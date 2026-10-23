import { describe, expect, it } from "vitest";
import type { universalBilling as billing } from "@paltas/contracts";
import { calculateQuote } from "../dist/core/billing/pricing.js";

const line = (overrides: Partial<billing.QuoteLineInput> = {}): billing.QuoteLineInput => ({
  categoryId: "parking",
  categoryVersion: 1,
  description: "Parking",
  classification: "customer_service",
  currency: "KES",
  pricing: { kind: "fixed", amountMinor: 500_000 },
  tax: { mode: "exclusive", components: [] },
  ...overrides,
});
const quote = (...lines: billing.QuoteLineInput[]) => calculateQuote({ currency: "KES", lines });

describe("shared billing quote calculations (no financial posting)", () => {
  it("calculates the five-service example without mixing classifications", () => {
    const result = quote(
      ...[60_000, 2_500, 3_000, 2_000, 5_000].map((amount, i) =>
        line({
          categoryId: `service-${i}`,
          pricing: { kind: "fixed", amountMinor: amount * 100 },
        }),
      ),
    );
    expect(result.totalMinor).toBe(7_250_000);
    expect(result.lines).toHaveLength(5);
    expect(result.netMinor + result.taxMinor).toBe(result.totalMinor);
  });
  it.each(["unit", "night", "guest", "booking", "hour", "day", "month", "square_metre"] as const)(
    "supports exact fractional %s quantities",
    (unit) => {
      expect(quote(line({ pricing: { kind: "quantity", unit, quantity: "1.125", rateMinor: 100 } })).totalMinor).toBe(
        113,
      );
    },
  );
  it("calculates metered usage and rejects backwards readings", () => {
    expect(
      quote(line({ pricing: { kind: "metered", previous: "20.1", current: "22.3", rateMinor: 150 } })).totalMinor,
    ).toBe(330);
    expect(() => quote(line({ pricing: { kind: "metered", previous: "23", current: "22", rateMinor: 150 } }))).toThrow(
      "Line 1: Current meter",
    );
  });
  it("calculates graduated tiers, including fractional quantities", () => {
    expect(
      quote(
        line({
          pricing: {
            kind: "tiered",
            quantity: "12.5",
            tiers: [
              { upTo: "10", rateMinor: 100 },
              { upTo: null, rateMinor: 200 },
            ],
          },
        }),
      ).totalMinor,
    ).toBe(1500);
  });
  it("validates all tiers even when consumption is below the first tier", () => {
    expect(() =>
      quote(
        line({
          pricing: {
            kind: "tiered",
            quantity: "1",
            tiers: [
              { upTo: "10", rateMinor: 100 },
              { upTo: "9", rateMinor: 200 },
            ],
          },
        }),
      ),
    ).toThrow("strictly increasing");
    expect(() =>
      quote(
        line({
          pricing: {
            kind: "tiered",
            quantity: "1",
            tiers: [
              { upTo: null, rateMinor: 100 },
              { upTo: null, rateMinor: 200 },
            ],
          },
        }),
      ),
    ).toThrow("Only the final");
    expect(() =>
      quote(line({ pricing: { kind: "tiered", quantity: "11", tiers: [{ upTo: "10", rateMinor: 100 }] } })),
    ).toThrow("exceeds final");
  });
  it("supports explicit percentage basis and custom amounts", () => {
    expect(quote(line({ pricing: { kind: "percentage", baseMinor: 12_345, basisPoints: 250 } })).totalMinor).toBe(309);
    expect(quote(line({ pricing: { kind: "custom", amountMinor: 123 } })).totalMinor).toBe(123);
  });
  it("applies bounds then discounts then exclusive tax", () => {
    const result = quote(
      line({
        minimumMinor: 600_000,
        maximumMinor: 700_000,
        discount: { kind: "percentage", basisPoints: 1000 },
        tax: { mode: "exclusive", components: [{ code: "approved-tax", basisPoints: 1600 }] },
      }),
    );
    expect(result.subtotalMinor).toBe(600_000);
    expect(result.discountMinor).toBe(60_000);
    expect(result.netMinor).toBe(540_000);
    expect(result.taxMinor).toBe(86_400);
    expect(result.totalMinor).toBe(626_400);
  });
  it("preserves inclusive totals and distributes rounding deterministically", () => {
    const result = quote(
      line({
        pricing: { kind: "fixed", amountMinor: 12 },
        tax: {
          mode: "inclusive",
          components: [
            { code: "a", basisPoints: 500 },
            { code: "b", basisPoints: 500 },
          ],
        },
      }),
    ).lines[0]!;
    expect(result.netMinor).toBe(11);
    expect(result.taxMinor).toBe(1);
    expect(result.totalMinor).toBe(12);
    expect(result.taxes).toEqual([
      { code: "a", amountMinor: 1 },
      { code: "b", amountMinor: 0 },
    ]);
  });
  it("rejects expense-to-customer billing and implicit currency conversion", () => {
    expect(() => quote(line({ classification: "operating_expense" }))).toThrow("operating expense");
    expect(() => quote(line({ currency: "USD" }))).toThrow("Line currency");
    expect(quote(line({ classification: "building_assessment" })).totalMinor).toBe(500_000);
  });
  it("rejects invalid limits, discounts and tax configuration", () => {
    expect(() => quote(line({ minimumMinor: 100, maximumMinor: 50 }))).toThrow("Minimum charge");
    expect(() => quote(line({ discount: { kind: "amount", amountMinor: 500_001 } }))).toThrow("Discount exceeds");
    expect(() =>
      quote(
        line({
          tax: {
            mode: "exclusive",
            components: [
              { code: "a", basisPoints: 500 },
              { code: "a", basisPoints: 500 },
            ],
          },
        }),
      ),
    ).toThrow("unique");
    expect(() =>
      quote(
        line({
          tax: {
            mode: "exclusive",
            components: [
              { code: "a", basisPoints: 6000 },
              { code: "b", basisPoints: 6000 },
            ],
          },
        }),
      ),
    ).toThrow("100 percent");
  });
  it.each(["-1", "1e3", "1,000", "01", "1.1234567", "Infinity"])("rejects unsafe quantity %s", (quantity) => {
    expect(() => quote(line({ pricing: { kind: "quantity", unit: "unit", quantity, rateMinor: 1 } }))).toThrow();
  });
  it("rejects overflow in lines and aggregate totals", () => {
    expect(() =>
      quote(line({ pricing: { kind: "quantity", unit: "unit", quantity: "2", rateMinor: Number.MAX_SAFE_INTEGER } })),
    ).toThrow("range");
    expect(() => quote(line({ pricing: { kind: "fixed", amountMinor: Number.MAX_SAFE_INTEGER } }), line())).toThrow(
      "range",
    );
  });
  it("detaches price/tax snapshots from future input edits", () => {
    const input = line();
    const result = quote(input);
    input.description = "Changed";
    input.pricing = { kind: "fixed", amountMinor: 1 };
    expect(result.lines[0]!.snapshot.description).toBe("Parking");
    expect(result.totalMinor).toBe(500_000);
  });
  it("preserves every minor unit across varied tax combinations", () => {
    for (let amount = 0; amount < 250; amount++) {
      for (const mode of ["exclusive", "inclusive"] as const) {
        const result = quote(
          line({
            pricing: { kind: "fixed", amountMinor: amount },
            tax: {
              mode,
              components: [
                { code: "a", basisPoints: 733 },
                { code: "b", basisPoints: 1150 },
              ],
            },
          }),
        ).lines[0]!;
        expect(result.taxes.reduce((sum, t) => sum + t.amountMinor, 0)).toBe(result.taxMinor);
        expect(result.netMinor + result.taxMinor).toBe(result.totalMinor);
        if (mode === "inclusive") expect(result.totalMinor).toBe(amount);
      }
    }
  });
});
