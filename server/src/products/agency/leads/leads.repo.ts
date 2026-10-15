// SQL only: inbox enquiries, leads, viewings and offers, with the contact each one is about.
import type { agency } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

interface WithContact {
  contact_id: string;
  c_name: string;
  c_email: string | null;
  c_phone: string | null;
}
const contactOf = (r: WithContact) => ({ id: r.contact_id, name: r.c_name, email: r.c_email, phone: r.c_phone });
const C = "c.name AS c_name, c.email AS c_email, c.phone AS c_phone";

export interface LeadRow extends WithContact {
  id: string;
  org_id: string;
  number: string;
  listing_id: string | null;
  source: string;
  stage: agency.Lead["stage"];
  agent_user: string | null;
  budget_minor: number | null;
  lost_reason: string | null;
  stage_at: string;
  first_response_at: string | null;
  created_at: string;
}
export const LEAD_SQL = `SELECT l.*, ${C} FROM agency_leads l JOIN contacts c ON c.id = l.contact_id`;
export const toLead = (r: LeadRow): agency.Lead => ({
  id: r.id,
  number: r.number,
  contact: contactOf(r),
  listingId: r.listing_id,
  source: r.source,
  stage: r.stage,
  agentUserId: r.agent_user,
  budgetMinor: r.budget_minor,
  lostReason: r.lost_reason,
  stageAt: r.stage_at,
  firstResponseAt: r.first_response_at,
  createdAt: r.created_at,
});

export interface EnquiryRow extends WithContact {
  id: string;
  number: string;
  kind: agency.Enquiry["kind"];
  listing_id: string;
  l_number: string;
  l_title: string;
  message: string;
  preferred_date: string | null;
  preferred_time: string | null;
  source: string;
  status: agency.Enquiry["status"];
  lead_id: string | null;
  created_at: string;
}
export const ENQUIRY_SQL = `SELECT e.*, l.number AS l_number, l.title AS l_title, ${C}
  FROM agency_enquiries e JOIN agency_listings l ON l.id = e.listing_id JOIN contacts c ON c.id = e.contact_id`;
export const toEnquiry = (r: EnquiryRow): agency.Enquiry => ({
  id: r.id,
  number: r.number,
  kind: r.kind,
  listingId: r.listing_id,
  listingNumber: r.l_number,
  listingTitle: r.l_title,
  contact: contactOf(r),
  message: r.message,
  preferredDate: r.preferred_date,
  preferredTime: r.preferred_time,
  source: r.source,
  status: r.status,
  leadId: r.lead_id,
  createdAt: r.created_at,
});

export interface ViewingRow extends WithContact {
  id: string;
  number: string;
  lead_id: string;
  listing_id: string;
  agent_user: string;
  date: string;
  time: string;
  status: agency.Viewing["status"];
  feedback: string;
  interest: number | null;
}
export const VIEWING_SQL = `SELECT v.*, ${C} FROM agency_viewings v JOIN contacts c ON c.id = v.contact_id`;
export const toViewing = (r: ViewingRow): agency.Viewing => ({
  id: r.id,
  number: r.number,
  leadId: r.lead_id,
  listingId: r.listing_id,
  contact: contactOf(r),
  agentUserId: r.agent_user,
  date: r.date,
  time: r.time,
  status: r.status,
  feedback: r.feedback,
  interest: r.interest,
});

export interface OfferRow extends WithContact {
  id: string;
  org_id: string;
  number: string;
  listing_id: string;
  l_title: string;
  lead_id: string | null;
  amount_minor: number;
  counter_minor: number | null;
  message: string;
  status: agency.Offer["status"];
  created_at: string;
}
export const OFFER_SQL = `SELECT o.*, l.title AS l_title, ${C}
  FROM agency_offers o JOIN agency_listings l ON l.id = o.listing_id JOIN contacts c ON c.id = o.contact_id`;
export const toOffer = (r: OfferRow): agency.Offer => ({
  id: r.id,
  number: r.number,
  listingId: r.listing_id,
  listingTitle: r.l_title,
  contact: contactOf(r),
  leadId: r.lead_id,
  amountMinor: r.amount_minor,
  counterMinor: r.counter_minor,
  message: r.message,
  status: r.status,
  createdAt: r.created_at,
});

export async function findLead(db: Db, orgId: string, id: string): Promise<LeadRow> {
  const l = await db.row<LeadRow>(`${LEAD_SQL} WHERE l.org_id = $1 AND l.id = $2`, [orgId, id]);
  if (!l) throw fail.notFound("Lead not found");
  return l;
}

/** Log something on a lead's history. */
export async function leadEvent(
  db: Db,
  lead: { id: string; org_id: string },
  kind: string,
  text: string,
  by: string | null,
) {
  await db.run("INSERT INTO agency_lead_events (lead_id, org_id, kind, text, by_user) VALUES ($1, $2, $3, $4, $5)", [
    lead.id,
    lead.org_id,
    kind,
    text,
    by,
  ]);
}
