import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrate } from "../dist/db/migrate.js";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("flexible rent in-place upgrade protects existing inventory and finances", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-01");
  });
  afterAll(() => S.close());
  it("adds metadata and indexes without changing invoices, posted journals or unit IDs", async () => {
    const { orgId, staff } = await pmOrg(S),
      pm = staff.property_manager,
      b = await setUpBuilding(orgId, pm, { units: ["Existing unit"] });
    const tenantId = await newTenant(pm, orgId, "Synthetic pre-upgrade tenant");
    const lease = await pm.api.property.createLease({
      params: { orgId },
      body: {
        unitId: b.units["Existing unit"]!,
        tenantId,
        startDate: "2026-10-01",
        rentMinor: 310_000,
        depositMinor: 0,
        depositMode: "none",
      },
    });
    await pm.api.property.activateLease({
      params: { orgId, leaseId: lease.id },
      body: { signedOn: "2026-10-01", billFirstRent: true },
    });
    // Reconstruct the exact pre-0058 schema in this disposable test database only.
    await S.sql(`DROP TABLE pm_rent_schedules;
   DROP INDEX pm_invoice_billing_key; DROP INDEX pm_invoice_rent_start; DROP INDEX pm_invoice_rent_ranges; DROP INDEX pm_invoices_rent_once;
   ALTER TABLE pm_invoices DROP CONSTRAINT pm_rent_interval_valid;
   ALTER TABLE pm_invoices DROP CONSTRAINT pm_scheduled_rent_metadata;
   ALTER TABLE pm_invoices DROP COLUMN billing_key,DROP COLUMN rent_from,DROP COLUMN rent_through;
   CREATE UNIQUE INDEX pm_invoices_rent_once ON pm_invoices(lease_id,period) WHERE kind='rent';
   DELETE FROM schema_migrations WHERE version='0058_property_rent_schedules'`);
    const invoices = await S.sql("SELECT to_jsonb(i) AS data FROM pm_invoices i WHERE org_id=$1 ORDER BY id", [orgId]);
    const journals = await S.sql("SELECT * FROM journal_entries WHERE org_id=$1 ORDER BY id", [orgId]);
    const lines = await S.sql("SELECT * FROM journal_lines WHERE org_id=$1 ORDER BY entry_id,line_no", [orgId]);
    const units = await S.sql("SELECT * FROM pm_units WHERE org_id=$1 ORDER BY id", [orgId]);
    expect(await migrate(S.app.ctx.db)).toEqual(["0058_property_rent_schedules"]);
    expect(await migrate(S.app.ctx.db)).toEqual([]);
    expect(
      await S.sql(
        "SELECT to_jsonb(i)-'billing_key'-'rent_from'-'rent_through' AS data FROM pm_invoices i WHERE org_id=$1 ORDER BY id",
        [orgId],
      ),
    ).toEqual(invoices);
    expect(await S.sql("SELECT * FROM journal_entries WHERE org_id=$1 ORDER BY id", [orgId])).toEqual(journals);
    expect(await S.sql("SELECT * FROM journal_lines WHERE org_id=$1 ORDER BY entry_id,line_no", [orgId])).toEqual(
      lines,
    );
    expect(await S.sql("SELECT * FROM pm_units WHERE org_id=$1 ORDER BY id", [orgId])).toEqual(units);
    const run = await pm.api.property.runBilling({
      params: { orgId },
      body: { propertyId: b.propertyId, period: "2026-10", kind: "rent" },
    });
    expect(run.created).toHaveLength(0);
    await expect(
      S.sql(
        `INSERT INTO pm_invoices(id,org_id,number,kind,lease_id,tenant_id,owner_id,agreement_id,period,issue_date,due_date,amount_minor)
    SELECT 'duplicate-month',org_id,'DUP-MONTH',kind,lease_id,tenant_id,owner_id,agreement_id,period,issue_date,due_date,amount_minor FROM pm_invoices WHERE lease_id=$1`,
        [lease.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
