import type Stripe from "stripe";
import type { AppContext } from "../../../context.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { recordAudit } from "../../audit/audit.service.js";
import type { PortalScope } from "../../../products/property/shared/access.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
import { invoiceRow, balanceOf } from "../../../products/property/shared/records.js";
import { rentMetadata, validateRentStripeConfig } from "./stripe-isolation.js";
import { RENT_METHODS, type RentMethod } from "./payment-methods.js";

export interface RentAttempt {
  id: string;
  org_id: string;
  invoice_id: string;
  tenant_id: string;
  property_id: string;
  merchant_id: string;
  platform_account_id: string;
  connected_account_id: string;
  mode: "test" | "live";
  method: RentMethod;
  currency: string;
  amount_minor: number;
  request_key: string;
  status: "reserved" | "submitted" | "processing" | "succeeded" | "failed" | "cancelled" | "review";
  provider_session_id: string | null;
  provider_intent_id: string | null;
  payment_id: string | null;
  created_at: string;
}

/** Internal collection lifecycle. No public endpoint or provider execution is registered by this module.
 * Reservations cannot create receipts, alter invoice balances or post to bank accounts.
 */
export function rentAttemptService(ctx: AppContext) {
  const db = ctx.db;
  const enabledMode = () => {
    const rent = ctx.config.stripeRent;
    if (!rent?.enabled) throw fail.conflict("Automatic rent collection is not activated");
    const mode = validateRentStripeConfig(ctx.config.stripe, rent, ctx.config.signup.appBaseUrl);
    if (mode === "disabled") throw fail.conflict("Automatic rent collection is not activated");
    return mode;
  };
  const find = async (s: PortalScope, id: string) => {
    const a = await db.row<RentAttempt>(
      "SELECT * FROM rent_collection_attempts WHERE id=$1 AND org_id=$2 AND tenant_id=$3",
      [id, s.orgId, s.contact.id],
    );
    if (!a) throw fail.notFound("Collection attempt not found");
    if (s.propertyIds && !s.propertyIds.includes(a.property_id)) throw fail.notFound("Collection attempt not found");
    return a;
  };
  const metadata = (a: RentAttempt) =>
    rentMetadata({
      orgId: a.org_id,
      obligationId: a.id,
      invoiceId: a.invoice_id,
      merchantAccountId: a.connected_account_id,
      mode: a.mode,
      platformAccountId: a.platform_account_id,
    });
  return {
    metadata,
    async reserve(
      s: PortalScope,
      input: { invoiceId: string; amountMinor: number; method: RentMethod; requestKey: string },
    ) {
      const mode = enabledMode();
      if (!RENT_METHODS.includes(input.method)) throw fail.invalid("Choose a supported collection method");
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
        throw fail.invalid("Choose a positive collection amount in whole currency minor units");
      if (!/^[A-Za-z0-9:_-]{8,120}$/.test(input.requestKey))
        throw fail.invalid("A valid collection request identifier is required");
      return financeTransaction(db, s.orgId, async (t) => {
        const prior = await t.row<RentAttempt>(
          "SELECT * FROM rent_collection_attempts WHERE org_id=$1 AND request_key=$2 FOR UPDATE",
          [s.orgId, input.requestKey],
        );
        if (prior) {
          if (
            prior.tenant_id !== s.contact.id ||
            prior.invoice_id !== input.invoiceId ||
            prior.amount_minor !== input.amountMinor ||
            prior.method !== input.method ||
            prior.mode !== mode ||
            prior.platform_account_id !== ctx.config.stripe?.accountId ||
            prior.currency !== s.entitlement.org.currency ||
            (s.propertyIds && !s.propertyIds.includes(prior.property_id))
          )
            throw fail.conflict("This request identifier was already used for different collection details");
          return prior;
        }
        const inv = await invoiceRow(t, s.orgId, input.invoiceId);
        if (
          inv.tenant_id !== s.contact.id ||
          !inv.property_id ||
          (s.propertyIds && !s.propertyIds.includes(inv.property_id))
        )
          throw fail.notFound("Invoice not found");
        if (!inv.journal_id)
          throw fail.conflict("This invoice has not been posted. Issue and review it before collecting payment");
        if (input.amountMinor > balanceOf(inv))
          throw fail.conflict("The invoice balance changed. Refresh it before paying; no collection was started");
        const merchant = await t.row<{
          id: string;
          account_id: string | null;
          platform_account_id: string;
          mode: string;
          status: string;
          charges_enabled: boolean;
          payouts_enabled: boolean;
        }>("SELECT * FROM rent_stripe_merchants WHERE org_id=$1", [s.orgId]);
        if (
          !merchant?.account_id ||
          merchant.status !== "verified" ||
          !merchant.charges_enabled ||
          !merchant.payouts_enabled ||
          merchant.mode !== mode ||
          merchant.platform_account_id !== ctx.config.stripe?.accountId
        )
          throw fail.conflict("The company collection account is not verified for this environment");
        if (
          !(await t.row(
            "SELECT property_id FROM rent_collection_property_routes WHERE org_id=$1 AND property_id=$2 AND merchant_id=$3 AND status='active'",
            [s.orgId, inv.property_id, merchant.id],
          ))
        )
          throw fail.conflict("The company owner must authorise this property's collection account first");
        if (
          await t.row(
            "SELECT id FROM rent_collection_attempts WHERE invoice_id=$1 AND status IN ('reserved','submitted','processing','review')",
            [inv.id],
          )
        )
          throw fail.conflict(
            "A collection is already pending for this invoice. Review its status before trying again",
          );
        const a = await t.row<RentAttempt>(
          `INSERT INTO rent_collection_attempts(id,org_id,invoice_id,tenant_id,property_id,merchant_id,platform_account_id,connected_account_id,mode,method,currency,amount_minor,request_key,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [
            newId("rca"),
            s.orgId,
            inv.id,
            s.contact.id,
            inv.property_id,
            merchant.id,
            merchant.platform_account_id,
            merchant.account_id,
            mode,
            input.method,
            s.entitlement.org.currency,
            input.amountMinor,
            input.requestKey,
            s.userId,
          ],
        );
        if (!a) throw new Error("Collection reservation was not retained");
        await t.run(
          "INSERT INTO rent_collection_attempt_events(attempt_id,org_id,to_status,reason) VALUES($1,$2,'reserved','Tenant requested collection; no funds received')",
          [a.id, s.orgId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rent collection reserved",
          target: a.id,
          detail: `Invoice ${inv.number}; ${a.amount_minor} ${a.currency}; no payment posted`,
        });
        return a;
      });
    },
    async beginSubmission(s: PortalScope, id: string) {
      enabledMode();
      const a = await find(s, id);
      return financeTransaction(db, s.orgId, async (t) => {
        const current = await t.row<RentAttempt>("SELECT * FROM rent_collection_attempts WHERE id=$1 FOR UPDATE", [
          a.id,
        ]);
        if (!current || !["reserved", "submitted"].includes(current.status))
          throw fail.conflict("This collection cannot be submitted again");
        const merchant = await t.row<{ status: string; charges_enabled: boolean; payouts_enabled: boolean }>(
          "SELECT status,charges_enabled,payouts_enabled FROM rent_stripe_merchants WHERE id=$1 AND org_id=$2 AND account_id=$3 AND platform_account_id=$4 AND mode=$5",
          [current.merchant_id, s.orgId, current.connected_account_id, ctx.config.stripe?.accountId, enabledMode()],
        );
        if (!merchant || merchant.status !== "verified" || !merchant.charges_enabled || !merchant.payouts_enabled)
          throw fail.conflict("Company collection capability changed; no new provider request is authorised");
        if (
          !(await t.row(
            "SELECT property_id FROM rent_collection_property_routes WHERE org_id=$1 AND property_id=$2 AND merchant_id=$3 AND status='active'",
            [s.orgId, current.property_id, current.merchant_id],
          ))
        )
          throw fail.conflict("This property's collection authority is paused; no new provider request is authorised");
        if (ctx.clock.now().getTime() - new Date(current.created_at).getTime() > 23 * 60 * 60 * 1000) {
          await t.run("UPDATE rent_collection_attempts SET status='review',updated_at=now() WHERE id=$1", [id]);
          await t.run(
            "INSERT INTO rent_collection_attempt_events(attempt_id,org_id,from_status,to_status,reason) VALUES($1,$2,$3,'review','Provider retry window expired; reconcile before retry')",
            [id, s.orgId, current.status],
          );
          return {
            attempt: { ...current, status: "review" as const },
            submit: false as const,
            idempotencyKey: "paltas-rent-checkout-" + id,
          };
        }
        const inv = await invoiceRow(t, s.orgId, current.invoice_id);
        if (balanceOf(inv) < current.amount_minor)
          throw fail.conflict(
            "Invoice balance changed before collection. Reconcile the pending attempt before continuing",
          );
        if (current.status === "reserved") {
          await t.run("UPDATE rent_collection_attempts SET status='submitted',updated_at=now() WHERE id=$1", [id]);
          await t.run(
            "INSERT INTO rent_collection_attempt_events(attempt_id,org_id,from_status,to_status,reason) VALUES($1,$2,'reserved','submitted','Durable idempotent provider request prepared')",
            [id, s.orgId],
          );
        }
        return {
          attempt: { ...current, status: "submitted" as const },
          submit: true as const,
          idempotencyKey: "paltas-rent-checkout-" + id,
        };
      });
    },
    async attachHostedSession(s: PortalScope, id: string, session: Stripe.Checkout.Session) {
      enabledMode();
      const a = await find(s, id),
        m = metadata(a);
      if (
        session.mode !== "payment" ||
        session.livemode !== (a.mode === "live") ||
        session.amount_total !== a.amount_minor ||
        session.currency?.toUpperCase() !== a.currency ||
        Object.entries(m).some(([k, v]) => session.metadata?.[k] !== v)
      )
        throw fail.conflict("Stripe checkout does not match the authorised invoice collection");
      if (!session.url) throw fail.conflict("Stripe did not return a hosted checkout URL");
      const url = new URL(session.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password)
        throw fail.conflict("Unexpected checkout destination");
      return financeTransaction(db, s.orgId, async (t) => {
        const r = await t.row<RentAttempt>("SELECT * FROM rent_collection_attempts WHERE id=$1 FOR UPDATE", [id]);
        if (!r || r.status !== "submitted" || (r.provider_session_id && r.provider_session_id !== session.id))
          throw fail.conflict("Checkout is not the retained collection attempt");
        await t.run("UPDATE rent_collection_attempts SET provider_session_id=$2,updated_at=now() WHERE id=$1", [
          id,
          session.id,
        ]);
        return { url: url.href, status: "submitted" as const };
      });
    },
  };
}
