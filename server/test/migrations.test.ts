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
