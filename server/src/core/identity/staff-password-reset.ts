/** Mailbox proof AND an existing second factor. Never changes staff roles or MFA enrollment. */
import { createHash, randomBytes } from "node:crypto";
import type { AppContext } from "../../context.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audit/audit.service.js";
import { emailAdapter } from "../notifications/email-providers.js";
import { hashPassword } from "./passwords.js";
import { backupDigest } from "./staff-enrollment.js";
import { totp } from "./totp.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const RECEIVED = {
  received: true as const,
  message:
    "If this address is eligible for Super Admin recovery, a password reset link has been sent. Check your inbox and spam folder. Your authenticator or an unused backup code is still required.",
};
const INVALID =
  "Reset link or verification code is invalid, used or expired. Use a fresh authenticator code or request a new link.";
interface Account {
  id: string;
  email: string;
  active: boolean;
  staff_role: string | null;
  auth_version: number;
  mfa_confirmed_at: string | null;
  mfa_secret_sealed: string | null;
  mfa_last_step: number | null;
}
interface Reset {
  id: string;
  user_id: string;
  account_version: number;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  superseded_at: string | null;
}
export function staffPasswordResetService(ctx: AppContext) {
  const { db, config, clock, secrets } = ctx;
  return {
    async request(email: string, ip: string) {
      const eligible = await db.tx(async (t) => {
        // Serialise rate accounting even for unknown addresses; never enumerate accounts through limits.
        await t.run("SELECT pg_advisory_xact_lock($1)", [7240813]);
        const ipHash = digest(ip),
          emailHash = digest(email.trim().toLowerCase());
        const rate = await t.row<{ ip: number; email: number }>(
          `SELECT count(*) FILTER(WHERE ip_hash=$1)::int AS ip,count(*) FILTER(WHERE email_hash=$2)::int AS email FROM staff_reset_requests WHERE created_at>now()-interval '1 hour'`,
          [ipHash, emailHash],
        );
        if ((rate?.ip ?? 0) >= config.passwordReset.perIpPerHour)
          throw fail.tooManyAttempts("Too many reset requests — try again later");
        await t.run("INSERT INTO staff_reset_requests(ip_hash,email_hash) VALUES($1,$2)", [ipHash, emailHash]);
        if ((rate?.email ?? 0) >= config.passwordReset.perAccountPerHour) return null;
        return t.row<Account>(
          "SELECT id,email,active,staff_role,auth_version,mfa_confirmed_at,mfa_secret_sealed,mfa_last_step FROM users WHERE lower(email)=lower($1)",
          [email],
        );
      });
      if (
        !eligible?.active ||
        eligible.staff_role !== "super_admin" ||
        !eligible.mfa_confirmed_at ||
        !eligible.mfa_secret_sealed ||
        !config.email.provider
      )
        return RECEIVED;
      try {
        await db.tx(async (t) => {
          const u = await t.row<Account>(
            "SELECT id,email,active,staff_role,auth_version,mfa_confirmed_at,mfa_secret_sealed,mfa_last_step FROM users WHERE id=$1 FOR UPDATE",
            [eligible.id],
          );
          if (!u?.active || u.staff_role !== "super_admin" || u.auth_version !== eligible.auth_version) return;
          const id = newId("spr"),
            token = randomBytes(32).toString("base64url"),
            expires = new Date(clock.now().getTime() + config.passwordReset.minutes * 60000).toISOString();
          await t.run(
            "UPDATE staff_password_resets SET superseded_at=now() WHERE user_id=$1 AND used_at IS NULL AND superseded_at IS NULL",
            [u.id],
          );
          await t.run(
            "INSERT INTO staff_password_resets(id,user_id,token_hash,account_version,expires_at) VALUES($1,$2,$3,$4,$5)",
            [id, u.id, digest(token), u.auth_version, expires],
          );
          const mail = config.email;
          const sent = await emailAdapter({ ...mail, provider: mail.provider! }, ctx.emailTransport).submit({
            id,
            orgId: "platform",
            channel: "email",
            to: u.email,
            subject: "PALTAS Super Admin — reset your password",
            body: `A password reset was requested for your PALTAS Super Admin account.\nOpen this link on PALTAS to choose a new password:\n${config.signup.appBaseUrl}/admin.html#password-reset=${token}\nThis link expires in ${config.passwordReset.minutes} minutes and works once. Your existing authenticator or an unused backup recovery code is required. This does not reset your authenticator.\nIf you did not request this, ignore this email.`,
            from: { name: mail.fromName, address: mail.fromAddress, replyTo: mail.fromAddress },
          });
          if (!sent.accepted || !sent.sent || !sent.providerMessageId) throw new Error("Recovery email not accepted");
          await recordAudit(t, {
            actor: { userId: null, role: "public" },
            orgId: null,
            action: "Staff password reset email accepted",
            target: u.email,
            detail: "Provider accepted message; inbox delivery not confirmed",
          });
        });
      } catch {
        await recordAudit(db, {
          actor: { userId: null, role: "public" },
          orgId: null,
          action: "Staff password reset email unavailable",
          target: eligible.id,
          detail: "No recovery link activated; provider or transaction failed",
        });
      }
      return RECEIVED;
    },
    async complete(input: { token: string; newPassword: string; code?: string; backupCode?: string }) {
      const hash = await hashPassword(input.newPassword);
      // Lock account before token to match request locking order and avoid deadlocks.
      const found = await db.row<{ user_id: string }>("SELECT user_id FROM staff_password_resets WHERE token_hash=$1", [
        digest(input.token),
      ]);
      if (!found) throw fail.invalid(INVALID);
      const result = await db.tx(async (t) => {
        const u = await t.row<Account>(
          "SELECT id,email,active,staff_role,auth_version,mfa_confirmed_at,mfa_secret_sealed,mfa_last_step FROM users WHERE id=$1 FOR UPDATE",
          [found.user_id],
        );
        const r = await t.row<Reset>("SELECT * FROM staff_password_resets WHERE token_hash=$1 FOR UPDATE", [
          digest(input.token),
        ]);
        if (
          !r ||
          r.used_at ||
          r.superseded_at ||
          r.attempts >= 5 ||
          new Date(r.expires_at) <= clock.now() ||
          !u?.active ||
          u.staff_role !== "super_admin" ||
          !u.mfa_confirmed_at ||
          !u.mfa_secret_sealed ||
          r.account_version !== u.auth_version
        )
          return false;
        let valid = false;
        if (input.code && !input.backupCode) {
          const secret = secrets.open(u.mfa_secret_sealed),
            now = clock.now().getTime();
          const step = [-1, 0, 1]
            .map((d) => Math.floor(now / 30000) + d)
            .find((n) => totp(secret, n * 30000) === input.code);
          if (step !== undefined && (u.mfa_last_step === null || step > u.mfa_last_step)) {
            await t.run("UPDATE users SET mfa_last_step=$2 WHERE id=$1", [u.id, step]);
            valid = true;
          }
        } else if (input.backupCode && !input.code)
          valid = !!(await t.run(
            "UPDATE staff_backup_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL",
            [u.id, backupDigest(input.backupCode)],
          ));
        if (!valid) {
          await t.run("UPDATE staff_password_resets SET attempts=attempts+1 WHERE id=$1", [r.id]);
          await recordAudit(t, {
            actor: { userId: null, role: "public" },
            orgId: null,
            action: "Staff password reset verification failed",
            target: u.id,
            detail: "Second factor invalid, reused or missing",
          });
          return false;
        }
        await t.run("UPDATE staff_password_resets SET used_at=now() WHERE id=$1", [r.id]);
        await t.run(
          "UPDATE staff_password_resets SET superseded_at=now() WHERE user_id=$1 AND id<>$2 AND used_at IS NULL",
          [u.id, r.id],
        );
        await t.run(
          "UPDATE users SET password_hash=$2,must_change_password=false,failed_count=0,locked_until=NULL WHERE id=$1",
          [u.id, hash],
        );
        const ended = await t.run("DELETE FROM sessions WHERE user_id=$1", [u.id]);
        await recordAudit(t, {
          actor: { userId: u.id, role: u.staff_role },
          orgId: null,
          action: "Staff password reset completed",
          target: u.email,
          detail: `Mailbox and existing second factor verified; ${ended} sessions ended; MFA unchanged`,
        });
        return u.email;
      });
      if (!result) throw fail.invalid(INVALID);
      // The password transaction has committed. Notification failure must never make its outcome ambiguous.
      if (config.email.provider) {
        try {
          const mail = config.email;
          const sent = await emailAdapter({ ...mail, provider: mail.provider! }, ctx.emailTransport).submit({
            id: newId("sprn"),
            orgId: "platform",
            channel: "email",
            to: result,
            subject: "PALTAS Super Admin password changed",
            body: "Your Super Admin password was changed after mailbox and second-factor verification. All previous sessions have ended. Your authenticator remains enabled. If this was not you, contact your verified platform operator immediately.",
            from: { name: mail.fromName, address: mail.fromAddress, replyTo: mail.fromAddress },
          });
          await recordAudit(db, {
            actor: { userId: null, role: "system" },
            orgId: null,
            action:
              sent.accepted && sent.sent
                ? "Staff password change notice accepted"
                : "Staff password change notice not accepted",
            target: found.user_id,
            detail: "Provider response recorded; delivery not confirmed",
          });
        } catch {
          await recordAudit(db, {
            actor: { userId: null, role: "system" },
            orgId: null,
            action: "Staff password change notice unavailable",
            target: found.user_id,
            detail: "Password reset already completed; contact operator to review notification",
          });
        }
      }
      return { ok: true as const };
    },
  };
}
