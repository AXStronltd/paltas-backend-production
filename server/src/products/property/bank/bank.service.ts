import { createHash } from "node:crypto";
import { financeTransaction } from "../shared/finance-transaction.js";
/*
 * Bank reconciliation of the client account (1040) against what was RECORDED in PALTAS: no bank is connected, the
 * statement lines are imported by hand. Lines are matched by reference and exact amount to recorded receipts (money in)
 * and to released payouts, bill payments and deposit refunds (money out); a matched payout becomes "paid". An unknown
 * incoming line can be recorded as a tenant's payment. A reconciliation explains the difference between the statement
 * and the ledger and is signed off by someone other than its preparer, only when the difference is zero.
 */
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { PmDeps } from "../deps.js";
import type { PaymentsService } from "../payments/payments.service.js";
import { PM_JOURNALS_SQL, pmBalance } from "../shared/posting.js";
import { formatMoney } from "../../../lib/money.js";

interface LineRow {
  id: string;
  account_code: string;
  date: string;
  amount_minor: number;
  reference: string;
  description: string;
  status: "unmatched" | "matched" | "ignored";
  matched_kind: P.BankLine["matchedKind"];
  matched_id: string | null;
  note: string;
}

interface RecRow {
  source_fingerprint: string | null;
  unmatched_count: number | null;
  id: string;
  account_code: string;
  statement_date: string;
  statement_balance_minor: number;
  ledger_balance_minor: number;
  uncleared_in_minor: number;
  uncleared_out_minor: number;
  unmatched_lines_minor: number;
  difference_minor: number;
  status: "prepared" | "approved";
  prepared_by: string;
  approved_by: string | null;
}

const toLine = (r: LineRow): P.BankLine => ({
  id: r.id,
  accountCode: r.account_code,
  date: r.date,
  amountMinor: r.amount_minor,
  reference: r.reference,
  description: r.description,
  status: r.status,
  matchedKind: r.matched_kind,
  matchedId: r.matched_id,
  note: r.note,
});

const toRec = (r: RecRow) => ({
  unmatchedCount: r.unmatched_count,
  id: r.id,
  accountCode: r.account_code,
  statementDate: r.statement_date,
  statementBalanceMinor: r.statement_balance_minor,
  ledgerBalanceMinor: r.ledger_balance_minor,
  unclearedInMinor: r.uncleared_in_minor,
  unclearedOutMinor: r.uncleared_out_minor,
  unmatchedLinesMinor: r.unmatched_lines_minor,
  differenceMinor: r.difference_minor,
  status: r.status,
  preparedBy: r.prepared_by,
  approvedBy: r.approved_by,
});

type Kind = NonNullable<P.BankLine["matchedKind"]>;

/** What was recorded as moving money through the client account (line = the statement line it is matched to). */
const CANDIDATES: Record<Kind, { sql: string; sign: 1 | -1 }> = {
  provider_settlement: {
    sign: 1,
    sql: `SELECT s.id,b.reference AS ref,s.amount_minor AS amount,b.date,s.bank_line_id AS line FROM pm_kulmipay_settlements s JOIN pm_bank_lines b ON b.org_id=s.org_id AND b.id=s.bank_line_id WHERE s.org_id=$1 AND s.status='approved'`,
  },
  payment: {
    sign: 1,
    sql: `SELECT id, reference AS ref, amount_minor AS amount, date, bank_line_id AS line FROM pm_effective_payments
          WHERE org_id = $1 AND NOT EXISTS (SELECT 1 FROM pm_kulmipay_requests k WHERE k.org_id=$1 AND k.ledger_payment_id=pm_effective_payments.id)`,
  },
  payout: {
    sign: -1,
    sql: `SELECT id, number AS ref, amount_minor AS amount, release_date AS date, bank_line_id AS line FROM pm_payouts
          WHERE org_id = $1 AND status IN ('released', 'paid')`,
  },
  bill_payment: {
    sign: -1,
    sql: `SELECT id, paid_reference AS ref, amount_minor AS amount, paid_date AS date, bank_line_id AS line FROM pm_bills
          WHERE org_id = $1 AND status = 'paid' AND recover_from = 'owner'`,
  },
  deposit_refund: {
    sign: -1,
    sql: `SELECT r.id, r.refund_reference AS ref, r.refund_minor AS amount, e.date, r.bank_line_id AS line
          FROM pm_deposit_refunds r JOIN journal_entries e ON e.id = r.journal_id
          WHERE r.org_id = $1 AND r.status = 'approved' AND r.refund_minor > 0`,
  },
};

const TABLE: Record<Kind, string> = {
  provider_settlement: "pm_kulmipay_settlements",
  payment: "pm_payments",
  payout: "pm_payouts",
  bill_payment: "pm_bills",
  deposit_refund: "pm_deposit_refunds",
};

export function bankService(d: PmDeps, deps: { payments: PaymentsService }) {
  const { core } = d;
  const db = core.db;

  async function lineRow(t: Db, orgId: string, id: string, lock = false): Promise<LineRow> {
    const r = await t.row<LineRow>(
      `SELECT * FROM pm_bank_lines WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!r) throw fail.notFound("Statement line not found");
    return r;
  }

  /** Mark a line and the recorded item as matched (a payout becomes paid). */
  async function link(t: Db, s: OrgScope, line: LineRow, kind: Kind, id: string) {
    await t.run(
      "UPDATE pm_bank_lines SET status = 'matched', matched_kind = $2, matched_id = $3, decided_by = $4, decided_at = now() WHERE id = $1",
      [line.id, kind, id, s.userId],
    );
    await t.run(`UPDATE ${TABLE[kind]} SET bank_line_id = $2 WHERE id = $1`, [id, line.id]);
    if (kind === "payout")
      await t.run("UPDATE pm_payouts SET status = 'paid' WHERE id = $1 AND status = 'released'", [id]);
  }

  /** The recorded item with this reference and exact amount, if exactly one is waiting. */
  async function findMatch(t: Db, orgId: string, line: LineRow): Promise<{ kind: Kind; id: string } | null> {
    for (const [kind, c] of Object.entries(CANDIDATES) as [Kind, (typeof CANDIDATES)[Kind]][]) {
      if (Math.sign(line.amount_minor) !== c.sign) continue;
      const hits = await t.rows<{ id: string }>(
        `SELECT id FROM (${c.sql}) x WHERE x.line IS NULL AND upper(btrim(x.ref)) = upper(btrim($2)) AND x.amount = $3`,
        [orgId, line.reference, Math.abs(line.amount_minor)],
      );
      if (hits.length === 1) return { kind, id: (hits[0] as { id: string }).id };
    }
    return null;
  }

  async function snapshot(t: Db, s: OrgScope, D: string, statementBalanceMinor: number) {
    const ledger = await pmBalance(t, s.orgId, ACC.clientBank, D);
    // recorded but not on the statement by D (not matched, or matched to a later line)
    const uncleared = async (kind: Kind) => {
      const r = await t.row<{ n: number }>(
        `SELECT COALESCE(sum(x.amount), 0)::bigint AS n FROM (${kind === "payment" ? CANDIDATES[kind].sql.replaceAll("pm_effective_payments", "pm_payments") : CANDIDATES[kind].sql}) x
           WHERE x.date <= $2 ${kind === "payment" ? "AND NOT EXISTS (SELECT 1 FROM pm_payment_reversals r WHERE r.payment_id=x.id AND r.approved_by IS NOT NULL AND r.date <= $2)" : ""} AND NOT EXISTS (SELECT 1 FROM pm_bank_lines b
             WHERE b.matched_kind = $3 AND b.matched_id = x.id AND b.date <= $2)`,
        [s.orgId, D, kind],
      );
      return r?.n ?? 0;
    };
    const unclearedIn = (await uncleared("payment")) + (await uncleared("provider_settlement"));
    const unclearedOut =
      (await uncleared("payout")) + (await uncleared("bill_payment")) + (await uncleared("deposit_refund"));
    const unmatched = await t.row<{ n: number }>(
      "SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM pm_bank_lines WHERE org_id = $1 AND status <> 'matched' AND date <= $2",
      [s.orgId, D],
    );
    const unmatchedLines = unmatched?.n ?? 0;
    for (const n of [statementBalanceMinor, unclearedIn, unclearedOut, unmatchedLines, ledger])
      if (!Number.isSafeInteger(n)) throw fail.invalid("The reconciliation exceeds the supported monetary range");
    const exactDifference =
      BigInt(statementBalanceMinor) +
      BigInt(unclearedIn) -
      BigInt(unclearedOut) -
      BigInt(unmatchedLines) -
      BigInt(ledger);
    if (exactDifference > BigInt(Number.MAX_SAFE_INTEGER) || exactDifference < -BigInt(Number.MAX_SAFE_INTEGER))
      throw fail.invalid("The reconciliation difference exceeds the supported monetary range");
    const difference = Number(exactDifference);

    for (const n of [ledger, unclearedIn, unclearedOut, unmatchedLines, difference])
      if (!Number.isSafeInteger(n)) throw fail.invalid("The reconciliation exceeds the supported monetary range");
    const bank = await t.rows<{ status: string }>(
      "SELECT id,date,amount_minor,status,matched_kind,matched_id FROM pm_bank_lines WHERE org_id=$1 AND date<=$2 ORDER BY id",
      [s.orgId, D],
    );
    const records: Record<string, unknown[]> = {};
    for (const [kind, c] of Object.entries(CANDIDATES) as [Kind, (typeof CANDIDATES)[Kind]][]) {
      const sql = kind === "payment" ? c.sql.replaceAll("pm_effective_payments", "pm_payments") : c.sql;
      records[kind] = await t.rows(
        `SELECT x.* FROM (${sql}) x WHERE x.date<=$2 ${kind === "payment" ? "AND NOT EXISTS(SELECT 1 FROM pm_payment_reversals r WHERE r.org_id=$1 AND r.payment_id=x.id AND r.approved_by IS NOT NULL AND r.date<=$2)" : ""} ORDER BY x.id`,
        [s.orgId, D],
      );
    }
    const entries = await t.rows(
      `SELECT l.entry_id,l.line_no,l.debit_minor,l.credit_minor FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.org_id=$1 AND l.account_code=$2 AND e.date<=$3 AND e.id IN ${PM_JOURNALS_SQL} ORDER BY l.entry_id,l.line_no`,
      [s.orgId, ACC.clientBank, D],
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([D, statementBalanceMinor, bank, records, entries]))
      .digest("hex");
    return {
      ledger,
      unclearedIn,
      unclearedOut,
      unmatchedLines,
      difference,
      fingerprint,
      unmatchedCount: bank.filter((x) => x.status === "unmatched").length,
    };
  }

  return {
    async importLines(
      s: OrgScope,
      b: { statement: string; lines: { date: string; amountMinor: number; reference: string; description: string }[] },
    ) {
      return financeTransaction(db, s.orgId, async (t) => {
        let imported = 0;
        let duplicates = 0;
        let matched = 0;
        const ids: string[] = [];
        for (const l of b.lines) {
          if (l.date > s.today) throw fail.invalid(`A statement line is dated in the future (${l.date})`);
          const row = await t.row<LineRow>(
            `INSERT INTO pm_bank_lines (id, org_id, account_code, date, amount_minor, reference, description, statement, status,
               imported_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unmatched', $9) ON CONFLICT DO NOTHING RETURNING *`,
            [
              newId("pbk"),
              s.orgId,
              ACC.clientBank,
              l.date,
              l.amountMinor,
              l.reference,
              l.description,
              b.statement,
              s.userId,
            ],
          );
          if (!row) {
            duplicates++;
            continue;
          }
          imported++;
          ids.push(row.id);
          const m = await findMatch(t, s.orgId, row);
          if (m) {
            await link(t, s, row, m.kind, m.id);
            matched++;
          }
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bank statement imported",
          target: b.statement,
          detail: `${imported} line(s) · ${matched} matched · ${duplicates} already imported`,
        });
        const lines = await t.rows<LineRow>("SELECT * FROM pm_bank_lines WHERE id = ANY($1) ORDER BY date, reference", [
          ids,
        ]);
        return { imported, duplicates, matched, lines: lines.map(toLine) };
      });
    },

    async list(s: OrgScope, status?: LineRow["status"]) {
      const rows = await db.rows<LineRow>(
        "SELECT * FROM pm_bank_lines WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY date, reference",
        [s.orgId, status ?? null],
      );
      return { lines: rows.map(toLine) };
    },

    async match(
      s: OrgScope,
      lineId: string,
      b: { to: Kind; id: string } | { to: "new_payment"; tenantId: string; method: P.PaymentMethod },
    ) {
      await financeTransaction(db, s.orgId, async (t) => {
        const line = await lineRow(t, s.orgId, lineId, true);
        if (line.status !== "unmatched") throw fail.conflict(`This line is already ${line.status}`);
        if (b.to === "new_payment") {
          if (line.amount_minor <= 0) throw fail.invalid("Only money in can be recorded as a tenant's payment");
          const paymentId = await deps.payments.recordIn(t, s, {
            tenantId: b.tenantId,
            date: line.date,
            amountMinor: line.amount_minor,
            method: b.method,
            reference: line.reference,
            note: `From bank statement ${line.description}`.trim(),
            bankLineId: null,
          });
          await link(t, s, line, "payment", paymentId);
          return;
        }
        const c = CANDIDATES[b.to];
        if (Math.sign(line.amount_minor) !== c.sign)
          throw fail.invalid("The line's direction does not match that record");
        const hit = await t.row<{ amount: number }>(
          `SELECT amount FROM (${c.sql}) x WHERE x.line IS NULL AND x.id = $2`,
          [s.orgId, b.id],
        );
        if (!hit) throw fail.notFound("Nothing recorded and unmatched with that id");
        if (hit.amount !== Math.abs(line.amount_minor))
          throw fail.conflict(
            `Amounts differ: the line is ${formatMoney(Math.abs(line.amount_minor), s.entitlement.org.currency)}, the record ${formatMoney(hit.amount, s.entitlement.org.currency)}`,
          );
        await link(t, s, line, b.to, b.id);
      });
      await financeTransaction(db, s.orgId, (t) =>
        recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Statement line matched by hand",
          target: lineId,
          after: b,
        }),
      );
      return toLine(await lineRow(db, s.orgId, lineId));
    },

    async ignore(s: OrgScope, lineId: string, reason: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const line = await lineRow(t, s.orgId, lineId, true);
        if (line.status !== "unmatched") throw fail.conflict(`This line is already ${line.status}`);
        await t.run(
          "UPDATE pm_bank_lines SET status = 'ignored', note = $2, decided_by = $3, decided_at = now() WHERE id = $1",
          [lineId, reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Statement line set aside",
          target: lineId,
          detail: reason,
        });
      });
      return toLine(await lineRow(db, s.orgId, lineId));
    },

    async prepare(s: OrgScope, b: { statementDate: string; statementBalanceMinor: number }) {
      const D = b.statementDate;
      if (D > s.today) throw fail.invalid("The statement date is in the future");
      return financeTransaction(db, s.orgId, async (t) => {
        const { ledger, unclearedIn, unclearedOut, unmatchedLines, difference, fingerprint, unmatchedCount } =
          await snapshot(t, s, D, b.statementBalanceMinor);
        const id = newId("prc");
        await t.run(
          `INSERT INTO pm_reconciliations (id, org_id, account_code, statement_date, statement_balance_minor,
             ledger_balance_minor, uncleared_in_minor, uncleared_out_minor, unmatched_lines_minor, difference_minor, status,
             prepared_by,source_fingerprint,unmatched_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepared', $11,$12,$13)`,
          [
            id,
            s.orgId,
            ACC.clientBank,
            D,
            b.statementBalanceMinor,
            ledger,
            unclearedIn,
            unclearedOut,
            unmatchedLines,
            difference,
            s.userId,
            fingerprint,
            unmatchedCount,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bank reconciliation prepared",
          target: id,
          detail: `${D} · statement ${b.statementBalanceMinor} · ledger ${ledger} · difference ${difference}`,
        });
        const saved = await t.row<RecRow>("SELECT * FROM pm_reconciliations WHERE org_id=$1 AND id=$2", [s.orgId, id]);
        return toRec(saved as RecRow);
      });
    },

    async listReconciliations(s: OrgScope) {
      const rows = await db.rows<RecRow>(
        "SELECT * FROM pm_reconciliations WHERE org_id = $1 ORDER BY statement_date DESC, prepared_at DESC",
        [s.orgId],
      );
      return { reconciliations: rows.map(toRec) };
    },

    async approve(s: OrgScope, id: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await t.row<RecRow>("SELECT * FROM pm_reconciliations WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!r) throw fail.notFound("Reconciliation not found");
        if (r.status !== "prepared") throw fail.conflict("This reconciliation is already signed off");
        if (r.prepared_by === s.userId)
          throw fail.separationOfDuties("You prepared this reconciliation — someone else signs it off");
        if (r.difference_minor !== 0)
          throw fail.conflict(
            `The reconciliation has a difference of ${formatMoney(r.difference_minor, s.entitlement.org.currency)} — resolve it first`,
          );
        if ((await pmBalance(t, s.orgId, ACC.clientBank, r.statement_date)) !== r.ledger_balance_minor)
          throw fail.conflict(
            "The ledger changed after this reconciliation was prepared. Prepare a fresh reconciliation before approval.",
          );
        const current = await snapshot(t, s, r.statement_date, r.statement_balance_minor);
        if (
          !r.source_fingerprint ||
          r.source_fingerprint !== current.fingerprint ||
          r.uncleared_in_minor !== current.unclearedIn ||
          r.uncleared_out_minor !== current.unclearedOut ||
          r.unmatched_lines_minor !== current.unmatchedLines ||
          current.difference !== 0
        )
          throw fail.conflict(
            "Statement lines, recorded money or matches changed after preparation. Prepare a fresh reconciliation and review it before signing off.",
          );
        if (current.unmatchedCount > 0)
          throw fail.conflict(
            "Resolve or explicitly classify every unmatched statement line before sign-off. Offsetting unknown amounts are not a reconciled statement.",
          );
        await t.run(
          "UPDATE pm_reconciliations SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
          [id, s.userId],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Bank reconciliation signed off", target: id });
      });
      return toRec((await db.row<RecRow>("SELECT * FROM pm_reconciliations WHERE id = $1", [id])) as RecRow);
    },
  };
}

export type BankService = ReturnType<typeof bankService>;
