// M-Pesa (Daraja STK result, C2B confirmation) and card PSP webhooks: translated into core payment events and decided
// ONLY by the core rules — a valid signature, then the exact amount and currency of what is owed. Payloads are
// FIXTURES written from public documentation shapes (see support/platform-fixtures.ts); no live provider exists.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exactMinor } from "../dist/core/payments/adapters/translate.js";
import {
  c2bConfirmation,
  cardWebhook,
  signedPost,
  staffMember,
  standInProduct,
  stkCancelled,
  stkSuccess,
} from "./support/platform-fixtures.js";
import { startServer, WEBHOOK_SECRET, type TestServer } from "./support/test-server.js";

const MPESA = "whsec_mpesa_" + randomBytes(12).toString("hex");
const CARDS = "whsec_cards_" + randomBytes(12).toString("hex");

describe("payment provider callbacks", () => {
  let S: TestServer;
  let orgId: string;
  let invoice: { id: string; totalMinor: number; currency: string };
  const stand = standInProduct();

  beforeAll(async () => {
    S = await startServer({
      products: [stand.module],
      config: { webhookSecrets: { testpay: WEBHOOK_SECRET, mpesa: MPESA, cardpsp: CARDS } },
    });
    const sa = await S.staff();
    orgId = (await S.newOrg({ name: "Nyali Apartments", trial: false })).orgId;
    invoice = await sa.api.admin.issueInvoice({ params: { orgId }, body: {} });
  });
  afterAll(() => S.close());

  const mpesa = (body: unknown, secret = MPESA, provider = "mpesa") =>
    signedPost(S, `/api/v1/webhooks/mpesa/${provider}`, body, secret);
  const card = (body: unknown, t?: number) => signedPost(S, "/api/v1/webhooks/cards/cardpsp", body, CARDS, t);
  const reference = (ref: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
    S.app.core.db.tx((t) =>
      S.app.core.providers.registerReference(t, {
        orgId,
        reference: ref,
        type: "rent.test",
        data: { dueMinor: amountMinor, currency: "KES", ...extra },
        amountMinor,
        currency: "KES",
      }),
    );
  const refStatus = async (ref: string) =>
    (await S.sql<{ status: string }>("SELECT status FROM payment_references WHERE reference = $1", [ref]))[0]?.status;
  const invoiceStatus = async () =>
    (await S.sql<{ status: string }>("SELECT status FROM billing_invoices WHERE id = $1", [invoice.id]))[0]?.status;

  it("amounts convert exactly or not at all", () => {
    expect(exactMinor("29000.00", "KES")).toBe(2_900_000);
    expect(exactMinor("29000.5", "KES")).toBe(2_900_050);
    expect(exactMinor(1, "KES")).toBe(100);
    expect(exactMinor("29000.005", "KES")).toBeNull();
    expect(exactMinor("-5", "KES")).toBeNull();
    expect(exactMinor("1e3", "KES")).toBeNull();
    expect(exactMinor("2500.00", "UGX")).toBe(2500);
    expect(exactMinor("2500.50", "UGX")).toBeNull();
  });

  it("M-Pesa C2B: only a signed callback counts; the amount must equal the invoice exactly", async () => {
    const major = (invoice.totalMinor / 100).toFixed(2);
    // no signature, a wrong secret, a provider without a secret: refused before anything is read
    expect(
      (await S.raw("POST", "/api/v1/webhooks/mpesa/mpesa", c2bConfirmation("RKT0001", invoice.id, major))).status,
    ).toBe(401);
    expect((await mpesa(c2bConfirmation("RKT0001", invoice.id, major), "not-the-secret")).status).toBe(401);
    expect((await mpesa(c2bConfirmation("RKT0001", invoice.id, major), MPESA, "otherpay")).status).toBe(404);
    expect(await S.sql("SELECT 1 FROM payment_events WHERE provider = 'mpesa'")).toEqual([]);

    // too little: held for review, invoice stays open
    const short = await mpesa(c2bConfirmation("RKT0002", invoice.id, "28000.00"));
    expect([short.status, short.body.ResultCode, short.body.outcome.result]).toEqual([
      200,
      0,
      "Held for review — amount or currency does not match the invoice",
    ]);
    expect(await invoiceStatus()).toBe("Open");
    // an amount that is not exact is never rounded: held, no payment event at all
    const odd = await mpesa(c2bConfirmation("RKT0003", invoice.id, "29000.005"));
    expect(odd.body.outcome).toBeNull();
    expect(await S.sql("SELECT 1 FROM payment_events WHERE id = 'mpesa:RKT0003'")).toEqual([]);
    // the account number in lower case still finds the invoice; exact amount → paid
    const paid = await mpesa(c2bConfirmation("RKT0004", invoice.id.toLowerCase(), major));
    expect(paid.body.outcome).toMatchObject({
      duplicate: false,
      result: "Applied — invoice paid",
      invoiceId: invoice.id,
    });
    expect(await invoiceStatus()).toBe("Paid");
    // delivered twice: nothing changes
    const again = await mpesa(c2bConfirmation("RKT0004", invoice.id, major));
    expect(again.body.outcome.duplicate).toBe(true);
    expect((await S.sql("SELECT 1 FROM billing_receipts WHERE invoice_id = $1", [invoice.id])).length).toBe(1);
    // every callback is kept as received, with its outcome
    const kept = await S.sql<{ external_id: string; result: string; payload: { TransAmount: string } }>(
      "SELECT external_id, result, payload FROM provider_callbacks WHERE provider = 'mpesa' ORDER BY id",
    );
    expect(kept.map((k) => k.external_id)).toEqual(["RKT0002", "RKT0003", "RKT0004", "RKT0004"]);
    expect(kept[1]!.result).toMatch(/^Held for review — TransAmount "29000.005" is not an exact amount$/);
    expect(kept[0]!.payload.TransAmount).toBe("28000.00");
  });

  it("M-Pesa: a payment quoting no known reference is kept and held, applied nowhere", async () => {
    const r = await mpesa(c2bConfirmation("RKT0100", "NOPE-123", "500.00"));
    expect(r.body.outcome.result).toBe("Held for review — no matching payment reference");
    const [ev] = await S.sql<{ type: string; org_id: string | null; amount_minor: number }>(
      "SELECT type, org_id, amount_minor FROM payment_events WHERE id = 'mpesa:RKT0100'",
    );
    expect(ev).toEqual({ type: "unmatched.payment", org_id: null, amount_minor: 50_000 });
  });

  it("M-Pesa STK push results go to the product that asked for the money, by checkout id", async () => {
    const checkout = "ws_CO_111020261020363925";
    await reference("RENT-A1-NOV", 4_500_000, { mpesaCheckoutRequestId: checkout });
    const cancelled = await mpesa(stkCancelled(checkout));
    expect(cancelled.body.outcome.result).toBe("Payment failed — nothing applied");
    expect(await refStatus("RENT-A1-NOV")).toBe("open");
    const ok = await mpesa(stkSuccess(checkout, 45000, "NLJ7RT61SV"));
    expect(ok.body.outcome.result).toBe("Applied — rent paid");
    expect(await refStatus("RENT-A1-NOV")).toBe("settled");
    const [ev] = await S.sql<{ id: string; org_id: string; ref: string }>(
      "SELECT id, org_id, ref FROM payment_events WHERE id = 'mpesa:NLJ7RT61SV'",
    );
    expect(ev).toEqual({ id: "mpesa:NLJ7RT61SV", org_id: orgId, ref: "NLJ7RT61SV" });
  });

  it("references: a client can never register one that pays a PALTAS invoice, nor a type no product handles", async () => {
    await expect(
      S.app.core.db.tx((t) =>
        S.app.core.providers.registerReference(t, {
          orgId,
          reference: "SUB-HACK-1",
          type: "subscription.payment",
          amountMinor: 1,
          currency: "KES",
        }),
      ),
    ).rejects.toThrow(/PALTAS invoices/);
    await expect(reference("RENT-A1-NOV", 100)).rejects.toThrow(); // unique reference
    await expect(
      S.app.core.db.tx((t) =>
        S.app.core.providers.registerReference(t, {
          orgId,
          reference: "X-123",
          type: "nobody.handles",
          amountMinor: 1,
          currency: "KES",
        }),
      ),
    ).rejects.toThrow(/No handler/);
  });

  it("card PSP webhooks: failed, wrong amount, paid (currency in any case), ignored types, stale signatures", async () => {
    await reference("RENT-CARD-77", 1_250_000);
    const failed = await card(
      cardWebhook("evt_1", "payment.failed", {
        amount: 1_250_000,
        currency: "kes",
        reference: "RENT-CARD-77",
        failure: "insufficient_funds",
      }),
    );
    expect(failed.body.outcome.result).toBe("Payment failed — nothing applied");
    const wrong = await card(
      cardWebhook("evt_2", "payment.succeeded", { amount: 1_000_000, currency: "KES", reference: "RENT-CARD-77" }),
    );
    expect(wrong.body.outcome.result).toBe("Held for review — amount or currency does not match what is due");
    const usd = await card(
      cardWebhook("evt_3", "payment.succeeded", { amount: 1_250_000, currency: "usd", reference: "RENT-CARD-77" }),
    );
    expect(usd.body.outcome.result).toMatch(/^Held for review/);
    expect(await refStatus("RENT-CARD-77")).toBe("open");
    const ok = await card(
      cardWebhook("evt_4", "payment.succeeded", { amount: 1_250_000, currency: "kes", reference: "RENT-CARD-77" }),
    );
    expect([ok.status, ok.body.outcome.result]).toEqual([200, "Applied — rent paid"]);
    expect(await refStatus("RENT-CARD-77")).toBe("settled");
    const ignored = await card(
      cardWebhook("evt_5", "payment.created", { amount: 1, currency: "KES", reference: "RENT-CARD-77" }),
    );
    expect([ignored.body.outcome, ignored.body.note]).toEqual([null, "Ignored — event type not used"]);
    const stale = await card(
      cardWebhook("evt_6", "payment.succeeded", { amount: 1, currency: "KES", reference: "X" }),
      Math.floor(Date.now() / 1000) - 3600,
    );
    expect([stale.status, stale.body.error.message]).toEqual([401, "Signature too old"]);
    expect(await S.sql("SELECT 1 FROM payment_events WHERE id = 'cardpsp:evt_6'")).toEqual([]);
  });

  it("pending callbacks never settle references; later confirmed events are idempotent", async () => {
    await reference("READY-PENDING", 120000);
    const pending = await card(
      cardWebhook("ready_pending", "payment.processing", {
        amount: 120000,
        currency: "KES",
        reference: "READY-PENDING",
      }),
    );
    expect(pending.body.outcome.result).toBe("Ignored — status pending");
    expect(await refStatus("READY-PENDING")).toBe("open");
    expect(await S.sql("SELECT 1 FROM billing_receipts WHERE event_id = $1", ["cardpsp:ready_pending"])).toEqual([]);
    const confirmed = cardWebhook("ready_confirmed", "payment.succeeded", {
      amount: 120000,
      currency: "KES",
      reference: "READY-PENDING",
    });
    expect((await card(confirmed)).body.outcome.duplicate).toBe(false);
    expect((await card(confirmed)).body.outcome.duplicate).toBe(true);
    expect(await refStatus("READY-PENDING")).toBe("settled");
  });

  it("cancelled references and zero-value confirmations are held without posting", async () => {
    await reference("READY-CANCELLED", 120000);
    await S.sql("UPDATE payment_references SET status='cancelled' WHERE org_id=$1 AND reference=$2", [
      orgId,
      "READY-CANCELLED",
    ]);
    const cancelled = await card(
      cardWebhook("ready_cancelled", "payment.succeeded", {
        amount: 120000,
        currency: "KES",
        reference: "READY-CANCELLED",
      }),
    );
    expect(cancelled.body.outcome).toBeNull();
    expect(cancelled.body.note).toMatch(/reference is cancelled/);
    const zero = await mpesa(c2bConfirmation("READY-ZERO", "READY-CANCELLED", "0"));
    expect(zero.body.outcome).toBeNull();
    expect(
      await S.sql("SELECT 1 FROM payment_events WHERE id IN ('cardpsp:ready_cancelled','mpesa:READY-ZERO')"),
    ).toEqual([]);
    expect(await refStatus("READY-CANCELLED")).toBe("cancelled");
  });

  it("staff see every adapter's state: none connected; secrets are named, never shown", async () => {
    const sa = await S.staff();
    const { adapters } = await sa.api.paymentProviders.adapters();
    expect(adapters.map((a) => [a.key, a.connected])).toEqual([
      ["mpesa", false],
      ["card", false],
      ["bank", false],
    ]);
    expect(adapters.find((a) => a.key === "mpesa")!.status).toMatch(/^BLOCKED — needs Daraja credentials/);
    expect(adapters.find((a) => a.key === "card")!.status).toMatch(/^BLOCKED/);
    expect(adapters[0]!.signingSecretFor).toEqual(["cardpsp", "mpesa", "testpay"]);
    expect(JSON.stringify(adapters)).not.toContain(MPESA);
    const support = await staffMember(S, "support");
    expect((await support.api.paymentProviders.adapters()).adapters).toHaveLength(3);
    const client = (await S.newOrg()).admin;
    expect((await S.raw("GET", "/api/v1/admin/payment-providers", undefined, client.token)).status).toBe(404);
  });
});
