/*
 * Self-service password reset by e-mail link.
 *
 *   request   public. The answer is the SAME whatever happened, so it never reveals whether an address has an
 *             account. For an active account that belongs to an organisation, a single-use link is recorded in the
 *             e-mail outbox (only its SHA-256 is stored; it expires after PASSWORD_RESET_MINUTES; a newer request
 *             supersedes it). PALTAS staff accounts are never reset by e-mail (another Super Admin helps them), and an
 *             account with no organisation has no outbox to carry the link — both get the same answer, nothing sent.
 *             Limited per caller address (429) and per account (silently: still the same answer).
 *   complete  public, with the token. Sets the new password, clears any lock-out, signs out EVERY session of the
 *             account and is audited.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AppContext } from "../../context.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audit/audit.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import { readableMoment } from "../signup/signup.service.js";
import { hashPassword } from "./passwords.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const RESET_RECEIVED = {
  received: true as const,
  message:
    "If this e-mail address has a PALTAS account, we have sent it a link to choose a new password. " +
    "The link works once and expires soon. Check your inbox and spam folder.",
};
const INVALID = "This reset link is not valid or has expired — ask for a new one";

export function passwordResetService(ctx: AppContext, deps: { notifications: NotificationsService }) {
  const { db, clock, config } = ctx;
  const s = config.passwordReset;

  return {
    async request(email: string, ip: string) {
      const byIp = await db.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM password_resets WHERE requested_ip = $1 AND created_at > now() - interval '1 hour'",
        [ip],
      );
      if ((byIp?.n ?? 0) >= s.perIpPerHour)
        throw fail.tooManyAttempts("Too many password reset requests from this address — try again later");
      await db.tx(async (t) => {
        const u = await t.row<{
          id: string;
          email: string;
          name: string;
          staff_role: string | null;
          org_id: string | null;
        }>(
          `SELECT u.id, u.email, u.name, u.staff_role,
                  (SELECT m.org_id FROM memberships m JOIN organisations o ON o.id = m.org_id
                   WHERE m.user_id = u.id AND m.status = 'active' ORDER BY m.created_at, m.org_id LIMIT 1) AS org_id
           FROM users u WHERE lower(u.email) = lower($1) AND u.active FOR UPDATE OF u`,
          [email],
        );
        if (!u || u.staff_role || !u.org_id) {
          await recordAudit(t, {
            actor: { userId: null, role: "public" },
            orgId: null,
            action: "Password reset requested — no link sent",
            target: email.toLowerCase(),
            detail: !u
              ? "no active account"
              : u.staff_role
                ? "PALTAS staff: reset by another Super Admin"
                : "no organisation",
          });
          return;
        }
        const recent = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'",
          [u.id],
        );
        if ((recent?.n ?? 0) >= s.perAccountPerHour) return; // the same answer; nothing more is sent this hour
        await t.run(
          "UPDATE password_resets SET superseded_at = now() WHERE user_id = $1 AND used_at IS NULL AND superseded_at IS NULL",
          [u.id],
        );
        const token = randomBytes(32).toString("base64url");
        const id = newId("pwr");
        const expiresAt = new Date(clock.now().getTime() + s.minutes * 60_000).toISOString();
        const message = await deps.notifications.record(t, {
          orgId: u.org_id,
          channel: "email",
          to: u.email,
          category: "transactional",
          templateKey: "password.reset",
          vars: {
            name: u.name,
            minutes: String(s.minutes),
            expiresAt: readableMoment(expiresAt),
            link: `${config.signup.appBaseUrl}/account.html#reset=${token}`,
          },
          source: "platform",
          sourceRef: "password.reset:" + id,
        });
        await t.run(
          `INSERT INTO password_resets (id, user_id, token_hash, expires_at, requested_ip, notification_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, u.id, sha256(token), expiresAt, ip, message.id],
        );
        await recordAudit(t, {
          actor: { userId: null, role: "public" },
          orgId: null,
          action: "Password reset link recorded",
          target: u.email,
          detail: `expires in ${s.minutes} minutes · ${message.status}`,
        });
      });
      return RESET_RECEIVED;
    },

    async complete(token: string, newPassword: string) {
      const hash = await hashPassword(newPassword);
      await db.tx(async (t) => {
        const r = await t.row<{
          id: string;
          user_id: string;
          expires_at: string;
          used_at: string | null;
          superseded_at: string | null;
        }>("SELECT * FROM password_resets WHERE token_hash = $1 FOR UPDATE", [sha256(token)]);
        if (!r || r.used_at || r.superseded_at || new Date(r.expires_at) <= clock.now()) throw fail.invalid(INVALID);
        const u = await t.row<{ email: string; active: boolean; staff_role: string | null }>(
          "SELECT email, active, staff_role FROM users WHERE id = $1 FOR UPDATE",
          [r.user_id],
        );
        if (!u?.active || u.staff_role) throw fail.invalid(INVALID);
        await t.run("UPDATE password_resets SET used_at = now() WHERE id = $1", [r.id]);
        await t.run(
          `UPDATE users SET password_hash = $2, must_change_password = false, failed_count = 0, locked_until = NULL
           WHERE id = $1`,
          [r.user_id, hash],
        );
        const ended = await t.run("DELETE FROM sessions WHERE user_id = $1", [r.user_id]);
        await recordAudit(t, {
          actor: { userId: r.user_id, role: "client" },
          orgId: null,
          action: "Password reset with an e-mail link",
          target: u.email,
          detail: `${ended} session(s) signed out`,
        });
      });
      return { ok: true as const };
    },
  };
}

export type PasswordResetService = ReturnType<typeof passwordResetService>;
