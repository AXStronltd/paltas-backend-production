/*
 * Owners: the owner statement (built from the owner's own postings in the ledger, so its closing equals the ledger by
 * construction and is checked against it) and owner payouts — prepared by one person, approved by a second, released by
 * someone other than the approver. Releasing posts Dr 2250 / Cr 1040; PALTAS moves no money: the bank file is
 * uploaded by hand and the payout is "paid" once it is matched on the bank statement.
 */
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { PmDeps } from "../deps.js";
import { numberScope } from "../shared/money.js";
import { ownerFunds } from "../shared/owner-funds.js";
import { cr, dr, post } from "../shared/posting.js";
import { sum } from "../shared/util.js";
import { formatMoney } from "../../../lib/money.js";

interface PayoutRow {
  id: string;
  number: string;
  owner_id: string;
  owner_name: string;
  amount_minor: number;
  balance_minor: number;
  reserve_minor: number;
  as_of: string;
  status: P.Payout["status"];
  prepared_by: string;
  approved_by: string | null;
  released_by: string | null;
  release_date: string | null;
  journal_id: string | null;
}

const toPayout = (r: PayoutRow): P.Payout => ({
  id: r.id,
  number: r.number,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  amountMinor: r.amount_minor,
  balanceMinor: r.balance_minor,
  reserveMinor: r.reserve_minor,
  asOf: r.as_of,
  status: r.status,
  preparedBy: r.prepared_by,
  approvedBy: r.approved_by,
  releasedBy: r.released_by,
  releaseDate: r.release_date,
  journalId: r.journal_id,
});

const PAYOUT_SQL = "SELECT p.*, c.name AS owner_name FROM pm_payouts p JOIN contacts c ON c.id = p.owner_id";

/** The owner's statement for a period, from the owner's linked postings on 2250 and migrated owner balances. */
export async function ownerStatement(
  db: Db,
  orgId: string,
  ownerId: string,
  ownerName: string,
  from: string,
  to: string,
) {
  if (from > to) throw fail.invalid("The start date is after the end date");
  const moves = await db.rows<{
    journal_id: string;
    date: string;
    kind: string;
    memo: string;
    cr2250: number;
    dr2250: number;
    fees: number;
  }>(
    `SELECT e.id AS journal_id, e.date, k.kind, e.memo,
       COALESCE(sum(l.credit_minor) FILTER (WHERE l.account_code = $3), 0)::bigint AS cr2250,
       COALESCE(sum(l.debit_minor) FILTER (WHERE l.account_code = $3), 0)::bigint AS dr2250,
       COALESCE(sum(l.credit_minor) FILTER (WHERE l.account_code = $4), 0)::bigint AS fees
     FROM pm_ledger_links k JOIN journal_entries e ON e.id = k.journal_id AND e.status = 'posted'
     JOIN journal_lines l ON l.entry_id = e.id
     WHERE k.org_id = $1 AND k.owner_id = $2 AND e.date <= $5
     GROUP BY e.id, e.date, k.kind, e.memo, e.number
     HAVING sum(l.debit_minor + l.credit_minor) FILTER (WHERE l.account_code = $3) > 0
     ORDER BY e.date, e.number`,
    [orgId, ownerId, ACC.ownerFunds, ACC.managementFees, to],
  );
  const brought = await db.rows<{ id: string; as_of: string | null; account: string; n: number }>(
    `SELECT id, as_of, account, (COALESCE(credit_minor, 0) - COALESCE(debit_minor, 0))::bigint AS n
     FROM pm_trial_balance_lines WHERE org_id = $1 AND owner_id = $2 AND paltas_account = $3
       AND COALESCE(as_of, '-infinity') <= $4
     ORDER BY as_of`,
    [orgId, ownerId, ACC.ownerFunds, to],
  );
  const before = moves.filter((m) => m.date < from);
  const inP = moves.filter((m) => m.date >= from);
  const bfBefore = brought.filter((b) => (b.as_of ?? "") < from);
  const bfIn = brought.filter((b) => (b.as_of ?? "") >= from);
  const opening = sum(before, (m) => m.cr2250 - m.dr2250) + sum(bfBefore, (b) => b.n);
  const of = (kind: string) => inP.filter((m) => m.kind === kind);
  const collections = of("collection");
  const collected = sum(collections, (m) => m.cr2250);
  const fees = sum(collections, (m) => m.fees);
  const vat = sum(collections, (m) => m.dr2250) - fees;
  const expenses = sum(of("bill"), (m) => m.dr2250 - m.cr2250);
  const deductions = sum(of("deposit_refund"), (m) => m.cr2250 - m.dr2250);
  const payouts = sum(of("payout"), (m) => m.dr2250 - m.cr2250);
  const known = new Set(["collection", "bill", "deposit_refund", "payout"]);
  const other = sum(
    inP.filter((m) => !known.has(m.kind)),
    (m) => m.cr2250 - m.dr2250,
  );
  const broughtForward = sum(bfIn, (b) => b.n);
  const closing = opening + collected - fees - vat - expenses + deductions - payouts + broughtForward + other;
  const ledgerClosing = (await ownerFunds(db, orgId, to, ownerId)).get(ownerId) ?? 0;
  return {
    ownerId,
    ownerName,
    from,
    to,
    openingMinor: opening,
    collectedMinor: collected,
    managementFeesMinor: fees,
    vatOnFeesMinor: vat,
    expensesMinor: expenses,
    depositDeductionsMinor: deductions,
    payoutsMinor: payouts,
    openingBroughtForwardMinor: broughtForward,
    otherMinor: other,
    closingMinor: closing,
    ledgerClosingMinor: ledgerClosing,
    agrees: closing === ledgerClosing,
    lines: [
      ...bfIn.map((b) => ({
        date: b.as_of ?? from,
        journalId: null,
        kind: "opening balance",
        memo: `Brought forward from the previous system: ${b.account}`,
        creditMinor: Math.max(b.n, 0),
        debitMinor: Math.max(-b.n, 0),
      })),
      ...inP.map((m) => ({
        date: m.date,
        journalId: m.journal_id,
        kind: m.kind,
        memo: m.memo,
        creditMinor: m.cr2250,
        debitMinor: m.dr2250,
      })),
    ],
  } satisfies P.OwnerStatement;
}

export function ownersService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  const payoutRow = async (t: Db, orgId: string, id: string, lock = false): Promise<PayoutRow> => {
    if (lock) await t.run("SELECT 1 FROM pm_payouts WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    const r = await t.row<PayoutRow>(`${PAYOUT_SQL} WHERE p.org_id = $1 AND p.id = $2`, [orgId, id]);
    if (!r) throw fail.notFound("Payout not found");
    return r;
  };

  return {
    async statement(s: OrgScope, ownerId: string, from: string, to: string) {
      const owner = await core.contacts.get(s.orgId, ownerId);
      if (!owner.types.includes("owner")) throw fail.notFound("Owner not found");
      return ownerStatement(db, s.orgId, ownerId, owner.name, from, to);
    },

    async listPayouts(s: OrgScope, ownerId?: string) {
      const rows = await db.rows<PayoutRow>(
        `${PAYOUT_SQL} WHERE p.org_id = $1 AND ($2::text IS NULL OR p.owner_id = $2) ORDER BY p.created_at DESC`,
        [s.orgId, ownerId ?? null],
      );
      return { payouts: rows.map(toPayout) };
    },

    async prepare(s: OrgScope, ownerId: string) {
      const id = await db.tx(async (t) => {
        const owner = await core.contacts.live(t, s.orgId, ownerId, true);
        if (!owner.types.includes("owner")) throw fail.notFound("Owner not found");
        const prof = await t.row<{ bank_verified_at: string | null; reserve_minor: number }>(
          "SELECT bank_verified_at, reserve_minor FROM pm_owner_profiles WHERE owner_id = $1",
          [ownerId],
        );
        if (!prof?.bank_verified_at) throw fail.conflict("The owner's bank details are not verified — payout blocked");
        const open = await t.row<{ number: string }>(
          "SELECT number FROM pm_payouts WHERE owner_id = $1 AND status IN ('prepared', 'approved')",
          [ownerId],
        );
        if (open) throw fail.conflict(`Payout ${open.number} for this owner is already in progress`);
        const balance = (await ownerFunds(t, s.orgId, s.today, ownerId)).get(ownerId) ?? 0;
        const amount = balance - prof.reserve_minor;
        if (amount <= 0)
          throw fail.conflict(
            `Nothing to pay above the reserve: funds ${formatMoney(balance, s.entitlement.org.currency)}, reserve ${formatMoney(prof.reserve_minor, s.entitlement.org.currency)}`,
          );
        const id = newId("ppo");
        const number = await nextNumber(t, numberScope(s.orgId), "OPY", 5);
        await t.run(
          `INSERT INTO pm_payouts (id, org_id, number, owner_id, amount_minor, balance_minor, reserve_minor, as_of, status,
             prepared_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'prepared', $9)`,
          [id, s.orgId, number, ownerId, amount, balance, prof.reserve_minor, s.today, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Owner payout prepared",
          target: number,
          detail: `${owner.name} · ${amount} (funds ${balance} − reserve ${prof.reserve_minor})`,
        });
        return id;
      });
      return toPayout(await payoutRow(db, s.orgId, id));
    },

    async approve(s: OrgScope, id: string) {
      await db.tx(async (t) => {
        const p = await payoutRow(t, s.orgId, id, true);
        if (p.status !== "prepared") throw fail.conflict(`This payout is already ${p.status}`);
        if (p.prepared_by === s.userId)
          throw fail.separationOfDuties("You prepared this payout — someone else must approve it");
        await t.run("UPDATE pm_payouts SET status = 'approved', approved_by = $2 WHERE id = $1", [id, s.userId]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Owner payout approved", target: p.number });
      });
      return toPayout(await payoutRow(db, s.orgId, id));
    },

    async release(s: OrgScope, id: string) {
      await db.tx(async (t) => {
        const p = await payoutRow(t, s.orgId, id, true);
        if (p.status !== "approved")
          throw fail.conflict(`Only an approved payout can be released (this one is ${p.status})`);
        if (p.approved_by === s.userId)
          throw fail.separationOfDuties("You approved this payout — someone else releases it");
        const funds = (await ownerFunds(t, s.orgId, s.today, p.owner_id)).get(p.owner_id) ?? 0;
        if (funds < p.amount_minor)
          throw fail.conflict(
            `The owner's funds are now ${formatMoney(funds, s.entitlement.org.currency)}, less than the payout ${formatMoney(p.amount_minor, s.entitlement.org.currency)} — cancel it`,
          );
        const journalId = await post(t, core, {
          orgId: s.orgId,
          date: s.today,
          kind: "payout",
          memo: `${p.number} · owner payout to ${p.owner_name} (bank file released by hand — no bank is connected)`,
          ref: `payout:${p.id}`,
          link: { ownerId: p.owner_id },
          lines: [dr(ACC.ownerFunds, p.amount_minor, "Owner payout"), cr(ACC.clientBank, p.amount_minor, p.number)],
        });
        await t.run(
          "UPDATE pm_payouts SET status = 'released', released_by = $2, release_date = $3, journal_id = $4 WHERE id = $1",
          [id, s.userId, s.today, journalId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Owner payout released",
          target: p.number,
          detail: `${p.amount_minor} · payment reference ${p.number}; marked paid when it appears on the bank statement`,
        });
      });
      return toPayout(await payoutRow(db, s.orgId, id));
    },

    async cancel(s: OrgScope, id: string, reason: string) {
      await db.tx(async (t) => {
        const p = await payoutRow(t, s.orgId, id, true);
        if (p.status !== "prepared" && p.status !== "approved")
          throw fail.conflict(`A ${p.status} payout cannot be cancelled`);
        await t.run("UPDATE pm_payouts SET status = 'cancelled' WHERE id = $1", [id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Owner payout cancelled",
          target: p.number,
          detail: reason,
        });
      });
      return toPayout(await payoutRow(db, s.orgId, id));
    },

    /** Default statement period: the current month to date. */
    defaultPeriod: (today: string) => ({ from: `${today.slice(0, 7)}-01`, to: today }),

    toPayout,
    PAYOUT_SQL,
  };
}

export type OwnersService = ReturnType<typeof ownersService>;
