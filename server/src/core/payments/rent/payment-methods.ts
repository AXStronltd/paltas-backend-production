import type Stripe from "stripe";
import { fail } from "../../../http/errors.js";

export const RENT_METHODS = ["card", "us_bank_account", "bacs_debit", "sepa_debit", "acss_debit"] as const;
export type RentMethod = (typeof RENT_METHODS)[number];
const europeanMerchants = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE GB".split(" "),
);
const capability = {
  card: "card_payments",
  us_bank_account: "us_bank_account_ach_payments",
  bacs_debit: "bacs_debit_payments",
  sepa_debit: "sepa_debit_payments",
  acss_debit: "acss_debit_payments",
} as const;

/** Country/currency candidates are insufficient: the actual merchant capability AND provider configuration must agree.
 * This is deliberately scoped to the approved initial markets. It never requests capabilities or accepts a mandate.
 */
export function eligibleRentMethods(input: {
  merchant: Pick<Stripe.Account, "country" | "charges_enabled" | "payouts_enabled" | "capabilities" | "requirements">;
  currency: string;
  amountMinor: number;
  providerAvailable: readonly RentMethod[];
}): RentMethod[] {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw fail.invalid("The collection amount must be a positive whole number of currency minor units");
  const a = input.merchant,
    country = a.country ?? "",
    currency = input.currency.toUpperCase();
  if (!a.charges_enabled || !a.payouts_enabled || a.requirements?.disabled_reason) return [];
  if (!["USD", "GBP", "EUR", "CAD"].includes(currency)) return [];
  const candidates: RentMethod[] = [];
  if (["US", "CA"].includes(country) || europeanMerchants.has(country)) candidates.push("card");
  if (currency === "USD" && input.amountMinor >= 50 && (country === "US" || europeanMerchants.has(country)))
    candidates.push("us_bank_account");
  if (currency === "GBP" && (country === "US" || country === "CA" || europeanMerchants.has(country)))
    candidates.push("bacs_debit");
  if (currency === "EUR" && (country === "US" || country === "CA" || europeanMerchants.has(country)))
    candidates.push("sepa_debit");
  if (["CAD", "USD"].includes(currency) && input.amountMinor >= 50 && ["CA", "US"].includes(country))
    candidates.push("acss_debit");
  return candidates.filter((m) => a.capabilities?.[capability[m]] === "active" && input.providerAvailable.includes(m));
}

export function assertRentMethod(input: Parameters<typeof eligibleRentMethods>[0], method: RentMethod): void {
  if (!eligibleRentMethods(input).includes(method))
    throw fail.conflict(
      "This payment method is not enabled for the verified company, currency and amount. Choose an available method; no payment was initiated.",
    );
}
