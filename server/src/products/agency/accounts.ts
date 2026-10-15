/*
 * The ledger accounts an Agent / Host organisation needs, added to its chart when it subscribes
 * (ProductModule.accounts), and the posting helper every agency money movement uses. Core accounts used as well:
 * 1000 operating bank (payments RECORDED as received or paid outside PALTAS) and 2100 VAT payable.
 */
import type { CoreServices } from "../../core/core-services.js";
import type { AccountSeed } from "../../core/ledger/default-chart.js";
import type { Db } from "../../db/database.js";

export const AGENCY_ACCOUNTS: AccountSeed[] = [
  { code: "1180", name: "Commission receivable", type: "asset", system: true },
  { code: "1190", name: "Guest stay receivables", type: "asset", system: true },
  { code: "2460", name: "Guest booking deposits held", type: "liability", system: true },
  { code: "2470", name: "Stay owner (host) payouts payable", type: "liability", system: true },
  { code: "2480", name: "Agent commission shares payable", type: "liability", system: true },
  { code: "4700", name: "Agency commission income", type: "income", system: true },
  { code: "4710", name: "Short-stay revenue", type: "income", system: true },
  { code: "4720", name: "Stay management fees", type: "income", system: true },
  { code: "5710", name: "Agent commission shares", type: "expense", system: true },
];

export const ACC = {
  bank: "1000",
  vat: "2100",
  commissionReceivable: "1180",
  guestReceivable: "1190",
  guestDeposits: "2460",
  ownerPayable: "2470",
  agentSharePayable: "2480",
  commissionIncome: "4700",
  stayRevenue: "4710",
  managementFees: "4720",
  agentShareExpense: "5710",
} as const;

export interface Line {
  account: string;
  debitMinor?: number;
  creditMinor?: number;
  memo?: string;
  dimensions?: Record<string, string>;
}

/** Post one agency document to the ONE ledger, once (the same sourceRef never posts twice). Zero lines are dropped. */
export async function post(
  core: CoreServices,
  t: Db,
  e: { orgId: string; date: string; memo: string; sourceRef: string; lines: Line[] },
) {
  const lines = e.lines
    .filter((l) => (l.debitMinor ?? 0) > 0 || (l.creditMinor ?? 0) > 0)
    .map((l) => ({
      account: l.account,
      debitMinor: l.debitMinor ?? 0,
      creditMinor: l.creditMinor ?? 0,
      memo: l.memo,
      dimensions: l.dimensions,
    }));
  return core.ledger.postSystemJournal(t, {
    orgId: e.orgId,
    date: e.date,
    memo: e.memo,
    source: "system:agency",
    sourceRef: e.sourceRef,
    lines,
  });
}

/** Debit minus credit of one account (posted journals up to a date); optionally for one dimension value. */
export async function balance(
  db: Db,
  orgId: string,
  account: string,
  asOf: string,
  dimension?: { key: string; value: string },
): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT COALESCE(sum(l.debit_minor - l.credit_minor), 0)::bigint AS n
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.date <= $3
     WHERE l.org_id = $1 AND l.account_code = $2 AND ($4::text IS NULL OR l.dimensions ->> $4 = $5)`,
    [orgId, account, asOf, dimension?.key ?? null, dimension?.value ?? null],
  );
  return r?.n ?? 0;
}
