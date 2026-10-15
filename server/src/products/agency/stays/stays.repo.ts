// SQL only: stay bookings and blocks, with the guest each booking is for.
import type { agency } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { daysBetween } from "../shared/util.js";

export interface StayRow {
  id: string;
  org_id: string;
  number: string;
  listing_id: string;
  kind: "booking" | "block";
  contact_id: string | null;
  g_name: string | null;
  g_email: string | null;
  g_phone: string | null;
  check_in: string;
  check_out: string;
  guests: number;
  source: agency.Stay["source"];
  status: agency.Stay["status"];
  accommodation_minor: number;
  cleaning_minor: number;
  service_fee_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  owner_contact_id: string | null;
  management_bp: number;
  note: string;
  token_hash: string | null;
  currency: string;
  l_title: string;
  created_at: string;
}

export const STAY_SQL = `SELECT s.*, g.name AS g_name, g.email AS g_email, g.phone AS g_phone,
    l.currency, l.title AS l_title
  FROM agency_stays s JOIN agency_listings l ON l.id = s.listing_id LEFT JOIN contacts g ON g.id = s.contact_id`;

export const toStay = (r: StayRow): agency.Stay => ({
  id: r.id,
  number: r.number,
  listingId: r.listing_id,
  kind: r.kind,
  guest: r.contact_id ? { id: r.contact_id, name: r.g_name ?? "", email: r.g_email, phone: r.g_phone } : null,
  checkIn: r.check_in,
  checkOut: r.check_out,
  nights: daysBetween(r.check_in, r.check_out),
  guests: r.guests,
  source: r.source,
  status: r.status,
  currency: r.currency,
  accommodationMinor: r.accommodation_minor,
  cleaningMinor: r.cleaning_minor,
  serviceFeeMinor: r.service_fee_minor,
  taxMinor: r.tax_minor,
  totalMinor: r.total_minor,
  paidMinor: r.paid_minor,
  balanceMinor: r.total_minor - r.paid_minor,
  ownerContactId: r.owner_contact_id,
  note: r.note,
  createdAt: r.created_at,
});

export async function findStay(db: Db, orgId: string, id: string, lock = false): Promise<StayRow> {
  const r = await db.row<StayRow>(`${STAY_SQL} WHERE s.org_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`, [
    orgId,
    id,
  ]);
  if (!r) throw fail.notFound("Stay not found");
  return r;
}
