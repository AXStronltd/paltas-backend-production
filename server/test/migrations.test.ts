// Migrations apply once, in order, and refuse to run if an applied file was edited.
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { connect } from "../dist/db/database.js";
import { migrate } from "../dist/db/migrate.js";
import { adminUrl, dbUrl } from "./support/global-setup.js";

const name = `paltas_test_mig_${process.pid}`;

describe("migrations", () => {
  afterAll(async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });

  it("apply to an empty database, then do nothing on a second run, and detect an edited migration", async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    const db = connect(dbUrl(name), 2);
    try {
      const first = await migrate(db);
      expect(first).toEqual([
        "0001_platform",
        "0002_ledger",
        "0003_ledger_hardening",
        "0004_member_invitations",
        "0005_hotel",
        "0006_migration",
        "0007_property",
        "0008_development",
        "0009_security",
        "0010_agency",
        "0011_hotel_extensions",
        "0012_platform_ops",
        "0013_self_service",
        "0014_property_document_files",
        "0015_catalogue_seed",
        "0016_email_delivery",
        "0017_password_reset",
        "0019_company_registration_profiles",
        "0020_property_block_safety",
        "0021_agency_photo_files",
        "0022_payment_corrections",
        "0023_developer_command_center",
        "0024_stripe_subscriptions",
        "0025_trial_reminders",
        "0026_us_rental_rules",
        "0027_social_campaigns",
        "0028_request_ids",
        "0029_staff_enrollment",
        "0029_staff_roles",
        "0030_staff_auth_version",
        "0030_support_chat",
        "0031_migration_table_analysis",
        "0032_property_ownership_authority",
        "0033_property_historical_reference",
        "0034_membership_product_roles",
        "0035_operational_controls",
        "0036_staff_password_reset",
        "0037_property_finance_operations",
        "0038_property_configurable_finance",
        "0039_contact_product_activity",
        "0040_property_invoice_drafts",
        "0041_property_billing_disputes",
        "0042_property_collection_plans",
        "0043_property_collection_reminders",
        "0044_property_partial_deposit_settlements",
      ]);
      expect(await migrate(db)).toEqual([]);
      // two servers starting at once: both succeed, only one applies anything
      const both = await Promise.all([migrate(db), migrate(db)]);
      expect(both).toEqual([[], []]);
      await db.run("UPDATE schema_migrations SET checksum = 'edited' WHERE version = '0002_ledger'");
      await expect(migrate(db)).rejects.toThrow(/was changed after it was applied/);
    } finally {
      await db.close();
    }
  });
});
