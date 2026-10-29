/** KulmiPay transport. Only client-owned credentials supplied by the server may reach this module. */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "@paltas/contracts";
import { exactMinor } from "../adapters/translate.js";

export type KulmiEnvironment = "sandbox" | "live";
export interface KulmiCredentials {
  environment: KulmiEnvironment;
  secretKey: string;
  walletId: string;
}
export type KulmiTransport = (url: string, init: RequestInit) => Promise<Response>;
const Invoice = z.object({
  invoice_id: z.string().min(1).max(140),
  state: z.enum(["PENDING", "PROCESSING", "FAILED", "CANCELED", "PARTIAL", "COMPLETE", "RETRY"]),
  provider: z.enum(["M-PESA", "PESALINK"]),
  currency: z.literal("KES"),
  value: z.union([z.string(), z.number()]),
  api_ref: z.string().nullable().optional(),
  charges: z.union([z.string(), z.number()]).optional(),
  net_amount: z.union([z.string(), z.number()]).optional(),
  clearing_status: z.string().optional(),
  mpesa_reference: z.string().max(200).optional(),
  updated_at: z.string().datetime({ offset: true }).nullable().optional(),
});
export type KulmiInvoice = z.infer<typeof Invoice>;
export interface KulmiExpected {
  invoiceId: string;
  reference: string;
  amountMinor: number;
  provider: "M-PESA" | "PESALINK";
}
export interface KulmiCollection {
  invoiceId: string;
  state: KulmiInvoice["state"];
  provider: "M-PESA" | "PESALINK";
  amountMinor: number;
  feeMinor: number | null;
  netMinor: number | null;
  clearingStatus: string | null;
  receiptReference: string | null;
  /** Provider COMPLETE is collection confirmation, never bank settlement. */
  confirmed: boolean;
  confirmedAt: string | null;
}

export class KulmiPayError extends Error {
  constructor(public readonly code: "configuration" | "network" | "provider" | "response" | "mismatch") {
    super(
      {
        configuration: "KulmiPay connection is not configured correctly",
        network: "KulmiPay did not confirm this request; do not retry collection automatically",
        provider: "KulmiPay could not complete the request",
        response: "KulmiPay returned an unsupported response",
        mismatch: "KulmiPay payment details do not match this collection",
      }[code],
    );
  }
}
function validate(c: KulmiCredentials) {
  if (
    !/^ISSecretKey_(test|live)_[A-Za-z0-9_-]+$/.test(c.secretKey) ||
    !c.secretKey.startsWith(`ISSecretKey_${c.environment === "live" ? "live" : "test"}_`) ||
    !/^[A-Za-z0-9_-]{1,140}$/.test(c.walletId)
  )
    throw new KulmiPayError("configuration");
}
const major = (minor: number) => {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new KulmiPayError("configuration");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
};
export function verifyKulmiChallenge(expected: string, received: unknown): boolean {
  if (expected.length < 32 || expected.length > 256 || typeof received !== "string" || received.length > 256)
    return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(expected), digest(received));
}
export function checkedKulmiCollection(raw: unknown, expected: KulmiExpected): KulmiCollection {
  const parsed = Invoice.safeParse(raw);
  if (!parsed.success) throw new KulmiPayError("response");
  const i = parsed.data,
    amount = exactMinor(i.value, "KES"),
    fee = i.charges === undefined ? null : exactMinor(i.charges, "KES"),
    net = i.net_amount === undefined ? null : exactMinor(i.net_amount, "KES");
  if (
    i.invoice_id !== expected.invoiceId ||
    i.api_ref !== expected.reference ||
    i.provider !== expected.provider ||
    amount !== expected.amountMinor ||
    amount <= 0
  )
    throw new KulmiPayError("mismatch");
  if (
    (i.charges !== undefined && fee === null) ||
    (i.net_amount !== undefined && net === null) ||
    (fee !== null && fee > amount) ||
    (net !== null && net > amount) ||
    (fee !== null && net !== null && fee !== amount - net)
  )
    throw new KulmiPayError("mismatch");
  return {
    invoiceId: i.invoice_id,
    state: i.state,
    provider: i.provider,
    amountMinor: amount,
    feeMinor: fee,
    netMinor: net,
    clearingStatus: i.clearing_status ?? null,
    receiptReference: i.mpesa_reference?.trim().toUpperCase() || null,
    confirmed: i.state === "COMPLETE",
    confirmedAt: i.state === "COMPLETE" ? (i.updated_at ?? null) : null,
  };
}

export function kulmiPayClient(transport: KulmiTransport = fetch) {
  async function call(c: KulmiCredentials, path: string, body?: unknown) {
    validate(c);
    const host = c.environment === "live" ? "https://app.kulmipay.com" : "https://sandbox.kulmipay.com";
    let r: Response;
    try {
      r = await transport(host + "/api/v1/" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${c.secretKey}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new KulmiPayError("network");
    }
    // Never propagate provider error bodies: they can contain credentials or personal information.
    if (!r.ok) throw new KulmiPayError("provider");
    const reader = r.body?.getReader();
    if (!reader) throw new KulmiPayError("response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 256000) {
          await reader.cancel();
          throw new KulmiPayError("response");
        }
        chunks.push(part.value);
      }
    } catch {
      throw new KulmiPayError("response");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new KulmiPayError("response");
    }
  }
  return {
    async verifyWallet(c: KulmiCredentials) {
      const raw = await call(c, `wallets/${encodeURIComponent(c.walletId)}/`);
      const r = z.object({ wallet_id: z.string(), currency: z.literal("KES") }).safeParse(raw);
      if (!r.success || r.data.wallet_id !== c.walletId) throw new KulmiPayError("mismatch");
    },
    async initiate(
      c: KulmiCredentials,
      b: { provider: "M-PESA" | "PESALINK"; amountMinor: number; reference: string; phone?: string },
    ) {
      if (!/^[A-Za-z0-9_-]{1,140}$/.test(b.reference)) throw new KulmiPayError("configuration");
      // KulmiPay rounds STK amounts up to whole shillings. Refuse fractions rather than overcharging.
      if (b.provider === "M-PESA" && (!/^254[17]\d{8}$/.test(b.phone ?? "") || b.amountMinor % 100 !== 0))
        throw new KulmiPayError("configuration");
      const body = {
        amount: major(b.amountMinor),
        api_ref: b.reference,
        wallet_id: c.walletId,
        ...(b.provider === "M-PESA"
          ? { phone_number: b.phone, mobile_tarrif: "BUSINESS-PAYS" }
          : { method: "PESALINK", currency: "KES", bank_tarrif: "BUSINESS-PAYS" }),
      };
      const raw = await call(c, b.provider === "M-PESA" ? "payment/mpesa-stk-push/" : "payment/collection/", body);
      const result = z
        .object({ invoice: z.object({ invoice_id: z.string().optional(), id: z.string().optional() }).passthrough() })
        .safeParse(raw);
      if (!result.success) throw new KulmiPayError("response");
      const invoiceId = result.data.invoice.invoice_id ?? result.data.invoice.id;
      if (!invoiceId) throw new KulmiPayError("response");
      return checkedKulmiCollection(
        { ...result.data.invoice, invoice_id: invoiceId },
        { invoiceId, reference: b.reference, amountMinor: b.amountMinor, provider: b.provider },
      );
    },
    async status(c: KulmiCredentials, expected: KulmiExpected) {
      const raw = await call(c, "payment/status/", { invoice_id: expected.invoiceId });
      const r = z.object({ invoice: z.unknown() }).safeParse(raw);
      if (!r.success) throw new KulmiPayError("response");
      return checkedKulmiCollection(r.data.invoice, expected);
    },
  };
}
