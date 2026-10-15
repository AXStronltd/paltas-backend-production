/*
 * PALTAS subscription billing: invoices, orders (purchases) and applying payments.
 *
 * - An order (add-on, plan, allowance, product) creates an invoice and starts ONLY when that invoice is paid by a
 *   verified payment event. In BILLING_MODE=simulated (local demos only, refused in production) it starts at once
 *   and says so in its status.
 * - Amounts are integer minor units. The entitlement rules price in major units; conversion happens here.
 */
import type { BillingInvoice, Entitlement, Product } from "@paltas/contracts";
import { entitlements } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { nextNumber } from "../../db/counters.js";
import type { Db } from "../../db/database.js";
import { addDays, addMonths } from "../../lib/dates.js";
import { newId } from "../../lib/ids.js";
import { toMinor } from "../../lib/money.js";
import type { PaymentOutcome, ProductPaymentEvent } from "../../products/registry.js";
import { recordAudit, type Actor } from "../audit/audit.service.js";
import type { EntitlementContext } from "./entitlement.service.js";

export interface ChargeMinor {
  currency: string;
  lines: { kind: string; what: string; amountMinor: number; key?: string }[];
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  taxPct: number;
  taxMinor: number;
  totalMinor: number;
}

interface InvoiceRow {
  id: string;
  org_id: string;
  product: Product;
  period_from: string;
  period_to: string;
  lines: ChargeMinor["lines"];
  gross_minor: number;
  discount_minor: number;
  net_minor: number;
  tax_pct: number;
  tax_minor: number;
  total_minor: number;
  currency: string;
  status: BillingInvoice["status"];
  issued: string;
  due: string;
  attempts: number;
  paid_at: string | null;
  note: string;
}

export interface PurchaseRow {
  id: string;
  org_id: string;
  product: Product;
  kind: "addon" | "plan" | "allowance" | "product";
  module_key: string | null;
  plan_id: string | null;
  invoice_id: string | null;
  status: string;
  total_minor: number;
  currency: string;
}

export const toInvoice = (r: InvoiceRow): BillingInvoice => ({
  id: r.id,
  product: r.product,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  lines: r.lines,
  grossMinor: r.gross_minor,
  discountMinor: r.discount_minor,
  netMinor: r.net_minor,
  taxPct: r.tax_pct,
  taxMinor: r.tax_minor,
  totalMinor: r.total_minor,
  currency: r.currency,
  status: r.status,
  issued: r.issued,
  due: r.due,
  attempts: r.attempts,
  paidAt: r.paid_at,
  note: r.note,
});

export const toPurchase = (p: PurchaseRow) => ({
  id: p.id,
  product: p.product,
  kind: p.kind,
  moduleKey: p.module_key,
  planId: p.plan_id,
  invoiceId: p.invoice_id,
  status: p.status,
  totalMinor: p.total_minor,
  currency: p.currency,
});

/** The rules' monthly charge, in minor units. total = net + tax exactly. */
export function monthlyChargeMinor(en: EntitlementContext, today: string) {
  const c = entitlements.charges(en.catalogue, en.view, today);
  const m = (x: number) => toMinor(x, c.ccy);
  const netMinor = m(c.net);
  const taxMinor = m(c.tax);
  return {
    charge: {
      currency: c.ccy,
      lines: c.lines.map((l) => ({
        kind: l.kind,
        what: l.what,
        amountMinor: m(l.amount),
        ...(l.key ? { key: l.key } : {}),
      })),
      grossMinor: m(c.gross),
      discountMinor: m(c.discount),
      netMinor,
      taxPct: c.taxPct,
      taxMinor,
      totalMinor: netMinor + taxMinor,
    } satisfies ChargeMinor,
    taxNote: c.taxNote,
    missing: c.missing,
    priced: c.priced,
  };
}

/** A one-off charge (first period of an add-on, plan or allowance), with the organisation's discount and the plan's tax. */
export function oneOffCharge(
  ent: Entitlement,
  currency: string,
  what: string,
  amountMinor: number,
  taxPct?: number | null,
): ChargeMinor {
  const pct = taxPct ?? ent.plan.taxPct ?? 0;
  const discountMinor = Math.round((amountMinor * (ent.terms.discountPct || 0)) / 100);
  const netMinor = amountMinor - discountMinor;
  const taxMinor = Math.round((netMinor * pct) / 100);
  return {
    currency,
    lines: [{ kind: "oneoff", what, amountMinor }],
    grossMinor: amountMinor,
    discountMinor,
    netMinor,
    taxPct: pct,
    taxMinor,
    totalMinor: netMinor + taxMinor,
  };
}

export async function insertInvoice(
  t: Db,
  input: {
    orgId: string;
    product: Product;
    from: string;
    to: string;
    charge: ChargeMinor;
    issued: string;
    note: string;
  },
): Promise<BillingInvoice> {
  const id = await nextNumber(t, "platform", "SUB");
  const c = input.charge;
  const row = await t.row<InvoiceRow>(
    `INSERT INTO billing_invoices (id, org_id, product, period_from, period_to, lines, gross_minor, discount_minor,
       net_minor, tax_pct, tax_minor, total_minor, currency, status, issued, due, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Open',$14,$15,$16) RETURNING *`,
    [
      id,
      input.orgId,
      input.product,
      input.from,
      input.to,
      JSON.stringify(c.lines),
      c.grossMinor,
      c.discountMinor,
      c.netMinor,
      c.taxPct,
      c.taxMinor,
      c.totalMinor,
      c.currency,
      input.issued,
      addDays(input.from, 7),
      input.note,
    ],
  );
  return toInvoice(row as InvoiceRow);
}

export function billingService(ctx: AppContext) {
  const { config, clock } = ctx;

  /** Turn on what a paid (or simulated) order bought. */
  async function activate(t: Db, p: PurchaseRow): Promise<void> {
    const today = clock.today();
    const k = [p.org_id, p.product];
    switch (p.kind) {
      case "product":
        await t.run(
          "UPDATE subscriptions SET plan_id = $3, status = 'active', anchor = $4, trial_ends = NULL WHERE org_id = $1 AND product = $2",
          [...k, p.plan_id, today],
        );
        break;
      case "addon":
        await t.run("DELETE FROM subscription_disabled WHERE org_id = $1 AND product = $2 AND module_key = $3", [
          ...k,
          p.module_key,
        ]);
        await t.run(
          "DELETE FROM subscription_pending WHERE org_id = $1 AND product = $2 AND type = 'cancelAddon' AND module_key = $3",
          [...k, p.module_key],
        );
        await t.run(
          "INSERT INTO subscription_addons (org_id, product, module_key, since) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [...k, p.module_key, today],
        );
        break;
      case "allowance":
        await t.run(
          "UPDATE subscriptions SET buildings_extra = buildings_extra + 1 WHERE org_id = $1 AND product = $2",
          k,
        );
        break;
      case "plan": {
        const plan = await t.row<{ modules: string[] }>("SELECT modules FROM catalogue_plans WHERE id = $1", [
          p.plan_id,
        ]);
        // add-ons the new plan includes are no longer charged separately (never charged twice)
        await t.run("DELETE FROM subscription_addons WHERE org_id = $1 AND product = $2 AND module_key = ANY($3)", [
          ...k,
          plan?.modules ?? [],
        ]);
        await t.run(
          "DELETE FROM subscription_pending WHERE org_id = $1 AND product = $2 AND type IN ('plan', 'cancel')",
          k,
        );
        await t.run(
          `UPDATE subscriptions SET plan_id = $3, status = 'active',
             anchor = CASE WHEN status = 'active' AND anchor IS NOT NULL THEN anchor ELSE $4::date END
           WHERE org_id = $1 AND product = $2`,
          [...k, p.plan_id, today],
        );
        break;
      }
    }
  }

  return {
    activate,

    /**
     * Record an order. Provider mode: an invoice is issued and the order waits for payment.
     * Simulated mode: it starts now and its status says no payment was taken.
     */
    async order(
      t: Db,
      s: { orgId: string; product: Product; actor: Actor; en: EntitlementContext },
      o: {
        kind: PurchaseRow["kind"];
        what: string;
        amountMinor: number;
        moduleKey?: string | null;
        planId?: string | null;
        taxPct?: number | null;
        note: string;
        /** Always wait for a real payment, even in BILLING_MODE=simulated (self-service upgrades). */
        requirePayment?: boolean;
      },
    ) {
      const currency = s.en.org.currency;
      const simulated = config.billingMode === "simulated" && !o.requirePayment;
      let invoice: BillingInvoice | null = null;
      let status: string;
      if (simulated) {
        status = "Simulated — local demo, no payment taken";
      } else {
        const charge = oneOffCharge(s.en.ent, currency, o.what, o.amountMinor, o.taxPct);
        const today = clock.today();
        invoice = await insertInvoice(t, {
          orgId: s.orgId,
          product: s.product,
          from: today,
          to: today,
          charge,
          issued: today,
          note: o.note,
        });
        status = "Awaiting payment — starts when the payment is confirmed";
      }
      const row = await t.row<PurchaseRow>(
        `INSERT INTO billing_purchases (id, org_id, product, kind, module_key, plan_id, invoice_id, status, total_minor, currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          newId("pur"),
          s.orgId,
          s.product,
          o.kind,
          o.moduleKey ?? null,
          o.planId ?? null,
          invoice?.id ?? null,
          status,
          invoice?.totalMinor ?? o.amountMinor,
          currency,
          s.actor.userId,
        ],
      );
      const purchase = row as PurchaseRow;
      if (simulated) await activate(t, purchase);
      return { purchase: toPurchase(purchase), invoice };
    },

    /** The regular invoice for the next period (Super Admin). Null when nothing is priced in the org's currency. */
    async issuePeriodInvoice(t: Db, en: EntitlementContext, note: string): Promise<BillingInvoice | null> {
      const today = clock.today();
      const from = en.ent.nextBilling ?? today;
      const c = monthlyChargeMinor(en, today);
      if (!c.priced) return null;
      return insertInvoice(t, {
        orgId: en.org.id,
        product: en.product,
        from,
        to: addDays(addMonths(from, 1), -1),
        charge: c.charge,
        issued: today,
        note,
      });
    },

    /**
     * Payment handler for "subscription.payment": the ONLY way a PALTAS invoice becomes paid.
     * Exact amount and currency required; anything else is held for review, never applied.
     */
    async applySubscriptionPayment(t: Db, ev: ProductPaymentEvent): Promise<PaymentOutcome> {
      const actor: Actor = ev.manual
        ? { userId: ev.recordedBy, role: "super_admin" }
        : { userId: null, role: "provider:" + ev.provider };
      const inv = ev.invoiceId
        ? await t.row<InvoiceRow>("SELECT * FROM billing_invoices WHERE id = $1 FOR UPDATE", [ev.invoiceId])
        : null;
      let result: string;
      if (!inv) result = "Rejected — unknown invoice";
      else if (inv.status === "Paid") result = "Ignored — invoice already paid";
      else if (inv.status === "Void") result = "Ignored — invoice void";
      else if (ev.status === "failed") result = "Payment failed — invoice stays unpaid";
      else if (ev.status !== "succeeded") result = "Ignored — status " + ev.status;
      else if (ev.amountMinor !== inv.total_minor || ev.currency !== inv.currency)
        result = "Held for review — amount or currency does not match the invoice";
      else result = "Applied — invoice paid";
      const out: PaymentOutcome = {
        result,
        orgId: inv?.org_id ?? null,
        targetId: ev.invoiceId ?? null,
        invoiceId: inv?.id ?? null,
        receiptId: null,
      };
      if (!inv) return out;

      if (result.startsWith("Payment failed")) {
        await t.run("UPDATE billing_invoices SET status = 'Payment failed', attempts = attempts + 1 WHERE id = $1", [
          inv.id,
        ]);
        await recordAudit(t, {
          actor,
          orgId: inv.org_id,
          action: "Subscription payment failed",
          target: inv.id,
          detail: ev.reason ?? "declined",
        });
      } else if (result.startsWith("Applied")) {
        await t.run("UPDATE billing_invoices SET status = 'Paid', paid_at = now(), paid_event = $2 WHERE id = $1", [
          inv.id,
          ev.eventId,
        ]);
        const receiptId = await nextNumber(t, "platform", "RCPT");
        await t.run(
          `INSERT INTO billing_receipts (id, org_id, invoice_id, event_id, amount_minor, currency, ref, manual) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [receiptId, inv.org_id, inv.id, ev.eventId, inv.total_minor, inv.currency, ev.ref ?? "", ev.manual],
        );
        for (const p of await t.rows<PurchaseRow>(
          "SELECT * FROM billing_purchases WHERE invoice_id = $1 AND status LIKE 'Awaiting payment%' FOR UPDATE",
          [inv.id],
        )) {
          await activate(t, p);
          await t.run("UPDATE billing_purchases SET status = 'Active — payment confirmed' WHERE id = $1", [p.id]);
        }
        await recordAudit(t, {
          actor,
          orgId: inv.org_id,
          action: ev.manual ? "Manual receipt recorded" : "Subscription payment confirmed",
          target: inv.id,
          detail: "ref " + (ev.ref ?? ""),
        });
        out.receiptId = receiptId;
      } else if (result.startsWith("Held")) {
        await recordAudit(t, {
          actor,
          orgId: inv.org_id,
          action: "Subscription payment held for review",
          target: inv.id,
          detail: result,
        });
      }
      return out;
    },
  };
}

export type BillingService = ReturnType<typeof billingService>;
