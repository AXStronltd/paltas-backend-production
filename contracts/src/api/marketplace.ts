// The public PALTAS marketplace (homes for sale and rent, short stays) and its PALTAS-staff moderation.
//
// Public endpoints (auth "public") need no sign-in. The server:
// - shows only listings PALTAS staff approved, from organisations whose subscription is usable today;
// - never returns personal data: no owner, agent, contact, private address, organisation id or other guest;
// - limits how often one address may search and submit (429 TOO_MANY_ATTEMPTS), and how many open requests one
//   e-mail address may have per listing;
// - routes every enquiry, viewing request, offer and booking request to the listing's own organisation only.
// A buyer or guest follows their offer or booking with the reference and the private token returned once at creation.
import { z } from "zod";
import { Product } from "../access.js";
import { Currency, Email, IsoDate, IsoDateTime, MinorUnits, PositiveMinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";

// ------------------------------------------------------------------ building blocks (shared with the agency contract)
export const LISTING_PURPOSES = ["sale", "rent", "stay"] as const;
export const ListingPurpose = z.enum(LISTING_PURPOSES);
export type ListingPurpose = z.infer<typeof ListingPurpose>;

export const LISTING_STATUSES = ["draft", "pending_review", "published", "paused", "rejected", "closed"] as const;
export const ListingStatus = z.enum(LISTING_STATUSES);

export const MEDIA_KINDS = ["photo", "video", "floor_plan", "tour", "document"] as const;
export const MediaKind = z.enum(MEDIA_KINDS);

export const STAY_STATUSES = ["requested", "confirmed", "checked_in", "completed", "cancelled", "declined"] as const;
export const StayStatus = z.enum(STAY_STATUSES);

export const OFFER_STATUSES = ["pending", "countered", "accepted", "rejected", "withdrawn"] as const;
export const OfferStatus = z.enum(OFFER_STATUSES);

export const PersonName = z.string().trim().min(2).max(120);
export const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, "Phone number looks wrong");
const Message = z.string().trim().max(2000);
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:00");
/** The private token returned once with an offer or booking; it is the only way to follow it without signing in. */
const Token = z.string().min(20).max(100);
const ListingParams = z.object({ listingId: z.string().min(1).max(80) });
const ReferenceParams = z.object({ reference: z.string().min(1).max(40) });

/** A file the listing shows. Bytes are kept by a storage provider adapter; until one is connected there is no URL. */
export const PublicMedia = z.object({
  id: z.string(),
  kind: MediaKind,
  caption: z.string(),
  position: z.number().int(),
  url: z.string().nullable(),
});
export type PublicMedia = z.infer<typeof PublicMedia>;

/** What anyone may see about a published listing. No personal data, no private address, no organisation id. */
export const PublicListing = z.object({
  id: z.string(),
  number: z.string(),
  purpose: ListingPurpose,
  propertyType: z.string(),
  title: z.string(),
  description: z.string(),
  country: z.string(),
  city: z.string(),
  area: z.string(),
  bedrooms: z.number().int(),
  bathrooms: z.number().int(),
  sizeM2: z.number().int().nullable(),
  maxGuests: z.number().int().nullable(),
  amenities: z.array(z.string()),
  currency: Currency,
  /** Sale price, monthly rent or nightly rate, by purpose. */
  priceMinor: MinorUnits,
  depositMinor: MinorUnits,
  cleaningFeeMinor: MinorUnits,
  serviceFeePct: z.number(),
  taxPct: z.number(),
  minNights: z.number().int(),
  instantBook: z.boolean(),
  /** The company that lists it (a PALTAS customer). */
  listedBy: z.string(),
  media: z.array(PublicMedia),
  rating: z.object({ average: z.number().nullable(), count: z.number().int() }),
  publishedAt: IsoDateTime,
});
export type PublicListing = z.infer<typeof PublicListing>;

export const PublicReview = z.object({
  rating: z.number().int(),
  text: z.string(),
  displayName: z.string(),
  at: IsoDateTime,
});
export type PublicReview = z.infer<typeof PublicReview>;

export const StayQuote = z.object({
  checkIn: IsoDate,
  checkOut: IsoDate,
  nights: z.number().int(),
  currency: Currency,
  nightly: z.array(z.object({ date: IsoDate, priceMinor: MinorUnits })),
  accommodationMinor: MinorUnits,
  cleaningMinor: MinorUnits,
  serviceFeeMinor: MinorUnits,
  taxMinor: MinorUnits,
  totalMinor: MinorUnits,
  /** Free for these nights right now (a request can still be declined, or lose to another booking). */
  available: z.boolean(),
  problems: z.array(z.string()),
});
export type StayQuote = z.infer<typeof StayQuote>;

const csv = z
  .string()
  .max(400)
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

// ------------------------------------------------------------------ public: search and read
export const searchListings = endpoint({
  id: "marketplace.search",
  method: "GET",
  path: "/api/v1/public/listings",
  auth: "public",
  summary:
    "Search published listings (no sign-in). Filters: purpose, city, text, type, price range, bedrooms, guests, " +
    "amenities and — for stays — free dates. Only approved listings of organisations with a usable subscription.",
  query: z.object({
    purpose: ListingPurpose.optional(),
    city: z.string().trim().max(80).optional(),
    q: z.string().trim().max(80).optional(),
    propertyType: z.string().trim().max(40).optional(),
    minPriceMinor: z.coerce.number().int().min(0).optional(),
    maxPriceMinor: z.coerce.number().int().min(0).optional(),
    bedrooms: z.coerce.number().int().min(0).max(50).optional(),
    guests: z.coerce.number().int().min(1).max(50).optional(),
    amenities: csv.optional(),
    checkIn: IsoDate.optional(),
    checkOut: IsoDate.optional(),
    sort: z.enum(["newest", "price_low", "price_high"]).default("newest"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(1000).default(0),
  }),
  response: z.object({
    listings: z.array(PublicListing),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
});

export const getListing = endpoint({
  id: "marketplace.listing",
  method: "GET",
  path: "/api/v1/public/listings/:listingId",
  auth: "public",
  summary: "One published listing with its approved reviews (no sign-in)",
  params: ListingParams,
  response: PublicListing.extend({ reviews: z.array(PublicReview) }),
});

export const mediaContent = endpoint({
  id: "marketplace.mediaContent",
  method: "GET",
  path: "/api/v1/public/listings/:listingId/media/:mediaId/content",
  auth: "public",
  summary: "JPEG bytes for a photo of an approved listing with a usable subscription; unpublished images return 404",
  params: ListingParams.extend({ mediaId: z.string().min(1).max(80) }),
  response: z.string().describe("Binary JPEG image"),
});

export const listingAvailability = endpoint({
  id: "marketplace.availability",
  method: "GET",
  path: "/api/v1/public/listings/:listingId/availability",
  auth: "public",
  summary: "Free nights and nightly prices of a published stay, up to 120 days at a time (no guest details)",
  params: ListingParams,
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({
    days: z.array(z.object({ date: IsoDate, available: z.boolean(), priceMinor: MinorUnits })),
  }),
});

export const quoteStay = endpoint({
  id: "marketplace.quote",
  method: "GET",
  path: "/api/v1/public/listings/:listingId/quote",
  auth: "public",
  summary: "The full price of a stay before booking: nights, cleaning, service fee and tax as the host configured them",
  params: ListingParams,
  query: z.object({ checkIn: IsoDate, checkOut: IsoDate, guests: z.coerce.number().int().min(1).max(50).default(1) }),
  response: StayQuote,
});

// ------------------------------------------------------------------ public: submissions (routed to the listing's organisation)
const Visitor = {
  name: PersonName,
  email: Email.optional(),
  phone: Phone.optional(),
  /** May the organisation send this person marketing (not only replies)? */
  marketingConsent: z.boolean().default(false),
};

export const sendEnquiry = endpoint({
  id: "marketplace.enquire",
  method: "POST",
  path: "/api/v1/public/listings/:listingId/enquiries",
  auth: "public",
  summary:
    "Ask about a listing, or ask to view it. The message goes to the listing organisation's inbox only; " +
    "nothing is e-mailed from here.",
  params: ListingParams,
  body: z
    .object({
      kind: z.enum(["enquiry", "viewing_request"]).default("enquiry"),
      ...Visitor,
      message: Message.default(""),
      preferredDate: IsoDate.optional(),
      preferredTime: Time.optional(),
    })
    .refine((b) => b.email || b.phone, "Give an e-mail address or a phone number")
    .refine((b) => b.kind !== "viewing_request" || b.preferredDate, "A viewing request needs a preferred date"),
  response: z.object({ reference: z.string(), status: z.literal("received") }),
  status: 201,
});

export const PublicOffer = z.object({
  reference: z.string(),
  listingTitle: z.string(),
  currency: Currency,
  amountMinor: MinorUnits,
  counterMinor: MinorUnits.nullable(),
  status: OfferStatus,
});
export type PublicOffer = z.infer<typeof PublicOffer>;

export const makeOffer = endpoint({
  id: "marketplace.offer",
  method: "POST",
  path: "/api/v1/public/listings/:listingId/offers",
  auth: "public",
  summary:
    "Make an offer on a home for sale. Returns a private token, ONCE: keep it to follow the offer. " +
    "No money is taken.",
  params: ListingParams,
  body: z.object({ ...Visitor, email: Email, amountMinor: PositiveMinorUnits, message: Message.default("") }),
  response: PublicOffer.extend({ token: z.string() }),
  status: 201,
});

export const offerStatus = endpoint({
  id: "marketplace.offerStatus",
  method: "POST",
  path: "/api/v1/public/offers/:reference/status",
  auth: "public",
  summary: "Where an offer stands (reference + the private token)",
  params: ReferenceParams,
  body: z.object({ token: Token }),
  response: PublicOffer,
});

export const acceptCounter = endpoint({
  id: "marketplace.acceptCounter",
  method: "POST",
  path: "/api/v1/public/offers/:reference/accept-counter",
  auth: "public",
  summary: "Accept the seller's counter-offer",
  params: ReferenceParams,
  body: z.object({ token: Token }),
  response: PublicOffer,
});

export const withdrawOffer = endpoint({
  id: "marketplace.withdrawOffer",
  method: "POST",
  path: "/api/v1/public/offers/:reference/withdraw",
  auth: "public",
  summary: "Withdraw an offer that has not been accepted",
  params: ReferenceParams,
  body: z.object({ token: Token }),
  response: PublicOffer,
});

export const PublicBooking = z.object({
  reference: z.string(),
  listingTitle: z.string(),
  status: StayStatus,
  checkIn: IsoDate,
  checkOut: IsoDate,
  guests: z.number().int(),
  currency: Currency,
  totalMinor: MinorUnits,
  paidMinor: MinorUnits,
  /** A review can be left once, after the stay is completed. */
  canReview: z.boolean(),
});
export type PublicBooking = z.infer<typeof PublicBooking>;

export const requestBooking = endpoint({
  id: "marketplace.book",
  method: "POST",
  path: "/api/v1/public/listings/:listingId/bookings",
  auth: "public",
  summary:
    "Ask to book a stay. Instant-book stays are confirmed at once when the nights are free; others wait for the " +
    "host. Returns a private token, ONCE. No payment is taken here — the host records payment.",
  params: ListingParams,
  body: z.object({
    ...Visitor,
    email: Email,
    checkIn: IsoDate,
    checkOut: IsoDate,
    guests: z.number().int().min(1).max(50),
    message: Message.default(""),
  }),
  response: PublicBooking.extend({ token: z.string(), quote: StayQuote }),
  status: 201,
});

export const bookingStatus = endpoint({
  id: "marketplace.bookingStatus",
  method: "POST",
  path: "/api/v1/public/bookings/:reference/status",
  auth: "public",
  summary: "Where a booking stands (reference + the private token)",
  params: ReferenceParams,
  body: z.object({ token: Token }),
  response: PublicBooking,
});

export const cancelBooking = endpoint({
  id: "marketplace.cancelBooking",
  method: "POST",
  path: "/api/v1/public/bookings/:reference/cancel",
  auth: "public",
  summary: "Cancel a booking before check-in. Any refund is recorded by the host.",
  params: ReferenceParams,
  body: z.object({ token: Token }),
  response: PublicBooking,
});

export const reviewStay = endpoint({
  id: "marketplace.review",
  method: "POST",
  path: "/api/v1/public/bookings/:reference/review",
  auth: "public",
  summary: "Review a completed stay, once. It is shown after PALTAS staff approve it.",
  params: ReferenceParams,
  body: z.object({
    token: Token,
    rating: z.number().int().min(1).max(5),
    text: z.string().trim().min(10).max(2000),
    displayName: z.string().trim().min(2).max(40),
  }),
  response: z.object({ status: z.literal("pending") }),
  status: 201,
});

export const requestBusiness = endpoint({
  id: "marketplace.businessRequest",
  method: "POST",
  path: "/api/v1/public/business-requests",
  auth: "public",
  summary:
    "PALTAS for Business: ask to set up a company workspace. PALTAS staff check it and create the organisation " +
    "through the normal onboarding; nothing is charged and no module is switched on before then.",
  body: z.object({
    product: Product,
    orgName: z.string().trim().min(3).max(160),
    registrationNumber: z.string().trim().max(60).default(""),
    country: z.string().trim().min(2).max(80),
    currency: Currency,
    timezone: z.string().trim().min(1).max(60),
    contactName: PersonName,
    contactEmail: Email,
    contactPhone: Phone.optional(),
    modules: z.array(z.string().min(1).max(40)).max(20).default([]),
    details: z.record(z.string().max(60), z.string().max(300)).default({}),
    authorityConfirmed: z.literal(true, { error: "Confirm that you may set up this organisation" }),
  }),
  response: z.object({ reference: z.string(), status: z.literal("pending") }),
  status: 201,
});

// ------------------------------------------------------------------ PALTAS staff: moderation and onboarding requests
export const ModerationListing = z.object({
  id: z.string(),
  number: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  purpose: ListingPurpose,
  propertyType: z.string(),
  title: z.string(),
  description: z.string(),
  city: z.string(),
  area: z.string(),
  currency: Currency,
  priceMinor: MinorUnits,
  mediaCount: z.number().int(),
  status: ListingStatus,
  submittedAt: IsoDateTime.nullable(),
  reviewedAt: IsoDateTime.nullable(),
  reviewNote: z.string(),
});
export type ModerationListing = z.infer<typeof ModerationListing>;

const ListingIdParams = z.object({ listingId: z.string().min(1) });

export const moderationQueue = endpoint({
  id: "admin.marketplace.listings",
  method: "GET",
  path: "/api/v1/admin/marketplace/listings",
  auth: "staff",
  summary: "Listings waiting for review (or with another status)",
  query: z.object({ status: ListingStatus.default("pending_review") }),
  response: z.object({ listings: z.array(ModerationListing) }),
});

export const approveListing = endpoint({
  id: "admin.marketplace.approveListing",
  method: "POST",
  path: "/api/v1/admin/marketplace/listings/:listingId/approve",
  auth: "staff",
  summary: "Approve a submitted listing: it is published on the marketplace",
  params: ListingIdParams,
  body: z.object({ note: z.string().trim().max(500).default("") }),
  response: ModerationListing,
});

export const rejectListing = endpoint({
  id: "admin.marketplace.rejectListing",
  method: "POST",
  path: "/api/v1/admin/marketplace/listings/:listingId/reject",
  auth: "staff",
  summary: "Refuse a submitted listing, or take a published one down, with the reason the organisation sees",
  params: ListingIdParams,
  body: z.object({ reason: Reason }),
  response: ModerationListing,
});

export const ModerationReview = z.object({
  id: z.string(),
  orgName: z.string(),
  listingNumber: z.string(),
  listingTitle: z.string(),
  rating: z.number().int(),
  text: z.string(),
  displayName: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: IsoDateTime,
});
export type ModerationReview = z.infer<typeof ModerationReview>;

export const reviewQueue = endpoint({
  id: "admin.marketplace.reviews",
  method: "GET",
  path: "/api/v1/admin/marketplace/reviews",
  auth: "staff",
  summary: "Guest reviews waiting for moderation (or with another status)",
  query: z.object({ status: z.enum(["pending", "approved", "rejected"]).default("pending") }),
  response: z.object({ reviews: z.array(ModerationReview) }),
});

export const moderateReview = endpoint({
  id: "admin.marketplace.moderateReview",
  method: "POST",
  path: "/api/v1/admin/marketplace/reviews/:reviewId",
  auth: "staff",
  summary: "Approve (show publicly) or reject a guest review",
  params: z.object({ reviewId: z.string().min(1) }),
  body: z
    .object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).default("") })
    .refine((b) => b.decision === "approve" || b.note.length >= 5, "Give the reason for rejecting (5+ characters)"),
  response: ModerationReview,
});

export const BusinessRequest = z.object({
  id: z.string(),
  reference: z.string(),
  product: Product,
  orgName: z.string(),
  registrationNumber: z.string(),
  country: z.string(),
  currency: Currency,
  timezone: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  modules: z.array(z.string()),
  details: z.record(z.string(), z.string()),
  status: z.enum(["pending", "approved", "rejected"]),
  decisionNote: z.string(),
  orgId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type BusinessRequest = z.infer<typeof BusinessRequest>;

export const businessRequests = endpoint({
  id: "admin.marketplace.businessRequests",
  method: "GET",
  path: "/api/v1/admin/marketplace/business-requests",
  auth: "staff",
  summary: "For Business sign-up requests",
  query: z.object({ status: z.enum(["pending", "approved", "rejected"]).default("pending") }),
  response: z.object({ requests: z.array(BusinessRequest) }),
});

export const approveBusinessRequest = endpoint({
  id: "admin.marketplace.approveBusiness",
  method: "POST",
  path: "/api/v1/admin/marketplace/business-requests/:requestId/approve",
  auth: "staff",
  summary:
    "Create the organisation, its subscription and its administrator through the core onboarding " +
    "(Super Admin only). The administrator's temporary password is returned ONCE.",
  params: z.object({ requestId: z.string().min(1) }),
  body: z.object({ plan: z.string().min(1), trial: z.boolean().default(true) }),
  response: z.object({ request: BusinessRequest, temporaryPassword: z.string().nullable() }),
});

export const rejectBusinessRequest = endpoint({
  id: "admin.marketplace.rejectBusiness",
  method: "POST",
  path: "/api/v1/admin/marketplace/business-requests/:requestId/reject",
  auth: "staff",
  summary: "Refuse a For Business request, with a reason",
  params: z.object({ requestId: z.string().min(1) }),
  body: z.object({ reason: Reason }),
  response: BusinessRequest,
});
