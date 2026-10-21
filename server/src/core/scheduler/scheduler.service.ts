/*
 * The scheduler: durable, database-backed jobs.
 *
 *   sched_jobs   one row per schedule (cron + time zone), platform-wide or per organisation (and target)
 *   sched_runs   one row per (job, period): queued → running → succeeded / failed / skipped
 *
 * 1. ENQUEUE: a job whose next_run_at has passed gets a run for that period (unique per job and period, so two
 *    servers can never queue the same period twice) and its next_run_at moves to the next fire time after now —
 *    periods missed while every server was down are not replayed one by one; the latest due period runs once.
 * 2. CLAIM: a worker takes a queued run with a lease (lease_owner, lease_until) and renews it while working
 *    (heartbeat). A run whose server stopped is taken over when its lease runs out. One run per job at a time.
 * 3. RUN: the product's handler runs. Failure → retried with exponential backoff up to SCHEDULER_MAX_ATTEMPTS, then
 *    "failed" (audited). Jobs of a suspended organisation are skipped, not run.
 *
 * PALTAS staff list, pause, resume, reschedule and run jobs now (every change audited with its reason).
 */
import type { ops } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit, SYSTEM } from "../audit/audit.service.js";
import { staffActor } from "../admin/admin.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { checkTimezone, nextFire, parseCron, periodKey } from "./cron.js";
import type { JobOutcome, ScheduledJobDefinition } from "./types.js";

export interface JobRow {
  id: string;
  key: string;
  org_id: string | null;
  target_id: string | null;
  label: string;
  cron: string;
  timezone: string;
  status: "active" | "paused";
  paused_reason: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

export interface RunRow {
  id: string;
  job_id: string;
  org_id: string | null;
  period: string;
  trigger: "schedule" | "manual";
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  due_at: string;
  scheduled_for: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  requested_by: string | null;
}

type JobDto = ops.ScheduledJob;
type RunDto = ops.JobRun;

const ONE_HOUR = 3_600_000;

/** Validate a schedule; a clear 400 if the cron or the time zone is wrong. */
export function checkSchedule(cron: string, timezone: string) {
  try {
    parseCron(cron);
    checkTimezone(timezone);
  } catch (e) {
    throw fail.invalid((e as Error).message);
  }
}

function next(cron: string, tz: string, after: Date): string | null {
  return nextFire(cron, after, tz)?.toISOString() ?? null;
}

export function schedulerService(ctx: AppContext) {
  const { db, config, clock, log } = ctx;
  const S = config.scheduler;
  const definitions = new Map<string, ScheduledJobDefinition>();

  const toJob = (j: JobRow): JobDto => ({
    id: j.id,
    key: j.key,
    label: j.label,
    orgId: j.org_id,
    targetId: j.target_id,
    cron: j.cron,
    timezone: j.timezone,
    status: j.status,
    pausedReason: j.paused_reason,
    nextRunAt: j.next_run_at,
    lastRunAt: j.last_run_at,
    lastStatus: j.last_status,
    handlerRegistered: definitions.has(j.key),
  });
  const toRun = (r: RunRow): RunDto => ({
    id: r.id,
    jobId: r.job_id,
    period: r.period,
    trigger: r.trigger,
    status: r.status,
    dueAt: r.due_at,
    scheduledFor: r.scheduled_for,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    summary: r.summary,
    error: r.error,
    requestedBy: r.requested_by,
  });

  async function loadJob(t: Db, id: string, lock = false): Promise<JobRow> {
    const j = await t.row<JobRow>(`SELECT * FROM sched_jobs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    if (!j) throw fail.notFound("No such scheduled job");
    return j;
  }

  /** Queue a run for every job that is due. Returns how many runs were queued. */
  async function enqueueDue(now: Date = clock.now()): Promise<number> {
    return db.tx(async (t) => {
      const due = await t.rows<JobRow>(
        `SELECT * FROM sched_jobs WHERE status = 'active' AND next_run_at <= $1
         ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
        [now.toISOString()],
      );
      let queued = 0;
      for (const j of due) {
        const at = new Date(j.next_run_at as string);
        queued += await t.run(
          `INSERT INTO sched_runs (id, job_id, org_id, period, trigger, status, due_at, scheduled_for, max_attempts)
           VALUES ($1,$2,$3,$4,'schedule','queued',$5,$5,$6) ON CONFLICT (job_id, period) DO NOTHING`,
          [newId("run"), j.id, j.org_id, periodKey(at, j.timezone), at.toISOString(), S.maxAttempts],
        );
        await t.run("UPDATE sched_jobs SET next_run_at = $2, updated_at = now() WHERE id = $1", [
          j.id,
          next(j.cron, j.timezone, now),
        ]);
      }
      return queued;
    });
  }

  /** Take one runnable run under a lease (or null). */
  async function claim(workerId: string, now: Date = clock.now()): Promise<RunRow | null> {
    // a run whose last attempt stopped without finishing cannot be retried any more
    await db.run(
      `UPDATE sched_runs SET status = 'failed', finished_at = now(), lease_owner = NULL, lease_until = NULL,
         error = 'Stopped without finishing (the server running it went away) — no attempts left'
       WHERE status = 'running' AND lease_until < now() AND attempts >= max_attempts`,
    );
    return db.row<RunRow>(
      `UPDATE sched_runs r SET status = 'running', lease_owner = $1, lease_until = now() + $2 * interval '1 millisecond',
         heartbeat_at = now(), attempts = r.attempts + 1, started_at = now()
       WHERE r.id = (
         SELECT c.id FROM sched_runs c JOIN sched_jobs j ON j.id = c.job_id
         WHERE ((c.status = 'queued' AND c.due_at <= $3) OR (c.status = 'running' AND c.lease_until < now()))
           AND c.attempts < c.max_attempts
           AND (j.status = 'active' OR c.trigger = 'manual')
           AND NOT EXISTS (SELECT 1 FROM sched_runs o WHERE o.job_id = c.job_id AND o.id <> c.id
                           AND o.status = 'running' AND o.lease_until >= now())
         ORDER BY c.due_at, c.created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
       RETURNING r.*`,
      [workerId, S.leaseMs, now.toISOString()],
    );
  }

  /** Record the end of a run, only while this worker still holds it. */
  async function finish(run: RunRow, workerId: string, status: "succeeded" | "skipped", summary: string) {
    await db.tx(async (t) => {
      const n = await t.run(
        `UPDATE sched_runs SET status = $3, summary = $4, error = NULL, finished_at = now(), lease_owner = NULL,
           lease_until = NULL WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [run.id, workerId, status, summary.slice(0, 1000)],
      );
      if (!n) return log.warn({ run: run.id }, "Scheduled run finished after losing its lease; result not kept");
      await t.run("UPDATE sched_jobs SET last_run_at = now(), last_status = $2 WHERE id = $1", [run.job_id, status]);
    });
  }

  async function failed(run: RunRow, workerId: string, job: JobRow | null, err: unknown, now: Date) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const final = run.attempts >= run.max_attempts;
    const retryAt = new Date(now.getTime() + Math.min(ONE_HOUR, S.retryBaseMs * 2 ** (run.attempts - 1)));
    await db.tx(async (t) => {
      const n = await t.run(
        `UPDATE sched_runs SET status = $3, error = $4, due_at = CASE WHEN $3 = 'queued' THEN $5::timestamptz ELSE due_at END,
           finished_at = CASE WHEN $3 = 'failed' THEN now() END, lease_owner = NULL, lease_until = NULL
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [run.id, workerId, final ? "failed" : "queued", message, retryAt.toISOString()],
      );
      if (!n) return;
      await t.run("UPDATE sched_jobs SET last_run_at = now(), last_status = $2 WHERE id = $1", [
        run.job_id,
        final ? "failed" : "retrying",
      ]);
      if (final)
        await recordAudit(t, {
          actor: SYSTEM,
          orgId: run.org_id,
          action: "Scheduled job failed",
          target: run.job_id,
          detail: `${job?.key ?? "unknown"} · ${run.period} · ${run.attempts} attempt(s) · ${message}`,
        });
    });
    log.warn({ run: run.id, key: job?.key, attempt: run.attempts, final }, "Scheduled run failed");
  }

  /** Run one claimed run to its end (success, skip, retry or failure). */
  async function execute(run: RunRow, workerId: string, now: Date = clock.now()): Promise<void> {
    const job = await db.row<JobRow & { org_suspended: boolean }>(
      `SELECT j.*, (o.suspended_at IS NOT NULL) AS org_suspended
       FROM sched_jobs j LEFT JOIN organisations o ON o.id = j.org_id WHERE j.id = $1`,
      [run.job_id],
    );
    try {
      if (!job) throw new Error("The job no longer exists");
      if (job.org_suspended)
        return await finish(run, workerId, "skipped", "Organisation suspended by PALTAS — not run");
      const def = definitions.get(job.key);
      if (!def) throw new Error(`No handler is registered for "${job.key}" (is its product running?)`);
      const scheduled = new Date(run.scheduled_for);
      const out: JobOutcome = await def.run({
        runId: run.id,
        jobId: job.id,
        key: job.key,
        orgId: job.org_id,
        targetId: job.target_id,
        period: run.period,
        scheduledFor: run.scheduled_for,
        localDate: periodKey(scheduled, job.timezone).slice(0, 10),
        timezone: job.timezone,
        trigger: run.trigger,
        attempt: run.attempts,
        db,
      });
      await finish(run, workerId, "succeeded", out.summary);
    } catch (err) {
      await failed(run, workerId, job, err, now);
    }
  }

  return {
    /** Add job definitions (core at start-up, then every product's scheduledJobs). */
    register(list: ScheduledJobDefinition[]) {
      for (const d of list) {
        if (definitions.has(d.key)) throw new Error(`Scheduled job ${d.key} is registered twice`);
        if (d.defaultCron) parseCron(d.defaultCron);
        definitions.set(d.key, d);
      }
    },

    definitions(): ScheduledJobDefinition[] {
      return [...definitions.values()];
    },

    /** Create the schedule of every platform job that has none yet (staff changes to existing ones are kept). */
    async ensurePlatformJobs(now: Date = clock.now()) {
      for (const d of definitions.values()) {
        if (d.scope !== "platform" || !d.defaultCron) continue;
        await db.run(
          `INSERT INTO sched_jobs (id, key, label, cron, timezone, next_run_at) VALUES ($1,$2,$3,$4,'UTC',$5)
           ON CONFLICT (key, (COALESCE(org_id, '')), (COALESCE(target_id, ''))) DO NOTHING`,
          [newId("job"), d.key, d.label, d.defaultCron, next(d.defaultCron, "UTC", now)],
        );
      }
    },

    /**
     * Create or update an organisation's schedule for a registered job (for products), in the caller's transaction.
     * Changing the cron or time zone recomputes the next run; a paused job stays paused.
     */
    async ensureJob(
      t: Db,
      j: { key: string; orgId: string; targetId?: string | null; label: string; cron: string; timezone: string },
      now: Date = clock.now(),
    ): Promise<JobDto> {
      const def = definitions.get(j.key);
      if (!def) throw new Error(`Scheduled job ${j.key} is not registered`);
      if (def.scope !== "org") throw new Error(`Scheduled job ${j.key} is a platform job`);
      checkSchedule(j.cron, j.timezone);
      const row = await t.row<JobRow>(
        `INSERT INTO sched_jobs (id, key, org_id, target_id, label, cron, timezone, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (key, (COALESCE(org_id, '')), (COALESCE(target_id, ''))) DO UPDATE SET
           label = EXCLUDED.label, cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, updated_at = now(),
           next_run_at = CASE WHEN sched_jobs.cron = EXCLUDED.cron AND sched_jobs.timezone = EXCLUDED.timezone
                              THEN sched_jobs.next_run_at ELSE EXCLUDED.next_run_at END
         RETURNING *`,
        [newId("job"), j.key, j.orgId, j.targetId ?? null, j.label, j.cron, j.timezone, next(j.cron, j.timezone, now)],
      );
      return toJob(row as JobRow);
    },

    enqueueDue,
    claim,
    execute,

    /** Queue what is due, then claim and run at most one run. True if one ran. */
    async runOnce(workerId: string, now: Date = clock.now(), beat?: (run: RunRow) => () => void): Promise<boolean> {
      await enqueueDue(now);
      const run = await claim(workerId, now);
      if (!run) return false;
      const stopBeat = beat?.(run);
      try {
        await execute(run, workerId, now);
      } finally {
        stopBeat?.();
      }
      return true;
    },

    /** Renew a lease while a run works. */
    async heartbeat(runId: string, workerId: string) {
      await db.run(
        `UPDATE sched_runs SET lease_until = now() + $3 * interval '1 millisecond', heartbeat_at = now()
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [runId, workerId, S.leaseMs],
      );
    },

    // ---------------------------------------------------------------- PALTAS staff

    async listJobs(filter: { orgId?: string | undefined; key?: string | undefined }) {
      const jobs = await db.rows<JobRow>(
        `SELECT * FROM sched_jobs WHERE ($1::text IS NULL OR org_id = $1) AND ($2::text IS NULL OR key = $2)
         ORDER BY org_id NULLS FIRST, key, target_id`,
        [filter.orgId ?? null, filter.key ?? null],
      );
      return {
        jobs: jobs.map(toJob),
        handlers: [...definitions.values()].map((d) => ({ key: d.key, label: d.label, scope: d.scope })),
      };
    },

    async listRuns(jobId: string, limit: number) {
      const job = await loadJob(db, jobId);
      const runs = await db.rows<RunRow>(
        "SELECT * FROM sched_runs WHERE job_id = $1 ORDER BY created_at DESC, id LIMIT $2",
        [jobId, limit],
      );
      return { job: toJob(job), runs: runs.map(toRun) };
    },

    async pause(user: SessionUser, jobId: string, reason: string) {
      const actor = staffActor(user, "platform.operate");
      return db.tx(async (t) => {
        const j = await loadJob(t, jobId, true);
        if (j.status === "paused") throw fail.conflict("This job is already paused");
        const row = await t.row<JobRow>(
          "UPDATE sched_jobs SET status = 'paused', paused_reason = $2, updated_at = now() WHERE id = $1 RETURNING *",
          [jobId, reason],
        );
        await recordAudit(t, { actor, orgId: j.org_id, action: "Scheduled job paused", target: jobId, detail: reason });
        return toJob(row as JobRow);
      });
    },

    async resume(user: SessionUser, jobId: string, reason: string) {
      const actor = staffActor(user, "platform.operate");
      return db.tx(async (t) => {
        const j = await loadJob(t, jobId, true);
        if (j.status === "active") throw fail.conflict("This job is not paused");
        const row = await t.row<JobRow>(
          `UPDATE sched_jobs SET status = 'active', paused_reason = NULL, next_run_at = $2, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [jobId, next(j.cron, j.timezone, clock.now())],
        );
        await recordAudit(t, {
          actor,
          orgId: j.org_id,
          action: "Scheduled job resumed",
          target: jobId,
          detail: reason,
        });
        return toJob(row as JobRow);
      });
    },

    async runNow(user: SessionUser, jobId: string, reason: string) {
      const actor = staffActor(user, "platform.operate");
      return db.tx(async (t) => {
        const j = await loadJob(t, jobId, true);
        if (
          await t.row("SELECT 1 FROM sched_runs WHERE job_id = $1 AND trigger = 'manual' AND status = 'queued'", [
            jobId,
          ])
        )
          throw fail.conflict("A manual run of this job is already waiting");
        const now = clock.now();
        const run = await t.row<RunRow>(
          `INSERT INTO sched_runs (id, job_id, org_id, period, trigger, status, due_at, scheduled_for, max_attempts, requested_by)
           VALUES ($1,$2,$3,$4,'manual','queued',$5,$5,$6,$7) RETURNING *`,
          [newId("run"), jobId, j.org_id, "manual:" + now.toISOString(), now.toISOString(), S.maxAttempts, user.id],
        );
        await recordAudit(t, {
          actor,
          orgId: j.org_id,
          action: "Scheduled job run requested",
          target: jobId,
          detail: `${j.key} · ${reason}`,
        });
        return toRun(run as RunRow);
      });
    },

    async reschedule(user: SessionUser, jobId: string, b: { cron: string; timezone: string; reason: string }) {
      const actor = staffActor(user, "platform.operate");
      checkSchedule(b.cron, b.timezone);
      return db.tx(async (t) => {
        const j = await loadJob(t, jobId, true);
        const row = await t.row<JobRow>(
          "UPDATE sched_jobs SET cron = $2, timezone = $3, next_run_at = $4, updated_at = now() WHERE id = $1 RETURNING *",
          [jobId, b.cron, b.timezone, next(b.cron, b.timezone, clock.now())],
        );
        await recordAudit(t, {
          actor,
          orgId: j.org_id,
          action: "Scheduled job rescheduled",
          target: jobId,
          detail: b.reason,
          before: { cron: j.cron, timezone: j.timezone },
          after: { cron: b.cron, timezone: b.timezone },
        });
        return toJob(row as JobRow);
      });
    },
  };
}

export type SchedulerService = ReturnType<typeof schedulerService>;
