import { describe, expect, it } from "vitest";
import type { Plan } from "@paltas/contracts";
import { subscriptionPrice } from "../dist/core/subscriptions/subscription-price.js";
const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "paltas_property_standard_20261027",
  name: "Standard",
  tier: "Standard",
  products: ["property"],
  modules: [],
  buildingsIncluded: 1,
  base: { amount: 49, ccy: "USD", per: "month" },
  frequency: "monthly",
  ...overrides,
});
describe("subscription and operating currency isolation", () => {
  it("quotes the approved USD offer without changing KES property accounting", () => {
    const operatingCurrency = "KES";
    expect(subscriptionPrice(plan(), operatingCurrency)).toEqual({ amount: 49, ccy: "USD", per: "month" });
    expect(operatingCurrency).toBe("KES");
  });
  it("supports all five approved products and three tiers", () => {
    for (const product of ["property", "agency", "developer", "hotel", "security"])
      for (const [tier, amount] of [
        ["standard", 49],
        ["pro", 69],
        ["enterprise", 99],
      ] as const)
        expect(
          subscriptionPrice(
            plan({
              id: `paltas_${product}_${tier}_20261027`,
              products: [product],
              tier: tier === "standard" ? "Standard" : tier === "pro" ? "Pro" : "Enterprise",
              base: { amount, ccy: "USD", per: "month" },
            }),
            "ZAR",
          )?.amount,
        ).toBe(amount);
  });
  it("does not enable currency fallback for legacy or unrecognised offers", () => {
    expect(subscriptionPrice(plan({ id: "PM-STD" }), "KES")).toBeNull();
    expect(subscriptionPrice(plan({ id: "paltas_property_standard_20990101" }), "KES")).toBeNull();
  });
  it("rejects altered approved amounts, billing periods and product associations", () => {
    expect(subscriptionPrice(plan({ base: { amount: 4900, ccy: "USD", per: "month" } }), "KES")).toBeNull();
    expect(subscriptionPrice(plan({ base: { amount: 49, ccy: "USD", per: "year" } }), "KES")).toBeNull();
    expect(subscriptionPrice(plan({ products: ["hotel"] }), "KES")).toBeNull();
  });
  it("retains existing explicit operating-currency prices and no inferred FX", () => {
    expect(
      subscriptionPrice(plan({ id: "PM-STD", base: { amount: 25000, ccy: "KES", per: "month" } }), "KES")?.ccy,
    ).toBe("KES");
    expect(
      subscriptionPrice(plan({ id: "PM-STD", base: { amount: 25000, ccy: "KES", per: "month" } }), "EUR"),
    ).toBeNull();
  });
});
