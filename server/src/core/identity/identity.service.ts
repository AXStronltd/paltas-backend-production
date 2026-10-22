import { managerGrant } from "../access/manager-access.js";
/*
 * Identity: sign-in, sessions, password changes and two-factor set-up.
 *
 * - Passwords: scrypt. Five wrong attempts lock the account for 15 minutes; every failure is audited.
 * - Sessions: a random token is returned once; only its SHA-256 is stored. Sessions expire after
 *   SESSION_MINUTES of inactivity (sliding).
 * - Two-factor: PALTAS staff always need it; anyone else may turn it on. Secrets are encrypted at rest.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  entitlements,
  STAFF_ROLE_DEFINITIONS,
  type Product,
  type ProductRoles,
  type Role,
  type SignedInUser,
  type StaffRole,
} from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audit/audit.service.js";
import { productRole } from "../access/product-role.js";
import { resolveEntitlement } from "../subscriptions/entitlement.service.js";
import { decoyHash, hashPassword, temporaryPassword, verifyPassword } from "./passwords.js";
import { backupDigest } from "./staff-enrollment.js";
import { newTotpSecret, otpauthUrl, verifyTotp, totp } from "./totp.js";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
/** A session ends after this long even if it stays in use; the person signs in again. */
const MAX_SESSION_HOURS = 12;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  staffRole: StaffRole | null;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  tokenHash: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  must_change_password: boolean;
  mfa_secret_sealed: string | null;
  mfa_pending_sealed: string | null;
  mfa_confirmed_at: string | null;
  mfa_last_step: string | null;
  staff_role: StaffRole | null;
  active: boolean;
  failed_count: number;
  locked_until: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function toSignedInUser(
  u: Pick<SessionUser, "id" | "email" | "name" | "staffRole" | "mfaEnabled" | "mustChangePassword">,
): SignedInUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    staff: !!u.staffRole,
    staffRole: u.staffRole,
    staffPermissions: u.staffRole ? [...STAFF_ROLE_DEFINITIONS[u.staffRole].permissions] : [],
    mfaEnabled: u.mfaEnabled,
    mustChangePassword: u.mustChangePassword,
  };
}

/** Create a person. Without a password, a temporary one is generated and returned ONCE. */
export async function createUser(
  db: Db,
  input: {
    email: string;
    name: string;
    password?: string;
    staffRole?: StaffRole | null;
    mfaSecretSealed?: string | null;
  },
): Promise<{ id: string; temporaryPassword: string | null }> {
  const temp = input.password ? null : temporaryPassword();
  const id = newId("usr");
  await db.run(
    `INSERT INTO users (id, email, name, password_hash, must_change_password, staff_role, mfa_secret_sealed)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7)`,
    [
      id,
      input.email,
      input.name,
      await hashPassword(input.password ?? (temp as string)),
      !!temp,
      input.staffRole ?? null,
      input.mfaSecretSealed ?? null,
    ],
  );
  return { id, temporaryPassword: temp };
}

export function identityService(ctx: AppContext) {
  const { db, config, secrets, clock } = ctx;
  const sessionMs = config.sessionMinutes * 60_000;

  async function failedAttempt(u: UserRow | null, email: string, reason: string) {
    if (u) {
      // counted in the database in one statement, so parallel attempts cannot slip past the limit
      await db.run(
        `UPDATE users SET
           locked_until = CASE WHEN failed_count + 1 >= $2 THEN $3::timestamptz ELSE locked_until END,
           failed_count = CASE WHEN failed_count + 1 >= $2 THEN 0 ELSE failed_count + 1 END
         WHERE id = $1`,
        [u.id, MAX_FAILURES, new Date(clock.now().getTime() + LOCK_MINUTES * 60_000).toISOString()],
      );
    }
    await recordAudit(db, {
      actor: { userId: u?.id ?? null, role: "unknown" },
      orgId: null,
      action: "Failed sign-in",
      target: email,
      detail: reason,
    });
  }

  return {
    async login(input: { email: string; password: string; code?: string | undefined }, ip: string) {
      const u = await db.row<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [input.email]);
      if (u?.locked_until && new Date(u.locked_until) > clock.now()) {
        throw fail.tooManyAttempts("Too many attempts — try again in a few minutes");
      }
      const passwordOk = await verifyPassword(input.password, u?.password_hash ?? (await decoyHash()));
      const okUser = !!u && u.active && passwordOk;
      const needCode = !!u && (!!u.staff_role || !!u.mfa_secret_sealed);
      const codeOk =
        !needCode ||
        (!!input.code && !!u?.mfa_secret_sealed && verifyTotp(secrets.open(u.mfa_secret_sealed), input.code));
      if (!okUser || !codeOk) {
        await failedAttempt(u, input.email, okUser ? "Wrong or missing verification code" : "Wrong email or password");
        if (okUser && !input.code) throw fail.notSignedIn("Enter the 6-digit code from your authenticator app");
        throw fail.notSignedIn("Email, password or verification code is not correct");
      }
      // Newly confirmed staff cannot reuse an authenticator step (including the enrollment code).
      // Legacy accounts retain their behavior until explicitly enrolled; no automatic lockout migration.
      if (u.staff_role && u.mfa_confirmed_at && u.mfa_secret_sealed && input.code) {
        const secret = secrets.open(u.mfa_secret_sealed);
        const now = clock.now().getTime();
        const counter = [-1, 0, 1]
          .map((d) => Math.floor(now / 30000) + d)
          .find((n) => totp(secret, n * 30000) === input.code);
        const consumed =
          counter === undefined
            ? 0
            : await db.run(
                "UPDATE users SET mfa_last_step=$2 WHERE id=$1 AND (mfa_last_step IS NULL OR mfa_last_step<$2)",
                [u.id, counter],
              );
        if (!consumed) {
          await failedAttempt(u, input.email, "Verification code reused");
          throw fail.notSignedIn("Email, password or verification code is not correct");
        }
      }
      await db.run("UPDATE users SET failed_count = 0, locked_until = NULL, last_sign_in_at = now() WHERE id = $1", [
        u.id,
      ]);
      const token = randomBytes(32).toString("base64url");
      await db.tx(async (t) => {
        const current = await t.row<UserRow>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [u.id]);
        if (
          !current?.active ||
          current.password_hash !== u.password_hash ||
          current.mfa_secret_sealed !== u.mfa_secret_sealed ||
          current.staff_role !== u.staff_role
        )
          throw fail.notSignedIn("Account changed; sign in again");
        await t.run("INSERT INTO sessions (token_hash, user_id, expires_at, ip) VALUES ($1, $2, $3, $4)", [
          sha256(token),
          u.id,
          new Date(clock.now().getTime() + sessionMs).toISOString(),
          ip,
        ]);
      });
      await recordAudit(db, {
        actor: { userId: u.id, role: u.staff_role ?? "client" },
        orgId: null,
        action: "Signed in",
        target: u.email,
      });
      return {
        token,
        expiresInMinutes: config.sessionMinutes,
        user: toSignedInUser({
          id: u.id,
          email: u.email,
          name: u.name,
          staffRole: u.staff_role,
          mfaEnabled: !!u.mfa_secret_sealed,
          mustChangePassword: u.must_change_password,
        }),
      };
    },

    async loginWithBackup(input: { email: string; password: string; backupCode: string }, ip: string) {
      const u = await db.row<UserRow>("SELECT * FROM users WHERE lower(email)=lower($1)", [input.email]);
      if (u?.locked_until && new Date(u.locked_until) > clock.now())
        throw fail.tooManyAttempts("Too many attempts — try again in a few minutes");
      const passwordOk = await verifyPassword(input.password, u?.password_hash ?? (await decoyHash()));
      if (!u || !u.active || u.staff_role !== "super_admin" || !u.mfa_confirmed_at || !passwordOk) {
        await failedAttempt(u, input.email, "Backup login rejected");
        throw fail.notSignedIn("Email, password or recovery code is not correct");
      }
      const result = await db.tx(async (t) => {
        const current = await t.row<UserRow>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [u.id]);
        if (
          !current?.active ||
          current.staff_role !== "super_admin" ||
          current.password_hash !== u.password_hash ||
          !current.mfa_confirmed_at ||
          (current.locked_until && new Date(current.locked_until) > clock.now())
        )
          return null;
        const consumed = await t.run(
          "UPDATE staff_backup_codes SET used_at=$3 WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL",
          [u.id, backupDigest(input.backupCode), clock.now().toISOString()],
        );
        if (!consumed) return null;
        const token = randomBytes(32).toString("base64url");
        await t.run("INSERT INTO sessions(token_hash,user_id,expires_at,ip) VALUES($1,$2,$3,$4)", [
          sha256(token),
          u.id,
          new Date(clock.now().getTime() + sessionMs).toISOString(),
          ip,
        ]);
        await t.run("UPDATE users SET failed_count=0,locked_until=NULL WHERE id=$1", [u.id]);
        await recordAudit(t, {
          actor: { userId: u.id, role: "super_admin" },
          orgId: null,
          action: "Signed in with single-use backup code",
          target: u.email,
          detail: "One backup code consumed atomically",
        });
        return {
          token,
          expiresInMinutes: config.sessionMinutes,
          user: toSignedInUser({
            id: u.id,
            email: u.email,
            name: u.name,
            staffRole: u.staff_role,
            mfaEnabled: true,
            mustChangePassword: u.must_change_password,
          }),
        };
      });
      if (!result) {
        await failedAttempt(u, input.email, "Backup code invalid or used");
        throw fail.notSignedIn("Email, password or recovery code is not correct");
      }
      return result;
    },

    /** The person behind a bearer token, or null. Extends the session (sliding expiry). */
    async authenticate(token: string): Promise<SessionUser | null> {
      const hash = sha256(token);
      const s = await db.row<UserRow & { expires_at: string; token_hash: string; session_created: string }>(
        `SELECT s.token_hash, s.expires_at, s.created_at AS session_created, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
        [hash],
      );
      const now = clock.now().getTime();
      if (!s || !s.active || new Date(s.expires_at).getTime() <= now) return null;
      if (now - new Date(s.session_created).getTime() > MAX_SESSION_HOURS * 3_600_000) {
        await db.run("DELETE FROM sessions WHERE token_hash = $1", [hash]);
        return null;
      }
      const next = now + sessionMs;
      // extend at most once a minute, to keep writes low
      if (next - new Date(s.expires_at).getTime() > 60_000) {
        await db.run("UPDATE sessions SET expires_at = $1 WHERE token_hash = $2", [new Date(next).toISOString(), hash]);
      }
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        staffRole: s.staff_role,
        mfaEnabled: !!s.mfa_secret_sealed,
        mustChangePassword: s.must_change_password,
        tokenHash: hash,
      };
    },

    async logout(user: SessionUser) {
      await db.run("DELETE FROM sessions WHERE token_hash = $1", [user.tokenHash]);
    },

    async me(user: SessionUser) {
      const organisations = await db.rows<{
        id: string;
        name: string;
        role: Role;
        product_roles: ProductRoles | null;
        products: Product[];
      }>(
        `SELECT o.id, o.name, m.role, m.product_roles,
                COALESCE(array_agg(s.product ORDER BY s.created_at, s.product) FILTER (WHERE s.product IS NOT NULL), '{}') AS products
         FROM memberships m
         JOIN organisations o ON o.id = m.org_id
         LEFT JOIN subscriptions s ON s.org_id = o.id
         WHERE m.user_id = $1 AND m.status = 'active' AND o.suspended_at IS NULL
         GROUP BY o.id, o.name, m.role, m.product_roles
         ORDER BY o.name`,
        [user.id],
      );
      const ids = organisations.map((o) => o.id);
      // trial days left per product (the shared rules' trialState) and whether e-mail verification is awaited
      const subs = await db.rows<{
        org_id: string;
        product: Product;
        status: "trial" | "active" | "suspended" | "expired";
        trial_ends: string | null;
        grace_days: number;
        anchor: string | null;
      }>(
        "SELECT org_id, product, status, trial_ends, grace_days, anchor FROM subscriptions WHERE org_id = ANY($1) ORDER BY created_at, product",
        [ids],
      );
      const verified = new Map(
        (
          await db.rows<{ org_id: string; verified: boolean }>(
            `SELECT s.org_id, u.email_verified_at IS NOT NULL AS verified FROM org_signups s
             JOIN users u ON u.id = s.user_id WHERE s.org_id = ANY($1)`,
            [ids],
          )
        ).map((r) => [r.org_id, r.verified]),
      );
      const today = clock.today();
      const withTrials = await Promise.all(
        organisations.map(async (o) => ({
          id: o.id,
          name: o.name,
          role: o.role,
          products: o.products.filter((p) => productRole(o.role, o.product_roles, p)),
          portals: (
            await Promise.all(
              o.products.map(async (p) => {
                const role = productRole(o.role, o.product_roles, p);
                if (!role) return null;
                if (
                  p === "property" &&
                  role === "tenant" &&
                  (await db.row(
                    "SELECT 1 FROM pm_tenant_controls tc JOIN contacts c ON c.org_id=tc.org_id AND c.id=tc.tenant_id WHERE c.org_id=$1 AND c.user_id=$2 AND tc.portal_suspended",
                    [o.id, user.id],
                  ))
                )
                  return null;
                const en = await resolveEntitlement(db, ctx.products, clock.today(), o.id, p);
                return en ? { product: p, role, usable: en.ent.usable, status: en.ent.status } : null;
              }),
            )
          ).filter((p): p is NonNullable<typeof p> => p !== null),
          managerGrants: (await Promise.all(o.products.map((p) => managerGrant(db, o.id, user.id, p)))).filter(
            (g): g is NonNullable<typeof g> => g !== null,
          ),
          trials: subs
            .filter((s) => s.org_id === o.id)
            .flatMap((s) => {
              const st = entitlements.trialState(
                { plan: "", status: s.status, trialEnds: s.trial_ends, graceDays: s.grace_days, anchor: s.anchor },
                today,
              );
              return st ? [{ product: s.product, ...st }] : [];
            }),
          emailVerification: !verified.has(o.id)
            ? ("not_required" as const)
            : verified.get(o.id)
              ? ("verified" as const)
              : ("required" as const),
        })),
      );
      const invitations = await db.rows<{ orgId: string; orgName: string; role: Role }>(
        `SELECT o.id AS "orgId", o.name AS "orgName", m.role FROM memberships m JOIN organisations o ON o.id = m.org_id
         WHERE m.user_id = $1 AND m.status = 'invited' ORDER BY o.name`,
        [user.id],
      );
      return { user: toSignedInUser(user), organisations: withTrials, invitations };
    },

    /** Accept or decline an invitation from an organisation. Declining leaves no membership behind. */
    async answerInvitation(user: SessionUser, orgId: string, accept: boolean) {
      await db.tx(async (t) => {
        const m = await t.row<{ role: Role }>(
          "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'invited' FOR UPDATE",
          [orgId, user.id],
        );
        if (!m) throw fail.notFound("No invitation from this organisation");
        if (accept) {
          await t.run("UPDATE memberships SET status = 'active' WHERE org_id = $1 AND user_id = $2", [orgId, user.id]);
        } else {
          await t.run("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, user.id]);
        }
        await recordAudit(t, {
          actor: { userId: user.id, role: m.role },
          orgId,
          action: accept ? "Invitation accepted" : "Invitation declined",
          target: user.email,
          detail: m.role,
        });
      });
    },

    async changePassword(user: SessionUser, current: string, next: string) {
      const u = await db.row<UserRow>("SELECT * FROM users WHERE id = $1", [user.id]);
      if (!u || !(await verifyPassword(current, u.password_hash)))
        throw fail.invalid("Your current password is not correct");
      if (current === next) throw fail.invalid("Choose a password you have not used here before");
      await db.tx(async (t) => {
        await t.run("UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2", [
          await hashPassword(next),
          user.id,
        ]);
        await t.run("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, user.tokenHash]);
        await recordAudit(t, {
          actor: { userId: user.id, role: user.staffRole ?? "client" },
          orgId: null,
          action: "Password changed",
          target: user.email,
          detail: "Other sessions signed out",
        });
      });
    },

    async startMfa(user: SessionUser) {
      if (user.mfaEnabled) throw fail.conflict("Two-factor sign-in is already on");
      const secret = newTotpSecret();
      await db.run("UPDATE users SET mfa_pending_sealed = $1 WHERE id = $2", [secrets.seal(secret), user.id]);
      return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
    },

    async confirmMfa(user: SessionUser, code: string) {
      const u = await db.row<UserRow>("SELECT * FROM users WHERE id = $1", [user.id]);
      if (!u?.mfa_pending_sealed) throw fail.invalid("Start two-factor set-up first");
      if (!verifyTotp(secrets.open(u.mfa_pending_sealed), code))
        throw fail.invalid("That code is not correct — check the time on your phone and try again");
      await db.run("UPDATE users SET mfa_secret_sealed = mfa_pending_sealed, mfa_pending_sealed = NULL WHERE id = $1", [
        user.id,
      ]);
      await recordAudit(db, {
        actor: { userId: user.id, role: user.staffRole ?? "client" },
        orgId: null,
        action: "Two-factor sign-in turned on",
        target: user.email,
      });
    },
  };
}

export type IdentityService = ReturnType<typeof identityService>;
