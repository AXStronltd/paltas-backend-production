import { afterAll, beforeAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, newTenant, setUpBuilding } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import { collectionCsvCell } from "../dist/products/property/reports/collections-export.js";
let S: TestServer, admin: Person, orgId: string, propertyId: string, tenantId: string;
const query = { from: "2026-10-01", to: "2026-10-25", kind: "receipts" as const };
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  ({ orgId, admin } = await pmOrg(S));
  const building = await setUpBuilding(orgId, admin);
  propertyId = building.propertyId;
  tenantId = await newTenant(admin, orgId, ' =HYPERLINK("example")');
  const lease = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: building.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000, dueDay: 5 },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: lease.id },
    body: { signedOn: "2026-10-01", billFirstRent: true },
  });
  for (let n = 0; n < 52; n++)
    await admin.api.property.recordPayment({
      params: { orgId },
      body: { tenantId, date: "2026-10-24", amountMinor: 2500, method: "cash", reference: `ROW-${n},"quoted"` },
    });
});
afterAll(() => S.close());
it("exports all matching receipts beyond one screen page, exact amounts, source IDs and audit fingerprint", async () => {
  const page = await admin.api.property.collectionsOverview({ params: { orgId }, query });
  expect(page.rows).toHaveLength(50);
  const r = await admin.api.property.exportCollections({ params: { orgId }, query });
  expect(r.rowCount).toBe(52);
  expect(r.content.split("\r\n")).toHaveLength(54);
  expect(r.content).toContain('"25.00"');
  expect(r.content).toContain('ROW-51,""quoted""');
  expect(r.content).toContain(page.rows[0]!.id);
  expect(r.content).toContain("including unallocated credit");
  expect(r.content).toContain("'=HYPERLINK");
  expect(r.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const audit = await S.sql<{ after: { fingerprint: string; rowCount: number } }>(
    "SELECT after FROM audit_log WHERE org_id=$1 AND action='Collections report exported' ORDER BY id DESC LIMIT 1",
    [orgId],
  );
  expect(audit[0]!.after).toMatchObject({ fingerprint: r.fingerprint, rowCount: 52 });
});
it("exports asset allocations separately from excess credit, plus current invoice balances", async () => {
  const scoped = await admin.api.property.exportCollections({ params: { orgId }, query: { ...query, propertyId } });
  expect(scoped.rowCount).toBe(40);
  expect(scoped.content).toContain("Direct allocations");
  const open = await admin.api.property.exportCollections({
    params: { orgId },
    query: { ...query, kind: "invoices", invoiceStatus: "open" },
  });
  expect(open.rowCount).toBe(0);
  const billed = await admin.api.property.exportCollections({
    params: { orgId },
    query: { ...query, kind: "invoices", invoiceStatus: "billed" },
  });
  expect(billed.rowCount).toBe(1);
  expect(billed.content).toContain('"1000.00","0.00"');
  expect(billed.content).toContain("Current outstanding");
});
it("checks current grants, organisation/property isolation and ordinary role permissions", async () => {
  const other = await pmOrg(S);
  await refused(other.admin.api.property.exportCollections({ params: { orgId }, query }), 404);
  await refused(
    other.admin.api.property.exportCollections({ params: { orgId: other.orgId }, query: { ...query, propertyId } }),
    404,
  );
  const tech = await S.addMember(orgId, admin.api, "technician");
  await refused(tech.api.property.exportCollections({ params: { orgId }, query }), 403);
  const manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.reports.read','property.tenants.history'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
  await refused(manager.api.property.exportCollections({ params: { orgId }, query }), 400);
  expect(
    (await manager.api.property.exportCollections({ params: { orgId }, query: { ...query, propertyId } })).rowCount,
  ).toBe(40);
  await S.sql("DELETE FROM main_manager_grants WHERE org_id=$1 AND user_id=$2", [orgId, manager.userId]);
  await refused(manager.api.property.exportCollections({ params: { orgId }, query: { ...query, propertyId } }), 403);
});
it("rejects invalid/future dates and neutralises formulas including whitespace prefixes", async () => {
  await refused(
    admin.api.property.exportCollections({ params: { orgId }, query: { ...query, to: "2026-10-26" } }),
    400,
  );
  await refused(
    admin.api.property.exportCollections({ params: { orgId }, query: { ...query, from: "2026-11-01" } }),
    400,
  );
  for (const text of ["=1+1", " +SUM(A1)", "\t@SUM(A1)", "\r-12"]) expect(collectionCsvCell(text)).toContain("'");
  expect(collectionCsvCell('safe,"text"\nnext')).toBe('"safe,""text""\nnext"');
});
