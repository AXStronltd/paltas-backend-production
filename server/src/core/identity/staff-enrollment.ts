/** Operator-authorized recovery, separate from public registration and normal sessions. */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit, SYSTEM } from "../audit/audit.service.js";
import { emailAdapter } from "../notifications/email-providers.js";
import { hashPassword } from "./passwords.js";
import { newTotpSecret, otpauthUrl, totp } from "./totp.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const backupDigest = (s: string) => digest(s.replace(/[\s-]/g, "").toUpperCase());
const INVALID =
  "Setup authorization or verification code is invalid or expired. Ask your platform operator for a new setup.";
interface Account {
  id: string;
  email: string;
  staff_role: string | null;
  active: boolean;
  password_hash: string;
  mfa_secret_sealed: string | null;
}
interface Grant {
  id: string;
  user_id: string;
  email_code_hash: string;
  account_fingerprint: string;
  expires_at: string;
  attempts: number;
  pending_sealed: string | null;
  used_at: string | null;
  revoked_at: string | null;
}
const fingerprint = (u: Account) =>
  digest(JSON.stringify([u.id, u.email, u.staff_role, u.active, u.password_hash, u.mfa_secret_sealed]));
function step(secret: string, code: string, now: number): number | null {
  for (const delta of [-1, 0, 1]) {
    const n = Math.floor(now / 30000) + delta;
    if (equal(totp(secret, n * 30000), code)) return n;
  }
  return null;
}
export function staffEnrollmentService(ctx: AppContext) {
  const { db, secrets, clock, config } = ctx;
  async function locked(t: Db, token: string) {
    const g = await t.row<Grant>("SELECT * FROM staff_enrollments WHERE token_hash=$1 FOR UPDATE", [digest(token)]);
    if (!g || g.used_at || g.revoked_at || g.attempts >= 5 || new Date(g.expires_at).getTime() <= clock.now().getTime())
      return null;
    const u = await t.row<Account>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [g.user_id]);
    if (!u || u.staff_role !== "super_admin" || fingerprint(u) !== g.account_fingerprint) return null;
    return { g, u };
  }
  return {
    /** Only callable from the privileged CLI; no HTTP route can issue a grant or elevate a role. */
    async issue(
      input: { email: string; operator: string; createFirst?: boolean },
      deliver: (url: string) => Promise<void>,
    ) {
      if (input.operator.trim().length < 12)
        throw fail.invalid("Record the authenticated hosting operator and approval reference (at least 12 characters)");
      const mail = config.email;
      if (!mail.provider) throw fail.conflict("A real platform email provider is required for mailbox verification");
      const provider = mail.provider;
      const token = randomBytes(32).toString("base64url"),
        code = String(randomInt(10000000, 100000000)),
        id = newId("sen");
      const expiresAt = new Date(clock.now().getTime() + 15 * 60 * 1000).toISOString();
      const url = `${config.signup.appBaseUrl}/admin.html#enroll=${token}`;
      await db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock($1)", [7240812]);
        let u = await t.row<Account>("SELECT * FROM users WHERE lower(email)=lower($1) FOR UPDATE", [input.email]);
        if (input.createFirst) {
          if (u || (await t.row("SELECT 1 FROM users WHERE staff_role IS NOT NULL LIMIT 1")))
            throw fail.conflict(
              "First staff account already exists; use explicitly approved recovery for its exact email",
            );
          const userId = newId("usr");
          await t.run(
            "INSERT INTO users(id,email,name,password_hash,staff_role,active) VALUES($1,lower($2),'PALTAS Owner',$3,'super_admin',false)",
            [userId, input.email, await hashPassword(randomBytes(32).toString("base64url"))],
          );
          u = await t.row<Account>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId]);
        }
        if (!u || u.staff_role !== "super_admin")
          throw fail.invalid("An existing Super Admin account is required; client accounts cannot be elevated");
        if (!u.active && !input.createFirst)
          throw fail.forbidden("Disabled staff accounts require a separate account review");
        const recent = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM staff_enrollments WHERE user_id=$1 AND created_at > now()-interval '1 hour'",
          [u.id],
        );
        if ((recent?.n ?? 0) >= 3) throw fail.tooManyAttempts("Too many setup authorizations; wait an hour");
        await t.run(
          "UPDATE staff_enrollments SET revoked_at=now(),pending_sealed=NULL WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
          [u.id],
        );
        await t.run(
          "INSERT INTO staff_enrollments(id,user_id,token_hash,email_code_hash,account_fingerprint,approved_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, u.id, digest(token), digest(code), fingerprint(u), input.operator, expiresAt],
        );
        const result = await emailAdapter({ ...mail, provider }, ctx.emailTransport).submit({
          id,
          orgId: "platform",
          channel: "email",
          to: u.email,
          subject: "PALTAS owner setup — verify your email",
          body: `A PALTAS hosting operator authorized account setup.\nYour mailbox verification code is: ${code}\nIt expires in 15 minutes. Use it only on the setup screen opened from your operator-issued link.\nIf you did not request this, do not share the code and contact your platform operator.`,
          from: { name: mail.fromName, address: mail.fromAddress, replyTo: mail.fromAddress },
        });
        if (!result.accepted || !result.sent || !result.providerMessageId)
          throw fail.conflict("Setup email was not accepted by the provider; no grant activated");
        await deliver(url); // owner-only file, never stdout; failure rolls back the grant
        await recordAudit(t, {
          actor: SYSTEM,
          orgId: null,
          action: "Staff enrollment authorized",
          target: u.email,
          detail: `Hosting operator approval: ${input.operator}; mailbox challenge accepted by provider; expires ${expiresAt}`,
        });
      });
      return { expiresAt };
    },
    async begin(token: string, emailCode: string) {
      const result = await db.tx(async (t) => {
        const pair = await locked(t, token);
        if (!pair) return null;
        const { g, u } = pair;
        await t.run("UPDATE staff_enrollments SET attempts=attempts+1 WHERE id=$1", [g.id]);
        if (!equal(digest(emailCode), g.email_code_hash)) return null;
        const secret = g.pending_sealed ? secrets.open(g.pending_sealed) : newTotpSecret();
        await t.run("UPDATE staff_enrollments SET pending_sealed=$2 WHERE id=$1", [g.id, secrets.seal(secret)]);
        return { secret, otpauthUrl: otpauthUrl(secret, u.email), expiresAt: g.expires_at };
      });
      if (!result) throw fail.invalid(INVALID);
      return result;
    },
    async complete(token: string, code: string, newPassword: string) {
      // Rate limits and bounded password length apply before this service.
      const result = await db.tx(async (t) => {
        const pair = await locked(t, token);
        if (!pair) return null;
        const { g, u } = pair;
        await t.run("UPDATE staff_enrollments SET attempts=attempts+1 WHERE id=$1", [g.id]);
        if (!g.pending_sealed) return null;
        const secret = secrets.open(g.pending_sealed),
          counter = step(secret, code, clock.now().getTime());
        if (counter === null) return null;
        const hash = await hashPassword(newPassword);
        const backupCodes = Array.from({ length: 10 }, () => {
          const raw = randomBytes(12).toString("hex").toUpperCase();
          return [raw.slice(0, 6), raw.slice(6, 12), raw.slice(12, 18), raw.slice(18, 24)].join("-");
        });
        await t.run(
          "UPDATE users SET password_hash=$2,mfa_secret_sealed=$3,mfa_pending_sealed=NULL,mfa_confirmed_at=$4,mfa_last_step=$5,must_change_password=false,failed_count=0,locked_until=NULL,active=true WHERE id=$1",
          [u.id, hash, secrets.seal(secret), clock.now().toISOString(), counter],
        );
        await t.run("DELETE FROM staff_backup_codes WHERE user_id=$1", [u.id]);
        for (const b of backupCodes)
          await t.run("INSERT INTO staff_backup_codes(user_id,code_hash) VALUES($1,$2)", [u.id, backupDigest(b)]);
        await t.run("DELETE FROM sessions WHERE user_id=$1", [u.id]);
        await t.run("UPDATE staff_enrollments SET used_at=$2,pending_sealed=NULL WHERE id=$1", [
          g.id,
          clock.now().toISOString(),
        ]);
        await t.run(
          "UPDATE staff_enrollments SET revoked_at=now(),pending_sealed=NULL WHERE user_id=$1 AND id<>$2 AND used_at IS NULL AND revoked_at IS NULL",
          [u.id, g.id],
        );
        await recordAudit(t, {
          actor: { userId: u.id, role: "super_admin" },
          orgId: null,
          action: "Staff MFA enrollment confirmed",
          target: u.email,
          detail:
            "Mailbox and first authenticator code verified; password set; backup codes issued; existing sessions revoked; permissions preserved",
        });
        return { ok: true as const, backupCodes };
      });
      if (!result) throw fail.invalid(INVALID);
      return result;
    },
  };
}
