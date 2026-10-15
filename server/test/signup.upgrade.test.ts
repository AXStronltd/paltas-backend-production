// Self-service upgrade: the subscription becomes active ONLY on a confirmed payment — a signed provider event with
// the exact amount (test adapter; live collection BLOCKED) or a bank reference PALTAS staff record — never because
// a form was submitted, not even in BILLING_MODE=simulated. Downgrades and cancellations take effect at the end of
// the paid period; a lapsed workspace comes back with all its records. The export is the administrator's only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contactWrite,
  dailyJobs,
  productRecords,
  productWrite,
  signUpAndIn,
  signupServer,
  verificationToken,
  type Account,
} from "./support/signup-fixture.js";
import { refused, TODAY, type TestServer } from "./support/test-server.js";

async function verified(S: TestServer, a: Account) {
  await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
  return a;
}

describe("self-service upgrade and payment", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;

  beforeAll(async () => {
    S = await signupServer();
    sa = await S.staff();
  });
  afterAll(() => S.close());

  const ent = (a: Account) => a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: {} });

  it("provider path: only a correctly signed event with the exact amount activates (test adapter)", async () => {
    const a = await verified(S, await signUpAndIn(S, "hotel"));
    const opts = await a.api.subscriptions.upgradeOptions({ params: { orgId: a.orgId }, query: {} });
    expect(opts.paymentMethods.find((m) => m.method === "provider")!.note).toMatch(/test adapter.*BLOCKED/);
    // a running trial converts on the same plan
    const up = await a.api.subscriptions.upgrade({
      params: { orgId: a.orgId },
      body: { plan: "HOTEL-STD", frequency: "monthly", payment: "provider", confirm: "CONFIRM" },
    });
    expect(up.payment.instructions).toMatch(/Not connected — test adapter/);
    const inv = up.invoice!;
    await refused(
      a.api.subscriptions.upgrade({
        params: { orgId: a.orgId },
        body: { plan: "HOTEL-PRO", frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
      }),
      409,
    );
    const event = { type: "subscription.payment", invoiceId: inv.id, currency: inv.currency };
    const bad = await S.webhook(
      { ...event, id: "ev-forged", status: "succeeded", amountMinor: inv.totalMinor, ref: "CARD-1" },
      { signature: "t=1,v1=00" },
    );
    expect(bad.status).toBe(401);
    expect(
      (await S.webhook({ ...event, id: "ev-fail", status: "failed", amountMinor: inv.totalMinor, ref: "CARD-2" })).body
        .result,
    ).toMatch(/^Payment failed/);
    expect(
      (
        await S.webhook({
          ...event,
          id: "ev-short",
          status: "succeeded",
          amountMinor: inv.totalMinor - 100,
          ref: "CARD-3",
        })
      ).body.result,
    ).toMatch(/^Held for review/);
    expect((await ent(a)).status).toBe("trial");
    expect(
      (await S.webhook({ ...event, id: "ev-ok", status: "succeeded", amountMinor: inv.totalMinor, ref: "CARD-4" })).body
        .result,
    ).toMatch(/^Applied/);
    const e = await ent(a);
    expect([e.status, e.trial, e.plan]).toEqual(["active", null, "HOTEL-STD"]);
    await refused(
      a.api.subscriptions.upgrade({
        params: { orgId: a.orgId },
        body: { plan: "HOTEL-STD", frequency: "monthly", payment: "provider", confirm: "CONFIRM" },
      }),
      409,
    );
    const paid = await sa.api.admin.listUpgrades({ query: { status: "paid" } });
    expect(paid.upgrades.map((u) => [u.orgId, u.method, u.invoice.status])).toEqual([[a.orgId, "provider", "Paid"]]);
  });

  it("only the organisation administrator upgrades; Enterprise and unknown plans are refused", async () => {
    const a = await verified(S, await signUpAndIn(S, "property"));
    const m = await a.api.organisations.addMember({
      params: { orgId: a.orgId },
      body: { email: "fd@property.test", role: "finance_director" },
    });
    const fd = await S.login("fd@property.test", m.temporaryPassword!);
    await fd.api.identity.changePassword({
      body: { currentPassword: m.temporaryPassword!, newPassword: "Finance-Director-Pass-1" },
    });
    const body = {
      plan: "PM-STARTER",
      frequency: "monthly" as const,
      payment: "bank_transfer" as const,
      confirm: "CONFIRM" as const,
    };
    await refused(fd.api.subscriptions.upgrade({ params: { orgId: a.orgId }, body }), 403, "ROLE_NOT_ALLOWED");
    await refused(
      a.api.subscriptions.upgrade({ params: { orgId: a.orgId }, body: { ...body, plan: "PM-ENTERPRISE" } }),
      400,
    );
    await refused(a.api.subscriptions.upgrade({ params: { orgId: a.orgId }, body: { ...body, plan: "NOPE" } }), 400);
    const other = await signUpAndIn(S, "security");
    await refused(other.api.subscriptions.upgrade({ params: { orgId: a.orgId }, body }), 404);
  });

  it("downgrade and cancellation take effect at the end of the paid period; a lapsed workspace comes back whole", async () => {
    const a = await verified(S, await signUpAndIn(S, "property", { plan: "PM-GROWTH" }));
    await productWrite(a, 1);
    const up = await a.api.subscriptions.upgrade({
      params: { orgId: a.orgId },
      body: { plan: "PM-GROWTH", frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
    });
    await sa.api.admin.recordReceipt({
      params: { invoiceId: up.invoice!.id },
      body: { ref: "BANK-GROWTH-01", reason: "Transfer on the PALTAS statement" },
    });
    expect((await ent(a)).status).toBe("active");
    const down = await a.api.subscriptions.changePlan({
      params: { orgId: a.orgId },
      body: { plan: "PM-STARTER", confirm: "CONFIRM" },
    });
    expect(down).toMatchObject({ scheduled: true, effective: "2026-11-11" });
    expect((await ent(a)).plan).toBe("PM-GROWTH"); // until the period ends
    const cancel = await a.api.subscriptions.cancel({ params: { orgId: a.orgId }, body: { reason: "Season over" } });
    expect(cancel.effective).toBe("2026-11-11");
    await dailyJobs(S, "2026-11-10");
    expect([(await ent(a)).status, (await ent(a)).usable]).toEqual(["active", true]);
    await contactWrite(a, 1);
    await dailyJobs(S, "2026-11-11");
    const lapsed = await ent(a);
    expect([lapsed.status, lapsed.usable]).toEqual(["cancelled", false]);
    await refused(contactWrite(a, 2), 402, "SUBSCRIPTION_INACTIVE");
    // back again: a new upgrade, paid, and every record is still there
    const again = await a.api.subscriptions.upgrade({
      params: { orgId: a.orgId },
      body: { plan: "PM-STARTER", frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
    });
    expect((await ent(a)).status).toBe("cancelled");
    await sa.api.admin.recordReceipt({
      params: { invoiceId: again.invoice!.id },
      body: { ref: "BANK-BACK-01", reason: "Customer came back — transfer seen" },
    });
    const back = await ent(a);
    expect([back.status, back.usable, back.plan]).toEqual(["active", true, "PM-STARTER"]);
    expect(await productRecords(a)).toBe(1);
    expect((await a.api.contacts.listContacts({ params: { orgId: a.orgId }, query: {} })).contacts).toHaveLength(1);
    await contactWrite(a, 3);
    S.setToday(TODAY);
  });

  it("in BILLING_MODE=simulated a self-service upgrade still waits for a real payment", async () => {
    const sim = await signupServer({}, { billingMode: "simulated" });
    try {
      const a = await verified(sim, await signUpAndIn(sim, "agency"));
      const up = await a.api.subscriptions.upgrade({
        params: { orgId: a.orgId },
        body: { plan: "AGENCY-STD", frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
      });
      expect([up.invoice?.status, up.purchase.status]).toEqual([
        "Open",
        "Awaiting payment — starts when the payment is confirmed",
      ]);
      expect((await a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: {} })).status).toBe("trial");
      expect((await sim.sql("SELECT status FROM subscriptions WHERE org_id = $1", [a.orgId]))[0].status).toBe("trial");
    } finally {
      await sim.close();
    }
  });

  it("the export is the organisation administrator's, audited; nobody else's", async () => {
    const a = await verified(S, await signUpAndIn(S, "developer"));
    const m = await a.api.organisations.addMember({
      params: { orgId: a.orgId },
      body: { email: "acct@dev.test", role: "accountant" },
    });
    const acct = await S.login("acct@dev.test", m.temporaryPassword!);
    await acct.api.identity.changePassword({
      body: { currentPassword: m.temporaryPassword!, newPassword: "Accountant-Pass-123" },
    });
    const path = `/api/v1/orgs/${a.orgId}/export?reason=${encodeURIComponent("Monthly backup copy")}`;
    expect((await S.raw("GET", path, undefined, acct.token)).status).toBe(403);
    const other = await signUpAndIn(S, "developer");
    expect((await S.raw("GET", path, undefined, other.token)).status).toBe(404);
    const ok = await S.raw("GET", path, undefined, a.token);
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/scrypt\$|token_hash|password_hash/);
    const audit = await a.api.organisations.listAudit({ params: { orgId: a.orgId }, query: {} });
    expect(audit.entries.find((e) => e.action === "Organisation data exported")?.detail).toBe("Monthly backup copy");
  });

  it("the trial lifecycle is a platform job PALTAS staff can see and run", async () => {
    const jobs = (await sa.api.ops.listJobs({ query: { key: "platform.trials.lifecycle" } })).jobs;
    expect(jobs.map((j) => [j.key, j.cron])).toEqual([["platform.trials.lifecycle", "20 0 * * *"]]);
    await sa.api.ops.runJobNow({ params: { jobId: jobs[0]!.id }, body: { reason: "Check the trial job" } });
    for (let i = 0; i < 10 && (await S.app.core.scheduler.runOnce("test", new Date(Date.now() + 1000))); i++);
    const run = (await sa.api.ops.listRuns({ params: { jobId: jobs[0]!.id } })).runs[0]!;
    expect([run.status, run.summary]).toEqual([
      "succeeded",
      expect.stringMatching(/trial reminder\(s\) .* recorded \(outbox, not sent\)/),
    ]);
  });
});
