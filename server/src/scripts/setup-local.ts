/*
 * Local set-up for trying the server on your own computer:  npm run setup:local
 * Creates the catalogue, one PALTAS Super Admin and two demo organisations (Property Management and Development)
 * with their administrators. Every password and the Super Admin's authenticator secret are generated here and
 * printed ONCE — nothing secret is stored in this repository. Refuses to run in production (and the core refuses
 * any demo organisation there: core/admin createOrganisationRecords). Production customers sign themselves up
 * (POST /api/v1/public/signup) or are onboarded by PALTAS staff.
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { createOrganisationRecords } from "../core/admin/admin.service.js";
import { seedCatalogue } from "../core/catalogue/catalogue.seed.js";
import { createUser } from "../core/identity/identity.service.js";
import { newTotpSecret } from "../core/identity/totp.js";
import { connect } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { systemClock } from "../lib/clock.js";
import { secretBox } from "../lib/secret-box.js";
import { ProductRegistry } from "../products/registry.js";
import { PRODUCTS } from "../products/index.js";

const config = loadConfig();
if (config.env === "production") throw new Error("setup:local is for local computers only");
const db = connect(config.databaseUrl, 2);
const secrets = secretBox(config.secretsKey);
const ctx = { clock: systemClock(config.fixedToday), products: new ProductRegistry(PRODUCTS), config };
const printed: { email: string; password: string; authenticatorSecret?: string }[] = [];

async function person(email: string, name: string, staff: boolean): Promise<string> {
  const existing = await db.row<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  if (existing) return existing.id;
  const password = randomBytes(12).toString("base64url");
  const totp = staff ? newTotpSecret() : null;
  const { id } = await createUser(db, {
    email,
    name,
    password,
    staffRole: staff ? "super_admin" : null,
    mfaSecretSealed: totp ? secrets.seal(totp) : null,
  });
  printed.push({ email, password, ...(totp ? { authenticatorSecret: totp } : {}) });
  return id;
}

try {
  await migrate(db);
  await seedCatalogue(db);
  await person("superadmin@paltas.local", "Local Super Admin", true);
  for (const [id, name, product, plan, email] of [
    ["ORG-LOCALPM", "Sample Property Management (local demo)", "property", "PM-STARTER", "admin@pm.local"],
    ["ORG-LOCALDEV", "Sample Developments (local demo)", "developer", "DEV-STD", "admin@dev.local"],
  ] as const) {
    if (!(await db.row("SELECT 1 FROM organisations WHERE id = $1", [id]))) {
      await db.tx((t) =>
        createOrganisationRecords(t, ctx, {
          id,
          name,
          product,
          planId: plan,
          country: "Kenya",
          currency: "KES",
          timezone: "Africa/Nairobi",
          trial: true,
          demo: true,
        }),
      );
    }
    const uid = await person(email, `${name} administrator`, false);
    await db.run(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'org_admin') ON CONFLICT DO NOTHING",
      [id, uid],
    );
  }
  console.log("Local set-up done. Keep these somewhere safe — they are not shown again:");
  console.table(printed);
} finally {
  await db.close();
}
