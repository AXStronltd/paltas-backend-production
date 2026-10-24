import { afterAll, beforeAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer, admin: Person, reviewer: Person, orgId: string, propertyId: string, tenantId: string;
let receiptId: string;
const query = { from: "2026-10-01", to: "2026-10-25" };
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  reviewer = o.staff.finance_director;
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  tenantId = await newTenant(admin, orgId, "Cashbook Tenant");
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000, dueDay: 5 },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: true },
  });
  const p = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-24", amountMinor: 120000, method: "cash", reference: "CASHBOOK-01" },
  });
  receiptId = p.id;
});
afterAll(() => S.close());
it("separates receipt-date cash, property allocations, excess credit and current balances", async () => {
  const all = await admin.api.property.collectionsOverview({ params: { orgId }, query });
  expect(all).toMatchObject({
    currency: "KES",
    receiptsMinor: 120000,
    bankMatchedMinor: 0,
    unmatchedMinor: 120000,
    billedMinor: 100000,
    outstandingMinor: 0,
    total: 1,
    collectionRatePct: 100,
    tenants: { paid: 1, credited: 0, partial: 0, unpaid: 0 },
  });
  const scoped = await admin.api.property.collectionsOverview({ params: { orgId }, query: { ...query, propertyId } });
  expect(scoped).toMatchObject({ scopedAllocations: true, receiptsMinor: 100000 });
  expect(scoped.rows[0]).toMatchObject({ id: receiptId, amountMinor: 100000, date: "2026-10-24" });
  const today = await admin.api.property.collectionsOverview({
    params: { orgId },
    query: { from: "2026-10-25", to: "2026-10-25" },
  });
  expect(today.receiptsMinor).toBe(0);
  expect(today.total).toBe(0);
  const emptyPage = await admin.api.property.collectionsOverview({
    params: { orgId },
    query: { ...query, limit: 1, offset: 1 },
  });
  expect(emptyPage.rows).toHaveLength(0);
  expect(emptyPage.total).toBe(1);
});
it("validates dates and rejects foreign organisation, filter and unauthorised role", async () => {
  const other = await pmOrg(S);
  await refused(other.admin.api.property.collectionsOverview({ params: { orgId }, query }), 404);
  await refused(
    other.admin.api.property.collectionsOverview({ params: { orgId: other.orgId }, query: { ...query, propertyId } }),
    404,
  );
  await refused(
    admin.api.property.collectionsOverview({ params: { orgId }, query: { from: "2026-10-25", to: "2026-10-24" } }),
    400,
  );
  await refused(
    admin.api.property.collectionsOverview({ params: { orgId }, query: { ...query, to: "2026-10-26" } }),
    400,
  );
  const tech = await S.addMember(orgId, admin.api, "technician");
  await refused(tech.api.property.collectionsOverview({ params: { orgId }, query }), 403);
});
it("excludes an approved reversed receipt and restores the invoice balance", async () => {
  await admin.api.property.requestPaymentReversal({
    params: { orgId, paymentId: receiptId },
    body: { reason: "Synthetic correction" },
  });
  await reviewer.api.property.approvePaymentReversal({ params: { orgId, paymentId: receiptId } });
  const r = await admin.api.property.collectionsOverview({ params: { orgId }, query });
  expect(r.invoices).toHaveLength(1);
  expect(r.invoices[0]?.balanceMinor).toBe(100000);
  expect(r).toMatchObject({
    receiptsMinor: 0,
    outstandingMinor: 100000,
    overdueMinor: 100000,
    tenants: { paid: 0, unpaid: 1 },
  });
});

it("enforces assigned-property delegation and revocation", async () => {
  const manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.reports.read','property.read','property.tenants.history'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
  await refused(manager.api.property.collectionsOverview({ params: { orgId }, query }), 400);
  const scoped = await manager.api.property.collectionsOverview({ params: { orgId }, query: { ...query, propertyId } });
  expect(scoped.scopedAllocations).toBe(true);
  const other = await setUpBuilding(orgId, admin, { name: "Unassigned building" });
  await refused(
    manager.api.property.collectionsOverview({ params: { orgId }, query: { ...query, propertyId: other.propertyId } }),
    404,
  );
  await S.sql("UPDATE main_manager_grants SET enabled=false WHERE org_id=$1 AND user_id=$2", [orgId, manager.userId]);
  await refused(manager.api.property.collectionsOverview({ params: { orgId }, query: { ...query, propertyId } }), 403);
});

it("shows bank matching without claiming settlement or profit", async () => {
  const o = await pmOrg(S);
  const t = await newTenant(o.admin, o.orgId, "Matched cashbook tenant");
  await o.admin.api.property.recordPayment({
    params: { orgId: o.orgId },
    body: {
      tenantId: t,
      date: "2026-10-24",
      amountMinor: 45000,
      method: "bank_transfer",
      reference: "MATCHED-CASHBOOK",
    },
  });
  const imp = await o.staff.accountant.api.property.importBankLines({
    params: { orgId: o.orgId },
    body: {
      statement: "Synthetic",
      lines: [{ date: "2026-10-24", amountMinor: 45000, reference: "MATCHED-CASHBOOK" }],
    },
  });
  expect(imp.matched).toBe(1);
  const report = await o.admin.api.property.collectionsOverview({ params: { orgId: o.orgId }, query });
  expect(report).toMatchObject({ receiptsMinor: 45000, bankMatchedMinor: 45000, unmatchedMinor: 0 });
  expect(report.rows[0]?.bankMatched).toBe(true);
});

it("keeps credit-note settlement distinct from cash-backed payment", async () => {
  const all = await admin.api.property.listInvoices({ params: { orgId } });
  const inv = all.invoices.find((i) => i.tenantId === tenantId)!;
  await admin.api.property.createCreditNote({
    params: { orgId, invoiceId: inv.id },
    body: { amountMinor: 100000, reason: "Synthetic credit correction" },
  });
  const r = await admin.api.property.collectionsOverview({ params: { orgId }, query });
  expect(r).toMatchObject({
    receiptsMinor: 0,
    cohortAllocatedMinor: 0,
    cohortCreditedMinor: 100000,
    collectionRatePct: null,
    tenants: { paid: 0, credited: 1, unpaid: 0 },
  });
  expect(r.invoices).toHaveLength(0);
  const billed = await admin.api.property.collectionsOverview({
    params: { orgId },
    query: { ...query, invoiceStatus: "billed" },
  });
  expect(billed.invoiceTotal).toBe(1);
  expect(billed.invoices[0]?.balanceMinor).toBe(0);
});
