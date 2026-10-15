// The scheduler end to end: product job registration, per-organisation schedules in their time zone, one run per
// period (idempotent), retries with backoff, leases taken over after a crash, suspended organisations skipped,
// the platform jobs (session clean-up, trial expiry, renewal invoices) and the Super Admin controls.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RENEWAL_NOTE } from "../dist/core/scheduler/platform-jobs.js";
import { DEFAULTS, staffMember, standInProduct } from "./support/platform-fixtures.js";
import { refused, startServer, TODAY, type TestServer } from "./support/test-server.js";

describe("scheduler", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  const stand = standInProduct();
  let orgId: string;
  let jobId: string;

  beforeAll(async () => {
    S = await startServer({
      products: [stand.module],
      config: { scheduler: { ...DEFAULTS.scheduler, worker: false, maxAttempts: 3, retryBaseMs: 1000 } },
    });
    sa = await S.staff();
    orgId = (await S.newOrg({ name: "Kilima Hotels", trial: false })).orgId;
    // keep the platform jobs out of the way of these tests (staff can still run a paused job by hand)
    await S.sql("UPDATE sched_jobs SET status = 'paused', paused_reason = 'isolated for tests' WHERE org_id IS NULL");
  });
  afterAll(() => S.close());

  const J = () => S.app.core.scheduler;
  const run = (now: Date, worker = "test-worker") => J().runOnce(worker, now);
  const runs = (id: string) =>
    S.sql<{ id: string; period: string; status: string; attempts: number; error: string | null; due_at: string }>(
      "SELECT * FROM sched_runs WHERE job_id = $1 ORDER BY created_at, id",
      [id],
    );

  it("creates the platform jobs at start-up, once", async () => {
    const { jobs, handlers } = await sa.api.ops.listJobs();
    expect(jobs.filter((j) => !j.orgId).map((j) => [j.key, j.cron])).toEqual([
      ["platform.notifications.dispatch", "* * * * *"],
      ["platform.sessions.cleanup", "17 * * * *"],
      ["platform.subscriptions.renewals", "5 0 * * *"],
      ["platform.trials.lifecycle", "20 0 * * *"],
    ]);
    expect(handlers.map((h) => h.key)).toContain("test.night_audit");
    await J().ensurePlatformJobs();
    expect((await S.sql("SELECT 1 FROM sched_jobs WHERE org_id IS NULL")).length).toBe(4);
  });

  it("a product creates an organisation's schedule in the property's time zone; a period runs once", async () => {
    const job = await S.app.core.db.tx((t) =>
      J().ensureJob(
        t,
        {
          key: "test.night_audit",
          orgId,
          targetId: "PROP-1",
          label: "Night audit — Kilima Beach",
          cron: "0 2 * * *",
          timezone: "Africa/Nairobi",
        },
        new Date("2026-10-11T12:00:00Z"),
      ),
    );
    jobId = job.id;
    expect(job.nextRunAt).toBe("2026-10-11T23:00:00.000Z"); // 02:00 in Nairobi
    // calling again with the same schedule keeps it; a platform key or unknown key is refused
    const again = await S.app.core.db.tx((t) =>
      J().ensureJob(t, {
        key: "test.night_audit",
        orgId,
        targetId: "PROP-1",
        label: "Night audit — Kilima Beach",
        cron: "0 2 * * *",
        timezone: "Africa/Nairobi",
      }),
    );
    expect([again.id, again.nextRunAt]).toEqual([jobId, "2026-10-11T23:00:00.000Z"]);
    await expect(
      S.app.core.db.tx((t) =>
        J().ensureJob(t, { key: "platform.sessions.cleanup", orgId, label: "x", cron: "* * * * *", timezone: "UTC" }),
      ),
    ).rejects.toThrow(/platform job/);

    // not due yet
    expect(await run(new Date("2026-10-11T22:59:00Z"))).toBe(false);
    expect(stand.calls).toHaveLength(0);
    // due: runs once for that period, with the local date
    const now = new Date("2026-10-11T23:00:30Z");
    expect(await run(now)).toBe(true);
    expect(stand.calls.map((c) => [c.period, c.localDate, c.targetId, c.orgId])).toEqual([
      ["2026-10-12T02:00", "2026-10-12", "PROP-1", orgId],
    ]);
    expect(await run(now)).toBe(false);
    // even if the schedule were queued again for the same period (another server, a restart), it runs only once
    await S.sql("UPDATE sched_jobs SET next_run_at = '2026-10-11T23:00:00Z' WHERE id = $1", [jobId]);
    expect(await run(now)).toBe(false);
    expect(stand.calls).toHaveLength(1);
    const [r] = await runs(jobId);
    expect([r!.status, r!.attempts]).toEqual(["succeeded", 1]);
    const [j] = await S.sql<{ next_run_at: string; last_status: string }>("SELECT * FROM sched_jobs WHERE id = $1", [
      jobId,
    ]);
    expect([j!.next_run_at, j!.last_status]).toEqual(["2026-10-12T23:00:00.000Z", "succeeded"]);
  });

  it("a failing run is retried with backoff, then succeeds; history keeps each attempt's outcome", async () => {
    stand.behaviour.fail = 2;
    const now = new Date("2026-10-12T23:00:10Z");
    expect(await run(now)).toBe(true);
    let [, r] = await runs(jobId);
    expect([r!.status, r!.attempts, r!.error]).toEqual(["queued", 1, "Audit refused: a cashier shift is still open"]);
    // waits for the backoff (1 s, then 2 s)
    expect(await run(now)).toBe(false);
    expect(await run(new Date(new Date(r!.due_at).getTime() + 10))).toBe(true);
    [, r] = await runs(jobId);
    expect([r!.status, r!.attempts]).toEqual(["queued", 2]);
    expect(await run(new Date(new Date(r!.due_at).getTime() + 10))).toBe(true);
    [, r] = await runs(jobId);
    expect([r!.status, r!.attempts, r!.error]).toEqual(["succeeded", 3, null]);
    const history = await sa.api.ops.listRuns({ params: { jobId } });
    expect(history.runs.map((x) => x.status)).toEqual(["succeeded", "succeeded"]);
    expect(history.runs[0]!.summary).toBe("Night audit for 2026-10-13 completed");
  });

  it("after the last attempt the run is failed and audited", async () => {
    stand.behaviour.fail = 3;
    let now = new Date("2026-10-13T23:00:10Z");
    for (let i = 0; i < 3; i++) {
      expect(await run(now)).toBe(true);
      const last = (await runs(jobId)).at(-1)!;
      now = new Date(new Date(last.due_at).getTime() + 10);
    }
    const last = (await runs(jobId)).at(-1)!;
    expect([last.status, last.attempts]).toEqual(["failed", 3]);
    const audit = await sa.api.ops.auditSearch({ query: { action: "Scheduled job failed" } });
    expect(audit.entries[0]).toMatchObject({ orgId, target: jobId });
    expect(audit.entries[0]!.detail).toMatch(/test\.night_audit · 2026-10-14T02:00 · 3 attempt\(s\)/);
  });

  it("a run whose server stopped is taken over when its lease runs out; the old worker cannot overwrite it", async () => {
    stand.behaviour.fail = 0;
    const now = new Date("2026-10-14T23:00:10Z");
    await J().enqueueDue(now);
    const claimedByA = await J().claim("worker-A", now);
    expect(claimedByA?.status).toBe("running");
    // while A's lease holds, nobody else takes it
    expect(await run(now, "worker-B")).toBe(false);
    // A disappears: its lease runs out
    await S.sql("UPDATE sched_runs SET lease_until = now() - interval '1 second' WHERE id = $1", [claimedByA!.id]);
    const before = stand.behaviour.finished;
    expect(await run(now, "worker-B")).toBe(true);
    expect(stand.behaviour.finished).toBe(before + 1);
    const [taken] = await S.sql<{ status: string; attempts: number; lease_owner: string | null }>(
      "SELECT * FROM sched_runs WHERE id = $1",
      [claimedByA!.id],
    );
    expect([taken!.status, taken!.attempts]).toEqual(["succeeded", 2]);
    // A comes back and tries to record a failure: ignored, B's result stands
    await J().execute({ ...claimedByA!, attempts: 1 }, "worker-A");
    const [still] = await S.sql<{ status: string }>("SELECT status FROM sched_runs WHERE id = $1", [claimedByA!.id]);
    expect(still!.status).toBe("succeeded");
  });

  it("Super Admin pauses, runs now, reschedules and resumes — each audited; support staff and clients cannot", async () => {
    const support = await staffMember(S, "support");
    await refused(
      support.api.ops.pauseJob({ params: { jobId }, body: { reason: "Maintenance window" } }),
      403,
      "STAFF_ROLE_NOT_ALLOWED",
    );
    expect((await support.api.ops.listJobs({ query: { orgId } })).jobs).toHaveLength(1);
    const client = (await S.newOrg()).admin;
    await refused(client.api.ops.listJobs(), 404);

    const paused = await sa.api.ops.pauseJob({ params: { jobId }, body: { reason: "Hotel closed for refurbishment" } });
    expect([paused.status, paused.pausedReason]).toEqual(["paused", "Hotel closed for refurbishment"]);
    await refused(sa.api.ops.pauseJob({ params: { jobId }, body: { reason: "Again please" } }), 409);
    // a paused job queues nothing on schedule
    const later = new Date("2026-10-20T23:00:10Z");
    const count = (await runs(jobId)).length;
    expect(await run(later)).toBe(false);
    expect((await runs(jobId)).length).toBe(count);
    // … but staff may run it once by hand
    const manual = await sa.api.ops.runJobNow({ params: { jobId }, body: { reason: "Close the 20th by hand" } });
    expect([manual.trigger, manual.status, manual.period.startsWith("manual:")]).toEqual(["manual", "queued", true]);
    await refused(sa.api.ops.runJobNow({ params: { jobId }, body: { reason: "Twice by mistake" } }), 409);
    expect(await run(new Date(Date.now() + 1000))).toBe(true);
    expect((await sa.api.ops.listRuns({ params: { jobId } })).runs[0]).toMatchObject({
      trigger: "manual",
      status: "succeeded",
      requestedBy: sa.userId,
    });

    await refused(
      sa.api.ops.rescheduleJob({
        params: { jobId },
        body: { cron: "0 25 * * *", timezone: "UTC", reason: "Bad hour" },
      }),
      400,
    );
    await refused(
      sa.api.ops.rescheduleJob({
        params: { jobId },
        body: { cron: "0 3 * * *", timezone: "Nowhere/City", reason: "Bad zone" },
      }),
      400,
    );
    const moved = await sa.api.ops.rescheduleJob({
      params: { jobId },
      body: { cron: "30 3 * * *", timezone: "Africa/Nairobi", reason: "Audit moved to 03:30" },
    });
    expect(moved.cron).toBe("30 3 * * *");
    const resumed = await sa.api.ops.resumeJob({ params: { jobId }, body: { reason: "Hotel reopened" } });
    expect(resumed.status).toBe("active");
    expect(new Date(resumed.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    const actions = (await sa.api.ops.auditSearch({ query: { target: jobId } })).entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "Scheduled job paused",
        "Scheduled job run requested",
        "Scheduled job rescheduled",
        "Scheduled job resumed",
      ]),
    );
  });

  it("jobs of a suspended organisation are skipped, not run", async () => {
    await sa.api.ops.suspendOrg({ params: { orgId }, body: { reason: "Unpaid for three months" } });
    const calls = stand.calls.length;
    await sa.api.ops.runJobNow({ params: { jobId }, body: { reason: "Try while suspended" } });
    expect(await run(new Date(Date.now() + 1000))).toBe(true);
    expect(stand.calls.length).toBe(calls);
    expect((await sa.api.ops.listRuns({ params: { jobId } })).runs[0]).toMatchObject({
      status: "skipped",
      summary: "Organisation suspended by PALTAS — not run",
    });
    await sa.api.ops.reactivateOrg({ params: { orgId }, body: { reason: "Paid in full" } });
  });

  it("a job without a registered handler fails clearly instead of disappearing", async () => {
    const [row] = await S.sql<{ id: string }>(
      `INSERT INTO sched_jobs (id, key, org_id, label, cron, timezone, next_run_at)
       VALUES ('job_orphan', 'gone.product_job', $1, 'Orphan', '0 1 * * *', 'UTC', '2026-01-01T01:00:00Z') RETURNING id`,
      [orgId],
    );
    const listed = (await sa.api.ops.listJobs({ query: { key: "gone.product_job" } })).jobs[0];
    expect(listed?.handlerRegistered).toBe(false);
    expect(await run(new Date("2026-01-01T01:00:10Z"))).toBe(true);
    const [r] = await runs(row!.id);
    expect(r!.error).toMatch(/No handler is registered for "gone.product_job"/);
    await S.sql("UPDATE sched_jobs SET status = 'paused', paused_reason = 'test done' WHERE id = 'job_orphan'");
    await S.sql("UPDATE sched_runs SET status = 'failed' WHERE job_id = 'job_orphan'");
  });

  describe("platform jobs", () => {
    const platformJob = async (key: string) => (await sa.api.ops.listJobs({ query: { key } })).jobs[0]!.id;
    const runPlatform = async (key: string) => {
      const id = await platformJob(key);
      await sa.api.ops.runJobNow({ params: { jobId: id }, body: { reason: "Test run of " + key } });
      // other due platform jobs may run first; keep going until this one has finished
      for (let i = 0; i < 10 && (await run(new Date(Date.now() + 1000))); i++);
      return (await sa.api.ops.listRuns({ params: { jobId: id } })).runs[0]!;
    };

    it("session clean-up removes expired sessions only", async () => {
      const [u] = await S.sql<{ id: string }>("SELECT id FROM users WHERE staff_role IS NULL LIMIT 1");
      await S.sql(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (repeat('a', 64), $1, now() - interval '1 minute')",
        [u!.id],
      );
      const r = await runPlatform("platform.sessions.cleanup");
      expect(r.status).toBe("succeeded");
      expect(r.summary).toMatch(/^\d+ expired session\(s\) removed$/);
      expect(await S.sql("SELECT 1 FROM sessions WHERE token_hash = repeat('a', 64)")).toEqual([]);
      // live sessions survive
      expect((await sa.api.ops.listJobs()).jobs.length).toBeGreaterThan(0);
    });

    it("renewals: trials past their end expire; active subscriptions get their next invoice once, a few days ahead", async () => {
      const trial = await S.newOrg({ name: "Trial Co", trial: true });
      const paying = await S.newOrg({ name: "Paying Co", trial: false }); // anchor 2026-10-11 → next 2026-11-11
      await S.sql("UPDATE subscriptions SET trial_ends = '2026-10-20' WHERE org_id = $1", [trial.orgId]);
      const invoices = () =>
        S.sql<{ period_from: string; note: string; total_minor: number }>(
          "SELECT period_from, note, total_minor FROM billing_invoices WHERE org_id = $1",
          [paying.orgId],
        );

      S.setToday("2026-11-01"); // 10 days before the period: not yet (lead 7 days)
      const r = await runPlatform("platform.subscriptions.renewals");
      expect(await invoices()).toEqual([]);
      const [t1] = await S.sql<{ status: string }>("SELECT status FROM subscriptions WHERE org_id = $1", [trial.orgId]);
      expect(t1!.status).toBe("expired");
      expect(r.summary).toMatch(/[1-9]\d* trial\(s\) expired/);

      S.setToday("2026-11-05");
      await runPlatform("platform.subscriptions.renewals");
      expect(await invoices()).toEqual([{ period_from: "2026-11-11", note: RENEWAL_NOTE, total_minor: 2_900_000 }]);
      // the next day: nothing new for the same period
      S.setToday("2026-11-06");
      await runPlatform("platform.subscriptions.renewals");
      expect(await invoices()).toHaveLength(1);
      // and a Super Admin cannot issue it a second time by hand
      await refused(sa.api.admin.issueInvoice({ params: { orgId: paying.orgId }, body: {} }), 409);
      const audit = await sa.api.ops.auditSearch({
        query: { orgId: paying.orgId, action: "Subscription renewal invoice issued" },
      });
      expect(audit.entries).toHaveLength(1);
      S.setToday(TODAY);
    });
  });
});
