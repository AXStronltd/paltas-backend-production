/*
 * Short stays: one calendar per stay listing. Bookings and owner/maintenance blocks that are confirmed, in house or
 * completed never overlap — the service checks, and the database's exclusion constraint makes it impossible even
 * for two requests at the same instant. Requests (from the marketplace) hold no nights until the host confirms.
 *
 * Money (RECORDED, never processed):
 *   payment before check-out   Dr 1000 bank          / Cr 2460 guest deposits held
 *   payment after check-out    Dr 1000 bank          / Cr 1190 guest receivables
 *   refund (before check-out)  Dr 2460               / Cr 1000
 *   check-out                  Dr 2460 (paid) + Dr 1190 (unpaid)
 *                              / Cr 4710 stay revenue (the organisation's own listing) — or, for an owner's listing,
 *                                Cr 2470 owner earnings (nights less the management %) + Cr 4720 management fees
 *                              / Cr 4720 or 4710 cleaning and service fees / Cr 2100 tax
 *   host payout (approved)     Dr 2470 (owner)       / Cr 1000, prepared by one person and approved by another.
 */
import type { agency } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, balance, post } from "../accounts.js";
import type { AgencyDeps } from "../deps.js";
import { findListing, type ListingRow } from "../listings/listings.repo.js";
import { findContact, linkContact, type Person } from "../shared/contacts.js";
import { quote } from "../shared/quote.js";
import { daysBetween, exclusive, shareOf, unique } from "../shared/util.js";
import { findStay, STAY_SQL, toStay, type StayRow } from "./stays.repo.js";

export const TAKEN = "Those nights are already booked or blocked";

/** Add a booking for a guest at the host's prices. Confirmed ones take the nights (or fail with 409). */
export async function insertBooking(
  t: Db,
  o: {
    orgId: string;
    listing: ListingRow;
    contactId: string;
    checkIn: string;
    checkOut: string;
    guests: number;
    source: "marketplace" | "direct";
    status: "requested" | "confirmed";
    note: string;
    tokenHash: string | null;
    by: string | null;
    today: string;
  },
): Promise<StayRow> {
  const l = o.listing;
  const q = await quote(t, l, { checkIn: o.checkIn, checkOut: o.checkOut, guests: o.guests }, o.today);
  const taken = q.problems.includes("Some of these nights are already booked");
  const other = q.problems.filter((p) => p !== "Some of these nights are already booked");
  if (other.length) throw fail.invalid(other.join("; "), { problems: other });
  if (taken) throw fail.conflict(TAKEN);
  const mgmt = l.agreement_id
    ? ((
        await t.row<{ commission_bp: number }>(
          "SELECT commission_bp FROM agency_agreements WHERE id = $1 AND kind = 'stay_management'",
          [l.agreement_id],
        )
      )?.commission_bp ?? 0)
    : 0;
  const id = newId("sty");
  await exclusive(
    t.run(
      `INSERT INTO agency_stays (id, org_id, number, listing_id, kind, contact_id, check_in, check_out, guests, source,
         status, accommodation_minor, cleaning_minor, service_fee_minor, tax_minor, total_minor, owner_contact_id,
         management_bp, note, token_hash, created_by)
       VALUES ($1,$2,$3,$4,'booking',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        o.orgId,
        await nextNumber(t, o.orgId, "STY"),
        l.id,
        o.contactId,
        o.checkIn,
        o.checkOut,
        o.guests,
        o.source,
        o.status,
        q.accommodationMinor,
        q.cleaningMinor,
        q.serviceFeeMinor,
        q.taxMinor,
        q.totalMinor,
        l.owner_contact_id,
        l.owner_contact_id ? mgmt : 0,
        o.note,
        o.tokenHash,
        o.by,
      ],
    ),
    TAKEN,
  );
  return findStay(t, o.orgId, id);
}

/** What an owner earns from a completed stay: the nights less the management share. */
const ownerShare = (r: StayRow) => r.accommodation_minor - shareOf(r.accommodation_minor, r.management_bp);

export function staysService(d: AgencyDeps) {
  const { db } = d.core;

  async function audit(t: Db, s: OrgScope, action: string, r: StayRow, detail = "") {
    await recordAudit(t, { actor: s.actor, orgId: s.orgId, action, target: r.number, detail });
  }

  /** Check-out: the stay's money moves from deposits / receivable to revenue, owner earnings and tax. */
  async function postCompleted(t: Db, s: OrgScope, r: StayRow) {
    const deposits = Math.min(r.paid_minor, r.total_minor);
    const fees = r.cleaning_minor + r.service_fee_minor;
    const owner = r.owner_contact_id ? ownerShare(r) : 0;
    const dims = { stay: r.number, listing: r.listing_id };
    const j = await post(d.core, t, {
      orgId: s.orgId,
      date: s.today,
      memo: `Stay ${r.number} completed · ${r.g_name ?? ""} · ${r.check_in} → ${r.check_out}`,
      sourceRef: `stay-completed:${r.id}`,
      lines: [
        { account: ACC.guestDeposits, debitMinor: deposits, dimensions: dims },
        { account: ACC.guestReceivable, debitMinor: r.total_minor - deposits, dimensions: dims },
        ...(r.owner_contact_id
          ? [
              {
                account: ACC.ownerPayable,
                creditMinor: owner,
                dimensions: { ...dims, owner: r.owner_contact_id },
              },
              { account: ACC.managementFees, creditMinor: r.accommodation_minor - owner + fees, dimensions: dims },
            ]
          : [{ account: ACC.stayRevenue, creditMinor: r.accommodation_minor + fees, dimensions: dims }]),
        { account: ACC.vat, creditMinor: r.tax_minor, dimensions: dims },
      ],
    });
    await t.run("UPDATE agency_stays SET completed_journal = $2 WHERE id = $1", [r.id, j.id]);
  }

  return {
    async list(s: OrgScope, q: { status?: string | undefined; listingId?: string | undefined }) {
      const rows = await db.rows<StayRow>(
        `${STAY_SQL} WHERE s.org_id = $1 AND ($2::text IS NULL OR s.status = $2) AND ($3::text IS NULL OR s.listing_id = $3)
         ORDER BY s.check_in DESC, s.id LIMIT 1000`,
        [s.orgId, q.status ?? null, q.listingId ?? null],
      );
      return { stays: rows.map(toStay) };
    },

    async create(
      s: OrgScope,
      b:
        | {
            kind: "booking";
            listingId: string;
            guest: Person;
            checkIn: string;
            checkOut: string;
            guests: number;
            note: string;
          }
        | {
            kind: "block";
            listingId: string;
            checkIn: string;
            checkOut: string;
            source: "owner" | "maintenance";
            note: string;
          },
    ) {
      return db.tx(async (t) => {
        const l = await findListing(t, s.orgId, b.listingId);
        if (l.purpose !== "stay") throw fail.invalid("Only stays are booked");
        if (l.status === "closed") throw fail.conflict("This listing is closed");
        let r: StayRow;
        if (b.kind === "booking") {
          const guest = await linkContact(d.core, t, {
            orgId: s.orgId,
            person: b.guest,
            as: "guest",
            source: "Direct stay booking",
            actor: s.actor,
          });
          r = await insertBooking(t, {
            orgId: s.orgId,
            listing: l,
            contactId: guest.id,
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            guests: b.guests,
            source: "direct",
            status: "confirmed",
            note: b.note,
            tokenHash: null,
            by: s.userId,
            today: s.today,
          });
        } else {
          const nights = daysBetween(b.checkIn, b.checkOut);
          if (nights < 1 || nights > 366) throw fail.invalid("Block 1 to 366 nights");
          if (b.checkOut <= s.today) throw fail.invalid("A block must end after today");
          const id = newId("sty");
          await exclusive(
            t.run(
              `INSERT INTO agency_stays (id, org_id, number, listing_id, kind, check_in, check_out, source, status, note, created_by)
               VALUES ($1, $2, $3, $4, 'block', $5, $6, $7, 'confirmed', $8, $9)`,
              [
                id,
                s.orgId,
                await nextNumber(t, s.orgId, "STY"),
                l.id,
                b.checkIn,
                b.checkOut,
                b.source,
                b.note,
                s.userId,
              ],
            ),
            TAKEN,
          );
          r = await findStay(t, s.orgId, id);
        }
        await audit(
          t,
          s,
          b.kind === "booking" ? "Stay booked directly" : "Stay nights blocked",
          r,
          `${r.check_in} → ${r.check_out}`,
        );
        return toStay(r);
      });
    },

    async action(
      s: OrgScope,
      id: string,
      b:
        | { action: "confirm" }
        | { action: "decline"; reason: string }
        | { action: "cancel"; reason: string }
        | { action: "check_in" }
        | { action: "check_out" },
    ) {
      return db.tx(async (t) => {
        const r = await findStay(t, s.orgId, id, true);
        const set = (status: string, note?: string) =>
          t.run("UPDATE agency_stays SET status = $2, decided_by = $3, note = COALESCE($4, note) WHERE id = $1", [
            id,
            status,
            s.userId,
            note ?? null,
          ]);
        switch (b.action) {
          case "confirm":
            if (r.status !== "requested") throw fail.conflict(`This booking is ${r.status}`);
            if (r.check_in < s.today) throw fail.conflict("The check-in date has passed — decline the request");
            await exclusive(set("confirmed"), TAKEN);
            break;
          case "decline":
            if (r.status !== "requested") throw fail.conflict(`This booking is ${r.status}`);
            await set("declined", b.reason);
            break;
          case "cancel":
            if (!["requested", "confirmed"].includes(r.status))
              throw fail.conflict(`A ${r.status} stay cannot be cancelled`);
            await set("cancelled", b.reason);
            break;
          case "check_in":
            if (r.kind !== "booking" || r.status !== "confirmed")
              throw fail.conflict("Only a confirmed booking checks in");
            if (s.today < r.check_in || s.today >= r.check_out)
              throw fail.conflict(`Check-in is from ${r.check_in} until the day before ${r.check_out}`);
            await set("checked_in");
            break;
          case "check_out":
            if (r.status !== "checked_in") throw fail.conflict("Only a guest in house checks out");
            await set("completed");
            await postCompleted(t, s, r);
            break;
        }
        const out = await findStay(t, s.orgId, id);
        await audit(t, s, `Stay ${b.action.replace("_", "-")}`, out, "reason" in b ? b.reason : "");
        return toStay(out);
      });
    },

    async payment(
      s: OrgScope,
      id: string,
      b: { kind: "payment" | "refund"; amountMinor: number; method: string; reference: string },
    ) {
      return db.tx(async (t) => {
        const r = await findStay(t, s.orgId, id, true);
        if (r.kind !== "booking") throw fail.invalid("A block has no payments");
        const dims = { stay: r.number };
        let lines;
        if (b.kind === "payment") {
          if (!["confirmed", "checked_in", "completed"].includes(r.status))
            throw fail.conflict(`A ${r.status} booking takes no payment`);
          if (b.amountMinor > r.total_minor - r.paid_minor)
            throw fail.invalid(`At most ${r.total_minor - r.paid_minor} is still due on this stay`);
          const credit = r.status === "completed" ? ACC.guestReceivable : ACC.guestDeposits;
          lines = [
            { account: ACC.bank, debitMinor: b.amountMinor, dimensions: dims },
            { account: credit, creditMinor: b.amountMinor, dimensions: dims },
          ];
        } else {
          if (r.status === "completed") throw fail.conflict("After check-out, correct the stay with a journal");
          if (b.amountMinor > r.paid_minor) throw fail.invalid(`At most ${r.paid_minor} was paid on this stay`);
          lines = [
            { account: ACC.guestDeposits, debitMinor: b.amountMinor, dimensions: dims },
            { account: ACC.bank, creditMinor: b.amountMinor, dimensions: dims },
          ];
        }
        const pid = newId("spy");
        const j = await post(d.core, t, {
          orgId: s.orgId,
          date: s.today,
          memo: `Stay ${r.number} ${b.kind} recorded · ${b.method} · ${b.reference}`,
          sourceRef: `stay-${b.kind}:${pid}`,
          lines,
        });
        await unique(
          t.run(
            `INSERT INTO agency_stay_payments (id, org_id, stay_id, kind, amount_minor, method, reference, recorded_by, journal_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [pid, s.orgId, r.id, b.kind, b.amountMinor, b.method, b.reference, s.userId, j.id],
          ),
          "That payment reference is already recorded",
        );
        await t.run("UPDATE agency_stays SET paid_minor = paid_minor + $2 WHERE id = $1", [
          r.id,
          b.kind === "payment" ? b.amountMinor : -b.amountMinor,
        ]);
        const out = await findStay(t, s.orgId, id);
        await audit(
          t,
          s,
          b.kind === "payment" ? "Guest payment recorded" : "Guest refund recorded",
          out,
          `${b.amountMinor} · ${b.reference}`,
        );
        return toStay(out);
      });
    },

    // ---------------------------------------------------------------- host payouts
    async payouts(s: OrgScope) {
      const rows = await db.rows<PayoutRow>(`${PAYOUT_SQL} WHERE p.org_id = $1 ORDER BY p.created_at DESC, p.id`, [
        s.orgId,
      ]);
      const owners = await db.rows<{ id: string; name: string }>(
        `SELECT DISTINCT c.id, c.name FROM contacts c JOIN agency_stays s ON s.owner_contact_id = c.id
         WHERE c.org_id = $1 AND s.status = 'completed' ORDER BY c.name`,
        [s.orgId],
      );
      const out: agency.OwnerBalance[] = [];
      for (const o of owners) out.push(await ownerBalance(db, s, o.id, o.name));
      return {
        payouts: rows.map(toPayout),
        owners: out,
        ledgerPayableMinor: -(await balance(db, s.orgId, ACC.ownerPayable, s.today)),
      };
    },

    async prepare(s: OrgScope, b: { ownerContactId: string; amountMinor: number; note: string }) {
      return db.tx(async (t) => {
        const owner = await findContact(d.core, t, s.orgId, b.ownerContactId);
        // one payout decision per owner at a time
        await t.run("SELECT 1 FROM contacts WHERE id = $1 FOR UPDATE", [owner.id]);
        const bal = await ownerBalance(t, s, owner.id, owner.name);
        if (b.amountMinor > bal.dueMinor)
          throw fail.invalid(`${owner.name} is due ${bal.dueMinor} — no more can be paid out`);
        const id = newId("po");
        await t.run(
          `INSERT INTO agency_payouts (id, org_id, number, owner_contact_id, amount_minor, note, prepared_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, s.orgId, await nextNumber(t, s.orgId, "PO"), owner.id, b.amountMinor, b.note, s.userId],
        );
        const p = (await t.row<PayoutRow>(`${PAYOUT_SQL} WHERE p.id = $1`, [id])) as PayoutRow;
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Host payout prepared",
          target: p.number,
          detail: `${owner.name} · ${b.amountMinor}`,
        });
        return toPayout(p);
      });
    },

    async decide(
      s: OrgScope,
      id: string,
      b: { decision: "approve"; reference: string } | { decision: "reject"; reason: string },
    ) {
      return db.tx(async (t) => {
        const p = await t.row<PayoutRow>(`${PAYOUT_SQL} WHERE p.org_id = $1 AND p.id = $2 FOR UPDATE OF p`, [
          s.orgId,
          id,
        ]);
        if (!p) throw fail.notFound("Payout not found");
        if (p.status !== "prepared") throw fail.conflict(`This payout is already ${p.status}`);
        if (p.prepared_by === s.userId)
          throw fail.separationOfDuties("You prepared this payout — someone else must approve or reject it");
        if (b.decision === "reject") {
          await t.run("UPDATE agency_payouts SET status = 'rejected', reject_reason = $2 WHERE id = $1", [
            id,
            b.reason,
          ]);
        } else {
          await t.run("SELECT 1 FROM contacts WHERE id = $1 FOR UPDATE", [p.owner_contact_id]);
          const owed = -(await balance(t, s.orgId, ACC.ownerPayable, s.today, {
            key: "owner",
            value: p.owner_contact_id,
          }));
          if (p.amount_minor > owed)
            throw fail.conflict(`${p.owner_name} is owed ${owed} in the ledger — less than this payout`);
          const j = await post(d.core, t, {
            orgId: s.orgId,
            date: s.today,
            memo: `Host payout ${p.number} · ${p.owner_name} · ${b.reference} (recorded — made outside PALTAS)`,
            sourceRef: `payout:${p.id}`,
            lines: [
              {
                account: ACC.ownerPayable,
                debitMinor: p.amount_minor,
                dimensions: { owner: p.owner_contact_id, payout: p.number },
              },
              { account: ACC.bank, creditMinor: p.amount_minor, dimensions: { payout: p.number } },
            ],
          });
          await unique(
            t.run(
              `UPDATE agency_payouts SET status = 'approved', approved_by = $2, approved_at = now(), reference = $3,
                 journal_id = $4 WHERE id = $1`,
              [id, s.userId, b.reference, j.id],
            ),
            "That bank reference is already recorded on another payout",
          );
        }
        const out = (await t.row<PayoutRow>(`${PAYOUT_SQL} WHERE p.id = $1`, [id])) as PayoutRow;
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.decision === "approve" ? "Host payout approved and recorded" : "Host payout rejected",
          target: p.number,
          detail: b.decision === "approve" ? b.reference : b.reason,
        });
        return toPayout(out);
      });
    },
  };
}

interface PayoutRow {
  id: string;
  number: string;
  owner_contact_id: string;
  owner_name: string;
  amount_minor: number;
  note: string;
  status: agency.Payout["status"];
  prepared_by: string;
  approved_by: string | null;
  reference: string | null;
  journal_id: string | null;
  reject_reason: string | null;
  created_at: string;
}
const PAYOUT_SQL = `SELECT p.*, c.name AS owner_name FROM agency_payouts p JOIN contacts c ON c.id = p.owner_contact_id`;
const toPayout = (p: PayoutRow): agency.Payout => ({
  id: p.id,
  number: p.number,
  ownerContactId: p.owner_contact_id,
  ownerName: p.owner_name,
  amountMinor: p.amount_minor,
  note: p.note,
  status: p.status,
  preparedBy: p.prepared_by,
  approvedBy: p.approved_by,
  reference: p.reference,
  journalId: p.journal_id,
  rejectReason: p.reject_reason,
  createdAt: p.created_at,
});

/** An owner's earnings and payouts, read from the ledger (2470 by owner), less payouts still waiting for approval. */
async function ownerBalance(db: Db, s: OrgScope, ownerId: string, name: string): Promise<agency.OwnerBalance> {
  const r = await db.row<{ earned: number; paid: number }>(
    `SELECT COALESCE(sum(l.credit_minor), 0)::bigint AS earned, COALESCE(sum(l.debit_minor), 0)::bigint AS paid
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
     WHERE l.org_id = $1 AND l.account_code = $2 AND l.dimensions ->> 'owner' = $3`,
    [s.orgId, ACC.ownerPayable, ownerId],
  );
  const prepared =
    (
      await db.row<{ n: number }>(
        "SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM agency_payouts WHERE org_id = $1 AND owner_contact_id = $2 AND status = 'prepared'",
        [s.orgId, ownerId],
      )
    )?.n ?? 0;
  const earned = r?.earned ?? 0;
  const paid = r?.paid ?? 0;
  return {
    ownerContactId: ownerId,
    ownerName: name,
    earnedMinor: earned,
    paidOutMinor: paid,
    preparedMinor: prepared,
    dueMinor: earned - paid - prepared,
  };
}

export type StaysService = ReturnType<typeof staysService>;
