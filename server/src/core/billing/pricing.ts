/** Pure calculation only: no database, entitlement decisions, FX, provider calls or postings. */
import { universalBilling as billing } from "@paltas/contracts";

const SCALE = 1_000_000n;
const BP = 10_000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function quantity(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
}
function rounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}
function safe(value: bigint): number {
  if (value < 0n || value > MAX) throw new Error("Calculated amount exceeds supported minor-unit range");
  return Number(value);
}
function baseAmount(pricing: billing.QuoteLineInput["pricing"]): bigint {
  switch (pricing.kind) {
    case "fixed":
    case "custom":
      return BigInt(pricing.amountMinor);
    case "quantity":
      return rounded(quantity(pricing.quantity) * BigInt(pricing.rateMinor), SCALE);
    case "percentage":
      return rounded(BigInt(pricing.baseMinor) * BigInt(pricing.basisPoints), BP);
    case "metered": {
      const usage = quantity(pricing.current) - quantity(pricing.previous);
      if (usage < 0n) throw new Error("Current meter reading must not be below previous reading");
      return rounded(usage * BigInt(pricing.rateMinor), SCALE);
    }
    case "tiered": {
      let previous = 0n,
        numerator = 0n;
      const usage = quantity(pricing.quantity);
      for (let i = 0; i < pricing.tiers.length; i++) {
        const tier = pricing.tiers[i];
        if (!tier) throw new Error("Missing pricing tier");
        if (tier.upTo === null && i !== pricing.tiers.length - 1) {
          throw new Error("Only the final pricing tier may be unbounded");
        }
        const ceiling = tier.upTo === null ? null : quantity(tier.upTo);
        if (ceiling !== null && ceiling <= previous) throw new Error("Tier limits must be strictly increasing");
        const end = ceiling === null || usage < ceiling ? usage : ceiling;
        if (end > previous) numerator += (end - previous) * BigInt(tier.rateMinor);
        if (ceiling !== null) previous = ceiling;
      }
      const last = pricing.tiers[pricing.tiers.length - 1];
      if (!last) throw new Error("At least one pricing tier is required");
      if (last.upTo !== null && usage > quantity(last.upTo)) throw new Error("Quantity exceeds final pricing tier");
      return rounded(numerator, SCALE);
    }
  }
}
/** Proportional taxes use largest remainders, preserving the exact rounded total. */
function splitTax(total: bigint, components: billing.QuoteLineInput["tax"]["components"]): bigint[] {
  const denominator = components.reduce((s, c) => s + BigInt(c.basisPoints), 0n);
  if (denominator === 0n) return components.map(() => 0n);
  const values = components.map((c, i) => ({
    i,
    amount: (total * BigInt(c.basisPoints)) / denominator,
    remainder: (total * BigInt(c.basisPoints)) % denominator,
  }));
  let remainder = total - values.reduce((s, v) => s + v.amount, 0n);
  const ordered = [...values].sort((a, b) =>
    a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1,
  );
  for (const value of ordered) {
    if (remainder === 0n) break;
    value.amount += 1n;
    remainder -= 1n;
  }
  return values.map((v) => v.amount);
}
function quoteLine(line: billing.QuoteLineInput): billing.QuotedLine {
  if (line.classification === "operating_expense") {
    throw new Error(
      "An operating expense cannot be issued as a customer charge; create a separately authorised charge",
    );
  }
  if (line.minimumMinor !== undefined && line.maximumMinor !== undefined && line.minimumMinor > line.maximumMinor) {
    throw new Error("Minimum charge exceeds maximum charge");
  }
  if (new Set(line.tax.components.map((c) => c.code)).size !== line.tax.components.length) {
    throw new Error("Tax component codes must be unique per line");
  }
  let gross = baseAmount(line.pricing);
  // Limits apply before discount and tax; never silently cap an overflowing calculation.
  safe(gross);
  if (line.minimumMinor !== undefined && gross < BigInt(line.minimumMinor)) gross = BigInt(line.minimumMinor);
  if (line.maximumMinor !== undefined && gross > BigInt(line.maximumMinor)) gross = BigInt(line.maximumMinor);
  const discount = !line.discount
    ? 0n
    : line.discount.kind === "amount"
      ? BigInt(line.discount.amountMinor)
      : rounded(gross * BigInt(line.discount.basisPoints), BP);
  if (discount > gross) throw new Error("Discount exceeds the line amount");
  const discounted = gross - discount;
  const rate = line.tax.components.reduce((s, c) => s + BigInt(c.basisPoints), 0n);
  if (rate > BP) throw new Error("Combined tax rate exceeds supported 100 percent");
  const tax = rounded(discounted * rate, line.tax.mode === "inclusive" ? BP + rate : BP);
  const net = line.tax.mode === "inclusive" ? discounted - tax : discounted;
  const shares = splitTax(tax, line.tax.components);
  return {
    snapshot: line,
    grossBeforeDiscountMinor: safe(gross),
    discountMinor: safe(discount),
    netMinor: safe(net),
    taxes: line.tax.components.map((c, i) => ({ code: c.code, amountMinor: safe(shares[i] ?? 0n) })),
    taxMinor: safe(tax),
    totalMinor: safe(net + tax),
  };
}
/** Amounts are currency minor units. No inferred tax, exchange rate or legal authority. */
export function calculateQuote(input: billing.QuoteInput): billing.Quote {
  const parsed = billing.QuoteInput.parse(input);
  const lines = parsed.lines.map((line, index) => {
    try {
      if (line.currency !== parsed.currency)
        throw new Error("Line currency differs from quote currency; currency conversion is not implicit");
      return quoteLine(line);
    } catch (error) {
      throw new Error(`Line ${index + 1}: ${error instanceof Error ? error.message : "Invalid calculation"}`, {
        cause: error,
      });
    }
  });
  const sum = (field: "grossBeforeDiscountMinor" | "discountMinor" | "netMinor" | "taxMinor" | "totalMinor") =>
    safe(lines.reduce((s, l) => s + BigInt(l[field]), 0n));
  return {
    calculationVersion: 1,
    currency: parsed.currency,
    lines,
    subtotalMinor: sum("grossBeforeDiscountMinor"),
    discountMinor: sum("discountMinor"),
    netMinor: sum("netMinor"),
    taxMinor: sum("taxMinor"),
    totalMinor: sum("totalMinor"),
  };
}
