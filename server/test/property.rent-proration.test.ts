import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../dist/db/database.js";
import { rentLine } from "../dist/products/property/billing/billing.service.js";
import type { LeaseRow } from "../dist/products/property/shared/records.js";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";

// Pure pricing fixtures exercise the real shared quote without posting anything.
const quote = (
  start: string,
  end: string | null,
  period: string,
  rent = 310_000,
  steps: { effective_from: string; rent_minor: number }[] = [],
) => {
  const db = {
    row: async (_q: string, p: unknown[]) => steps.filter((x) => x.effective_from <= String(p[1])).at(-1) ?? null,
    rows: async (_q: string, p: unknown[]) =>
      steps.filter((x) => x.effective_from > String(p[1]) && x.effective_from <= String(p[2])),
  } as unknown as Db;
  return rentLine(db, { id: "synthetic", start_date: start, end_date: end, rent_minor: rent } as LeaseRow, period);
};
describe("calendar rent calculation", () => {
  it("retains full-month and existing first-month pricing", async () => {
    expect((await quote("2026-01-01", null, "2026-10")).line.amountMinor).toBe(310_000);
    expect((await quote("2026-10-16", null, "2026-10")).line.amountMinor).toBe(160_000);
  });
  it("prorates final months, short leases and one-day occupancy inclusively", async () => {
    expect((await quote("2026-01-01", "2026-10-10", "2026-10")).line.amountMinor).toBe(100_000);
    expect((await quote("2026-10-10", "2026-10-19", "2026-10")).line.amountMinor).toBe(100_000);
    expect((await quote("2026-10-10", "2026-10-10", "2026-10")).line.amountMinor).toBe(10_000);
  });
  it("uses actual leap-year days and rounds only once", async () => {
    expect((await quote("2028-02-15", "2028-02-29", "2028-02", 290_000)).line.amountMinor).toBe(150_000);
    expect((await quote("2027-02-15", "2027-02-28", "2027-02", 280_000)).line.amountMinor).toBe(140_000);
    expect((await quote("2026-10-01", "2026-10-01", "2026-10", 16)).line.amountMinor).toBe(1);
  });
  it("applies effective rent changes on their exact day and retains calculation evidence", async () => {
    const r = await quote("2026-01-01", null, "2026-10", 310_000, [
      { effective_from: "2026-09-01", rent_minor: 620_000 },
      { effective_from: "2026-10-16", rent_minor: 930_000 },
      { effective_from: "2026-11-01", rent_minor: 1_240_000 },
    ]);
    expect(r.line.amountMinor).toBe(780_000); // 15 * 20,000 + 16 * 30,000
    expect(r.note).toContain("Effective rent changes");
    expect(r.line.pricingSnapshot).toMatchObject({ from: "2026-10-01", through: "2026-10-31", daysInMonth: 31 });
    expect(r.line.pricingSnapshot?.segments as unknown[]).toHaveLength(2);
  });
  it("keeps large safe minor amounts exact despite day multiplication", async () => {
    const rent = Number.MAX_SAFE_INTEGER;
    expect((await quote("2026-01-01", null, "2026-10", rent)).line.amountMinor).toBe(rent);
  });
  it("rejects out-of-lease periods and unbillable sub-minor amounts", async () => {
    await expect(quote("2026-11-01", null, "2026-10")).rejects.toThrow("outside this lease");
    await expect(quote("2026-01-01", "2026-09-30", "2026-10")).rejects.toThrow("outside this lease");
    await expect(quote("2026-10-01", "2026-10-01", "2026-10", 1)).rejects.toThrow("minor currency unit");
  });
});

describe("rent invoice proration integrity", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
  });
  afterAll(() => S.close());
  it("preview and issue agree for a short lease; concurrent billing cannot duplicate or rewrite it", async () => {
    const { orgId, staff } = await pmOrg(S),
      pm = staff.property_manager;
    const b = await setUpBuilding(orgId, pm, { units: ["Short lease"] });
    const tenantId = await newTenant(pm, orgId, "Synthetic short tenancy");
    const l = await pm.api.property.createLease({
      params: { orgId },
      body: {
        unitId: b.units["Short lease"]!,
        tenantId,
        startDate: "2026-10-10",
        endDate: "2026-10-19",
        rentMinor: 310_000,
        depositMinor: 0,
        depositMode: "none",
        dueDay: 5,
      },
    });
    const input = { signedOn: "2026-10-01", billFirstRent: true };
    const preview = await pm.api.property.previewLeaseActivation({ params: { orgId, leaseId: l.id }, body: input });
    expect(preview).toMatchObject({ rentMinor: 100_000 });
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [l.id])).toHaveLength(0);
    const active = await pm.api.property.activateLease({ params: { orgId, leaseId: l.id }, body: input });
    expect(active.firstRentInvoice?.amountMinor).toBe(100_000);
    expect(active.firstRentInvoice?.note).toContain("Prorated 10 of 31 days");
    const original = await S.sql("SELECT * FROM pm_invoices WHERE lease_id=$1", [l.id]);
    await Promise.all(
      [1, 2].map(() =>
        pm.api.property.runBilling({
          params: { orgId },
          body: { propertyId: b.propertyId, period: "2026-10", kind: "rent" },
        }),
      ),
    );
    expect(await S.sql("SELECT * FROM pm_invoices WHERE lease_id=$1", [l.id])).toEqual(original);
    const lines = await S.sql("SELECT pricing_snapshot FROM pm_invoice_lines WHERE invoice_id=$1", [
      active.firstRentInvoice!.id,
    ]);
    expect(lines[0].pricing_snapshot.through).toBe("2026-10-19");
    const journals = await S.sql<{ debit_minor: number; credit_minor: number }>(
      "SELECT debit_minor,credit_minor FROM journal_lines WHERE entry_id=$1",
      [(await S.sql("SELECT journal_id FROM pm_invoices WHERE lease_id=$1", [l.id]))[0].journal_id],
    );
    expect(journals.length).toBeGreaterThanOrEqual(2);
    expect(journals.reduce((s, x) => s + x.debit_minor - x.credit_minor, 0)).toBe(0);
  });
});
