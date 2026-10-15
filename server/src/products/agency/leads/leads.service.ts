/*
 * The marketplace inbox and the lead pipeline: enquiries → leads (one open lead per person and listing) → viewings
 * (an agent never in two viewings within the hour) → offers → won (only by closing a deal) or lost (with a reason).
 * A leasing agent sees their own and unassigned leads; a manager (agency.leads.assign) sees every lead.
 */
import { agency as A, roleCan } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { AgencyDeps } from "../deps.js";
import { findListing } from "../listings/listings.repo.js";
import { linkContact, noteOnContact, type Person } from "../shared/contacts.js";
import { requireMember } from "../shared/members.js";
import { exclusive, unique } from "../shared/util.js";
import {
  ENQUIRY_SQL,
  findLead,
  LEAD_SQL,
  leadEvent,
  OFFER_SQL,
  toEnquiry,
  toLead,
  toOffer,
  toViewing,
  VIEWING_SQL,
  type EnquiryRow,
  type LeadRow,
  type OfferRow,
  type ViewingRow,
} from "./leads.repo.js";

type Stage = A.Lead["stage"];
const rank = (s: Stage) => A.LEAD_STAGES.indexOf(s);
const OPEN = (s: Stage) => s !== "won" && s !== "lost";

const DONE = { accept: "accepted", reject: "rejected", counter: "countered" } as const;

const seesAll = (s: OrgScope) => roleCan(s.role, "agency.leads.assign");

/** Move a lead forward to a stage (never backwards), recording when. */
export async function advanceLead(
  t: Db,
  lead: { id: string; org_id: string; stage: Stage },
  to: Stage,
  by: string | null,
) {
  if (!OPEN(lead.stage) || rank(lead.stage) >= rank(to)) return;
  await t.run("UPDATE agency_leads SET stage = $2, stage_at = now() WHERE id = $1", [lead.id, to]);
  await leadEvent(t, lead, "stage", `Stage: ${lead.stage} → ${to}`, by);
}

/** The person's open lead for this listing, or a new one. */
export async function openLeadFor(
  t: Db,
  o: {
    orgId: string;
    contactId: string;
    listingId: string | null;
    source: string;
    by: string | null;
    agent?: string | null;
  },
): Promise<LeadRow> {
  const open = await t.row<LeadRow>(
    `${LEAD_SQL} WHERE l.org_id = $1 AND l.contact_id = $2 AND l.listing_id IS NOT DISTINCT FROM $3
       AND l.stage NOT IN ('won', 'lost') ORDER BY l.created_at LIMIT 1 FOR UPDATE OF l`,
    [o.orgId, o.contactId, o.listingId],
  );
  if (open) return open;
  const id = newId("lead");
  await t.run(
    `INSERT INTO agency_leads (id, org_id, number, contact_id, listing_id, source, agent_user, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, o.orgId, await nextNumber(t, o.orgId, "LEAD"), o.contactId, o.listingId, o.source, o.agent ?? null, o.by],
  );
  const lead = await findLead(t, o.orgId, id);
  await leadEvent(t, lead, "created", `New lead via ${o.source}`, o.by);
  return lead;
}

export function leadsService(d: AgencyDeps) {
  const { db } = d.core;

  /** A lead this person may work on (an agent: their own or unassigned), or 404. */
  async function visibleLead(t: Db, s: OrgScope, id: string, lock = false): Promise<LeadRow> {
    const lead = await findLead(t, s.orgId, id);
    if (!seesAll(s) && lead.agent_user && lead.agent_user !== s.userId) throw fail.notFound("Lead not found");
    if (lock) await t.run("SELECT 1 FROM agency_leads WHERE id = $1 FOR UPDATE", [id]);
    return lead;
  }

  async function viewing(t: Db, orgId: string, id: string): Promise<ViewingRow> {
    const v = await t.row<ViewingRow>(`${VIEWING_SQL} WHERE v.org_id = $1 AND v.id = $2`, [orgId, id]);
    if (!v) throw fail.notFound("Viewing not found");
    return v;
  }

  async function book(
    t: Db,
    s: OrgScope,
    lead: LeadRow,
    b: { listingId?: string | undefined; date: string; time: string; agentUserId?: string | undefined },
  ): Promise<ViewingRow> {
    if (!OPEN(lead.stage)) throw fail.conflict("This lead is closed");
    const listingId = b.listingId ?? lead.listing_id;
    if (!listingId) throw fail.invalid("Choose the listing to view");
    const listing = await findListing(t, s.orgId, listingId);
    if (listing.status === "closed") throw fail.conflict("That listing is closed (sold or let)");
    if (listing.purpose === "stay") throw fail.invalid("Stays are booked, not viewed");
    if (b.date < s.today) throw fail.invalid("Pick today or a future date");
    const agent = b.agentUserId ?? lead.agent_user ?? s.userId;
    if (agent !== s.userId && !seesAll(s)) throw fail.roleNotAllowed("Only a manager books viewings for someone else");
    await requireMember(t, s.orgId, agent, "agency.leads.manage");
    const id = newId("vw");
    await exclusive(
      t.run(
        `INSERT INTO agency_viewings (id, org_id, number, lead_id, listing_id, contact_id, agent_user, date, time,
           starts_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $11)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "VW"),
          lead.id,
          listingId,
          lead.contact_id,
          agent,
          b.date,
          b.time,
          `${b.date} ${b.time}`,
          s.userId,
        ],
      ),
      "That agent already has a viewing within an hour of this time",
    );
    if (!lead.listing_id) await t.run("UPDATE agency_leads SET listing_id = $2 WHERE id = $1", [lead.id, listingId]);
    if (!lead.first_response_at)
      await t.run("UPDATE agency_leads SET first_response_at = now() WHERE id = $1", [lead.id]);
    await advanceLead(t, lead, "viewing", s.userId);
    const text = `Viewing booked: ${listing.number} on ${b.date} ${b.time}`;
    await leadEvent(t, lead, "viewing", text, s.userId);
    await noteOnContact(d.core, t, {
      orgId: s.orgId,
      contactId: lead.contact_id,
      kind: "viewing",
      text,
      refType: "agency_viewing",
      refId: id,
      by: s.userId,
    });
    return viewing(t, s.orgId, id);
  }

  return {
    // ---------------------------------------------------------------- inbox
    async inbox(s: OrgScope, status?: string) {
      const rows = await db.rows<EnquiryRow>(
        `${ENQUIRY_SQL} WHERE e.org_id = $1 AND ($2::text IS NULL OR e.status = $2) ORDER BY e.created_at DESC, e.id LIMIT 500`,
        [s.orgId, status ?? null],
      );
      const n = await db.row<{ new: number; offers: number; bookings: number }>(
        `SELECT (SELECT count(*) FROM agency_enquiries WHERE org_id = $1 AND status = 'new')::int AS new,
                (SELECT count(*) FROM agency_offers WHERE org_id = $1 AND status = 'pending')::int AS offers,
                (SELECT count(*) FROM agency_stays WHERE org_id = $1 AND status = 'requested')::int AS bookings`,
        [s.orgId],
      );
      return {
        enquiries: rows.map(toEnquiry),
        counts: { new: n?.new ?? 0, offersPending: n?.offers ?? 0, bookingRequests: n?.bookings ?? 0 },
      };
    },

    async convert(s: OrgScope, enquiryId: string, agentUserId?: string) {
      return db.tx(async (t) => {
        const e = await t.row<EnquiryRow>(`${ENQUIRY_SQL} WHERE e.org_id = $1 AND e.id = $2 FOR UPDATE OF e`, [
          s.orgId,
          enquiryId,
        ]);
        if (!e) throw fail.notFound("Enquiry not found");
        if (e.status !== "new") throw fail.conflict(`This enquiry is already ${e.status}`);
        const agent = agentUserId ?? (seesAll(s) ? null : s.userId);
        if (agent && agent !== s.userId && !seesAll(s))
          throw fail.roleNotAllowed("Only a manager gives leads to someone else");
        if (agent) await requireMember(t, s.orgId, agent, "agency.leads.manage");
        const lead = await openLeadFor(t, {
          orgId: s.orgId,
          contactId: e.contact_id,
          listingId: e.listing_id,
          source: e.source,
          by: s.userId,
          agent,
        });
        if (!lead.agent_user && agent)
          await t.run("UPDATE agency_leads SET agent_user = $2 WHERE id = $1", [lead.id, agent]);
        await leadEvent(t, lead, "enquiry", `${e.number}: ${e.message || "(no message)"}`.slice(0, 2000), s.userId);
        let v: ViewingRow | null = null;
        if (e.kind === "viewing_request" && e.preferred_date && e.preferred_date >= s.today)
          v = await book(t, s, await findLead(t, s.orgId, lead.id), {
            date: e.preferred_date,
            time: e.preferred_time ?? "10:00",
            agentUserId: agent ?? s.userId,
          });
        await t.run(
          "UPDATE agency_enquiries SET status = 'converted', lead_id = $2, handled_by = $3, handled_at = now() WHERE id = $1",
          [e.id, lead.id, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Enquiry converted to a lead",
          target: e.number,
          detail: lead.number,
        });
        return { lead: toLead(await findLead(t, s.orgId, lead.id)), viewing: v ? toViewing(v) : null };
      });
    },

    async closeEnquiry(s: OrgScope, enquiryId: string, status: "closed" | "spam") {
      return db.tx(async (t) => {
        const e = await t.row<EnquiryRow>(`${ENQUIRY_SQL} WHERE e.org_id = $1 AND e.id = $2 FOR UPDATE OF e`, [
          s.orgId,
          enquiryId,
        ]);
        if (!e) throw fail.notFound("Enquiry not found");
        if (e.status !== "new") throw fail.conflict(`This enquiry is already ${e.status}`);
        await t.run("UPDATE agency_enquiries SET status = $2, handled_by = $3, handled_at = now() WHERE id = $1", [
          e.id,
          status,
          s.userId,
        ]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: `Enquiry marked ${status}`, target: e.number });
        return toEnquiry({ ...e, status });
      });
    },

    // ---------------------------------------------------------------- leads
    async list(s: OrgScope, stage?: string) {
      const rows = await db.rows<LeadRow>(
        `${LEAD_SQL} WHERE l.org_id = $1 AND ($2::text IS NULL OR l.stage = $2)
           AND ($3::text IS NULL OR l.agent_user IS NULL OR l.agent_user = $3)
         ORDER BY l.created_at DESC, l.id LIMIT 1000`,
        [s.orgId, stage ?? null, seesAll(s) ? null : s.userId],
      );
      return { leads: rows.map(toLead) };
    },

    async create(
      s: OrgScope,
      b: {
        person: Person;
        listingId?: string | undefined;
        source: string;
        budgetMinor?: number | undefined;
        agentUserId?: string | undefined;
      },
    ) {
      return db.tx(async (t) => {
        if (b.listingId) await findListing(t, s.orgId, b.listingId);
        const agent = b.agentUserId ?? (seesAll(s) ? null : s.userId);
        if (agent && agent !== s.userId && !seesAll(s))
          throw fail.roleNotAllowed("Only a manager gives leads to someone else");
        if (agent) await requireMember(t, s.orgId, agent, "agency.leads.manage");
        const c = await linkContact(d.core, t, {
          orgId: s.orgId,
          person: b.person,
          as: "enquirer",
          source: b.source,
          actor: s.actor,
        });
        const lead = await openLeadFor(t, {
          orgId: s.orgId,
          contactId: c.id,
          listingId: b.listingId ?? null,
          source: b.source,
          by: s.userId,
          agent,
        });
        if (b.budgetMinor)
          await t.run("UPDATE agency_leads SET budget_minor = $2 WHERE id = $1", [lead.id, b.budgetMinor]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lead created",
          target: lead.number,
          detail: c.name,
        });
        return toLead(await findLead(t, s.orgId, lead.id));
      });
    },

    async get(s: OrgScope, id: string) {
      const lead = await visibleLead(db, s, id);
      const events = await db.rows<{ kind: string; text: string; by_user: string | null; at: string }>(
        "SELECT kind, text, by_user, at FROM agency_lead_events WHERE lead_id = $1 ORDER BY id",
        [id],
      );
      const viewings = await db.rows<ViewingRow>(`${VIEWING_SQL} WHERE v.lead_id = $1 ORDER BY v.starts_at`, [id]);
      const offers = await db.rows<OfferRow>(`${OFFER_SQL} WHERE o.lead_id = $1 ORDER BY o.created_at`, [id]);
      return {
        lead: toLead(lead),
        events: events.map((e) => ({ kind: e.kind, text: e.text, byUserId: e.by_user, at: e.at })),
        viewings: viewings.map(toViewing),
        offers: offers.map(toOffer),
      };
    },

    async move(s: OrgScope, id: string, b: { stage: Stage; lostReason?: string | undefined }) {
      return db.tx(async (t) => {
        const lead = await visibleLead(t, s, id, true);
        if (!OPEN(lead.stage)) throw fail.conflict(`This lead is already ${lead.stage}`);
        if (b.stage === "won") throw fail.invalid("A lead is won by closing a deal");
        if (b.stage === "lost" && !b.lostReason) throw fail.invalid("Record why the lead was lost");
        await t.run("UPDATE agency_leads SET stage = $2, stage_at = now(), lost_reason = $3 WHERE id = $1", [
          id,
          b.stage,
          b.stage === "lost" ? (b.lostReason ?? null) : null,
        ]);
        await leadEvent(
          t,
          lead,
          "stage",
          `Stage: ${lead.stage} → ${b.stage}${b.lostReason ? ` (${b.lostReason})` : ""}`,
          s.userId,
        );
        return toLead(await findLead(t, s.orgId, id));
      });
    },

    async assign(s: OrgScope, id: string, agentUserId: string) {
      return db.tx(async (t) => {
        const lead = await visibleLead(t, s, id, true);
        await requireMember(t, s.orgId, agentUserId, "agency.leads.manage");
        await t.run("UPDATE agency_leads SET agent_user = $2 WHERE id = $1", [id, agentUserId]);
        await leadEvent(t, lead, "assigned", "Lead assigned", s.userId);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lead assigned",
          target: lead.number,
          detail: agentUserId,
        });
        return toLead(await findLead(t, s.orgId, id));
      });
    },

    async note(s: OrgScope, id: string, b: { kind: "note" | "call" | "email" | "meeting"; text: string }) {
      return db.tx(async (t) => {
        const lead = await visibleLead(t, s, id, true);
        await leadEvent(t, lead, b.kind, b.text, s.userId);
        if (b.kind !== "note") {
          if (!lead.first_response_at)
            await t.run("UPDATE agency_leads SET first_response_at = now() WHERE id = $1", [id]);
          await advanceLead(t, lead, "contacted", s.userId);
        }
        return toLead(await findLead(t, s.orgId, id));
      });
    },

    // ---------------------------------------------------------------- viewings
    async bookViewing(
      s: OrgScope,
      leadId: string,
      b: { listingId?: string | undefined; date: string; time: string; agentUserId?: string | undefined },
    ) {
      return db.tx(async (t) => {
        const lead = await visibleLead(t, s, leadId, true);
        const v = await book(t, s, lead, b);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Viewing booked",
          target: v.number,
          detail: lead.number,
        });
        return toViewing(v);
      });
    },

    async viewings(s: OrgScope, q: { from?: string | undefined; to?: string | undefined }) {
      const rows = await db.rows<ViewingRow>(
        `${VIEWING_SQL} WHERE v.org_id = $1 AND ($2::date IS NULL OR v.date >= $2) AND ($3::date IS NULL OR v.date <= $3)
           AND ($4::text IS NULL OR v.agent_user = $4)
         ORDER BY v.starts_at, v.id LIMIT 1000`,
        [s.orgId, q.from ?? null, q.to ?? null, seesAll(s) ? null : s.userId],
      );
      return { viewings: rows.map(toViewing) };
    },

    async viewingAction(
      s: OrgScope,
      id: string,
      b:
        | { action: "confirm" }
        | { action: "cancel"; reason: string }
        | { action: "outcome"; attended: boolean; feedback: string; interest?: number | undefined },
    ) {
      return db.tx(async (t) => {
        const v = await viewing(t, s.orgId, id);
        if (!seesAll(s) && v.agent_user !== s.userId) throw fail.notFound("Viewing not found");
        await t.run("SELECT 1 FROM agency_viewings WHERE id = $1 FOR UPDATE", [id]);
        if (!["scheduled", "confirmed"].includes(v.status)) throw fail.conflict(`This viewing is already ${v.status}`);
        const lead = await findLead(t, s.orgId, v.lead_id);
        if (b.action === "confirm") {
          if (v.status === "confirmed") throw fail.conflict("Already confirmed");
          await t.run("UPDATE agency_viewings SET status = 'confirmed' WHERE id = $1", [id]);
        } else if (b.action === "cancel") {
          await t.run("UPDATE agency_viewings SET status = 'cancelled', feedback = $2 WHERE id = $1", [id, b.reason]);
          await leadEvent(t, lead, "viewing", `Viewing ${v.number} cancelled: ${b.reason}`, s.userId);
        } else {
          if (v.date > s.today) throw fail.invalid("Record the outcome on or after the day of the viewing");
          if (b.attended && !b.interest) throw fail.invalid("Rate the client's interest from 1 to 5");
          await t.run("UPDATE agency_viewings SET status = $2, feedback = $3, interest = $4 WHERE id = $1", [
            id,
            b.attended ? "completed" : "no_show",
            b.feedback,
            b.attended ? (b.interest ?? null) : null,
          ]);
          await leadEvent(
            t,
            lead,
            "viewing",
            b.attended
              ? `Viewing completed · interest ${b.interest}/5 ${b.feedback}`.trim()
              : "Did not attend the viewing",
            s.userId,
          );
          if (b.attended) await advanceLead(t, lead, "viewed", s.userId);
        }
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: `Viewing ${b.action}`, target: v.number });
        return toViewing(await viewing(t, s.orgId, id));
      });
    },

    // ---------------------------------------------------------------- offers
    async offers(s: OrgScope, status?: string) {
      const rows = await db.rows<OfferRow>(
        `${OFFER_SQL} WHERE o.org_id = $1 AND ($2::text IS NULL OR o.status = $2) ORDER BY o.created_at DESC, o.id`,
        [s.orgId, status ?? null],
      );
      return { offers: rows.map(toOffer) };
    },

    async respond(
      s: OrgScope,
      id: string,
      b: { action: "accept" } | { action: "reject" } | { action: "counter"; counterMinor: number },
    ) {
      return db.tx(async (t) => {
        const o = await t.row<OfferRow>(`${OFFER_SQL} WHERE o.org_id = $1 AND o.id = $2 FOR UPDATE OF o`, [
          s.orgId,
          id,
        ]);
        if (!o) throw fail.notFound("Offer not found");
        const listing = await findListing(t, s.orgId, o.listing_id, true);
        if (listing.status === "closed") throw fail.conflict("The listing is closed");
        if (b.action === "accept") {
          if (!["pending", "countered"].includes(o.status)) throw fail.conflict(`This offer is ${o.status}`);
          await unique(
            t.run("UPDATE agency_offers SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1", [
              id,
              s.userId,
            ]),
            "Another offer on this listing is already accepted",
          );
        } else if (b.action === "reject") {
          if (!["pending", "countered"].includes(o.status)) throw fail.conflict(`This offer is ${o.status}`);
          await t.run(
            "UPDATE agency_offers SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1",
            [id, s.userId],
          );
        } else {
          if (o.status !== "pending") throw fail.conflict("Only a new offer can be countered");
          if (b.counterMinor <= o.amount_minor) throw fail.invalid("A counter-offer is above the offer");
          await t.run(
            "UPDATE agency_offers SET status = 'countered', counter_minor = $2, decided_by = $3, decided_at = now() WHERE id = $1",
            [id, b.counterMinor, s.userId],
          );
        }
        if (o.lead_id) {
          const lead = await findLead(t, s.orgId, o.lead_id);
          await leadEvent(t, lead, "offer", `Offer ${o.number} ${DONE[b.action]}`, s.userId);
        }
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: `Offer ${DONE[b.action]}`, target: o.number });
        return toOffer((await t.row<OfferRow>(`${OFFER_SQL} WHERE o.id = $1`, [id])) as OfferRow);
      });
    },
  };
}

export type LeadsService = ReturnType<typeof leadsService>;
