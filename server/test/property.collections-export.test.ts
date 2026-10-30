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

it("exports genuine Excel values without executable formulas and prints escaped complete source records", async () => {
  const { readZip } = await import("../dist/core/migration/files/zip.js");
  const x = await admin.api.property.exportCollections({ params: { orgId }, query: { ...query, format: "xlsx" } });
  expect(x.encoding).toBe("base64");
  expect(x.filename).toMatch(/\.xlsx$/);
  const entries = readZip(Buffer.from(x.content, "base64"), { maxEntries: 20, maxUncompressedBytes: 10_000_000 });
  const sheet = entries.find((e) => e.name === "xl/worksheets/sheet1.xml")!.data.toString();
  expect(sheet).toContain('t="inlineStr"');
  expect(sheet).toContain("=HYPERLINK");
  expect(sheet).not.toContain("<f>");
  expect(sheet).toContain("<v>25.00</v>");
  expect(sheet.match(/<row r=/g)).toHaveLength(53);
  const print = await admin.api.property.exportCollections({ params: { orgId }, query: { ...query, format: "print" } });
  expect(print.contentType).toBe("text/html");
  expect(print.content).toContain("Save as PDF");
  expect(print.content).toContain("ROW-51");
  expect(print.content).not.toContain("<script");
  expect(print.rowCount).toBe(x.rowCount);
});
it("uses the organisation currency minor units instead of assuming cents", async () => {
  const { collectionDecimal } = await import("../dist/products/property/reports/collections-export.js");
  expect(collectionDecimal(1250, "UGX")).toBe("1250");
  expect(collectionDecimal(1250, "KES")).toBe("12.50");
  expect(collectionDecimal(0, "JPY")).toBe("0");
  expect(collectionDecimal(Number.MAX_SAFE_INTEGER, "UGX")).toBe("9007199254740991");
  expect(() => collectionDecimal(-1, "KES")).toThrow();
  expect(() => collectionDecimal(Number.NaN, "KES")).toThrow();
  const other = await pmOrg(S);
  await S.sql("UPDATE organisations SET currency='UGX' WHERE id=$1", [other.orgId]);
  const tenant = await newTenant(other.admin, other.orgId, "UGX tenant");
  await other.admin.api.property.recordPayment({
    params: { orgId: other.orgId },
    body: { tenantId: tenant, date: "2026-10-24", amountMinor: 1250, method: "cash", reference: "UGX cash collection" },
  });
  const csv = await other.admin.api.property.exportCollections({ params: { orgId: other.orgId }, query });
  expect(csv.content).toContain('"UGX","1250"');
  expect(csv.content).not.toContain('"12.50"');
});

it("enforces current organisation and role permissions for every export format", async () => {
  const other = await pmOrg(S);
  const tech = await S.addMember(orgId, admin.api, "technician");
  for (const format of ["csv", "xlsx", "print"] as const) {
    await refused(other.admin.api.property.exportCollections({ params: { orgId }, query: { ...query, format } }), 404);
    await refused(tech.api.property.exportCollections({ params: { orgId }, query: { ...query, format } }), 403);
  }
});

it("exports invoice amounts and balances in Excel and readable print columns", async () => {
  const { readZip } = await import("../dist/core/migration/files/zip.js");
  const q = { ...query, kind: "invoices" as const, invoiceStatus: "billed" as const };
  const x = await admin.api.property.exportCollections({ params: { orgId }, query: { ...q, format: "xlsx" } });
  const sheet = readZip(Buffer.from(x.content, "base64"), { maxEntries: 20, maxUncompressedBytes: 1000000 })
    .find((e) => e.name === "xl/worksheets/sheet1.xml")!
    .data.toString();
  expect(sheet).toContain("Current outstanding");
  expect(sheet).toContain("<v>1000.00</v>");
  expect(x.rowCount).toBe(1);
  const print = await admin.api.property.exportCollections({ params: { orgId }, query: { ...q, format: "print" } });
  expect(print.content).toContain("Current outstanding");
  expect(print.content).not.toContain('scope="col">Invoice ID');
  expect(print.content).toContain("Current balances as of");
});
