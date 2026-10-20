// Agent / Host (product "agency"): an agency's or host's back office behind the public marketplace.
//   listings (sale, rent, stays) and their media metadata → submitted to PALTAS for publication;
//   the marketplace inbox (enquiries, viewing requests) → leads, viewings and offers;
//   commission agreements → deals → commissions, approved by a second person and posted to the ONE ledger;
//   short stays: one calendar per stay listing, bookings and blocks (never two overlapping), guest payments and
//   refunds (RECORDED, never processed), check-in / check-out, owner earnings and host payouts (prepared by one
//   person, approved by another, RECORDED — never sent).
// Ledger accounts: 1180 commission receivable, 1190 guest stay receivables, 2460 guest deposits held,
// 2470 owner (host) payouts payable, 2480 agent commission shares payable, 4700 commission income,
// 4710 short-stay revenue, 4720 stay management fees, 5710 agent commission shares; core 1000 bank and 2100 VAT.
// Listings and the inbox serve Property Management organisations as well (their listings reach the same marketplace).
// People (buyers, guests, sellers, owners) live in the organisation's ONE contact store: the contacts API (core/contacts).
import { z } from "zod";
import { IsoDate, IsoDateTime, MinorUnits, PositiveMinorUnits, Reason, Currency, Email } from "../common.js";
import { endpoint } from "../endpoint.js";
import {
  Jurisdiction,
  ListingPurpose,
  ListingStatus,
  MediaKind,
  OfferStatus,
  PersonName,
  Phone,
  PublicMedia,
  StayStatus,
  TenantFee,
} from "./marketplace.js";
import { OrgParams } from "./organisations.js";

// ------------------------------------------------------------------ building blocks
const Id = z.string().min(1).max(80);
/** A percentage with at most two decimals, e.g. 3 or 7.5. */
const Pct = z
  .number()
  .min(0)
  .max(100)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Use at most two decimals");
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:00");
const NonNegativeMinor = MinorUnits.min(0);
const Text = z.string().trim().max(2000);
const PAYMENT_METHODS = ["cash", "card", "mobile_money", "bank_transfer"] as const;
const BankRef = z.string().trim().min(3).max(120);

const base = "/api/v1/orgs/:orgId/agency";
const ListingParams = OrgParams.extend({ listingId: Id });

/** A new person, or an existing contact of this organisation. */
const PersonInput = z
  .object({ name: PersonName, email: Email.optional(), phone: Phone.optional() })
  .refine((p) => p.email || p.phone, "Give an e-mail address or a phone number");

const ContactRef = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

// ------------------------------------------------------------------ commission agreements
export const Agreement = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(["sale", "letting", "stay_management"]),
  clientContactId: z.string(),
  clientName: z.string(),
  commissionPct: z.number(),
  commissionFixedMinor: MinorUnits,
  vatPct: z.number(),
  agentSharePct: z.number(),
  startsOn: IsoDate,
  endsOn: IsoDate.nullable(),
  status: z.enum(["active", "ended"]),
});
export type Agreement = z.infer<typeof Agreement>;

export const listAgreements = endpoint({
  id: "agency.agreements.list",
  method: "GET",
  path: `${base}/agreements`,
  auth: "user",
  summary: "Commission and management agreements",
  params: OrgParams,
  response: z.object({ agreements: z.array(Agreement) }),
});

export const createAgreement = endpoint({
  id: "agency.agreements.create",
  method: "POST",
  path: `${base}/agreements`,
  auth: "user",
  summary:
    "Agree commission with a client: a percentage of the deal (or of stay accommodation for stay management), " +
    "a fixed fee, VAT, and the listing agent's share",
  params: OrgParams,
  body: z.object({
    kind: z.enum(["sale", "letting", "stay_management"]),
    clientContactId: Id,
    commissionPct: Pct,
    commissionFixedMinor: NonNegativeMinor.default(0),
    vatPct: Pct.default(0),
    agentSharePct: Pct.default(0),
    startsOn: IsoDate,
    endsOn: IsoDate.optional(),
  }),
  response: Agreement,
  status: 201,
});

// ------------------------------------------------------------------ listings
export const ListingInput = z.object({
  purpose: ListingPurpose,
  propertyType: z.string().trim().min(2).max(40),
  title: z.string().trim().min(5).max(160),
  description: Text.default(""),
  country: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  area: z.string().trim().max(120).default(""),
  /** Never shown publicly. */
  addressPrivate: z.string().trim().max(300).default(""),
  bedrooms: z.number().int().min(0).max(50).default(0),
  bathrooms: z.number().int().min(0).max(50).default(0),
  sizeM2: z.number().int().positive().max(1_000_000).optional(),
  maxGuests: z.number().int().min(1).max(50).optional(),
  amenities: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(40).default([]),
  /** Sale price, monthly rent or nightly rate, by purpose. */
  priceMinor: PositiveMinorUnits,
  depositMinor: NonNegativeMinor.default(0),
  cleaningFeeMinor: NonNegativeMinor.default(0),
  serviceFeePct: Pct.default(0),
  taxPct: Pct.default(0),
  minNights: z.number().int().min(1).max(365).default(1),
  instantBook: z.boolean().default(false),
  ownerContactId: Id.optional(),
  agreementId: Id.optional(),
  agentUserId: Id.optional(),
  /** Local rental rules (contracts/src/rental-rules.ts): New York City short-term rental registration and FARE Act. */
  strRegistrationNumber: z.string().trim().toUpperCase().max(40).default(""),
  hostPresent: z.boolean().default(false),
  tenantFees: z.array(TenantFee).max(20).default([]),
  noTenantBrokerFee: z.boolean().default(false),
});
export type ListingInput = z.infer<typeof ListingInput>;

export const Listing = ListingInput.extend({
  id: z.string(),
  number: z.string(),
  currency: Currency,
  sizeM2: z.number().int().nullable(),
  maxGuests: z.number().int().nullable(),
  ownerContactId: z.string().nullable(),
  agreementId: z.string().nullable(),
  agentUserId: z.string().nullable(),
  status: ListingStatus,
  reviewNote: z.string(),
  submittedAt: IsoDateTime.nullable(),
  reviewedAt: IsoDateTime.nullable(),
  publishedAt: IsoDateTime.nullable(),
  compliance: z.object({
    jurisdiction: Jurisdiction,
    strVerifiedAt: IsoDateTime.nullable(),
    /** What stops this listing being submitted or published under local rules, in plain words. */
    issues: z.array(z.string()),
  }),
  media: z.array(
    PublicMedia.extend({
      fileName: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      sha256: z.string(),
    }),
  ),
  updatedAt: IsoDateTime,
});
export type Listing = z.infer<typeof Listing>;

export const listListings = endpoint({
  id: "agency.listings.list",
  method: "GET",
  path: `${base}/listings`,
  auth: "user",
  summary: "This organisation's listings, every status",
  params: OrgParams,
  query: z.object({ status: ListingStatus.optional(), purpose: ListingPurpose.optional() }),
  response: z.object({ listings: z.array(Listing) }),
});

export const createListing = endpoint({
  id: "agency.listings.create",
  method: "POST",
  path: `${base}/listings`,
  auth: "user",
  summary: "Draft a listing (sale, rent or stay). It is public only after PALTAS approves it.",
  params: OrgParams,
  body: ListingInput,
  response: Listing,
  status: 201,
});

export const getListing = endpoint({
  id: "agency.listings.get",
  method: "GET",
  path: `${base}/listings/:listingId`,
  auth: "user",
  summary: "One listing with its media and review status",
  params: ListingParams,
  response: Listing,
});

export const updateListing = endpoint({
  id: "agency.listings.update",
  method: "PUT",
  path: `${base}/listings/:listingId`,
  auth: "user",
  summary: "Change a draft, paused or refused listing (a published or waiting one must be taken down first)",
  params: ListingParams,
  body: ListingInput,
  response: Listing,
});

export const submitListing = endpoint({
  id: "agency.listings.submit",
  method: "POST",
  path: `${base}/listings/:listingId/submit`,
  auth: "user",
  summary: "Send the listing to PALTAS for review and publication",
  params: ListingParams,
  response: Listing,
});

export const unpublishListing = endpoint({
  id: "agency.listings.unpublish",
  method: "POST",
  path: `${base}/listings/:listingId/unpublish`,
  auth: "user",
  summary: "Take a listing off the marketplace (or withdraw it from review). It can be changed and submitted again.",
  params: ListingParams,
  response: Listing,
});

export const addMedia = endpoint({
  id: "agency.listings.addMedia",
  method: "POST",
  path: `${base}/listings/:listingId/media`,
  auth: "user",
  summary:
    "Register a photo, video, floor plan, tour or document (metadata). The file is stored by a storage provider " +
    'adapter; until one is connected the answer says "Not connected — test adapter" and gives no upload URL.',
  params: ListingParams,
  body: z.object({
    kind: MediaKind,
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().regex(/^(image|video|application)\/[a-z0-9.+-]+$/, "Not a content type"),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 as 64 hex characters"),
    caption: z.string().trim().max(200).default(""),
    position: z.number().int().min(0).max(500).default(0),
  }),
  response: z.object({
    media: Listing.shape.media.element,
    upload: z.object({
      adapter: z.string(),
      connected: z.boolean(),
      status: z.string(),
      uploadUrl: z.string().nullable(),
    }),
  }),
  status: 201,
});

export const uploadPhoto = endpoint({
  id: "agency.listings.uploadPhoto",
  method: "POST",
  path: `${base}/listings/:listingId/photos`,
  auth: "user",
  summary:
    "Upload a real JPEG, PNG or WebP photo (2 MiB input); normalize and persist bytes, up to 20 photos per listing and 100 MiB per company",
  params: ListingParams,
  body: z.object({
    fileName: z.string().trim().min(1).max(200),
    caption: z.string().trim().max(200).default(""),
    contentBase64: z
      .string()
      .min(4)
      .max(2796204)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  response: z.object({ media: Listing.shape.media.element, stored: z.literal(true) }),
  status: 201,
});

export const removeMedia = endpoint({
  id: "agency.listings.removeMedia",
  method: "DELETE",
  path: `${base}/listings/:listingId/media/:mediaId`,
  auth: "user",
  summary: "Remove a file from a listing that is not public or waiting for review",
  params: ListingParams.extend({ mediaId: Id }),
  response: z.object({ ok: z.literal(true) }),
});

export const CalendarDay = z.object({
  date: IsoDate,
  priceMinor: MinorUnits,
  state: z.enum(["free", "booked", "blocked", "requested"]),
  stayNumber: z.string().nullable(),
});
export type CalendarDay = z.infer<typeof CalendarDay>;

export const listingCalendar = endpoint({
  id: "agency.listings.calendar",
  method: "GET",
  path: `${base}/listings/:listingId/calendar`,
  auth: "user",
  summary: "A stay listing's calendar: price per night, and which nights are booked, blocked or requested",
  params: ListingParams,
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({ days: z.array(CalendarDay) }),
});

export const setRates = endpoint({
  id: "agency.listings.setRates",
  method: "PUT",
  path: `${base}/listings/:listingId/rates`,
  auth: "user",
  summary: "Set the price of particular nights (null returns a night to the listing's nightly rate)",
  params: ListingParams,
  body: z.object({
    rates: z
      .array(z.object({ date: IsoDate, priceMinor: PositiveMinorUnits.nullable() }))
      .min(1)
      .max(366),
  }),
  response: z.object({ ok: z.literal(true) }),
});

// ------------------------------------------------------------------ inbox and leads
export const Offer = z.object({
  id: z.string(),
  number: z.string(),
  listingId: z.string(),
  listingTitle: z.string(),
  contact: ContactRef,
  leadId: z.string().nullable(),
  amountMinor: MinorUnits,
  counterMinor: MinorUnits.nullable(),
  message: z.string(),
  status: OfferStatus,
  createdAt: IsoDateTime,
});
export type Offer = z.infer<typeof Offer>;

export const Enquiry = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(["enquiry", "viewing_request"]),
  listingId: z.string(),
  listingNumber: z.string(),
  listingTitle: z.string(),
  contact: ContactRef,
  message: z.string(),
  preferredDate: IsoDate.nullable(),
  preferredTime: z.string().nullable(),
  source: z.string(),
  status: z.enum(["new", "converted", "closed", "spam"]),
  leadId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Enquiry = z.infer<typeof Enquiry>;

export const inbox = endpoint({
  id: "agency.inbox.list",
  method: "GET",
  path: `${base}/inbox`,
  auth: "user",
  summary: "Marketplace enquiries and viewing requests for this organisation's listings, newest first",
  params: OrgParams,
  query: z.object({ status: z.enum(["new", "converted", "closed", "spam"]).optional() }),
  response: z.object({
    enquiries: z.array(Enquiry),
    counts: z.object({ new: z.number().int(), offersPending: z.number().int(), bookingRequests: z.number().int() }),
  }),
});

export const LEAD_STAGES = ["new", "contacted", "qualified", "viewing", "viewed", "offer", "won", "lost"] as const;
export const LeadStage = z.enum(LEAD_STAGES);

export const Lead = z.object({
  id: z.string(),
  number: z.string(),
  contact: ContactRef,
  listingId: z.string().nullable(),
  source: z.string(),
  stage: LeadStage,
  agentUserId: z.string().nullable(),
  budgetMinor: MinorUnits.nullable(),
  lostReason: z.string().nullable(),
  stageAt: IsoDateTime,
  firstResponseAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Lead = z.infer<typeof Lead>;

export const Viewing = z.object({
  id: z.string(),
  number: z.string(),
  leadId: z.string(),
  listingId: z.string(),
  contact: ContactRef,
  agentUserId: z.string(),
  date: IsoDate,
  time: z.string(),
  status: z.enum(["scheduled", "confirmed", "completed", "no_show", "cancelled"]),
  feedback: z.string(),
  interest: z.number().int().nullable(),
});
export type Viewing = z.infer<typeof Viewing>;

export const convertEnquiry = endpoint({
  id: "agency.inbox.convert",
  method: "POST",
  path: `${base}/inbox/:enquiryId/convert`,
  auth: "user",
  summary:
    "Turn an enquiry into a lead (the contact's open lead for the same listing is reused). A viewing request " +
    "with a date also books the viewing.",
  params: OrgParams.extend({ enquiryId: Id }),
  body: z.object({ agentUserId: Id.optional() }),
  response: z.object({ lead: Lead, viewing: Viewing.nullable() }),
});

export const closeEnquiry = endpoint({
  id: "agency.inbox.close",
  method: "POST",
  path: `${base}/inbox/:enquiryId/close`,
  auth: "user",
  summary: "Close an enquiry without a lead, or mark it as spam",
  params: OrgParams.extend({ enquiryId: Id }),
  body: z.object({ status: z.enum(["closed", "spam"]) }),
  response: Enquiry,
});

export const listLeads = endpoint({
  id: "agency.leads.list",
  method: "GET",
  path: `${base}/leads`,
  auth: "user",
  summary: "The lead pipeline. A leasing agent sees their own and unassigned leads; managers see every lead.",
  params: OrgParams,
  query: z.object({ stage: LeadStage.optional() }),
  response: z.object({ leads: z.array(Lead) }),
});

export const createLead = endpoint({
  id: "agency.leads.create",
  method: "POST",
  path: `${base}/leads`,
  auth: "user",
  summary: "Record an enquiry that came by phone, walk-in or another channel",
  params: OrgParams,
  body: z.object({
    person: PersonInput,
    listingId: Id.optional(),
    source: z.string().trim().min(2).max(60),
    budgetMinor: PositiveMinorUnits.optional(),
    agentUserId: Id.optional(),
  }),
  response: Lead,
  status: 201,
});

export const LeadEvent = z.object({
  kind: z.string(),
  text: z.string(),
  byUserId: z.string().nullable(),
  at: IsoDateTime,
});

export const getLead = endpoint({
  id: "agency.leads.get",
  method: "GET",
  path: `${base}/leads/:leadId`,
  auth: "user",
  summary: "A lead with its history, viewings and offers",
  params: OrgParams.extend({ leadId: Id }),
  response: z.object({
    lead: Lead,
    events: z.array(LeadEvent),
    viewings: z.array(Viewing),
    offers: z.array(Offer),
  }),
});

export const moveLead = endpoint({
  id: "agency.leads.stage",
  method: "POST",
  path: `${base}/leads/:leadId/stage`,
  auth: "user",
  summary: "Move a lead to another stage ('won' comes only from closing a deal; 'lost' needs the reason)",
  params: OrgParams.extend({ leadId: Id }),
  body: z.object({ stage: LeadStage, lostReason: z.string().trim().min(3).max(300).optional() }),
  response: Lead,
});

export const assignLead = endpoint({
  id: "agency.leads.assign",
  method: "POST",
  path: `${base}/leads/:leadId/assign`,
  auth: "user",
  summary: "Give a lead to an agent of this organisation",
  params: OrgParams.extend({ leadId: Id }),
  body: z.object({ agentUserId: Id }),
  response: Lead,
});

export const noteLead = endpoint({
  id: "agency.leads.note",
  method: "POST",
  path: `${base}/leads/:leadId/notes`,
  auth: "user",
  summary: "Log a call, e-mail, meeting or note (a call, e-mail or meeting counts as the first response)",
  params: OrgParams.extend({ leadId: Id }),
  body: z.object({ kind: z.enum(["note", "call", "email", "meeting"]), text: z.string().trim().min(2).max(2000) }),
  response: Lead,
});

export const bookViewing = endpoint({
  id: "agency.viewings.book",
  method: "POST",
  path: `${base}/leads/:leadId/viewings`,
  auth: "user",
  summary: "Book a viewing for a lead. An agent cannot have two viewings less than an hour apart.",
  params: OrgParams.extend({ leadId: Id }),
  body: z.object({ listingId: Id.optional(), date: IsoDate, time: Time, agentUserId: Id.optional() }),
  response: Viewing,
  status: 201,
});

export const listViewings = endpoint({
  id: "agency.viewings.list",
  method: "GET",
  path: `${base}/viewings`,
  auth: "user",
  summary: "Viewings in a date range (a leasing agent sees their own)",
  params: OrgParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: z.object({ viewings: z.array(Viewing) }),
});

export const viewingAction = endpoint({
  id: "agency.viewings.update",
  method: "POST",
  path: `${base}/viewings/:viewingId`,
  auth: "user",
  summary: "Confirm, cancel or record the outcome of a viewing (attended or no-show, feedback, interest 1–5)",
  params: OrgParams.extend({ viewingId: Id }),
  body: z.discriminatedUnion("action", [
    z.object({ action: z.literal("confirm") }),
    z.object({ action: z.literal("cancel"), reason: Reason }),
    z.object({
      action: z.literal("outcome"),
      attended: z.boolean(),
      feedback: z.string().trim().max(1000).default(""),
      interest: z.number().int().min(1).max(5).optional(),
    }),
  ]),
  response: Viewing,
});

// ------------------------------------------------------------------ offers
export const listOffers = endpoint({
  id: "agency.offers.list",
  method: "GET",
  path: `${base}/offers`,
  auth: "user",
  summary: "Offers received on this organisation's listings",
  params: OrgParams,
  query: z.object({ status: OfferStatus.optional() }),
  response: z.object({ offers: z.array(Offer) }),
});

export const respondOffer = endpoint({
  id: "agency.offers.respond",
  method: "POST",
  path: `${base}/offers/:offerId/respond`,
  auth: "user",
  summary: "Accept, reject or counter an offer (one accepted offer per listing)",
  params: OrgParams.extend({ offerId: Id }),
  body: z.discriminatedUnion("action", [
    z.object({ action: z.literal("accept") }),
    z.object({ action: z.literal("reject") }),
    z.object({ action: z.literal("counter"), counterMinor: PositiveMinorUnits }),
  ]),
  response: Offer,
});

// ------------------------------------------------------------------ deals and commissions
export const Deal = z.object({
  id: z.string(),
  number: z.string(),
  listingId: z.string(),
  leadId: z.string().nullable(),
  offerId: z.string().nullable(),
  agreementId: z.string(),
  kind: z.enum(["sale", "letting"]),
  valueMinor: MinorUnits,
  closedOn: IsoDate,
  agentUserId: z.string().nullable(),
  commissionId: z.string(),
});
export type Deal = z.infer<typeof Deal>;

export const Commission = z.object({
  id: z.string(),
  number: z.string(),
  dealId: z.string(),
  agreementId: z.string(),
  clientName: z.string(),
  baseMinor: MinorUnits,
  commissionMinor: MinorUnits,
  vatMinor: MinorUnits,
  totalMinor: MinorUnits,
  agentUserId: z.string().nullable(),
  agentShareMinor: MinorUnits,
  receivedMinor: MinorUnits,
  status: z.enum(["pending_approval", "approved", "rejected", "paid"]),
  raisedBy: z.string(),
  approvedBy: z.string().nullable(),
  rejectReason: z.string().nullable(),
  journalId: z.string().nullable(),
});
export type Commission = z.infer<typeof Commission>;

export const listDeals = endpoint({
  id: "agency.deals.list",
  method: "GET",
  path: `${base}/deals`,
  auth: "user",
  summary: "Closed deals",
  params: OrgParams,
  response: z.object({ deals: z.array(Deal) }),
});

export const closeDeal = endpoint({
  id: "agency.deals.close",
  method: "POST",
  path: `${base}/deals`,
  auth: "user",
  summary:
    "Close a sale or letting: the listing comes off the marketplace, the lead is won, and the commission is " +
    "computed from the agreement and raised for approval by someone else",
  params: OrgParams,
  body: z.object({
    listingId: Id,
    agreementId: Id,
    valueMinor: PositiveMinorUnits.optional(),
    closedOn: IsoDate,
    leadId: Id.optional(),
    offerId: Id.optional(),
  }),
  response: z.object({ deal: Deal, commission: Commission }),
  status: 201,
});

export const listCommissions = endpoint({
  id: "agency.commissions.list",
  method: "GET",
  path: `${base}/commissions`,
  auth: "user",
  summary: "Commissions, with totals beside the ledger's own balances (they must agree)",
  params: OrgParams,
  query: z.object({ status: z.enum(["pending_approval", "approved", "rejected", "paid"]).optional() }),
  response: z.object({
    commissions: z.array(Commission),
    totals: z.object({
      approvedCommissionMinor: MinorUnits,
      approvedVatMinor: MinorUnits,
      receivedMinor: MinorUnits,
      outstandingMinor: MinorUnits,
      ledgerIncomeMinor: MinorUnits,
      ledgerReceivableMinor: MinorUnits,
    }),
  }),
});

export const decideCommission = endpoint({
  id: "agency.commissions.decide",
  method: "POST",
  path: `${base}/commissions/:commissionId/decide`,
  auth: "user",
  summary:
    "Approve (posts Dr 1180 / Cr 4700 + Cr 2100 VAT, and the agent's share Dr 5710 / Cr 2480) or reject a " +
    "commission. The person who raised it cannot decide it.",
  params: OrgParams.extend({ commissionId: Id }),
  body: z.discriminatedUnion("decision", [
    z.object({ decision: z.literal("approve") }),
    z.object({ decision: z.literal("reject"), reason: Reason }),
  ]),
  response: Commission,
});

export const commissionReceipt = endpoint({
  id: "agency.commissions.receipt",
  method: "POST",
  path: `${base}/commissions/:commissionId/receipts`,
  auth: "user",
  summary: "Record commission received from the client (Dr 1000 / Cr 1180). A bank reference is recorded once.",
  params: OrgParams.extend({ commissionId: Id }),
  body: z.object({ amountMinor: PositiveMinorUnits, reference: BankRef, receivedOn: IsoDate }),
  response: Commission,
});

// ------------------------------------------------------------------ short stays
export const Stay = z.object({
  id: z.string(),
  number: z.string(),
  listingId: z.string(),
  kind: z.enum(["booking", "block"]),
  guest: ContactRef.nullable(),
  checkIn: IsoDate,
  checkOut: IsoDate,
  nights: z.number().int(),
  guests: z.number().int(),
  source: z.enum(["marketplace", "direct", "owner", "maintenance"]),
  status: StayStatus,
  currency: Currency,
  accommodationMinor: MinorUnits,
  cleaningMinor: MinorUnits,
  serviceFeeMinor: MinorUnits,
  taxMinor: MinorUnits,
  totalMinor: MinorUnits,
  paidMinor: MinorUnits,
  balanceMinor: MinorUnits,
  ownerContactId: z.string().nullable(),
  note: z.string(),
  createdAt: IsoDateTime,
});
export type Stay = z.infer<typeof Stay>;

export const listStays = endpoint({
  id: "agency.stays.list",
  method: "GET",
  path: `${base}/stays`,
  auth: "user",
  summary: "Stay bookings and blocks",
  params: OrgParams,
  query: z.object({ status: StayStatus.optional(), listingId: Id.optional() }),
  response: z.object({ stays: z.array(Stay) }),
});

export const createStay = endpoint({
  id: "agency.stays.create",
  method: "POST",
  path: `${base}/stays`,
  auth: "user",
  summary:
    "Book a stay directly (phone, walk-in) — confirmed at once — or block nights for the owner or maintenance. " +
    "Two overlapping stays on one listing are refused, also by the database.",
  params: OrgParams,
  body: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("booking"),
      listingId: Id,
      guest: PersonInput,
      checkIn: IsoDate,
      checkOut: IsoDate,
      guests: z.number().int().min(1).max(50),
      note: z.string().trim().max(500).default(""),
    }),
    z.object({
      kind: z.literal("block"),
      listingId: Id,
      checkIn: IsoDate,
      checkOut: IsoDate,
      source: z.enum(["owner", "maintenance"]),
      note: z.string().trim().min(3).max(500),
    }),
  ]),
  response: Stay,
  status: 201,
});

export const stayAction = endpoint({
  id: "agency.stays.update",
  method: "POST",
  path: `${base}/stays/:stayId`,
  auth: "user",
  summary:
    "Confirm or decline a request; cancel; check in; check out (posts the stay to the ledger: revenue, owner " +
    "earnings, management fee, tax)",
  params: OrgParams.extend({ stayId: Id }),
  body: z.discriminatedUnion("action", [
    z.object({ action: z.literal("confirm") }),
    z.object({ action: z.literal("decline"), reason: Reason }),
    z.object({ action: z.literal("cancel"), reason: Reason }),
    z.object({ action: z.literal("check_in") }),
    z.object({ action: z.literal("check_out") }),
  ]),
  response: Stay,
});

export const stayPayment = endpoint({
  id: "agency.stays.payment",
  method: "POST",
  path: `${base}/stays/:stayId/payments`,
  auth: "user",
  summary:
    "RECORD a guest payment or refund received or made outside PALTAS (nothing is charged from here). " +
    "Before check-out it is a deposit (2460); after, it settles the guest receivable (1190).",
  params: OrgParams.extend({ stayId: Id }),
  body: z.object({
    kind: z.enum(["payment", "refund"]),
    amountMinor: PositiveMinorUnits,
    method: z.enum(PAYMENT_METHODS),
    reference: BankRef,
  }),
  response: Stay,
});

// ------------------------------------------------------------------ host payouts
export const Payout = z.object({
  id: z.string(),
  number: z.string(),
  ownerContactId: z.string(),
  ownerName: z.string(),
  amountMinor: MinorUnits,
  note: z.string(),
  status: z.enum(["prepared", "approved", "rejected"]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  reference: z.string().nullable(),
  journalId: z.string().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Payout = z.infer<typeof Payout>;

export const OwnerBalance = z.object({
  ownerContactId: z.string(),
  ownerName: z.string(),
  earnedMinor: MinorUnits,
  paidOutMinor: MinorUnits,
  preparedMinor: MinorUnits,
  dueMinor: MinorUnits,
});
export type OwnerBalance = z.infer<typeof OwnerBalance>;

export const listPayouts = endpoint({
  id: "agency.payouts.list",
  method: "GET",
  path: `${base}/payouts`,
  auth: "user",
  summary: "Host payouts and what each stay owner has earned, been paid and is still due, beside the ledger (2470)",
  params: OrgParams,
  response: z.object({
    payouts: z.array(Payout),
    owners: z.array(OwnerBalance),
    ledgerPayableMinor: MinorUnits,
  }),
});

export const preparePayout = endpoint({
  id: "agency.payouts.prepare",
  method: "POST",
  path: `${base}/payouts`,
  auth: "user",
  summary: "Prepare a payout to a stay owner, up to what they are due (nothing is sent)",
  params: OrgParams,
  body: z.object({
    ownerContactId: Id,
    amountMinor: PositiveMinorUnits,
    note: z.string().trim().max(300).default(""),
  }),
  response: Payout,
  status: 201,
});

export const decidePayout = endpoint({
  id: "agency.payouts.decide",
  method: "POST",
  path: `${base}/payouts/:payoutId/decide`,
  auth: "user",
  summary:
    "Approve a prepared payout with the bank reference of the transfer made outside PALTAS (posts Dr 2470 / Cr 1000), " +
    "or reject it. The person who prepared it cannot decide it.",
  params: OrgParams.extend({ payoutId: Id }),
  body: z.discriminatedUnion("decision", [
    z.object({ decision: z.literal("approve"), reference: BankRef }),
    z.object({ decision: z.literal("reject"), reason: Reason }),
  ]),
  response: Payout,
});

// ------------------------------------------------------------------ reports
export const summary = endpoint({
  id: "agency.reports.summary",
  method: "GET",
  path: `${base}/reports/summary`,
  auth: "user",
  summary:
    "Listings by status, the marketplace funnel (enquiries → leads → viewings → offers → won), commissions and " +
    "stays — money figures read from the ledger",
  params: OrgParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: z.object({
    from: IsoDate,
    to: IsoDate,
    listings: z.record(z.string(), z.number().int()),
    funnel: z.object({
      enquiries: z.number().int(),
      leads: z.number().int(),
      viewings: z.number().int(),
      offers: z.number().int(),
      won: z.number().int(),
    }),
    leadsByStage: z.record(z.string(), z.number().int()),
    stays: z.object({ bookings: z.number().int(), nights: z.number().int(), completed: z.number().int() }),
    ledger: z.object({
      commissionIncomeMinor: MinorUnits,
      commissionReceivableMinor: MinorUnits,
      stayRevenueMinor: MinorUnits,
      managementFeesMinor: MinorUnits,
      ownerPayableMinor: MinorUnits,
      guestDepositsMinor: MinorUnits,
      guestReceivableMinor: MinorUnits,
    }),
  }),
});

export const listingPerformance = endpoint({
  id: "agency.reports.listings",
  method: "GET",
  path: `${base}/reports/listings`,
  auth: "user",
  summary:
    "Listing performance: public detail views, enquiries, leads, viewings, offers and closed deals per listing, " +
    "and the marketplace sources leads came from",
  params: OrgParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: z.object({
    from: IsoDate,
    to: IsoDate,
    listings: z.array(
      z.object({
        listingId: z.string(),
        number: z.string(),
        title: z.string(),
        status: ListingStatus,
        views: z.number().int(),
        enquiries: z.number().int(),
        leads: z.number().int(),
        viewings: z.number().int(),
        offers: z.number().int(),
        closed: z.boolean(),
        /** Enquiries per 100 views (null without views). */
        enquiryRatePct: z.number().nullable(),
      }),
    ),
    sources: z.array(z.object({ source: z.string(), leads: z.number().int(), won: z.number().int() })),
  }),
});
