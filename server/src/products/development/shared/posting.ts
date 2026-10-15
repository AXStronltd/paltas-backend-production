/*
 * Development postings go to the organisation's ONE ledger through core.ledger.postSystemJournal (source
 * "system:development"), inside the caller's transaction, once per source document (the ref). Each line carries
 * dimensions (project, cost code, contract, unit, buyer, supplier, invoice) so reports read the same postings
 * Finance sees.
 */
import type { CoreServices } from "../../../core/core-services.js";
import { ensureAccounts } from "../../../core/ledger/default-chart.js";
import type { NewLine } from "../../../core/ledger/ledger.repo.js";
import type { Db } from "../../../db/database.js";
import { DEV_ACCOUNTS } from "../accounts.js";

export const SOURCE = "system:development" as const;

export interface Dims {
  /** "cost" marks the line that carries a project cost (the cost report reads these). */
  kind?: "cost";
  project?: string | null;
  costCode?: string | null;
  contract?: string | null;
  unit?: string | null;
  buyer?: string | null;
  supplier?: string | null;
  invoice?: string | null;
}

function clean(d: Dims | undefined): Record<string, string> | undefined {
  if (!d) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" && v) out[k] = v;
  return out;
}

export const dr = (account: string, amount: number, memo: string, dims?: Dims): NewLine => ({
  account,
  debitMinor: amount,
  creditMinor: 0,
  memo,
  dimensions: clean(dims),
});
export const cr = (account: string, amount: number, memo: string, dims?: Dims): NewLine => ({
  account,
  debitMinor: 0,
  creditMinor: amount,
  memo,
  dimensions: clean(dims),
});

export interface Posting {
  orgId: string;
  date: string;
  memo: string;
  /** Unique per source document: posting it again returns the first journal. */
  ref: string;
  lines: NewLine[];
}

export async function post(t: Db, core: CoreServices, p: Posting): Promise<string> {
  await ensureAccounts(t, p.orgId, DEV_ACCOUNTS);
  const j = await core.ledger.postSystemJournal(t, {
    orgId: p.orgId,
    date: p.date,
    memo: p.memo,
    source: SOURCE,
    sourceRef: p.ref,
    lines: p.lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0),
  });
  return j.id;
}

/** Posted balance (debits − credits) of these accounts, optionally only lines carrying these dimensions. */
export async function ledgerBalance(
  db: Db,
  orgId: string,
  accounts: string[],
  dims: Record<string, string> = {},
): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT COALESCE(sum(l.debit_minor - l.credit_minor), 0)::bigint AS n
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
     WHERE l.org_id = $1 AND l.account_code = ANY($2) AND l.dimensions @> $3::jsonb`,
    [orgId, accounts, JSON.stringify(dims)],
  );
  return r?.n ?? 0;
}
