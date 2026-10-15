// Automation: a finance person turns on the monthly billing run and daily late fees for a property; the PALTAS
// scheduler then bills rent and charges on the billing day (once per lease and month, however often it fires) and
// charges late fees per the property's policy (once per overdue invoice). Switched off, the jobs do nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer, type Building } from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("Property Management automation", () => {
  let S: TestServer;
  let orgId: string;
  let pm: Person;
  let acct: Person;
  let agent: Person;
  let B: Building;
  let leaseId: string;

  /** Let the scheduler fire the property's job at its next scheduled moment; returns the run's status and summary. */
  async function fire(key: string): Promise<{ status: string; summary: string | null }> {
    await S.sql("UPDATE sched_jobs SET status = 'paused', paused_reason = 'property test' WHERE org_id IS NULL");
    const [job] = await S.sql("SELECT id, next_run_at FROM sched_jobs WHERE key = $1 AND target_id = $2", [
      key,
      B.propertyId,
    ]);
    const at = new Date(new Date(job.next_run_at).getTime() + 60_000);
    // run everything due by then (the other job of the property may fall due first)
    let ran = 0;
    while (await S.app.core.scheduler.runOnce("test-worker", at)) ran++;
    expect(ran).toBeGreaterThan(0);
    const [run] = await S.sql(
      "SELECT status, summary FROM sched_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
      [job.id],
    );
    return run;
  }

  const invoices = async () =>
    (
      await S.sql("SELECT kind, amount_minor FROM pm_invoices WHERE org_id = $1 AND lease_id = $2 ORDER BY kind", [
        orgId,
        leaseId,
      ])
    ).map((r) => [r.kind, Number(r.amount_minor)]);

  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
    const o = await pmOrg(S, { name: "Automation Org" });
    orgId = o.orgId;
    pm = o.staff.property_manager;
    acct = o.staff.accountant;
    agent = o.staff.leasing_agent;
    B = await setUpBuilding(orgId, pm, { units: ["D-1"] });
    const tenantId = await newTenant(pm, orgId, "Akinyi Odhiambo");
    const draft = await pm.api.property.createLease({
      params: { orgId },
      body: {
        unitId: B.units["D-1"]!,
        tenantId,
        startDate: "2026-10-01",
        endDate: "2027-09-30",
        rentMinor: 5_000_000,
        depositMinor: 0,
        dueDay: 5,
      },
    });
    leaseId = draft.id;
    await pm.api.property.activateLease({ params: { orgId, leaseId }, body: { signedOn: "2026-09-28" } });
  });
  afterAll(() => S.close());

  it("is turned on by a person with billing rights only, and registers one schedule per job in the organisation's time zone", async () => {
    const body = { monthlyBilling: true, billingDay: 1, lateFees: true };
    await refused(agent.api.property.setAutomation({ params: { orgId, propertyId: B.propertyId }, body }), 403);
    const p = await acct.api.property.setAutomation({ params: { orgId, propertyId: B.propertyId }, body });
    expect(p.automation).toEqual(body);
    // asking again keeps the same schedules
    await acct.api.property.setAutomation({ params: { orgId, propertyId: B.propertyId }, body });
    const jobs = await S.sql("SELECT key, cron, status FROM sched_jobs WHERE target_id = $1 ORDER BY key", [
      B.propertyId,
    ]);
    expect(jobs).toEqual([
      { key: "property.late_fees", cron: "30 6 * * *", status: "active" },
      { key: "property.monthly_billing", cron: "0 6 1 * *", status: "active" },
    ]);
    expect(
      (await pm.api.property.getProperty({ params: { orgId, propertyId: B.propertyId } })).property.automation,
    ).toEqual(body);
  });

  it("bills the month's rent on the billing day, once however often the scheduler fires", async () => {
    S.setToday("2026-11-01");
    const first = await fire("property.monthly_billing");
    expect(first.status).toBe("succeeded");
    expect(first.summary).toContain("2026-11: 1 rent invoice(s)");
    expect(await invoices()).toEqual([["rent", 5_000_000]]);
    const again = await fire("property.monthly_billing");
    expect(again.summary).toContain("0 rent invoice(s)");
    expect(await invoices()).toEqual([["rent", 5_000_000]]);
    // the rent is posted to the one ledger (tenant receivable)
    const [j] = await S.sql("SELECT count(*)::int AS n FROM pm_ledger_links WHERE org_id = $1 AND lease_id = $2", [
      orgId,
      leaseId,
    ]);
    expect(j.n).toBeGreaterThan(0);
  });

  it("charges one late fee per overdue invoice after the grace days; switched off, it does nothing", async () => {
    S.setToday("2026-11-10");
    const early = await fire("property.late_fees");
    expect(early.summary).toContain("0 late fee(s)");
    S.setToday("2026-11-20");
    const due = await fire("property.late_fees");
    expect(due.summary).toContain("1 late fee(s)");
    // 5 % of 5,000,000 = 250,000 (above the 50,000 minimum)
    expect(await invoices()).toEqual([
      ["late_fee", 250_000],
      ["rent", 5_000_000],
    ]);
    expect((await fire("property.late_fees")).summary).toContain("0 late fee(s)");
    await acct.api.property.setAutomation({
      params: { orgId, propertyId: B.propertyId },
      body: { monthlyBilling: false, billingDay: 1, lateFees: false },
    });
    S.setToday("2026-12-01");
    expect((await fire("property.monthly_billing")).summary).toContain("Automatic billing is off");
    expect((await fire("property.late_fees")).summary).toContain("Automatic late fees are off");
    expect((await invoices()).length).toBe(2);
  });
});
