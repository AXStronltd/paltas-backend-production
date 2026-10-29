/*
 * Property Management postings go to the organisation's ONE ledger through core.ledger.postSystemJournal
 * (source "system:property"), inside the caller's transaction, once per source document (the ref). Each journal is
 * linked to the property, owner, tenant and lease it belongs to (pm_ledger_links), so owner statements, tenant
 * balances and the dashboards read exactly the postings Finance sees. A closed month refuses the posting.
 */
import type { CoreServices } from "../../../core/core-services.js";
import type { NewLine } from "../../../core/ledger/ledger.repo.js";
import type { Db } from "../../../db/database.js";

export type PostingKind =
  | "provider_settlement"
  | "payroll"
  | "payroll_payment"
  | "payroll_remittance"
  | "payroll_reversal"
  | "invoice"
  | "receipt"
  | "collection"
  | "credit_note"
  | "deposit_refund"
  | "bill"
  | "bill_payment"
  | "payout";

export interface PostingLink {
  propertyId?: string | null;
  ownerId?: string | null;
  tenantId?: string | null;
  leaseId?: string | null;
}

export interface PmPosting {
  orgId: string;
  date: string;
  kind: PostingKind;
  memo: string;
  /** Unique per source document; posting the same document again returns the first journal. */
  ref: string;
  link: PostingLink;
  lines: NewLine[];
  reverses?: string;
}

export const SOURCE = "system:property" as const;

export async function post(t: Db, core: CoreServices, p: PmPosting): Promise<string> {
  const j = await core.ledger.postSystemJournal(t, {
    orgId: p.orgId,
    date: p.date,
    memo: p.memo,
    source: SOURCE,
    sourceRef: p.ref,
    ...(p.reverses ? { reverses: p.reverses } : {}),
    lines: p.lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0),
  });
  await t.run(
    `INSERT INTO pm_ledger_links (journal_id, org_id, kind, property_id, owner_id, tenant_id, lease_id, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (journal_id) DO NOTHING`,
    [
      j.id,
      p.orgId,
      p.kind,
      p.link.propertyId ?? null,
      p.link.ownerId ?? null,
      p.link.tenantId ?? null,
      p.link.leaseId ?? null,
      p.ref,
    ],
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

/**
 * The PM part of the ledger: journals posted by Property Management, plus opening balances posted by a PM data
 * migration. Used by every "equal to the ledger" figure.
 */
export const PM_JOURNALS_SQL = `(
  SELECT e.id FROM journal_entries e WHERE e.org_id = $1 AND e.status = 'posted' AND e.source = '${SOURCE}'
  UNION ALL
  SELECT e.id FROM journal_entries e
    JOIN mig_batches b ON e.source_ref IN ('migration:' || b.id, 'migration:' || b.id || ':reversal')
    JOIN mig_jobs j ON j.id = b.job_id AND j.domain = 'property'
  WHERE e.org_id = $1 AND e.status = 'posted' AND e.source = 'system:migration'
)`;

/** The PM balance (debit − credit) of an account at a date, from the ledger. */
export async function pmBalance(db: Db, orgId: string, account: string, asOf: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT COALESCE(sum(l.debit_minor - l.credit_minor), 0)::bigint AS n
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.org_id = $1 AND l.account_code = $2 AND e.date <= $3 AND e.id IN ${PM_JOURNALS_SQL}`,
    [orgId, account, asOf],
  );
  return r?.n ?? 0;
}
