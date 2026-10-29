import { expect, it } from "vitest";
import {
  translatedProblem,
  translateCard,
  translateMpesa,
  type Translated,
} from "../dist/core/payments/adapters/translate.js";
const base: Translated = {
  kind: "card",
  externalId: "evt_example",
  lookup: { by: "reference", value: "invoice_example" },
  status: "succeeded",
  amountMinor: 120000,
  currency: "KES",
  ref: "transaction_example",
};
it("confirmed events require explicit positive precise money and identifiers", () => {
  expect(translatedProblem(base)).toBeNull();
  for (const amountMinor of [null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    expect(translatedProblem({ ...base, amountMinor })).not.toBeNull();
  expect(translatedProblem({ ...base, externalId: " " })).not.toBeNull();
  expect(translatedProblem({ ...base, ref: " " })).not.toBeNull();
  expect(translatedProblem({ ...base, currency: "kes" })).not.toBeNull();
});
it("pending/processing remains pending rather than becoming a receipt", () => {
  for (const type of ["payment.pending", "payment.processing"]) {
    const r = translateCard({
      id: "event_pending",
      type,
      data: { id: "payment_pending", amount: 120000, currency: "kes", reference: "invoice_example" },
    });
    expect(r.status).toBe("pending");
    expect(translatedProblem(r)).toBeNull();
  }
  expect(translatedProblem({ ...base, status: "failed", amountMinor: null })).toBeNull();
});
it("unknown events remain ignored and adapter-specific problems are retained", () => {
  expect(translatedProblem({ ...base, status: "ignored", amountMinor: null })).toBeNull();
  expect(translatedProblem({ ...base, problem: "Missing meter reference" })).toBe("Missing meter reference");
});
it("M-Pesa success without valid receipt or positive exact amount is held", () => {
  for (const amount of [0, -1, 1.005]) {
    const r = translateMpesa({
      Body: {
        stkCallback: {
          MerchantRequestID: "merchant",
          CheckoutRequestID: "checkout",
          ResultCode: 0,
          ResultDesc: "Success",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: amount },
              { Name: "MpesaReceiptNumber", Value: "receipt" },
            ],
          },
        },
      },
    });
    expect(translatedProblem(r)).not.toBeNull();
  }
});
