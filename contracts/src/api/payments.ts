// Payment provider events. A payment counts ONLY when it arrives here with a valid signature, or when PALTAS staff
// record it by hand with the bank reference (admin.recordReceipt). A browser returning to a "success" page never
// marks anything paid.
//
// Signature header:  X-Paltas-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
// Each provider adapter (M-Pesa Daraja, card processor, bank) translates its own callback into this signed shape.
import { z } from "zod";
import { Currency, MinorUnits } from "../common.js";
import { endpoint } from "../endpoint.js";

export const SIGNATURE_HEADER = "x-paltas-signature";
/** Signatures older than this are refused (replay protection). */
export const SIGNATURE_MAX_AGE_SECONDS = 300;

export const PaymentEventStatus = z.enum(["succeeded", "failed", "pending", "refunded"]);

export const PaymentEvent = z.object({
  /** The provider's own event id. Sending the same id twice changes nothing (idempotent). */
  id: z.string().min(1).max(200),
  /** What the payment is for. Core handles "subscription.payment"; products register their own types. */
  type: z.string().min(1).max(100),
  status: PaymentEventStatus,
  amountMinor: MinorUnits,
  currency: Currency,
  ref: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
  /** For subscription.payment: the PALTAS subscription invoice. */
  invoiceId: z.string().optional(),
  /** Product-specific fields (e.g. tenant, sale). Each product's handler validates its own. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentEvent = z.infer<typeof PaymentEvent>;

export const PaymentEventResult = z.object({
  duplicate: z.boolean(),
  result: z.string(),
  invoiceId: z.string().nullable(),
  receiptId: z.string().nullable(),
});

export const receivePaymentEvent = endpoint({
  id: "webhooks.payment",
  method: "POST",
  path: "/api/v1/webhooks/payments/:provider",
  auth: "signed-webhook",
  summary: "Receive a signed payment event from a provider adapter",
  params: z.object({ provider: z.string().regex(/^[a-z0-9_-]{2,40}$/) }),
  body: PaymentEvent,
  response: PaymentEventResult,
});
