/*
 * Hotel postings go to the organisation's ONE ledger through core.ledger.postSystemJournal (source "system:hotel"),
 * inside the caller's transaction. Each journal is linked to its hotel and business date so the hotel reports read
 * exactly the postings Finance sees.
 */
import type { CoreServices } from "../../../core/core-services.js";
import type { NewLine } from "../../../core/ledger/ledger.repo.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import type { PropertyRow } from "./property.js";

export type PostingKind =
  | "charge"
  | "void"
  | "payment"
  | "deposit"
  | "deposit_applied"
  | "refund"
  | "city_ledger"
  | "city_ledger_payment"
  | "room_night"
  | "commission"
  | "cost";

export interface HotelPosting {
  orgId: string;
  propertyId: string;
  /** The hotel's business date: the journal date. */
  date: string;
  kind: PostingKind;
  memo: string;
  /** Unique per source document; posting the same document twice returns the first journal. */
  ref: string;
  channelId?: string | null;
  lines: NewLine[];
}

const BUSINESS_DATE_FOR_SHARE = "SELECT business_date FROM hotel_properties WHERE org_id = $1 AND id = $2 FOR SHARE";

/**
 * The hotel's business date for a posting, read under FOR SHARE inside the posting's own transaction. The night audit
 * holds the property row FOR UPDATE while it rolls the date, so a posting either commits before the audit reads the
 * day or waits and then sees the new date. The scope is refreshed so every row the transaction writes carries that
 * date. Call it first in the transaction, before other row locks, so postings and the audit lock in the same order.
 */
export async function lockBusinessDate(t: Db, op: { orgId: string; property: PropertyRow }): Promise<string> {
  const r = await t.row<{ business_date: string }>(BUSINESS_DATE_FOR_SHARE, [op.orgId, op.property.id]);
  if (!r) throw fail.notFound("Hotel not found");
  op.property.business_date = r.business_date;
  return r.business_date;
}

export async function postToLedger(t: Db, core: CoreServices, p: HotelPosting): Promise<string> {
  // a posting dated anything but the hotel's current business date (held under FOR SHARE) is refused
  const bd = await t.row<{ business_date: string }>(BUSINESS_DATE_FOR_SHARE, [p.orgId, p.propertyId]);
  if (!bd) throw fail.notFound("Hotel not found");
  if (bd.business_date !== p.date)
    throw fail.conflict(`The hotel's business date is now ${bd.business_date} — try again`);
  const j = await core.ledger.postSystemJournal(t, {
    orgId: p.orgId,
    date: p.date,
    memo: p.memo,
    source: "system:hotel",
    sourceRef: p.ref,
    lines: p.lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0),
  });
  await t.run(
    `INSERT INTO hotel_ledger_links (journal_id, org_id, property_id, business_date, kind, channel_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (journal_id) DO NOTHING`,
    [j.id, p.orgId, p.propertyId, p.date, p.kind, p.channelId ?? null],
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
