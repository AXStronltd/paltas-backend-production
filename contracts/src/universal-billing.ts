/** Shared quote contracts. Quotes do not authorise issuance, payment or ledger posting. */
import { z } from "zod";
import { Currency, MinorUnits } from "./common.js";

const Amount = MinorUnits.nonnegative();
const BasisPoints = z.number().int().min(0).max(10_000);
export const Quantity = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const Tier = z.object({ upTo: Quantity.nullable(), rateMinor: Amount }).strict();
export const Pricing = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amountMinor: Amount }).strict(),
  z.object({ kind: z.literal("custom"), amountMinor: Amount }).strict(),
  z
    .object({
      kind: z.literal("quantity"),
      unit: z.enum(["unit", "night", "guest", "booking", "hour", "day", "month", "square_metre"]),
      quantity: Quantity,
      rateMinor: Amount,
    })
    .strict(),
  z.object({ kind: z.literal("metered"), previous: Quantity, current: Quantity, rateMinor: Amount }).strict(),
  z.object({ kind: z.literal("tiered"), quantity: Quantity, tiers: z.array(Tier).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("percentage"), baseMinor: Amount, basisPoints: BasisPoints }).strict(),
]);
export const QuoteLineInput = z
  .object({
    categoryId: z.string().min(1).max(100),
    categoryVersion: z.number().int().positive(),
    description: z.string().trim().min(1).max(500),
    classification: z.enum(["customer_service", "building_assessment", "operating_expense"]),
    currency: Currency,
    pricing: Pricing,
    minimumMinor: Amount.optional(),
    maximumMinor: Amount.optional(),
    discount: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("amount"), amountMinor: Amount }).strict(),
        z.object({ kind: z.literal("percentage"), basisPoints: BasisPoints }).strict(),
      ])
      .optional(),
    tax: z
      .object({
        mode: z.enum(["exclusive", "inclusive"]),
        components: z
          .array(
            z
              .object({
                code: z.string().min(1).max(100),
                basisPoints: BasisPoints,
              })
              .strict(),
          )
          .max(10),
      })
      .strict(),
  })
  .strict();
export const QuoteInput = z
  .object({
    currency: Currency,
    lines: z.array(QuoteLineInput).min(1).max(500),
  })
  .strict();
export type QuoteLineInput = z.infer<typeof QuoteLineInput>;
export type QuoteInput = z.infer<typeof QuoteInput>;
export interface QuotedLine {
  /** Detached snapshot: a later template/default change cannot change this calculation. */
  snapshot: QuoteLineInput;
  grossBeforeDiscountMinor: number;
  discountMinor: number;
  netMinor: number;
  taxes: { code: string; amountMinor: number }[];
  taxMinor: number;
  totalMinor: number;
}
export interface Quote {
  calculationVersion: 1;
  currency: string;
  lines: QuotedLine[];
  subtotalMinor: number;
  discountMinor: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
}
