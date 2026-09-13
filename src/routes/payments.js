/* ====================================================================== *
 * A MEMBER COMPANY COLLECTING FROM ITS OWN CUSTOMERS.
 *
 *   connect -> Stripe verifies them -> charge -> webhook confirms
 *
 * ── WHAT THESE ROUTES ARE NOT ───────────────────────────────────────────
 *
 * They do not bill companies FOR PALTAS. Subscriptions and platform fees are a
 * different rail into PALTAS's own account, and nothing here touches them.
 *
 * ── ONE THING IS TRUE THROUGHOUT ────────────────────────────────────────
 *
 * PALTAS never decides that a company may take money. Stripe does. Every route
 * below reads `configuration.merchant.capabilities.card_payments.status` as
 * Stripe last reported it, and refuses on anything other than "active".
 *
 * Charging into an unverified account is worse than a decline: the payment
 * appears to succeed, the customer is debited, and the company discovers weeks
 * later that it cannot be paid out.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import { badRequest, conflict, forbidden, notFound, unavailable } from "../http/errors.js";
import { rateLimit } from "../http/rate-limit.js";
import { requireOrganization } from "../http/session.js";
import { config } from "../config.js";
import {
  processor, isConnected, status as payStatus, wireAccount, NotReadyToCharge,
} from "../payments/stripe.js";

export const paymentRoutes = Router();

function live() {
  if (!isConnected()) {
    throw unavailable(
      "No payment processor is connected, so companies cannot collect card " +
      "payments. Nothing else in PALTAS is affected.");
  }
  return processor();
}

/** The company's connected account row, or null. */
const accountFor = (orgId) =>
  db.connectedAccount.findUnique({ where: { orgId } });

/**
 * Only an OWNER or a MANAGER may connect a company's bank account.
 *
 * This decides where the company's money lands, so it is not something a
 * receptionist or a housekeeper should be able to do — and it is not covered by
 * any product entitlement, because it is about the company itself rather than
 * about what they bought.
 *
 * Checked against the Role enum rather than a hopeful pattern: an earlier
 * version of this matched /OWNER|ADMIN/, and there is no ADMIN role in this
 * schema — so the second half matched nothing and only the accident of OWNER
 * existing kept it working.
 */
const MAY_ADMINISTER = new Set(["OWNER", "MANAGER"]);

function mustAdminister(actor) {
  const role = String((actor && actor.role) || "").toUpperCase();
  if (!MAY_ADMINISTER.has(role)) {
    throw forbidden(
      "Only an owner or a manager can set up how this company gets paid.");
  }
}

/* ---------------------------------------------------------------- 1
 * WHERE THIS COMPANY STANDS.
 * ---------------------------------------------------------------- */
paymentRoutes.get("/payments/account",
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireOrganization(),
  async (req, res, next) => {
    try {
      const row = await accountFor(req.actor.orgId);
      res.set("Cache-Control", "no-store");
      res.json({
        /* Null rather than an invented shell: "not set up" is a real state and
           the difference matters to the screen showing it. */
        account: row ? publicAccount(row) : null,
        canCollect: Boolean(row && row.cardPaymentsStatus === "active"),
        processor: payStatus(),
      });
    } catch (e) { next(e); }
  });

/** Everything about an account that is safe for a browser. */
function publicAccount(row) {
  return {
    provider: row.provider,
    /* The acct_ id is not secret, and a company support-chatting with Stripe
       will be asked for it. */
    accountId: row.accountId,
    cardPaymentsStatus: row.cardPaymentsStatus,
    /* Said in a way somebody can act on, rather than just "pending". */
    requirementsDue: row.requirementsDue ? row.requirementsDue.split(",") : [],
    disabledReason: row.disabledReason || "",
    country: row.country,
    defaultCurrency: row.defaultCurrency,
    /* So a test account is never displayed as able to take real money. */
    livemode: row.livemode,
    lastSyncedAt: row.lastSyncedAt,
  };
}

/* ---------------------------------------------------------------- 2
 * START, OR CONTINUE, VERIFICATION.
 *
 * One route for both. A company part-way through onboarding needs a fresh link
 * rather than a second account — creating another would leave the first
 * orphaned and split their history across two.
 * ---------------------------------------------------------------- */
paymentRoutes.post("/payments/account/onboarding",
  rateLimit({ windowMs: 60_000, max: 10 }),
  requireOrganization(),
  async (req, res, next) => {
    try {
      const s = live();
      mustAdminister(req.actor);

      const org = await db.organization.findUnique({
        where: { id: req.actor.orgId },
        select: { id: true, name: true, country: true },
      });
      if (!org) throw notFound("No such company.");

      let row = await accountFor(org.id);

      if (!row) {
        const created = await s.createAccount({
          orgId: org.id,
          name: org.name,
          country: org.country,
          email: req.session && req.session.email,
        });
        const wired = wireAccount(created);
        row = await db.connectedAccount.create({
          data: { orgId: org.id, provider: "stripe", ...wired, lastSyncedAt: new Date() },
        });
      }

      /*
       * Both URLs are required by Stripe and they are not the same thing.
       * `refresh` is where the company lands if the link expired before they
       * finished — sending them to `return` would show them a success page for
       * something they did not complete.
       */
      const base = `${config.appUrl}/dashboard/settings.html`;
      const link = await s.onboardingLink({
        accountId: row.accountId,
        returnUrl: `${base}?payments=return`,
        refreshUrl: `${base}?payments=refresh`,
      });

      res.set("Cache-Control", "no-store");
      res.json({
        url: link.url,
        expiresAt: link.expiresAt,
        account: publicAccount(row),
        notice: "Stripe verifies the company directly. PALTAS does not see or " +
                "store the bank or identity details entered there.",
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 3
 * ASK STRIPE AGAIN.
 *
 * The webhook is the normal path; this is for the moment a company comes back
 * from onboarding and wants to see the result now rather than whenever the
 * delivery lands.
 * ---------------------------------------------------------------- */
paymentRoutes.post("/payments/account/refresh",
  rateLimit({ windowMs: 60_000, max: 20 }),
  requireOrganization(),
  async (req, res, next) => {
    try {
      const s = live();
      const row = await accountFor(req.actor.orgId);
      if (!row) throw notFound("This company has not started setting up payments.");

      const fresh = await s.account({ accountId: row.accountId });
      const wired = wireAccount(fresh);
      const updated = await db.connectedAccount.update({
        where: { orgId: req.actor.orgId },
        data: { ...wired, lastSyncedAt: new Date() },
      });

      res.set("Cache-Control", "no-store");
      res.json({
        account: publicAccount(updated),
        canCollect: updated.cardPaymentsStatus === "active",
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 4
 * TAKE A PAYMENT FROM THIS COMPANY'S CUSTOMER.
 *
 * A DIRECT charge on their account: they are merchant of record, the money is
 * theirs, and PALTAS's cut rides along as an application fee.
 *
 * Returns a client secret for a Payment Element. No card number reaches PALTAS.
 * ---------------------------------------------------------------- */
paymentRoutes.post("/payments/charges",
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireOrganization(),
  async (req, res, next) => {
    try {
      const s = live();
      const b = req.body || {};

      const amount = Number(b.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw badRequest("amount must be a positive whole number of minor units.");
      }
      const currency = String(b.currency || "").trim();
      if (!/^[A-Za-z]{3}$/.test(currency)) throw badRequest("currency must be an ISO 4217 code.");

      const row = await accountFor(req.actor.orgId);
      if (!row) {
        throw conflict(
          "This company has not set up payments yet, so it cannot take a card. " +
          "Nobody has been charged.");
      }

      /*
       * The fee, worked out here and never sent by the client. A caller able to
       * name PALTAS's own commission could set it to zero.
       */
      const applicationFee = platformFee(amount, req.actor);

      let intent;
      try {
        intent = await s.charge({
          accountId: row.accountId,
          amount,
          currency: currency.toUpperCase(),
          applicationFee,
          description: String(b.description || ""),
          metadata: {
            paltas_org_id: req.actor.orgId,
            ...(b.invoiceId ? { paltas_invoice_id: String(b.invoiceId) } : {}),
          },
          /* A retry after a timeout must not charge somebody twice. */
          idempotencyKey: b.idempotencyKey ? String(b.idempotencyKey) : "",
          statusCheck: row.cardPaymentsStatus,
        });
      } catch (e) {
        if (e instanceof NotReadyToCharge) {
          throw conflict(e.message + (row.requirementsDue
            ? ` Stripe is still waiting for: ${row.requirementsDue.split(",").join(", ")}.`
            : ""));
        }
        throw e;
      }

      res.set("Cache-Control", "no-store");
      res.status(201).json({
        /* What the browser needs, and nothing else. */
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amount,
        currency: currency.toUpperCase(),
        applicationFee,
        /* The account the Element must be mounted against — a direct charge
           will not confirm without it. */
        stripeAccount: row.accountId,
        livemode: Boolean(intent.livemode),
        /*
         * Said plainly: this is an intent, not a payment. The Payment row is
         * written when the webhook confirms, never from this response.
         */
        notice: "Nobody has been charged yet. This authorises the customer's " +
                "browser to pay; the payment is recorded when Stripe confirms it.",
      });
    } catch (e) { next(e); }
  });

/**
 * PALTAS's cut of a payment, in minor units.
 *
 * Zero for now, and deliberately so: what PALTAS charges a company for
 * collecting its own rent is a commercial decision nobody has made, and
 * inventing a percentage here would start taking money from member companies
 * on the strength of a guess in a source file.
 *
 * The seam exists so that decision lands in one place when it is made.
 */
export function platformFee(_amount, _actor) {
  return 0;
}
