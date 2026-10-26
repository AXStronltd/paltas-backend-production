/** Read-only PALTAS account diagnostic. Does not activate collection, create accounts or print credentials/PII. */
import Stripe from "stripe";
import { loadConfig } from "../config.js";
import { PALTAS_STRIPE_ACCOUNT } from "../core/payments/rent/stripe-isolation.js";

const c = loadConfig(process.env);
if (c.stripe?.accountId !== PALTAS_STRIPE_ACCOUNT || !/^(sk|rk)_(test|live)_/.test(c.stripe.secretKey)) {
  console.log(
    JSON.stringify({
      verified: false,
      reason: "Existing PALTAS account pin and server key required; no Stripe request made",
    }),
  );
  process.exitCode = 1;
} else {
  const client = new Stripe(c.stripe.secretKey, { timeout: 10000, maxNetworkRetries: 0 });
  try {
    const a = await client.accounts.retrieve(null);
    if (a.id !== PALTAS_STRIPE_ACCOUNT) {
      console.log(JSON.stringify({ verified: false, reason: "Key account mismatch; no further request made" }));
      process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify({
          verified: true,
          accountId: a.id,
          mode: /^(sk|rk)_live_/.test(c.stripe.secretKey) ? "live" : "test",
          country: a.country,
          chargesEnabled: a.charges_enabled,
          payoutsEnabled: a.payouts_enabled,
          activeCapabilities: Object.entries(a.capabilities ?? {})
            .filter(([, v]) => v === "active")
            .map(([k]) => k),
          subscriptionsEnabled: c.stripe.enabled,
          rentEnabled: c.stripeRent?.enabled ?? false,
        }),
      );
      try {
        const connected = await client.accounts.list({ limit: 1 });
        console.log(
          JSON.stringify({
            connectListReadable: true,
            connectedAccountsInSample: connected.data.length,
            hasMore: connected.has_more,
            countryOperational: false,
            note: "Account eligibility is not proof of a working rent collection or payout journey",
          }),
        );
      } catch {
        console.log(
          JSON.stringify({
            connectListReadable: false,
            note: "Connect access not verified; check the existing PALTAS key permissions and account eligibility",
          }),
        );
        process.exitCode = 1;
      }
    }
  } catch {
    console.log(
      JSON.stringify({
        verified: false,
        reason: "PALTAS Stripe identity request failed; inspect authorised provider diagnostics privately",
      }),
    );
    process.exitCode = 1;
  }
}
