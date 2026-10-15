/*
 * PALTAS Super Admin: the catalogue, customer organisations, subscription status, invoices and manual receipts.
 * Only PALTAS staff reach this (route auth "staff"); changes need the super_admin staff role, and every change is
 * audited with the record before and after.
 */
import { randomBytes } from "node:crypto";
import type { Product } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { addDays } from "../../lib/dates.js";
import { toMajor } from "../../lib/money.js";
import { recordAudit, type Actor } from "../audit/audit.service.js";
import { findPlan, saveModule, savePlan, type ModuleInput, type PlanInput } from "../catalogue/catalogue.service.js";
import { createUser } from "../identity/identity.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { CORE_ACCOUNTS, ensureAccounts } from "../ledger/default-chart.js";
import { loadOrganisation } from "../organisations/organisations.service.js";
import type { PaymentsService } from "../payments/payments.service.js";
import type { BillingService } from "../subscriptions/billing.service.js";
import { resolveEntitlement } from "../subscriptions/entitlement.service.js";

export function staffActor(user: SessionUser, need?: "super_admin"): Actor {
  if (need && user.staffRole !== need) throw fail.staffRoleNotAllowed();
  return { userId: user.id, role: user.staffRole ?? "staff" };
}

/** Everything a new organisation needs in one transaction: the organisation, its first subscription, its chart of accounts. */
export async function createOrganisationRecords(
  t: Db,
  ctx: Pick<AppContext, "clock" | "products">,
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
  },
) {
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
  await t.run(
    "INSERT INTO subscriptions (org_id, product, plan_id, status, trial_ends, anchor) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      id,
      input.product,
      plan.id,
      input.trial ? "trial" : "active",
      input.trial ? addDays(today, plan.trial_days || 14) : null,
      input.trial ? null : today,
    ],
  );
  await ensureAccounts(t, id, [...CORE_ACCOUNTS, ...ctx.products.accountsFor(input.product)]);
  return { id, plan };
}

export function adminService(ctx: AppContext, deps: { billing: BillingService; payments: PaymentsService }) {
  const { db, clock } = ctx;

  return {
    async savePlan(user: SessionUser, id: string, input: PlanInput) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
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
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
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
      },
    ) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        const { id, plan } = await createOrganisationRecords(t, ctx, { ...b, planId: b.plan });
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
      const actor = staffActor(user, "super_admin");
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
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        if (!(await t.row("SELECT 1 FROM organisations WHERE id = $1", [orgId])))
          throw fail.notFound("Organisation not found");
        const plan = await findPlan(t, b.plan);
        if (!plan || plan.product !== b.product) throw fail.invalid("Pick a plan for that product");
        if (await t.row("SELECT 1 FROM subscriptions WHERE org_id = $1 AND product = $2", [orgId, b.product]))
          throw fail.conflict("Already has this product");
        const today = clock.today();
        await t.run(
          "INSERT INTO subscriptions (org_id, product, plan_id, status, trial_ends, anchor) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            orgId,
            b.product,
            plan.id,
            b.trial ? "trial" : "active",
            b.trial ? addDays(today, plan.trial_days || 14) : null,
            b.trial ? null : today,
          ],
        );
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
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["invoice:" + orgId]);
        const en = await resolveEntitlement(t, ctx.products, clock.today(), orgId, product);
        if (!en) throw fail.notFound("Organisation or product subscription not found");
        const from = en.ent.nextBilling ?? clock.today();
        if (
          await t.row(
            "SELECT 1 FROM billing_invoices WHERE org_id = $1 AND product = $2 AND period_from = $3 AND status <> 'Void' AND note = 'Issued by PALTAS'",
            [orgId, en.product, from],
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
      staffActor(user, "super_admin");
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
  };
}

export type AdminService = ReturnType<typeof adminService>;
