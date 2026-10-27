import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { provisionStripeOffers } from "../dist/core/subscriptions/stripe-offers.js";
import { PALTAS_STRIPE_ACCOUNT, PALTAS_STRIPE_SANDBOX } from "../dist/core/payments/rent/stripe-isolation.js";
const approved = JSON.parse(
  readFileSync(new URL("../../config/paltas-subscription-offers-2026-10-27.json", import.meta.url), "utf8"),
);
function provider() {
  const products = new Map<string, Stripe.Product>(),
    prices = new Map<string, Stripe.Price>();
  let accountId = PALTAS_STRIPE_SANDBOX,
    creates = 0,
    lose = false;
  const stripe = {
    accounts: { retrieve: async () => ({ id: accountId }) },
    products: {
      retrieve: async (id: string) => {
        const p = products.get(id);
        if (!p) throw { code: "resource_missing" };
        return p;
      },
      create: async (b: Stripe.ProductCreateParams) => {
        creates++;
        const p = { ...b, id: b.id, active: true };
        products.set(b.id!, p as Stripe.Product);
        return p;
      },
    },
    prices: {
      list: async (b: Stripe.PriceListParams) => ({
        data: [...prices.values()].filter((p) => b.lookup_keys?.includes(p.lookup_key!)),
        has_more: false,
      }),
      create: async (b: Stripe.PriceCreateParams) => {
        creates++;
        const p = {
          ...b,
          id: "price_" + prices.size,
          active: true,
          livemode: false,
          billing_scheme: "per_unit",
          recurring: { ...b.recurring, interval_count: 1, usage_type: "licensed" },
        } as unknown as Stripe.Price;
        prices.set(b.lookup_key!, p);
        if (lose) {
          lose = false;
          throw new Error("Lost response after retained price");
        }
        return p;
      },
    },
  } as unknown as Stripe;
  return {
    stripe,
    products,
    prices,
    creates: () => creates,
    account: (id: string) => (accountId = id),
    lose: () => (lose = true),
  };
}
const options = { accountId: PALTAS_STRIPE_SANDBOX, live: false, apply: false };
describe("Approved subscription offers — mock Stripe, no customer or charge API", () => {
  it("dry-run lists all approved prices without changing provider resources", async () => {
    const p = provider(),
      r = await provisionStripeOffers(p.stripe, approved, options);
    expect(r.rows).toHaveLength(15);
    expect(p.creates()).toBe(0);
    expect(r.rows.filter((x) => x.tier === "Standard").every((x) => x.amountMinor === 4900)).toBe(true);
    expect(r.rows.filter((x) => x.tier === "Pro").every((x) => x.amountMinor === 6900)).toBe(true);
    expect(r.rows.filter((x) => x.tier === "Enterprise").every((x) => x.amountMinor === 9900)).toBe(true);
    expect(r.rows.every((x) => x.currency === "USD" && x.priceId === null)).toBe(true);
  });
  it("creates versioned inclusive monthly definitions once and safely resumes", async () => {
    const p = provider();
    const r = await provisionStripeOffers(p.stripe, approved, { ...options, apply: true });
    expect(r.rows.every((x) => x.priceId)).toBe(true);
    expect(p.creates()).toBe(30);
    expect((await provisionStripeOffers(p.stripe, approved, { ...options, apply: true })).rows).toEqual(r.rows);
    expect(p.creates()).toBe(30);
    expect([...p.prices.values()].every((x) => x.tax_behavior === "inclusive")).toBe(true);
  });
  it("recovers a lost provider response without duplicating the retained price", async () => {
    const p = provider();
    p.lose();
    await expect(provisionStripeOffers(p.stripe, approved, { ...options, apply: true })).rejects.toThrow(/Lost/);
    await provisionStripeOffers(p.stripe, approved, { ...options, apply: true });
    expect(p.products.size).toBe(15);
    expect(p.prices.size).toBe(15);
    expect(p.creates()).toBe(30);
  });
  it("refuses foreign platforms and mismatched authenticated key accounts", async () => {
    const p = provider();
    await expect(provisionStripeOffers(p.stripe, approved, { ...options, accountId: "acct_other" })).rejects.toThrow(
      /verified PALTAS/,
    );
    p.account(PALTAS_STRIPE_ACCOUNT);
    await expect(provisionStripeOffers(p.stripe, approved, options)).rejects.toThrow(/different account/);
    expect(p.creates()).toBe(0);
  });
  it("never overwrites an existing price with different terms", async () => {
    const p = provider();
    await provisionStripeOffers(p.stripe, approved, { ...options, apply: true });
    const first = [...p.prices.values()][0]!;
    first.unit_amount = 1;
    await expect(provisionStripeOffers(p.stripe, approved, { ...options, apply: true })).rejects.toThrow(
      /differs from approved/,
    );
    expect(p.creates()).toBe(30);
    expect(first.unit_amount).toBe(1);
  });
  it("refuses ambiguous tiers, products and non-inclusive tax treatment", async () => {
    const p = provider();
    for (const bad of [
      { ...approved, products: ["property", "property"] },
      { ...approved, tiers: [approved.tiers[0], approved.tiers[0], approved.tiers[2]] },
      { ...approved, taxBehavior: "exclusive" },
    ])
      await expect(provisionStripeOffers(p.stripe, bad, options)).rejects.toThrow();
    expect(p.creates()).toBe(0);
  });
});
