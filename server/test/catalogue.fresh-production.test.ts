// A brand-new production database (migrations only — no setup:local, no bootstrap seed) must sell every product:
// migration 0015 seeds the whole catalogue, the public sign-up options show it, and a business that signs up
// for any of the five products can make its first records — including the module-gated ones ("crm is not in your
// plan" was the gap). The catalogue from the migration equals the one seedCatalogue writes.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createClient, type PaltasClient } from "@paltas/api-client";
import type { Product } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { seedCatalogue } from "../dist/core/catalogue/catalogue.seed.js";
import { connect, type Database } from "../dist/db/database.js";
import { migrate } from "../dist/db/migrate.js";
import { adminUrl, dbUrl } from "./support/global-setup.js";
import { SALE } from "./support/agency-fixture.js";
import { TAX } from "./support/hotel-fixture.js";
import { signupBody } from "./support/signup-fixture.js";

const STANDARD: Record<Product, string> = Object.fromEntries(
  ["property", "developer", "hotel", "security", "agency"].map((p) => [p, `PALTAS-20261027-${p}-Standard`]),
) as Record<Product, string>;

const KEY = randomBytes(32).toString("base64");
const PUBLIC_LIMIT = 60;

async function freshDatabase(name: string): Promise<Database> {
  const a = new pg.Client({ connectionString: adminUrl() });
  await a.connect();
  await a.query(`CREATE DATABASE ${name}`);
  await a.end();
  return connect(dbUrl(name), 3);
}

async function dropDatabase(name: string) {
  const a = new pg.Client({ connectionString: adminUrl() });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await a.end();
}

const CATALOGUE_SQL = {
  modules:
    "SELECT key, name, products, deps, excludes, price_minor, price_ccy, per, scope, available FROM catalogue_modules ORDER BY key",
  plans: `SELECT id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor, currency,
            frequency, tax_pct, tax_note, cap_sites, cap_units, active FROM catalogue_plans ORDER BY id`,
};

describe("a fresh production database sells every product (migration 0015)", () => {
  const tag = `${process.pid}_${randomBytes(3).toString("hex")}`;
  const name = `paltas_fresh_${tag}`;
  const seeded = `paltas_seeded_${tag}`;
  let db: Database;
  let app: App;
  let base: string;
  let api: PaltasClient;

  beforeAll(async () => {
    db = await freshDatabase(name);
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: dbUrl(name),
      SECRETS_KEY: KEY,
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      SIGNUP_ENABLED: "true",
      APP_BASE_URL: "https://paltas.test",
      SIGNUP_TERMS_URL: "https://paltas.test/terms.html",
      SIGNUP_PRODUCTS: "property,developer,hotel,security,agency",
      // production sign-up needs a platform e-mail provider; nothing is dispatched here (no scheduler)
      PLATFORM_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_not_used",
      PLATFORM_EMAIL_FROM: "support@paltas.test",
      PUBLIC_READ_RATE_LIMIT_PER_MINUTE: String(PUBLIC_LIMIT),
      SCHEDULER_WORKER: "false",
      MIGRATION_WORKER: "false",
    });
    app = await buildApp(config, { db }); // applies every migration at start, exactly as on Render
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    api = createClient({ baseUrl: base, token: null, validateResponses: true });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    await dropDatabase(name);
    await dropDatabase(seeded);
  });

  it("has every module and every product's plans from migrations alone, with the owner's DEV-PRO price", async () => {
    expect(
      (await db.rows<{ key: string }>("SELECT key FROM catalogue_modules ORDER BY key")).map((r) => r.key),
    ).toEqual(["automation", "crm", "docs", "finance", "intelligence", "maint", "payments", "procurement"]);
    const plans = await db.rows<{ id: string; product: string; modules: string[] }>(
      "SELECT id, product, modules FROM catalogue_plans ORDER BY id",
    );
    expect(new Set(plans.map((p) => p.product))).toEqual(
      new Set(["property", "developer", "hotel", "security", "agency"]),
    );
    // every module a plan sells exists (no "Unknown module")
    const keys = new Set((await db.rows<{ key: string }>("SELECT key FROM catalogue_modules")).map((r) => r.key));
    for (const p of plans) for (const m of p.modules) expect([p.id, keys.has(m)]).toEqual([p.id, true]);
    expect(
      await db.row("SELECT base_minor::int AS b, currency, frequency FROM catalogue_plans WHERE id = 'DEV-PRO'"),
    ).toEqual({ b: 15_000_000, currency: "KES", frequency: "monthly" });
    // no organisation, account or membership comes with it
    for (const t of ["organisations", "users", "memberships"]) expect(await db.rows(`SELECT 1 FROM ${t}`)).toEqual([]);
  });

  it("gives exactly the catalogue seedCatalogue writes (one set of initial prices)", async () => {
    const other = await freshDatabase(seeded);
    try {
      await migrate(other);
      await seedCatalogue(other);
      for (const q of Object.values(CATALOGUE_SQL)) expect(await db.rows(q)).toEqual(await other.rows(q));
    } finally {
      await other.close();
    }
  });

  it("GET /public/signup-options: plans with tier, modules in words, price and the policy's trial days; cacheable", async () => {
    const res = await fetch(base + "/api/v1/public/signup-options");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const all = await api.signup.options();
    expect(all).toMatchObject({ enabled: true, termsVersion: "2026-10", termsUrl: "https://paltas.test/terms.html" });
    expect(all.trialDays).toBe(30);
    expect(new Set(all.plans.map((p) => p.product))).toEqual(
      new Set(["property", "developer", "agency", "hotel", "security"]),
    );
    const dev = all.plans.filter((p) => p.product === "developer");
    // Enterprise plans are agreed with PALTAS and are not offered for self-service
    expect(dev.map((p) => [p.id, p.tier, p.price.amount, p.price.currency, p.price.frequency])).toEqual([
      ["PALTAS-20261027-developer-Standard", "Standard", 49, "USD", "monthly"],
      ["PALTAS-20261027-developer-Pro", "Pro", 69, "USD", "monthly"],
      ["PALTAS-20261027-developer-Enterprise", "Enterprise", 99, "USD", "monthly"],
    ]);
    expect(dev[0]!.modules.map((m) => m.key)).toEqual(["crm", "finance", "payments", "procurement"]);
    expect(dev[0]!.modules[0]!.name).toBe("Advanced CRM and Marketing");
    // a Super Admin's later price change is what the page shows (prices are rows, not code)
    await db.run("UPDATE catalogue_plans SET base_minor = 9_000_000 WHERE id = 'PALTAS-20261027-developer-Standard'");
    expect(
      (await api.signup.options()).plans.find((p) => p.id === "PALTAS-20261027-developer-Standard")!.price.amount,
    ).toBe(90_000);
    await db.run("UPDATE catalogue_plans SET base_minor = 4900 WHERE id = 'PALTAS-20261027-developer-Standard'");
    // the trial length follows the ONE platform policy
    await db.run("UPDATE trial_policy SET trial_days = 21 WHERE id = 1");
    expect((await api.signup.options()).trialDays).toBe(21);
    await db.run("UPDATE trial_policy SET trial_days = 30 WHERE id = 1");
    // everything else stays uncacheable
    expect((await fetch(base + "/api/v1/health")).headers.get("cache-control")).toBe("no-store");
  });

  const firstWrites: Record<Product, (a: PaltasClient, orgId: string) => Promise<unknown>> = {
    property: (a, orgId) => a.property.createProperty({ params: { orgId }, body: { name: "Trial Court" } }),
    developer: async (a, orgId) => {
      await a.development.createProject({ params: { orgId }, body: { name: "Trial Heights" } });
      // the Sales module needs crm — the gap was "crm is not in your plan"
      return a.development.createBuyer({ params: { orgId }, body: { name: "Wanjiru Kamau", email: "wk@buyer.test" } });
    },
    hotel: (a, orgId) =>
      a.hotel.createProperty({
        params: { orgId },
        body: { name: "Trial Hotel", country: "Kenya", city: "Mombasa", timezone: "Africa/Nairobi", tax: TAX },
      }),
    security: (a, orgId) =>
      a.security.createClient({
        params: { orgId },
        body: { name: "Trial Client", contactName: "Daniel Kariuki", paymentTermsDays: 30 },
      }),
    agency: (a, orgId) => a.agency.createListing({ params: { orgId }, body: { ...SALE, title: "Trial listing one" } }),
  };

  it.each(["property", "developer", "hotel", "security", "agency"] as Product[])(
    "sign-up for %s on the Standard plan, then the first write in its main module succeeds",
    async (product) => {
      const body = signupBody(product, { plan: STANDARD[product] });
      const r = await fetch(base + "/api/v1/public/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
      const s = await api.identity.login({ body: { email: body.email, password: body.password } });
      const a = createClient({ baseUrl: base, token: s.token, validateResponses: true });
      const orgId = (await a.identity.me()).organisations[0]!.id;
      const ent = await a.subscriptions.entitlements({ params: { orgId }, query: { product } });
      expect(ent).toMatchObject({ plan: STANDARD[product], usable: true });
      const plan = await db.row<{ modules: string[] }>("SELECT modules FROM catalogue_plans WHERE id = $1", [
        STANDARD[product],
      ]);
      // the subscription has its plan's modules
      for (const m of plan!.modules) expect([m, ent.modules[m]]).toEqual([m, true]);
      await firstWrites[product](a, orgId);
      if (product === "security") {
        // Finance is a module of every Security plan: an accountant's first collections note is accepted
        const token = /verify-email#token=([A-Za-z0-9_-]+)/.exec(
          (await db.row<{ body: string }>("SELECT body FROM notifications WHERE to_address = lower($1)", [body.email]))!
            .body,
        )![1]!;
        await api.signup.verify({ body: { token } });
        const email = `acct+${randomBytes(3).toString("hex")}@business.test`;
        const m = await a.organisations.addMember({
          params: { orgId },
          body: { email, name: "Accountant", role: "accountant" },
        });
        const first = await api.identity.login({ body: { email, password: m.temporaryPassword as string } });
        const acct = createClient({ baseUrl: base, token: first.token, validateResponses: true });
        await acct.identity.changePassword({
          body: { currentPassword: m.temporaryPassword as string, newPassword: "Accountant-Chosen-1" },
        });
        const [client] = (await acct.security.listClients({ params: { orgId } })).clients;
        await acct.security.addClientNote({
          params: { orgId, clientId: client!.id },
          body: { kind: "call", text: "First call about the deposit" },
        });
      }
    },
  );

  it("limits the public sign-up options per address (429 after PUBLIC_READ_RATE_LIMIT_PER_MINUTE)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_LIMIT + 5; i++)
      statuses.push((await fetch(base + "/api/v1/public/signup-options")).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(PUBLIC_LIMIT);
  });
});
