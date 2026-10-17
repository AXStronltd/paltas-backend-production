import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer, type Building } from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";
describe("lease activation and first rent are one transaction", () => {
  let S: TestServer, orgId: string, pm: Person, B: Building, tenantId: string;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
    const o = await pmOrg(S);
    orgId = o.orgId;
    pm = o.staff.property_manager;
    B = await setUpBuilding(orgId, pm, { units: ["A1", "A2", "A3", "A4", "A5", "A6"] });
    tenantId = await newTenant(pm, orgId, "Activation Customer");
  });
  afterAll(() => S.close());
  const draft = (unit: string, startDate = "2026-10-01", depositMinor = 0) =>
    pm.api.property.createLease({
      params: { orgId },
      body: {
        unitId: B.units[unit]!,
        tenantId,
        startDate,
        rentMinor: 12_500_000,
        depositMinor,
        depositMode: depositMinor ? "collect" : "none",
        dueDay: 5,
      },
    });
  it("issues the agreed first rent, occupies the unit, and a monthly run cannot duplicate it", async () => {
    const l = await draft("A1");
    const a = await pm.api.property.activateLease({
      params: { orgId, leaseId: l.id },
      body: { signedOn: "2026-10-01", billFirstRent: true },
    });
    expect(a.firstRentInvoice).toMatchObject({ kind: "rent", period: "2026-10", amountMinor: 12_500_000 });
    expect(a.depositInvoice).toBeNull();
    const p = await pm.api.property.getProperty({ params: { orgId, propertyId: B.propertyId } });
    expect(p.units.find((u) => u.id === l.unitId)?.occupancy).toBe("let");
    const run = await pm.api.property.runBilling({
      params: { orgId },
      body: { propertyId: B.propertyId, period: "2026-10", kind: "rent" },
    });
    expect(run.created).toHaveLength(0);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1 AND kind='rent'", [l.id])).toHaveLength(1);
  });
  it("preserves the existing explicit monthly-billing flow when not requested", async () => {
    const l = await draft("A2");
    const a = await pm.api.property.activateLease({
      params: { orgId, leaseId: l.id },
      body: { signedOn: "2026-10-01" },
    });
    expect(a.firstRentInvoice).toBeUndefined();
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [l.id])).toHaveLength(0);
  });
  it("uses the existing first-month proration rules", async () => {
    const l = await draft("A3", "2026-10-16");
    const a = await pm.api.property.activateLease({
      params: { orgId, leaseId: l.id },
      body: { signedOn: "2026-10-01", billFirstRent: true },
    });
    expect(a.firstRentInvoice?.amountMinor).toBe(Math.round((12_500_000 * 16) / 31));
    expect(a.firstRentInvoice?.note).toContain("Prorated");
  });
  it("rolls back the activation and deposit if first-rent validation fails", async () => {
    const l = await draft("A4", "2027-01-01", 100_000);
    await refused(
      pm.api.property.activateLease({
        params: { orgId, leaseId: l.id },
        body: { signedOn: "2026-10-01", billFirstRent: true },
      }),
      400,
    );
    expect((await pm.api.property.getLease({ params: { orgId, leaseId: l.id } })).lease.status).toBe("draft");
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [l.id])).toHaveLength(0);
  });
  it("serialises concurrent activation and refuses cross-company access", async () => {
    const l = await draft("A5");
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        pm.api.property.activateLease({
          params: { orgId, leaseId: l.id },
          body: { signedOn: "2026-10-01", billFirstRent: true },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1 AND kind='rent'", [l.id])).toHaveLength(1);
    const other = await pmOrg(S);
    await refused(other.admin.api.property.getLease({ params: { orgId, leaseId: l.id } }), 404);
  });
});
