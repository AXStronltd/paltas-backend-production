/*
 * Commission agreements, closed deals and commissions.
 *   close a deal  → the listing leaves the marketplace, the lead is won, other open offers are declined, and the
 *                   commission is computed from the agreement (% of the deal value + fixed fee, VAT, agent's share)
 *                   and raised for approval;
 *   approve       → someone OTHER than who raised it (also a database constraint) — posts
 *                   Dr 1180 total / Cr 4700 commission / Cr 2100 VAT, and the agent's share Dr 5710 / Cr 2480;
 *   receipt       → RECORDED (never collected here): Dr 1000 / Cr 1180, each bank reference once.
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
import { leadEvent } from "../leads/leads.repo.js";
import { findListing } from "../listings/listings.repo.js";
import { findContact, tag } from "../shared/contacts.js";
import { shareOf, toBp, toPct, unique } from "../shared/util.js";
import { formatMoney } from "../../../lib/money.js";

interface AgreementRow {
  id: string;
  number: string;
  kind: agency.Agreement["kind"];
  client_contact_id: string;
  client_name: string;
  commission_bp: number;
  commission_fixed_minor: number;
  vat_bp: number;
  agent_share_bp: number;
  starts_on: string;
  ends_on: string | null;
  status: "active" | "ended";
}
const AGREEMENT_SQL = `SELECT a.*, c.name AS client_name FROM agency_agreements a
  JOIN contacts c ON c.id = a.client_contact_id`;
const toAgreement = (a: AgreementRow): agency.Agreement => ({
  id: a.id,
  number: a.number,
  kind: a.kind,
  clientContactId: a.client_contact_id,
  clientName: a.client_name,
  commissionPct: toPct(a.commission_bp),
  commissionFixedMinor: a.commission_fixed_minor,
  vatPct: toPct(a.vat_bp),
  agentSharePct: toPct(a.agent_share_bp),
  startsOn: a.starts_on,
  endsOn: a.ends_on,
  status: a.status,
});

interface CommissionRow {
  id: string;
  org_id: string;
  number: string;
  deal_id: string;
  agreement_id: string;
  client_name: string;
  base_minor: number;
  commission_minor: number;
  vat_minor: number;
  total_minor: number;
  agent_user: string | null;
  agent_share_minor: number;
  received_minor: number;
  status: agency.Commission["status"];
  raised_by: string;
  approved_by: string | null;
  reject_reason: string | null;
  journal_id: string | null;
}
const COMMISSION_SQL = `SELECT m.*, c.name AS client_name FROM agency_commissions m
  JOIN contacts c ON c.id = m.client_contact_id`;
const toCommission = (m: CommissionRow): agency.Commission => ({
  id: m.id,
  number: m.number,
  dealId: m.deal_id,
  agreementId: m.agreement_id,
  clientName: m.client_name,
  baseMinor: m.base_minor,
  commissionMinor: m.commission_minor,
  vatMinor: m.vat_minor,
  totalMinor: m.total_minor,
  agentUserId: m.agent_user,
  agentShareMinor: m.agent_share_minor,
  receivedMinor: m.received_minor,
  status: m.status,
  raisedBy: m.raised_by,
  approvedBy: m.approved_by,
  rejectReason: m.reject_reason,
  journalId: m.journal_id,
});

interface DealRow {
  id: string;
  number: string;
  listing_id: string;
  lead_id: string | null;
  offer_id: string | null;
  agreement_id: string;
  kind: "sale" | "letting";
  value_minor: number;
  closed_on: string;
  agent_user: string | null;
  commission_id: string;
}
const DEAL_SQL = `SELECT d.*, m.id AS commission_id FROM agency_deals d JOIN agency_commissions m ON m.deal_id = d.id`;
const toDeal = (d: DealRow): agency.Deal => ({
  id: d.id,
  number: d.number,
  listingId: d.listing_id,
  leadId: d.lead_id,
  offerId: d.offer_id,
  agreementId: d.agreement_id,
  kind: d.kind,
  valueMinor: d.value_minor,
  closedOn: d.closed_on,
  agentUserId: d.agent_user,
  commissionId: d.commission_id,
});

export function dealsService(d: AgencyDeps) {
  const { db } = d.core;

  async function commission(t: Db, orgId: string, id: string, lock = false): Promise<CommissionRow> {
    const m = await t.row<CommissionRow>(
      `${COMMISSION_SQL} WHERE m.org_id = $1 AND m.id = $2${lock ? " FOR UPDATE OF m" : ""}`,
      [orgId, id],
    );
    if (!m) throw fail.notFound("Commission not found");
    return m;
  }

  return {
    // ---------------------------------------------------------------- agreements
    async agreements(s: OrgScope) {
      const rows = await db.rows<AgreementRow>(`${AGREEMENT_SQL} WHERE a.org_id = $1 ORDER BY a.created_at DESC`, [
        s.orgId,
      ]);
      return { agreements: rows.map(toAgreement) };
    },

    async createAgreement(
      s: OrgScope,
      b: {
        kind: agency.Agreement["kind"];
        clientContactId: string;
        commissionPct: number;
        commissionFixedMinor: number;
        vatPct: number;
        agentSharePct: number;
        startsOn: string;
        endsOn?: string | undefined;
      },
    ) {
      return db.tx(async (t) => {
        const client = await findContact(d.core, t, s.orgId, b.clientContactId);
        if (b.kind !== "stay_management" && b.commissionPct === 0 && b.commissionFixedMinor === 0)
          throw fail.invalid("Agree a commission percentage or a fixed fee");
        if (b.endsOn && b.endsOn < b.startsOn) throw fail.invalid("The agreement cannot end before it starts");
        const id = newId("agr");
        await t.run(
          `INSERT INTO agency_agreements (id, org_id, number, kind, client_contact_id, commission_bp, commission_fixed_minor,
             vat_bp, agent_share_bp, starts_on, ends_on, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            s.orgId,
            await nextNumber(t, s.orgId, "AGR"),
            b.kind,
            client.id,
            toBp(b.commissionPct),
            b.commissionFixedMinor,
            toBp(b.vatPct),
            toBp(b.agentSharePct),
            b.startsOn,
            b.endsOn ?? null,
            s.userId,
          ],
        );
        await tag(
          t,
          s.orgId,
          client.id,
          b.kind === "stay_management" ? "owner" : b.kind === "sale" ? "seller" : "landlord",
        );
        const a = (await t.row<AgreementRow>(`${AGREEMENT_SQL} WHERE a.id = $1`, [id])) as AgreementRow;
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Commission agreement made",
          target: a.number,
          detail: `${client.name} · ${b.kind} · ${b.commissionPct}% + ${b.commissionFixedMinor}`,
        });
        return toAgreement(a);
      });
    },

    // ---------------------------------------------------------------- deals
    async deals(s: OrgScope) {
      const rows = await db.rows<DealRow>(`${DEAL_SQL} WHERE d.org_id = $1 ORDER BY d.closed_on DESC, d.id`, [s.orgId]);
      return { deals: rows.map(toDeal) };
    },

    async close(
      s: OrgScope,
      b: {
        listingId: string;
        agreementId: string;
        valueMinor?: number | undefined;
        closedOn: string;
        leadId?: string | undefined;
        offerId?: string | undefined;
      },
    ) {
      return db.tx(async (t) => {
        const listing = await findListing(t, s.orgId, b.listingId, true);
        if (listing.purpose === "stay") throw fail.invalid("Stays earn through bookings, not deals");
        if (listing.status === "closed") throw fail.conflict("This listing already has a closed deal");
        if (b.closedOn > s.today) throw fail.invalid("A deal cannot close in the future");
        const a = await t.row<AgreementRow>(`${AGREEMENT_SQL} WHERE a.org_id = $1 AND a.id = $2`, [
          s.orgId,
          b.agreementId,
        ]);
        if (!a) throw fail.notFound("Agreement not found");
        const kind = listing.purpose === "sale" ? "sale" : "letting";
        if (a.kind !== kind) throw fail.invalid(`A ${listing.purpose} deal needs a ${kind} agreement`);
        if (a.status !== "active" || b.closedOn < a.starts_on || (a.ends_on && b.closedOn > a.ends_on))
          throw fail.conflict("The agreement does not cover the closing date");
        let value = b.valueMinor ?? null;
        let leadId = b.leadId ?? null;
        if (b.offerId) {
          const o = await t.row<{ status: string; amount_minor: number; lead_id: string | null; listing_id: string }>(
            "SELECT status, amount_minor, lead_id, listing_id FROM agency_offers WHERE org_id = $1 AND id = $2",
            [s.orgId, b.offerId],
          );
          if (!o || o.listing_id !== listing.id) throw fail.notFound("Offer not found");
          if (o.status !== "accepted") throw fail.conflict("Only an accepted offer closes a deal");
          if (value !== null && value !== o.amount_minor) throw fail.invalid("The deal value is the accepted offer");
          value = o.amount_minor;
          leadId = leadId ?? o.lead_id;
        }
        value = value ?? listing.price_minor;
        const lead = leadId
          ? await t.row<{ id: string; org_id: string; stage: string; agent_user: string | null; number: string }>(
              "SELECT id, org_id, stage, agent_user, number FROM agency_leads WHERE org_id = $1 AND id = $2 FOR UPDATE",
              [s.orgId, leadId],
            )
          : null;
        if (leadId && !lead) throw fail.notFound("Lead not found");
        if (lead && (lead.stage === "won" || lead.stage === "lost"))
          throw fail.conflict(`The lead is already ${lead.stage}`);
        const agent = listing.agent_user ?? lead?.agent_user ?? null;

        const commissionMinor = shareOf(value, a.commission_bp) + a.commission_fixed_minor;
        if (commissionMinor <= 0) throw fail.invalid("The agreement gives no commission on this deal");
        const vat = shareOf(commissionMinor, a.vat_bp);
        const agentShare = agent ? shareOf(commissionMinor, a.agent_share_bp) : 0;

        const dealId = newId("deal");
        await unique(
          t.run(
            `INSERT INTO agency_deals (id, org_id, number, listing_id, lead_id, offer_id, agreement_id, kind, value_minor,
               closed_on, agent_user, closed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              dealId,
              s.orgId,
              await nextNumber(t, s.orgId, "DEAL"),
              listing.id,
              leadId,
              b.offerId ?? null,
              a.id,
              kind,
              value,
              b.closedOn,
              agent,
              s.userId,
            ],
          ),
          "This listing already has a closed deal",
        );
        const comId = newId("com");
        await t.run(
          `INSERT INTO agency_commissions (id, org_id, number, deal_id, agreement_id, client_contact_id, base_minor,
             commission_minor, vat_minor, total_minor, agent_user, agent_share_minor, raised_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            comId,
            s.orgId,
            await nextNumber(t, s.orgId, "COM"),
            dealId,
            a.id,
            a.client_contact_id,
            value,
            commissionMinor,
            vat,
            commissionMinor + vat,
            agent,
            agentShare,
            s.userId,
          ],
        );
        await t.run("UPDATE agency_listings SET status = 'closed', updated_at = now() WHERE id = $1", [listing.id]);
        await t.run(
          `UPDATE agency_offers SET status = 'rejected', decided_by = $2, decided_at = now()
           WHERE listing_id = $1 AND status IN ('pending', 'countered')`,
          [listing.id, s.userId],
        );
        if (lead) {
          await t.run("UPDATE agency_leads SET stage = 'won', stage_at = now() WHERE id = $1", [lead.id]);
          await leadEvent(t, lead, "stage", `Won: deal on ${listing.number}`, s.userId);
        }
        const deal = (await t.row<DealRow>(`${DEAL_SQL} WHERE d.id = $1`, [dealId])) as DealRow;
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Deal closed — commission raised for approval",
          target: deal.number,
          detail: `${listing.number} · value ${value} · commission ${commissionMinor} + VAT ${vat}`,
        });
        return { deal: toDeal(deal), commission: toCommission(await commission(t, s.orgId, comId)) };
      });
    },

    // ---------------------------------------------------------------- commissions
    async commissions(s: OrgScope, status?: string) {
      const rows = await db.rows<CommissionRow>(
        `${COMMISSION_SQL} WHERE m.org_id = $1 AND ($2::text IS NULL OR m.status = $2) ORDER BY m.created_at DESC, m.id`,
        [s.orgId, status ?? null],
      );
      const posted = await db.rows<CommissionRow>(
        `${COMMISSION_SQL} WHERE m.org_id = $1 AND m.status IN ('approved', 'paid')`,
        [s.orgId],
      );
      const sum = (f: (m: CommissionRow) => number) => posted.reduce((a, m) => a + f(m), 0);
      return {
        commissions: rows.map(toCommission),
        totals: {
          approvedCommissionMinor: sum((m) => m.commission_minor),
          approvedVatMinor: sum((m) => m.vat_minor),
          receivedMinor: sum((m) => m.received_minor),
          outstandingMinor: sum((m) => m.total_minor - m.received_minor),
          ledgerIncomeMinor: -(await balance(db, s.orgId, ACC.commissionIncome, s.today)),
          ledgerReceivableMinor: await balance(db, s.orgId, ACC.commissionReceivable, s.today),
        },
      };
    },

    async decide(s: OrgScope, id: string, b: { decision: "approve" } | { decision: "reject"; reason: string }) {
      return db.tx(async (t) => {
        const m = await commission(t, s.orgId, id, true);
        if (m.status !== "pending_approval")
          throw fail.conflict(`This commission is already ${m.status.replace("_", " ")}`);
        if (m.raised_by === s.userId)
          throw fail.separationOfDuties("You raised this commission — someone else must approve or reject it");
        if (b.decision === "reject") {
          await t.run("UPDATE agency_commissions SET status = 'rejected', reject_reason = $2 WHERE id = $1", [
            id,
            b.reason,
          ]);
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Commission rejected",
            target: m.number,
            detail: b.reason,
          });
          return toCommission(await commission(t, s.orgId, id));
        }
        const deal = (await t.row<{ number: string; closed_on: string }>(
          "SELECT number, closed_on FROM agency_deals WHERE id = $1",
          [m.deal_id],
        )) as { number: string; closed_on: string };
        const dims = { deal: deal.number, commission: m.number };
        const j = await post(d.core, t, {
          orgId: s.orgId,
          date: s.today,
          memo: `Commission ${m.number} · ${m.client_name} · deal ${deal.number}`,
          sourceRef: `commission:${m.id}`,
          lines: [
            { account: ACC.commissionReceivable, debitMinor: m.total_minor, dimensions: dims },
            { account: ACC.commissionIncome, creditMinor: m.commission_minor, dimensions: dims },
            { account: ACC.vat, creditMinor: m.vat_minor, dimensions: dims },
            { account: ACC.agentShareExpense, debitMinor: m.agent_share_minor, dimensions: dims },
            { account: ACC.agentSharePayable, creditMinor: m.agent_share_minor, dimensions: dims },
          ],
        });
        await t.run(
          "UPDATE agency_commissions SET status = 'approved', approved_by = $2, approved_at = now(), journal_id = $3 WHERE id = $1",
          [id, s.userId, j.id],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Commission approved and posted",
          target: m.number,
          detail: `${j.number} · ${m.total_minor}`,
        });
        return toCommission(await commission(t, s.orgId, id));
      });
    },

    async receipt(s: OrgScope, id: string, b: { amountMinor: number; reference: string; receivedOn: string }) {
      return db.tx(async (t) => {
        const m = await commission(t, s.orgId, id, true);
        if (m.status !== "approved") throw fail.conflict("Only an approved, unpaid commission can receive money");
        if (b.amountMinor > m.total_minor - m.received_minor)
          throw fail.invalid(
            `At most ${formatMoney(m.total_minor - m.received_minor, s.entitlement.org.currency)} is still due on this commission`,
          );
        if (b.receivedOn > s.today) throw fail.invalid("Money cannot be received in the future");
        const rid = newId("crc");
        const j = await post(d.core, t, {
          orgId: s.orgId,
          date: b.receivedOn,
          memo: `Commission ${m.number} received · ${b.reference}`,
          sourceRef: `commission-receipt:${rid}`,
          lines: [
            { account: ACC.bank, debitMinor: b.amountMinor },
            { account: ACC.commissionReceivable, creditMinor: b.amountMinor, dimensions: { commission: m.number } },
          ],
        });
        await unique(
          t.run(
            `INSERT INTO agency_commission_receipts (id, org_id, commission_id, amount_minor, reference, received_on,
               recorded_by, journal_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [rid, s.orgId, m.id, b.amountMinor, b.reference, b.receivedOn, s.userId, j.id],
          ),
          "That bank reference is already recorded",
        );
        const received = m.received_minor + b.amountMinor;
        await t.run("UPDATE agency_commissions SET received_minor = $2, status = $3 WHERE id = $1", [
          id,
          received,
          received === m.total_minor ? "paid" : "approved",
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Commission receipt recorded",
          target: m.number,
          detail: `${b.amountMinor} · ${b.reference}`,
        });
        return toCommission(await commission(t, s.orgId, id));
      });
    },
  };
}

export type DealsService = ReturnType<typeof dealsService>;
