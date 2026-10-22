import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPropertyServer, pmOrg } from "./support/property-fixture.js";
import { upload, waitFor } from "./support/migration-fixtures.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";
describe("annual reports become explicit non-posting monthly history", () => {
  let S: TestServer, admin: Person, reviewer: Person, orgId: string, propertyId: string, jobId: string, tableId: string;
  const params = () => ({ orgId, jobId });
  beforeAll(async () => {
    S = await startPropertyServer();
    const o = await pmOrg(S);
    orgId = o.orgId;
    admin = o.admin;
    reviewer = o.staff.finance_director;
    propertyId = (
      await admin.api.property.createProperty({ params: { orgId }, body: { name: "Saved history property" } })
    ).id;
    await admin.api.property.createUnits({
      params: { orgId, propertyId },
      body: { units: [{ unitNo: "0804 E" }, { unitNo: "805 E" }] },
    });
    jobId = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: { domain: "property", name: "2021 annual history", sourceSystem: "old-excel", cutoverDate: "2026-10-01" },
      })
    ).id;
    await upload(
      admin.api,
      orgId,
      jobId,
      "2021.csv",
      Buffer.from(
        "COMPANY LIMITED\nService charge report 2021\n\nUnit,NAMES,Jan,Feb\n804 E,Example Resident,1000,0\n805 E,Another Resident,1000,\nTOTAL,,2000,0",
      ),
    );
    const r = await admin.api.migration.detect({ params: params() });
    tableId = r.tables[0]!.id;
    expect(r.tables[0]!.analysis?.classification).toBe("annual_matrix");
  });
  afterAll(() => S.close());
  it("requires confirmed meaning rather than treating monthly columns as dated invoices", async () => {
    const e = await refused(
      admin.api.migration.mapTable({
        params: { ...params(), tableId },
        body: { entity: "opening_invoice", columns: [{ source: "Jan", field: "amount" }] },
      }),
      400,
    );
    expect(e.message).toMatch(/annual monthly report/);
  });
  it("normalises source periods, original cells, zeros and compact unit aliases without a payment date", async () => {
    const r = await admin.api.migration.mapTable({
      params: { ...params(), tableId },
      body: {
        normaliseAnnual: {
          propertyId,
          year: 2021,
          unitColumn: "Unit",
          subjectColumn: "NAMES",
          subjectType: "tenant",
          kind: "service_charge_summary",
          currency: "KES",
          confirm: "REFERENCE ONLY",
        },
      },
    });
    expect(r.entity).toBe("historical_summary");
    expect(r.rowCount).toBe(3);
    expect(r.sample.map((x) => x.source_cell)).toEqual(["C5", "D5", "C6"]);
    expect(r.sample.map((x) => x.period)).toEqual(["2021-01", "2021-02", "2021-01"]);
    expect(r.sample[1]!.amount).toBe("0");
    expect(r.sample[0]).not.toHaveProperty("date");
    const v = await admin.api.migration.validate({ params: params() });
    expect(v.errors).toBe(0);
  });
  it("previews reference counts with no financial postings, requires separate approval, imports and reconciles", async () => {
    const d = await admin.api.migration.dryRun({ params: params() });
    expect(d.ledger).toHaveLength(0);
    expect(d.byEntity.find((x) => x.entity === "historical_summary")?.create).toBe(3);
    expect(await S.sql("SELECT id FROM pm_historical_records WHERE org_id=$1", [orgId])).toHaveLength(0);
    await refused(admin.api.migration.approve({ params: params(), body: { confirm: "CONFIRM" } }), 403);
    await reviewer.api.migration.approve({ params: params(), body: { confirm: "CONFIRM" } });
    await admin.api.migration.startImport({ params: params() });
    await waitFor(
      () => admin.api.migration.getJob({ params: params() }),
      (j) => j.status === "reconciled" || j.status === "failed",
    );
    const job = await admin.api.migration.getJob({ params: params() });
    expect(job.status).toBe("reconciled");
    const r = await admin.api.migration.reconcile({ params: params() });
    expect(r.ok).toBe(true);
    expect((await admin.api.property.listHistoricalSummaries({ params: { orgId }, query: {} })).total).toBe(3);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE org_id=$1", [orgId])).toHaveLength(0);
    expect(await S.sql("SELECT id FROM pm_payments WHERE org_id=$1", [orgId])).toHaveLength(0);
    expect(await S.sql("SELECT id FROM journal_entries WHERE org_id=$1", [orgId])).toHaveLength(0);
    expect((await S.sql("SELECT count(*)::int n FROM pm_units WHERE org_id=$1", [orgId]))[0]!.n).toBe(2);
  });
  it("recognises a repeat import and refuses altered source totals before staging", async () => {
    const again = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: {
          domain: "property",
          name: "Repeat monthly reference",
          sourceSystem: "old-excel",
          cutoverDate: "2026-10-01",
        },
      })
    ).id;
    const data = Buffer.from(
      "COMPANY LIMITED\nService charge report 2021\n\nUnit,NAMES,Jan,Feb\n804 E,Example Resident,1000,0\n805 E,Another Resident,1000,\nTOTAL,,2000,0",
    );
    await upload(admin.api, orgId, again, "2021.csv", data);
    const detected = await admin.api.migration.detect({ params: { orgId, jobId: again } });
    const tab = detected.tables[0]!;
    await admin.api.migration.mapTable({
      params: { orgId, jobId: again, tableId: tab.id },
      body: {
        normaliseAnnual: {
          propertyId,
          year: 2021,
          unitColumn: "Unit",
          subjectColumn: "NAMES",
          subjectType: "tenant",
          kind: "service_charge_summary",
          currency: "KES",
          confirm: "REFERENCE ONLY",
        },
      },
    });
    const v = await admin.api.migration.validate({ params: { orgId, jobId: again } });
    expect(v.errors).toBe(0);
    expect(v.byCode.ALREADY_PRESENT).toBe(3);
    const wrong = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: {
          domain: "property",
          name: "Incorrect monthly source total",
          sourceSystem: "old-excel",
          cutoverDate: "2026-10-01",
        },
      })
    ).id;
    await upload(
      admin.api,
      orgId,
      wrong,
      "2021.csv",
      Buffer.from(data.toString().replace("TOTAL,,2000,0", "TOTAL,,999,0")),
    );
    const d = await admin.api.migration.detect({ params: { orgId, jobId: wrong } });
    const e = await refused(
      admin.api.migration.mapTable({
        params: { orgId, jobId: wrong, tableId: d.tables[0]!.id },
        body: {
          normaliseAnnual: {
            propertyId,
            year: 2021,
            unitColumn: "Unit",
            subjectColumn: "NAMES",
            subjectType: "tenant",
            kind: "service_charge_summary",
            currency: "KES",
            confirm: "REFERENCE ONLY",
          },
        },
      }),
      400,
    );
    expect(e.message).toMatch(/do not agree/);
    expect((await admin.api.property.listHistoricalSummaries({ params: { orgId }, query: {} })).total).toBe(3);
  });
  it("isolates history reads from another organisation", async () => {
    const other = await pmOrg(S);
    await refused(other.admin.api.property.listHistoricalSummaries({ params: { orgId }, query: {} }), 404);
    expect(
      (await other.admin.api.property.listHistoricalSummaries({ params: { orgId: other.orgId }, query: {} })).total,
    ).toBe(0);
  });
});
