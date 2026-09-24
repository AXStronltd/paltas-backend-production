/* ====================================================================== *
 * STRIPE CONNECT.
 *
 * Member companies collecting from their own customers. Every test here is
 * about one of three things going wrong in a way that costs somebody money:
 *
 *   charging into an account Stripe has not activated
 *   trusting a webhook that did not come from Stripe
 *   recording the same payment twice
 *
 * No key is needed. The Stripe client is injected, so the request SHAPES are
 * verified without an account — which is most of what goes wrong, and all of
 * what can be checked before credentials exist.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.js";

import {
  stripeProcessor, notConnected, register, clear, isConnected, status,
  cardPaymentsStatus, requirementsOf, wireAccount, redact, fromEnv,
  PaymentsUnavailable, NotReadyToCharge, STRIPE_API_VERSION,
} from "../src/payments/stripe.js";

test.afterEach(() => clear());

/** A Stripe double that records what it was asked for. */
function fakeStripe(overrides = {}) {
  const calls = [];
  const rec = (name) => (...args) => {
    calls.push({ name, args });
    const fn = overrides[name];
    return Promise.resolve(fn ? fn(...args) : {});
  };
  return {
    calls,
    v2: { core: { accounts: { create: rec("accounts.create"), retrieve: rec("accounts.retrieve") } } },
    accountLinks: { create: rec("accountLinks.create") },
    paymentIntents: { create: rec("paymentIntents.create") },
    webhooks: { constructEvent: (...a) => { calls.push({ name: "constructEvent", args: a });
      if (overrides["constructEvent"]) return overrides["constructEvent"](...a);
      throw new Error("bad signature"); } },
  };
}

const ACTIVE_ACCOUNT = {
  id: "acct_1", livemode: false, dashboard: "full",
  identity: { country: "ke" },
  configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } },
  requirements: { currently_due: [], disabled_reason: null },
};

/* ================================================================ 1
 * WITH NOTHING CONNECTED
 * ================================================================ */

test("with no processor, every write refuses and nothing is invented", async () => {
  assert.equal(isConnected(), false);
  /* Money: a fake success here is a company believing it was paid. */
  await assert.rejects(() => notConnected.charge(), /No payment processor is connected/);
  await assert.rejects(() => notConnected.createAccount(), /Nothing has been created/);
  await assert.rejects(() => notConnected.verifyWebhook(), PaymentsUnavailable);
  assert.equal(status().connected, false);
});

test("status never carries a key", () => {
  register(stripeProcessor({ secretKey: "sk_test_SHOULD_NEVER_APPEAR", client: fakeStripe() }));
  const s = JSON.stringify(status());
  assert.ok(!s.includes("SHOULD_NEVER_APPEAR"), "the secret key is in the status payload");
  assert.equal(JSON.parse(s).name, "stripe");
});

test("a live key is reported as live, a test key as test", () => {
  const t = stripeProcessor({ secretKey: "sk_test_x", client: fakeStripe() });
  const l = stripeProcessor({ secretKey: "rk_live_x", client: fakeStripe() });
  assert.equal(t.livemode, false);
  assert.equal(l.livemode, true, "a restricted LIVE key must still read as live");
  assert.match(l.describe().why, /LIVE mode. Real cards/);
});

/* ================================================================ 2
 * ACCOUNTS V2 — the shapes that are easy to get wrong
 * ================================================================ */

test("an account is created with v2 dimensions and no legacy type", async () => {
  const fake = fakeStripe({ "accounts.create": () => ACTIVE_ACCOUNT });
  const p = stripeProcessor({ secretKey: "sk_test_x", client: fake });
  await p.createAccount({ orgId: "org1", name: "Nyali Hotel", country: "KE", email: "a@b.c" });

  const body = fake.calls.find((c) => c.name === "accounts.create").args[0];
  /*
   * `type: "express" | "custom" | "standard"` is the deprecated v1 pattern.
   * Passing it silently opts the platform out of the v2 model entirely.
   */
  assert.equal(body.type, undefined, "a legacy account type was sent");

  /* SaaS: the company is an independent business and merchant of record. */
  assert.equal(body.dashboard, "full");
  assert.equal(body.defaults.responsibilities.fees_collector, "stripe");
  assert.equal(body.defaults.responsibilities.losses_collector, "stripe");
  /* Merchant configuration is what makes a direct charge possible at all. */
  assert.equal(body.configuration.merchant.capabilities.card_payments.requested, true);
  /* And the company can be found from Stripe's side without asking PALTAS. */
  assert.equal(body.metadata.paltas_org_id, "org1");
});

test("readiness is the v2 capability path, not charges_enabled", () => {
  assert.equal(cardPaymentsStatus(ACTIVE_ACCOUNT), "active");
  /*
   * An account carrying ONLY the deprecated v1 flag must read as inactive.
   * Treating `charges_enabled: true` as permission is how a platform charges
   * into an account Stripe never activated.
   */
  assert.equal(cardPaymentsStatus({ id: "acct_2", charges_enabled: true }), "inactive");
  assert.equal(cardPaymentsStatus({}), "inactive");
  assert.equal(cardPaymentsStatus(null), "inactive");
  assert.equal(cardPaymentsStatus({
    configuration: { merchant: { capabilities: { card_payments: { status: "pending" } } } },
  }), "pending", "pending must stay pending, not collapse to a boolean");
});

test("what Stripe is waiting for is kept, so 'pending' is actionable", () => {
  const due = requirementsOf({
    requirements: { currently_due: ["individual.id_number"], past_due: ["external_account"] },
    configuration: { merchant: { requirements: { errors: [{ requirement: "business_profile.url" }] } } },
  });
  assert.deepEqual(due, ["individual.id_number", "external_account", "business_profile.url"]);
  assert.deepEqual(requirementsOf({}), []);
});

test("an account is wired into exactly what PALTAS stores", () => {
  const w = wireAccount(ACTIVE_ACCOUNT);
  assert.equal(w.accountId, "acct_1");
  assert.equal(w.cardPaymentsStatus, "active");
  assert.equal(w.country, "ke");
  assert.equal(w.livemode, false);
  assert.equal(w.dashboard, "full");
  assert.equal(w.requirementsDue, "");
});

/* ================================================================ 3
 * CHARGING — where the money is
 * ================================================================ */

test("an unverified company cannot be charged into", async () => {
  /*
   * The most expensive mistake available here. The payment appears to succeed,
   * the customer is debited, and the company finds out weeks later that it
   * cannot be paid out — unlike a decline, nobody notices.
   */
  const fake = fakeStripe();
  const p = stripeProcessor({ secretKey: "sk_test_x", client: fake });

  for (const s of ["pending", "restricted", "inactive", "", undefined]) {
    await assert.rejects(
      () => p.charge({ accountId: "acct_1", amount: 1000, currency: "KES", statusCheck: s || "inactive" }),
      NotReadyToCharge);
  }
  assert.equal(fake.calls.length, 0, "a charge request was sent for an unverified company");
});

test("a charge is DIRECT, on the company's own account", async () => {
  const fake = fakeStripe({ "paymentIntents.create": () => ({ id: "pi_1", client_secret: "pi_1_secret_x", livemode: false }) });
  const p = stripeProcessor({ secretKey: "sk_test_x", client: fake });

  await p.charge({
    accountId: "acct_1", amount: 250000, currency: "kes", applicationFee: 5000,
    description: "Folio 12", metadata: { paltas_org_id: "org1" },
    idempotencyKey: "key-1", statusCheck: "active",
  });

  const call = fake.calls.find((c) => c.name === "paymentIntents.create");
  const [body, opts] = call.args;

  /* THE header that makes it a direct charge. Without it the charge lands on
     PALTAS's account and PALTAS becomes merchant of record. */
  assert.equal(opts.stripeAccount, "acct_1");
  assert.equal(body.amount, 250000);
  assert.equal(body.currency, "kes");
  assert.equal(body.application_fee_amount, 5000);
  /* A retry after a timeout must not charge twice. */
  assert.equal(opts.idempotencyKey, "key-1");
  /*
   * No payment_method_types: omitting it enables dynamic payment methods, so
   * what a customer is offered is configured per market in the Dashboard rather
   * than frozen here.
   */
  assert.equal(body.payment_method_types, undefined);
  assert.deepEqual(body.automatic_payment_methods, { enabled: true });
});

test("a fee cannot equal or exceed the payment", async () => {
  /* A fee of the whole amount leaves the company nothing for work it did. */
  const p = stripeProcessor({ secretKey: "sk_test_x", client: fakeStripe() });
  await assert.rejects(
    () => p.charge({ accountId: "a", amount: 1000, currency: "KES", applicationFee: 1000, statusCheck: "active" }),
    /smaller than the amount/);
  await assert.rejects(
    () => p.charge({ accountId: "a", amount: 1000, currency: "KES", applicationFee: -1, statusCheck: "active" }),
    /smaller than the amount/);
});

test("a charge needs a real amount", async () => {
  const p = stripeProcessor({ secretKey: "sk_test_x", client: fakeStripe() });
  for (const bad of [0, -100, 1.5, "1000", null]) {
    await assert.rejects(
      () => p.charge({ accountId: "a", amount: bad, currency: "KES", statusCheck: "active" }),
      /amount in minor units/);
  }
});

/* ================================================================ 4
 * WEBHOOKS — the only thing that makes a payment real
 * ================================================================ */

test("an unverifiable webhook is refused, and says nothing about the body", async () => {
  const p = stripeProcessor({ secretKey: "sk_test_x", webhookSecret: "whsec_x", client: fakeStripe() });
  await assert.rejects(
    () => p.verifyWebhook({ rawBody: Buffer.from("{}"), signature: "t=1,v1=nope" }),
    (e) => {
      assert.match(e.message, /signature did not verify/);
      /* Nothing from the attacker-controlled body may be echoed back. */
      assert.ok(!/\{|\}/.test(e.message));
      return true;
    });
});

test("without a webhook secret, no event can be trusted at all", async () => {
  const p = stripeProcessor({ secretKey: "sk_test_x", client: fakeStripe() });
  await assert.rejects(
    () => p.verifyWebhook({ rawBody: Buffer.from("{}"), signature: "sig" }),
    /STRIPE_WEBHOOK_SECRET is not set/);
});

test("the webhook route reads the RAW body, before express.json", () => {
  /*
   * The signature is over the exact bytes Stripe sent. express.json() parses
   * and discards them, and a re-serialised object never verifies — the failure
   * looks exactly like a wrong secret, which is why this is pinned rather than
   * left to whoever next reorders server.js.
   */
  const server = sourceText("server.js")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const hook = server.indexOf("app.use(stripeWebhookRoutes)");
  const json = server.indexOf("express.json(");
  assert.ok(hook > 0 && json > 0, "one of the two mounts is missing");
  assert.ok(hook < json,
    "the Stripe webhook is mounted AFTER express.json(), so every signature " +
    "will fail verification");

  const route = sourceText("routes", "stripe-webhook.js");
  assert.ok(/express\.raw\(/.test(route), "the webhook does not take a raw body");
});

/* ================================================================ 5
 * SECRETS
 * ================================================================ */

test("redaction covers every key shape Stripe uses", () => {
  assert.match(redact("key sk_live_abc123def"), /\[redacted-key\]/);
  assert.match(redact("key rk_test_abc123"), /\[redacted-key\]/);
  assert.match(redact("whsec_abcdef123"), /\[redacted-webhook-secret\]/);
  assert.match(redact('{"api_key":"abc"}'), /\[redacted\]/);
  assert.equal(redact("Stripe returned 402"), "Stripe returned 402");
});

test("no key or secret is hard-coded anywhere in the payments code", () => {
  for (const f of ["../src/payments/stripe.js", "../src/routes/payments.js", "../src/routes/stripe-webhook.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/.test(src), `a Stripe key is hard-coded in ${f}`);
    assert.ok(!/\bwhsec_[A-Za-z0-9]{6,}/.test(src), `a webhook secret is hard-coded in ${f}`);
  }
});

test("absent credentials are the normal state, not a crash", () => {
  assert.equal(fromEnv({}), null);
  assert.ok(fromEnv({ STRIPE_SECRET_KEY: "sk_test_x" }));
});

test("the API version is pinned", () => {
  /* An unpinned version lets Stripe change a response shape under a running
     service — and this one moves money. */
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}\./);
  const src = sourceText("payments", "stripe.js");
  assert.ok(/apiVersion: STRIPE_API_VERSION/.test(src), "the client is created without a pinned apiVersion");
});

test("PALTAS does not invent its own commission", () => {
  /*
   * What PALTAS charges a company for collecting its own rent is a commercial
   * decision nobody has made. A percentage guessed in a source file would start
   * taking money from member companies on no authority at all.
   */
  const src = sourceText("routes", "payments.js");
  const fn = src.slice(src.indexOf("export function platformFee"));
  assert.ok(/return 0;/.test(fn.slice(0, 200)),
    "platformFee returns something other than zero — that is a pricing decision, " +
    "and it must be made deliberately rather than appear in a diff");
});
