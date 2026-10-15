// Smart Hotel (product "hotel"): properties, rooms, rates, ONE availability record, reservations, front desk,
// folios posting to the organisation's one ledger, housekeeping, cashier shifts, night and income audit, KPIs,
// group (chain) views and integration boundaries (channel manager, door locks, room controls, messaging).
//
// Rules the server enforces (and the database backs up):
// - a room type can never be sold beyond its rooms for any night, across every channel (inventory constraint);
// - a physical room can never hold two overlapping stays (exclusion constraint);
// - every money movement posts to the ledger (guest ledger 1150, city ledger 1160, deposits 2350 …);
// - payments are RECORDED, never processed; messages are RECORDED, never sent; external systems answer
//   "Not connected — test adapter" until a real adapter is installed.
import { z } from "zod";
import { Currency, Email, IsoDate, IsoDateTime, MinorUnits, PositiveMinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { AccountCode } from "./ledger.js";
import { OrgParams } from "./organisations.js";

// ------------------------------------------------------------------ building blocks
const Id = z.string().min(1).max(80);
const Name = z.string().trim().min(1).max(160);
const Text = z.string().trim().max(2000);
const Code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,20}$/, "Use 1–20 letters, digits, - or _");
/** A percentage with at most two decimals, e.g. 16 or 7.5. */
const Pct = z
  .number()
  .min(0)
  .max(100)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Use at most two decimals");
const SignedPct = z
  .number()
  .min(-100)
  .max(500)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Use at most two decimals");
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:00");
const NonNegativeMinor = MinorUnits.min(0);

/** Revenue departments. Each posts to its own income account (rooms 4100, fnb 4200, spa 4300, other 4400, noshow 4500). */
export const HOTEL_DEPARTMENTS = ["rooms", "fnb", "spa", "other", "noshow"] as const;
export const HotelDepartment = z.enum(HOTEL_DEPARTMENTS);
export type HotelDepartment = z.infer<typeof HotelDepartment>;
/** Departments a person may charge by hand (no-show fees come only from the cancellation / no-show policy). */
const ChargeDepartment = z.enum(["rooms", "fnb", "spa", "other"]);

export const PAYMENT_METHODS = ["cash", "card", "mobile_money", "bank_transfer"] as const;
export const PaymentMethod = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethod>;
const ByMethod = z.object({ cash: MinorUnits, card: MinorUnits, mobile_money: MinorUnits, bank_transfer: MinorUnits });

const RESERVATION_SOURCES = ["direct", "booking_engine", "phone", "walk_in", "channel", "corporate", "group"] as const;
export const ReservationSource = z.enum(RESERVATION_SOURCES);

/** An external system PALTAS talks to through an adapter. Until a real adapter is installed, it is a test adapter. */
export const IntegrationState = z.object({
  adapter: z.string(),
  connected: z.boolean(),
  status: z.string(),
});

// ------------------------------------------------------------------ setup
export const TaxConfig = z.object({
  vatPct: Pct,
  serviceChargePct: Pct.default(0),
  /** Departments that carry the service charge. */
  serviceChargeDepartments: z.array(HotelDepartment).default(["fnb", "spa"]),
  vatOnServiceCharge: z.boolean().default(true),
  levy: z
    .object({
      kind: z.enum(["none", "per_night", "percent_of_room"]),
      name: z.string().trim().min(1).max(80).default("Tourism levy"),
      /** per_night: amount per occupied room night. */
      amountMinor: NonNegativeMinor.default(0),
      /** percent_of_room: share of the room revenue. */
      pct: Pct.default(0),
    })
    .default({ kind: "none", name: "Tourism levy", amountMinor: 0, pct: 0 }),
});
export type TaxConfig = z.infer<typeof TaxConfig>;

const MappingGroup = z.object({ revenue: z.array(AccountCode), costs: z.array(AccountCode) });
/** USALI-style departmental layout: which ledger accounts make up each department. */
export const UsaliMapping = z.object({
  rooms: MappingGroup,
  fnb: MappingGroup,
  spa: MappingGroup,
  other: MappingGroup,
  undistributed: z.object({ costs: z.array(AccountCode) }),
});
export type UsaliMapping = z.infer<typeof UsaliMapping>;

export const FaqEntry = z.object({
  question: z.string().trim().min(2).max(300),
  keywords: z.array(z.string().trim().min(2).max(40)).min(1).max(20),
  answer: z.string().trim().min(2).max(1000),
});

export const Property = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string(),
  city: z.string(),
  currency: Currency,
  timezone: z.string(),
  checkInTime: Time,
  checkOutTime: Time,
  /** The property's own business date; only the night audit moves it on. */
  businessDate: IsoDate,
  tax: TaxConfig,
  /** Check-in needs a supervisor-inspected room (otherwise clean is enough). */
  requireInspection: z.boolean(),
  welcomeTemperatureC: z.number(),
  ecoTemperatureC: z.number(),
  faq: z.array(FaqEntry),
  usali: UsaliMapping,
  roomCount: z.number().int(),
});
export type Property = z.infer<typeof Property>;

export const RoomType = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  capacityAdults: z.number().int(),
  capacityChildren: z.number().int(),
  beds: z.string(),
  sizeSqm: z.number().nullable(),
  amenities: z.array(z.string()),
  roomCount: z.number().int(),
});

export const HOUSEKEEPING_STATUSES = ["dirty", "cleaning", "clean", "inspected"] as const;
export const HousekeepingStatus = z.enum(HOUSEKEEPING_STATUSES);
export const ServiceStatus = z.enum(["in_service", "out_of_order", "out_of_service"]);

export const Room = z.object({
  id: z.string(),
  number: z.string(),
  roomTypeId: z.string(),
  floor: z.string(),
  attributes: z.array(z.string()),
  housekeeping: HousekeepingStatus,
  service: ServiceStatus,
  occupancy: z.enum(["vacant", "occupied"]),
  ecoMode: z.boolean(),
});

export const RatePolicy = z.object({
  refundable: z.boolean(),
  /** Free cancellation until this many days before arrival (refundable plans). */
  freeCancelDays: z.number().int().min(0).max(365),
  /** Nights charged for a late cancellation (refundable plans). Non-refundable plans charge the whole stay. */
  cancelFeeNights: z.number().int().min(0).max(60),
  /** Nights charged for a no-show. Non-refundable plans charge the whole stay. */
  noShowFeeNights: z.number().int().min(0).max(60),
});

export const RATE_PLAN_KINDS = [
  "bar",
  "derived",
  "non_refundable",
  "breakfast",
  "corporate",
  "long_stay",
  "package",
] as const;

export const Season = z.object({
  name: z.string().trim().min(1).max(80),
  roomTypeId: Id,
  from: IsoDate,
  to: IsoDate,
  amountMinor: PositiveMinorUnits,
  /** Optional day-of-week prices, Monday first; null keeps the season amount for that day. */
  weekdayAmountsMinor: z.array(PositiveMinorUnits.nullable()).length(7).optional(),
});

export const RatePlan = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(RATE_PLAN_KINDS),
  parentId: z.string().nullable(),
  /** Derived plans: percentage on the parent's price, e.g. -10 for "BAR minus 10%". */
  derivedPct: z.number().nullable(),
  breakfastIncluded: z.boolean(),
  corporateAccountId: z.string().nullable(),
  policy: RatePolicy,
  active: z.boolean(),
  baseRates: z.array(z.object({ roomTypeId: z.string(), amountMinor: MinorUnits })),
  seasons: z.array(Season),
});
export type RatePlan = z.infer<typeof RatePlan>;

export const Restriction = z.object({
  roomTypeId: Id.nullable().default(null),
  ratePlanId: Id.nullable().default(null),
  /** null = every channel and direct bookings. */
  channelId: Id.nullable().default(null),
  from: IsoDate,
  to: IsoDate,
  minStay: z.number().int().min(1).max(365).nullable().default(null),
  maxStay: z.number().int().min(1).max(365).nullable().default(null),
  closedToArrival: z.boolean().default(false),
  closedToDeparture: z.boolean().default(false),
  stopSell: z.boolean().default(false),
});
export type RestrictionOut = z.output<typeof Restriction>;

export const Channel = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  /** The channel-manager provider name its signed booking webhooks use. */
  provider: z.string(),
  commissionPct: z.number(),
  active: z.boolean(),
  integration: IntegrationState,
});

export const Outlet = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  department: ChargeDepartment,
  staffUserIds: z.array(z.string()),
});

export const CorporateAccount = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["company", "travel_agent"]),
  creditLimitMinor: MinorUnits,
  contactEmail: z.string().nullable(),
  balanceMinor: MinorUnits,
  ageing: z.object({ current: MinorUnits, d31to60: MinorUnits, d61to90: MinorUnits, over90: MinorUnits }),
});

// ------------------------------------------------------------------ guests, reservations, stays
export const Guest = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  nationality: z.string().nullable(),
  vip: z.boolean(),
  preferences: z.record(z.string(), z.string()),
  /** Allergies are kept only with the guest's recorded consent. */
  allergies: z.string().nullable(),
  marketingConsent: z.boolean(),
  notes: z.string(),
  stayCount: z.number().int(),
});

export const GuestInput = z.object({
  name: Name,
  email: Email.optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{6,20}$/, "Phone looks wrong")
    .optional(),
  idNumber: z.string().trim().min(3).max(40).optional(),
  nationality: z.string().trim().min(2).max(60).optional(),
});

export const STAY_STATUSES = ["reserved", "waitlisted", "in_house", "checked_out", "cancelled", "no_show"] as const;
export const StayStatus = z.enum(STAY_STATUSES);

export const Stay = z.object({
  id: z.string(),
  reservationId: z.string(),
  roomTypeId: z.string(),
  ratePlanId: z.string(),
  roomId: z.string().nullable(),
  roomNumber: z.string().nullable(),
  adults: z.number().int(),
  children: z.number().int(),
  arrival: IsoDate,
  departure: IsoDate,
  status: StayStatus,
  folioIds: z.array(z.string()),
  nights: z.array(z.object({ date: IsoDate, rateMinor: MinorUnits, planRateMinor: MinorUnits, posted: z.boolean() })),
});
export type Stay = z.infer<typeof Stay>;

export const Reservation = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  status: z.enum(["confirmed", "waitlisted", "in_house", "checked_out", "cancelled", "no_show"]),
  guest: Guest.extend({ returning: z.boolean() }),
  arrival: IsoDate,
  departure: IsoDate,
  nights: z.number().int(),
  source: ReservationSource,
  channelId: z.string().nullable(),
  externalRef: z.string().nullable(),
  corporateAccountId: z.string().nullable(),
  groupBlockId: z.string().nullable(),
  specialRequests: z.string(),
  roomTotalMinor: MinorUnits,
  preCheckIn: z
    .object({
      idCaptured: z.boolean(),
      idDocumentRef: z.string(),
      nationality: z.string().nullable(),
      signatureRef: z.string(),
      arrivalTime: z.string().nullable(),
      at: IsoDateTime,
    })
    .nullable(),
  deposits: z.array(
    z.object({
      id: z.string(),
      amountMinor: MinorUnits,
      method: PaymentMethod,
      reference: z.string(),
      receivedOn: IsoDate,
      appliedToFolioId: z.string().nullable(),
    }),
  ),
  cancelledReason: z.string().nullable(),
  stays: z.array(Stay),
});
export type Reservation = z.infer<typeof Reservation>;

export const RoomRequest = z.object({
  roomTypeId: Id,
  ratePlanId: Id,
  adults: z.number().int().min(1).max(20).default(1),
  children: z.number().int().min(0).max(20).default(0),
  /** A negotiated or discretionary nightly rate. Rates below the plan are flagged by the income audit. */
  rateOverrideMinor: PositiveMinorUnits.optional(),
});

export const ReservationInput = z
  .object({
    guest: GuestInput,
    arrival: IsoDate,
    departure: IsoDate,
    rooms: z.array(RoomRequest).min(1).max(20),
    source: ReservationSource.default("direct"),
    channelId: Id.optional(),
    corporateAccountId: Id.optional(),
    groupBlockId: Id.optional(),
    specialRequests: Text.default(""),
    /** When nothing is available: put the booking on the waitlist instead of refusing it. */
    waitlist: z.boolean().default(false),
  })
  .refine((r) => r.departure > r.arrival, "Departure must be after arrival");

export const GroupBlock = z.object({
  id: z.string(),
  name: z.string(),
  roomTypeId: z.string(),
  ratePlanId: z.string(),
  arrival: IsoDate,
  departure: IsoDate,
  roomsPerNight: z.number().int(),
  cutoffDate: IsoDate,
  billing: z.enum(["master", "individual"]),
  corporateAccountId: z.string().nullable(),
  status: z.enum(["open", "released"]),
  masterFolioId: z.string().nullable(),
  nights: z.array(z.object({ date: IsoDate, held: z.number().int(), picked: z.number().int() })),
});

// ------------------------------------------------------------------ folios
export const FOLIO_LINE_KINDS = ["charge", "payment", "deposit", "transfer", "void", "refund", "city_ledger"] as const;
export const FolioLine = z.object({
  id: z.string(),
  date: IsoDate,
  kind: z.enum(FOLIO_LINE_KINDS),
  department: HotelDepartment.nullable(),
  description: z.string(),
  netMinor: MinorUnits,
  serviceChargeMinor: MinorUnits,
  vatMinor: MinorUnits,
  levyMinor: MinorUnits,
  /** Signed: charges add to the balance, payments and credits reduce it. */
  totalMinor: MinorUnits,
  method: PaymentMethod.nullable(),
  reference: z.string().nullable(),
  voidsLineId: z.string().nullable(),
  voidedBy: z.string().nullable(),
  voidApprovedBy: z.string().nullable(),
  journalId: z.string().nullable(),
  createdBy: z.string().nullable(),
});

export const Folio = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  reservationId: z.string().nullable(),
  stayId: z.string().nullable(),
  groupBlockId: z.string().nullable(),
  name: z.string(),
  payer: z.enum(["guest", "company"]),
  corporateAccountId: z.string().nullable(),
  status: z.enum(["open", "closed"]),
  blocked: z.boolean(),
  blockedReason: z.string().nullable(),
  lines: z.array(FolioLine),
  chargesMinor: MinorUnits,
  creditsMinor: MinorUnits,
  balanceMinor: MinorUnits,
});
export type Folio = z.infer<typeof Folio>;

export const Refund = z.object({
  id: z.string(),
  folioId: z.string(),
  amountMinor: MinorUnits,
  method: PaymentMethod,
  reason: z.string(),
  status: z.enum(["requested", "approved"]),
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
});

export const Key = z.object({
  id: z.string(),
  stayId: z.string(),
  roomId: z.string(),
  validFrom: IsoDate,
  validTo: IsoDate,
  status: z.enum(["active", "revoked"]),
  adapterRef: z.string(),
  integration: IntegrationState,
});

// ------------------------------------------------------------------ operations
export const RoomBoardRow = Room.extend({
  roomTypeCode: z.string(),
  assignedTo: z.string().nullable(),
  arrivalToday: z.boolean(),
  departureToday: z.boolean(),
  /** Ready to give to an arriving guest: vacant, in service and clean (or inspected where the property requires it). */
  ready: z.boolean(),
});

export const MaintenanceTicket = z.object({
  id: z.string(),
  roomId: z.string().nullable(),
  title: z.string(),
  kind: z.enum(["corrective", "preventive"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  status: z.enum(["open", "resolved"]),
  outOfOrderFrom: IsoDate.nullable(),
  outOfOrderTo: IsoDate.nullable(),
  dueDate: IsoDate.nullable(),
  createdBy: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  note: z.string(),
});

export const LostItem = z.object({
  id: z.string(),
  roomId: z.string().nullable(),
  item: z.string(),
  foundOn: IsoDate,
  photoRef: z.string().nullable(),
  guestContacted: z.boolean(),
  status: z.enum(["held", "returned", "disposed"]),
});

export const GuestRequest = z.object({
  id: z.string(),
  stayId: z.string().nullable(),
  reservationId: z.string().nullable(),
  kind: z.enum(["request", "wake_up", "housekeeping", "maintenance", "handoff"]),
  text: z.string(),
  dueAt: IsoDateTime.nullable(),
  status: z.enum(["open", "done"]),
  source: z.enum(["staff", "concierge", "guest"]),
  createdBy: z.string().nullable(),
  completedBy: z.string().nullable(),
});

export const CashierShift = z.object({
  id: z.string(),
  userId: z.string(),
  businessDate: IsoDate,
  status: z.enum(["open", "closed"]),
  floatMinor: MinorUnits,
  takings: ByMethod,
  expectedCashMinor: MinorUnits,
  countedCashMinor: MinorUnits.nullable(),
  overShortMinor: MinorUnits.nullable(),
  openedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
});

export const AuditBlock = z.object({
  code: z.enum([
    "OPEN_CASHIER_SHIFT",
    "DEPARTURE_NOT_CHECKED_OUT",
    "FOLIO_OUT_OF_BALANCE",
    "UNAPPROVED_VOIDS",
    "PENDING_NO_SHOWS",
  ]),
  message: z.string(),
  refs: z.array(z.string()),
});

const DeptAmounts = z.object({
  rooms: MinorUnits,
  fnb: MinorUnits,
  spa: MinorUnits,
  other: MinorUnits,
  noshow: MinorUnits,
  total: MinorUnits,
});

export const DailyReport = z.object({
  propertyId: z.string(),
  businessDate: IsoDate,
  currency: Currency,
  roomsAvailable: z.number().int(),
  roomsSold: z.number().int(),
  outOfOrder: z.number().int(),
  occupancyPct: z.number(),
  adrMinor: MinorUnits,
  revparMinor: MinorUnits,
  trevparMinor: MinorUnits,
  /** Revenue by department from the ledger postings of the day. */
  revenue: DeptAmounts,
  /** The same figures summed from the folio lines; must equal `revenue`. */
  folioRevenue: DeptAmounts,
  reconciled: z.boolean(),
  taxes: z.object({ vat: MinorUnits, serviceCharge: MinorUnits, levy: MinorUnits }),
  payments: ByMethod.extend({ total: MinorUnits }),
  depositsReceivedMinor: MinorUnits,
  arrivals: z.number().int(),
  departures: z.number().int(),
  noShows: z.number().int(),
  distribution: z.string(),
});
export type DailyReport = z.infer<typeof DailyReport>;

export const IncomeAuditFinding = z.object({
  code: z.enum(["RATE_BELOW_PLAN", "VOID_WITHOUT_APPROVAL"]),
  message: z.string(),
  ref: z.string(),
  amountMinor: MinorUnits,
});

export const IncomeAudit = z.object({
  propertyId: z.string(),
  businessDate: IsoDate,
  findings: z.array(IncomeAuditFinding),
  signedOffBy: z.string().nullable(),
  signedOffAt: IsoDateTime.nullable(),
  note: z.string().nullable(),
  final: z.boolean(),
});

export const Kpis = z.object({
  from: IsoDate,
  to: IsoDate,
  currency: Currency,
  roomsAvailable: z.number().int(),
  roomsSold: z.number().int(),
  occupancyPct: z.number(),
  adrMinor: MinorUnits,
  revparMinor: MinorUnits,
  trevparMinor: MinorUnits,
  gopMinor: MinorUnits,
  gopparMinor: MinorUnits,
  costPerOccupiedRoomMinor: MinorUnits,
  revenue: DeptAmounts,
});
export type Kpis = z.infer<typeof Kpis>;

export const PnlDepartment = z.object({
  key: z.enum(["rooms", "fnb", "spa", "other"]),
  name: z.string(),
  revenueMinor: MinorUnits,
  costsMinor: MinorUnits,
  profitMinor: MinorUnits,
  accounts: z.array(z.object({ code: AccountCode, name: z.string(), amountMinor: MinorUnits })),
});

export const RoomCommand = z.object({
  id: z.string(),
  roomId: z.string(),
  roomNumber: z.string(),
  command: z.enum(["eco_on", "eco_off", "set_temperature"]),
  value: z.number().nullable(),
  reason: z.string(),
  integration: IntegrationState,
  at: IsoDateTime,
});

export const AriMessage = z.object({
  id: z.string(),
  channelId: z.string(),
  roomTypeId: z.string(),
  from: IsoDate,
  to: IsoDate,
  days: z.array(
    z.object({
      date: IsoDate,
      available: z.number().int(),
      closed: z.boolean(),
      rates: z.array(z.object({ ratePlanId: z.string(), amountMinor: MinorUnits })),
    }),
  ),
  status: z.string(),
  at: IsoDateTime,
});

export const Message = z.object({
  id: z.string(),
  reservationId: z.string().nullable(),
  channel: z.enum(["whatsapp", "sms", "email", "web"]),
  direction: z.enum(["inbound", "outbound"]),
  body: z.string(),
  status: z.string(),
  at: IsoDateTime,
});

// ------------------------------------------------------------------ params
const Base = "/api/v1/orgs/:orgId/hotel";
const P = `${Base}/properties/:propertyId`;
const PropParams = OrgParams.extend({ propertyId: Id });
const Range = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((r) => r.to >= r.from, "The end date is before the start date");

// ------------------------------------------------------------------ endpoints: setup
export const listProperties = endpoint({
  id: "hotel.properties.list",
  method: "GET",
  path: `${Base}/properties`,
  auth: "user",
  summary: "The organisation's hotels you can work in, and whether group (chain) views apply",
  params: OrgParams,
  response: z.object({ properties: z.array(Property), groupViews: z.boolean() }),
});

const PropertyFields = z.object({
  name: Name,
  country: z.string().trim().min(2).max(80),
  city: z.string().trim().min(1).max(80),
  timezone: z.string().min(1).max(60).default("UTC"),
  checkInTime: Time.default("14:00"),
  checkOutTime: Time.default("11:00"),
  tax: TaxConfig,
  requireInspection: z.boolean().default(false),
  welcomeTemperatureC: z.number().min(10).max(30).default(22),
  ecoTemperatureC: z.number().min(10).max(35).default(26),
  faq: z.array(FaqEntry).max(100).default([]),
  usali: UsaliMapping.optional(),
});

export const createProperty = endpoint({
  id: "hotel.properties.create",
  method: "POST",
  path: `${Base}/properties`,
  auth: "user",
  summary: "Add a hotel. Its currency is the organisation's; its business date starts today unless given.",
  params: OrgParams,
  body: PropertyFields.extend({ businessDate: IsoDate.optional() }),
  response: Property,
  status: 201,
});

export const getProperty = endpoint({
  id: "hotel.properties.get",
  method: "GET",
  path: P,
  auth: "user",
  summary: "One hotel with its tax engine, business date and settings",
  params: PropParams,
  response: Property,
});

export const updateProperty = endpoint({
  id: "hotel.properties.update",
  method: "PUT",
  path: P,
  auth: "user",
  summary: "Change a hotel's settings (taxes, times, concierge answers, departmental account mapping)",
  params: PropParams,
  body: PropertyFields.partial(),
  response: Property,
});

export const setPropertyStaff = endpoint({
  id: "hotel.properties.staff",
  method: "PUT",
  path: `${P}/staff`,
  auth: "user",
  summary:
    "The members who work at this hotel. A member assigned to any hotel sees only the hotels they are assigned to.",
  params: PropParams,
  body: z.object({ userIds: z.array(Id).max(500) }),
  response: z.object({ userIds: z.array(z.string()) }),
});

export const getSetup = endpoint({
  id: "hotel.setup.get",
  method: "GET",
  path: `${P}/setup`,
  auth: "user",
  summary: "Room types, rooms, rate plans, restrictions, channels and outlets of a hotel",
  params: PropParams,
  response: z.object({
    property: Property,
    roomTypes: z.array(RoomType),
    rooms: z.array(Room),
    ratePlans: z.array(RatePlan),
    restrictions: z.array(Restriction),
    channels: z.array(Channel),
    outlets: z.array(Outlet),
  }),
});

export const createRoomType = endpoint({
  id: "hotel.roomTypes.create",
  method: "POST",
  path: `${P}/room-types`,
  auth: "user",
  summary: "Add a room type",
  params: PropParams,
  body: z.object({
    code: Code,
    name: Name,
    capacityAdults: z.number().int().min(1).max(20),
    capacityChildren: z.number().int().min(0).max(20).default(0),
    beds: z.string().trim().min(1).max(80),
    sizeSqm: z.number().positive().max(10000).nullable().default(null),
    amenities: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  }),
  response: RoomType,
  status: 201,
});

export const createRooms = endpoint({
  id: "hotel.rooms.create",
  method: "POST",
  path: `${P}/rooms`,
  auth: "user",
  summary: "Add physical rooms, each linked to its room type. Inventory grows with them.",
  params: PropParams,
  body: z.object({
    rooms: z
      .array(
        z.object({
          number: z.string().trim().min(1).max(20),
          roomTypeId: Id,
          floor: z.string().trim().max(20).default(""),
          attributes: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
        }),
      )
      .min(1)
      .max(500),
  }),
  response: z.object({ rooms: z.array(Room) }),
  status: 201,
});

const RatePlanFields = z.object({
  name: Name,
  breakfastIncluded: z.boolean().default(false),
  policy: RatePolicy.default({ refundable: true, freeCancelDays: 1, cancelFeeNights: 1, noShowFeeNights: 1 }),
  baseRates: z
    .array(z.object({ roomTypeId: Id, amountMinor: PositiveMinorUnits }))
    .max(100)
    .default([]),
  derivedPct: SignedPct.optional(),
  active: z.boolean().default(true),
});

export const createRatePlan = endpoint({
  id: "hotel.ratePlans.create",
  method: "POST",
  path: `${P}/rate-plans`,
  auth: "user",
  summary: "Add a rate plan: BAR, a plan derived from a parent (e.g. -10%), non-refundable, breakfast, corporate …",
  params: PropParams,
  body: RatePlanFields.extend({
    code: Code,
    kind: z.enum(RATE_PLAN_KINDS),
    parentId: Id.optional(),
    corporateAccountId: Id.optional(),
  }),
  response: RatePlan,
  status: 201,
});

export const updateRatePlan = endpoint({
  id: "hotel.ratePlans.update",
  method: "PUT",
  path: `${P}/rate-plans/:ratePlanId`,
  auth: "user",
  summary: "Change a rate plan's prices, policy or status (revenue and front-office managers only)",
  params: PropParams.extend({ ratePlanId: Id }),
  body: RatePlanFields.partial(),
  response: RatePlan,
});

export const setSeasons = endpoint({
  id: "hotel.ratePlans.seasons",
  method: "PUT",
  path: `${P}/rate-plans/:ratePlanId/seasons`,
  auth: "user",
  summary: "Replace a rate plan's seasons and day-of-week prices",
  params: PropParams.extend({ ratePlanId: Id }),
  body: z.object({ seasons: z.array(Season).max(200) }),
  response: RatePlan,
});

export const setRestrictions = endpoint({
  id: "hotel.restrictions.set",
  method: "PUT",
  path: `${P}/restrictions`,
  auth: "user",
  summary: "Replace the hotel's restrictions: minimum / maximum stay, closed to arrival or departure, stop-sell",
  params: PropParams,
  body: z.object({ restrictions: z.array(Restriction).max(1000) }),
  response: z.object({ restrictions: z.array(Restriction) }),
});

export const createChannel = endpoint({
  id: "hotel.channels.create",
  method: "POST",
  path: `${P}/channels`,
  auth: "user",
  summary: "Connect a sales channel (OTA, short-let platform) through the channel manager, with its commission",
  params: PropParams,
  body: z.object({
    code: Code,
    name: Name,
    provider: z.string().regex(/^[a-z0-9]{2,30}$/, "Provider: 2–30 lowercase letters or digits"),
    commissionPct: Pct,
  }),
  response: Channel,
  status: 201,
});

export const createOutlet = endpoint({
  id: "hotel.outlets.create",
  method: "POST",
  path: `${P}/outlets`,
  auth: "user",
  summary: "Add a revenue outlet (restaurant, bar, spa …) and the outlet staff who may post from it",
  params: PropParams,
  body: z.object({
    code: Code,
    name: Name,
    department: ChargeDepartment,
    staffUserIds: z.array(Id).max(200).default([]),
  }),
  response: Outlet,
  status: 201,
});

export const listCorporateAccounts = endpoint({
  id: "hotel.corporate.list",
  method: "GET",
  path: `${Base}/corporate-accounts`,
  auth: "user",
  summary: "Company and travel-agent accounts with city-ledger balance and ageing",
  params: OrgParams,
  response: z.object({ accounts: z.array(CorporateAccount) }),
});

export const createCorporateAccount = endpoint({
  id: "hotel.corporate.create",
  method: "POST",
  path: `${Base}/corporate-accounts`,
  auth: "user",
  summary: "Add a company or travel-agent account with its credit limit",
  params: OrgParams,
  body: z.object({
    name: Name,
    kind: z.enum(["company", "travel_agent"]).default("company"),
    creditLimitMinor: NonNegativeMinor,
    contactEmail: Email.optional(),
  }),
  response: CorporateAccount,
  status: 201,
});

export const cityLedgerStatement = endpoint({
  id: "hotel.corporate.statement",
  method: "GET",
  path: `${Base}/corporate-accounts/:accountId/statement`,
  auth: "user",
  summary: "City-ledger statement: invoices from checked-out folios and payments received",
  params: OrgParams.extend({ accountId: Id }),
  response: z.object({
    account: CorporateAccount,
    entries: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        date: IsoDate,
        kind: z.enum(["invoice", "payment"]),
        amountMinor: MinorUnits,
        folioId: z.string().nullable(),
        reference: z.string(),
      }),
    ),
  }),
});

export const cityLedgerPayment = endpoint({
  id: "hotel.corporate.payment",
  method: "POST",
  path: `${Base}/corporate-accounts/:accountId/payments`,
  auth: "user",
  summary: "Record a payment received from a company (recorded, not processed). Posts bank 1000 / city ledger 1160.",
  params: OrgParams.extend({ accountId: Id }),
  body: z.object({
    propertyId: Id,
    amountMinor: PositiveMinorUnits,
    method: PaymentMethod,
    reference: z.string().trim().min(2).max(120),
  }),
  response: CorporateAccount,
  status: 201,
});

export const listGuests = endpoint({
  id: "hotel.guests.list",
  method: "GET",
  path: `${Base}/guests`,
  auth: "user",
  summary: "Find guest profiles by name, email, phone or ID number (returning guests are recognised at booking)",
  params: OrgParams,
  query: z.object({ q: z.string().trim().min(2).max(120) }),
  response: z.object({ guests: z.array(Guest) }),
});

export const updateGuest = endpoint({
  id: "hotel.guests.update",
  method: "PUT",
  path: `${Base}/guests/:guestId`,
  auth: "user",
  summary: "Update a guest's preferences, VIP status, notes and consents. Allergies need the guest's consent.",
  params: OrgParams.extend({ guestId: Id }),
  body: z
    .object({
      preferences: z.record(z.string().max(40), z.string().max(200)).optional(),
      vip: z.boolean().optional(),
      notes: Text.optional(),
      marketingConsent: z.boolean().optional(),
      allergies: z.string().trim().max(500).nullable().optional(),
      allergyConsent: z.boolean().optional(),
    })
    .refine((b) => !b.allergies || b.allergyConsent === true, "Record the guest's consent before keeping allergies"),
  response: Guest,
});

// ------------------------------------------------------------------ availability and reservations
export const availability = endpoint({
  id: "hotel.availability",
  method: "GET",
  path: `${P}/availability`,
  auth: "user",
  summary:
    "The ONE availability record by room type and night, with rates — as the booking engine or a channel sees it",
  params: PropParams,
  query: z
    .object({ from: IsoDate, to: IsoDate, channelId: Id.optional() })
    .refine((r) => r.to >= r.from, "The end date is before the start date"),
  response: z.object({
    channelId: z.string().nullable(),
    roomTypes: z.array(
      z.object({
        roomTypeId: z.string(),
        code: z.string(),
        name: z.string(),
        days: z.array(
          z.object({
            date: IsoDate,
            total: z.number().int(),
            sold: z.number().int(),
            held: z.number().int(),
            outOfOrder: z.number().int(),
            available: z.number().int(),
            closed: z.boolean(),
            rates: z.array(z.object({ ratePlanId: z.string(), code: z.string(), amountMinor: MinorUnits })),
          }),
        ),
      }),
    ),
  }),
});

export const createReservation = endpoint({
  id: "hotel.reservations.create",
  method: "POST",
  path: `${P}/reservations`,
  auth: "user",
  summary: "Book one or more rooms. Each night is taken from the one inventory; the last room can never be sold twice.",
  params: PropParams,
  body: ReservationInput,
  response: Reservation,
  status: 201,
});

export const listReservations = endpoint({
  id: "hotel.reservations.list",
  method: "GET",
  path: `${P}/reservations`,
  auth: "user",
  summary: "Reservations staying between two dates (arrivals, in-house, departures)",
  params: PropParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional(), status: Reservation.shape.status.optional() }),
  response: z.object({ reservations: z.array(Reservation) }),
});

const ResParams = PropParams.extend({ reservationId: Id });

export const getReservation = endpoint({
  id: "hotel.reservations.get",
  method: "GET",
  path: `${P}/reservations/:reservationId`,
  auth: "user",
  summary: "One reservation with its stays, nights and deposits",
  params: ResParams,
  response: Reservation,
});

export const cancelReservation = endpoint({
  id: "hotel.reservations.cancel",
  method: "POST",
  path: `${P}/reservations/:reservationId/cancel`,
  auth: "user",
  summary: "Cancel: the rooms return to sale and the rate plan's cancellation fee is charged where the policy says",
  params: ResParams,
  body: z.object({ reason: Reason }),
  response: z.object({ reservation: Reservation, feeMinor: MinorUnits, folioId: z.string().nullable() }),
});

export const noShowReservation = endpoint({
  id: "hotel.reservations.noShow",
  method: "POST",
  path: `${P}/reservations/:reservationId/no-show`,
  auth: "user",
  summary: "Record a no-show on or after the arrival date: fee per policy, deposit applied, rooms released",
  params: ResParams,
  response: z.object({ reservation: Reservation, feeMinor: MinorUnits, folioId: z.string().nullable() }),
});

export const confirmWaitlisted = endpoint({
  id: "hotel.reservations.confirmWaitlist",
  method: "POST",
  path: `${P}/reservations/:reservationId/confirm`,
  auth: "user",
  summary: "Confirm a waitlisted reservation once rooms are free (takes them from inventory, or refuses)",
  params: ResParams,
  response: Reservation,
});

export const createGroupBlock = endpoint({
  id: "hotel.groups.create",
  method: "POST",
  path: `${P}/groups`,
  auth: "user",
  summary: "Hold a block of rooms for a group (wedding, tour, conference) until its cut-off date",
  params: PropParams,
  body: z
    .object({
      name: Name,
      roomTypeId: Id,
      ratePlanId: Id,
      arrival: IsoDate,
      departure: IsoDate,
      roomsPerNight: z.number().int().min(1).max(1000),
      cutoffDate: IsoDate,
      billing: z.enum(["master", "individual"]).default("individual"),
      corporateAccountId: Id.optional(),
    })
    .refine((g) => g.departure > g.arrival, "Departure must be after arrival")
    .refine((g) => g.cutoffDate <= g.arrival, "The cut-off date must be on or before arrival"),
  response: GroupBlock,
  status: 201,
});

export const listGroupBlocks = endpoint({
  id: "hotel.groups.list",
  method: "GET",
  path: `${P}/groups`,
  auth: "user",
  summary: "Group blocks with rooms held and picked up per night",
  params: PropParams,
  response: z.object({ groups: z.array(GroupBlock) }),
});

export const releaseGroupCutoffs = endpoint({
  id: "hotel.groups.releaseCutoffs",
  method: "POST",
  path: `${P}/groups/release-cutoffs`,
  auth: "user",
  summary:
    "Return unsold rooms of blocks whose cut-off date has passed to general sale (the night audit does this too)",
  params: PropParams,
  response: z.object({ released: z.array(z.object({ groupId: z.string(), roomNights: z.number().int() })) }),
});

// ------------------------------------------------------------------ front desk
const StayParams = PropParams.extend({ stayId: Id });

export const preCheckIn = endpoint({
  id: "hotel.frontdesk.preCheckIn",
  method: "POST",
  path: `${P}/reservations/:reservationId/pre-check-in`,
  auth: "user",
  summary:
    "Digital pre-check-in: ID captured (document reference), registration signed (signature reference), deposit recorded as a liability",
  params: ResParams,
  body: z.object({
    idCaptured: z.literal(true, { error: "Capture the guest's ID first" }),
    idDocumentRef: z.string().trim().min(3).max(200),
    nationality: z.string().trim().min(2).max(60).optional(),
    signatureRef: z.string().trim().min(3).max(200),
    arrivalTime: Time.optional(),
    deposit: z
      .object({ amountMinor: PositiveMinorUnits, method: PaymentMethod, reference: z.string().trim().min(2).max(120) })
      .optional(),
  }),
  response: Reservation,
});

export const assignRoom = endpoint({
  id: "hotel.frontdesk.assignRoom",
  method: "POST",
  path: `${P}/stays/:stayId/assign-room`,
  auth: "user",
  summary: "Pre-assign a room of the booked type to a stay (a room never holds two overlapping stays)",
  params: StayParams,
  body: z.object({ roomId: Id }),
  response: Stay,
});

export const checkIn = endpoint({
  id: "hotel.frontdesk.checkIn",
  method: "POST",
  path: `${P}/stays/:stayId/check-in`,
  auth: "user",
  summary: "Check in: room assigned (ready rooms only), folio opened, deposits applied, mobile key issued",
  params: StayParams,
  body: z.object({ roomId: Id.optional() }),
  response: z.object({ stay: Stay, folio: Folio, key: Key }),
});

export const moveRoom = endpoint({
  id: "hotel.frontdesk.move",
  method: "POST",
  path: `${P}/stays/:stayId/move`,
  auth: "user",
  summary: "Move an in-house guest to another ready room of the same type; the old room goes dirty, keys are re-issued",
  params: StayParams,
  body: z.object({ roomId: Id, reason: Reason }),
  response: z.object({ stay: Stay, key: Key }),
});

export const extendStay = endpoint({
  id: "hotel.frontdesk.extend",
  method: "POST",
  path: `${P}/stays/:stayId/extend`,
  auth: "user",
  summary: "Extend a stay: the extra nights come from the one inventory and the room must stay free",
  params: StayParams,
  body: z.object({ departure: IsoDate }),
  response: Stay,
});

export const checkOut = endpoint({
  id: "hotel.frontdesk.checkOut",
  method: "POST",
  path: `${P}/stays/:stayId/check-out`,
  auth: "user",
  summary:
    "Check out: every folio must balance, or a company folio goes to the city ledger (within the credit limit). Room set dirty; keys revoked.",
  params: StayParams,
  response: z.object({
    stay: Stay,
    folios: z.array(Folio),
    cityLedger: z.array(z.object({ folioId: z.string(), corporateAccountId: z.string(), amountMinor: MinorUnits })),
  }),
});

export const listRequests = endpoint({
  id: "hotel.requests.list",
  method: "GET",
  path: `${P}/requests`,
  auth: "user",
  summary: "Guest requests, wake-up calls and concierge hand-overs",
  params: PropParams,
  query: z.object({ status: z.enum(["open", "done"]).optional() }),
  response: z.object({ requests: z.array(GuestRequest) }),
});

export const createRequest = endpoint({
  id: "hotel.requests.create",
  method: "POST",
  path: `${P}/requests`,
  auth: "user",
  summary: "Record a guest request or wake-up call as a task",
  params: PropParams,
  body: z.object({
    stayId: Id.optional(),
    kind: GuestRequest.shape.kind.default("request"),
    text: z.string().trim().min(2).max(1000),
    dueAt: IsoDateTime.optional(),
  }),
  response: GuestRequest,
  status: 201,
});

export const completeRequest = endpoint({
  id: "hotel.requests.complete",
  method: "POST",
  path: `${P}/requests/:requestId/complete`,
  auth: "user",
  summary: "Mark a request done",
  params: PropParams.extend({ requestId: Id }),
  response: GuestRequest,
});

// ------------------------------------------------------------------ folios
const FolioParams = PropParams.extend({ folioId: Id });

export const listFolios = endpoint({
  id: "hotel.folios.list",
  method: "GET",
  path: `${P}/folios`,
  auth: "user",
  summary: "Folios of a hotel, optionally of one reservation or stay",
  params: PropParams,
  query: z.object({
    reservationId: Id.optional(),
    stayId: Id.optional(),
    status: z.enum(["open", "closed"]).optional(),
  }),
  response: z.object({ folios: z.array(Folio) }),
});

export const getFolio = endpoint({
  id: "hotel.folios.get",
  method: "GET",
  path: `${P}/folios/:folioId`,
  auth: "user",
  summary: "One folio with every line and its balance",
  params: FolioParams,
  response: Folio,
});

export const createFolio = endpoint({
  id: "hotel.folios.create",
  method: "POST",
  path: `${P}/folios`,
  auth: "user",
  summary: "Open another folio for a stay (split billing), e.g. a company folio for room and tax",
  params: PropParams,
  body: z.object({
    stayId: Id,
    name: Name,
    payer: z.enum(["guest", "company"]),
    corporateAccountId: Id.optional(),
  }),
  response: Folio,
  status: 201,
});

export const setRouting = endpoint({
  id: "hotel.folios.routing",
  method: "PUT",
  path: `${P}/stays/:stayId/routing`,
  auth: "user",
  summary: "Route charges by department to a folio of the stay (e.g. rooms to the company, extras to the guest)",
  params: StayParams,
  body: z.object({ rules: z.array(z.object({ department: HotelDepartment, folioId: Id })).max(10) }),
  response: z.object({ rules: z.array(z.object({ department: HotelDepartment, folioId: z.string() })) }),
});

export const postCharge = endpoint({
  id: "hotel.folios.charge",
  method: "POST",
  path: `${P}/folios/:folioId/charges`,
  auth: "user",
  summary: "Post a charge with the hotel's taxes (VAT, service charge, levy) — and to the ledger",
  params: FolioParams,
  body: z.object({
    department: ChargeDepartment,
    description: z.string().trim().min(2).max(200),
    amountMinor: PositiveMinorUnits,
  }),
  response: Folio,
  status: 201,
});

export const transferLines = endpoint({
  id: "hotel.folios.transfer",
  method: "POST",
  path: `${P}/folios/:folioId/transfer`,
  auth: "user",
  summary: "Move charges to another open folio of the same reservation or group",
  params: FolioParams,
  body: z.object({ lineIds: z.array(Id).min(1).max(200), toFolioId: Id }),
  response: z.object({ from: Folio, to: Folio }),
});

export const recordPayment = endpoint({
  id: "hotel.folios.payment",
  method: "POST",
  path: `${P}/folios/:folioId/payments`,
  auth: "user",
  summary:
    "Record a payment taken through the hotel's own provider or till (never processed here). Cash needs your open cashier shift.",
  params: FolioParams,
  body: z.object({
    method: PaymentMethod,
    amountMinor: PositiveMinorUnits,
    reference: z.string().trim().min(2).max(120),
  }),
  response: Folio,
  status: 201,
});

export const blockFolio = endpoint({
  id: "hotel.folios.block",
  method: "POST",
  path: `${P}/folios/:folioId/block`,
  auth: "user",
  summary: "Block a folio from room charges (outlets then require payment on the spot), or unblock it",
  params: FolioParams,
  body: z.object({ blocked: z.boolean(), reason: Reason }),
  response: Folio,
});

const LineParams = FolioParams.extend({ lineId: Id });

export const voidLine = endpoint({
  id: "hotel.folios.void",
  method: "POST",
  path: `${P}/folios/:folioId/lines/:lineId/void`,
  auth: "user",
  summary: "Void a charge (reverses its ledger posting). Unapproved voids are flagged by the income audit.",
  params: LineParams,
  body: z.object({ reason: Reason }),
  response: Folio,
});

export const approveVoid = endpoint({
  id: "hotel.folios.approveVoid",
  method: "POST",
  path: `${P}/folios/:folioId/lines/:lineId/approve`,
  auth: "user",
  summary: "Approve a void made by someone else",
  params: LineParams,
  response: Folio,
});

export const requestRefund = endpoint({
  id: "hotel.folios.refund",
  method: "POST",
  path: `${P}/folios/:folioId/refunds`,
  auth: "user",
  summary: "Request a refund of a folio credit; someone else must approve it before it posts",
  params: FolioParams,
  body: z.object({ amountMinor: PositiveMinorUnits, method: PaymentMethod, reason: Reason }),
  response: Refund,
  status: 201,
});

export const approveRefund = endpoint({
  id: "hotel.refunds.approve",
  method: "POST",
  path: `${P}/refunds/:refundId/approve`,
  auth: "user",
  summary: "Approve a refund requested by someone else; it is recorded on the folio and posted (paid out by the hotel)",
  params: PropParams.extend({ refundId: Id }),
  response: Refund,
});

export const outletCharge = endpoint({
  id: "hotel.outlets.charge",
  method: "POST",
  path: `${P}/outlets/:outletId/charges`,
  auth: "user",
  summary:
    "Charge an outlet sale to a room: only for a guest in house whose folio is not blocked (blocked folios pay on the spot)",
  params: PropParams.extend({ outletId: Id }),
  body: z.object({
    roomNumber: z.string().trim().min(1).max(20),
    description: z.string().trim().min(2).max(200),
    amountMinor: PositiveMinorUnits,
  }),
  response: z.object({ folioId: z.string(), line: FolioLine }),
  status: 201,
});

// ------------------------------------------------------------------ rooms, housekeeping, maintenance
export const roomBoard = endpoint({
  id: "hotel.rooms.board",
  method: "GET",
  path: `${P}/room-status`,
  auth: "user",
  summary: "Every room's live status, with the housekeeping board figures",
  params: PropParams,
  response: z.object({
    businessDate: IsoDate,
    rooms: z.array(RoomBoardRow),
    figures: z.object({
      toClean: z.number().int(),
      averageCleanMinutes: z.number().nullable(),
      outOfOrder: z.number().int(),
      readyForArrivals: z.number().int(),
      arrivalsToday: z.number().int(),
    }),
  }),
});

export const setHousekeeping = endpoint({
  id: "hotel.rooms.housekeeping",
  method: "POST",
  path: `${P}/rooms/:roomId/housekeeping`,
  auth: "user",
  summary:
    "Attendants start and finish their own rooms; supervisors inspect, which releases the room to the front desk",
  params: PropParams.extend({ roomId: Id }),
  body: z.object({ status: HousekeepingStatus }),
  response: Room,
});

export const assignHousekeeping = endpoint({
  id: "hotel.housekeeping.assign",
  method: "POST",
  path: `${P}/housekeeping/assignments`,
  auth: "user",
  summary: "Assign rooms to an attendant for the business date",
  params: PropParams,
  body: z.object({ attendantUserId: Id, roomIds: z.array(Id).min(1).max(200) }),
  response: z.object({ date: IsoDate, attendantUserId: z.string(), roomIds: z.array(z.string()) }),
});

export const postMinibar = endpoint({
  id: "hotel.rooms.minibar",
  method: "POST",
  path: `${P}/rooms/:roomId/minibar`,
  auth: "user",
  summary: "Record minibar consumption in an occupied room; it posts to the guest folio as food and beverage",
  params: PropParams.extend({ roomId: Id }),
  body: z.object({
    items: z
      .array(
        z.object({
          description: z.string().trim().min(2).max(100),
          quantity: z.number().int().min(1).max(50),
          unitMinor: PositiveMinorUnits,
        }),
      )
      .min(1)
      .max(50),
  }),
  response: z.object({ folioId: z.string(), line: FolioLine }),
  status: 201,
});

export const listMaintenance = endpoint({
  id: "hotel.maintenance.list",
  method: "GET",
  path: `${P}/maintenance`,
  auth: "user",
  summary: "Maintenance tickets (corrective and preventive)",
  params: PropParams,
  query: z.object({ status: z.enum(["open", "resolved"]).optional() }),
  response: z.object({ tickets: z.array(MaintenanceTicket) }),
});

export const createMaintenance = endpoint({
  id: "hotel.maintenance.create",
  method: "POST",
  path: `${P}/maintenance`,
  auth: "user",
  summary: "Open a ticket; a room set out of order leaves inventory for those nights (refused if that would oversell)",
  params: PropParams,
  body: z
    .object({
      roomId: Id.optional(),
      title: z.string().trim().min(3).max(200),
      kind: z.enum(["corrective", "preventive"]).default("corrective"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      dueDate: IsoDate.optional(),
      outOfOrder: Range.optional(),
      outOfService: z.boolean().default(false),
    })
    .refine((b) => !(b.outOfOrder || b.outOfService) || b.roomId, "Name the room to take out of order or service"),
  response: MaintenanceTicket,
  status: 201,
});

export const resolveMaintenance = endpoint({
  id: "hotel.maintenance.resolve",
  method: "POST",
  path: `${P}/maintenance/:ticketId/resolve`,
  auth: "user",
  summary: "Resolve a ticket: the room returns to service (dirty, so housekeeping prepares it)",
  params: PropParams.extend({ ticketId: Id }),
  body: z.object({ note: z.string().trim().min(2).max(500) }),
  response: MaintenanceTicket,
});

export const listLostFound = endpoint({
  id: "hotel.lostFound.list",
  method: "GET",
  path: `${P}/lost-found`,
  auth: "user",
  summary: "Lost and found register",
  params: PropParams,
  response: z.object({ items: z.array(LostItem) }),
});

export const createLostFound = endpoint({
  id: "hotel.lostFound.create",
  method: "POST",
  path: `${P}/lost-found`,
  auth: "user",
  summary: "Record a found item",
  params: PropParams,
  body: z.object({
    roomId: Id.optional(),
    item: z.string().trim().min(2).max(200),
    photoRef: z.string().trim().max(300).optional(),
  }),
  response: LostItem,
  status: 201,
});

export const updateLostFound = endpoint({
  id: "hotel.lostFound.update",
  method: "POST",
  path: `${P}/lost-found/:itemId`,
  auth: "user",
  summary: "Record that the guest was contacted, or that the item was returned or disposed of",
  params: PropParams.extend({ itemId: Id }),
  body: z.object({ guestContacted: z.boolean().optional(), status: LostItem.shape.status.optional() }),
  response: LostItem,
});

// ------------------------------------------------------------------ cashier, night audit, income audit
export const listShifts = endpoint({
  id: "hotel.cashier.list",
  method: "GET",
  path: `${P}/cashier-shifts`,
  auth: "user",
  summary: "Cashier shifts with takings by method and over / short",
  params: PropParams,
  query: z.object({ status: z.enum(["open", "closed"]).optional() }),
  response: z.object({ shifts: z.array(CashierShift) }),
});

export const openShift = endpoint({
  id: "hotel.cashier.open",
  method: "POST",
  path: `${P}/cashier-shifts`,
  auth: "user",
  summary: "Open your cashier shift with the opening float (one open shift per person)",
  params: PropParams,
  body: z.object({ floatMinor: NonNegativeMinor }),
  response: CashierShift,
  status: 201,
});

export const closeShift = endpoint({
  id: "hotel.cashier.close",
  method: "POST",
  path: `${P}/cashier-shifts/:shiftId/close`,
  auth: "user",
  summary: "Close your shift with the counted cash; over / short is calculated and kept",
  params: PropParams.extend({ shiftId: Id }),
  body: z.object({ countedCashMinor: NonNegativeMinor }),
  response: CashierShift,
});

export const nightAuditCheck = endpoint({
  id: "hotel.nightAudit.check",
  method: "GET",
  path: `${P}/night-audit`,
  auth: "user",
  summary: "What would block tonight's audit, and the arrivals that would become no-shows",
  params: PropParams,
  response: z.object({
    businessDate: IsoDate,
    blocks: z.array(AuditBlock),
    pendingArrivals: z.array(z.string()),
    canRun: z.boolean(),
  }),
});

export const runNightAudit = endpoint({
  id: "hotel.nightAudit.run",
  method: "POST",
  path: `${P}/night-audit`,
  auth: "user",
  summary:
    "Close the business day: refused with the reasons while anything blocks it; otherwise posts room and tax, processes no-shows, releases group cut-offs, stores the daily report and rolls the business date",
  params: PropParams,
  body: z.object({ processNoShows: z.boolean().default(false) }),
  response: z.object({ closedDate: IsoDate, businessDate: IsoDate, report: DailyReport }),
});

export const getDailyReport = endpoint({
  id: "hotel.reports.daily",
  method: "GET",
  path: `${P}/daily-reports/:date`,
  auth: "user",
  summary: "The daily report the night audit stored for a business date",
  params: PropParams.extend({ date: IsoDate }),
  response: DailyReport,
});

export const getIncomeAudit = endpoint({
  id: "hotel.incomeAudit.get",
  method: "GET",
  path: `${P}/income-audit/:date`,
  auth: "user",
  summary: "Income audit of a closed day: rates below the rate plan and voids without approval",
  params: PropParams.extend({ date: IsoDate }),
  response: IncomeAudit,
});

export const signOffIncomeAudit = endpoint({
  id: "hotel.incomeAudit.signOff",
  method: "POST",
  path: `${P}/income-audit/:date/sign-off`,
  auth: "user",
  summary:
    "Sign off a closed day (income auditor; not the person who ran the night audit). Open findings must be acknowledged.",
  params: PropParams.extend({ date: IsoDate }),
  body: z.object({ note: z.string().trim().min(5).max(1000), acknowledgeFindings: z.boolean().default(false) }),
  response: IncomeAudit,
});

// ------------------------------------------------------------------ reports (all from the ledger postings)
export const kpis = endpoint({
  id: "hotel.reports.kpis",
  method: "GET",
  path: `${P}/reports/kpis`,
  auth: "user",
  summary: "Occupancy, ADR, RevPAR, TRevPAR, GOPPAR and cost per occupied room, from the ledger postings",
  params: PropParams,
  query: Range,
  response: Kpis,
});

export const flashReport = endpoint({
  id: "hotel.reports.flash",
  method: "GET",
  path: `${P}/reports/flash`,
  auth: "user",
  summary: "Daily flash: revenue by department, occupancy, ADR, RevPAR, cash taken and deposits",
  params: PropParams,
  query: z.object({ date: IsoDate }),
  response: z.object({
    date: IsoDate,
    currency: Currency,
    revenue: DeptAmounts,
    occupancyPct: z.number(),
    adrMinor: MinorUnits,
    revparMinor: MinorUnits,
    payments: ByMethod.extend({ total: MinorUnits }),
    depositsReceivedMinor: MinorUnits,
  }),
});

export const departmentalPnl = endpoint({
  id: "hotel.reports.pnl",
  method: "GET",
  path: `${P}/reports/pnl`,
  auth: "user",
  summary: "Departmental P&L (USALI-style, by the hotel's account mapping): departments, undistributed, GOP, GOPPAR",
  params: PropParams,
  query: Range,
  response: z.object({
    from: IsoDate,
    to: IsoDate,
    currency: Currency,
    departments: z.array(PnlDepartment),
    undistributed: z.object({
      costsMinor: MinorUnits,
      accounts: z.array(z.object({ code: AccountCode, name: z.string(), amountMinor: MinorUnits })),
    }),
    totalRevenueMinor: MinorUnits,
    gopMinor: MinorUnits,
    gopparMinor: MinorUnits,
    roomsAvailable: z.number().int(),
  }),
});

export const channelReport = endpoint({
  id: "hotel.reports.channels",
  method: "GET",
  path: `${P}/reports/channels`,
  auth: "user",
  summary: "Room revenue, commission and net revenue per channel (direct included)",
  params: PropParams,
  query: Range,
  response: z.object({
    channels: z.array(
      z.object({
        channelId: z.string().nullable(),
        name: z.string(),
        roomNights: z.number().int(),
        roomRevenueMinor: MinorUnits,
        commissionMinor: MinorUnits,
        netMinor: MinorUnits,
      }),
    ),
  }),
});

export const postCost = endpoint({
  id: "hotel.costs.post",
  method: "POST",
  path: `${P}/costs`,
  auth: "user",
  summary:
    "Post a departmental cost (rooms, F&B cost of sales, commissions, undistributed) to the ledger for this hotel",
  params: PropParams,
  body: z.object({
    account: AccountCode.refine((c) => /^[5-9]/.test(c), "Use an expense account (5–9…)"),
    amountMinor: PositiveMinorUnits,
    memo: z.string().trim().min(3).max(200),
    paidFrom: z.enum(["bank", "payable"]),
  }),
  response: z.object({ journalId: z.string(), date: IsoDate }),
  status: 201,
});

// ------------------------------------------------------------------ group (chains: two or more hotels)
export const groupAvailability = endpoint({
  id: "hotel.group.availability",
  method: "GET",
  path: `${Base}/group/availability`,
  auth: "user",
  summary: "Central reservations: rooms free for every night of a stay, across all the group's hotels",
  params: OrgParams,
  query: z.object({ from: IsoDate, to: IsoDate }).refine((r) => r.to > r.from, "Departure must be after arrival"),
  response: z.object({
    properties: z.array(
      z.object({
        propertyId: z.string(),
        name: z.string(),
        city: z.string(),
        roomTypes: z.array(
          z.object({ roomTypeId: z.string(), code: z.string(), name: z.string(), available: z.number().int() }),
        ),
        totalAvailable: z.number().int(),
      }),
    ),
  }),
});

export const groupKpis = endpoint({
  id: "hotel.group.kpis",
  method: "GET",
  path: `${Base}/group/kpis`,
  auth: "user",
  summary: "Consolidated KPIs and the owner / management-fee report per hotel",
  params: OrgParams,
  query: z
    .object({
      from: IsoDate,
      to: IsoDate,
      baseFeePct: z.coerce.number().min(0).max(100).default(0),
      incentiveFeePct: z.coerce.number().min(0).max(100).default(0),
    })
    .refine((r) => r.to >= r.from, "The end date is before the start date"),
  response: z.object({
    properties: z.array(
      z.object({
        propertyId: z.string(),
        name: z.string(),
        kpis: Kpis,
        baseFeeMinor: MinorUnits,
        incentiveFeeMinor: MinorUnits,
      }),
    ),
    consolidated: Kpis,
    feesMinor: MinorUnits,
  }),
});

// ------------------------------------------------------------------ integrations (boundaries; test adapters)
export const integrations = endpoint({
  id: "hotel.integrations",
  method: "GET",
  path: `${P}/integrations`,
  auth: "user",
  summary: "Which external systems are connected. Without a certified adapter each one is a labelled test adapter.",
  params: PropParams,
  response: z.object({
    adapters: z.array(
      IntegrationState.extend({
        kind: z.enum(["channel_manager", "door_locks", "room_controls", "messaging", "payments", "ai_concierge"]),
        note: z.string(),
      }),
    ),
  }),
});

export const ariQueue = endpoint({
  id: "hotel.channels.ariQueue",
  method: "GET",
  path: `${P}/channels/ari-queue`,
  auth: "user",
  summary: "Availability updates queued for the channel manager (nothing is transmitted without a connected adapter)",
  params: PropParams,
  query: z.object({ channelId: Id.optional() }),
  response: z.object({ messages: z.array(AriMessage) }),
});

export const channelBooking = endpoint({
  id: "hotel.channels.inboundBooking",
  method: "POST",
  path: "/api/v1/webhooks/hotel/channels/:provider",
  auth: "signed-webhook",
  summary:
    "A booking from a channel manager (signed). It takes the room from the one inventory at once; a repeat delivery is ignored.",
  params: z.object({ provider: z.string().min(1) }),
  body: z.object({
    orgId: Id,
    propertyId: Id,
    channelCode: Code,
    externalRef: z.string().trim().min(1).max(120),
    guest: GuestInput,
    roomTypeId: Id,
    ratePlanId: Id,
    arrival: IsoDate,
    departure: IsoDate,
    adults: z.number().int().min(1).max(20).default(1),
    children: z.number().int().min(0).max(20).default(0),
  }),
  response: z.object({ reservationId: z.string(), number: z.string(), duplicate: z.boolean() }),
});

export const listKeys = endpoint({
  id: "hotel.keys.list",
  method: "GET",
  path: `${P}/stays/:stayId/keys`,
  auth: "user",
  summary: "Mobile keys issued for a stay",
  params: StayParams,
  response: z.object({ keys: z.array(Key) }),
});

export const checkKey = endpoint({
  id: "hotel.keys.check",
  method: "POST",
  path: `${P}/keys/:keyId/check`,
  auth: "user",
  summary: "Ask the lock adapter whether a key opens a room on a date (test adapter until a lock system is connected)",
  params: PropParams.extend({ keyId: Id }),
  body: z.object({ roomId: Id, date: IsoDate }),
  response: z.object({ opens: z.boolean(), reason: z.string(), integration: IntegrationState }),
});

export const runEnergy = endpoint({
  id: "hotel.energy.run",
  method: "POST",
  path: `${P}/energy/run`,
  auth: "user",
  summary:
    "Energy rules for the business date: eco mode for vacant rooms with no arrival, welcome temperature for assigned arrivals",
  params: PropParams,
  response: z.object({ commands: z.array(RoomCommand) }),
});

export const listRoomCommands = endpoint({
  id: "hotel.roomControls.commands",
  method: "GET",
  path: `${P}/room-controls/commands`,
  auth: "user",
  summary: "Commands recorded for the room-control system",
  params: PropParams,
  response: z.object({ commands: z.array(RoomCommand) }),
});

export const askConcierge = endpoint({
  id: "hotel.concierge.ask",
  method: "POST",
  path: `${P}/concierge/ask`,
  auth: "user",
  summary:
    "Rule-based concierge: answers from the hotel's own FAQ, otherwise hands over to staff as a task (no external AI)",
  params: PropParams,
  body: z.object({
    question: z.string().trim().min(2).max(1000),
    reservationId: Id.optional(),
    channel: z.enum(["whatsapp", "sms", "email", "web"]).default("whatsapp"),
  }),
  response: z.object({
    answered: z.boolean(),
    answer: z.string(),
    handoffRequestId: z.string().nullable(),
  }),
});

export const listMessages = endpoint({
  id: "hotel.messages.list",
  method: "GET",
  path: `${P}/messages`,
  auth: "user",
  summary: "Guest messages recorded for a hotel (or one reservation)",
  params: PropParams,
  query: z.object({ reservationId: Id.optional() }),
  response: z.object({ messages: z.array(Message) }),
});

export const sendMessage = endpoint({
  id: "hotel.messages.send",
  method: "POST",
  path: `${P}/messages`,
  auth: "user",
  summary: "Record a message to a guest. It is recorded, not sent, until a messaging provider is connected.",
  params: PropParams,
  body: z.object({
    reservationId: Id,
    channel: z.enum(["whatsapp", "sms", "email"]),
    body: z.string().trim().min(1).max(2000),
  }),
  response: Message,
  status: 201,
});

// ------------------------------------------------------------------ record types (for the server and the client)
export type RoomTypeOut = z.infer<typeof RoomType>;
export type RoomOut = z.infer<typeof Room>;
export type ChannelOut = z.infer<typeof Channel>;
export type OutletOut = z.infer<typeof Outlet>;
export type GuestOut = z.infer<typeof Guest>;
export type CorporateAccountOut = z.infer<typeof CorporateAccount>;
export type GroupBlockOut = z.infer<typeof GroupBlock>;
export type FolioLineOut = z.infer<typeof FolioLine>;
export type RefundOut = z.infer<typeof Refund>;
export type KeyOut = z.infer<typeof Key>;
export type RoomBoardRowOut = z.infer<typeof RoomBoardRow>;
export type MaintenanceTicketOut = z.infer<typeof MaintenanceTicket>;
export type LostItemOut = z.infer<typeof LostItem>;
export type GuestRequestOut = z.infer<typeof GuestRequest>;
export type CashierShiftOut = z.infer<typeof CashierShift>;
export type AuditBlockOut = z.infer<typeof AuditBlock>;
export type IncomeAuditFindingOut = z.infer<typeof IncomeAuditFinding>;
export type IncomeAuditOut = z.infer<typeof IncomeAudit>;
export type PnlDepartmentOut = z.infer<typeof PnlDepartment>;
export type RoomCommandOut = z.infer<typeof RoomCommand>;
export type AriMessageOut = z.infer<typeof AriMessage>;
export type MessageOut = z.infer<typeof Message>;
export type IntegrationAdapterOut = z.infer<typeof integrations.response>["adapters"][number];
