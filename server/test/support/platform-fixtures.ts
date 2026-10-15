/*
 * Helpers for the platform tests (scheduler, notifications, provider adapters, Super Admin operations):
 *   - more PALTAS staff (a second Super Admin, a support user) — separation of duties needs two people;
 *   - a test-only stand-in product that owns a payment type and a scheduled job, registered exactly like a real one;
 *   - provider callback FIXTURES.
 *
 * FIXTURES — written by hand from the public documentation shapes of Safaricom Daraja (STK push result callback,
 * C2B confirmation) and of a generic card-processor webhook. They were NOT recorded from a live provider: no live
 * connection exists (BLOCKED, needs credentials).
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../dist/config.js";
import { createUser } from "../../dist/core/identity/identity.service.js";
import { newTotpSecret, totp } from "../../dist/core/identity/totp.js";
import { signPayload } from "../../dist/core/payments/signature.js";
import type { JobRunContext } from "../../dist/core/scheduler/types.js";
import type { ProductModule } from "../../dist/products/registry.js";
import type { TestServer } from "./test-server.js";

/** The default settings (to override one nested setting, e.g. { scheduler: { ...DEFAULTS.scheduler, maxAttempts: 3 } }). */
export const DEFAULTS = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused" });

/** Another PALTAS staff member, signed in with their authenticator code. */
export async function staffMember(S: TestServer, role: "super_admin" | "support" = "super_admin") {
  const secret = newTotpSecret();
  const password = "Staff-Pass-" + randomBytes(6).toString("hex");
  const email = `${role}+${randomBytes(3).toString("hex")}@paltas.test`;
  const { id } = await createUser(S.app.ctx.db, {
    email,
    name: role,
    password,
    staffRole: role,
    mfaSecretSealed: S.app.ctx.secrets.seal(secret),
  });
  const s = await S.login(email, password, totp(secret));
  return { ...s, userId: id, email };
}

/** POST a JSON body signed like a provider relay would (X-Paltas-Signature with that provider's secret). */
export function signedPost(S: TestServer, path: string, body: unknown, secret: string, t?: number) {
  const raw = JSON.stringify(body);
  return S.raw("POST", path, raw, null, {
    "X-Paltas-Signature": signPayload(secret, raw, t ?? Math.floor(Date.now() / 1000)),
  });
}

/**
 * Test-only stand-in for a product (registered as "property"): it owns the payment type "rent.test" — applied only
 * when amount and currency equal what the payment reference says is due — and the scheduled job "test.night_audit",
 * whose behaviour each test controls.
 */
export function standInProduct() {
  const calls: JobRunContext[] = [];
  const behaviour: { fail: number; delayMs: number; finished: number } = { fail: 0, delayMs: 0, finished: 0 };
  const module: ProductModule = {
    product: "property",
    routes: () => [],
    paymentHandlers: {
      "rent.test": async (_t, ev) => {
        const due = Number(ev.data?.dueMinor);
        const orgId = String(ev.data?.orgId ?? "");
        let result: string;
        if (ev.status === "failed") result = "Payment failed — nothing applied";
        else if (ev.status !== "succeeded") result = "Ignored — status " + ev.status;
        else if (ev.amountMinor !== due || ev.currency !== ev.data?.currency)
          result = "Held for review — amount or currency does not match what is due";
        else result = "Applied — rent paid";
        return { result, orgId: orgId || null, targetId: String(ev.data?.paymentReference ?? "") };
      },
    },
    scheduledJobs: () => [
      {
        key: "test.night_audit",
        label: "Night audit (test stand-in)",
        scope: "org",
        async run(job) {
          calls.push(job);
          if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
          if (behaviour.fail > 0) {
            behaviour.fail--;
            throw new Error("Audit refused: a cashier shift is still open");
          }
          behaviour.finished++;
          return { summary: `Night audit for ${job.localDate} completed` };
        },
      },
    ],
  };
  return { module, calls, behaviour };
}

// ---------------------------------------------------------------- FIXTURES (documentation shapes, not live data)

/** Daraja STK push result — success (shape per Safaricom Daraja "Lipa na M-Pesa Online" callback documentation). */
export function stkSuccess(checkoutRequestId: string, amountMajor: number | string, receipt: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amountMajor },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "TransactionDate", Value: 20261011102115 },
            { Name: "PhoneNumber", Value: 254708374149 },
          ],
        },
      },
    },
  };
}

/** Daraja STK push result — the customer cancelled (no CallbackMetadata on failures). */
export function stkCancelled(checkoutRequestId: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-2",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 1032,
        ResultDesc: "Request cancelled by user",
      },
    },
  };
}

/** Daraja C2B confirmation (Pay Bill), as documented. */
export function c2bConfirmation(transId: string, billRef: string, amount: string) {
  return {
    TransactionType: "Pay Bill",
    TransID: transId,
    TransTime: "20261011063845",
    TransAmount: amount,
    BusinessShortCode: "600638",
    BillRefNumber: billRef,
    InvoiceNumber: "",
    OrgAccountBalance: "49197.00",
    ThirdPartyTransID: "",
    MSISDN: "2547*****149",
    FirstName: "John",
    MiddleName: "",
    LastName: "Doe",
  };
}

/** Generic card processor webhook. */
export function cardWebhook(
  id: string,
  type: string,
  o: { amount: number; currency: string; reference: string; paymentId?: string; failure?: string },
) {
  return {
    id,
    type,
    created: 1_760_000_000,
    data: {
      id: o.paymentId ?? "pay_" + id,
      amount: o.amount,
      currency: o.currency,
      reference: o.reference,
      failure_reason: o.failure ?? null,
    },
  };
}
