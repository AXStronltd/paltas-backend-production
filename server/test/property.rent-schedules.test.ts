import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../dist/db/database.js";
import {
  nextRentBoundary,
  intervalRent,
  rentSchedulesService,
} from "../dist/products/property/billing/rent-schedules.service.js";
import { pmAccess } from "../dist/products/property/shared/access.js";
import type { LeaseRow } from "../dist/products/property/shared/records.js";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";

describe("rent interval calendar and rounding", () => {
  it("keeps month-end anchors and leap years", () => {
    expect(nextRentBoundary("2026-01-31", "2026-01-31", "monthly", null)).toBe("2026-02-28");
    expect(nextRentBoundary("2026-01-31", "2026-02-28", "monthly", null)).toBe("2026-03-31");
    expect(nextRentBoundary("2028-01-31", "2028-01-31", "monthly", null)).toBe("2028-02-29");
    expect(nextRentBoundary("2026-01-31", "2026-01-31", "quarterly", null)).toBe("2026-04-30");
    expect(nextRentBoundary("2028-02-29", "2028-02-29", "annual", null)).toBe("2029-02-28");
  });
  it("supports exact weekly and custom-day boundaries", () => {
    expect(nextRentBoundary("2026-10-01", "2026-10-01", "weekly", null)).toBe("2026-10-08");
    expect(nextRentBoundary("2026-10-01", "2026-10-01", "custom_days", 10)).toBe("2026-10-11");
  });
  it("weekly partitions sum to the exact monthly obligation without minor-unit drift", async () => {
    const t = { row: async () => null, rows: async () => [] } as unknown as Db;
    const l = { id: "synthetic", start_date: "2026-10-01", end_date: "2026-10-31", rent_minor: 310_001 } as LeaseRow;
    const amounts = [];
    for (const [from, through] of [
      ["01", "07"],
      ["08", "14"],
      ["15", "21"],
      ["22", "28"],
      ["29", "31"],
    ])
      amounts.push((await intervalRent(t, l, `2026-10-${from}`, `2026-10-${through}`)).amount);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(310_001);
  });
  it("cross-month intervals retain each month's correct denominator", async () => {
    const t = { row: async () => null, rows: async () => [] } as unknown as Db;
    const l = { id: "synthetic", start_date: "2026-10-01", end_date: null, rent_minor: 310_000 } as LeaseRow;
    // 4 October days plus 3 November days, rounded through monthly cumulative allocation.
    expect((await intervalRent(t, l, "2026-10-28", "2026-11-03")).amount).toBe(40_000 + 31_000);
  });
});

describe("client-controlled flexible rent schedules", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
  });
  afterAll(() => S.close());
  async function fixture(endDate: string | null = "2026-10-31") {
    S.setToday("2026-10-01");
    const o = await pmOrg(S),
      pm = o.staff.property_manager,
      b = await setUpBuilding(o.orgId, pm, { units: ["Weekly"] });
    const tenantId = await newTenant(pm, o.orgId, "Synthetic weekly tenant");
    const lease = await pm.api.property.createLease({
      params: { orgId: o.orgId },
      body: {
        unitId: b.units.Weekly!,
        tenantId,
        startDate: "2026-10-01",
        endDate,
        rentMinor: 310_001,
        depositMinor: 0,
        depositMode: "none",
      },
    });
    await pm.api.property.activateLease({
      params: { orgId: o.orgId, leaseId: lease.id },
      body: { signedOn: "2026-10-01", billFirstRent: false },
    });
    const params = { orgId: o.orgId, leaseId: lease.id };
    const input = {
      cadence: "weekly" as const,
      everyDays: null,
      startDate: "2026-10-01",
      dueDays: 2,
      expectedVersion: 0,
      reason: "Agreed weekly invoicing of monthly contractual rent",
    };
    const configure = async (who: Person = pm, body = input) => {
      const preview = await who.api.property.previewRentSchedule({ params, body });
      const schedule = await who.api.property.saveRentSchedule({
        params,
        body: { input: body, previewKey: preview.previewKey, confirm: "ENABLE_RENT_SCHEDULE" },
      });
      return { preview, schedule };
    };
    return { o, pm, b, lease, params, input, configure };
  }
  const service = () => rentSchedulesService({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) });
  it("previews without posting, configures one daily job, and issues only after explicit confirmation", async () => {
    const f = await fixture();
    const { preview, schedule } = await f.configure();
    expect(preview).toMatchObject({ from: "2026-10-01", through: "2026-10-07", amountMinor: 70_000 });
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(0);
    expect(
      await S.sql("SELECT id FROM sched_jobs WHERE key='property.flexible_rent' AND target_id=$1", [f.b.propertyId]),
    ).toHaveLength(1);
    const p = await f.pm.api.property.previewRentScheduleRun({ params: f.params });
    const replies = await Promise.allSettled(
      [1, 2].map(() =>
        f.pm.api.property.runRentSchedule({
          params: f.params,
          body: { previewKey: p.previewKey, confirm: "ISSUE_RENT_INVOICE" },
        }),
      ),
    );
    expect(replies.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(1);
    const current = (await f.pm.api.property.getRentSchedule({ params: f.params })).schedule!;
    expect(current.nextDate).toBe("2026-10-08");
    expect(current.version).toBe(schedule.version + 1);
    const monthly = await f.pm.api.property.runBilling({
      params: { orgId: f.o.orgId },
      body: { propertyId: f.b.propertyId, period: "2026-10", kind: "rent" },
    });
    expect(monthly.created).toHaveLength(0);
    expect(monthly.skipped[0]?.reason).toContain("flexible rent schedule");
    expect(
      await S.sql("SELECT sum(debit_minor-credit_minor)::bigint balance FROM journal_lines WHERE org_id=$1", [
        f.o.orgId,
      ]),
    ).toMatchObject([{ balance: 0 }]);
  });
  it("scheduled catch-up is idempotent, sums correctly and stops at lease end", async () => {
    const f = await fixture();
    await f.configure();
    S.setToday("2026-10-29");
    const op = { orgId: f.o.orgId, userId: null, actor: { userId: null, role: "system:test" }, today: "2026-10-29" };
    await Promise.all([service().automatic(op, f.b.propertyId), service().automatic(op, f.b.propertyId)]);
    const invoices = await S.sql("SELECT * FROM pm_invoices WHERE lease_id=$1 ORDER BY rent_from", [f.lease.id]);
    expect(invoices).toHaveLength(5);
    expect(invoices.reduce((n, x) => n + x.amount_minor, 0)).toBe(310_001);
    expect(invoices.at(-1)?.rent_through).toBe("2026-10-31");
    expect((await f.pm.api.property.getRentSchedule({ params: f.params })).schedule?.status).toBe("completed");
    await service().automatic({ ...op, today: "2026-11-10" }, f.b.propertyId);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(5);
  });
  it("pause preserves invoices; resume catches up only through the authorised schedule", async () => {
    const f = await fixture(),
      { schedule } = await f.configure();
    const paused = await f.pm.api.property.setRentScheduleStatus({
      params: f.params,
      body: {
        action: "pause",
        expectedVersion: schedule.version,
        reason: "Customer-requested temporary pause",
        confirm: "CHANGE_RENT_SCHEDULE",
      },
    });
    const op = { orgId: f.o.orgId, userId: null, actor: { userId: null, role: "system:test" }, today: "2026-10-08" };
    await service().automatic(op, f.b.propertyId);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(0);
    await f.pm.api.property.setRentScheduleStatus({
      params: f.params,
      body: {
        action: "resume",
        expectedVersion: paused.version,
        reason: "Approved resumption including unbilled periods",
        confirm: "CHANGE_RENT_SCHEDULE",
      },
    });
    await service().automatic(op, f.b.propertyId);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(2);
  });
  it("rejects legacy-month overlap, historical activation, stale configuration and unavailable authority", async () => {
    const f = await fixture();
    await f.pm.api.property.runBilling({
      params: { orgId: f.o.orgId },
      body: { propertyId: f.b.propertyId, period: "2026-10", kind: "rent" },
    });
    await refused(f.pm.api.property.previewRentSchedule({ params: f.params, body: f.input }), 409);
    const g = await fixture(),
      a = await g.configure();
    await refused(
      g.pm.api.property.saveRentSchedule({
        params: g.params,
        body: { input: g.input, previewKey: a.preview.previewKey, confirm: "ENABLE_RENT_SCHEDULE" },
      }),
      409,
    );
    const h = await fixture();
    S.setToday("2026-10-02");
    await refused(h.pm.api.property.previewRentSchedule({ params: h.params, body: h.input }), 400);
  });
  it("enforces organisation, viewer and scoped Main Manager boundaries", async () => {
    const f = await fixture(),
      other = await pmOrg(S);
    await refused(other.admin.api.property.getRentSchedule({ params: f.params }), 404);
    await refused(f.o.staff.viewer.api.property.previewRentSchedule({ params: f.params, body: f.input }), 403);
    const manager = await S.addMember(f.o.orgId, f.o.admin.api, "main_manager");
    await f.o.admin.api.organisations.setManagerGrants({
      params: { orgId: f.o.orgId, userId: manager.userId },
      body: {
        grants: [
          {
            product: "property",
            capabilities: ["property.read", "property.billing"],
            propertyIds: [f.b.propertyId],
            enabled: true,
          },
        ],
        reason: "Delegate assigned billing operations",
        confirm: "SAVE_PERMISSIONS",
      },
    });
    await f.configure(manager);
    const outside = await setUpBuilding(f.o.orgId, f.pm, { name: "Unassigned building", units: ["Unassigned"] });
    const tenantId = await newTenant(f.pm, f.o.orgId, "Unassigned tenant");
    const lease = await f.pm.api.property.createLease({
      params: { orgId: f.o.orgId },
      body: {
        unitId: outside.units.Unassigned!,
        tenantId,
        startDate: "2026-10-01",
        rentMinor: 310_000,
        depositMinor: 0,
        depositMode: "none",
      },
    });
    await refused(manager.api.property.getRentSchedule({ params: { orgId: f.o.orgId, leaseId: lease.id } }), 404);
  });
  it("supports custom-day edits, rejects stale invoice previews and prevents early issuance", async () => {
    const f = await fixture(null),
      initial = await f.configure();
    const stale = await f.pm.api.property.previewRentScheduleRun({ params: f.params });
    const input = {
      ...f.input,
      cadence: "custom_days" as const,
      everyDays: 10,
      expectedVersion: initial.schedule.version,
    };
    const preview = await f.pm.api.property.previewRentSchedule({ params: f.params, body: input });
    expect(preview.through).toBe("2026-10-10");
    await f.pm.api.property.saveRentSchedule({
      params: f.params,
      body: { input, previewKey: preview.previewKey, confirm: "ENABLE_RENT_SCHEDULE" },
    });
    await refused(
      f.pm.api.property.runRentSchedule({
        params: f.params,
        body: { previewKey: stale.previewKey, confirm: "ISSUE_RENT_INVOICE" },
      }),
      409,
    );
    const p = await f.pm.api.property.previewRentScheduleRun({ params: f.params });
    const result = await f.pm.api.property.runRentSchedule({
      params: f.params,
      body: { previewKey: p.previewKey, confirm: "ISSUE_RENT_INVOICE" },
    });
    expect(result.invoice?.rentThrough).toBe("2026-10-10");
    const next = await f.pm.api.property.previewRentScheduleRun({ params: f.params });
    expect(next.due).toBe(false);
    await refused(
      f.pm.api.property.runRentSchedule({
        params: f.params,
        body: { previewKey: next.previewKey, confirm: "ISSUE_RENT_INVOICE" },
      }),
      409,
    );
    const current = result.schedule;
    const changed = {
      ...input,
      cadence: "monthly" as const,
      everyDays: null,
      startDate: current.nextDate,
      expectedVersion: current.version,
    };
    const check = await f.pm.api.property.previewRentSchedule({ params: f.params, body: changed });
    expect(check.through).toBe("2026-11-10");
  });
  it("dispatches from the shared scheduler with the organisation timezone", async () => {
    const f = await fixture();
    await f.configure();
    await S.sql(
      "UPDATE sched_jobs SET status='paused',paused_reason='isolated test' WHERE target_id IS DISTINCT FROM $1",
      [f.b.propertyId],
    );
    const [job] = await S.sql(
      "SELECT id,next_run_at FROM sched_jobs WHERE key='property.flexible_rent' AND target_id=$1",
      [f.b.propertyId],
    );
    await S.sql("UPDATE sched_jobs SET next_run_at='2026-10-01T03:00:00Z' WHERE id=$1", [job.id]);
    const at = new Date("2026-10-01T03:01:00Z");
    expect(await S.app.core.scheduler.runOnce("rent-test", at)).toBe(true);
    const [run] = await S.sql(
      "SELECT status,summary FROM sched_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1",
      [job.id],
    );
    expect(run.status).toBe("succeeded");
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(1);
  });
  it("blocks missing authority, exposes recovery errors, and never bills a terminated lease", async () => {
    const f = await fixture();
    await f.configure();
    await S.sql("UPDATE pm_agreements SET end_date='2026-10-03' WHERE id=$1", [f.b.agreementId]);
    const op = { orgId: f.o.orgId, userId: null, actor: { userId: null, role: "system:test" }, today: "2026-10-01" };
    await service().automatic(op, f.b.propertyId);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(0);
    const blocked = (await f.pm.api.property.getRentSchedule({ params: f.params })).schedule!;
    expect(blocked.lastError).toContain("Management authority");
    expect(blocked.nextDate).toBe("2026-10-01");
    await S.sql("UPDATE pm_agreements SET end_date=NULL WHERE id=$1", [f.b.agreementId]);
    await service().automatic(op, f.b.propertyId);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(1);
    await S.sql("UPDATE pm_leases SET status='ended',end_date='2026-10-07' WHERE id=$1", [f.lease.id]);
    await service().automatic({ ...op, today: "2026-10-08" }, f.b.propertyId);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [f.lease.id])).toHaveLength(1);
    expect((await f.pm.api.property.getRentSchedule({ params: f.params })).schedule?.status).toBe("completed");
  });
  it("does not allow an amendment to reprice issued weekly rent", async () => {
    const f = await fixture();
    await f.configure();
    const p = await f.pm.api.property.previewRentScheduleRun({ params: f.params });
    await f.pm.api.property.runRentSchedule({
      params: f.params,
      body: { previewKey: p.previewKey, confirm: "ISSUE_RENT_INVOICE" },
    });
    await refused(
      f.pm.api.property.reviewRent({
        params: f.params,
        body: { rentMinor: 620_000, effectiveFrom: "2026-10-05", reason: "Retrospective rent change" },
      }),
      409,
    );
    await f.pm.api.property.reviewRent({
      params: f.params,
      body: { rentMinor: 620_000, effectiveFrom: "2026-10-08", reason: "Agreed prospective rent change" },
    });
    S.setToday("2026-10-08");
    const next = await f.pm.api.property.previewRentScheduleRun({ params: f.params });
    expect(next.amountMinor).toBeGreaterThan(139_990);
    expect((await S.sql("SELECT amount_minor FROM pm_invoices WHERE lease_id=$1", [f.lease.id]))[0].amount_minor).toBe(
      70_000,
    );
  });
  it("uses the authority for the billed interval, not the later catch-up issue date", async () => {
    const f = await fixture();
    await f.configure();
    await S.sql("UPDATE pm_agreements SET end_date='2026-10-07' WHERE id=$1", [f.b.agreementId]);
    const op = { orgId: f.o.orgId, userId: null, actor: { userId: null, role: "system:test" }, today: "2026-10-10" };
    await service().automatic(op, f.b.propertyId);
    const invoices = await S.sql(
      "SELECT agreement_id,rent_from,rent_through,issue_date FROM pm_invoices WHERE lease_id=$1",
      [f.lease.id],
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      agreement_id: f.b.agreementId,
      rent_from: "2026-10-01",
      rent_through: "2026-10-07",
      issue_date: "2026-10-10",
    });
    expect((await f.pm.api.property.getRentSchedule({ params: f.params })).schedule?.lastError).toContain(
      "Management authority",
    );
  });
});
