// The live database (paltas-v2-db) holds real rows written under migrations 0001–0006. This builds such a database
// — migrations 0001–0006 exactly as the live server recorded them, the live catalogue seed, the Super Admin the first
// `npm run bootstrap` created, and representative rows (organisations, members, trial and active subscriptions,
// invoices, posted journals, data-migration jobs with imported records, hotel data) — then lets THIS code start on
// it in production mode: migrations 0007–0020 must apply, every row must survive, and the server must be healthy.
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
const NEW = [
  "0007",
  "0008",
  "0009",
  "0010",
  "0011",
  "0012",
  "0013",
  "0014",
  "0015",
  "0016",
  "0017",
  "0019",
  "0020",
  "0021",
  "0022",
  "0023",
  "0024",
  "0025",
  "0026",
  "0027",
  "0028",
  "0029",
  "0029",
  "0030",
  "0030",
  "0031",
  "0032",
  "0033",
  "0034",
  "0035",
  "0036",
  "0037",
  "0038",
  "0039",
  "0040",
  "0041",
];
const KEY = randomBytes(32).toString("base64");

/** Exactly what the live server's migrate() did: each file applied and recorded with its checksum. */
async function applyLiveMigrations(db: Database, versions: string[] = LIVE) {
  const files = (await readdir(MIGRATIONS)).filter((f) => versions.includes(f.slice(0, 4))).sort();
  expect(files).toHaveLength(versions.length);
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

describe("live database upgrade: 0001–0006 with real rows, then 0007–0020", () => {
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
    // the catalogue as the live database may hold it: DEV-PRO still without a price (the older seed), and a price the
    // owner already changed by hand (audited) — 0015 must price the first and leave the second alone
    await db.run(
      "UPDATE catalogue_plans SET base_minor = NULL, currency = NULL WHERE id IN ('DEV-PRO', 'DEV-ENTERPRISE')",
    );
    await db.run("UPDATE catalogue_plans SET base_minor = 2_750_000 WHERE id = 'PM-STARTER'");
    await db.run("UPDATE catalogue_modules SET price_minor = 650_000 WHERE key = 'finance'");
    await db.run(
      "INSERT INTO audit_log (actor_role, action, target, detail) VALUES ('super_admin', 'Plan changed', 'PM-STARTER', 'owner price')",
    );
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

  it("applies 0007–0020 on it, keeps every row, and fills new columns with safe values", async () => {
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

    // 0015: the catalogue is complete; rows a person changed keep their values; DEV-PRO gets the owner's price
    expect(
      await db.rows(
        "SELECT id, base_minor::int AS b, currency FROM catalogue_plans WHERE id IN ('PM-STARTER', 'DEV-PRO', 'DEV-ENTERPRISE') ORDER BY id",
      ),
    ).toEqual([
      { id: "DEV-ENTERPRISE", b: null, currency: null },
      { id: "DEV-PRO", b: 15_000_000, currency: "KES" },
      { id: "PM-STARTER", b: 2_750_000, currency: "KES" },
    ]);
    expect(await db.row("SELECT price_minor::int AS p FROM catalogue_modules WHERE key = 'finance'")).toEqual({
      p: 650_000,
    });
    expect(Number((await db.row<{ n: string }>("SELECT count(*) AS n FROM catalogue_modules"))?.n)).toBe(8);

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

// A live database whose catalogue was never seeded (no bootstrap run): its subscriptions had plans but no module rows,
// so every module-gated write was refused. After 0015 the same subscriptions have their plans' modules.
describe("live database without catalogue modules: 0015 gives existing subscriptions their plans' modules", () => {
  const name = `paltas_nomodules_${process.pid}_${randomBytes(3).toString("hex")}`;
  const url = dbUrl(name);
  let db: Database;
  let app: App | null = null;
  const admin = { email: "owner@paltashub.test", password: "Owner-Chosen-Password-2", secret: newTotpSecret() };

  beforeAll(async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    db = connect(url, 2);
    await applyLiveMigrations(db); // no seedCatalogue: only the hotel plans of 0005 exist
    await createUser(db, {
      email: admin.email,
      name: "PALTAS Super Admin",
      password: admin.password,
      staffRole: "super_admin",
      mfaSecretSealed: secretBox(KEY).seal(admin.secret),
    });
    await db.run(
      `INSERT INTO organisations (id, name, legal_name, country, currency, timezone, discount_pct, terms_note) VALUES
         ('org_nomod_hotel', 'Coral Bay Hotel', 'Coral Bay Hotel Ltd', 'Kenya', 'KES', 'Africa/Nairobi', 0, '')`,
    );
    await db.run(
      `INSERT INTO subscriptions (org_id, product, plan_id, status, anchor) VALUES
         ('org_nomod_hotel', 'hotel', 'HOTEL-STD', 'active', '2026-09-01')`,
    );
    expect(await db.rows("SELECT key FROM catalogue_modules")).toEqual([]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });

  it("applies 0007–0020 and the hotel subscription now has maintenance, finance and documents", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: url,
      SECRETS_KEY: KEY,
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      SCHEDULER_WORKER: "false",
    });
    app = await buildApp(config);
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const api = createClient({ baseUrl: base, token: null, validateResponses: true });
    const s = await api.identity.login({
      body: { email: admin.email, password: admin.password, code: totp(admin.secret) },
    });
    const staff = createClient({ baseUrl: base, token: s.token, validateResponses: true });
    const org = await staff.admin.getOrganisation({ params: { orgId: "org_nomod_hotel" } });
    const modules = org.subscriptions[0]!.entitlement.modules;
    expect(
      Object.keys(modules)
        .filter((k) => modules[k])
        .sort(),
    ).toEqual(["docs", "finance", "maint"]);
    expect(await db.rows("SELECT org_id, plan_id, status FROM subscriptions")).toEqual([
      { org_id: "org_nomod_hotel", plan_id: "HOTEL-STD", status: "active" },
    ]);
  });
});

// The live paltas-v2-db today: migrations 0001–0013 applied (the recovery export shows 13), the bootstrap catalogue,
// one Super Admin, and rows in every table this release's migrations touch. Then this code's migrations 0014–0020
// apply and the server starts in production exactly as render.yaml configures it — Gmail SMTP chosen, SMTP password
// possibly not entered yet — and must be healthy and ready.
describe("live database at main (0001–0013) with real rows, then 0014–0020 and a production start", () => {
  const name = `paltas_main_${process.pid}_${randomBytes(3).toString("hex")}`;
  const url = dbUrl(name);
  const MAIN = ["0007", "0008", "0009", "0010", "0011", "0012", "0013"];
  let db: Database;
  let app: App | null = null;
  const admin = { email: "main-admin@paltashub.test", password: "Owner-Chosen-Password-3", secret: newTotpSecret() };
  let before: Record<string, unknown[]>;
  const SNAPSHOT: Record<string, string> = {
    notifications: "SELECT id, status, provider, provider_message_id, body FROM notifications ORDER BY id",
    templates: "SELECT id, subject, body FROM notification_templates WHERE org_id IS NOT NULL ORDER BY id",
    documents: "SELECT id, org_id, filename, sha256 FROM pm_documents ORDER BY id",
    plans: "SELECT id, base_minor, currency, modules FROM catalogue_plans ORDER BY id",
    modules: "SELECT key, name, price_minor FROM catalogue_modules ORDER BY key",
    policy: "SELECT version, trial_days, grace_days, verify_within_days FROM trial_policy",
    users: "SELECT id, email, password_hash FROM users ORDER BY id",
    subscriptions: "SELECT org_id, product, plan_id, status, grace_days FROM subscriptions ORDER BY org_id, product",
    journals: "SELECT id, status FROM journal_entries ORDER BY id",
  };

  beforeAll(async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    db = connect(url, 2);
    // the live history: 0001–0006 with real rows, then main's 0007–0013, each recorded with its checksum
    await applyLiveMigrations(db);
    await seedCatalogue(db); // the bootstrap seed
    await createUser(db, {
      email: admin.email,
      name: "PALTAS Super Admin",
      password: admin.password,
      staffRole: "super_admin",
      mfaSecretSealed: secretBox(KEY).seal(admin.secret),
    });
    await db.run(await readFile(ROWS, "utf8")); // organisations, members, subscriptions, invoices, journals, hotel…
    await applyLiveMigrations(db, MAIN);
    // a Super Admin already re-priced a plan and a module: the catalogue migration must not touch them
    await db.run("UPDATE catalogue_plans SET base_minor = 2_750_000 WHERE id = 'PM-STARTER'");
    await db.run("UPDATE catalogue_modules SET price_minor = 650_000 WHERE key = 'finance'");
    // the outbox as main left it: a recorded verification, a test-adapter queued one, a provider-sent one
    await db.run(
      `INSERT INTO notifications (id, org_id, channel, to_address, category, template_key, subject, body, status,
         provider, provider_message_id, source, source_ref) VALUES
       ('ntf_main_1', 'org_legacy_pm', 'email', 'admin@legacy.test', 'transactional', 'signup.verify', 'Verify',
        'Hello', 'recorded', NULL, NULL, 'platform', 'signup.verify:main1'),
       ('ntf_main_2', 'org_legacy_pm', 'email', 'admin@legacy.test', 'transactional', NULL, 'Note', 'Body',
        'queued', 'test', NULL, 'manual', NULL),
       ('ntf_main_3', 'org_legacy_hotel', 'email', 'guest@legacy.test', 'transactional', NULL, 'Stay', 'Body',
        'sent', 'platform_resend', 're-main-3', 'hotel', NULL)`,
    );
    // an organisation's own template wording, and a property document record without bytes
    await db.run(
      `INSERT INTO notification_templates (id, org_id, key, channel, subject, body) VALUES
       ('tpl_main_org', 'org_legacy_pm', 'signup.verify', 'email', 'Our wording', 'Hello {{name}} {{link}}')`,
    );
    await db.run(`INSERT INTO pm_properties (id, org_id, name) VALUES ('pmp_main_1', 'org_legacy_pm', 'Almas Tower')`);
    await db.run(
      `INSERT INTO pm_documents (id, org_id, doc_type, filename) VALUES ('pmd_main_1', 'org_legacy_pm', 'lease', 'lease.pdf')`,
    );
    before = Object.fromEntries(
      await Promise.all(Object.entries(SNAPSHOT).map(async ([k, q]) => [k, await db.rows(q)] as const)),
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });

  it("applies only 0014–0020, additively: every existing row and every changed price is kept", async () => {
    const applied = await migrate(db);
    expect(applied.map((v) => v.slice(0, 4))).toEqual([
      "0014",
      "0015",
      "0016",
      "0017",
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0029",
      "0030",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
      "0037",
      "0038",
      "0039",
      "0040",
      "0041",
    ]);
    expect(await migrate(db)).toEqual([]); // checksums of 0001–0013 unchanged
    for (const [k, q] of Object.entries(SNAPSHOT)) {
      const after = await db.rows(q);
      if (k === "plans" || k === "modules") {
        // the catalogue only gains rows; nothing that existed changes
        for (const row of before[k]!) expect(after).toContainEqual(row);
      } else if (k === "policy") {
        expect(after).toEqual(
          before[k]!.map((row) => ({
            ...(row as Record<string, unknown>),
            version: 2,
            grace_days: 0,
          })),
        );
        expect(await db.row("SELECT change_source FROM trial_policy_history WHERE version=2")).toEqual({
          change_source: "release",
        });
        expect(await db.row("SELECT suspend_unverified_requires_delivery AS s FROM trial_policy")).toEqual({
          s: true,
        });
      } else expect([k, after]).toEqual([k, before[k]]);
    }
    expect(Number((await db.row<{ n: string }>("SELECT count(*) AS n FROM catalogue_modules"))?.n)).toBe(8);
    // every plan's modules exist, so existing subscriptions get their plans' modules
    expect(
      await db.rows(
        "SELECT p.id, m FROM catalogue_plans p, unnest(p.modules) m WHERE m NOT IN (SELECT key FROM catalogue_modules)",
      ),
    ).toEqual([]);
    // new statuses are allowed; the old ones still hold
    await db.run("UPDATE notifications SET status = 'delivered', delivered_at = now() WHERE id = 'ntf_main_3'");
    await expect(db.run("UPDATE notifications SET status = 'delivered' WHERE id = 'ntf_main_2'")).rejects.toThrow();
    expect(await db.rows("SELECT * FROM password_resets")).toEqual([]);
    expect(await db.rows("SELECT * FROM staff_enrollments")).toEqual([]);
    expect(await db.rows("SELECT * FROM staff_backup_codes")).toEqual([]);
    expect(
      await db.rows("SELECT id FROM users WHERE mfa_confirmed_at IS NOT NULL OR mfa_last_step IS NOT NULL"),
    ).toEqual([]);
    expect(await db.rows("SELECT document_id FROM pm_document_files")).toEqual([]);
    expect(await db.rows("SELECT id FROM pm_buildings WHERE is_archived")).toEqual([]);
    expect(await db.rows("SELECT id FROM pm_units WHERE toilets IS NOT NULL")).toEqual([]);
  });

  it("starts in production as render.yaml configures it, with the SMTP password not entered: healthy and ready", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: url,
      SECRETS_KEY: KEY,
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      SIGNUP_ENABLED: "true",
      APP_BASE_URL: "https://paltas.io",
      SCHEDULER_WORKER: "false",
      MIGRATION_WORKER: "false",
      PLATFORM_EMAIL_PROVIDER: "smtp",
      PLATFORM_EMAIL_FROM: "PALTAS <supportpaltas@gmail.com>",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_USER: "supportpaltas@gmail.com",
    });
    expect(config.email.provider).toBeNull();
    app = await buildApp(config);
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const api = createClient({ baseUrl: base, token: null, validateResponses: true });
    expect(await api.identity.health()).toMatchObject({ ok: true, database: "postgres" });
    const ready = await (await fetch(base + "/api/v1/ready")).json();
    expect(ready).toMatchObject({ ready: true, database: "up", migrations: { pending: [] } });
    // no e-mail provider in use and no published terms yet: public sign-up stays closed, the API stays up
    const options = await api.signup.options();
    expect(options.enabled).toBe(false);
    expect(options.plans.length).toBeGreaterThan(0);
    const s = await api.identity.login({
      body: { email: admin.email, password: admin.password, code: totp(admin.secret) },
    });
    const staff = createClient({ baseUrl: base, token: s.token, validateResponses: true });
    expect((await staff.admin.listOrganisations()).organisations.length).toBe(3);
  });
});
