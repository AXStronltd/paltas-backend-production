/** Provision price definitions only. No subscriptions, customers, payments or existing prices are changed. */
import Stripe from "stripe";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { provisionStripeOffers } from "../core/subscriptions/stripe-offers.js";
const c = loadConfig();
if (!c.stripe || !/^(sk|rk)_(test|live)_/.test(c.stripe.secretKey) || !c.stripe.accountId)
  throw new Error("Existing PALTAS Stripe key and account pin required");
const live = /^(sk|rk)_live_/.test(c.stripe.secretKey);
if (live && new URL(c.signup.appBaseUrl).hostname !== "paltas.io")
  throw new Error("Live offer provisioning is restricted to PALTAS production");
const approved = JSON.parse(
  readFileSync(new URL("../../../config/paltas-subscription-offers-2026-10-27.json", import.meta.url), "utf8"),
);
try {
  const result = await provisionStripeOffers(
    new Stripe(c.stripe.secretKey, { timeout: 15000, maxNetworkRetries: 2 }),
    approved,
    { accountId: c.stripe.accountId, live, apply: process.argv.includes("--apply-approved-offers") },
  );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  // Provider error text can include credential fragments; never print it.
  const type = typeof e === "object" && e && "type" in e ? e.type : "OfferProvisioningError";
  const code = typeof e === "object" && e && "code" in e ? e.code : "review_required";
  console.error(
    JSON.stringify({
      type,
      code,
      completed: false,
      note: "No customer was charged. Review approved configuration and permissions; retrying the same offer version preserves existing definitions.",
    }),
  );
  process.exitCode = 1;
}
