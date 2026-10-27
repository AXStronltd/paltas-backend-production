import Stripe from "stripe";
import { createHash } from "node:crypto";
import type { AppContext } from "../../../context.js";
import { fail } from "../../../http/errors.js";
import { financeTransaction } from "../../../products/property/shared/finance-transaction.js";
import { recordAudit, SYSTEM } from "../../audit/audit.service.js";
import {
  RENT_APPLICATION,
  rentMetadata,
  validateRentStripeConfig,
  verifiedRentStripe,
  rentEventContext,
} from "./stripe-isolation.js";
import type { RentAttempt } from "./attempts.service.js";

/** Internal signed event verification/inbox. Not publicly registered until clearing-ledger posting is complete.
 * A verified provider success is retained for posting/reconciliation; this module never invents bank cash or receipts.
 */
export function rentCollectionEvents(ctx: AppContext) {
  return {
    async receive(raw: Buffer, signature: string | undefined) {
      const rent = ctx.config.stripeRent,
        stripeConfig = ctx.config.stripe;
      if (!rent?.webhookSecret || !stripeConfig) throw fail.conflict("Rent collection webhooks are not configured");
      // Disabling new collections must not discard confirmations or returns for money already initiated.
      // This signed-event boundary retrieves provider objects only; it cannot initiate a payment.
      const eventSettings = { ...rent, enabled: true, liveApproved: true };
      const mode = validateRentStripeConfig(stripeConfig, eventSettings, ctx.config.signup.appBaseUrl);
      if (mode === "disabled") throw fail.conflict("Automatic rent collection is not activated");
      const local =
        ctx.rentStripeClient ?? new Stripe(stripeConfig.secretKey, { timeout: 15000, maxNetworkRetries: 2 });
      let event: Stripe.Event;
      try {
        event = local.webhooks.constructEvent(raw, signature ?? "", rent.webhookSecret, 300);
      } catch {
        throw fail.invalid("Invalid rent collection webhook signature");
      }
      if (!event.account || event.livemode !== (mode === "live"))
        throw fail.invalid("Connected-account rent event environment does not match");
      if (
        ![
          "payment_intent.processing",
          "payment_intent.succeeded",
          "payment_intent.payment_failed",
          "payment_intent.canceled",
        ].includes(event.type)
      )
        return { received: true as const, result: "Ignored — not a rent payment-intent observation" };
      const envelope = event.data?.object as Stripe.PaymentIntent;
      if (
        !envelope ||
        typeof envelope.id !== "string" ||
        !Number.isSafeInteger(event.created) ||
        !/^evt_[A-Za-z0-9_]+$/.test(event.id)
      )
        throw fail.invalid("Malformed rent payment event");
      if (envelope.metadata?.paltasApplication !== RENT_APPLICATION)
        return { received: true as const, result: "Ignored — unrelated connected-account payment" };
      const a = await ctx.db.row<RentAttempt & { verified_success_at: string | null }>(
        "SELECT * FROM rent_collection_attempts WHERE id=$1 AND org_id=$2",
        [envelope.metadata.paltasObligationId ?? "", envelope.metadata.paltasOrgId ?? ""],
      );
      if (
        !a ||
        !rentEventContext(event, { accountId: a.connected_account_id, mode: a.mode }) ||
        a.platform_account_id !== stripeConfig.accountId ||
        a.mode !== mode
      )
        throw fail.invalid("Unknown rent collection event context");
      if (!a.provider_session_id || !/^pi_[A-Za-z0-9]+$/.test(envelope.id))
        throw fail.conflict("The retained checkout must be reconciled before this event is processed");
      const expected = rentMetadata({
        orgId: a.org_id,
        obligationId: a.id,
        invoiceId: a.invoice_id,
        merchantAccountId: a.connected_account_id,
        platformAccountId: a.platform_account_id,
        mode: a.mode,
      });
      if (Object.entries(expected).some(([k, v]) => envelope.metadata[k] !== v))
        throw fail.invalid("Rent event metadata does not match its retained attempt");
      const payloadHash = createHash("sha256").update(raw).digest("hex");
      const existing = await ctx.db.row<{
        attempt_id: string;
        org_id: string;
        connected_account_id: string;
        payload_sha256: string;
      }>(
        "SELECT attempt_id,org_id,connected_account_id,payload_sha256 FROM rent_collection_provider_events WHERE id=$1",
        [event.id],
      );
      if (existing) {
        if (
          existing.attempt_id !== a.id ||
          existing.org_id !== a.org_id ||
          existing.connected_account_id !== event.account ||
          existing.payload_sha256 !== payloadHash
        )
          throw fail.invalid("Conflicting provider event identity");
        return { received: true as const, result: "Duplicate — retained rent event" };
      }
      const verified = await verifiedRentStripe(
        stripeConfig,
        eventSettings,
        ctx.config.signup.appBaseUrl,
        ctx.rentStripeClient,
      );
      let intent: Stripe.PaymentIntent, session: Stripe.Checkout.Session;
      try {
        [intent, session] = await Promise.all([
          verified.stripe.paymentIntents.retrieve(envelope.id, {}, { stripeAccount: a.connected_account_id }),
          verified.stripe.checkout.sessions.retrieve(
            a.provider_session_id,
            {},
            { stripeAccount: a.connected_account_id },
          ),
        ]);
      } catch {
        throw fail.conflict("Stripe payment status could not be independently verified; retry this event safely");
      }
      const intentOf = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (
        intent.id !== envelope.id ||
        intent.id !== intentOf ||
        session.id !== a.provider_session_id ||
        session.mode !== "payment" ||
        session.client_reference_id !== a.id ||
        session.livemode !== (a.mode === "live") ||
        intent.livemode !== (a.mode === "live") ||
        intent.amount !== a.amount_minor ||
        intent.currency.toUpperCase() !== a.currency ||
        session.amount_total !== a.amount_minor ||
        session.currency?.toUpperCase() !== a.currency ||
        (a.provider_intent_id && a.provider_intent_id !== intent.id) ||
        Object.entries(expected).some(([k, v]) => intent.metadata[k] !== v || session.metadata?.[k] !== v)
      )
        throw fail.invalid("Verified Stripe objects do not match the original rent collection");
      if (intent.status === "succeeded" && intent.amount_received !== a.amount_minor)
        throw fail.invalid("Verified received amount does not match the collection");
      return financeTransaction(ctx.db, a.org_id, async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtextextended('rent-event:'||$1,0))", [event.id]);
        const duplicate = await t.row<{
          attempt_id: string;
          org_id: string;
          connected_account_id: string;
          payload_sha256: string;
        }>(
          "SELECT attempt_id,org_id,connected_account_id,payload_sha256 FROM rent_collection_provider_events WHERE id=$1",
          [event.id],
        );
        if (duplicate) {
          if (
            duplicate.attempt_id !== a.id ||
            duplicate.org_id !== a.org_id ||
            duplicate.connected_account_id !== event.account ||
            duplicate.payload_sha256 !== payloadHash
          )
            throw fail.invalid("Conflicting provider event identity");
          return { received: true as const, result: "Duplicate — retained rent event" };
        }
        const current = await t.row<RentAttempt & { verified_success_at: string | null }>(
          "SELECT * FROM rent_collection_attempts WHERE id=$1 FOR UPDATE",
          [a.id],
        );
        if (!current) throw fail.conflict("Collection attempt is no longer available");
        const confirmed = intent.status === "succeeded",
          previouslyConfirmed = !!current.verified_success_at;
        let status: RentAttempt["status"];
        // Never downgrade confirmed money when an older processing event arrives. Returns require a reviewed reversal.
        if (confirmed) status = current.payment_id ? "succeeded" : "review";
        else if (previouslyConfirmed)
          status = ["processing", "requires_action", "requires_confirmation"].includes(intent.status)
            ? current.status
            : "review";
        else if (intent.status === "processing") status = "processing";
        else if (intent.status === "canceled" && session.status === "expired") status = "cancelled";
        else if (intent.status === "requires_payment_method" || intent.status === "requires_action")
          status = "submitted";
        else status = "review";
        const result = confirmed
          ? current.payment_id
            ? "Verified success already posted"
            : "Verified success retained — accounting and settlement review required"
          : previouslyConfirmed
            ? "Confirmed collection requires review; no silent reversal"
            : "Verified provider state: " + intent.status;
        await t.run(
          "UPDATE rent_collection_attempts SET status=$2,provider_intent_id=$3,last_provider_state=CASE WHEN verified_success_at IS NOT NULL AND $4 IN ('processing','requires_action','requires_confirmation') THEN last_provider_state ELSE $4 END,verified_success_at=CASE WHEN $5 THEN COALESCE(verified_success_at,now()) ELSE verified_success_at END,clearing_state=CASE WHEN verified_success_at IS NOT NULL AND NOT $5 AND $4 NOT IN ('processing','requires_action','requires_confirmation') THEN 'disputed' ELSE clearing_state END,updated_at=now() WHERE id=$1",
          [a.id, status, intent.id, intent.status, confirmed],
        );
        await t.run(
          "INSERT INTO rent_collection_provider_events(id,attempt_id,org_id,connected_account_id,event_type,provider_created,payload_sha256,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [event.id, a.id, a.org_id, a.connected_account_id, event.type, event.created, payloadHash, result],
        );
        if (status !== current.status)
          await t.run(
            "INSERT INTO rent_collection_attempt_events(attempt_id,org_id,from_status,to_status,reason) VALUES($1,$2,$3,$4,$5)",
            [a.id, a.org_id, current.status, status, result],
          );
        await recordAudit(t, {
          actor: SYSTEM,
          orgId: a.org_id,
          action: "Stripe rent observation verified",
          target: a.id,
          detail: result,
        });
        return { received: true as const, result };
      });
    },
  };
}
