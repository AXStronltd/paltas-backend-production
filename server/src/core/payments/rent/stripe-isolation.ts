/** Rent collection uses the existing PALTAS Stripe account. Never infer an account from a default CLI profile. */
import Stripe from "stripe";
import type { Config } from "../../../config.js";
import { fail } from "../../../http/errors.js";

export const PALTAS_STRIPE_ACCOUNT = "acct_1US4fBIaWEYyCbix";
export const PALTAS_STRIPE_SANDBOX = "acct_1US4fPExurlWTneR";
export const RENT_APPLICATION = "paltas-rent";

export interface RentStripeSettings {
  enabled: boolean;
  onboardingEnabled?: boolean;
  webhookSecret: string;
  /** Explicit operational approval is separate from the subscription integration flag. */
  liveApproved: boolean;
}

/** Validate before constructing a provider client or making a request. No SaaS price/portal configuration is needed. */
export function validateRentStripeConfig(
  stripe: Config["stripe"],
  rent: RentStripeSettings,
  origin: string,
): "disabled" | "test" | "live" {
  if (!rent.enabled && !rent.onboardingEnabled) return "disabled";
  if (!stripe || ![PALTAS_STRIPE_ACCOUNT, PALTAS_STRIPE_SANDBOX].includes(stripe.accountId ?? ""))
    throw fail.conflict("Rent collection requires the verified existing PALTAS Stripe account");
  if (!/^(sk|rk)_(test|live)_/.test(stripe.secretKey))
    throw fail.conflict("The PALTAS server Stripe key is not configured for rent collection");
  if (rent.enabled && (!rent.webhookSecret.startsWith("whsec_") || rent.webhookSecret === stripe.webhookSecret))
    throw fail.conflict("Rent collection requires a separate Connect webhook signing secret");
  const live = /^(sk|rk)_live_/.test(stripe.secretKey);
  if (live && stripe.accountId !== PALTAS_STRIPE_ACCOUNT)
    throw fail.conflict("The verified PALTAS sandbox cannot use live Stripe credentials");
  const productionOrigin = new URL(origin).hostname === "paltas.io";
  if (live && (!productionOrigin || !rent.liveApproved))
    throw fail.conflict("Live rent collection requires approved production activation");
  if (!live && productionOrigin)
    throw fail.conflict("Test rent collection is not permitted at the production PALTAS origin");
  return live ? "live" : "test";
}

/** Small boundary shared by rent operations. Every client is account-pinned before touching connected resources. */
export async function verifiedRentStripe(
  stripe: Config["stripe"],
  rent: RentStripeSettings,
  origin: string,
  supplied?: Stripe,
  purpose: "collection" | "onboarding" = "collection",
): Promise<{ stripe: Stripe; mode: "test" | "live"; platformAccountId: string }> {
  if (purpose === "collection" && !rent.enabled) throw fail.conflict("Automatic Stripe rent collection is not enabled");
  if (purpose === "onboarding" && !rent.onboardingEnabled)
    throw fail.conflict("Company Stripe onboarding is not enabled");
  const mode = validateRentStripeConfig(stripe, rent, origin);
  if (mode === "disabled") throw fail.conflict("Automatic Stripe rent collection is not enabled");
  if (!stripe) throw fail.conflict("The existing PALTAS Stripe configuration is missing");
  const client = supplied ?? new Stripe(stripe.secretKey, { timeout: 15000, maxNetworkRetries: 2 });
  let account: Stripe.Account;
  try {
    account = await client.accounts.retrieve(null);
  } catch {
    throw fail.conflict("PALTAS Stripe account identity could not be verified. No collection request was made.");
  }
  if (account.id !== stripe.accountId)
    throw fail.conflict("PALTAS rent Stripe account verification failed; no collection request was made");
  return { stripe: client, mode, platformAccountId: account.id };
}

export function rentMetadata(input: {
  orgId: string;
  obligationId: string;
  invoiceId: string;
  merchantAccountId: string;
  mode: "test" | "live";
  platformAccountId?: string;
}) {
  return {
    paltasApplication: RENT_APPLICATION,
    paltasAccountId: input.platformAccountId ?? PALTAS_STRIPE_ACCOUNT,
    paltasMode: input.mode,
    paltasOrgId: input.orgId,
    paltasObligationId: input.obligationId,
    paltasInvoiceId: input.invoiceId,
    paltasMerchantAccountId: input.merchantAccountId,
  };
}

/** A valid signature alone is not enough: reject wrong-mode and unscoped events before rent dispatch. */
export function rentEventContext(event: Stripe.Event, expected: { accountId: string; mode: "test" | "live" }): boolean {
  return !!event.account && event.account === expected.accountId && event.livemode === (expected.mode === "live");
}
