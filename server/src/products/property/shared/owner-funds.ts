/*
 * What the agency holds for each owner (account 2250), read from the ledger: the owner's linked postings plus the
 * owner balances a PM data migration brought over (posted in the migration's opening-balance journal).
 */
import type { Db } from "../../../db/database.js";
import { ACC } from "../accounts.js";

export async function ownerFunds(db: Db, orgId: string, asOf: string, ownerId: string | null = null) {
  const rows = await db.rows<{ owner_id: string; n: number }>(
    `SELECT owner_id, sum(n)::bigint AS n FROM (
       SELECT k.owner_id, sum(l.credit_minor - l.debit_minor) AS n
       FROM pm_ledger_links k JOIN journal_entries e ON e.id = k.journal_id AND e.status = 'posted'
       JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = $2
       WHERE k.org_id = $1 AND k.owner_id IS NOT NULL AND e.date <= $3 AND ($4::text IS NULL OR k.owner_id = $4)
       GROUP BY k.owner_id
       UNION ALL
       SELECT t.owner_id, sum(COALESCE(t.credit_minor, 0) - COALESCE(t.debit_minor, 0))
       FROM pm_trial_balance_lines t
       WHERE t.org_id = $1 AND t.paltas_account = $2 AND t.owner_id IS NOT NULL AND COALESCE(t.as_of, '-infinity') <= $3
         AND ($4::text IS NULL OR t.owner_id = $4)
       GROUP BY t.owner_id
     ) x GROUP BY owner_id`,
    [orgId, ACC.ownerFunds, asOf, ownerId],
  );
  return new Map(rows.map((r) => [r.owner_id, r.n]));
}
