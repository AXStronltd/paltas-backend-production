import { readFileSync } from "node:fs";
import { entitlements, type Plan } from "@paltas/contracts";
import { OfferSchema } from "./stripe-offers.js";

// The same approved release manifest used to provision Stripe. This is a validation guard,
// not a second pricing catalogue: quoted amounts still come from authorised catalogue records.
const release = OfferSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../../../config/paltas-subscription-offers-2026-10-27.json", import.meta.url), "utf8"),
  ),
);
const approvedPlans = new Map<string, { product: string; tier: string; amount: number }>(
  release.products.flatMap((product) =>
    release.tiers.map(
      (tier) =>
        [
          `paltas_${product}_${tier.tier.toLowerCase()}_${release.version.replaceAll("-", "")}`,
          { product, tier: tier.tier, amount: tier.amountMinor / 100 },
        ] as const,
    ),
  ),
);

/** Approved offers are USD-denominated software subscriptions, independent of property operating currency.
 * Legacy catalogue plans retain their existing currency rules. No exchange rate is inferred.
 */
export function subscriptionPrice(plan: Plan, operatingCurrency: string) {
  const definition = approvedPlans.get(plan.id);
  if (!definition) return entitlements.priceIn(plan.base, operatingCurrency);
  if (
    plan.products.length !== 1 ||
    plan.products[0] !== definition.product ||
    plan.frequency !== "monthly" ||
    plan.tier !== definition.tier
  )
    return null;
  const approved = entitlements.priceIn(plan.base, release.currency);
  if (!approved || approved.amount !== definition.amount || approved.per !== release.interval) return null;
  return approved;
}
