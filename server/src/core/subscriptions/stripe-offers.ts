import type Stripe from "stripe";
import { z } from "zod";
import { PALTAS_STRIPE_ACCOUNT, PALTAS_STRIPE_SANDBOX } from "../payments/rent/stripe-isolation.js";

const OfferSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seller: z.string().min(3),
  sellerCountry: z.literal("GB"),
  vatRegistered: z.literal(true),
  currency: z.literal("USD"),
  interval: z.literal("month"),
  taxBehavior: z.literal("inclusive"),
  products: z.array(z.enum(["property", "agency", "developer", "hotel", "security"])).min(1),
  tiers: z
    .array(
      z.object({
        tier: z.enum(["Standard", "Pro", "Enterprise"]),
        amountMinor: z.number().int().positive().max(99999999),
      }),
    )
    .length(3),
});

/** Provision approved, versioned price definitions only. Never creates a customer, subscription or charge.
 * Existing Stripe prices, PALTAS catalogue records and agreements are not changed.
 */
export async function provisionStripeOffers(
  stripe: Stripe,
  input: unknown,
  options: { accountId: string; live: boolean; apply: boolean },
) {
  const config = OfferSchema.parse(input);
  if (new Set(config.products).size !== config.products.length || new Set(config.tiers.map((x) => x.tier)).size !== 3)
    throw new Error("Offer products and tiers must be unique");
  const expected = options.live ? PALTAS_STRIPE_ACCOUNT : PALTAS_STRIPE_SANDBOX;
  if (options.accountId !== expected) throw new Error("Only the verified PALTAS account may hold these offers");
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== expected) throw new Error("Stripe key belongs to a different account; no offers were changed");
  const rows: {
    product: string;
    tier: string;
    amountMinor: number;
    currency: string;
    lookupKey: string;
    productId: string;
    priceId: string | null;
  }[] = [];
  for (const product of config.products)
    for (const tier of config.tiers) {
      const suffix = `${product}_${tier.tier.toLowerCase()}_${config.version.replaceAll("-", "")}`;
      const productId = "paltas_" + suffix;
      const lookupKey = "paltas_" + suffix + "_usd_month_inclusive";
      const metadata = {
        paltasApplication: "paltas",
        paltasAccountId: expected,
        paltasOfferVersion: config.version,
        paltasProduct: product,
        paltasTier: tier.tier,
      };
      const matches = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 2 });
      if (matches.has_more || matches.data.length > 1) throw new Error("Ambiguous existing approved offer");
      let price = matches.data[0];
      if (!price && options.apply) {
        let existing: Stripe.Product | Stripe.DeletedProduct | undefined;
        try {
          existing = await stripe.products.retrieve(productId);
        } catch (e) {
          if (!(typeof e === "object" && e && "code" in e && e.code === "resource_missing")) throw e;
        }
        if (
          existing &&
          (existing.deleted ||
            !existing.active ||
            Object.entries(metadata).some(([k, v]) => existing && !existing.deleted && existing.metadata[k] !== v))
        )
          throw new Error("Existing product does not match this approved offer; review without overwriting it");
        if (!existing)
          await stripe.products.create(
            { id: productId, name: `PALTAS ${product} — ${tier.tier}`, metadata },
            { idempotencyKey: "product_" + lookupKey },
          );
        price = await stripe.prices.create(
          {
            product: productId,
            currency: "usd",
            unit_amount: tier.amountMinor,
            recurring: { interval: "month" },
            tax_behavior: "inclusive",
            lookup_key: lookupKey,
            metadata,
          },
          { idempotencyKey: "price_" + lookupKey },
        );
      }
      if (
        price &&
        (!price.active ||
          price.livemode !== options.live ||
          price.currency !== "usd" ||
          price.unit_amount !== tier.amountMinor ||
          price.tax_behavior !== "inclusive" ||
          price.recurring?.interval !== "month" ||
          price.recurring.interval_count !== 1 ||
          price.recurring.usage_type !== "licensed" ||
          price.billing_scheme !== "per_unit" ||
          (typeof price.product === "string" ? price.product : price.product.id) !== productId ||
          Object.entries(metadata).some(([k, v]) => price.metadata[k] !== v))
      )
        throw new Error("Existing price differs from approved terms; no price was overwritten");
      rows.push({
        product,
        tier: tier.tier,
        amountMinor: tier.amountMinor,
        currency: "USD",
        lookupKey,
        productId,
        priceId: price?.id ?? null,
      });
    }
  return {
    accountId: expected,
    live: options.live,
    applied: options.apply,
    taxBehavior: config.taxBehavior,
    rows,
    note: "Price definitions only. Catalogue, tax calculation, checkout, payment confirmation and release verification remain separate gates.",
  };
}
