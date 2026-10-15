/*
 * The first PALTAS Super Admin of a new installation (production included), created from the server's command line:
 *
 *   npm run bootstrap -- ops@paltashub.com ./paltas-superadmin.txt          (credentials to a new owner-only file)
 *   npm run bootstrap:admin -- --email ops@paltashub.com --name "PALTAS Operations"   (credentials printed once)
 *   (or, on the server after a build:  node server/dist/scripts/bootstrap.js … — bootstrap-admin.js is the same command)
 *
 * - Works ONLY while no PALTAS staff account exists; every later run is refused (and the refusal audited). Further
 *   staff are added by an existing Super Admin, never by this command.
 * - Never turns an existing client account (an owner, an organisation member) into staff.
 * - The temporary password and the authenticator secret are generated here and returned ONCE for printing; only
 *   the password hash and the encrypted secret are stored. The password must be changed at first sign-in (the API
 *   refuses everything else until then), and every sign-in needs the authenticator code.
 * - Runs under a lock in one transaction, so two runs at the same moment cannot both create an account.
 * - `deliver` (e.g. writing the credentials file) runs inside that transaction, before it commits: if it fails, no
 *   account is created whose secrets were never handed over.
 */
import type { Database } from "../../db/database.js";
import type { SecretBox } from "../../lib/secret-box.js";
import { recordAudit, SYSTEM } from "../audit/audit.service.js";
import { createUser } from "../identity/identity.service.js";
import { newTotpSecret, otpauthUrl } from "../identity/totp.js";

const LOCK = 7_240_812; // "PALTAS first Super Admin" (pg_advisory_xact_lock)

export class BootstrapRefused extends Error {}

export interface BootstrapResult {
  userId: string;
  email: string;
  temporaryPassword: string;
  authenticatorSecret: string;
  otpauthUrl: string;
}

export async function bootstrapFirstSuperAdmin(
  db: Database,
  secrets: SecretBox,
  input: { email: string; name: string; host?: string },
  deliver?: (r: BootstrapResult) => Promise<void>,
): Promise<BootstrapResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BootstrapRefused("Give a valid e-mail address (--email)");
  const name = input.name.trim();
  if (name.length < 2) throw new BootstrapRefused("Give the person's name (--name)");

  const created = await db.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    if (await t.row("SELECT 1 FROM users WHERE staff_role IS NOT NULL LIMIT 1")) {
      return { refused: "A PALTAS staff account already exists — the first Super Admin can only be created once" };
    }
    if (await t.row("SELECT 1 FROM users WHERE lower(email) = $1", [email])) {
      return { refused: "This e-mail belongs to an existing client account — PALTAS staff need their own account" };
    }
    const secret = newTotpSecret();
    const user = await createUser(t, { email, name, staffRole: "super_admin", mfaSecretSealed: secrets.seal(secret) });
    await recordAudit(t, {
      actor: SYSTEM,
      orgId: null,
      action: "First Super Admin created",
      target: email,
      detail: `bootstrap command${input.host ? " on " + input.host : ""} · temporary password, must be changed at first sign-in · two-factor required`,
    });
    const result: BootstrapResult = {
      userId: user.id,
      email,
      temporaryPassword: user.temporaryPassword as string,
      authenticatorSecret: secret,
      otpauthUrl: otpauthUrl(secret, email),
    };
    if (deliver) await deliver(result);
    return result;
  });
  if ("refused" in created) {
    await recordAudit(db, {
      actor: SYSTEM,
      orgId: null,
      action: "First Super Admin bootstrap refused",
      target: email,
      detail: created.refused,
    });
    throw new BootstrapRefused(created.refused);
  }
  return created;
}
