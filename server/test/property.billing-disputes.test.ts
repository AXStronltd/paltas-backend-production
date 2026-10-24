import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  tenant: Person,
  otherTenant: Person,
  invoiceId: string,
  propertyId: string,
  dispute: P.BillingDispute;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  tenant = await S.addMember(orgId, admin.api, "tenant");
  otherTenant = await S.addMember(orgId, admin.api, "tenant");
  const t = await newTenant(admin, orgId, "Utility Dispute Tenant");
  const t2 = await newTenant(admin, orgId, "Unrelated Tenant");
  await admin.api.contacts.updateContact({ params: { orgId, contactId: t }, body: { userId: tenant.userId } });
  await admin.api.contacts.updateContact({ params: { orgId, contactId: t2 }, body: { userId: otherTenant.userId } });
  const water = await admin.api.property.createChargeType({
    params: { orgId },
    body: { code: "WATER", name: "Water", metered: true, unitName: "m3", rateMinor: 100, payee: "owner" },
  });
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: {
      unitId: b.units["A-101"]!,
      tenantId: t,
      startDate: "2026-10-01",
      rentMinor: 100000,
      charges: [{ chargeTypeId: water.id, amountMinor: null }],
    },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: false },
  });
  await admin.api.property.recordMeterReadings({
    params: { orgId },
    body: {
      period: "2026-10",
      readings: [{ unitId: b.units["A-101"]!, chargeTypeId: water.id, previous: 10, current: 25 }],
    },
  });
  const run = await admin.api.property.runBilling({
    params: { orgId },
    body: { propertyId, period: "2026-10", kind: "charges" },
  });
  invoiceId = run.created[0]!.id;
  expect(run.created[0]!.amountMinor).toBe(1500);
});
afterAll(() => S.close());
it("lets a tenant query their utility invoice without changing the invoice, lease or ledger", async () => {
  dispute = await tenant.api.property.tenantCreateBillingDispute({
    params: { orgId },
    body: { invoiceId, amountMinor: 500, reason: "Meter reading needs review" },
  });
  expect(dispute.status).toBe("open");
  expect(dispute.events).toHaveLength(1);
  expect((await tenant.api.property.tenantPortal({ params: { orgId } })).invoices[0]?.balanceMinor).toBe(1500);
  await refused(
    tenant.api.property.tenantCreateBillingDispute({
      params: { orgId },
      body: { invoiceId, amountMinor: 500, reason: "Duplicate request" },
    }),
    409,
  );
});
it("prevents another tenant, organisation or unauthorised role from accessing the dispute", async () => {
  expect((await otherTenant.api.property.tenantBillingDisputes({ params: { orgId } })).disputes).toHaveLength(0);
  await refused(
    otherTenant.api.property.tenantCreateBillingDispute({
      params: { orgId },
      body: { invoiceId, amountMinor: 500, reason: "Not my invoice" },
    }),
    404,
  );
  await refused(
    otherTenant.api.property.tenantBillingDisputeAction({
      params: { orgId, disputeId: dispute.id },
      body: { expectedVersion: dispute.version, action: "withdraw", reason: "Not my case" },
    }),
    404,
  );
  await refused(
    tenant.api.property.tenantBillingDisputeAction({
      params: { orgId, disputeId: dispute.id },
      body: { expectedVersion: dispute.version, action: "resolve", reason: "Cannot self approve" },
    }),
    403,
  );
  const other = await pmOrg(S);
  await refused(other.admin.api.property.listBillingDisputes({ params: { orgId } }), 404);
});
it("supports reviewed resolution linked to an actual credit, then reconciles with the existing ledger", async () => {
  dispute = await admin.api.property.billingDisputeAction({
    params: { orgId, disputeId: dispute.id },
    body: { expectedVersion: dispute.version, action: "review", reason: "Checking original readings" },
  });
  expect(dispute.status).toBe("reviewing");
  await refused(
    admin.api.property.billingDisputeAction({
      params: { orgId, disputeId: dispute.id },
      body: { expectedVersion: 1, action: "resolve", reason: "Stale decision" },
    }),
    409,
  );
  const inv = await admin.api.property.createCreditNote({
    params: { orgId, invoiceId },
    body: { amountMinor: 500, reason: "Correct disputed water charge" },
  });
  const credit = inv.allocations.find((x) => x.source === "credit_note")!;
  dispute = await admin.api.property.billingDisputeAction({
    params: { orgId, disputeId: dispute.id },
    body: {
      expectedVersion: dispute.version,
      action: "resolve",
      reason: "Meter error corrected with posted credit",
      creditNoteId: credit.sourceId,
    },
  });
  expect(dispute.creditNoteId).toBe(credit.sourceId);
  expect(dispute.status).toBe("resolved");
  expect(dispute.events).toHaveLength(3);
  const page = await tenant.api.property.tenantBillingDisputes({ params: { orgId } });
  expect(page.disputes[0]?.resolution).toContain("Meter error");
  expect((await tenant.api.property.tenantPortal({ params: { orgId } })).invoices[0]?.balanceMinor).toBe(1000);
  const d = await admin.api.property.dashboard({ params: { orgId } });
  expect(Object.values(d.ledger).every((x) => x.agrees)).toBe(true);
});
it("lets a tenant reopen or withdraw without altering contractual or financial records", async () => {
  dispute = await tenant.api.property.tenantBillingDisputeAction({
    params: { orgId, disputeId: dispute.id },
    body: { expectedVersion: dispute.version, action: "reopen", reason: "Please review the explanation again" },
  });
  expect(dispute.status).toBe("open");
  dispute = await tenant.api.property.tenantBillingDisputeAction({
    params: { orgId, disputeId: dispute.id },
    body: { expectedVersion: dispute.version, action: "withdraw", reason: "Explanation accepted by tenant" },
  });
  expect(dispute.status).toBe("withdrawn");
  expect((await admin.api.property.getInvoice({ params: { orgId, invoiceId } })).balanceMinor).toBe(1000);
  const events = await S.sql("SELECT id FROM pm_billing_dispute_events WHERE dispute_id=$1", [dispute.id]);
  expect(events.length).toBe(5);
});
it("rejects an unrelated credit and enforces scoped manager visibility", async () => {
  const r = await tenant.api.property.tenantCreateBillingDispute({
    params: { orgId },
    body: { invoiceId, amountMinor: 100, reason: "A separate billing query" },
  });
  await refused(
    admin.api.property.billingDisputeAction({
      params: { orgId, disputeId: r.id },
      body: {
        expectedVersion: r.version,
        action: "resolve",
        reason: "Invalid credit reference",
        creditNoteId: "pcn_missing",
      },
    }),
    400,
  );
  const manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.read','property.billing','property.tenants.history'],ARRAY[]::text[],$3)",
    [orgId, manager.userId, admin.userId],
  );
  expect((await manager.api.property.listBillingDisputes({ params: { orgId } })).disputes).toHaveLength(0);
  await refused(
    manager.api.property.billingDisputeAction({
      params: { orgId, disputeId: r.id },
      body: { expectedVersion: r.version, action: "review", reason: "Not assigned" },
    }),
    404,
  );
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[$3]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
    propertyId,
  ]);
  expect((await manager.api.property.listBillingDisputes({ params: { orgId } })).total).toBe(2);
});
