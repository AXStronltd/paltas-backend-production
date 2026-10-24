import { calculateMeteredAmount } from "../../../core/billing/pricing.js";
import { fail } from "../../../http/errors.js";
/** Quantities follow pm_invoice_lines numeric(14,3); the shared calculator rounds money exactly once. */
export function chargeLineAmount(quantity: number, rateMinor: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0 || !/^\d+(\.\d{1,3})?$/.test(String(quantity)))
    throw fail.invalid("Use a positive quantity with at most three decimal places");
  if (!Number.isSafeInteger(rateMinor) || rateMinor <= 0)
    throw fail.invalid("Enter a positive rate in minor currency units");
  let amount: number;
  try {
    amount = calculateMeteredAmount("0", String(quantity), rateMinor).amountMinor;
  } catch {
    throw fail.invalid("The calculated invoice line exceeds the supported monetary range");
  }
  if (amount <= 0) throw fail.invalid("Each service charge must be at least one minor currency unit");
  return amount;
}
