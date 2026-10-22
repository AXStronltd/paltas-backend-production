import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTenant, startPropertyServer } from "./support/property-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("100-unit Property Pro trial acceptance", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
  });
  afterAll(() => S.close());
  it("keeps variable-floor inventory, 100 tenancies, invoices and recorded receipts consistent with one ledger", async () => {
    const { orgId, admin } = await S.newOrg({
      name: "Synthetic 100 unit trial",
      product: "property",
      plan: "PM-GROWTH",
      trial: true,
    });
    const pm = await S.addMember(orgId, admin.api, "property_manager");
    const accountant = await S.addMember(orgId, admin.api, "accountant");
    const p = await pm.api.property.createProperty({
      params: { orgId },
      body: { name: "Acceptance Tower", address: "Synthetic test building", kind: "residential" },
    });
    const counts = [4, 6, 3, 7, 5, 5, 5, 5, 5, 5]; // 50 apartments per block; floors need not be identical.
    const inputs = [];
    for (const name of ["West", "East"]) {
      const block = await pm.api.property.createBuilding({
        params: { orgId, propertyId: p.id },
        body: { name, floors: 10 },
      });
      for (const [i, count] of counts.entries())
        for (let door = 1; door <= count; door++)
          inputs.push({
            buildingId: block.id,
            floor: String(i + 1),
            unitNo: `${String(i + 1).padStart(2, "0")}${String(door).padStart(2, "0")} ${name[0]}`,
            marketRentMinor: 100_000,
          });
    }
    const created = await pm.api.property.createUnits({ params: { orgId, propertyId: p.id }, body: { units: inputs } });
    expect(created.units).toHaveLength(100);
    expect(new Set(created.units.map((u) => u.unitNo)).size).toBe(100);
    const owner = (
      await pm.api.contacts.createContact({ params: { orgId }, body: { name: "Synthetic owner", types: ["owner"] } })
    ).contact;
    await pm.api.property.createAgreement({
      params: { orgId },
      body: {
        propertyId: p.id,
        ownerId: owner.id,
        feePct: 10,
        authorityMinor: 100_000,
        payoutDay: 10,
        startDate: "2026-01-01",
      },
    });
    for (const [i, unit] of created.units.entries()) {
      const tenantId = await newTenant(
        pm,
        orgId,
        `Synthetic Resident ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
      );
      const lease = await pm.api.property.createLease({
        params: { orgId },
        body: {
          unitId: unit.id,
          tenantId,
          startDate: "2026-10-01",
          rentMinor: 100_000,
          depositMode: "none",
          depositMinor: 0,
          dueDay: 5,
        },
      });
      const activated = await pm.api.property.activateLease({
        params: { orgId, leaseId: lease.id },
        body: { signedOn: "2026-10-01", billFirstRent: true },
      });
      const invoice = activated.firstRentInvoice!;
      expect(invoice.amountMinor).toBe(100_000);
      const amount = i < 50 ? 100_000 : i < 75 ? 40_000 : 0;
      if (amount)
        await accountant.api.property.recordPayment({
          params: { orgId },
          body: {
            tenantId,
            date: "2026-10-01",
            amountMinor: amount,
            method: "bank_transfer",
            reference: `SYNTHETIC-RECORDED-${i}`,
            allocations: [{ invoiceId: invoice.id, amountMinor: amount }],
          },
        });
    }
    const rerun = await pm.api.property.runBilling({
      params: { orgId },
      body: { propertyId: p.id, period: "2026-10", kind: "rent" },
    });
    expect(rerun.created).toHaveLength(0);
    const invoices = (
      await accountant.api.property.listInvoices({ params: { orgId }, query: { propertyId: p.id, period: "2026-10" } })
    ).invoices;
    expect(invoices).toHaveLength(100);
    expect(invoices.filter((x) => x.status === "paid")).toHaveLength(50);
    expect(invoices.filter((x) => x.status === "part_paid")).toHaveLength(25);
    expect(invoices.filter((x) => x.status === "open")).toHaveLength(25);
    const d = await accountant.api.property.dashboard({
      params: { orgId },
      query: { month: "2026-10", propertyId: p.id },
    });
    expect(d.occupancy).toMatchObject({ units: 100, let: 100, vacant: 0 });
    expect(d).toMatchObject({ billedMinor: 10_000_000, collectedMinor: 6_000_000, arrears: { totalMinor: 4_000_000 } });
    for (const check of Object.values(d.ledger)) expect(check.agrees).toBe(true);
    const statements = await accountant.api.ledger.financialStatements({
      params: { orgId },
      query: { from: "2026-10-01", to: "2026-10-01" },
    });
    expect(statements.balanceSheet.balanced).toBe(true);
    expect(statements.profitAndLoss.incomeMinor).toBe(600_000); // management fees, never gross owner rent
    expect(statements.rows.find((x) => x.code === "1040")?.closingMinor).toBe(6_000_000);
    const reloaded = await pm.api.property.getProperty({ params: { orgId, propertyId: p.id } });
    expect(reloaded.units).toHaveLength(100);
    for (const [i, count] of counts.entries())
      expect(reloaded.units.filter((u) => u.floor === String(i + 1))).toHaveLength(count * 2);
    const other = await S.newOrg({ name: "Other trial client", product: "property", plan: "PM-GROWTH", trial: true });
    await refused(other.admin.api.property.getProperty({ params: { orgId, propertyId: p.id } }), 404);
  }, 120_000);
});
