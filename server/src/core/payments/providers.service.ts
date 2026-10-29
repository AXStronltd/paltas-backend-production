/*
 * Payment provider adapters on the core's signed-event path.
 *
 *   references   what a payment is for, by the reference the payer quotes (registered by core or a product)
 *   callbacks    M-Pesa / card webhooks (signature already checked by the route) → translated → payments.receive,
 *                where the owning handler applies its exact amount and currency rules; the raw callback is kept
 *   bank         statement import → match suggestions → a second person confirms → payments.receive (manual,
 *                with the bank reference), all in one transaction
 *
 * Nothing here marks anything paid by itself, and no live provider is connected (see adapters()).
 */
import { createHash } from "node:crypto";
import type { PaymentEvent, paymentProviders, z } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import type { PaymentHandler } from "../../products/registry.js";
import { recordAudit, type Actor } from "../audit/audit.service.js";
import { translateCard, translateMpesa, translatedProblem, type Translated } from "./adapters/translate.js";
import { parseStatement, suggest, type Candidate, type Suggestion } from "./bank/statement.js";
import type { PaymentsService } from "./payments.service.js";

type Body<E extends { body: z.ZodType }> = z.infer<E["body"]>;
type BankLineDto = z.infer<typeof paymentProviders.BankLine>;

/** Payments whose reference matches nothing are kept and held for review — never applied anywhere. */
export const UNMATCHED_PAYMENT = "unmatched.payment";
export const unmatchedPaymentHandler: PaymentHandler = async (_t, ev) => ({
  result:
    ev.status === "succeeded"
      ? "Held for review — no matching payment reference"
      : `Ignored — ${ev.status}, no matching payment reference`,
  orgId: null,
  targetId: null,
});

interface ReferenceRow {
  id: string;
  org_id: string | null;
  reference: string;
  type: string;
  invoice_id: string | null;
  data: Record<string, unknown>;
  amount_minor: number;
  currency: string;
  status: "open" | "settled" | "cancelled";
  created_at: string;
}

interface LineRow {
  id: string;
  statement_id: string;
  org_id: string | null;
  line_no: number;
  value_date: string;
  amount_minor: number;
  currency: string;
  bank_ref: string;
  description: string;
  status: BankLineDto["status"];
  suggestions: Suggestion[];
  imported_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  matched_reference: string | null;
  result: string | null;
}

interface StatementRow {
  id: string;
  org_id: string | null;
  account_label: string;
  currency: string;
  line_count: number;
  imported_by: string;
  imported_at: string;
  open: number;
}

type Target =
  | { kind: "reference"; row: ReferenceRow }
  | { kind: "invoice"; id: string; orgId: string; amountMinor: number; currency: string };

/** Who is acting on a statement: an organisation (its finance people) or PALTAS (null). */
export interface BankScope {
  orgId: string | null;
  userId: string;
  actor: Actor;
}

const toLine = (l: LineRow): BankLineDto => ({
  id: l.id,
  lineNo: l.line_no,
  valueDate: l.value_date,
  amountMinor: l.amount_minor,
  currency: l.currency,
  bankRef: l.bank_ref,
  description: l.description,
  status: l.status,
  suggestions: l.suggestions,
  decidedBy: l.decided_by,
  decidedAt: l.decided_at,
  decisionReason: l.decision_reason,
  matchedReference: l.matched_reference,
  result: l.result,
});

const toStatement = (s: StatementRow) => ({
  id: s.id,
  accountLabel: s.account_label,
  currency: s.currency,
  lineCount: s.line_count,
  importedBy: s.imported_by,
  importedAt: s.imported_at,
  open: s.open,
});

const STATEMENT_SQL = `SELECT s.*, (SELECT count(*)::int FROM bank_statement_lines l
  WHERE l.statement_id = s.id AND l.status IN ('suggested', 'unmatched')) AS open FROM bank_statements s`;

export function providersService(ctx: AppContext, deps: { payments: PaymentsService }) {
  const { db, config, products } = ctx;

  async function resolve(t: Db, lookup: Translated["lookup"]): Promise<Target | null> {
    if (!lookup.value) return null;
    const ref =
      lookup.by === "mpesaCheckout"
        ? await t.row<ReferenceRow>(
            "SELECT * FROM payment_references WHERE data->>'mpesaCheckoutRequestId' = $1 FOR UPDATE",
            [lookup.value],
          )
        : await t.row<ReferenceRow>("SELECT * FROM payment_references WHERE lower(reference) = lower($1) FOR UPDATE", [
            lookup.value,
          ]);
    if (ref) return { kind: "reference", row: ref };
    if (lookup.by !== "reference") return null;
    const inv = await t.row<{ id: string; org_id: string; total_minor: number; currency: string }>(
      "SELECT id, org_id, total_minor, currency FROM billing_invoices WHERE lower(id) = lower($1)",
      [lookup.value],
    );
    return inv
      ? { kind: "invoice", id: inv.id, orgId: inv.org_id, amountMinor: inv.total_minor, currency: inv.currency }
      : null;
  }

  function eventFor(
    tr: Pick<Translated, "externalId" | "lookup" | "status" | "amountMinor" | "currency" | "ref" | "reason">,
    target: Target | null,
  ): PaymentEvent {
    const base = {
      id: tr.externalId,
      status: tr.status as PaymentEvent["status"],
      amountMinor:
        tr.amountMinor ?? (target ? (target.kind === "reference" ? target.row.amount_minor : target.amountMinor) : 0),
      currency: tr.currency,
      ref: tr.ref,
      ...(tr.reason ? { reason: tr.reason } : {}),
    };
    if (!target) return { ...base, type: UNMATCHED_PAYMENT, data: { quotedReference: tr.lookup.value } };
    if (target.kind === "invoice") return { ...base, type: "subscription.payment", invoiceId: target.id };
    const r = target.row;
    return {
      ...base,
      type: r.type,
      ...(r.invoice_id ? { invoiceId: r.invoice_id } : {}),
      data: { ...r.data, orgId: r.org_id, paymentReference: r.reference },
    };
  }

  async function settleIfApplied(t: Db, target: Target | null, result: string) {
    if (target?.kind === "reference" && result.startsWith("Applied"))
      await t.run("UPDATE payment_references SET status = 'settled' WHERE id = $1 AND status = 'open'", [
        target.row.id,
      ]);
  }

  /** A translated provider callback, applied through the core payment path in one transaction. */
  async function callback(provider: string, payload: unknown, tr: Translated) {
    return db.tx(async (t) => {
      const keep = async (result: string, event: PaymentEvent | null) =>
        t.run(
          "INSERT INTO provider_callbacks (provider, kind, external_id, payload, event, result) VALUES ($1,$2,$3,$4,$5,$6)",
          [provider, tr.kind, tr.externalId, JSON.stringify(payload), event && JSON.stringify(event), result],
        );
      if (tr.status === "ignored") {
        await keep("Ignored — event type not used", null);
        return { outcome: null, note: "Ignored — event type not used" };
      }
      const problem = translatedProblem(tr);
      if (problem) {
        await keep(`Held for review — ${problem}`, null);
        return { outcome: null, note: `Held for review — ${problem}` };
      }
      const target = await resolve(t, tr.lookup);
      if (target?.kind === "reference" && target.row.status === "cancelled") {
        const note = "Held for review — payment reference is cancelled";
        await keep(note, null);
        return { outcome: null, note };
      }
      const event = eventFor(tr, target);
      const outcome = await deps.payments.receive(provider, event, {}, t);
      if (!outcome.duplicate) await settleIfApplied(t, target, outcome.result);
      await keep(outcome.result, event);
      return { outcome, note: outcome.result };
    });
  }

  async function statement(scope: BankScope, id: string) {
    const s = await db.row<StatementRow>(`${STATEMENT_SQL} WHERE s.id = $1 AND COALESCE(s.org_id, '') = $2`, [
      id,
      scope.orgId ?? "",
    ]);
    if (!s) throw fail.notFound("Statement not found");
    const lines = await db.rows<LineRow>(
      "SELECT * FROM bank_statement_lines WHERE statement_id = $1 ORDER BY line_no",
      [id],
    );
    return { statement: toStatement(s), lines: lines.map(toLine) };
  }

  async function candidates(t: Db, orgId: string | null): Promise<Candidate[]> {
    if (orgId)
      return (
        await t.rows<ReferenceRow>("SELECT * FROM payment_references WHERE org_id = $1 AND status = 'open'", [orgId])
      ).map((r) => ({
        id: r.id,
        kind: "reference" as const,
        reference: r.reference,
        orgId: r.org_id,
        amountMinor: r.amount_minor,
        currency: r.currency,
      }));
    return (
      await t.rows<{ id: string; org_id: string; total_minor: number; currency: string }>(
        "SELECT id, org_id, total_minor, currency FROM billing_invoices WHERE status IN ('Open', 'Payment failed')",
      )
    ).map((i) => ({
      id: i.id,
      kind: "invoice" as const,
      reference: i.id,
      orgId: i.org_id,
      amountMinor: i.total_minor,
      currency: i.currency,
    }));
  }

  return {
    /**
     * Register what a payment will be for (products call this when they ask for money, in their transaction).
     * For an M-Pesa STK push, put the CheckoutRequestID in data.mpesaCheckoutRequestId.
     */
    async registerReference(
      t: Db,
      r: {
        orgId: string;
        reference: string;
        type: string;
        invoiceId?: string | null;
        data?: Record<string, unknown>;
        amountMinor: number;
        currency: string;
        createdBy?: string | null;
      },
    ) {
      if (r.type === "subscription.payment") throw new Error("PALTAS invoices are matched by their own number");
      if (!products.paymentHandler(r.type)) throw new Error(`No handler for payment type "${r.type}"`);
      const id = newId("pref");
      await t.run(
        `INSERT INTO payment_references (id, org_id, reference, type, invoice_id, data, amount_minor, currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          r.orgId,
          r.reference,
          r.type,
          r.invoiceId ?? null,
          JSON.stringify(r.data ?? {}),
          r.amountMinor,
          r.currency,
          r.createdBy ?? null,
        ],
      );
      return { id };
    },

    async references(orgId: string, status?: ReferenceRow["status"]) {
      const rows = await db.rows<ReferenceRow>(
        `SELECT * FROM payment_references WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC, id`,
        [orgId, status ?? null],
      );
      return rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        type: r.type,
        invoiceId: r.invoice_id,
        amountMinor: r.amount_minor,
        currency: r.currency,
        status: r.status,
        createdAt: r.created_at,
      }));
    },

    adapters() {
      const signing = Object.keys(config.webhookSecrets).sort();
      return [
        {
          key: "mpesa",
          label: "M-Pesa (Daraja) — STK push results and C2B confirmations",
          kind: "mpesa" as const,
          connected: false,
          status:
            "BLOCKED — needs Daraja credentials (consumer key/secret, shortcode, passkey), registered callback URLs and the relay that signs callbacks. Callback translation is built and tested with documentation-shaped fixtures.",
          signingSecretFor: signing,
        },
        {
          key: "card",
          label: "Card processor (generic PSP webhook)",
          kind: "card" as const,
          connected: false,
          status:
            "BLOCKED — needs a contracted card processor, its credentials and webhook signing secret. Webhook translation is built and tested with fixtures.",
          signingSecretFor: signing,
        },
        {
          key: "bank",
          label: "Bank transfers — statement import",
          kind: "bank" as const,
          connected: false,
          status:
            "Statement import (CSV) works; a live bank feed is BLOCKED (needs a bank API agreement). Matches are confirmed by a second person.",
          signingSecretFor: [],
        },
      ];
    },

    mpesa(provider: string, payload: unknown, body: Body<typeof paymentProviders.mpesaCallback>) {
      return callback(provider, payload, translateMpesa(body));
    },

    card(provider: string, payload: unknown, body: Body<typeof paymentProviders.cardEvent>) {
      return callback(provider, payload, translateCard(body));
    },

    statement,

    async statements(orgId: string) {
      const rows = await db.rows<StatementRow>(`${STATEMENT_SQL} WHERE s.org_id = $1 ORDER BY s.imported_at DESC`, [
        orgId,
      ]);
      return rows.map(toStatement);
    },

    async importStatement(scope: BankScope, b: Body<typeof paymentProviders.importStatement>) {
      const lines = parseStatement(b.csv, { currency: b.currency, dateFormat: b.dateFormat });
      const sha = createHash("sha256").update(b.csv).digest("hex");
      const id = newId("bst");
      await db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["bank:" + (scope.orgId ?? "platform")]);
        if (
          await t.row("SELECT 1 FROM bank_statements WHERE COALESCE(org_id, '') = $1 AND file_sha256 = $2", [
            scope.orgId ?? "",
            sha,
          ])
        )
          throw fail.conflict("This statement file was already imported");
        const known = new Set(
          (
            await t.rows<{ ref: string }>(
              `SELECT lower(bank_ref) AS ref FROM bank_statement_lines
               WHERE COALESCE(org_id, '') = $1 AND status NOT IN ('duplicate', 'outgoing')`,
              [scope.orgId ?? ""],
            )
          ).map((r) => r.ref),
        );
        const cands = await candidates(t, scope.orgId);
        await t.run(
          `INSERT INTO bank_statements (id, org_id, account_label, currency, file_sha256, line_count, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, scope.orgId, b.accountLabel, b.currency, sha, lines.length, scope.userId],
        );
        let suggested = 0;
        for (const l of lines) {
          const key = l.bankRef.toLowerCase();
          const outgoing = l.amountMinor <= 0;
          const duplicate = !outgoing && known.has(key);
          const sugg = outgoing || duplicate ? [] : suggest(l, cands);
          if (!outgoing) known.add(key);
          if (sugg.length) suggested++;
          await t.run(
            `INSERT INTO bank_statement_lines (id, statement_id, org_id, line_no, value_date, amount_minor, currency,
               bank_ref, description, status, suggestions, imported_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              newId("bln"),
              id,
              scope.orgId,
              l.lineNo,
              l.valueDate,
              l.amountMinor,
              l.currency,
              l.bankRef,
              l.description,
              outgoing ? "outgoing" : duplicate ? "duplicate" : sugg.length ? "suggested" : "unmatched",
              JSON.stringify(sugg),
              scope.userId,
            ],
          );
        }
        await recordAudit(t, {
          actor: scope.actor,
          orgId: scope.orgId,
          action: "Bank statement imported",
          target: id,
          detail: `${b.accountLabel} · ${lines.length} line(s) · ${suggested} with suggested matches`,
        });
      });
      return statement(scope, id);
    },

    /** Confirm one line pays `match` (a payment reference id, or for PALTAS a subscription invoice id). */
    async confirmLine(scope: BankScope, statementId: string, lineId: string, b: { match: string; reason: string }) {
      return db.tx(async (t) => {
        const line = await t.row<LineRow>(
          `SELECT l.* FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id
           WHERE l.id = $1 AND l.statement_id = $2 AND COALESCE(s.org_id, '') = $3 FOR UPDATE OF l`,
          [lineId, statementId, scope.orgId ?? ""],
        );
        if (!line) throw fail.notFound("Statement line not found");
        if (line.status !== "suggested" && line.status !== "unmatched")
          throw fail.conflict(`This line is ${line.status} — nothing to confirm`);
        if (line.imported_by === scope.userId)
          throw fail.separationOfDuties("The person who imported the statement cannot confirm its matches");
        let target: Target;
        const eventId = `bank:${scope.orgId ?? "platform"}:${line.bank_ref.toLowerCase()}`;
        if (scope.orgId) {
          const ref = await t.row<ReferenceRow>(
            "SELECT * FROM payment_references WHERE id = $1 AND org_id = $2 FOR UPDATE",
            [b.match, scope.orgId],
          );
          if (!ref) throw fail.notFound("Payment reference not found");
          if (ref.status !== "open") throw fail.conflict(`This payment reference is already ${ref.status}`);
          target = { kind: "reference", row: ref };
        } else {
          const inv = await t.row<{ id: string; org_id: string; total_minor: number; currency: string }>(
            "SELECT id, org_id, total_minor, currency FROM billing_invoices WHERE id = $1",
            [b.match],
          );
          if (!inv) throw fail.notFound("Invoice not found");
          if (await t.row("SELECT 1 FROM payment_events WHERE lower(ref) = lower($1)", [line.bank_ref]))
            throw fail.conflict("This bank reference is already used by another payment");
          target = {
            kind: "invoice",
            id: inv.id,
            orgId: inv.org_id,
            amountMinor: inv.total_minor,
            currency: inv.currency,
          };
        }
        const event = eventFor(
          {
            externalId: line.bank_ref,
            lookup: { by: "reference", value: b.match },
            status: "succeeded",
            amountMinor: line.amount_minor,
            currency: line.currency,
            ref: line.bank_ref,
            reason: b.reason,
          },
          target,
        );
        const outcome = await deps.payments.receive(
          "bank",
          event,
          { manual: true, recordedBy: scope.userId, eventId },
          t,
        );
        if (!outcome.duplicate) await settleIfApplied(t, target, outcome.result);
        const matched = target.kind === "reference" ? target.row.reference : target.id;
        const row = await t.row<LineRow>(
          `UPDATE bank_statement_lines SET status = 'confirmed', decided_by = $2, decided_at = now(),
             decision_reason = $3, matched_reference = $4, payment_event_id = $5, result = $6
           WHERE id = $1 RETURNING *`,
          [line.id, scope.userId, b.reason, matched, eventId, outcome.result],
        );
        await recordAudit(t, {
          actor: scope.actor,
          orgId: scope.orgId,
          action: "Bank line confirmed",
          target: line.id,
          detail: `${line.bank_ref} → ${matched} · ${outcome.result}`,
        });
        return { line: toLine(row as LineRow), outcome };
      });
    },

    async ignoreLine(scope: BankScope, statementId: string, lineId: string, reason: string) {
      return db.tx(async (t) => {
        const line = await t.row<LineRow>(
          `SELECT l.* FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id
           WHERE l.id = $1 AND l.statement_id = $2 AND COALESCE(s.org_id, '') = $3 FOR UPDATE OF l`,
          [lineId, statementId, scope.orgId ?? ""],
        );
        if (!line) throw fail.notFound("Statement line not found");
        if (line.status !== "suggested" && line.status !== "unmatched")
          throw fail.conflict(`This line is ${line.status} — nothing to decide`);
        if (line.imported_by === scope.userId)
          throw fail.separationOfDuties("The person who imported the statement cannot decide its lines");
        const row = await t.row<LineRow>(
          `UPDATE bank_statement_lines SET status = 'ignored', decided_by = $2, decided_at = now(), decision_reason = $3
           WHERE id = $1 RETURNING *`,
          [line.id, scope.userId, reason],
        );
        await recordAudit(t, {
          actor: scope.actor,
          orgId: scope.orgId,
          action: "Bank line ignored",
          target: line.id,
          detail: `${line.bank_ref} · ${reason}`,
        });
        return toLine(row as LineRow);
      });
    },
  };
}

export type ProvidersService = ReturnType<typeof providersService>;
