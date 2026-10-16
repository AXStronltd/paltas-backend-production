// The live database (paltas-v2-db) holds real rows written under migrations 0001–0006. This builds such a database
// — migrations 0001–0006 exactly as the live server recorded them, the live catalogue seed, the Super Admin the first
// `npm run bootstrap` created, and representative rows (organisations, members, trial and active subscriptions,
// invoices, posted journals, data-migration jobs with imported records, hotel data) — then lets THIS code start on
// it in production mode: migrations 0007–0014 must apply, every row must survive, and the server must be healthy.
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createClient } from "@paltas/api-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { seedCatalogue } from "../dist/core/catalogue/catalogue.seed.js";
import { createUser } from "../dist/core/identity/identity.service.js";
import { newTotpSecret, totp } from "../dist/core/identity/totp.js";
import { connect, type Database } from "../dist/db/database.js";
import { migrate } from "../dist/db/migrate.js";
import { secretBox } from "../dist/lib/secret-box.js";
import { adminUrl, dbUrl } from "./support/global-setup.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const ROWS = fileURLToPath(new URL("./support/legacy-0006-rows.sql", import.meta.url));
const LIVE = ["0001", "0002", "0003", "0004", "0005", "0006"];
const NEW = ["0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014"];
const KEY = randomBytes(32).toString("base64");

/** Exactly what the live server's migrate() did: each file applied and recorded with its checksum. */
async function applyLiveMigrations(db: Database) {
  const files = (await readdir(MIGRATIONS)).filter((f) => LIVE.includes(f.slice(0, 4))).sort();
  expect(files).toHaveLength(LIVE.length);
  await db.tx(async (t) => {
    await t.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const f of files) {
      const sql = await readFile(MIGRATIONS + f, "utf8");
      await t.run(sql);
      await t.run("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
        f.replace(/\.sql$/, ""),
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
  });
}

const COUNTED = [
  "organisations",
  "users",
  "memberships",
  "subscriptions",
  "subscription_addons",
  "billing_invoices",
  "journal_entries",
  "journal_lines",
  "mig_jobs",
  "mig_files",
  "dev_units",
  "dev_reservations",
  "dev_contracts",
  "dev_handovers",
  "hotel_properties",
  "hotel_reservations",
  "hotel_folio_lines",
  "hotel_messages",
];

describe("live database upgrade: 0001–0006 with real rows, then 0007–0014", () => {
  const name = `paltas_upgrade_${process.pid}_${randomBytes(3).toString("hex")}`;
  const url = dbUrl(name);
  let db: Database;
  let app: App | null = null;
  const admin = { email: "owner-admin@paltashub.test", password: "Owner-Chosen-Password-1", secret: newTotpSecret() };
  let before: Record<string, number>;

  const count = async (table: string) => Number((await db.row<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))?.n);

  beforeAll(async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    db = connect(url, 2);
    await applyLiveMigrations(db);
    await seedCatalogue(db); // the live seed (unchanged by this round)
    // the first `npm run bootstrap` on the live database: a Super Admin with a chosen password and two-factor
    await createUser(db, {
      email: admin.email,
      name: "PALTAS Super Admin",
      password: admin.password,
      staffRole: "super_admin",
      mfaSecretSealed: secretBox(KEY).seal(admin.secret),
    });
    await db.run(await readFile(ROWS, "utf8"));
    before = Object.fromEntries(await Promise.all(COUNTED.map(async (t) => [t, await count(t)] as const)));
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });

  it("holds the live state before the upgrade", async () => {
    expect(
      (await db.rows<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).map((r) =>
        r.version.slice(0, 4),
      ),
    ).toEqual(LIVE);
    expect(before).toMatchObject({ organisations: 3, subscriptions: 3, journal_entries: 2, dev_reservations: 2 });
  });

  it("applies 0007–0014 on it, keeps every row, and fills new columns with safe values", async () => {
    const applied = await migrate(db);
    expect(applied.map((v) => v.slice(0, 4))).toEqual(NEW);
    expect(await migrate(db)).toEqual([]); // and again: nothing to do, checksums of 0001–0006 unchanged

    for (const t of COUNTED) expect([t, await count(t)]).toEqual([t, before[t]]);

    // posted journals stay posted and balanced; the closed month stays closed
    expect(await db.rows("SELECT id, status FROM journal_entries ORDER BY id")).toEqual([
      { id: "je_legacy_1", status: "posted" },
      { id: "je_legacy_2", status: "posted" },
    ]);
    expect(
      await db.rows(
        "SELECT entry_id, sum(debit_minor)::text AS dr, sum(credit_minor)::text AS cr FROM journal_lines GROUP BY entry_id ORDER BY entry_id",
      ),
    ).toEqual([
      { entry_id: "je_legacy_1", dr: "50000000", cr: "50000000" },
      { entry_id: "je_legacy_2", dr: "1200000", cr: "1200000" },
    ]);

    // subscriptions: the running trial keeps its end date, grace 0 (as before), invoices untouched
    expect(
      await db.rows(
        "SELECT org_id, status, trial_ends::text, grace_days, trial_started FROM subscriptions ORDER BY org_id",
      ),
    ).toEqual([
      { org_id: "org_legacy_dev", status: "active", trial_ends: null, grace_days: 0, trial_started: null },
      { org_id: "org_legacy_hotel", status: "active", trial_ends: null, grace_days: 0, trial_started: null },
      { org_id: "org_legacy_pm", status: "trial", trial_ends: "2026-10-30", grace_days: 0, trial_started: null },
    ]);
    expect(await db.rows("SELECT id, status FROM billing_invoices ORDER BY id")).toEqual([
      { id: "SUB-LEGACY-1", status: "Paid" },
      { id: "SUB-LEGACY-2", status: "Open" },
      { id: "SUB-LEGACY-3", status: "Void" },
    ]);
    expect(await db.row("SELECT trial_days FROM trial_policy WHERE id = 1")).toBeTruthy();

    // imported development history that breaks the new one-per-unit rules is kept; the rules cover new records
    for (const ix of [
      "dev_reservations_one_open_per_unit",
      "dev_contracts_one_live_per_unit",
      "dev_handovers_once_per_unit",
    ])
      expect(
        (await db.row<{ d: string }>("SELECT indexdef AS d FROM pg_indexes WHERE indexname = $1", [ix]))?.d,
      ).toMatch(/mig_job_id IS NULL/);
    expect(await db.rows("SELECT id, status FROM dev_contacts ORDER BY id")).toEqual([
      { id: "dct_legacy_1", status: "active" },
      { id: "dct_legacy_2", status: "active" },
    ]);

    // hotel: the extension accounts are added, the USALI map extended where it had the department, left otherwise
    expect(
      (
        await db.rows<{ code: string }>(
          "SELECT code FROM ledger_accounts WHERE org_id = 'org_legacy_hotel' ORDER BY code",
        )
      ).length,
    ).toBe(3 + 17);
    const usali = await db.rows<{ id: string; usali: Record<string, { costs?: string[] }> }>(
      "SELECT id, usali FROM hotel_properties ORDER BY id",
    );
    expect(usali[0]!.usali.rooms!.costs).toEqual(["5100", "5150"]);
    expect(usali[1]!.usali).toEqual({});
    expect(await db.row("SELECT language, contact_id FROM hotel_guests")).toEqual({ language: "en", contact_id: null });
  });

  it("starts in production mode on the upgraded database: healthy, ready, and the live Super Admin still signs in", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: url,
      SECRETS_KEY: KEY,
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      SIGNUP_ENABLED: "true",
      APP_BASE_URL: "https://paltas.io",
    });
    expect(config.env).toBe("production");
    app = await buildApp(config); // applies pending migrations at start, as on Render (none left here)
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const api = createClient({ baseUrl: base, token: null, validateResponses: true });

    expect(await api.identity.health()).toMatchObject({ ok: true, database: "postgres" });
    const ready = await (await fetch(base + "/api/v1/ready")).json();
    expect(ready).toMatchObject({ ready: true, database: "up", migrations: { pending: [] } });

    const s = await api.identity.login({
      body: { email: admin.email, password: admin.password, code: totp(admin.secret) },
    });
    const staff = createClient({ baseUrl: base, token: s.token, validateResponses: true });
    const orgs = await staff.admin.listOrganisations();
    expect(orgs.organisations.map((o) => o.id).sort()).toEqual(["org_legacy_dev", "org_legacy_hotel", "org_legacy_pm"]);
    // the owner's organisation page works on a legacy trial, with the trial view of the shared rules
    const pm = await staff.admin.getOrganisation({ params: { orgId: "org_legacy_pm" } });
    expect(pm.subscriptions[0]).toMatchObject({ status: "trial", trialEnds: "2026-10-30" });
    expect(pm.subscriptions[0]!.entitlement.trial).not.toBeNull();
    const invoices = await staff.admin.listInvoices({ query: {} });
    expect(invoices.invoices.map((i) => i.id).sort()).toEqual(["SUB-LEGACY-1", "SUB-LEGACY-2", "SUB-LEGACY-3"]);
    // the first-admin bootstrap refuses on it (also covered by platform-ops.bootstrap.test.ts)
    expect(
      Number((await db.row<{ n: string }>("SELECT count(*) AS n FROM users WHERE staff_role IS NOT NULL"))?.n),
    ).toBe(1);
  });
});
