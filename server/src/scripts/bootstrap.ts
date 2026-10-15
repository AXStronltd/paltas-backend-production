/*
 * First start of a NEW production database:  npm run bootstrap -- <email> <credentials-file>
 * Applies the migrations, loads the starting catalogue (existing rows are never overwritten) and creates the FIRST
 * PALTAS Super Admin — only while no staff account exists, so running it again changes nothing.
 * The password and authenticator secret are written to <credentials-file> (a new file, readable only by its owner),
 * never printed, so they stay out of terminals and hosting logs. Run it with the server's own DATABASE_URL and
 * SECRETS_KEY: the authenticator secret is sealed with that key, and the server cannot read it with any other.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { seedCatalogue } from "../core/catalogue/catalogue.seed.js";
import { createUser } from "../core/identity/identity.service.js";
import { newTotpSecret, otpauthUrl } from "../core/identity/totp.js";
import { connect } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { secretBox } from "../lib/secret-box.js";

const [email, file] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !file) {
  console.error("Usage: npm run bootstrap -- <super-admin-email> <credentials-file>");
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl, 2);
try {
  const applied = await migrate(db);
  await seedCatalogue(db);
  const staff = await db.row<{ n: string }>("SELECT count(*) AS n FROM users WHERE staff_role IS NOT NULL");
  if (Number(staff?.n) > 0) {
    console.log(`Nothing to create: ${staff?.n} PALTAS staff account(s) already exist. Catalogue checked.`);
  } else {
    const password = randomBytes(18).toString("base64url");
    const totp = newTotpSecret();
    // the file first: if it cannot be written (e.g. it already exists), no account is created whose secrets are lost
    await writeFile(
      file,
      [
        "PALTAS first Super Admin — keep this file safe, then delete it.",
        `email:                 ${email.toLowerCase()}`,
        `password:              ${password}`,
        `authenticator secret:  ${totp}`,
        `authenticator link:    ${otpauthUrl(totp, email.toLowerCase())}`,
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
    await createUser(db, {
      email,
      name: "PALTAS Super Admin",
      password,
      staffRole: "super_admin",
      mfaSecretSealed: secretBox(config.secretsKey).seal(totp),
    });
    console.log(`Super Admin ${email.toLowerCase()} created. Credentials written to ${file} (owner-only).`);
  }
  console.log(`Migrations applied now: ${applied.length ? applied.join(", ") : "none (already up to date)"}.`);
} finally {
  await db.close();
}
