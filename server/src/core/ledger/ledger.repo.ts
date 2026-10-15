// SQL for the ledger. Business rules live in ledger.service.ts; the database adds its own guarantees (migration 0002).
import type { AccountType, Journal, JournalStatus, LedgerAccount } from "@paltas/contracts";
import type { Db } from "../../db/database.js";

export interface AccountRow {
  code: string;
  name: string;
  type: AccountType;
  system: boolean;
  active: boolean;
}

export interface EntryRow {
  id: string;
  org_id: string;
  number: string;
  date: string;
  memo: string;
  currency: string;
  source: string;
  source_ref: string | null;
  status: JournalStatus;
  prepared_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  reverses: string | null;
  reversed_by: string | null;
}

interface LineRow {
  entry_id: string;
  line_no: number;
  account_code: string;
  account_name: string;
  debit_minor: number;
  credit_minor: number;
  memo: string;
}

export interface NewLine {
  account: string;
  debitMinor: number;
  creditMinor: number;
  memo?: string | undefined;
  dimensions?: Record<string, string> | undefined;
}

export async function accounts(db: Db, orgId: string, asOf: string): Promise<LedgerAccount[]> {
  return db.rows<LedgerAccount>(
    `SELECT a.code, a.name, a.type, a.system, a.active,
            COALESCE(sum(l.debit_minor - l.credit_minor) FILTER (WHERE e.id IS NOT NULL), 0)::bigint AS "balanceMinor"
     FROM ledger_accounts a
     LEFT JOIN journal_lines l ON l.org_id = a.org_id AND l.account_code = a.code
     LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.date <= $2
     WHERE a.org_id = $1
     GROUP BY a.code, a.name, a.type, a.system, a.active
     ORDER BY a.code`,
    [orgId, asOf],
  );
}

export async function account(db: Db, orgId: string, code: string): Promise<AccountRow | null> {
  return db.row<AccountRow>(
    "SELECT code, name, type, system, active FROM ledger_accounts WHERE org_id = $1 AND code = $2",
    [orgId, code],
  );
}

export async function entry(db: Db, orgId: string, id: string, forUpdate = false): Promise<EntryRow | null> {
  return db.row<EntryRow>(
    `SELECT * FROM journal_entries WHERE org_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [orgId, id],
  );
}

export async function insertEntry(
  db: Db,
  e: Omit<EntryRow, "approved_by" | "approved_at" | "rejected_reason" | "reversed_by" | "status">,
  lines: NewLine[],
): Promise<void> {
  await db.run(
    `INSERT INTO journal_entries (id, org_id, number, date, memo, currency, source, source_ref, status, prepared_by, reverses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_approval',$9,$10)`,
    [e.id, e.org_id, e.number, e.date, e.memo, e.currency, e.source, e.source_ref, e.prepared_by, e.reverses],
  );
  let n = 0;
  for (const l of lines) {
    await db.run(
      `INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, debit_minor, credit_minor, memo, dimensions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.id, ++n, e.org_id, l.account, l.debitMinor, l.creditMinor, l.memo ?? "", JSON.stringify(l.dimensions ?? {})],
    );
  }
}

export async function markPosted(db: Db, id: string, approvedBy: string | null): Promise<void> {
  await db.run(
    `UPDATE journal_entries SET status = 'posted', posted_at = now(), approved_by = $2,
       approved_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
     WHERE id = $1`,
    [id, approvedBy],
  );
}

export async function withLines(db: Db, rows: EntryRow[]): Promise<Journal[]> {
  if (!rows.length) return [];
  const lines = await db.rows<LineRow>(
    `SELECT l.entry_id, l.line_no, l.account_code, a.name AS account_name, l.debit_minor, l.credit_minor, l.memo
     FROM journal_lines l JOIN ledger_accounts a ON a.org_id = l.org_id AND a.code = l.account_code
     WHERE l.entry_id = ANY($1) ORDER BY l.entry_id, l.line_no`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => {
    const mine = lines.filter((l) => l.entry_id === r.id);
    return {
      id: r.id,
      number: r.number,
      date: r.date,
      memo: r.memo,
      currency: r.currency,
      source: r.source,
      sourceRef: r.source_ref,
      status: r.status,
      preparedBy: r.prepared_by,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      rejectedReason: r.rejected_reason,
      reverses: r.reverses,
      reversedBy: r.reversed_by,
      totalMinor: mine.reduce((a, l) => a + l.debit_minor, 0),
      lines: mine.map((l) => ({
        lineNo: l.line_no,
        account: l.account_code,
        accountName: l.account_name,
        debitMinor: l.debit_minor,
        creditMinor: l.credit_minor,
        memo: l.memo,
      })),
    };
  });
}

export async function lineTotals(db: Db, orgId: string, asOf: string) {
  return db.rows<{ code: string; name: string; type: AccountType; dr: number; cr: number }>(
    `SELECT a.code, a.name, a.type, sum(l.debit_minor)::bigint AS dr, sum(l.credit_minor)::bigint AS cr
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.date <= $2
     JOIN ledger_accounts a ON a.org_id = l.org_id AND a.code = l.account_code
     WHERE l.org_id = $1
     GROUP BY a.code, a.name, a.type
     ORDER BY a.code`,
    [orgId, asOf],
  );
}
