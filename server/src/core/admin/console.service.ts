/*
 * The Super Admin portal's console: the PALTAS staff team and their roles, the client company directory, the people
 * search and the platform overview.
 *
 * - Every staff member may read all of it. Managing the team needs "staff.manage" (Super Admin).
 * - Nobody changes their own staff account here (another Super Admin does), and the last active Super Admin can never
 *   be demoted or deactivated: the platform is never left without someone who can manage it. Staff changes run one at
 *   a time (advisory lock), so two Super Admins cannot remove each other at the same moment.
 * - Invitations and access resets return the temporary password and authenticator secret ONCE; only the password hash
 *   and the sealed secret are stored. A role change, deactivation or reset ends the person's open sessions at once.
 * - Every change is in the audit trail with the reason given.
 * - The directory and the overview are built in a few set-based queries (no per-company round trips).
 */
import {
  STAFF_PERMISSION_LABELS,
  STAFF_PERMISSIONS,
  STAFF_ROLE_DEFINITIONS,
  STAFF_ROLES,
  type Product,
  type StaffRole,
} from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { recordAudit } from "../audit/audit.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { createUser } from "../identity/identity.service.js";
import { hashPassword, temporaryPassword } from "../identity/passwords.js";
import { newTotpSecret, otpauthUrl } from "../identity/totp.js";
import { staffActor } from "./admin.service.js";

const STAFF_LOCK = 7_240_813; // PALTAS staff team changes (pg_advisory_xact_lock)
const DAY_MS = 86_400_000;

type ClientSource = "self_signup" | "business_request" | "paltas_staff" | "demo";
type ClientStatus = "trial" | "active" | "suspended" | "expired";

const SOURCE_SQL = `CASE WHEN o.demo THEN 'demo'
  WHEN EXISTS (SELECT 1 FROM org_signups g WHERE g.org_id = o.id) THEN 'self_signup'
  WHEN EXISTS (SELECT 1 FROM mkt_business_requests r WHERE r.org_id = o.id) THEN 'business_request'
  ELSE 'paltas_staff' END`;

const likeText = (q: string) => "%" + q.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

export function consoleService(ctx: Pick<AppContext, "db" | "secrets" | "clock">) {
  const { db, secrets, clock } = ctx;

  interface StaffRow {
    id: string;
    email: string;
    name: string;
    staff_role: StaffRole;
    active: boolean;
    must_change_password: boolean;
    created_at: string;
    last_sign_in_at: string | null;
  }

  async function staffTarget(t: Db, user: SessionUser, userId: string) {
    const target = await t.row<StaffRow>("SELECT * FROM users WHERE id = $1 AND staff_role IS NOT NULL FOR UPDATE", [
      userId,
    ]);
    if (!target) throw fail.notFound("No such PALTAS staff member");
    if (target.id === user.id)
      throw fail.invalid("You cannot change your own staff account here — ask another Super Admin");
    return target;
  }

  function credentials(userId: string, email: string, password: string, secret: string) {
    return {
      userId,
      email,
      temporaryPassword: password,
      authenticatorSecret: secret,
      otpauthUrl: otpauthUrl(secret, email),
    };
  }

  return {
    // ---------------------------------------------------------------- the PALTAS team
    async listStaff(user: SessionUser) {
      staffActor(user);
      const rows = await db.rows<StaffRow>(
        `SELECT id, email, name, staff_role, active, must_change_password, created_at, last_sign_in_at
         FROM users WHERE staff_role IS NOT NULL ORDER BY active DESC, name, email`,
      );
      return {
        staff: rows.map((r) => ({
          userId: r.id,
          email: r.email,
          name: r.name,
          role: r.staff_role,
          active: r.active,
          mustChangePassword: r.must_change_password,
          createdAt: iso(r.created_at) as string,
          lastSignInAt: iso(r.last_sign_in_at),
        })),
        roles: STAFF_ROLES.map((role) => ({
          role,
          label: STAFF_ROLE_DEFINITIONS[role].label,
          description: STAFF_ROLE_DEFINITIONS[role].description,
          permissions: [...STAFF_ROLE_DEFINITIONS[role].permissions],
        })),
        permissions: STAFF_PERMISSIONS.map((permission) => ({
          permission,
          label: STAFF_PERMISSION_LABELS[permission],
        })),
      };
    },

    async inviteStaff(user: SessionUser, b: { email: string; name: string; role: StaffRole; reason: string }) {
      const actor = staffActor(user, "staff.manage");
      const email = b.email.trim().toLowerCase();
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock($1)", [STAFF_LOCK]);
        if (await t.row("SELECT 1 FROM users WHERE lower(email) = $1", [email]))
          throw fail.conflict(
            "This e-mail already has a PALTAS account. Staff need their own account, separate from any client account.",
          );
        const secret = newTotpSecret();
        const created = await createUser(t, {
          email,
          name: b.name,
          staffRole: b.role,
          mfaSecretSealed: secrets.seal(secret),
        });
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "PALTAS staff member added",
          target: email,
          detail: `${STAFF_ROLE_DEFINITIONS[b.role].label} · ${b.reason} · temporary password, two-factor required`,
        });
        return credentials(created.id, email, created.temporaryPassword as string, secret);
      });
    },

    async updateStaff(
      user: SessionUser,
      userId: string,
      b: { role?: StaffRole | undefined; active?: boolean | undefined; reason: string },
    ) {
      const actor = staffActor(user, "staff.manage");
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock($1)", [STAFF_LOCK]);
        const target = await staffTarget(t, user, userId);
        const role = b.role ?? target.staff_role;
        const active = b.active ?? target.active;
        if (role === target.staff_role && active === target.active)
          throw fail.invalid("Nothing to change: the account already has this role and status");
        if (target.staff_role === "super_admin" && target.active && (role !== "super_admin" || !active)) {
          const others = await t.row<{ n: number }>(
            "SELECT count(*)::int AS n FROM users WHERE staff_role = 'super_admin' AND active AND id <> $1",
            [target.id],
          );
          if (!others?.n)
            throw fail.conflict("This is the last active Super Admin. Make someone else Super Admin first.");
        }
        await t.run("UPDATE users SET staff_role = $2, active = $3 WHERE id = $1", [target.id, role, active]);
        await t.run("DELETE FROM sessions WHERE user_id = $1", [target.id]);
        const changes = [
          role !== target.staff_role
            ? `role ${STAFF_ROLE_DEFINITIONS[target.staff_role].label} → ${STAFF_ROLE_DEFINITIONS[role].label}`
            : "",
          active !== target.active ? (active ? "reactivated" : "deactivated") : "",
        ].filter(Boolean);
        await recordAudit(t, {
          actor,
          orgId: null,
          action: active ? "PALTAS staff member changed" : "PALTAS staff member deactivated",
          target: target.email,
          detail: `${changes.join(", ")} · ${b.reason} · open sessions ended`,
        });
        return { ok: true as const };
      });
    },

    async resetStaffAccess(user: SessionUser, userId: string, b: { reason: string }) {
      const actor = staffActor(user, "staff.manage");
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock($1)", [STAFF_LOCK]);
        const target = await staffTarget(t, user, userId);
        if (!target.active) throw fail.conflict("Reactivate this account before giving it new sign-in details");
        const password = temporaryPassword();
        const secret = newTotpSecret();
        await t.run(
          `UPDATE users SET password_hash = $2, must_change_password = true, mfa_secret_sealed = $3,
             mfa_pending_sealed = NULL, failed_count = 0, locked_until = NULL WHERE id = $1`,
          [target.id, await hashPassword(password), secrets.seal(secret)],
        );
        await t.run("DELETE FROM sessions WHERE user_id = $1", [target.id]);
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "PALTAS staff sign-in reset",
          target: target.email,
          detail: `${b.reason} · new temporary password and authenticator · open sessions ended`,
        });
        return credentials(target.id, target.email, password, secret);
      });
    },

    // ---------------------------------------------------------------- client companies
    async listClients(
      user: SessionUser,
      q: {
        q?: string | undefined;
        product?: Product | undefined;
        status?: ClientStatus | undefined;
        country?: string | undefined;
        source?: ClientSource | undefined;
        sort: "newest" | "oldest" | "name" | "last_active";
        limit: number;
        offset: number;
      },
    ) {
      staffActor(user);
      const order = {
        newest: "b.created_at DESC, b.id",
        oldest: "b.created_at, b.id",
        name: "lower(b.name), b.id",
        last_active: "b.last_active DESC NULLS LAST, b.id",
      }[q.sort];
      const rows = await db.rows<{
        id: string;
        name: string;
        legal_name: string;
        country: string;
        currency: string;
        created_at: string;
        suspended_at: string | null;
        suspended_reason: string | null;
        source: ClientSource;
        last_active: string | null;
        total: number;
      }>(
        `WITH base AS (
           SELECT o.id, o.name, o.legal_name, o.country, o.currency, o.created_at, o.suspended_at, o.suspended_reason,
                  ${SOURCE_SQL} AS source,
                  (SELECT max(u.last_sign_in_at) FROM memberships m JOIN users u ON u.id = m.user_id
                    WHERE m.org_id = o.id) AS last_active
           FROM organisations o)
         SELECT b.*, count(*) OVER ()::int AS total FROM base b
         WHERE ($1::text IS NULL OR lower(b.name) LIKE $1 OR lower(b.legal_name) LIKE $1 OR lower(b.id) LIKE $1
                OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                           WHERE m.org_id = b.id AND lower(u.email) LIKE $1))
           AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id = b.id AND s.product = $2
                                           AND ($3::text IS NULL OR $3 = 'suspended' OR s.status = $3)))
           AND ($3::text IS NULL
                OR ($3 = 'suspended' AND (b.suspended_at IS NOT NULL OR EXISTS (
                     SELECT 1 FROM subscriptions s WHERE s.org_id = b.id AND s.status = 'suspended'
                       AND ($2::text IS NULL OR s.product = $2))))
                OR ($3 <> 'suspended' AND b.suspended_at IS NULL AND EXISTS (
                     SELECT 1 FROM subscriptions s WHERE s.org_id = b.id AND s.status = $3
                       AND ($2::text IS NULL OR s.product = $2))))
           AND ($4::text IS NULL OR lower(b.country) = lower($4))
           AND ($5::text IS NULL OR b.source = $5)
         ORDER BY ${order} LIMIT $6 OFFSET $7`,
        [
          q.q ? likeText(q.q) : null,
          q.product ?? null,
          q.status ?? null,
          q.country ?? null,
          q.source ?? null,
          q.limit,
          q.offset,
        ],
      );
      const ids = rows.map((r) => r.id);
      const [subs, admins, counts, countries] = await Promise.all([
        db.rows<{
          org_id: string;
          product: Product;
          plan_id: string | null;
          status: ClientStatus;
          trial_ends: string | null;
        }>(
          `SELECT org_id, product, plan_id, status, trial_ends FROM subscriptions WHERE org_id = ANY($1)
           ORDER BY created_at, product`,
          [ids],
        ),
        db.rows<{ org_id: string; name: string; email: string; verified: boolean }>(
          `SELECT DISTINCT ON (m.org_id) m.org_id, u.name, u.email, (u.email_verified_at IS NOT NULL) AS verified
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = ANY($1) AND m.role = 'org_admin' AND m.status = 'active'
           ORDER BY m.org_id, m.created_at`,
          [ids],
        ),
        db.rows<{ org_id: string; members: number; listings: number; open_invoices: number }>(
          `SELECT o.id AS org_id,
             (SELECT count(*)::int FROM memberships m WHERE m.org_id = o.id AND m.status <> 'invited') AS members,
             (SELECT count(*)::int FROM agency_listings l WHERE l.org_id = o.id) AS listings,
             (SELECT count(*)::int FROM billing_invoices i WHERE i.org_id = o.id
                AND i.status IN ('Open', 'Payment failed')) AS open_invoices
           FROM organisations o WHERE o.id = ANY($1)`,
          [ids],
        ),
        db.rows<{ country: string }>("SELECT DISTINCT country FROM organisations ORDER BY country"),
      ]);
      return {
        total: rows[0]?.total ?? 0,
        countries: countries.map((c) => c.country),
        clients: rows.map((r) => {
          const a = admins.find((x) => x.org_id === r.id);
          const c = counts.find((x) => x.org_id === r.id);
          return {
            id: r.id,
            name: r.name,
            legalName: r.legal_name,
            country: r.country,
            currency: r.currency,
            createdAt: iso(r.created_at) as string,
            source: r.source,
            suspended: r.suspended_at ? { at: iso(r.suspended_at) as string, reason: r.suspended_reason ?? "" } : null,
            products: subs
              .filter((s) => s.org_id === r.id)
              .map((s) => ({ product: s.product, plan: s.plan_id, status: s.status, trialEnds: s.trial_ends })),
            admin: a ? { name: a.name, email: a.email, emailVerified: a.verified } : null,
            members: c?.members ?? 0,
            listings: c?.listings ?? 0,
            openInvoices: c?.open_invoices ?? 0,
            lastActiveAt: iso(r.last_active),
          };
        }),
      };
    },

    // ---------------------------------------------------------------- people (client accounts)
    async searchPeople(user: SessionUser, q: { q: string; limit: number }) {
      staffActor(user);
      const people = await db.rows<{
        id: string;
        email: string;
        name: string;
        active: boolean;
        verified: boolean;
        two_factor: boolean;
        created_at: string;
        last_sign_in_at: string | null;
      }>(
        `SELECT id, email, name, active, (email_verified_at IS NOT NULL) AS verified,
                (mfa_secret_sealed IS NOT NULL) AS two_factor, created_at, last_sign_in_at
         FROM users WHERE staff_role IS NULL AND (lower(email) LIKE $1 OR lower(name) LIKE $1)
         ORDER BY lower(email) LIMIT $2`,
        [likeText(q.q), q.limit],
      );
      const memberships = await db.rows<{
        user_id: string;
        org_id: string;
        org_name: string;
        role: string;
        status: string;
      }>(
        `SELECT m.user_id, m.org_id, o.name AS org_name, m.role, m.status FROM memberships m
         JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ANY($1) ORDER BY o.name`,
        [people.map((p) => p.id)],
      );
      return {
        people: people.map((p) => ({
          userId: p.id,
          email: p.email,
          name: p.name,
          active: p.active,
          emailVerified: p.verified,
          twoFactor: p.two_factor,
          createdAt: iso(p.created_at) as string,
          lastSignInAt: iso(p.last_sign_in_at),
          memberships: memberships
            .filter((m) => m.user_id === p.id)
            .map((m) => ({
              orgId: m.org_id,
              orgName: m.org_name,
              role: m.role as never,
              status: m.status as "active" | "suspended" | "invited",
            })),
        })),
      };
    },

    // ---------------------------------------------------------------- platform overview
    async overview(user: SessionUser) {
      staffActor(user);
      const now = clock.now();
      const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
      const today = clock.today();
      const [clients, sources, subscriptions, people, money, market, queues] = await Promise.all([
        db.row<{ total: number; recent: number; suspended: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at >= $1)::int AS recent,
                  count(*) FILTER (WHERE suspended_at IS NOT NULL)::int AS suspended FROM organisations`,
          [since],
        ),
        db.rows<{ source: ClientSource; n: number }>(
          `SELECT ${SOURCE_SQL} AS source, count(*)::int AS n FROM organisations o GROUP BY 1`,
        ),
        db.rows<{ product: Product; status: ClientStatus; n: number }>(
          "SELECT product, status, count(*)::int AS n FROM subscriptions GROUP BY 1, 2 ORDER BY 1, 2",
        ),
        db.row<{ clients: number; recent: number; staff: number }>(
          `SELECT count(*) FILTER (WHERE staff_role IS NULL)::int AS clients,
                  count(*) FILTER (WHERE staff_role IS NULL AND last_sign_in_at >= $1)::int AS recent,
                  count(*) FILTER (WHERE staff_role IS NOT NULL AND active)::int AS staff FROM users`,
          [since],
        ),
        db.rows<{ kind: string; currency: string; amount: number }>(
          `SELECT 'outstanding' AS kind, currency, sum(total_minor)::bigint AS amount FROM billing_invoices
             WHERE status IN ('Open', 'Payment failed') GROUP BY currency
           UNION ALL
           SELECT 'overdue', currency, sum(total_minor)::bigint FROM billing_invoices
             WHERE status IN ('Open', 'Payment failed') AND due < $2::date GROUP BY currency
           UNION ALL
           SELECT 'paid', currency, sum(total_minor)::bigint FROM billing_invoices
             WHERE status = 'Paid' AND paid_at >= $1 GROUP BY currency`,
          [since, today],
        ),
        db.row<{ live: number; bookings: number; offers: number }>(
          `SELECT (SELECT count(*)::int FROM agency_listings WHERE status = 'published') AS live,
                  (SELECT count(*)::int FROM agency_stays WHERE source = 'marketplace' AND created_at >= $1) AS bookings,
                  (SELECT count(*)::int FROM agency_offers WHERE created_at >= $1) AS offers`,
          [since],
        ),
        db.row<{
          signups: number;
          requests: number;
          listings: number;
          reviews: number;
          payments: number;
          prices: number;
        }>(
          `SELECT (SELECT count(*)::int FROM org_signups WHERE status = 'blocked_repeat') AS signups,
                  (SELECT count(*)::int FROM mkt_business_requests WHERE status = 'pending') AS requests,
                  (SELECT count(*)::int FROM agency_listings WHERE status = 'pending_review') AS listings,
                  (SELECT count(*)::int FROM agency_reviews WHERE status = 'pending') AS reviews,
                  (SELECT count(*)::int FROM subscription_upgrades u JOIN billing_invoices i ON i.id = u.invoice_id
                     WHERE i.status IN ('Open', 'Payment failed')) AS payments,
                  (SELECT count(*)::int FROM catalogue_price_changes WHERE status = 'pending') AS prices`,
        ),
      ]);
      const sum = (kind: string) =>
        money.filter((m) => m.kind === kind).map((m) => ({ currency: m.currency, amountMinor: Number(m.amount) }));
      const bySource = { self_signup: 0, business_request: 0, paltas_staff: 0, demo: 0 };
      for (const s of sources) bySource[s.source] = s.n;
      return {
        asOf: now.toISOString(),
        clients: {
          total: clients?.total ?? 0,
          newLast30Days: clients?.recent ?? 0,
          suspended: clients?.suspended ?? 0,
          bySource,
          subscriptions: subscriptions.map((s) => ({ product: s.product, status: s.status, count: s.n })),
        },
        people: {
          clientAccounts: people?.clients ?? 0,
          signedInLast30Days: people?.recent ?? 0,
          staff: people?.staff ?? 0,
        },
        money: { outstanding: sum("outstanding"), overdue: sum("overdue"), paidLast30Days: sum("paid") },
        marketplace: {
          liveListings: market?.live ?? 0,
          bookingsLast30Days: market?.bookings ?? 0,
          offersLast30Days: market?.offers ?? 0,
        },
        queues: {
          signups: queues?.signups ?? 0,
          businessRequests: queues?.requests ?? 0,
          listings: queues?.listings ?? 0,
          reviews: queues?.reviews ?? 0,
          payments: queues?.payments ?? 0,
          priceChanges: queues?.prices ?? 0,
        },
      };
    },
  };
}
export type ConsoleService = ReturnType<typeof consoleService>;
