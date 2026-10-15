/*
 * Self-service upgrade: a trial (running, in grace or expired) or a lapsed subscription becomes paid.
 *
 *   options   the plans of this product in the catalogue (never hard-coded) with their price and billing period
 *   upgrade   the verified organisation administrator picks a plan and the billing period the catalogue offers for
 *             it, and how to pay. An invoice is issued through the existing billing service (an order of kind
 *             "plan" that ALWAYS waits for payment, even in BILLING_MODE=simulated). The subscription becomes
 *             active only when that invoice is paid:
 *               - provider: a signed provider event (card / M-Pesa adapters) quoting the invoice number. Only test
 *                 adapters exist: live collection is BLOCKED (credentials, contracts);
 *               - bank_transfer: PALTAS staff confirm the bank reference (admin receipts, or a confirmed bank
 *                 statement line imported by one person and confirmed by another).
 *             Nothing becomes active because a form was submitted. Records are never touched, so an expired
 *             workspace comes back with everything it had.
 *   Downgrades and cancellations keep the existing rules: they take effect at the end of the paid period.
 */
import { entitlements, type Product } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { toMinor } from "../../lib/money.js";
import type { OrgScope } from "../access/org-access.js";
import { exportOrganisationAs } from "../admin/export.js";
import { recordAudit } from "../audit/audit.service.js";
import type { BillingService } from "../subscriptions/billing.service.js";
import { toInvoice } from "../subscriptions/billing.service.js";
import { loadPolicy } from "./policy.js";
import type { SignupService } from "./signup.service.js";

type Frequency = "monthly" | "quarterly" | "yearly";
type Method = "provider" | "bank_transfer";

const PROVIDER_NOTE =
  "Not connected — test adapter. Live card and M-Pesa collection is BLOCKED (needs provider credentials and contracts); " +
  "a signed provider event quoting the invoice number marks it paid.";
const BANK_NOTE =
  "Pay PALTAS by bank transfer quoting the invoice number. PALTAS staff confirm the payment with the bank reference; " +
  "the subscription starts then.";

export function upgradeService(ctx: AppContext, deps: { billing: BillingService; signup: SignupService }) {
  const { db } = ctx;

  function plansFor(s: OrgScope) {
    const { catalogue, org, ent } = s.entitlement;
    return catalogue.plans
      .filter((p) => p.products[0] === s.product && p.tier)
      .map((p) => {
        const price = entitlements.priceIn(p.base, org.currency);
        return {
          plan: p,
          id: p.id,
          name: p.name,
          tier: p.tier,
          // the billing period is part of the plan in the catalogue (one plan row per period PALTAS sells)
          frequencies: [p.frequency] as Frequency[],
          price: price ? { amountMinor: toMinor(price.amount, price.ccy), currency: price.ccy, per: price.per } : null,
          contactSales: p.tier === "Enterprise" || !price,
          current: p.id === ent.planId,
        };
      });
  }

  return {
    async options(s: OrgScope) {
      const ent = s.entitlement.ent;
      const verified = (await deps.signup.verificationOf([s.orgId]))(s.orgId) !== "required";
      return {
        product: s.product,
        status: ent.status,
        trial: entitlements.trialState(s.entitlement.view.ent, s.today),
        emailVerified: verified,
        plans: plansFor(s).map(({ plan: _p, ...rest }) => rest),
        paymentMethods: [
          { method: "provider" as const, available: true, note: PROVIDER_NOTE },
          { method: "bank_transfer" as const, available: true, note: BANK_NOTE },
        ],
      };
    },

    async upgrade(s: OrgScope, b: { plan: string; frequency: Frequency; payment: Method }) {
      const ent = s.entitlement.ent;
      if (ent.status === "active")
        throw fail.conflict("This subscription is already active — change plan with POST …/subscription/plan");
      if (ent.status === "suspended")
        throw fail.conflict("This subscription is suspended — verify your e-mail address or contact PALTAS");
      const choice = plansFor(s).find((p) => p.id === b.plan);
      if (!choice)
        throw fail.invalid(`Pick a ${entitlements.PRODUCT_NAME[s.product] ?? s.product} plan from the catalogue`);
      if (choice.contactSales || !choice.price)
        throw fail.invalid("This plan is agreed with PALTAS — send an Enterprise enquiry", { contactSales: true });
      if (!choice.frequencies.includes(b.frequency))
        throw fail.invalid(`${choice.name} is billed ${choice.frequencies.join(" or ")} in the PALTAS catalogue`, {
          frequencies: choice.frequencies,
        });
      const price = choice.price;
      return db.tx(async (t) => {
        // one open upgrade per product subscription at a time
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", [`upgrade:${s.orgId}:${s.product}`]);
        const open = await t.row<{ invoice_id: string }>(
          `SELECT u.invoice_id FROM subscription_upgrades u JOIN billing_invoices i ON i.id = u.invoice_id
           WHERE u.org_id = $1 AND u.product = $2 AND i.status IN ('Open', 'Payment failed')`,
          [s.orgId, s.product],
        );
        if (open)
          throw fail.conflict(`An upgrade is already waiting for payment of invoice ${open.invoice_id}`, {
            invoiceId: open.invoice_id,
          });
        const out = await deps.billing.order(
          t,
          { orgId: s.orgId, product: s.product, actor: s.actor, en: s.entitlement },
          {
            kind: "plan",
            what: `${choice.name} — first ${price.per}`,
            amountMinor: price.amountMinor,
            planId: choice.id,
            taxPct: choice.plan.taxPct ?? 0,
            note: "Self-service upgrade",
            requirePayment: true,
          },
        );
        const invoice = out.invoice;
        if (!invoice) throw new Error("A self-service upgrade must issue an invoice");
        await t.run(
          `INSERT INTO subscription_upgrades (id, org_id, product, plan_id, frequency, method, purchase_id, invoice_id,
             requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newId("upg"), s.orgId, s.product, choice.id, b.frequency, b.payment, out.purchase.id, invoice.id, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Self-service upgrade ordered — awaiting payment",
          target: invoice.id,
          detail: `${s.product} · ${choice.id} · ${b.frequency} · ${b.payment} · ${invoice.currency} ${invoice.totalMinor} (minor units) · was ${ent.status}`,
        });
        return {
          ...out,
          payment: {
            method: b.payment,
            reference: invoice.id,
            status: "Awaiting payment — the subscription starts when the payment is confirmed",
            instructions: b.payment === "provider" ? PROVIDER_NOTE : BANK_NOTE,
          },
        };
      });
    },

    /** The organisation's own data export: allowed after expiry while the policy says so (records are kept). */
    async exportData(s: OrgScope, reason: string) {
      const policy = await loadPolicy(db);
      if (!s.entitlement.ent.usable && !policy.exportAllowed)
        throw fail.subscriptionInactive("The trial policy does not allow an export after expiry — choose a plan");
      return exportOrganisationAs(ctx, s.actor, s.orgId, reason);
    },

    /** PALTAS staff: self-service upgrades and how each will be paid. */
    async list(status: "awaiting" | "paid" | "all") {
      const rows = await db.rows<
        Parameters<typeof toInvoice>[0] & {
          upgrade_id: string;
          org_name: string;
          plan_id: string;
          frequency: Frequency;
          method: Method;
          requested_at: string;
          product: Product;
        }
      >(
        `SELECT i.*, u.id AS upgrade_id, o.name AS org_name, u.plan_id, u.frequency, u.method,
                u.created_at AS requested_at
         FROM subscription_upgrades u JOIN billing_invoices i ON i.id = u.invoice_id
         JOIN organisations o ON o.id = u.org_id
         WHERE $1 = 'all' OR ($1 = 'paid' AND i.status = 'Paid')
            OR ($1 = 'awaiting' AND i.status IN ('Open', 'Payment failed'))
         ORDER BY u.created_at DESC LIMIT 500`,
        [status],
      );
      return {
        upgrades: rows.map((r) => ({
          id: r.upgrade_id,
          orgId: r.org_id,
          orgName: r.org_name,
          product: r.product,
          plan: r.plan_id,
          frequency: r.frequency,
          method: r.method,
          invoice: toInvoice(r),
          requestedAt: r.requested_at,
        })),
      };
    },
  };
}

export type UpgradeService = ReturnType<typeof upgradeService>;
