import { describe, expect, it } from "vitest";
import { eligibleRentMethods, assertRentMethod, RENT_METHODS } from "../dist/core/payments/rent/payment-methods.js";
import type Stripe from "stripe";
const merchant = {
  country: "US",
  charges_enabled: true,
  payouts_enabled: true,
  capabilities: {
    card_payments: "active",
    us_bank_account_ach_payments: "active",
    bacs_debit_payments: "active",
    sepa_debit_payments: "active",
    acss_debit_payments: "active",
  },
  requirements: { disabled_reason: null },
} as unknown as Stripe.Account;
const base = { merchant, currency: "USD", amountMinor: 100000, providerAvailable: RENT_METHODS };
describe("Verified merchant rent method eligibility (no activation or money movement)", () => {
  it.each([
    ["US", "USD", ["card", "us_bank_account", "acss_debit"]],
    ["GB", "USD", ["card", "us_bank_account"]],
    ["GB", "GBP", ["card", "bacs_debit"]],
    ["FR", "EUR", ["card", "sepa_debit"]],
    ["CA", "CAD", ["card", "acss_debit"]],
    ["CA", "USD", ["card", "acss_debit"]],
    ["GB", "CAD", ["card"]],
    ["US", "EUR", ["card", "sepa_debit"]],
    ["KE", "KES", []],
  ])("uses actual merchant and currency boundaries: %s/%s", (country, currency, expected) => {
    expect(eligibleRentMethods({ ...base, merchant: { ...merchant, country }, currency: currency as string })).toEqual(
      expected,
    );
  });
  it("requires both active capability and provider configuration, not a dashboard switch alone", () => {
    expect(eligibleRentMethods({ ...base, providerAvailable: ["card"] })).toEqual(["card"]);
    expect(
      eligibleRentMethods({ ...base, merchant: { ...merchant, capabilities: { card_payments: "active" } } }),
    ).toEqual(["card"]);
    expect(
      eligibleRentMethods({
        ...base,
        merchant: { ...merchant, capabilities: { us_bank_account_ach_payments: "pending" } },
      }),
    ).toEqual([]);
  });
  it("refuses paused charges, paused payouts and disabled verification status", () => {
    for (const a of [
      { ...merchant, charges_enabled: false },
      { ...merchant, payouts_enabled: false },
      { ...merchant, requirements: { disabled_reason: "requirements.past_due" } as Stripe.Account.Requirements },
    ])
      expect(eligibleRentMethods({ ...base, merchant: a })).toEqual([]);
  });
  it.each([0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe amount %s", (amountMinor) => {
    expect(() => eligibleRentMethods({ ...base, amountMinor })).toThrow(/positive whole number/);
  });
  it("enforces minimum bank-debit amounts without disabling an otherwise eligible card", () => {
    expect(eligibleRentMethods({ ...base, amountMinor: 49 })).toEqual(["card"]);
    expect(eligibleRentMethods({ ...base, amountMinor: 50 })).toContain("us_bank_account");
  });
  it("gives a clear failure for an unavailable method without starting a payment", () => {
    expect(() => assertRentMethod({ ...base, currency: "EUR" }, "us_bank_account")).toThrow(/no payment was initiated/);
  });
});
