/*
 * Self-service sign-up and e-mail verification.
 *
 *   create   public. ONE transaction: the administrator (the password they chose), the organisation, the org_admin
 *            membership and a trial from the platform policy (core/admin createOrganisationRecords → openSubscription),
 *            its chart of accounts, the verification message in the outbox, and the audit entries. It never creates
 *            PALTAS staff, never a demo organisation. The answer is the SAME for every outcome:
 *              - created;
 *              - duplicate (the e-mail already has an account, or the organisation name is taken): nothing created;
 *              - blocked_repeat (the same business had a trial inside the policy window): kept for PALTAS staff, who
 *                allow it (with a reason) or decline it.
 *            Limited per caller address per hour and per e-mail per day (SIGNUP_*), counted in the database.
 *   verify   public, with the token from the link. Only the token's SHA-256 is stored; it expires
 *            (policy.verifyLinkHours) and works once. The message carrying the link is RECORDED in the outbox —
 *            never claimed as sent (no e-mail provider is connected).
 *   resend   the signed-in administrator asks for a new link (earlier links stop working).
 *
 * The trial is usable at once. Upgrading, paying and inviting members wait for a verified address (requireVerified);
 * an address still unverified policy.verifyWithinDays after the trial opened suspends the trial (lifecycle job), and
 * verifying it later lifts that suspension.
 */
import { createHash, randomBytes } from "node:crypto";
import { entitlements, type Product, type signup, type z } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { createOrganisationRecords } from "../admin/admin.service.js";
import { recordAudit, SYSTEM, type Actor } from "../audit/audit.service.js";
import { findPlan, loadCatalogue, trialCurrency } from "../catalogue/catalogue.service.js";
import { hashPassword } from "../identity/passwords.js";
import type { SessionUser } from "../identity/identity.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import { companyKey, findRepeats, loadPolicy, phoneKey, type TrialPolicy } from "./policy.js";

type SignupBody = z.output<typeof signup.SignupBody>;
type SignupDto = z.infer<typeof signup.SignupRequest>;
type Status = SignupDto["status"];

/** The one answer to every sign-up, whatever happened. */
export const SIGNUP_RECEIVED = {
  received: true as const,
  message:
    "Thank you. If these details can start a new PALTAS trial, your workspace is ready: sign in with your e-mail " +
    "address and the password you chose. A message to verify your e-mail address has been recorded for delivery.",
};

const INVALID_LINK = "This verification link is not valid or has expired — sign in and ask for a new one";
export const OUTBOX_NOTE =
  "Recorded in the PALTAS outbox. No e-mail provider is connected (test adapter): nothing is sent from here.";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface SignupRow {
  id: string;
  status: Status;
  org_id: string | null;
  user_id: string | null;
  company: string;
  company_key: string;
  country: string;
  timezone: string;
  product: Product;
  plan_id: string;
  admin_name: string;
  email: string;
  phone: string;
  password_hash: string | null;
  terms_version: string;
  terms_accepted_at: string;
  ip: string;
  signed_up_on: string;
  matched: SignupDto["matched"];
  decided_by: string | null;
  decision_reason: string | null;
  unverified_suspended_at: string | null;
  suspended_products: Product[];
  created_at: string;
  email_verified_at?: string | null;
}

const toDto = (r: SignupRow): SignupDto => ({
  id: r.id,
  status: r.status,
  orgId: r.org_id,
  company: r.company,
  country: r.country,
  product: r.product,
  plan: r.plan_id,
  adminName: r.admin_name,
  email: r.email,
  phone: r.phone,
  termsVersion: r.terms_version,
  signedUpOn: r.signed_up_on,
  matched: r.matched,
  emailVerified: r.user_id ? !!r.email_verified_at : null,
  decidedBy: r.decided_by,
  decisionReason: r.decision_reason,
  createdAt: r.created_at,
});

const SIGNUP_SQL = `SELECT s.*, u.email_verified_at FROM org_signups s LEFT JOIN users u ON u.id = s.user_id`;

/** "18 October 2026, 14:05 UTC" — how a person reads a link's expiry in a message. */
export function readableMoment(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date.format(d)}, ${time.format(d)} UTC`;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const TIER_ORDER = ["Standard", "Pro", "Enterprise", ""];

export function signupService(ctx: AppContext, deps: { notifications: NotificationsService }) {
  const { db, clock, config } = ctx;
  const settings = config.signup;
  /**
   * Production prerequisites for public sign-up: published HTTPS terms and a platform e-mail provider in use (so the
   * verification link can reach the person). Missing either only keeps sign-up closed; the server runs normally.
   */
  function registrationOpen() {
    if (!settings.enabled || !settings.allowedProducts.length) return false;
    if (config.env !== "production") return true;
    return /^https:\/\//.test(settings.termsUrl) && deps.notifications.emailDeliveryConfigured();
  }

  /** Record a verification message with a fresh single-use link; earlier open links stop working. */
  async function issueVerification(
    t: Db,
    v: { orgId: string; userId: string; email: string; name: string; product: Product; policy: TrialPolicy },
  ) {
    await t.run(
      "UPDATE email_verifications SET superseded_at = now() WHERE user_id = $1 AND used_at IS NULL AND superseded_at IS NULL",
      [v.userId],
    );
    const token = randomBytes(32).toString("base64url");
    const id = newId("ver");
    const expiresAt = new Date(clock.now().getTime() + v.policy.verifyLinkHours * 3_600_000).toISOString();
    const message = await deps.notifications.record(t, {
      orgId: v.orgId,
      channel: "email",
      to: v.email,
      category: "transactional",
      templateKey: "signup.verify",
      vars: {
        name: v.name,
        productName: entitlements.PRODUCT_NAME[v.product] ?? v.product,
        link: `${settings.appBaseUrl}/verify-email#token=${token}`,
        expiresAt: readableMoment(expiresAt),
      },
      source: "platform",
      sourceRef: "signup.verify:" + id,
      createdBy: v.userId,
    });
    await t.run(
      `INSERT INTO email_verifications (id, org_id, user_id, email, token_hash, expires_at, notification_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, v.orgId, v.userId, v.email, sha256(token), expiresAt, message.id],
    );
    return { expiresAt, delivery: `${OUTBOX_NOTE} Status: ${message.status}.` };
  }

  /**
   * Create the administrator, the organisation and its trial from a sign-up request (a new one, or one PALTAS
   * staff allowed). The administrator's password is the one they chose (only its hash is ever handled here).
   */
  async function openWorkspace(
    t: Db,
    r: Pick<
      SignupRow,
      "company" | "country" | "timezone" | "product" | "plan_id" | "admin_name" | "email" | "phone"
    > & { currency: string; passwordHash: string },
    override: { reason: string; by: string } | null,
  ) {
    const userId = newId("usr");
    // a plain client account: never PALTAS staff (and the database refuses staff memberships, migration 0012)
    await t.run(
      `INSERT INTO users (id, email, name, password_hash, must_change_password, staff_role)
       VALUES ($1, lower($2), $3, $4, false, NULL)`,
      [userId, r.email, r.admin_name, r.passwordHash],
    );
    const { id: orgId } = await createOrganisationRecords(t, ctx, {
      name: r.company,
      product: r.product,
      planId: r.plan_id,
      country: r.country,
      currency: r.currency,
      timezone: r.timezone,
      trial: true,
      demo: false,
      trialStart: { source: "signup", email: r.email, phone: r.phone, override },
    });
    await t.run("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'org_admin')", [orgId, userId]);
    return { orgId, userId };
  }

  /** Audit the new workspace and record the verification message. */
  async function afterOpen(
    t: Db,
    signupId: string,
    orgId: string,
    userId: string,
    r: { company: string; product: Product; email: string; name: string },
  ) {
    const actor: Actor = { userId, role: "org_admin" };
    const sub = await t.row<{ trial_ends: string; grace_days: number; trial_policy_version: number }>(
      "SELECT trial_ends, grace_days, trial_policy_version FROM subscriptions WHERE org_id = $1",
      [orgId],
    );
    await recordAudit(t, {
      actor,
      orgId,
      action: "Self-service sign-up — organisation created",
      target: signupId,
      detail: `${r.company} · ${r.product} · administrator ${r.email}`,
    });
    await recordAudit(t, {
      actor,
      orgId,
      action: "Trial started",
      target: r.product,
      detail: `ends ${sub?.trial_ends} · grace ${sub?.grace_days} day(s) · trial policy v${sub?.trial_policy_version}`,
    });
    const policy = await loadPolicy(t);
    await issueVerification(t, { orgId, userId, email: r.email, name: r.name, product: r.product, policy });
  }

  async function signupRow(t: Db, id: string, lock = false) {
    const r = await t.row<SignupRow>(
      lock ? "SELECT * FROM org_signups WHERE id = $1 FOR UPDATE" : SIGNUP_SQL + " WHERE s.id = $1",
      [id],
    );
    if (!r) throw fail.notFound("Sign-up request not found");
    return r;
  }

  /** Is this e-mail address or organisation name already in use? (Never told to the caller.) */
  async function duplicates(t: Db, email: string, company: string) {
    const out: { by: "account" | "name"; orgId: null }[] = [];
    if (await t.row("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email]))
      out.push({ by: "account", orgId: null });
    if (await t.row("SELECT 1 FROM organisations WHERE lower(name) = lower($1)", [company]))
      out.push({ by: "name", orgId: null });
    return out;
  }

  return {
    issueVerification,

    async options() {
      const catalogue = await loadCatalogue(db);
      const moduleName = new Map(catalogue.modules.map((m) => [m.key, m.name]));
      const trialOpen = new Set(
        (await db.rows<{ id: string }>("SELECT id FROM catalogue_plans WHERE active AND trial_signup")).map(
          (r) => r.id,
        ),
      );
      return {
        enabled: registrationOpen(),
        termsVersion: settings.termsVersion,
        termsUrl: settings.termsUrl || null,
        trialDays: (await loadPolicy(db)).trialDays,
        plans: catalogue.plans
          .flatMap((p) => {
            const base = p.base;
            const product = (p.products[0] === "agents" ? "agency" : p.products[0]) as Product;
            if (!settings.allowedProducts.includes(product)) return [];
            const priced = p.tier !== "Enterprise" && base?.amount != null && !!base.ccy;
            // a plan PALTAS prices on request is offered only when it is open for a free trial ("Talk to us")
            if (!priced && !trialOpen.has(p.id)) return [];
            return [
              {
                id: p.id,
                name: p.name,
                product,
                tier: p.tier ?? null,
                // only modules that exist in the catalogue: a plan never promises an unknown module
                modules: p.modules.flatMap((key) => {
                  const name = moduleName.get(key);
                  return name ? [{ key, name }] : [];
                }),
                price:
                  priced && base?.amount != null && base.ccy
                    ? { amount: base.amount, currency: base.ccy, frequency: p.frequency }
                    : null,
                contactSales: !priced,
              },
            ];
          })
          .sort(
            (a, b) => TIER_ORDER.indexOf(a.tier ?? "") - TIER_ORDER.indexOf(b.tier ?? "") || a.id.localeCompare(b.id),
          ),
      };
    },

    /** What each plan of a product includes, by area (catalogue_features), for the public pricing pages. */
    async comparison(product: Product) {
      const catalogue = await loadCatalogue(db);
      const moduleName = new Map(catalogue.modules.map((m) => [m.key, m.name]));
      const trialOpen = new Set(
        (await db.rows<{ id: string }>("SELECT id FROM catalogue_plans WHERE active AND trial_signup")).map(
          (r) => r.id,
        ),
      );
      const plans = catalogue.plans
        .filter((p) => (p.products[0] === "agents" ? "agency" : p.products[0]) === product)
        .sort((a, b) => TIER_ORDER.indexOf(a.tier ?? "") - TIER_ORDER.indexOf(b.tier ?? "") || a.id.localeCompare(b.id))
        .map((p) => {
          const priced = p.tier !== "Enterprise" && p.base?.amount != null && !!p.base.ccy;
          return {
            id: p.id,
            name: p.name,
            tier: p.tier ?? null,
            price:
              priced && p.base?.amount != null && p.base.ccy
                ? { amount: p.base.amount, currency: p.base.ccy, frequency: p.frequency }
                : null,
            contactSales: !priced,
            trial: (priced || trialOpen.has(p.id)) && settings.allowedProducts.includes(product),
            buildingsIncluded: p.buildingsIncluded ?? 0,
            modules: p.modules.flatMap((key) => {
              const name = moduleName.get(key);
              return name ? [{ key, name }] : [];
            }),
          };
        });
      const rows = await db.rows<{ id: string; area: string; label: string; module_key: string | null }>(
        "SELECT id, area, label, module_key FROM catalogue_features WHERE product = $1 ORDER BY area_order, sort, id",
        [product],
      );
      const areas: {
        area: string;
        features: { id: string; label: string; module: { key: string; name: string } | null; plans: string[] }[];
      }[] = [];
      for (const r of rows) {
        let a = areas.find((x) => x.area === r.area);
        if (!a) areas.push((a = { area: r.area, features: [] }));
        a.features.push({
          id: r.id,
          label: r.label,
          module: r.module_key ? { key: r.module_key, name: moduleName.get(r.module_key) ?? r.module_key } : null,
          plans: plans.filter((p) => !r.module_key || p.modules.some((m) => m.key === r.module_key)).map((p) => p.id),
        });
      }
      return { product, trialDays: (await loadPolicy(db)).trialDays, plans, areas };
    },

    async create(b: SignupBody, ip: string) {
      if (!registrationOpen()) throw fail.forbidden("Self-service sign-up is not open — contact PALTAS");
      if (!settings.allowedProducts.includes(b.product))
        throw fail.forbidden("Registration for this product is not open — contact PALTAS");
      if (b.terms.version !== settings.termsVersion)
        throw fail.invalid(`Accept the current PALTAS terms (version ${settings.termsVersion})`, {
          termsVersion: settings.termsVersion,
        });
      if (!validTimezone(b.timezone)) throw fail.invalid("Pick a time zone such as Africa/Nairobi");
      const phone = phoneKey(b.phone);
      const [byIp, byEmail] = await Promise.all([
        db.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM org_signups WHERE ip = $1 AND created_at > now() - interval '1 hour'",
          [ip],
        ),
        db.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM org_signups WHERE email = $1 AND created_at > now() - interval '1 day'",
          [b.email],
        ),
      ]);
      if ((byIp?.n ?? 0) >= settings.perIpPerHour)
        throw fail.tooManyAttempts("Too many sign-ups from this address — try again later");
      if ((byEmail?.n ?? 0) >= settings.perEmailPerDay)
        throw fail.tooManyAttempts("Too many sign-ups for this e-mail address today — try again tomorrow");
      // the plan comes from the catalogue (never from code); its currency becomes the organisation's
      const plan = await findPlan(db, b.plan);
      if (!plan || plan.product !== b.product)
        throw fail.invalid(`Pick a ${entitlements.PRODUCT_NAME[b.product]} plan from the PALTAS catalogue`);
      const priced = plan.tier !== "Enterprise" && plan.base_minor != null && !!plan.currency;
      if (!priced && !plan.trial_signup)
        throw fail.invalid("This plan is agreed with PALTAS — send an Enterprise enquiry instead", {
          contactSales: true,
        });
      // a "Talk to us" plan open for a trial opens in its product's catalogue currency; its price is agreed later
      const currency = await trialCurrency(db, plan);
      if (!currency) throw fail.conflict("This plan has no currency in the PALTAS catalogue yet — contact PALTAS");
      // the same work for every outcome, so the answer time says little about existing accounts
      const passwordHash = await hashPassword(b.password);
      const today = clock.today();
      await db.tx(async (t) => {
        // one request per e-mail and per business at a time
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["signup:" + b.email]);
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["signup-company:" + companyKey(b.company)]);
        const id = newId("sgn");
        const insert = (
          status: Status,
          extra: { matched?: unknown; hash?: string | null; orgId?: string; userId?: string },
        ) =>
          t.run(
            `INSERT INTO org_signups (id, status, org_id, user_id, company, company_key, country, timezone, product,
               plan_id, admin_name, email, phone, password_hash, terms_version, terms_accepted_at, ip, signed_up_on,
               opened_on, matched)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$18,$19)`,
            [
              id,
              status,
              extra.orgId ?? null,
              extra.userId ?? null,
              b.company,
              companyKey(b.company),
              b.country,
              b.timezone,
              b.product,
              plan.id,
              b.adminName,
              b.email,
              phone,
              extra.hash ?? null,
              b.terms.version,
              ip,
              today,
              extra.orgId ? today : null,
              JSON.stringify(extra.matched ?? []),
            ],
          );
        const dup = await duplicates(t, b.email, b.company);
        if (dup.length) {
          await insert("duplicate", { matched: dup });
          await recordAudit(t, {
            actor: { userId: null, role: "public" },
            orgId: null,
            action: "Sign-up request not created — already in use",
            target: id,
            detail: dup.map((d) => d.by).join(", "),
          });
          return;
        }
        const policy = await loadPolicy(t);
        const repeats = await findRepeats(t, policy, today, {
          company: b.company,
          country: b.country,
          email: b.email,
          phone,
        });
        if (repeats.length) {
          await insert("blocked_repeat", { matched: repeats, hash: passwordHash });
          await recordAudit(t, {
            actor: { userId: null, role: "public" },
            orgId: null,
            action: "Sign-up request held — repeat trial",
            target: id,
            detail: `same ${[...new Set(repeats.map((r) => r.by))].join(", ")} within ${policy.repeatWindowDays} days · waits for PALTAS staff`,
          });
          return;
        }
        const { orgId, userId } = await openWorkspace(
          t,
          { ...b, plan_id: plan.id, admin_name: b.adminName, phone, currency, passwordHash },
          null,
        );
        await insert("created", { orgId, userId });
        await afterOpen(t, id, orgId, userId, { ...b, name: b.adminName });
      });
      return SIGNUP_RECEIVED;
    },

    async verify(token: string) {
      return db.tx(async (t) => {
        const v = await t.row<{
          id: string;
          org_id: string;
          user_id: string;
          email: string;
          expires_at: string;
          used_at: string | null;
          superseded_at: string | null;
        }>("SELECT * FROM email_verifications WHERE token_hash = $1 FOR UPDATE", [sha256(token)]);
        if (!v || v.used_at || v.superseded_at || new Date(v.expires_at) <= clock.now())
          throw fail.invalid(INVALID_LINK);
        await t.run("UPDATE email_verifications SET used_at = now() WHERE id = $1", [v.id]);
        const n = await t.run(
          "UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 AND lower(email) = lower($2)",
          [v.user_id, v.email],
        );
        if (!n) throw fail.invalid(INVALID_LINK);
        const actor: Actor = { userId: v.user_id, role: "org_admin" };
        await recordAudit(t, { actor, orgId: v.org_id, action: "E-mail address verified", target: v.email });
        // a trial suspended for want of verification works again (records were kept)
        const s = await t.row<{ id: string; suspended_products: Product[] }>(
          "SELECT id, suspended_products FROM org_signups WHERE org_id = $1 AND unverified_suspended_at IS NOT NULL FOR UPDATE",
          [v.org_id],
        );
        if (s) {
          await t.run(
            "UPDATE subscriptions SET status = 'trial' WHERE org_id = $1 AND product = ANY($2) AND status = 'suspended'",
            [v.org_id, s.suspended_products],
          );
          await t.run(
            "UPDATE org_signups SET unverified_suspended_at = NULL, suspended_products = '{}' WHERE id = $1",
            [s.id],
          );
          await recordAudit(t, {
            actor,
            orgId: v.org_id,
            action: "Suspension lifted — e-mail address verified",
            target: s.suspended_products.join(", "),
          });
        }
        return { verified: true as const };
      });
    },

    async resend(user: SessionUser) {
      return db.tx(async (t) => {
        const s = await t.row<SignupRow & { org_id: string; user_id: string }>(
          SIGNUP_SQL +
            " WHERE s.user_id = $1 AND s.status IN ('created', 'allowed') ORDER BY s.created_at DESC LIMIT 1",
          [user.id],
        );
        if (!s) throw fail.notFound("There is no self-service sign-up to verify for this account");
        if (s.email_verified_at) throw fail.conflict("Your e-mail address is already verified");
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["verify:" + user.id]);
        const recent = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM email_verifications WHERE user_id = $1 AND created_at > now() - interval '1 day'",
          [user.id],
        );
        if ((recent?.n ?? 0) >= settings.perEmailPerDay + 1)
          throw fail.tooManyAttempts("Too many verification messages today — try again tomorrow");
        const out = await issueVerification(t, {
          orgId: s.org_id,
          userId: user.id,
          email: user.email,
          name: user.name,
          product: s.product,
          policy: await loadPolicy(t),
        });
        await recordAudit(t, {
          actor: { userId: user.id, role: "org_admin" },
          orgId: s.org_id,
          action: "Verification message recorded again",
          target: user.email,
        });
        return { recorded: true as const, ...out };
      });
    },

    /** Upgrading, paying and inviting members need the self-service administrator's verified e-mail address. */
    async requireVerified(orgId: string, t: Db = db) {
      const r = await t.row<{ verified: boolean }>(
        `SELECT u.email_verified_at IS NOT NULL AS verified FROM org_signups s JOIN users u ON u.id = s.user_id
         WHERE s.org_id = $1`,
        [orgId],
      );
      if (r && !r.verified)
        throw fail.forbidden(
          "Verify your e-mail address first: upgrading, paying and inviting members need a verified address " +
            "(ask for a new link with POST /api/v1/me/email-verification)",
          { emailVerificationRequired: true },
        );
    },

    /** Per organisation: does it still wait for its administrator's e-mail verification? */
    async verificationOf(orgIds: string[]) {
      const rows = await db.rows<{ org_id: string; verified: boolean }>(
        `SELECT s.org_id, u.email_verified_at IS NOT NULL AS verified FROM org_signups s JOIN users u ON u.id = s.user_id
         WHERE s.org_id = ANY($1)`,
        [orgIds],
      );
      const by = new Map(rows.map((r) => [r.org_id, r.verified]));
      return (orgId: string) =>
        !by.has(orgId) ? ("not_required" as const) : by.get(orgId) ? ("verified" as const) : ("required" as const);
    },

    // ------------------------------------------------------------ PALTAS staff: review of held sign-ups
    async list(q: { status?: Status | undefined; limit: number }) {
      const rows = await db.rows<SignupRow>(
        SIGNUP_SQL + ` WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.created_at DESC, s.id LIMIT $2`,
        [q.status ?? null, q.limit],
      );
      return { signups: rows.map(toDto) };
    },

    async allow(actor: Actor & { userId: string }, id: string, reason: string) {
      return db.tx(async (t) => {
        const r = await signupRow(t, id, true);
        if (r.status !== "blocked_repeat") throw fail.conflict(`This sign-up request is ${r.status}`);
        if ((await duplicates(t, r.email, r.company)).length)
          throw fail.conflict("The e-mail address or organisation name is now in use — decline this request");
        const plan = await findPlan(t, r.plan_id);
        const currency = plan ? await trialCurrency(t, plan) : null;
        if (!plan || !currency) throw fail.conflict("The plan is no longer offered — decline this request");
        const { orgId, userId } = await openWorkspace(
          t,
          { ...r, currency, passwordHash: r.password_hash as string },
          { reason, by: actor.userId },
        );
        await t.run(
          `UPDATE org_signups SET status = 'allowed', org_id = $2, user_id = $3, opened_on = $4, password_hash = NULL,
             decided_by = $5, decided_at = now(), decision_reason = $6 WHERE id = $1`,
          [id, orgId, userId, clock.today(), actor.userId, reason],
        );
        await recordAudit(t, {
          actor,
          orgId,
          action: "Repeat trial allowed by PALTAS",
          target: id,
          detail: reason,
          before: { matched: r.matched },
        });
        await afterOpen(t, id, orgId, userId, { ...r, name: r.admin_name });
        return toDto(await signupRow(t, id));
      });
    },

    async decline(actor: Actor & { userId: string }, id: string, reason: string) {
      return db.tx(async (t) => {
        const r = await signupRow(t, id, true);
        if (r.status !== "blocked_repeat") throw fail.conflict(`This sign-up request is ${r.status}`);
        await t.run(
          `UPDATE org_signups SET status = 'declined', password_hash = NULL, decided_by = $2, decided_at = now(),
             decision_reason = $3 WHERE id = $1`,
          [id, actor.userId, reason],
        );
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "Repeat trial declined by PALTAS",
          target: id,
          detail: reason,
        });
        return toDto(await signupRow(t, id));
      });
    },

    /**
     * Suspend trials whose administrator never verified the e-mail address in time (scheduler, daily). With the
     * policy's suspendUnverifiedRequiresDelivery (default on) nobody is suspended while no e-mail provider is
     * configured: the verification link could never have reached them. Returns null when skipped for that reason.
     */
    async suspendUnverified(policy: TrialPolicy, today: string): Promise<number | null> {
      if (policy.suspendUnverifiedRequiresDelivery && !deps.notifications.emailDeliveryConfigured()) return null;
      const due = await db.rows<{ id: string; org_id: string; email: string; admin_name: string }>(
        `SELECT s.id, s.org_id, s.email, s.admin_name FROM org_signups s JOIN users u ON u.id = s.user_id
         WHERE s.status IN ('created', 'allowed') AND u.email_verified_at IS NULL AND s.unverified_suspended_at IS NULL
           AND s.opened_on + $1::int < $2::date ORDER BY s.created_at`,
        [policy.verifyWithinDays, today],
      );
      let suspended = 0;
      for (const d of due) {
        await db.tx(async (t) => {
          const products = (
            await t.rows<{ product: Product }>(
              "UPDATE subscriptions SET status = 'suspended' WHERE org_id = $1 AND status = 'trial' RETURNING product",
              [d.org_id],
            )
          ).map((r) => r.product);
          const n = await t.run(
            `UPDATE org_signups SET unverified_suspended_at = now(), suspended_products = $2
             WHERE id = $1 AND unverified_suspended_at IS NULL`,
            [d.id, products],
          );
          if (!n) return;
          suspended++;
          await recordAudit(t, {
            actor: SYSTEM,
            orgId: d.org_id,
            action: "Trial suspended — e-mail address not verified",
            target: products.join(", ") || "no trial running",
            detail: `not verified within ${policy.verifyWithinDays} day(s) · records kept · verifying lifts it`,
          });
          await deps.notifications.record(t, {
            orgId: d.org_id,
            channel: "email",
            to: d.email,
            category: "transactional",
            templateKey: "signup.unverified",
            vars: {
              name: d.admin_name,
              days: String(policy.verifyWithinDays),
              link: `${settings.appBaseUrl}/account.html#signin`,
            },
            source: "platform",
            sourceRef: "signup.unverified:" + d.id,
          });
        });
      }
      return suspended;
    },
  };
}

export type SignupService = ReturnType<typeof signupService>;
