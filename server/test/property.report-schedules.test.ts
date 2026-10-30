import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import {
  collectionReportWindow,
  COLLECTION_REPORT_JOB,
} from "../dist/products/property/reports/report-schedules.service.js";
let S: TestServer, orgId: string, admin: Person, manager: Person, propertyId: string;
const today = new Date().toISOString().slice(0, 10),
  yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
const O = () => ({ orgId });
const input = () => ({
  propertyId,
  name: "Daily collection cashbook",
  kind: "receipts" as const,
  format: "xlsx" as const,
  frequency: "daily" as const,
  hour: 7,
  minute: 30,
  status: "paused" as const,
  requestKey: "scheduled-report-synthetic-0001",
});
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday(today);
  ({ orgId, admin } = await pmOrg(S));
  await S.sql("UPDATE organisations SET timezone='UTC' WHERE id=$1", [orgId]);
  const building = await setUpBuilding(orgId, admin);
  propertyId = building.propertyId;
  const tenant = await newTenant(admin, orgId, "Scheduled Report Tenant");
  const lease = await admin.api.property.createLease({
    params: O(),
    body: { unitId: building.units["A-101"]!, tenantId: tenant, startDate: yesterday, rentMinor: 100000 },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: lease.id },
    body: { signedOn: yesterday, billFirstRent: true },
  });
  await admin.api.property.recordPayment({
    params: O(),
    body: {
      tenantId: tenant,
      date: yesterday,
      amountMinor: 2500,
      method: "cash",
      reference: "SCHEDULED-REPORT-SOURCE",
    },
  });
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.reports.read','property.billing','property.tenants.history'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
});
afterAll(() => S.close());
it("uses complete calendar periods including week/year/leap boundaries", () => {
  expect(collectionReportWindow("daily", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
  expect(collectionReportWindow("weekly", "2026-01-05")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
  expect(collectionReportWindow("weekly", "2026-01-07")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
  expect(collectionReportWindow("monthly", "2024-03-01")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  expect(collectionReportWindow("monthly", "2026-01-01")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
});
it("creates idempotently paused and rejects a different body with the same key", async () => {
  const b = input();
  const a = await manager.api.property.createCollectionReportSchedule({ params: O(), body: b });
  expect(a).toMatchObject({ status: "paused", jobStatus: "paused", timezone: "UTC", version: 1 });
  expect((await manager.api.property.createCollectionReportSchedule({ params: O(), body: b })).id).toBe(a.id);
  await refused(
    manager.api.property.createCollectionReportSchedule({ params: O(), body: { ...b, name: "Different report" } }),
    409,
  );
  expect(
    (await manager.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId } })).schedules,
  ).toHaveLength(1);
});
it("supports repeat changes, stale edit rejection, pause, archive and restore", async () => {
  let a = (await admin.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId } }))
    .schedules[0]!;
  const params = { orgId, reportScheduleId: a.id };
  for (const status of ["active", "paused", "archived", "paused"] as const) {
    a = await manager.api.property.updateCollectionReportSchedule({
      params,
      body: { ...input(), status, expectedVersion: a.version, reason: "Manager reviewed the report automation" },
    });
    expect(a.status).toBe(status);
    expect(a.jobStatus).toBe(status === "active" ? "active" : "paused");
  }
  await refused(
    manager.api.property.updateCollectionReportSchedule({
      params,
      body: { ...input(), expectedVersion: 1, reason: "Stale browser must not overwrite" },
    }),
    409,
  );
  const jobs = await S.sql<{ cron: string; timezone: string }>(
    "SELECT cron,timezone FROM sched_jobs WHERE key=$1 AND target_id=$2",
    [COLLECTION_REPORT_JOB, a.id],
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ cron: "30 7 * * *", timezone: "UTC" });
});
it("generates complete source reports once, permits retries and keeps immutable download history", async () => {
  const a = (await admin.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId } }))
    .schedules[0]!;
  const params = { orgId, reportScheduleId: a.id },
    body = { confirm: "GENERATE" as const };
  const before = await S.sql("SELECT id FROM journal_entries WHERE org_id=$1", [orgId]);
  const [x, y] = await Promise.all([
    manager.api.property.runCollectionReportSchedule({ params, body }),
    manager.api.property.runCollectionReportSchedule({ params, body }),
  ]);
  expect(x.id).toBe(y.id);
  expect(x).toMatchObject({ from: yesterday, to: yesterday, asOf: today, rowCount: 1, trigger: "manual" });
  const page = await manager.api.property.collectionReportRuns({ params, query: { limit: 1 } });
  expect(page.total).toBe(1);
  expect(page.reports[0]?.id).toBe(x.id);
  const file = await manager.api.property.downloadCollectionReport({ params: { orgId, reportRunId: x.id } });
  expect(file.fingerprint).toBe(x.fingerprint);
  expect(file.encoding).toBe("base64");
  expect(file.filename).toContain("Daily-collection-cashbook");
  const { readZip } = await import("../dist/core/migration/files/zip.js");
  const sheet = readZip(Buffer.from(file.content, "base64"), { maxEntries: 20, maxUncompressedBytes: 1000000 })
    .find((x) => x.name === "xl/worksheets/sheet1.xml")
    ?.data.toString();
  expect(sheet).toContain("Scheduled report");
  expect(sheet).toContain("Daily collection cashbook");
  await expect(S.sql("UPDATE pm_collection_report_runs SET content='changed' WHERE id=$1", [x.id])).rejects.toThrow(
    "immutable",
  );
  expect((await manager.api.property.downloadCollectionReport({ params: { orgId, reportRunId: x.id } })).content).toBe(
    file.content,
  );
  expect(await S.sql("SELECT id FROM journal_entries WHERE org_id=$1", [orgId])).toEqual(before);
});
it("retains old snapshots after config changes and archive while rejecting new archived runs", async () => {
  let a = (await admin.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId } }))
    .schedules[0]!;
  const params = { orgId, reportScheduleId: a.id };
  const old = (await admin.api.property.collectionReportRuns({ params })).reports[0]!;
  a = await admin.api.property.updateCollectionReportSchedule({
    params,
    body: { ...input(), format: "csv", expectedVersion: a.version, reason: "Export CSV for the accountant" },
  });
  const next = await admin.api.property.runCollectionReportSchedule({ params, body: { confirm: "GENERATE" } });
  expect(next.version).toBe(a.version);
  expect(next.id).not.toBe(old.id);
  expect(
    (await admin.api.property.downloadCollectionReport({ params: { orgId, reportRunId: next.id } })).content,
  ).toContain("SCHEDULED-REPORT-SOURCE");
  await admin.api.property.updateCollectionReportSchedule({
    params,
    body: {
      ...input(),
      format: "csv",
      status: "archived",
      expectedVersion: a.version,
      reason: "Archive the unused report schedule",
    },
  });
  await refused(admin.api.property.runCollectionReportSchedule({ params, body: { confirm: "GENERATE" } }), 409);
  expect((await admin.api.property.downloadCollectionReport({ params: { orgId, reportRunId: old.id } })).encoding).toBe(
    "base64",
  );
});
it("checks organisation, property, current grants and non-operational roles on every access", async () => {
  const a = (await admin.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId } }))
    .schedules[0]!;
  const report = (await admin.api.property.collectionReportRuns({ params: { orgId, reportScheduleId: a.id } }))
    .reports[0]!;
  const other = await pmOrg(S);
  const tech = await S.addMember(orgId, admin.api, "technician");
  await refused(other.admin.api.property.collectionReportRuns({ params: { orgId, reportScheduleId: a.id } }), 404);
  await refused(tech.api.property.downloadCollectionReport({ params: { orgId, reportRunId: report.id } }), 403);
  const foreign = await admin.api.property.createProperty({
    params: O(),
    body: { name: "Unassigned report property" },
  });
  await refused(
    manager.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId: foreign.id } }),
    404,
  );
  await S.sql("DELETE FROM main_manager_grants WHERE org_id=$1 AND user_id=$2", [orgId, manager.userId]);
  await refused(manager.api.property.downloadCollectionReport({ params: { orgId, reportRunId: report.id } }), 403);
});
it("runs the real scheduler idempotently and stops after the author loses permission", async () => {
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.reports.read','property.billing','property.tenants.history'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
  const a = await manager.api.property.createCollectionReportSchedule({
    params: O(),
    body: { ...input(), status: "active", requestKey: "automatic-report-synthetic-0002" },
  });
  const fire = async (at: Date) => {
    await S.sql(
      "UPDATE sched_jobs SET status='paused',paused_reason='Isolated report test' WHERE target_id IS DISTINCT FROM $1",
      [a.id],
    );
    await S.sql(
      "UPDATE sched_jobs SET next_run_at=$2,status='active',paused_reason=NULL WHERE target_id=$1 AND key=$3",
      [a.id, new Date(at.getTime() - 1000).toISOString(), COLLECTION_REPORT_JOB],
    );
    expect(await S.app.core.scheduler.runOnce("report-scheduler-test", at)).toBe(true);
    return (
      await S.sql<{ status: string; summary: string }>(
        "SELECT status,summary FROM sched_runs WHERE job_id=(SELECT id FROM sched_jobs WHERE target_id=$1 AND key=$2) ORDER BY created_at DESC LIMIT 1",
        [a.id, COLLECTION_REPORT_JOB],
      )
    )[0]!;
  };
  expect((await fire(new Date())).summary).toContain("available in the workspace");
  const params = { orgId, reportScheduleId: a.id };
  expect((await manager.api.property.collectionReportRuns({ params })).total).toBe(1);
  expect(
    (await admin.api.property.runCollectionReportSchedule({ params, body: { confirm: "GENERATE" } })).trigger,
  ).toBe("schedule");
  await S.sql("DELETE FROM main_manager_grants WHERE org_id=$1 AND user_id=$2", [orgId, manager.userId]);
  const result = await fire(new Date(Date.now() + 120000));
  expect(result.status).toBe("succeeded");
  expect(result.summary).toContain("authorisation was revoked");
  expect(
    (await admin.api.property.listCollectionReportSchedules({ params: O(), query: { propertyId } })).schedules.find(
      (x) => x.id === a.id,
    )?.lastSummary,
  ).toContain("authorisation was revoked");
  expect((await admin.api.property.collectionReportRuns({ params })).total).toBe(1);
  expect((await S.sql("SELECT id FROM notifications WHERE org_id=$1", [orgId])).length).toBe(0);
});
it("bounds active schedules and prevents restoration bypassing the cap", async () => {
  const p = await admin.api.property.createProperty({ params: O(), body: { name: "Bounded report property" } });
  const items = [];
  for (let n = 0; n < 20; n++)
    items.push(
      await admin.api.property.createCollectionReportSchedule({
        params: O(),
        body: { ...input(), propertyId: p.id, requestKey: "bounded-synthetic-report-" + n },
      }),
    );
  await refused(
    admin.api.property.createCollectionReportSchedule({
      params: O(),
      body: { ...input(), propertyId: p.id, requestKey: "bounded-synthetic-report-overflow" },
    }),
    400,
  );
  const first = items[0]!;
  const params = { orgId, reportScheduleId: first.id };
  const archived = await admin.api.property.updateCollectionReportSchedule({
    params,
    body: { ...input(), status: "archived", expectedVersion: first.version, reason: "Archive old report automation" },
  });
  await admin.api.property.createCollectionReportSchedule({
    params: O(),
    body: { ...input(), propertyId: p.id, requestKey: "bounded-synthetic-report-replacement" },
  });
  await refused(
    admin.api.property.updateCollectionReportSchedule({
      params,
      body: { ...input(), expectedVersion: archived.version, reason: "Restoring cannot bypass the limit" },
    }),
    400,
  );
});

it("adopts an explicitly reviewed organisation timezone when rescheduling", async () => {
  const a = await admin.api.property.createCollectionReportSchedule({
    params: O(),
    body: { ...input(), requestKey: "timezone-synthetic-report-0001" },
  });
  await S.sql("UPDATE organisations SET timezone='America/Toronto' WHERE id=$1", [orgId]);
  try {
    const updated = await admin.api.property.updateCollectionReportSchedule({
      params: { orgId, reportScheduleId: a.id },
      body: {
        ...input(),
        status: "active",
        expectedVersion: a.version,
        reason: "Review the new organisation reporting timezone",
      },
    });
    expect(updated.timezone).toBe("America/Toronto");
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(updated.nextRunAt!)),
    ).toBe("07:30");
  } finally {
    await S.sql("UPDATE organisations SET timezone='UTC' WHERE id=$1", [orgId]);
  }
});
