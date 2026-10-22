import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, setUpBuilding, newTenant, startPropertyServer, tbBalance } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("Mixed-ownership buildings managed by one department", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
  });
  afterAll(() => S.close());
  it("attributes rent to each legal owner and keeps fees and deposits separate", async () => {
    const { orgId, admin, staff } = await pmOrg(S, { name: "Synthetic Mixed Ownership Management" });
    const pm = staff.property_manager;
    const B = await setUpBuilding(orgId, pm, { units: ["101 W", "102 W"], feePct: 10 });
    const individual = (
      await pm.api.contacts.createContact({
        params: { orgId },
        body: { name: "Synthetic Individual Owner", types: ["owner"] },
      })
    ).contact.id;
    const unit = B.units["102 W"]!;
    const ownership = (
      await pm.api.property.createOwnership({
        params: { orgId },
        body: {
          propertyId: B.propertyId,
          unitIds: [unit],
          ownerId: individual,
          ownerType: "individual",
          evidenceRef: "Synthetic unit ownership evidence",
        },
      })
    ).ownerships[0]!;
    await admin.api.property.verifyOwnership({
      params: { orgId, ownershipId: ownership.id },
      body: { confirm: "VERIFIED" },
    });
    const agreement = await pm.api.property.createAgreement({
      params: { orgId },
      body: {
        propertyId: B.propertyId,
        unitId: unit,
        ownerId: individual,
        ownershipId: ownership.id,
        managementModel: "third_party",
        managementCompany: "Synthetic Building Management Department",
        evidenceRef: "Synthetic signed rental management authority",
        feePct: 8,
        authorityMinor: 200000,
        payoutDay: 10,
        startDate: "2026-01-01",
      },
    });
    await admin.api.property.activateAgreement({
      params: { orgId, agreementId: agreement.id },
      body: { confirm: "ACTIVATE", signedOn: "2026-01-01" },
    });
    for (const [unitId, ownerId] of [
      [B.units["101 W"]!, B.ownerId],
      [unit, individual],
    ] as const) {
      const tenantId = await newTenant(pm, orgId, "Synthetic Resident " + unitId);
      const lease = await pm.api.property.createLease({
        params: { orgId },
        body: {
          unitId,
          tenantId,
          startDate: "2026-10-01",
          rentMinor: 10000000,
          depositMinor: 10000000,
          depositMode: "collect",
        },
      });
      const activated = await pm.api.property.activateLease({
        params: { orgId, leaseId: lease.id },
        body: { signedOn: "2026-10-01", billFirstRent: true, firstRentPeriod: "2026-10" },
      });
      expect(activated.firstRentInvoice?.ownerId).toBe(ownerId);
      const invoices = [activated.firstRentInvoice!, activated.depositInvoice!];
      await staff.accountant.api.property.recordPayment({
        params: { orgId },
        body: {
          tenantId,
          date: "2026-10-01",
          amountMinor: 20000000,
          method: "bank_transfer",
          reference: "SYNTHETIC-" + lease.id,
          allocations: invoices.map((i) => ({ invoiceId: i.id, amountMinor: i.amountMinor })),
        },
      });
    }
    const ownerBalances = await S.sql(
      `SELECT k.owner_id, sum(l.credit_minor-l.debit_minor)::bigint AS balance FROM pm_ledger_links k JOIN journal_entries e ON e.id=k.journal_id JOIN journal_lines l ON l.entry_id=e.id WHERE k.org_id=$1 AND e.status='posted' AND l.account_code='2250' GROUP BY k.owner_id`,
      [orgId],
    );
    expect(ownerBalances).toEqual(
      expect.arrayContaining([
        { owner_id: B.ownerId, balance: 9000000 },
        { owner_id: individual, balance: 9200000 },
      ]),
    );
    expect(await tbBalance(staff.accountant, orgId, "4650")).toBe(-1800000);
    expect(await tbBalance(staff.accountant, orgId, "2300")).toBe(-20000000);
    expect(await tbBalance(staff.accountant, orgId, "1120")).toBe(0);
  });
});
