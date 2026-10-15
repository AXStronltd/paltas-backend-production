/*
 * Provider callback translators. Each turns a provider's own payload into the facts the core needs (who paid what,
 * for which reference, did it succeed). They decide NOTHING about whether something is paid: the translated event goes
 * through payments.receive and the owning handler's exact amount and currency rules, after the route layer checked
 * the signature.
 *
 *   M-Pesa Daraja:  STK push result callback (Body.stkCallback) and C2B confirmation (TransID, BillRefNumber …).
 *                   Amounts are Kenya shillings in major units ("1500.00"); they must convert exactly to cents.
 *   Card PSP:       a generic webhook — { id, type: payment.succeeded | payment.failed | refund.succeeded,
 *                   data: { id, amount (minor units), currency, reference } }.
 */
import type { paymentProviders, PaymentEvent, z } from "@paltas/contracts";
import { decimalsOf } from "../../../lib/money.js";

type Stk = z.infer<typeof paymentProviders.MpesaStkCallback>;
type C2b = z.infer<typeof paymentProviders.MpesaC2bConfirmation>;
type Card = z.infer<typeof paymentProviders.CardWebhookEvent>;

/** M-Pesa in Kenya settles in shillings. */
export const MPESA_CURRENCY = "KES";

/** "1500", "1500.5", "1500.50" → minor units; anything that is not an exact amount → null (never rounded). */
export function exactMinor(value: string | number | undefined, currency: string): number | null {
  if (value === undefined) return null;
  const s = typeof value === "number" ? String(value) : value.trim();
  const d = decimalsOf(currency);
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(s);
  const frac = m?.[2] ?? "";
  // more decimals than the currency has are allowed only as trailing zeros ("10.00" for a 0-decimal currency)
  if (!m || /[1-9]/.test(frac.slice(d))) return null;
  const minor = Number(m[1]) * 10 ** d + Number(frac.slice(0, d).padEnd(d, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** What a provider callback says, before it is tied to what is owed. */
export interface Translated {
  kind: "mpesa_stk" | "mpesa_c2b" | "card";
  /** The provider's id for this event (used to make delivery idempotent). */
  externalId: string;
  /** How to find what it pays: a quoted reference, or an M-Pesa STK checkout id. */
  lookup: { by: "reference" | "mpesaCheckout"; value: string };
  status: PaymentEvent["status"] | "ignored";
  /** Null when the provider does not state it (a failed STK push) — the owed amount is used then. */
  amountMinor: number | null;
  currency: string;
  /** Receipt or transaction reference shown to people. */
  ref: string;
  reason?: string;
  /** Why an amount could not be read, if so. */
  problem?: string;
}

export function isStk(body: Stk | C2b): body is Stk {
  return "Body" in body;
}

export function translateMpesa(body: Stk | C2b): Translated {
  if (isStk(body)) {
    const cb = body.Body.stkCallback;
    const item = (name: string) => cb.CallbackMetadata?.Item.find((i) => i.Name === name)?.Value;
    const ok = cb.ResultCode === 0;
    const amount = ok ? exactMinor(item("Amount"), MPESA_CURRENCY) : null;
    const receipt = ok ? String(item("MpesaReceiptNumber") ?? "") : "";
    return {
      kind: "mpesa_stk",
      externalId: receipt || cb.CheckoutRequestID,
      lookup: { by: "mpesaCheckout", value: cb.CheckoutRequestID },
      status: ok ? "succeeded" : "failed",
      amountMinor: amount,
      currency: MPESA_CURRENCY,
      ref: receipt || cb.CheckoutRequestID,
      ...(ok ? {} : { reason: `M-Pesa result ${cb.ResultCode}: ${cb.ResultDesc}` }),
      ...(ok && amount === null ? { problem: "The callback has no exact amount" } : {}),
      ...(ok && !receipt ? { problem: "The callback has no M-Pesa receipt number" } : {}),
    };
  }
  const amount = exactMinor(body.TransAmount, MPESA_CURRENCY);
  return {
    kind: "mpesa_c2b",
    externalId: body.TransID,
    lookup: { by: "reference", value: body.BillRefNumber.trim() },
    status: "succeeded",
    amountMinor: amount,
    currency: MPESA_CURRENCY,
    ref: body.TransID,
    ...(amount === null ? { problem: `TransAmount "${String(body.TransAmount)}" is not an exact amount` } : {}),
  };
}

const CARD_STATUS: Record<string, PaymentEvent["status"]> = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
  "refund.succeeded": "refunded",
};

export function translateCard(ev: Card): Translated {
  return {
    kind: "card",
    externalId: ev.id,
    lookup: { by: "reference", value: ev.data.reference.trim() },
    status: CARD_STATUS[ev.type] ?? "ignored",
    amountMinor: ev.data.amount,
    currency: ev.data.currency.toUpperCase(),
    ref: ev.data.id,
    ...(ev.data.failure_reason ? { reason: ev.data.failure_reason } : {}),
  };
}
