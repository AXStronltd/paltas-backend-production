/*
 * Security postings go to the organisation's ONE ledger through core.ledger.postSystemJournal (source
 * "system:security"), inside the caller's transaction. Each journal is linked to its kind, site and client so the
 * security reports read exactly the postings Finance sees.
 */
import type { CoreServices } from "../../../core/core-services.js";
import type { NewLine } from "../../../core/ledger/ledger.repo.js";
import type { Db } from "../../../db/database.js";

export type PostingKind = "invoice" | "receipt" | "certificate" | "payroll" | "payroll_payment" | "cost" | "remittance";

export interface SecurityPosting {
  orgId: string;
  date: string;
  kind: PostingKind;
  memo: string;
  /** Unique per source document; posting the same document twice returns the first journal. */
  ref: string;
  siteId?: string | null;
  clientId?: string | null;
  lines: NewLine[];
}

export async function postToLedger(t: Db, core: CoreServices, p: SecurityPosting): Promise<string> {
  const j = await core.ledger.postSystemJournal(t, {
    orgId: p.orgId,
    date: p.date,
    memo: p.memo,
    source: "system:security",
    sourceRef: p.ref,
    lines: p.lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0),
  });
  await t.run(
    `INSERT INTO sec_ledger_links (journal_id, org_id, kind, site_id, client_id, date)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (journal_id) DO NOTHING`,
    [j.id, p.orgId, p.kind, p.siteId ?? null, p.clientId ?? null, p.date],
  );
  return j.id;
}

export const dr = (account: string, amount: number, memo?: string): NewLine => ({
  account,
  debitMinor: amount,
  creditMinor: 0,
  memo,
});
export const cr = (account: string, amount: number, memo?: string): NewLine => ({
  account,
  debitMinor: 0,
  creditMinor: amount,
  memo,
});
