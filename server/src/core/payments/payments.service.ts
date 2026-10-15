/*
 * Receives payment events (from signed provider webhooks, or a receipt recorded by PALTAS staff) and hands each to
 * the handler for its type: core handles "subscription.payment"; products register their own (e.g. "rent.payment").
 *
 * Every event is stored with its outcome. Delivering the same event again changes nothing (idempotent).
 */
import type { PaymentEvent } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import type { ProductPaymentEvent } from "../../products/registry.js";

export interface ReceivedPayment {
  duplicate: boolean;
  result: string;
  invoiceId: string | null;
  receiptId: string | null;
}

export function paymentsService(ctx: AppContext) {
  const { db, products } = ctx;

  return {
    async receive(
      provider: string,
      event: PaymentEvent,
      options: { manual?: boolean; recordedBy?: string | null; eventId?: string } = {},
      /** Run inside the caller's transaction (e.g. a confirmed bank line), instead of a new one. */
      within: Db = db,
    ): Promise<ReceivedPayment> {
      const handler = products.paymentHandler(event.type);
      if (!handler) throw fail.invalid(`No handler for payment type "${event.type}"`);
      const eventId = options.eventId ?? `${provider}:${event.id}`;
      return within.tx(async (t: Db) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", [eventId]);
        const seen = await t.row<{ result: string; target_id: string | null }>(
          "SELECT result, target_id FROM payment_events WHERE id = $1",
          [eventId],
        );
        if (seen) return { duplicate: true, result: seen.result, invoiceId: null, receiptId: null };

        // stored first (receipts refer to it), with its final outcome filled in below
        await t.run(
          `INSERT INTO payment_events (id, provider, type, status, amount_minor, currency, ref, manual, recorded_by, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Processing')`,
          [
            eventId,
            provider,
            event.type,
            event.status,
            event.amountMinor,
            event.currency,
            event.ref ?? "",
            !!options.manual,
            options.recordedBy ?? null,
          ],
        );
        const full: ProductPaymentEvent = {
          ...event,
          eventId,
          provider,
          manual: !!options.manual,
          recordedBy: options.recordedBy ?? null,
        };
        const out = await handler(t, full);
        await t.run("UPDATE payment_events SET result = $2, org_id = $3, target_id = $4 WHERE id = $1", [
          eventId,
          out.result,
          out.orgId,
          out.targetId,
        ]);
        return {
          duplicate: false,
          result: out.result,
          invoiceId: out.invoiceId ?? null,
          receiptId: out.receiptId ?? null,
        };
      });
    },
  };
}

export type PaymentsService = ReturnType<typeof paymentsService>;
