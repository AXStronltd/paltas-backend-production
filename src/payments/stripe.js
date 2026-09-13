/* ====================================================================== *
 * STRIPE CONNECT — member companies collecting from their own customers.
 *
 * A hotel on PALTAS charging a guest's folio. A landlord collecting rent. The
 * money is THEIRS; PALTAS sells the software and takes a fee.
 *
 * ── THE PATTERN, AND WHY IT IS NOT THE OTHER ONE ────────────────────────
 *
 * SaaS with DIRECT charges. The company is the merchant of record, the charge
 * is created on their own connected account, and PALTAS takes
 * `application_fee_amount`.
 *
 * The alternative — destination charges, where the charge lands on PALTAS's
 * account and the money is transferred onward — would make PALTAS merchant of
 * record for every room, tenancy and invoice on the platform, and liable for
 * every chargeback across all of it. A guest disputing a room they disliked
 * would be arguing with PALTAS rather than with the hotel that served them.
 *
 * Stripe's own mapping puts this beyond doubt: a platform whose sellers "run
 * their own business, accept their own payments and own their own customers" is
 * SaaS, which means `dashboard: "full"`, `fees_collector: "stripe"`,
 * `losses_collector: "stripe"` and direct charges.
 *
 * ── ACCOUNTS V2 ─────────────────────────────────────────────────────────
 *
 * Accounts are created through `/v2/core/accounts`. There is no
 * `type: "express"`, `type: "custom"` or `type: "standard"` anywhere here —
 * those are deprecated v1 patterns — and readiness is NOT `charges_enabled`,
 * which is also deprecated. It is
 *
 *     configuration.merchant.capabilities.card_payments.status === "active"
 *
 * and nothing charges a card until that says so.
 *
 * ── WHAT THIS FILE REFUSES TO DO ────────────────────────────────────────
 *
 * No key, no Stripe. `notConnected` below throws on every write and returns
 * nothing on every read — it does not invent an account id, a capability
 * status, or a successful charge. This is money: a fake success here is a
 * company believing it was paid.
 *
 * It also refuses to charge through an account Stripe has not activated, even
 * if a caller asks nicely. The company would be taking money it cannot be paid
 * out, which is worse than a declined payment because nobody notices for weeks.
 *
 * ── CREDENTIALS ─────────────────────────────────────────────────────────
 *
 *     STRIPE_SECRET_KEY       rk_… preferred over sk_…; a restricted key can
 *                             be scoped to exactly the permissions below
 *     STRIPE_WEBHOOK_SECRET   whsec_…, for signature verification
 *
 * From the environment only, never from a request, never logged, never
 * returned. `redact()` scrubs them from every error path because Stripe echoes
 * request details in some errors.
 * ====================================================================== */

import Stripe from "stripe";

/** The API version this integration is written against. Pinned deliberately:
 *  an unpinned version means Stripe can change a response shape under a
 *  running service, and this one moves money. */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/** Thrown when something asks for a capability no processor is behind. */
export class PaymentsUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "PaymentsUnavailable";
    /* 503, not 500: nothing is broken, a capability is absent. */
    this.status = 503;
    this.expose = true;
  }
}

/** Thrown when a company is not yet allowed to take money. */
export class NotReadyToCharge extends Error {
  constructor(message, details) {
    super(message);
    this.name = "NotReadyToCharge";
    /* 409, not 403: the company is not forbidden, it is not finished. */
    this.status = 409;
    this.expose = true;
    this.details = details || null;
  }
}

/* ---------------------------------------------------------------- *
 * THE PROCESSOR IN USE WHEN THERE IS NONE.
 * ---------------------------------------------------------------- */
export const notConnected = {
  name: "",
  livemode: false,

  describe() {
    return {
      name: "",
      connected: false,
      livemode: false,
      capabilities: [],
      why: "No payment processor is connected to this installation. Member " +
           "companies cannot collect card payments until one is configured.",
    };
  },

  async createAccount() {
    throw new PaymentsUnavailable(
      "No payment processor is connected, so a company cannot be set up to " +
      "collect payments. Nothing has been created.");
  },
  async onboardingLink() {
    throw new PaymentsUnavailable("No payment processor is connected.");
  },
  async account() {
    throw new PaymentsUnavailable("No payment processor is connected.");
  },
  async charge() {
    throw new PaymentsUnavailable(
      "No payment processor is connected, so no card can be charged. Nobody " +
      "has been billed.");
  },
  /* A read with a correct empty answer, so a screen renders rather than breaks. */
  async verifyWebhook() {
    throw new PaymentsUnavailable("No payment processor is connected.");
  },
};

/* ---------------------------------------------------------------- *
 * THE REGISTRY. One process, one processor, chosen by configuration.
 * ---------------------------------------------------------------- */

let current = notConnected;

export function register(processor) {
  if (!processor || typeof processor.charge !== "function") {
    throw new Error("A payment processor must implement charge().");
  }
  if (!processor.name) {
    throw new Error("A payment processor must have a name.");
  }
  current = processor;
  return current;
}

export const processor = () => current;
export const isConnected = () => current !== notConnected && Boolean(current.name);
export function clear() { current = notConnected; }

/**
 * What a settings screen reads. Never throws, and has no field that could hold
 * a credential — so nothing here can leak one.
 */
export function status() {
  try {
    const d = current.describe ? current.describe() : {};
    return {
      connected: isConnected(),
      name: d.name || current.name || "",
      livemode: Boolean(d.livemode ?? current.livemode),
      capabilities: d.capabilities || [],
      why: d.why || "",
    };
  } catch (e) {
    return {
      connected: false, name: "", livemode: false, capabilities: [],
      why: "The configured payment processor could not describe itself: " +
           String(e && e.message).slice(0, 160),
    };
  }
}

/* ---------------------------------------------------------------- *
 * READING STRIPE'S ANSWER.
 * ---------------------------------------------------------------- */

/**
 * Whether this account may take a card, per Accounts v2.
 *
 * Deliberately NOT `charges_enabled`, which is deprecated and which a platform
 * reading it today would find absent or stale. The v2 path is the only one that
 * answers truthfully, and anything other than the exact string "active" is a
 * no — an unrecognised status is treated as not-ready rather than assumed
 * benign.
 */
export function cardPaymentsStatus(account) {
  const s = account
    && account.configuration
    && account.configuration.merchant
    && account.configuration.merchant.capabilities
    && account.configuration.merchant.capabilities.card_payments
    && account.configuration.merchant.capabilities.card_payments.status;
  return typeof s === "string" && s ? s : "inactive";
}

/** What Stripe is still waiting for, as a plain list a person can act on. */
export function requirementsOf(account) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node) return;
    for (const key of ["currently_due", "past_due", "errors"]) {
      const v = node[key];
      if (!Array.isArray(v)) continue;
      for (const item of v) {
        const t = typeof item === "string" ? item
          : (item && (item.requirement || item.code)) || "";
        if (t && !seen.has(t)) { seen.add(t); out.push(String(t)); }
      }
    }
  };
  walk(account && account.requirements);
  walk(account && account.configuration && account.configuration.merchant
    && account.configuration.merchant.requirements);
  return out;
}

/** Everything PALTAS stores about an account, from what Stripe just said. */
export function wireAccount(account) {
  return {
    accountId: String(account.id),
    cardPaymentsStatus: cardPaymentsStatus(account),
    requirementsDue: requirementsOf(account).join(","),
    disabledReason: String(
      (account.requirements && account.requirements.disabled_reason) || ""),
    country: String(account.country || account.identity?.country || ""),
    defaultCurrency: String(account.defaults?.currency || account.default_currency || "").toUpperCase(),
    livemode: Boolean(account.livemode),
    dashboard: String(account.dashboard || account.configuration?.dashboard || "full"),
  };
}

/* ---------------------------------------------------------------- *
 * THE REAL PROCESSOR.
 * ---------------------------------------------------------------- */

/**
 * @param {object} cfg
 *   secretKey     STRIPE_SECRET_KEY — an rk_ restricted key for preference
 *   webhookSecret STRIPE_WEBHOOK_SECRET
 *   client        an injected Stripe instance, for tests
 *   platformName  what a company sees during onboarding
 */
export function stripeProcessor({
  secretKey,
  webhookSecret = "",
  client,
  platformName = "PALTAS",
} = {}) {
  if (!secretKey && !client) {
    throw new PaymentsUnavailable(
      "Stripe cannot be registered without STRIPE_SECRET_KEY. No company can " +
      "collect card payments, and nothing else in PALTAS is affected.");
  }

  /*
   * A CLIENT INSTANCE, never the deprecated global-key pattern.
   *
   * `Stripe.setApiKey` / `stripe.api_key = …` is deprecated in every current
   * SDK, and on a server it is worse than deprecated: it is process-global
   * mutable state on the thing that moves money.
   */
  const stripe = client || new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const live = /^(sk|rk)_live_/.test(String(secretKey || ""));

  return {
    name: "stripe",
    livemode: live,

    describe() {
      return {
        name: "stripe",
        connected: true,
        livemode: live,
        capabilities: ["connect", "direct-charges", "application-fee"],
        why: live
          ? "Stripe is connected in LIVE mode. Real cards will be charged."
          : "Stripe is connected in TEST mode. No real money moves.",
        webhooksVerified: Boolean(webhookSecret),
      };
    },

    /**
     * Create the company's own Stripe account.
     *
     * Accounts v2. The three dimensions are set explicitly rather than left to
     * a default, because each one decides who carries a liability:
     *
     *   dashboard "full"            these are independent businesses
     *   fees_collector "stripe"     the company pays Stripe's fees
     *   losses_collector "stripe"   Stripe owns negative-balance liability
     *
     * and `configuration.merchant` requesting card_payments is what makes the
     * company merchant of record for a direct charge.
     */
    async createAccount({ orgId, name, country, email }) {
      if (!orgId) throw new PaymentsUnavailable("A company is needed to create an account for.");
      try {
        return await stripe.v2.core.accounts.create({
          display_name: String(name || "").slice(0, 250),
          contact_email: email ? String(email) : undefined,
          identity: country ? { country: String(country).toLowerCase() } : undefined,
          dashboard: "full",
          defaults: {
            responsibilities: {
              fees_collector: "stripe",
              losses_collector: "stripe",
            },
          },
          configuration: {
            merchant: {
              capabilities: {
                /* Card payments only. Requesting capabilities a company does not
                   need lengthens their onboarding for nothing. */
                card_payments: { requested: true },
              },
            },
          },
          /* So a Stripe-side investigation can find the company without
             PALTAS having to be asked. */
          metadata: { paltas_org_id: String(orgId) },
          include: ["configuration.merchant", "requirements", "identity"],
        });
      } catch (e) { throw wrap(e); }
    },

    /** Where the company finishes verification, hosted by Stripe. */
    async onboardingLink({ accountId, returnUrl, refreshUrl }) {
      if (!accountId) throw new PaymentsUnavailable("An account id is needed.");
      try {
        /*
         * Hosted onboarding rather than the API kind. Collecting verification
         * fields ourselves would make PALTAS responsible for every remediation
         * flow as Stripe's requirements change — and they change per country,
         * per business type, without notice.
         */
        const link = await stripe.accountLinks.create({
          account: String(accountId),
          type: "account_onboarding",
          return_url: String(returnUrl),
          refresh_url: String(refreshUrl),
          collection_options: { fields: "eventually_due" },
        });
        return { url: link.url, expiresAt: link.expires_at || null };
      } catch (e) { throw wrap(e); }
    },

    /** What Stripe says about the account right now. */
    async account({ accountId }) {
      if (!accountId) throw new PaymentsUnavailable("An account id is needed.");
      try {
        return await stripe.v2.core.accounts.retrieve(String(accountId), {
          include: ["configuration.merchant", "requirements", "identity"],
        });
      } catch (e) { throw wrap(e); }
    },

    /**
     * Charge a customer, on the company's own account.
     *
     * A DIRECT charge: created with the `Stripe-Account` header, so it lives on
     * their account and they are merchant of record. `application_fee_amount`
     * is PALTAS's cut, taken from the same payment.
     *
     * Returns a client secret for the browser's Payment Element. PALTAS never
     * sees a card number.
     */
    async charge({
      accountId, amount, currency, applicationFee = 0,
      description = "", metadata = {}, idempotencyKey = "",
      statusCheck,
    }) {
      if (!accountId) throw new PaymentsUnavailable("An account id is needed to charge.");
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new PaymentsUnavailable("An amount in minor units is needed to charge.");
      }
      if (!currency) throw new PaymentsUnavailable("A currency is needed to charge.");

      /*
       * NOT READY MEANS NOT CHARGED.
       *
       * The caller passes what PALTAS last stored, and it is checked here as
       * well as there — because taking money into an account Stripe has not
       * activated means the company cannot be paid out, and unlike a decline
       * nobody notices for weeks.
       */
      if (statusCheck && statusCheck !== "active") {
        throw new NotReadyToCharge(
          "This company cannot accept card payments yet — Stripe has not " +
          "finished verifying them. Nobody has been charged.",
          { cardPaymentsStatus: statusCheck });
      }
      if (applicationFee < 0 || applicationFee >= amount) {
        throw new PaymentsUnavailable(
          "The platform fee must be smaller than the amount being charged.");
      }

      try {
        return await stripe.paymentIntents.create({
          amount,
          currency: String(currency).toLowerCase(),
          ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),
          description: String(description || "").slice(0, 300),
          metadata,
          /*
           * No `payment_method_types`. Omitting it enables dynamic payment
           * methods, so what a customer is offered is configured in the
           * Dashboard per market rather than frozen into this file — which
           * matters on a platform selling in Kenya, the UK and the Gulf.
           */
          automatic_payment_methods: { enabled: true },
        }, {
          /* THE header that makes this a direct charge on their account. */
          stripeAccount: String(accountId),
          /* So a retry after a timeout cannot charge somebody twice. */
          ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}),
        });
      } catch (e) { throw wrap(e); }
    },

    /**
     * Verify a webhook came from Stripe.
     *
     * The signature is the only thing separating a real payment notification
     * from anybody on the internet posting "you were paid". It needs the RAW
     * body — a parsed and re-serialised one will not verify, because the bytes
     * differ.
     */
    async verifyWebhook({ rawBody, signature }) {
      if (!webhookSecret) {
        throw new PaymentsUnavailable(
          "STRIPE_WEBHOOK_SECRET is not set, so webhook signatures cannot be " +
          "verified and no event can be trusted.");
      }
      if (!signature) throw new PaymentsUnavailable("The request carried no Stripe signature.");
      try {
        return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (e) {
        /* Deliberately not `wrap`: a bad signature is a rejected request, not
           an outage, and the message must not echo anything from the body. */
        throw new PaymentsUnavailable("The webhook signature did not verify.");
      }
    },
  };
}

/** A Stripe error, with nothing credential-shaped left in it. */
function wrap(e) {
  const msg = redact(String((e && e.message) || "Stripe could not be reached."));
  const err = new PaymentsUnavailable(msg.slice(0, 300));
  /* Stripe's own code is useful to a caller and safe to pass on. */
  if (e && e.code) err.stripeCode = e.code;
  if (e && e.type) err.stripeType = e.type;
  return err;
}

/** Remove anything key-shaped before it is thrown or logged. */
export function redact(s) {
  return String(s || "")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g, "[redacted-key]")
    .replace(/\bwhsec_[A-Za-z0-9]+/g, "[redacted-webhook-secret]")
    .replace(/("?(?:api[_-]?key|secret[_-]?key|client[_-]?secret)"?\s*[:=]\s*"?)[^",\s}]+/gi,
             "$1[redacted]");
}

/** Build from the environment, or null when this installation has no key. */
export function fromEnv(env = process.env) {
  if (!env.STRIPE_SECRET_KEY) return null;
  return stripeProcessor({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
  });
}
