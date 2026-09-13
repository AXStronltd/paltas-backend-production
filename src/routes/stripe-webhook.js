/* ====================================================================== *
 * STRIPE'S SIDE OF THE CONVERSATION.
 *
 * The signature is the only thing separating a genuine "you were paid" from
 * anybody on the internet posting the same words at this endpoint. Nothing here
 * runs until it verifies.
 *
 * ── THE RAW BODY, AND WHY THIS MOUNTS EARLY ─────────────────────────────
 *
 * The signature is over the EXACT BYTES Stripe sent. `express.json()` parses
 * and discards them, and a re-serialised object will not verify — the key order
 * and the whitespace differ. So this route is registered with
 * `express.raw()` BEFORE the global JSON parser in server.js, and moving it
 * after would break every webhook with a signature error that looks like a
 * misconfigured secret.
 *
 * ── DELIVERED AT LEAST ONCE, NOT EXACTLY ONCE ───────────────────────────
 *
 * A redelivery after a timeout is normal. Without the StripeEvent table a
 * repeated `payment_intent.succeeded` records the same money twice and the
 * company's books say it was paid double — so the event id is written first,
 * and a duplicate is acknowledged and dropped.
 *
 * ── WHY IT ALWAYS ANSWERS 200 ───────────────────────────────────────────
 *
 * Once verified, the event is acknowledged even if handling it fails. A 500
 * makes Stripe retry, and retrying a handler that threw halfway is how one
 * payment becomes two rows. The failure is recorded on the event instead, where
 * it can be found and replayed deliberately.
 * ====================================================================== */

import { Router } from "express";
import express from "express";
import { db } from "../db.js";
import { processor, isConnected, wireAccount } from "../payments/stripe.js";

export const stripeWebhookRoutes = Router();

const log = {
  info: (...a) => console.log(new Date().toISOString(), "[stripe]", ...a),
  error: (...a) => console.error(new Date().toISOString(), "[stripe]", ...a),
};

stripeWebhookRoutes.post("/webhooks/stripe",
  /* The raw bytes. Never express.json() on this path. */
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!isConnected()) {
      /* Nothing is configured, so nothing can be verified. 503 rather than 400:
         the request may be perfectly good and this installation simply is not
         listening yet. */
      return res.status(503).json({ error: "unavailable", message: "No payment processor is connected." });
    }

    let event;
    try {
      event = await processor().verifyWebhook({
        rawBody: req.body,
        signature: req.get("stripe-signature"),
      });
    } catch (e) {
      /*
       * 400 and nothing else. No detail, because an unverified body is
       * attacker-controlled and echoing any of it back is how a webhook
       * endpoint becomes a reflection tool.
       */
      log.error("rejected an unverified webhook");
      return res.status(400).json({ error: "bad_request", message: "Signature verification failed." });
    }

    /*
     * CLAIMED BEFORE IT IS HANDLED.
     *
     * The insert is the lock: a redelivery racing the first attempt hits the
     * primary key and loses, so the handler runs once even with two deliveries
     * in flight at the same instant.
     */
    try {
      await db.stripeEvent.create({
        data: {
          id: String(event.id),
          type: String(event.type),
          accountId: String(event.account || ""),
        },
      });
    } catch (e) {
      /* Already seen. Acknowledge so Stripe stops retrying. */
      log.info("duplicate delivery ignored:", event.id, event.type);
      return res.json({ received: true, duplicate: true });
    }

    let error = "";
    try {
      await handle(event);
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 400);
      log.error("handler failed for", event.type, event.id, error);
    }

    try {
      await db.stripeEvent.update({
        where: { id: String(event.id) },
        data: { handled: !error, handledAt: new Date(), error },
      });
    } catch (e) { log.error("could not mark the event handled:", e && e.message); }

    /* Always 200 once verified — see the note at the top of this file. */
    res.json({ received: true });
  });

/* ---------------------------------------------------------------- *
 * WHAT EACH EVENT MEANS.
 * ---------------------------------------------------------------- */
async function handle(event) {
  const o = event.data && event.data.object;

  switch (event.type) {
    /*
     * A company's verification moved. This is the ONLY thing that may change
     * whether they can take money — PALTAS never infers it from a completed
     * form, because Stripe is the one doing the verifying.
     */
    case "account.updated":
    case "v2.core.account.updated": {
      if (!o || !o.id) return;
      const wired = wireAccount(o);
      /* STRIPE TELLS US THE ACCOUNT, NOT THE COMPANY — there is no session and no
         actor here, and `acct_...` is globally unique. The orgId is what this
         lookup resolves; it cannot also be its filter. Safe because nothing runs
         before the signature verifies. */
      const before = await db.connectedAccount.findUnique({ where: { accountId: String(o.id) } });
      if (!before) {
        log.info("account.updated for an account PALTAS does not know:", o.id);
        return;
      }
      await db.connectedAccount.update({
        where: { accountId: String(o.id) },
        data: { ...wired, lastSyncedAt: new Date() },
      });
      if (before.cardPaymentsStatus !== wired.cardPaymentsStatus) {
        log.info(`account ${o.id}: card_payments ${before.cardPaymentsStatus} -> ${wired.cardPaymentsStatus}`);
      }
      return;
    }

    /*
     * MONEY ACTUALLY ARRIVED.
     *
     * This is the only place a Payment row is written. Not the API response
     * that created the intent — that says a payment was authorised to be
     * attempted, which is a different claim, and a browser that closes
     * mid-payment would otherwise leave a Payment row for money nobody sent.
     */
    case "payment_intent.succeeded": {
      if (!o || !o.id) return;
      const orgId = (o.metadata && o.metadata.paltas_org_id) || "";
      if (!orgId) {
        log.info("a succeeded payment carried no company id:", o.id);
        return;
      }

      /* Belt and braces with the event table: the same intent must not produce
         two Payment rows even if it somehow arrives under two event ids. */
      const seen = await db.payment.findFirst({ where: { orgId, providerRef: String(o.id) } });
      if (seen) return;

      await db.payment.create({
        data: {
          orgId,
          invoiceId: (o.metadata && o.metadata.paltas_invoice_id) || null,
          /* Minor units, exactly as Stripe reports them. */
          amount: BigInt(o.amount_received ?? o.amount ?? 0),
          currency: String(o.currency || "").toUpperCase(),
          method: "CARD",
          providerRef: String(o.id),
          reference: String((o.metadata && o.metadata.paltas_reference) || ""),
          receivedAt: o.created ? new Date(o.created * 1000) : new Date(),
          receivedBy: "stripe",
        },
      });
      log.info("recorded a payment for", orgId, o.id);
      return;
    }

    /*
     * Recorded only. A failed payment is not a Payment row, and inventing a
     * voided one would put money that never existed into a company's books.
     */
    case "payment_intent.payment_failed":
      log.info("payment failed:", o && o.id, (o && o.last_payment_error && o.last_payment_error.code) || "");
      return;

    /*
     * A refund or a dispute. NOT auto-reversed here: on a direct charge the
     * money is the company's and reversing their books from a webhook, without
     * a person deciding, is how a reconciliation becomes untraceable. Logged so
     * it can be actioned.
     */
    case "charge.refunded":
    case "charge.dispute.created":
      log.info(event.type, o && o.id, "— needs a human decision, not an automatic reversal");
      return;

    default:
      /* Unhandled is fine and is recorded as handled: Stripe sends a great many
         event types and retrying the ones this service does not care about
         would be noise forever. */
      return;
  }
}
