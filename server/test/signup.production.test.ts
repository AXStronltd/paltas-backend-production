// No demo or sample organisation can exist on the production path: a production server starts with none, the core
// onboarding refuses a demo organisation when NODE_ENV=production, setup:local refuses to run there, no migration or
// catalogue seed creates an organisation or an account, and self-service sign-up only ever creates real ones.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganisationRecords } from "../dist/core/admin/admin.service.js";
import { seedCatalogue } from "../dist/core/catalogue/catalogue.seed.js";
import { DEFAULTS } from "./support/platform-fixtures.js";
import { postSignup, signupBody, signupServer } from "./support/signup-fixture.js";
import { type TestServer } from "./support/test-server.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe("production: no demo or sample organisations", () => {
  let S: TestServer;

  beforeAll(async () => {
    S = await signupServer({}, { env: "production" });
  });
  afterAll(() => S.close());

  it("a production server starts with no organisation, no account and no membership", async () => {
    for (const t of ["organisations", "users", "memberships", "subscriptions"])
      expect(await S.sql(`SELECT 1 FROM ${t}`), t).toEqual([]);
    // seeding the catalogue again (idempotent) adds prices and plans only
    await seedCatalogue(S.app.core.db);
    expect(await S.sql("SELECT 1 FROM organisations")).toEqual([]);
  });

  it("no migration and no seed inserts an organisation, an account or a membership", () => {
    const dir = here("../migrations/");
    const sources = [
      ...readdirSync(dir).map((f) => readFileSync(dir + f, "utf8")),
      readFileSync(here("../src/core/catalogue/catalogue.seed.ts"), "utf8"),
    ];
    for (const s of sources) expect(s).not.toMatch(/INSERT\s+INTO\s+(organisations|users|memberships)\b/i);
  });

  it("the core onboarding refuses a demo organisation in production (and allows a real one)", async () => {
    const ctx = {
      clock: S.app.clock,
      products: S.app.ctx.products,
      config: { ...DEFAULTS, env: "production" as const },
    };
    const input = {
      name: "Sample Lettings (demo)",
      product: "property" as const,
      planId: "PM-STARTER",
      country: "Kenya",
      currency: "KES",
      timezone: "Africa/Nairobi",
      trial: true,
    };
    await expect(S.app.core.db.tx((t) => createOrganisationRecords(t, ctx, { ...input, demo: true }))).rejects.toThrow(
      /cannot be created in production/,
    );
    expect(await S.sql("SELECT 1 FROM organisations")).toEqual([]);
    const real = await S.app.core.db.tx((t) =>
      createOrganisationRecords(t, ctx, { ...input, name: "Real Lettings Ltd" }),
    );
    expect(await S.sql("SELECT demo FROM organisations WHERE id = $1", [real.id])).toEqual([{ demo: false }]);
  });

  it("setup:local refuses to run with NODE_ENV=production and creates nothing", () => {
    const r = spawnSync(process.execPath, [here("../dist/scripts/setup-local.js")], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        DATABASE_URL: S.app.ctx.config.databaseUrl,
        SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/setup:local is for local computers only/);
  });

  it("self-service sign-up in production creates a real (non-demo) organisation with a real trial", async () => {
    const b = signupBody("security");
    expect((await postSignup(S, b)).status).toBe(201);
    const rows = await S.sql<{ demo: boolean; status: string; staff_role: string | null }>(
      `SELECT o.demo, s.status, u.staff_role FROM organisations o JOIN subscriptions s ON s.org_id = o.id
       JOIN memberships m ON m.org_id = o.id JOIN users u ON u.id = m.user_id WHERE u.email = lower($1)`,
      [b.email],
    );
    expect(rows).toEqual([{ demo: false, status: "trial", staff_role: null }]);
    expect(await S.sql("SELECT 1 FROM organisations WHERE demo")).toEqual([]);
  });
});
