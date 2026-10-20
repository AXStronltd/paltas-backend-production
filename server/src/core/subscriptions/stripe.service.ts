/* Optional hosted subscription collection. All money still passes through PALTAS billing receipts.
 * A browser redirect never activates access. Stripe prices must exactly match an approved PALTAS invoice.
 */
import Stripe from "stripe";
import { STRIPE_CANCELLATION_REASON } from "./stripe.constants.js";
import type { Product } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../db/database.js";
import { insertInvoice } from "./billing.service.js";
import type { PaymentsService } from "../payments/payments.service.js";

interface Checkout {
  id: string;
  org_id: string;
  product: Product;
  plan_id: string;
  invoice_id: string;
  price_id: string;
  amount_minor: number;
  currency: string;
  frequency: "monthly" | "quarterly" | "yearly";
  session_id: string | null;
  checkout_url: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  status: string;
}
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id);
const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
export function stripeService(ctx: AppContext, payments: PaymentsService, supplied?: Stripe) {
  const settings = ctx.config.stripe ?? { enabled: false, secretKey: "", webhookSecret: "", prices: [] };
  const client = () => {
    if (!settings?.enabled)
      throw fail.conflict("Card subscriptions are not connected yet. Use bank transfer or contact PALTAS.");
    if (!settings.accountId) throw fail.conflict("PALTAS billing account is not configured. Contact PALTAS.");
    return supplied ?? new Stripe(settings.secretKey, { timeout: 15000, maxNetworkRetries: 2 });
  };
  const verifyAccount = async (stripe: Stripe) => {
    const account = await stripe.accounts.retrieve(null);
    if (account.id !== settings.accountId)
      throw fail.conflict("PALTAS billing account verification failed. Contact PALTAS.");
  };
  return {
    async checkout(orgId: string, product: Product, invoiceId: string) {
      const stripe = client();
      await verifyAccount(stripe);
      const invoice = await ctx.db.row<{
        id: string;
        plan_id: string;
        total_minor: number;
        currency: string;
        frequency: Checkout["frequency"];
        tax_minor: number;
        discount_minor: number;
        status: string;
      }>(
        `SELECT i.*,p.plan_id,c.frequency FROM billing_invoices i JOIN billing_purchases p ON p.invoice_id=i.id
         JOIN catalogue_plans c ON c.id=p.plan_id WHERE i.id=$1 AND i.org_id=$2 AND i.product=$3 AND p.kind='plan'`,
        [invoiceId, orgId, product],
      );
      if (!invoice) throw fail.notFound("Plan invoice not found");
      if (!["Open", "Payment failed"].includes(invoice.status))
        throw fail.conflict("This invoice is no longer awaiting payment");
      const mapping = settings.prices.find((p) => p.planId === invoice.plan_id && p.currency === invoice.currency);
      if (!mapping)
        throw fail.conflict(
          "Card checkout is not configured for this plan and currency. Contact PALTAS or use bank transfer.",
        );
      if (invoice.tax_minor || invoice.discount_minor)
        throw fail.conflict("This invoice needs assisted billing because it has tax or negotiated adjustments");
      const price = await stripe.prices.retrieve(mapping.priceId);
      const interval = invoice.frequency === "yearly" ? "year" : "month",
        count = invoice.frequency === "quarterly" ? 3 : 1;
      if (
        price.livemode !== /^(sk|rk)_live_/.test(settings.secretKey) ||
        !price.active ||
        price.currency.toUpperCase() !== invoice.currency ||
        price.unit_amount !== invoice.total_minor ||
        price.recurring?.interval !== interval ||
        price.recurring?.interval_count !== count ||
        price.billing_scheme !== "per_unit" ||
        price.recurring?.usage_type !== "licensed" ||
        invoice.total_minor <= 0
      )
        throw fail.conflict("The Stripe price does not match the approved PALTAS plan invoice");
      const row = await ctx.db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", [`stripe:${orgId}:${product}`]);
        const open = await t.row<Checkout>(
          "SELECT * FROM stripe_checkouts WHERE org_id=$1 AND product=$2 AND status NOT IN ('canceled','incomplete_expired','expired') FOR UPDATE",
          [orgId, product],
        );
        if (open) {
          if (open.invoice_id !== invoiceId) throw fail.conflict("A card subscription already exists for this product");
          return open;
        }
        const inserted = await t.row<Checkout>(
          `INSERT INTO stripe_checkouts(id,org_id,product,plan_id,invoice_id,price_id,amount_minor,currency,frequency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            newId("sc"),
            orgId,
            product,
            invoice.plan_id,
            invoiceId,
            mapping.priceId,
            invoice.total_minor,
            invoice.currency,
            invoice.frequency,
          ],
        );
        if (!inserted) throw new Error("Checkout record was not created");
        return inserted;
      });
      if (!["pending", "open"].includes(row.status))
        throw fail.conflict("This product already has a card subscription");
      if (row.price_id !== mapping.priceId || row.amount_minor !== invoice.total_minor)
        throw fail.conflict("The invoice changed. Contact PALTAS before retrying checkout");
      if (row.session_id) {
        const session = await stripe.checkout.sessions.retrieve(row.session_id);
        if (session.status !== "open" || !session.url)
          throw fail.conflict(
            "This checkout has completed or expired. Contact PALTAS before creating another subscription",
          );
        return { url: session.url, sessionId: session.id, testMode: !session.livemode };
      }
      const base = ctx.config.signup.appBaseUrl;
      const metadata = {
        paltasCheckoutId: row.id,
        paltasApplication: "paltas",
        paltasAccountId: settings.accountId ?? "",
        paltasMode: /^(sk|rk)_live_/.test(settings.secretKey) ? "live" : "test",
      };
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          line_items: [{ price: row.price_id, quantity: 1 }],
          client_reference_id: row.id,
          metadata,
          subscription_data: { metadata },
          success_url: base + "/account.html?billing=processing#account",
          cancel_url: base + "/account.html?billing=cancelled#account",
          billing_address_collection: "required",
          allow_promotion_codes: false,
        },
        { idempotencyKey: "paltas-checkout-" + row.id },
      );
      if (!session.url || new URL(session.url).hostname !== "checkout.stripe.com")
        throw fail.conflict("Stripe could not open a hosted checkout");
      await ctx.db.run(
        "UPDATE stripe_checkouts SET session_id=$2,checkout_url=$3,status=CASE WHEN status='pending' THEN 'open' ELSE status END WHERE id=$1",
        [row.id, session.id, session.url],
      );

      return { url: session.url, sessionId: session.id, testMode: !session.livemode };
    },
    async portal(orgId: string, product: Product, action: "manage" | "cancel" = "manage") {
      const stripe = client();
      await verifyAccount(stripe);
      if (!settings.portalConfigurationId)
        throw fail.conflict("Online billing management is not connected yet. Contact PALTAS.");
      const row = await ctx.db.row<Checkout>(
        "SELECT * FROM stripe_checkouts WHERE org_id=$1 AND product=$2 AND stripe_customer_id IS NOT NULL AND stripe_subscription_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [orgId, product],
      );
      if (!row?.stripe_customer_id || !row.stripe_subscription_id)
        throw fail.notFound("No card subscription found for this workspace");
      if (
        await ctx.db.row("SELECT 1 FROM stripe_checkouts WHERE stripe_customer_id=$1 AND org_id<>$2", [
          row.stripe_customer_id,
          orgId,
        ])
      )
        throw fail.conflict("Billing customer verification failed. Contact PALTAS.");
      const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      if (
        sub.livemode !== /^(sk|rk)_live_/.test(settings.secretKey) ||
        sub.id !== row.stripe_subscription_id ||
        idOf(sub.customer) !== row.stripe_customer_id ||
        sub.metadata.paltasCheckoutId !== row.id ||
        sub.metadata.paltasApplication !== "paltas" ||
        sub.metadata.paltasAccountId !== settings.accountId ||
        sub.metadata.paltasMode !== (/^(sk|rk)_live_/.test(settings.secretKey) ? "live" : "test")
      )
        throw fail.conflict("Billing subscription verification failed. Contact PALTAS.");
      const config = await stripe.billingPortal.configurations.retrieve(settings.portalConfigurationId);
      if (
        !config.active ||
        config.livemode !== /^(sk|rk)_live_/.test(settings.secretKey) ||
        config.metadata?.paltasAccountId !== settings.accountId ||
        config.metadata?.paltasApplication !== "paltas" ||
        config.features.subscription_update.enabled ||
        !config.features.subscription_cancel.enabled ||
        config.features.subscription_cancel.mode !== "at_period_end"
      )
        throw fail.conflict("Billing management settings need PALTAS review before you continue.");
      const base = ctx.config.signup.appBaseUrl;
      const returnUrl = base + "/account.html?org=" + encodeURIComponent(orgId) + "&product=" + product + "#upgrade";
      const session = await stripe.billingPortal.sessions.create({
        customer: row.stripe_customer_id,
        configuration: settings.portalConfigurationId,
        return_url: returnUrl,
        ...(action === "cancel" &&
        ["active", "trialing", "past_due"].includes(sub.status) &&
        !sub.cancel_at_period_end &&
        sub.cancel_at == null
          ? {
              flow_data: {
                type: "subscription_cancel" as const,
                subscription_cancel: { subscription: row.stripe_subscription_id },
                after_completion: { type: "redirect" as const, redirect: { return_url: returnUrl } },
              },
            }
          : {}),
      });
      const url = new URL(session.url);
      if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com" || url.username || url.password)
        throw fail.conflict("We could not open secure billing management. Contact PALTAS.");
      return { url: session.url, testMode: !/^(sk|rk)_live_/.test(settings.secretKey) };
    },
    async webhook(raw: Buffer, signature: string | undefined) {
      const stripe = client();
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, signature ?? "", settings.webhookSecret, 300);
      } catch {
        throw fail.invalid("Invalid Stripe signature");
      }
      if (event.account) throw fail.invalid("Connected-account events are not accepted by PALTAS billing");
      if (event.livemode !== /^(sk|rk)_live_/.test(settings.secretKey))
        throw fail.invalid("Stripe event mode does not match this environment");
      const assertMetadata = (metadata: Stripe.Metadata | null) => {
        if (
          metadata?.paltasApplication !== "paltas" ||
          metadata.paltasAccountId !== settings.accountId ||
          metadata.paltasMode !== (event.livemode ? "live" : "test")
        )
          throw fail.invalid("Stripe object does not belong to this PALTAS billing environment");
      };
      await verifyAccount(stripe);
      return ctx.db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["stripe-event:" + event.id]);
        const seen = await t.row<{ result: string }>("SELECT result FROM stripe_events WHERE id=$1", [event.id]);
        if (seen) return { received: true as const, result: "Duplicate — " + seen.result };
        const save = async (result: string) => {
          await t.run("INSERT INTO stripe_events(id,type,result) VALUES($1,$2,$3)", [event.id, event.type, result]);
          return { received: true as const, result };
        };
        if (event.type === "checkout.session.completed") {
          const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
          assertMetadata(session.metadata);
          const key = session.metadata?.paltasCheckoutId;
          const row = await t.row<Checkout>("SELECT * FROM stripe_checkouts WHERE id=$1 FOR UPDATE", [key ?? ""]);
          if (
            !row ||
            session.client_reference_id !== row.id ||
            session.mode !== "subscription" ||
            (row.session_id && row.session_id !== session.id)
          )
            throw fail.invalid("Unknown Stripe checkout");
          const sub = idOf(session.subscription),
            customer = idOf(session.customer);
          if (!sub || !customer) throw fail.invalid("Stripe checkout has no subscription or customer");
          await t.run(
            "UPDATE stripe_checkouts SET session_id=$2,stripe_subscription_id=$3,stripe_customer_id=$4 WHERE id=$1",
            [row.id, session.id, sub, customer],
          );
          return save("Checkout recorded — awaiting verified invoice payment");
        }
        if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
          const invoice = await stripe.invoices.retrieve(event.data.object.id, { expand: ["payments"] });
          const subId = idOf(invoice.parent?.subscription_details?.subscription);
          if (!subId) return save("Ignored — not a subscription invoice");
          const subscription = await stripe.subscriptions.retrieve(subId);
          assertMetadata(subscription.metadata);
          const row = await t.row<Checkout>("SELECT * FROM stripe_checkouts WHERE id=$1 FOR UPDATE", [
            subscription.metadata.paltasCheckoutId ?? "",
          ]);
          if (!row) return save("Ignored — not a PALTAS subscription");
          if (
            await t.row(
              "SELECT 1 FROM stripe_checkouts WHERE org_id=$1 AND product=$2 AND id<>$3 AND status NOT IN ('canceled','incomplete_expired','expired')",
              [row.org_id, row.product, row.id],
            )
          )
            throw fail.conflict("Payment targets a superseded subscription — reconcile before applying");

          if (
            (row.stripe_customer_id && row.stripe_customer_id !== idOf(subscription.customer)) ||
            idOf(invoice.customer) !== idOf(subscription.customer) ||
            (row.stripe_subscription_id && row.stripe_subscription_id !== subId)
          )
            throw fail.invalid("Stripe subscription identity mismatch");
          const line = invoice.lines.data[0],
            amount = invoice.amount_due,
            currency = invoice.currency.toUpperCase();
          const expectedPrice = line?.pricing?.price_details?.price;
          if (
            invoice.lines.has_more ||
            invoice.lines.data.length !== 1 ||
            line?.quantity !== 1 ||
            idOf(expectedPrice) !== row.price_id ||
            amount !== row.amount_minor ||
            currency !== row.currency ||
            invoice.total !== row.amount_minor
          )
            throw fail.conflict(
              "Stripe invoice needs reconciliation — price, quantity, tax, discount or currency differs",
            );
          let link = await t.row<{ invoice_id: string }>(
            "SELECT invoice_id FROM stripe_invoice_links WHERE stripe_invoice_id=$1",
            [invoice.id],
          );
          if (!link) {
            let target = row.invoice_id;
            if (invoice.billing_reason !== "subscription_create") {
              if (invoice.billing_reason !== "subscription_cycle")
                throw fail.conflict("Subscription changes need PALTAS approval before collection");
              target = await renewalInvoice(t, row, line.period.start, line.period.end, ctx.clock.today());
            }
            await t.run("INSERT INTO stripe_invoice_links(stripe_invoice_id,checkout_id,invoice_id) VALUES($1,$2,$3)", [
              invoice.id,
              row.id,
              target,
            ]);
            link = { invoice_id: target };
          }
          const paid = event.type === "invoice.paid";
          if (paid) {
            const paidItems = invoice.payments?.data.filter((p) => p.status === "paid") ?? [];
            if (invoice.payments?.has_more || paidItems.length !== 1 || paidItems[0]?.payment.type !== "payment_intent")
              throw fail.conflict("Invoice has no single verified Stripe payment");
            const intentId = idOf(paidItems[0].payment.payment_intent);
            if (!intentId) throw fail.conflict("Invoice payment has no PaymentIntent");
            const intent = await stripe.paymentIntents.retrieve(intentId);
            if (
              intent.status !== "succeeded" ||
              intent.amount_received !== row.amount_minor ||
              intent.currency.toUpperCase() !== row.currency ||
              idOf(intent.customer) !== idOf(subscription.customer)
            )
              throw fail.conflict("Stripe payment does not match the subscription invoice");
          }

          if (paid && (invoice.status !== "paid" || invoice.amount_paid !== row.amount_minor))
            throw fail.conflict("Stripe invoice is not fully paid");
          const result = await payments.receive(
            "stripe",
            {
              id: invoice.id + (paid ? ":paid" : ":failed"),
              type: "subscription.payment",
              status: paid ? "succeeded" : "failed",
              amountMinor: paid ? invoice.amount_paid : amount,
              currency,
              invoiceId: link.invoice_id,
              ref: invoice.id,
            },
            {},
            t,
          );
          if (
            paid &&
            !result.result.startsWith("Applied") &&
            !result.result.startsWith("Ignored — invoice already paid")
          )
            throw fail.conflict(result.result);
          await t.run(
            "UPDATE stripe_checkouts SET stripe_subscription_id=$2,stripe_customer_id=$3,status=$4 WHERE id=$1",
            [row.id, subId, idOf(subscription.customer), subscription.status],
          );
          // Never grant access from Checkout success or a subscription.created event. Paid invoice is the authority.
          if (["canceled", "unpaid", "incomplete_expired", "paused"].includes(subscription.status))
            await t.run("UPDATE subscriptions SET status='expired' WHERE org_id=$1 AND product=$2", [
              row.org_id,
              row.product,
            ]);
          if (paid && subscription.status === "active" && date(line.period.end) >= ctx.clock.today())
            await t.run("UPDATE subscriptions SET status='active' WHERE org_id=$1 AND product=$2", [
              row.org_id,
              row.product,
            ]);
          return save(result.result);
        }
        if (
          event.type === "customer.subscription.created" ||
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted"
        ) {
          const sub = await stripe.subscriptions.retrieve(event.data.object.id);
          assertMetadata(sub.metadata);
          const row = await t.row<Checkout>("SELECT * FROM stripe_checkouts WHERE id=$1 FOR UPDATE", [
            sub.metadata.paltasCheckoutId ?? "",
          ]);
          if (!row) return save("Ignored — not a PALTAS subscription");
          if (row.stripe_subscription_id && row.stripe_subscription_id !== sub.id)
            throw fail.invalid("Stripe subscription identity mismatch");
          await t.run(
            "UPDATE stripe_checkouts SET stripe_subscription_id=$2,stripe_customer_id=$3,status=$4 WHERE id=$1",
            [row.id, sub.id, idOf(sub.customer), sub.status],
          );
          const superseded = await t.row(
            "SELECT 1 FROM stripe_checkouts WHERE org_id=$1 AND product=$2 AND id<>$3 AND status NOT IN ('canceled','incomplete_expired','expired')",
            [row.org_id, row.product, row.id],
          );
          if (!superseded) {
            const reason = STRIPE_CANCELLATION_REASON;
            if (
              (sub.cancel_at_period_end || sub.cancel_at != null) &&
              ["active", "trialing", "past_due"].includes(sub.status)
            ) {
              const end = sub.cancel_at ?? sub.items.data[0]?.current_period_end;
              if (!end) throw fail.conflict("Stripe cancellation date needs reconciliation");
              await t.run(
                "UPDATE subscription_pending SET effective=$4 WHERE org_id=$1 AND product=$2 AND type='cancel' AND reason=$3",
                [row.org_id, row.product, reason, date(end)],
              );
              await t.run(
                "INSERT INTO subscription_pending(id,org_id,product,type,effective,reason) SELECT $1,$2,$3,'cancel',$4,$5 WHERE NOT EXISTS(SELECT 1 FROM subscription_pending WHERE org_id=$2 AND product=$3 AND type='cancel' AND reason=$5)",
                [newId("pen"), row.org_id, row.product, date(end), reason],
              );
            } else {
              await t.run(
                "DELETE FROM subscription_pending WHERE org_id=$1 AND product=$2 AND type='cancel' AND reason=$3",
                [row.org_id, row.product, reason],
              );
            }
          }
          if (["canceled", "unpaid", "incomplete_expired", "paused"].includes(sub.status))
            await t.run(
              "UPDATE subscriptions SET status='expired' WHERE org_id=$1 AND product=$2 AND NOT EXISTS(SELECT 1 FROM stripe_checkouts WHERE org_id=$1 AND product=$2 AND id<>$3 AND status IN ('active','trialing'))",
              [row.org_id, row.product, row.id],
            );
          return save("Subscription lifecycle recorded; no payment granted");
        }
        return save("Ignored — unsupported event");
      });
    },
  };
}
async function renewalInvoice(t: Db, row: Checkout, from: number, to: number, today: string) {
  const amount = row.amount_minor;
  const invoice = await insertInvoice(t, {
    orgId: row.org_id,
    product: row.product,
    from: date(from),
    to: date(to - 1),
    issued: today,
    note: "Stripe recurring subscription",
    charge: {
      currency: row.currency,
      lines: [{ kind: "plan", what: row.plan_id, amountMinor: amount }],
      grossMinor: amount,
      discountMinor: 0,
      netMinor: amount,
      taxPct: 0,
      taxMinor: 0,
      totalMinor: amount,
    },
  });
  return invoice.id;
}
