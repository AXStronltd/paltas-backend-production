import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rentAnalysis } from "../dist/products/property/reports/rent-insights.js";
import type { InvoiceRow } from "../dist/products/property/shared/records.js";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
const invoice = (values: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: "inv",
  org_id: "org",
  number: "RI1",
  kind: "rent",
  lease_id: "lease",
  tenant_id: "tenant",
  tenant_name: "Tenant",
  unit_id: "unit",
  unit_no: "101 E",
  property_id: "property",
  owner_id: "owner",
  agreement_id: "agreement",
  period: "2026-10",
  issue_date: "2026-10-01",
  due_date: "2026-10-05",
  amount_minor: 100_000,
  paid_minor: 0,
  credited_minor: 0,
  note: "",
  source_invoice_id: null,
  journal_id: "journal",
  mig_job_id: null,
  ...values,
});
describe("rent analytics calculations", () => {
  it("keeps cohort collection separate from credits, deposits and other periods", () => {
    const r = rentAnalysis(
      [
        invoice({ paid_minor: 40_000, credited_minor: 10_000 }),
        invoice({ id: "old", issue_date: "2026-09-01", due_date: "2026-09-05" }),
        invoice({ id: "deposit", kind: "deposit", amount_minor: 200_000 }),
        invoice({ id: "charge", kind: "charge", amount_minor: 20_000 }),
        invoice({ id: "future", issue_date: "2026-11-01" }),
      ],
      "2026-10",
      "2026-10-23",
      "KES",
    );
    expect(r).toMatchObject({
      billedMinor: 100_000,
      paidMinor: 40_000,
      creditedMinor: 10_000,
      outstandingMinor: 50_000,
      collectionRatePct: 44.44,
      overdueMinor: 150_000,
      overdueTenants: 1,
      invoiceCount: 1,
      partiallyPaidCount: 1,
      settledCount: 0,
      unpaidCount: 0,
    });
    expect(r.followUp[0]).toMatchObject({ overdueMinor: 150_000, oldestDueDate: "2026-09-05", invoiceCount: 2 });
    expect(r.ageing.map((b) => b.amountMinor)).toEqual([0, 50_000, 100_000, 0, 0]);
  });
  it("does not call credit-note settlement money received", () => {
    const r = rentAnalysis([invoice({ credited_minor: 100_000 })], "2026-10", "2026-10-23", "KES");
    expect(r.settledCount).toBe(1);
    expect(r.paidMinor).toBe(0);
    expect(r.collectionRatePct).toBeNull();
    expect(r.overdueMinor).toBe(0);
  });
  it("respects due-today, 7-day and ageing boundaries and limits follow-up", () => {
    const dates = [
      "2026-10-23",
      "2026-10-30",
      "2026-10-31",
      "2026-10-22",
      "2026-09-23",
      "2026-09-22",
      "2026-08-24",
      "2026-08-23",
      "2026-07-25",
      "2026-07-24",
    ];
    const r = rentAnalysis(
      dates.map((due_date, i) => invoice({ id: String(i), due_date, issue_date: "2026-07-01" })),
      "2026-10",
      "2026-10-23",
      "KES",
    );
    expect(r.dueSoonMinor).toBe(200_000);
    expect(r.ageing.map((b) => b.amountMinor)).toEqual([300_000, 200_000, 200_000, 200_000, 100_000]);
    const many = rentAnalysis(
      Array.from({ length: 12 }, (_, i) => invoice({ tenant_id: String(i), amount_minor: (i + 1) * 100 })),
      "2026-10",
      "2026-10-23",
      "KES",
    );
    expect(many.overdueTenants).toBe(12);
    expect(many.followUp).toHaveLength(10);
    expect(many.followUp[0]?.overdueMinor).toBe(1200);
  });
});

describe("authorised rent dashboard integration", () => {
  let S: TestServer, orgId: string, admin: Person, tenantId: string, propertyId: string;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-23");
    const o = await pmOrg(S);
    orgId = o.orgId;
    admin = o.admin;
    const b = await setUpBuilding(orgId, admin);
    propertyId = b.propertyId;
    tenantId = await newTenant(admin, orgId, "Rent Insight Tenant");
    const lease = await admin.api.property.createLease({
      params: { orgId },
      body: {
        unitId: Object.values(b.units)[0]!,
        tenantId,
        startDate: "2026-10-01",
        rentMinor: 100_000,
        depositMinor: 0,
        depositMode: "none",
        dueDay: 5,
      },
    });
    await admin.api.property.activateLease({
      params: { orgId, leaseId: lease.id },
      body: { signedOn: "2026-10-23", billFirstRent: true },
    });
    await admin.api.property.recordPayment({
      params: { orgId },
      body: {
        tenantId,
        amountMinor: 40_000,
        method: "bank_transfer",
        reference: "INSIGHT-1",
        date: "2026-10-23",
      },
    });
  });
  afterAll(() => S.close());
  it("uses actual invoices and effective allocations with no report writes", async () => {
    const d = await admin.api.property.dashboard({ params: { orgId }, query: { month: "2026-10", propertyId } });
    expect(d.rentAnalysis).toMatchObject({
      currency: "KES",
      billedMinor: 100_000,
      paidMinor: 40_000,
      outstandingMinor: 60_000,
      overdueMinor: 60_000,
      collectionRatePct: 40,
    });
    expect(d.rentAnalysis?.followUp[0]?.tenantId).toBe(tenantId);
    const again = await admin.api.property.dashboard({ params: { orgId }, query: { month: "2026-10" } });
    expect(again.rentAnalysis).toEqual(d.rentAnalysis);
    expect(Object.values(again.ledger).every((x) => x.agrees)).toBe(true);
  });
  it("rejects another organisation and unrelated property IDs", async () => {
    const other = await pmOrg(S);
    await refused(other.admin.api.property.dashboard({ params: { orgId } }), 404);
    await refused(other.admin.api.property.dashboard({ params: { orgId: other.orgId }, query: { propertyId } }), 404);
    expect(
      (await other.admin.api.property.dashboard({ params: { orgId: other.orgId } })).rentAnalysis?.billedMinor,
    ).toBe(0);
  });
  it("does not expose financial insights to a maintenance-only user", async () => {
    const technician = await S.addMember(orgId, admin.api, "technician");
    await refused(technician.api.property.dashboard({ params: { orgId } }), 403);
  });
});
