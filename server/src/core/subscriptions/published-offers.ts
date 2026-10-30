/** Versioned owner-approved offers. Existing plans and agreements retain their identifiers and prices. */
export const OFFER_PREFIX = "PALTAS-20261027-";
export function approvedOffer(id: string) {
  const match = /^PALTAS-20261027-(property|agency|developer|hotel|security)-(Standard|Pro|Enterprise)$/.exec(id);
  if (!match) return null;
  const product = match[1] as string;
  const tier = match[2] as string;
  return {
    product,
    tier,
    amountMinor: ({ Standard: 4900, Pro: 6900, Enterprise: 9900 } as Record<string, number>)[tier] as number,
    lookupKey: `paltas_${product}_${tier.toLowerCase()}_20261027_usd_month_inclusive`,
  };
}
