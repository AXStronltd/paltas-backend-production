/*
 * The FIRST PALTAS Super Admin of an installation (production included) — one command, two spellings:
 *
 *   npm run bootstrap -- <email> <credentials-file>                 (the owner's documented form)
 *   node server/dist/scripts/bootstrap-admin.js --email <email> --file <credentials-file> [--name "<full name>"]
 *   node server/dist/scripts/bootstrap.js …   (or bootstrap-admin.js, the same command) on the server after a build
 *
 * Every run applies the pending migrations and loads the starting catalogue (existing rows are never overwritten).
 * Then, ONLY while no PALTAS staff account exists, it creates the Super Admin (core/admin/bootstrap.ts): a temporary
 * password that must be changed at first sign-in, an authenticator secret sealed with SECRETS_KEY (two-factor at
 * every sign-in), audited. Once any staff account exists every run is refused, audited and exits 1: it never creates
 * a second Super Admin and never resets a password or a secret.
 *
 * A credentials file is REQUIRED: the password and secret are written to that NEW file (owner-only; it must not
 * exist yet) and are never printed to terminals or hosting logs. Missing arguments fail before database access.
 * Run it with the server's own DATABASE_URL and SECRETS_KEY: the server cannot read a secret sealed with another key.
 */
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { bootstrapFirstSuperAdmin, BootstrapRefused, type BootstrapResult } from "../core/admin/bootstrap.js";
import { seedCatalogue } from "../core/catalogue/catalogue.seed.js";
import { connect } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { secretBox } from "../lib/secret-box.js";

const USAGE = [
  "Usage: npm run bootstrap -- <super-admin-email> <credentials-file>",
  '   or: node server/dist/scripts/bootstrap-admin.js --email <address> --file <credentials-file> [--name "<full name>"]',
].join("\n");

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function readArgs() {
  try {
    return parseArgs({
      options: {
        email: { type: "string" },
        name: { type: "string", default: "PALTAS Super Admin" },
        file: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return usage();
  }
}

const args = readArgs();
const email = args.values.email ?? args.positionals[0];
const file = args.values.file ?? (args.values.email ? undefined : args.positionals[1]);
if (!email || !file || args.positionals.length > (args.values.email ? 0 : 2)) usage();

/** Written before the account is committed: if the file cannot be created (e.g. it exists), nothing is created. */
async function toFile(path: string, r: BootstrapResult) {
  await writeFile(
    path,
    [
      "PALTAS first Super Admin — keep this file safe, then delete it.",
      `email:                 ${r.email}`,
      `temporary password:    ${r.temporaryPassword}   (must be changed at first sign-in)`,
      `authenticator secret:  ${r.authenticatorSecret}`,
      `authenticator link:    ${r.otpauthUrl}`,
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
}

const config = loadConfig();
if (config.env === "production") {
  console.error(
    "Production bootstrap now requires verified first-time enrollment. Use staff-enrollment-grant.js --create-first with authenticated operator approval and mailbox verification. No account was changed.",
  );
  process.exit(2);
}
const db = connect(config.databaseUrl, 2);
try {
  const applied = await migrate(db);
  await seedCatalogue(db);
  console.log(`Migrations applied now: ${applied.length ? applied.join(", ") : "none (already up to date)"}.`);
  console.log("Catalogue checked (existing rows unchanged).");
  const r = await bootstrapFirstSuperAdmin(
    db,
    secretBox(config.secretsKey),
    { email, name: args.values.name, host: hostname() },
    (res) => toFile(file, res),
  );
  console.log(
    `First PALTAS Super Admin ${r.email} created (${config.env}). Credentials written to ${file} (owner-only).`,
  );
} catch (e) {
  if (!(e instanceof BootstrapRefused)) throw e;
  console.error(`Refused: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
