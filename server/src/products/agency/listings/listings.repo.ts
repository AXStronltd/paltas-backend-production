// SQL only: listing rows, their media, and the shapes the organisation and the public see.
import type { agency, marketplace } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import type { MediaStorage } from "../integrations/storage.js";
import { toPct } from "../shared/util.js";

export interface ListingRow {
  id: string;
  org_id: string;
  product: "agency" | "property";
  number: string;
  purpose: marketplace.ListingPurpose;
  property_type: string;
  title: string;
  description: string;
  country: string;
  city: string;
  area: string;
  address_private: string;
  bedrooms: number;
  bathrooms: number;
  size_m2: number | null;
  max_guests: number | null;
  amenities: string[];
  currency: string;
  price_minor: number;
  deposit_minor: number;
  cleaning_fee_minor: number;
  service_fee_bp: number;
  tax_bp: number;
  min_nights: number;
  instant_book: boolean;
  owner_contact_id: string | null;
  agreement_id: string | null;
  agent_user: string | null;
  status: (typeof marketplace.LISTING_STATUSES)[number];
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string;
  published_at: string | null;
  updated_at: string;
}

export interface MediaRow {
  id: string;
  listing_id: string;
  kind: (typeof marketplace.MEDIA_KINDS)[number];
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  caption: string;
  position: number;
  storage_key: string;
}

/** A listing of this organisation, or 404. */
export async function findListing(db: Db, orgId: string, id: string, lock = false): Promise<ListingRow> {
  const l = await db.row<ListingRow>(
    `SELECT * FROM agency_listings WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [orgId, id],
  );
  if (!l) throw fail.notFound("Listing not found");
  return l;
}

export async function mediaOf(db: Db, listingIds: string[]): Promise<Map<string, MediaRow[]>> {
  const out = new Map<string, MediaRow[]>();
  if (!listingIds.length) return out;
  const rows = await db.rows<MediaRow>(
    "SELECT * FROM agency_listing_media WHERE listing_id = ANY($1) ORDER BY position, created_at, id",
    [listingIds],
  );
  for (const r of rows) out.set(r.listing_id, [...(out.get(r.listing_id) ?? []), r]);
  return out;
}

export const toPublicMedia = (m: MediaRow, storage: MediaStorage): marketplace.PublicMedia => ({
  id: m.id,
  kind: m.kind,
  caption: m.caption,
  position: m.position,
  url: storage.publicUrl(m.storage_key),
});

export function toOrgMedia(m: MediaRow, storage: MediaStorage) {
  return {
    ...toPublicMedia(m, storage),
    fileName: m.file_name,
    contentType: m.content_type,
    sizeBytes: m.size_bytes,
    sha256: m.sha256,
  };
}

export function toListing(l: ListingRow, media: MediaRow[], storage: MediaStorage): agency.Listing {
  return {
    id: l.id,
    number: l.number,
    purpose: l.purpose,
    propertyType: l.property_type,
    title: l.title,
    description: l.description,
    country: l.country,
    city: l.city,
    area: l.area,
    addressPrivate: l.address_private,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    sizeM2: l.size_m2,
    maxGuests: l.max_guests,
    amenities: l.amenities,
    currency: l.currency,
    priceMinor: l.price_minor,
    depositMinor: l.deposit_minor,
    cleaningFeeMinor: l.cleaning_fee_minor,
    serviceFeePct: toPct(l.service_fee_bp),
    taxPct: toPct(l.tax_bp),
    minNights: l.min_nights,
    instantBook: l.instant_book,
    ownerContactId: l.owner_contact_id,
    agreementId: l.agreement_id,
    agentUserId: l.agent_user,
    status: l.status,
    reviewNote: l.review_note,
    submittedAt: l.submitted_at,
    reviewedAt: l.reviewed_at,
    publishedAt: l.published_at,
    media: media.map((m) => toOrgMedia(m, storage)),
    updatedAt: l.updated_at,
  };
}

/** The public face of a listing: no owner, agent, agreement, private address or organisation id. */
export function toPublicListing(
  l: ListingRow & { org_name: string; rating_avg: number | null; rating_count: number },
  media: MediaRow[],
  storage: MediaStorage,
): marketplace.PublicListing {
  return {
    id: l.id,
    number: l.number,
    purpose: l.purpose,
    propertyType: l.property_type,
    title: l.title,
    description: l.description,
    country: l.country,
    city: l.city,
    area: l.area,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    sizeM2: l.size_m2,
    maxGuests: l.max_guests,
    amenities: l.amenities,
    currency: l.currency,
    priceMinor: l.price_minor,
    depositMinor: l.deposit_minor,
    cleaningFeeMinor: l.cleaning_fee_minor,
    serviceFeePct: toPct(l.service_fee_bp),
    taxPct: toPct(l.tax_bp),
    minNights: l.min_nights,
    instantBook: l.instant_book,
    listedBy: l.org_name,
    // documents (title deeds, IDs …) are never public
    media: media.filter((m) => m.kind !== "document").map((m) => toPublicMedia(m, storage)),
    rating: { average: l.rating_avg === null ? null : Math.round(l.rating_avg * 10) / 10, count: l.rating_count },
    publishedAt: l.published_at as string,
  };
}
