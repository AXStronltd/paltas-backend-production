/*
 * PALTAS Super Admin: the catalogue, customer organisations, subscription status, invoices and manual receipts.
 * Only PALTAS staff reach this (route auth "staff"); changes need the super_admin staff role, and every change is
 * audited with the record before and after.
 */
import { randomBytes } from "node:crypto";
import { staffCan, type Product, type StaffPermission } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { toMajor } from "../../lib/money.js";
import { recordAudit, type Actor } from "../audit/audit.service.js";
import { findPlan, saveModule, savePlan, type ModuleInput, type PlanInput } from "../catalogue/catalogue.service.js";
import { createUser } from "../identity/identity.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { CORE_ACCOUNTS, ensureAccounts } from "../ledger/default-chart.js";
import { loadMembers, loadOrganisation } from "../organisations/organisations.service.js";
import type { PaymentsService } from "../payments/payments.service.js";
import { furtherProductTrial, openSubscription, organisationIdentity, type TrialStart } from "../signup/policy.js";
import { toInvoice, type BillingService } from "../subscriptions/billing.service.js";
import { RENEWAL_NOTE } from "../scheduler/platform-jobs.js";
import { resolveEntitlement, toEntitlementsView } from "../subscriptions/entitlement.service.js";

/** A PALTAS staff member as the actor of a change. With a permission, staff whose role lacks it are refused. */
export function staffActor(user: SessionUser, need?: StaffPermission): Actor {
  if (need && !staffCan(user.staffRole, need)) throw fail.staffRoleNotAllowed();
  return { userId: user.id, role: user.staffRole ?? "staff" };
}

/**
 * Everything a new organisation needs in one transaction: the organisation, its first subscription (a trial follows
 * the platform trial policy), its chart of accounts. Demo organisations are refused in production.
 */
export async function createOrganisationRecords(
  t: Db,
  ctx: Pick<AppContext, "clock" | "products" | "config">,
  input: {
    id?: string;
    name: string;
    legalName?: string | undefined;
    product: Product;
    planId: string;
    country: string;
    currency: string;
    timezone: string;
    trial: boolean;
    demo?: boolean;
    /** Who the business is and which path starts its trial (one trial per business). */
    trialStart?: Omit<TrialStart, "who"> & { email?: string | null; phone?: string | null };
  },
) {
  if (input.demo && ctx.config.env === "production")
    throw fail.forbidden("Demo or sample organisations cannot be created in production");
  const plan = await findPlan(t, input.planId);
  if (!plan) throw fail.invalid("Pick a plan");
  if (plan.product !== input.product) throw fail.invalid(`The plan is for ${plan.product}, not ${input.product}`);
  if (await t.row("SELECT 1 FROM organisations WHERE lower(name) = lower($1)", [input.name]))
    throw fail.conflict("An organisation with this name already exists");
  const id = input.id ?? "ORG-" + randomBytes(4).toString("hex").toUpperCase();
  const today = ctx.clock.today();
  await t.run(
    "INSERT INTO organisations (id, name, legal_name, country, currency, timezone, demo) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, input.name, input.legalName || input.name, input.country, input.currency, input.timezone, !!input.demo],
  );
  const start = input.trialStart ?? { source: "staff" as const };
  await openSubscription(t, {
    orgId: id,
    product: input.product,
    planId: plan.id,
    today,
    trial: input.trial
      ? {
          ...start,
          who: { company: input.name, country: input.country, email: start.email ?? null, phone: start.phone ?? null },
        }
      : null,
  });
  await ensureAccounts(t, id, [...CORE_ACCOUNTS, ...ctx.products.accountsFor(input.product)]);
  return { id, plan };
}

export function adminService(ctx: AppContext, deps: { billing: BillingService; payments: PaymentsService }) {
  const { db, clock } = ctx;
  const PRICE_APPROVAL =
    "Prices of an existing plan or module change only through a price change request approved by a second staff member with billing rights (POST /api/v1/admin/price-changes)";

  return {
    async savePlan(user: SessionUser, id: string, input: PlanInput) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        if (ctx.config.cataloguePriceApproval) {
          const cur = await t.row<{
            base_minor: number | null;
            extra_building_minor: number | null;
            currency: string | null;
          }>("SELECT base_minor, extra_building_minor, currency FROM catalogue_plans WHERE id = $1 FOR UPDATE", [id]);
          if (
            cur &&
            (cur.base_minor !== input.baseMinor ||
              cur.extra_building_minor !== input.extraBuildingMinor ||
              (input.baseMinor != null || input.extraBuildingMinor != null
                ? cur.currency !== (input.currency ?? null)
                : false))
          )
            throw fail.conflict(PRICE_APPROVAL);
        }
        const { before, after } = await savePlan(t, id, input);
        // price and plan changes apply to new invoices; issued invoices are never rewritten
        await recordAudit(t, {
          actor,
          orgId: null,
          action: before ? "Plan changed" : "Plan created",
          target: id,
          before,
          after,
        });
        return { ok: true as const, created: !before };
      });
    },

    async saveModule(user: SessionUser, key: string, input: ModuleInput) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        if (ctx.config.cataloguePriceApproval && (input.priceMinor !== undefined || input.currency !== undefined)) {
          const cur = await t.row<{ price_minor: number | null; price_ccy: string | null }>(
            "SELECT price_minor, price_ccy FROM catalogue_modules WHERE key = $1 FOR UPDATE",
            [key],
          );
          if (
            cur &&
            ((input.priceMinor !== undefined && input.priceMinor !== cur.price_minor) ||
              (input.currency !== undefined && input.currency !== cur.price_ccy))
          )
            throw fail.conflict(PRICE_APPROVAL);
        }
        const { before, after } = await saveModule(t, key, input);
        await recordAudit(t, { actor, orgId: null, action: "Module catalogue changed", target: key, before, after });
        return { ok: true as const };
      });
    },

    async listOrganisations() {
      const ids = await db.rows<{ id: string }>("SELECT id FROM organisations ORDER BY name");
      const subs = await db.rows<{
        org_id: string;
        product: Product;
        plan_id: string | null;
        status: "trial" | "active" | "suspended" | "expired";
        trial_ends: string | null;
      }>("SELECT org_id, product, plan_id, status, trial_ends FROM subscriptions ORDER BY created_at, product");
      const out = [];
      for (const { id } of ids) {
        const o = await loadOrganisation(db, id);
        if (!o) continue;
        out.push({
          ...o,
          subscriptions: subs
            .filter((s) => s.org_id === id)
            .map((s) => ({ product: s.product, plan: s.plan_id, status: s.status, trialEnds: s.trial_ends })),
        });
      }
      return { organisations: out };
    },

    async createOrganisation(
      user: SessionUser,
      b: {
        name: string;
        legalName?: string | undefined;
        product: Product;
        plan: string;
        country: string;
        currency: string;
        timezone: string;
        trial: boolean;
        admin: { email: string; name?: string | undefined };
        repeatTrialReason?: string | undefined;
      },
    ) {
      const actor = staffActor(user, "clients.manage");
      return db.tx(async (t) => {
        const { id, plan } = await createOrganisationRecords(t, ctx, {
          ...b,
          planId: b.plan,
          trialStart: {
            source: "staff",
            email: b.admin.email,
            override: b.repeatTrialReason ? { reason: b.repeatTrialReason, by: user.id } : null,
          },
        });
        let u = await t.row<{ id: string; staff_role: string | null }>(
          "SELECT id, staff_role FROM users WHERE lower(email) = lower($1)",
          [b.admin.email],
        );
        if (u?.staff_role) throw fail.invalid("A PALTAS staff account cannot administer a client organisation");
        let temporaryPassword: string | null = null;
        if (!u) {
          const created = await createUser(t, { email: b.admin.email, name: b.admin.name ?? b.admin.email });
          u = { id: created.id, staff_role: null };
          temporaryPassword = created.temporaryPassword;
        }
        await t.run("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'org_admin')", [id, u.id]);
        await recordAudit(t, {
          actor,
          orgId: id,
          action: "Organisation created",
          target: id,
          detail: `${b.name} · ${plan.id}`,
          after: { plan: plan.id, trial: b.trial },
        });
        // the temporary password is shown once, to be passed on through a secure channel; it is never stored in clear
        return { id, temporaryPassword };
      });
    },

    async setStatus(
      user: SessionUser,
      orgId: string,
      b: { status: "active" | "trial" | "suspended" | "expired"; reason: string; product?: Product | undefined },
    ) {
      const actor = staffActor(user, "clients.manage");
      return db.tx(async (t) => {
        const first = await t.row<{ product: Product }>(
          "SELECT product FROM subscriptions WHERE org_id = $1 ORDER BY created_at, product LIMIT 1",
          [orgId],
        );
        if (!first) throw fail.notFound("Organisation not found");
        const product = b.product ?? first.product;
        const before = await t.row<{ status: string }>(
          "SELECT status FROM subscriptions WHERE org_id = $1 AND product = $2 FOR UPDATE",
          [orgId, product],
        );
        if (!before) throw fail.notFound(`No ${product} subscription`);
        await t.run(
          "UPDATE subscriptions SET status = $3, anchor = COALESCE(anchor, CASE WHEN $3 = 'active' THEN $4::date END) WHERE org_id = $1 AND product = $2",
          [orgId, product, b.status, clock.today()],
        );
        await recordAudit(t, {
          actor,
          orgId,
          action: "Subscription status changed",
          target: product,
          detail: b.reason,
          before,
          after: { status: b.status },
        });
        return { ok: true as const, product };
      });
    },

    async addProduct(user: SessionUser, orgId: string, b: { product: Product; plan: string; trial: boolean }) {
      const actor = staffActor(user, "clients.manage");
      return db.tx(async (t) => {
        if (!(await t.row("SELECT 1 FROM organisations WHERE id = $1", [orgId])))
          throw fail.notFound("Organisation not found");
        const plan = await findPlan(t, b.plan);
        if (!plan || plan.product !== b.product) throw fail.invalid("Pick a plan for that product");
        if (await t.row("SELECT 1 FROM subscriptions WHERE org_id = $1 AND product = $2", [orgId, b.product]))
          throw fail.conflict("Already has this product");
        if (b.trial && !(await furtherProductTrial(t)))
          throw fail.conflict("The platform trial policy gives a further product no trial — add it as paid");
        await openSubscription(t, {
          orgId,
          product: b.product,
          planId: plan.id,
          today: clock.today(),
          trial: b.trial ? { source: "second_product", who: await organisationIdentity(t, orgId) } : null,
        });
        await ensureAccounts(t, orgId, ctx.products.accountsFor(b.product));
        await recordAudit(t, {
          actor,
          orgId,
          action: "Product subscription added",
          target: b.product,
          detail: `${plan.id}${b.trial ? " · trial" : ""} · existing products unchanged`,
        });
        return { ok: true as const };
      });
    },

    async issueInvoice(user: SessionUser, orgId: string, product?: Product) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["invoice:" + orgId]);
        const en = await resolveEntitlement(t, ctx.products, clock.today(), orgId, product);
        if (!en) throw fail.notFound("Organisation or product subscription not found");
        const from = en.ent.nextBilling ?? clock.today();
        if (
          await t.row(
            "SELECT 1 FROM billing_invoices WHERE org_id = $1 AND product = $2 AND period_from = $3 AND status <> 'Void' AND note IN ('Issued by PALTAS', $4)",
            [orgId, en.product, from, RENEWAL_NOTE],
          )
        ) {
          throw fail.conflict(`A ${en.product} invoice for the period from ${from} already exists`);
        }
        const inv = await deps.billing.issuePeriodInvoice(t, en, "Issued by PALTAS");
        if (!inv) throw fail.invalid(`Nothing to bill: set prices in ${en.org.currency} first`);
        await recordAudit(t, {
          actor,
          orgId,
          action: "Subscription invoice issued",
          target: inv.id,
          detail: `${inv.currency} ${toMajor(inv.totalMinor, inv.currency)}`,
        });
        return inv;
      });
    },

    async recordReceipt(user: SessionUser, invoiceId: string, b: { ref: string; reason: string }) {
      staffActor(user, "billing.manage");
      if (await db.row("SELECT 1 FROM payment_events WHERE lower(ref) = lower($1)", [b.ref]))
        throw fail.conflict("This reference is already used by another payment");
      const inv = await db.row<{ id: string; total_minor: number; currency: string }>(
        "SELECT id, total_minor, currency FROM billing_invoices WHERE id = $1",
        [invoiceId],
      );
      if (!inv) throw fail.notFound("Invoice not found");
      return deps.payments.receive(
        "manual",
        {
          id: b.ref,
          type: "subscription.payment",
          status: "succeeded",
          amountMinor: inv.total_minor,
          currency: inv.currency,
          ref: b.ref,
          reason: b.reason,
          invoiceId: inv.id,
        },
        { manual: true, recordedBy: user.id, eventId: "manual:" + b.ref.toLowerCase() },
      );
    },

    async getOrganisation(orgId: string) {
      const o = await loadOrganisation(db, orgId);
      if (!o) throw fail.notFound("Organisation not found");
      const terms = (await db.row<{ discount_pct: string; terms_note: string }>(
        "SELECT discount_pct, terms_note FROM organisations WHERE id = $1",
        [orgId],
      )) as { discount_pct: string; terms_note: string };
      const rows = await db.rows<SubscriptionRow>(
        "SELECT * FROM subscriptions WHERE org_id = $1 ORDER BY created_at, product",
        [orgId],
      );
      const subscriptions = [];
      for (const r of rows) {
        const en = await resolveEntitlement(db, ctx.products, clock.today(), orgId, r.product);
        if (!en) continue;
        const rec = r.product === en.org.type ? en.org.ent : en.org.subs?.[r.product];
        subscriptions.push({
          product: r.product,
          plan: r.plan_id,
          status: r.status,
          trialEnds: r.trial_ends,
          addons: rec?.addons ?? [],
          disabled: rec?.disabled ?? [],
          pending: rec?.pending ?? [],
          buildings: { extra: r.buildings_extra, override: r.buildings_override },
          entitlement: toEntitlementsView(en, clock.today()),
        });
      }
      return {
        ...o,
        terms: { discountPct: Number(terms.discount_pct), note: terms.terms_note },
        members: await loadMembers(db, orgId),
        subscriptions,
      };
    },

    async updateOrganisation(
      user: SessionUser,
      orgId: string,
      b: {
        name?: string | undefined;
        legalName?: string | undefined;
        country?: string | undefined;
        currency?: string | undefined;
        timezone?: string | undefined;
        admin?: { email: string; name?: string | undefined } | undefined;
      },
    ) {
      const actor = staffActor(user, "clients.manage");
      return db.tx(async (t) => {
        const before = await t.row<{
          name: string;
          legal_name: string;
          country: string;
          currency: string;
          timezone: string;
        }>("SELECT name, legal_name, country, currency, timezone FROM organisations WHERE id = $1 FOR UPDATE", [orgId]);
        if (!before) throw fail.notFound("Organisation not found");
        if (b.name && b.name.toLowerCase() !== before.name.toLowerCase()) {
          if (await t.row("SELECT 1 FROM organisations WHERE lower(name) = lower($1) AND id <> $2", [b.name, orgId]))
            throw fail.conflict("An organisation with this name already exists");
        }
        // amounts already invoiced are in the old currency: changing it would make them unreadable
        if (
          b.currency &&
          b.currency !== before.currency &&
          (await t.row("SELECT 1 FROM billing_invoices WHERE org_id = $1", [orgId]))
        )
          throw fail.conflict("The currency cannot change once an invoice has been issued");
        const after = {
          name: b.name ?? before.name,
          legal_name: b.legalName ?? before.legal_name,
          country: b.country ?? before.country,
          currency: b.currency ?? before.currency,
          timezone: b.timezone ?? before.timezone,
        };
        await t.run(
          "UPDATE organisations SET name = $2, legal_name = $3, country = $4, currency = $5, timezone = $6 WHERE id = $1",
          [orgId, after.name, after.legal_name, after.country, after.currency, after.timezone],
        );
        let temporaryPassword: string | null = null;
        if (b.admin) {
          let u = await t.row<{ id: string; staff_role: string | null }>(
            "SELECT id, staff_role FROM users WHERE lower(email) = lower($1)",
            [b.admin.email],
          );
          if (u?.staff_role) throw fail.invalid("A PALTAS staff account cannot administer a client organisation");
          if (!u) {
            const created = await createUser(t, { email: b.admin.email, name: b.admin.name ?? b.admin.email });
            u = { id: created.id, staff_role: null };
            temporaryPassword = created.temporaryPassword;
          }
          await t.run(
            `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'org_admin')
             ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'org_admin', status = 'active'`,
            [orgId, u.id],
          );
        }
        await recordAudit(t, {
          actor,
          orgId,
          action: "Organisation details changed",
          target: orgId,
          detail: b.admin ? `administrator: ${b.admin.email}` : "",
          before,
          after,
        });
        return { ok: true as const, temporaryPassword };
      });
    },

    async setPlan(user: SessionUser, orgId: string, b: { plan: string; reason: string }) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        const plan = await findPlan(t, b.plan);
        if (!plan) throw fail.invalid("Pick a plan");
        const product = plan.product as Product;
        const sub = await lockSubscription(t, orgId, product);
        if (sub.plan_id === plan.id) throw fail.invalid(`Already on ${plan.id}`);
        await t.run("UPDATE subscriptions SET plan_id = $3 WHERE org_id = $1 AND product = $2", [
          orgId,
          product,
          plan.id,
        ]);
        // a plan change scheduled earlier (e.g. a downgrade at the period end) would undo this one
        await t.run("DELETE FROM subscription_pending WHERE org_id = $1 AND product = $2 AND type = 'plan'", [
          orgId,
          product,
        ]);
        await recordAudit(t, {
          actor,
          orgId,
          action: "Plan changed",
          target: product,
          detail: b.reason,
          before: { plan: sub.plan_id },
          after: { plan: plan.id },
        });
        return { ok: true as const, product };
      });
    },

    async setTrial(
      user: SessionUser,
      orgId: string,
      b: { product?: Product | undefined; trialEnds: string; reason: string },
    ) {
      const actor = staffActor(user, "clients.manage");
      return db.tx(async (t) => {
        const sub = await lockSubscription(t, orgId, b.product);
        if (sub.status !== "trial") throw fail.invalid("Only a subscription on trial has a trial end date");
        await t.run("UPDATE subscriptions SET trial_ends = $3 WHERE org_id = $1 AND product = $2", [
          orgId,
          sub.product,
          b.trialEnds,
        ]);
        await recordAudit(t, {
          actor,
          orgId,
          action: "Trial end date changed",
          target: sub.product,
          detail: b.reason,
          before: { trialEnds: sub.trial_ends },
          after: { trialEnds: b.trialEnds },
        });
        return { ok: true as const, product: sub.product };
      });
    },

    async setTerms(user: SessionUser, orgId: string, b: { discountPct: number; note: string }) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        const before = await t.row<{ discount_pct: string; terms_note: string }>(
          "SELECT discount_pct, terms_note FROM organisations WHERE id = $1 FOR UPDATE",
          [orgId],
        );
        if (!before) throw fail.notFound("Organisation not found");
        await t.run("UPDATE organisations SET discount_pct = $2, terms_note = $3 WHERE id = $1", [
          orgId,
          b.discountPct,
          b.note,
        ]);
        // applies to invoices issued from now on; issued invoices are never rewritten
        await recordAudit(t, {
          actor,
          orgId,
          action: "Negotiated terms changed",
          target: orgId,
          detail: `${b.discountPct}%${b.note ? " · " + b.note : ""}`,
          before: { discountPct: Number(before.discount_pct), note: before.terms_note },
          after: b,
        });
        return { ok: true as const };
      });
    },

    async setAllowance(
      user: SessionUser,
      orgId: string,
      b: { product?: Product | undefined; extra: number; override: number | null; reason: string },
    ) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        const sub = await lockSubscription(t, orgId, b.product);
        await t.run(
          "UPDATE subscriptions SET buildings_extra = $3, buildings_override = $4 WHERE org_id = $1 AND product = $2",
          [orgId, sub.product, b.extra, b.override],
        );
        await recordAudit(t, {
          actor,
          orgId,
          action: "Building allowance changed",
          target: sub.product,
          detail: b.reason,
          before: { extra: sub.buildings_extra, override: sub.buildings_override },
          after: { extra: b.extra, override: b.override },
        });
        return { ok: true as const, product: sub.product };
      });
    },

    async setModule(
      user: SessionUser,
      orgId: string,
      key: string,
      b: { product?: Product | undefined; on: boolean; reason: string },
    ) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        const sub = await lockSubscription(t, orgId, b.product);
        const en = await resolveEntitlement(t, ctx.products, clock.today(), orgId, sub.product);
        if (!en) throw fail.notFound("Organisation or product subscription not found");
        const mods = en.catalogue.modules;
        const m = mods.find((x) => x.key === key);
        if (!m) throw fail.notFound("Unknown module");
        if (!m.products.includes(sub.product)) throw fail.invalid(`${m.name} is not offered for this product`);
        const on = en.ent.modules;
        const where = [orgId, sub.product, key];
        if (b.on) {
          const missing = m.dep.filter((d) => !on[d]);
          if (missing.length)
            throw fail.invalid(
              `${m.name} needs ${missing.map((d) => mods.find((x) => x.key === d)?.name ?? d).join(", ")} first`,
            );
          await t.run(
            "DELETE FROM subscription_disabled WHERE org_id = $1 AND product = $2 AND module_key = $3",
            where,
          );
          if (!en.ent.plan.modules.includes(key))
            await t.run(
              `INSERT INTO subscription_addons (org_id, product, module_key, since) VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [...where, clock.today()],
            );
        } else {
          const dependents = mods.filter((x) => x.dep.includes(key) && on[x.key]);
          if (dependents.length)
            throw fail.invalid(`Switch off ${dependents.map((x) => x.name).join(", ")} first — they depend on it`);
          await t.run("DELETE FROM subscription_addons WHERE org_id = $1 AND product = $2 AND module_key = $3", where);
          await t.run(
            "INSERT INTO subscription_disabled (org_id, product, module_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            where,
          );
        }
        // a scheduled cancellation of this add-on is settled by switching it now
        await t.run(
          "DELETE FROM subscription_pending WHERE org_id = $1 AND product = $2 AND type = 'cancelAddon' AND module_key = $3",
          where,
        );
        const now = await resolveEntitlement(t, ctx.products, clock.today(), orgId, sub.product);
        await recordAudit(t, {
          actor,
          orgId,
          action: b.on ? "Module enabled" : "Module disabled",
          target: `${sub.product}:${key}`,
          detail: `${m.name} · ${b.reason} (records are kept)`,
          before: { on: !!on[key] },
          after: { on: !!now?.ent.modules[key] },
        });
        return { ok: true as const, product: sub.product, modules: now?.ent.modules ?? {} };
      });
    },

    async listInvoices(q: { orgId?: string | undefined; status?: string | undefined; limit: number }) {
      const rows = await db.rows<Parameters<typeof toInvoice>[0] & { org_id: string; org_name: string }>(
        `SELECT i.*, o.name AS org_name FROM billing_invoices i JOIN organisations o ON o.id = i.org_id
         WHERE ($1::text IS NULL OR i.org_id = $1) AND ($2::text IS NULL OR i.status = $2)
         ORDER BY i.issued DESC, i.id DESC LIMIT $3`,
        [q.orgId ?? null, q.status ?? null, q.limit],
      );
      return { invoices: rows.map((r) => ({ ...toInvoice(r), orgId: r.org_id, orgName: r.org_name })) };
    },

    async voidInvoice(user: SessionUser, invoiceId: string, b: { reason: string }) {
      const actor = staffActor(user, "billing.manage");
      return db.tx(async (t) => {
        const inv = await t.row<{ org_id: string; status: string }>(
          "SELECT org_id, status FROM billing_invoices WHERE id = $1 FOR UPDATE",
          [invoiceId],
        );
        if (!inv) throw fail.notFound("Invoice not found");
        if (inv.status === "Paid") throw fail.conflict("A paid invoice cannot be voided — issue a credit instead");
        if (inv.status === "Void") throw fail.conflict("This invoice is already void");
        await t.run("UPDATE billing_invoices SET status = 'Void' WHERE id = $1", [invoiceId]);
        // an order waiting for this invoice will now never be paid through it
        await t.run(
          "UPDATE billing_purchases SET status = 'Cancelled — invoice voided' WHERE invoice_id = $1 AND status LIKE 'Awaiting payment%'",
          [invoiceId],
        );
        await recordAudit(t, {
          actor,
          orgId: inv.org_id,
          action: "Subscription invoice voided",
          target: invoiceId,
          detail: b.reason,
          before: { status: inv.status },
          after: { status: "Void" },
        });
        return { ok: true as const };
      });
    },
  };
}

interface SubscriptionRow {
  org_id: string;
  product: Product;
  plan_id: string | null;
  status: "trial" | "active" | "suspended" | "expired";
  trial_ends: string | null;
  buildings_extra: number;
  buildings_override: number | null;
}

/** One product subscription, locked for this change. Product omitted = the organisation's first product. */
async function lockSubscription(t: Db, orgId: string, product?: Product): Promise<SubscriptionRow> {
  if (!(await t.row("SELECT 1 FROM organisations WHERE id = $1", [orgId])))
    throw fail.notFound("Organisation not found");
  const row = await t.row<SubscriptionRow>(
    product
      ? "SELECT * FROM subscriptions WHERE org_id = $1 AND product = $2 FOR UPDATE"
      : "SELECT * FROM subscriptions WHERE org_id = $1 ORDER BY created_at, product LIMIT 1 FOR UPDATE",
    product ? [orgId, product] : [orgId],
  );
  if (!row) throw fail.notFound(product ? `No ${product} subscription — add the product first` : "No subscription");
  return row;
}

export type AdminService = ReturnType<typeof adminService>;
