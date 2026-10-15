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
  taxId: z.string().nullable(),
  billingAddress: z.string().nullable(),
  paymentTermsDays: z.number().int(),
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
export const FOLIO_LINE_KINDS = [
  "charge",
  "payment",
  "deposit",
  "transfer",
  "void",
  "refund",
  "city_ledger",
  /** a comp or discount given on a charge (with its taxes) */
  "allowance",
  /** loyalty points redeemed on the folio */
  "loyalty",
] as const;
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
  /** Allowances: comp or discount, the charge it reduces, and who approved it. */
  allowanceKind: z.enum(["comp", "discount"]).nullable(),
  allowanceOfLineId: z.string().nullable(),
  allowanceApprovedBy: z.string().nullable(),
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
  code: z.enum([
    "RATE_BELOW_PLAN",
    "VOID_WITHOUT_APPROVAL",
    /** a promo code or member rate below the rate plan */
    "DISCOUNT",
    /** a comp or discount on a charge (approved) */
    "ALLOWANCE",
    "ALLOWANCE_WITHOUT_APPROVAL",
    /** an outlet sale paid now outside any cashier shift */
    "OUTLET_TAKINGS_OUTSIDE_SHIFT",
    /** room nights charged differ from the rooms occupied */
    "ROOM_REVENUE_VS_OCCUPANCY",
  ]),
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
  /** Outlet takings of the day: paid now (inside / outside a cashier shift) and charged to rooms. */
  outletTakings: z.array(
    z.object({
      outletId: z.string(),
      name: z.string(),
      paidMinor: MinorUnits,
      inShiftMinor: MinorUnits,
      outsideShiftMinor: MinorUnits,
      roomChargesMinor: MinorUnits,
    }),
  ),
  /** Rooms occupied (in house that night) vs room nights charged. */
  occupancyCheck: z.object({ occupied: z.number().int(), charged: z.number().int() }),
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
  /** Automatic messages name their template; e-mails carry a subject and the recipient address or number. */
  template: z.string().nullable(),
  subject: z.string().nullable(),
  recipient: z.string().nullable(),
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
    taxId: z.string().trim().min(2).max(60).optional(),
    billingAddress: z.string().trim().min(2).max(500).optional(),
    paymentTermsDays: z.number().int().min(0).max(365).default(30),
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
        kind: z.enum([
          "channel_manager",
          "door_locks",
          "room_controls",
          "messaging",
          "payments",
          "ai_concierge",
          "e_invoicing",
          "kitchen_printers",
          "review_sites",
          "fx_rates",
          "rate_shopping",
          "payroll_engine",
          "sensors",
          "chain_loyalty",
        ]),
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

// ================================================================== extensions (migration 0011)
// Booking engine promo codes and upsells, attribute selling, loyalty, feedback, automatic messages, multi-currency,
// invoices, allowances (comps / discounts), collections, bank reconciliation, outlets (menus, orders, kitchen,
// tables), stock and purchasing, spa and activities, events, payroll inputs, budgets, fixed assets, FF&E, labour,
// revenue management, corporate sales and dashboards. Rules-based throughout: no external AI, no FX feed, nothing
// is sent or processed — messages are recorded, payments are recorded.

/** A quantity with at most three decimals (0.2 bottle, 1.5 kg). Stored as thousandths. */
const Qty = z
  .number()
  .positive()
  .max(1_000_000)
  .refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, "Use at most three decimals");
const NonNegativeQty = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, "Use at most three decimals");
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-10");
export const STAFF_DEPARTMENTS = ["rooms", "fnb", "spa", "other", "admin"] as const;
export const StaffDepartment = z.enum(STAFF_DEPARTMENTS);
export type StaffDepartment = z.infer<typeof StaffDepartment>;
const MethodNoCash = PaymentMethod.refine((m) => m !== "cash", "Cash is taken on a folio inside a cashier shift");
/** A payment taken now (recorded, not processed); a tip goes to the staff tips pool. */
const PaymentInput = z.object({
  method: PaymentMethod,
  amountMinor: PositiveMinorUnits,
  reference: z.string().trim().min(2).max(120),
  tipMinor: NonNegativeMinor.default(0),
});
/** How a sale is settled: charged to an in-house guest's room, or paid now (one or more payments = split). */
const Settlement = z
  .object({
    roomNumber: z.string().trim().min(1).max(20).optional(),
    payments: z.array(PaymentInput).max(6).default([]),
  })
  .refine((b) => !!b.roomNumber !== b.payments.length > 0, "Charge to a room, or record the payments — one of them");
const ByDepartment = z.object({ rooms: MinorUnits, fnb: MinorUnits, spa: MinorUnits, other: MinorUnits });

// ------------------------------------------------------------------ extension settings
export const ExtensionSettings = z.object({
  /** The night audit runs by itself at this local time (the PALTAS scheduler calls it); before noon it closes the previous day. */
  autoNightAudit: z.object({ enabled: z.boolean(), time: Time, processNoShows: z.boolean() }),
  /** Pre-arrival message this many days before arrival (0 = none). */
  preArrivalDays: z.number().int().min(0).max(30),
  /** Share of total revenue put into the FF&E replacement reserve each month. */
  ffeReservePct: Pct,
  /** Grams of CO₂ per kWh, entered by the hotel (no emissions data feed). */
  carbonGramsPerKwh: z.number().int().min(0).max(5000),
  /** Stay-over linen change every N nights (guests who opt into reuse: twice as long). */
  linenChangeNights: z.number().int().min(1).max(30),
  overtimeMultiplierPct: z.number().int().min(100).max(300),
  standardDayHours: z.number().int().min(1).max(24),
  /** The seller block printed on tax invoices. */
  invoice: z.object({
    legalName: z.string().trim().max(200),
    taxId: z.string().trim().max(60),
    address: z.string().trim().max(500),
  }),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettings>;

export const getExtensionSettings = endpoint({
  id: "hotel.settings.extensions",
  method: "GET",
  path: `${P}/settings/extensions`,
  auth: "user",
  summary: "Automation, finance and invoice settings of a hotel",
  params: PropParams,
  response: ExtensionSettings,
});

export const updateExtensionSettings = endpoint({
  id: "hotel.settings.extensionsUpdate",
  method: "PUT",
  path: `${P}/settings/extensions`,
  auth: "user",
  summary: "Change automation (automatic night audit time, pre-arrival days), finance and invoice settings",
  params: PropParams,
  body: ExtensionSettings.partial(),
  response: ExtensionSettings,
});

// ------------------------------------------------------------------ booking engine: promo codes, upsells, attributes
export const PromoCode = z.object({
  id: z.string(),
  code: z.string(),
  description: z.string(),
  discountPct: z.number(),
  stayFrom: IsoDate.nullable(),
  stayTo: IsoDate.nullable(),
  minNights: z.number().int(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  ratePlanIds: z.array(z.string()),
  active: z.boolean(),
});

export const listPromoCodes = endpoint({
  id: "hotel.promoCodes.list",
  method: "GET",
  path: `${P}/promo-codes`,
  auth: "user",
  summary: "Booking-engine promo codes",
  params: PropParams,
  response: z.object({ promoCodes: z.array(PromoCode) }),
});

export const createPromoCode = endpoint({
  id: "hotel.promoCodes.create",
  method: "POST",
  path: `${P}/promo-codes`,
  auth: "user",
  summary: "Add a promo code: a percentage off the nightly rate, for stay dates, plans and a number of uses",
  params: PropParams,
  body: z
    .object({
      code: Code,
      description: Text.default(""),
      discountPct: Pct.refine((n) => n > 0, "Give a discount above 0"),
      stayFrom: IsoDate.optional(),
      stayTo: IsoDate.optional(),
      minNights: z.number().int().min(1).max(60).default(1),
      maxUses: z.number().int().min(1).max(1_000_000).optional(),
      ratePlanIds: z.array(Id).max(50).default([]),
    })
    .refine((b) => !b.stayFrom || !b.stayTo || b.stayTo >= b.stayFrom, "The end date is before the start date"),
  response: PromoCode,
  status: 201,
});

export const updatePromoCode = endpoint({
  id: "hotel.promoCodes.update",
  method: "PUT",
  path: `${P}/promo-codes/:promoId`,
  auth: "user",
  summary: "Switch a promo code on or off, or change its description or use limit",
  params: PropParams.extend({ promoId: Id }),
  body: z.object({
    active: z.boolean().optional(),
    description: Text.optional(),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  }),
  response: PromoCode,
});

export const UPSELL_PRICING = ["per_stay", "per_night", "per_adult_night"] as const;
export const Upsell = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  department: ChargeDepartment,
  pricing: z.enum(UPSELL_PRICING),
  amountMinor: MinorUnits,
  active: z.boolean(),
});

export const listUpsells = endpoint({
  id: "hotel.upsells.list",
  method: "GET",
  path: `${P}/upsells`,
  auth: "user",
  summary: "Extras offered with a booking (breakfast, airport transfer, late check-out …)",
  params: PropParams,
  response: z.object({ upsells: z.array(Upsell) }),
});

export const saveUpsell = endpoint({
  id: "hotel.upsells.save",
  method: "POST",
  path: `${P}/upsells`,
  auth: "user",
  summary: "Add or change an extra by its code (priced per stay, per night or per adult per night)",
  params: PropParams,
  body: z.object({
    code: Code,
    name: Name,
    department: ChargeDepartment,
    pricing: z.enum(UPSELL_PRICING),
    amountMinor: PositiveMinorUnits,
    active: z.boolean().default(true),
  }),
  response: Upsell,
  status: 201,
});

export const AttributePrice = z.object({
  attribute: z.string(),
  name: z.string(),
  amountMinor: MinorUnits,
  rooms: z.number().int(),
});

export const listAttributePrices = endpoint({
  id: "hotel.attributes.list",
  method: "GET",
  path: `${P}/attribute-prices`,
  auth: "user",
  summary: "Room features sold for a price per night (attribute-based selling) and how many rooms have each",
  params: PropParams,
  response: z.object({ prices: z.array(AttributePrice) }),
});

export const setAttributePrices = endpoint({
  id: "hotel.attributes.set",
  method: "PUT",
  path: `${P}/attribute-prices`,
  auth: "user",
  summary: "Replace the prices of room features (the attribute must match the rooms' attributes, e.g. sea_view)",
  params: PropParams,
  body: z.object({
    prices: z
      .array(
        z.object({
          attribute: z.string().trim().min(1).max(40),
          name: z.string().trim().min(1).max(80),
          amountMinor: NonNegativeMinor,
        }),
      )
      .max(50),
  }),
  response: z.object({ prices: z.array(AttributePrice) }),
});

const BookingRoom = z.object({
  roomTypeId: Id,
  ratePlanId: Id,
  adults: z.number().int().min(1).max(20).default(1),
  children: z.number().int().min(0).max(20).default(0),
  /** Features the guest chooses (e.g. ["sea_view", "high_floor"]): a room with all of them is held for the stay. */
  attributes: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

const BookingFields = z.object({
  arrival: IsoDate,
  departure: IsoDate,
  rooms: z.array(BookingRoom).min(1).max(10),
  promoCode: z.string().trim().min(1).max(20).optional(),
  upsells: z
    .array(z.object({ upsellId: Id, quantity: z.number().int().min(1).max(20).default(1) }))
    .max(20)
    .default([]),
});

export const BookingQuote = z.object({
  nights: z.number().int(),
  discount: z.object({ kind: z.enum(["promo", "member"]), pct: z.number(), label: z.string() }).nullable(),
  rooms: z.array(
    z.object({
      roomTypeId: z.string(),
      ratePlanId: z.string(),
      nights: z.array(z.object({ date: IsoDate, planRateMinor: MinorUnits, rateMinor: MinorUnits })),
      attributesPerNightMinor: MinorUnits,
      totalMinor: MinorUnits,
    }),
  ),
  upsells: z.array(z.object({ upsellId: z.string(), name: z.string(), amountMinor: MinorUnits })),
  /** Before taxes; the hotel's tax engine adds VAT, service charge and levies on the folio. */
  totalBeforeTaxMinor: MinorUnits,
});

export const bookingQuote = endpoint({
  id: "hotel.bookingEngine.quote",
  method: "POST",
  path: `${P}/booking-engine/quote`,
  auth: "user",
  summary: "Price a direct booking: nightly rates, a promo code or member rate, room features and extras",
  params: PropParams,
  body: BookingFields.extend({ guest: GuestInput.optional() }).refine(
    (r) => r.departure > r.arrival,
    "Departure must be after arrival",
  ),
  response: BookingQuote,
});

export const bookDirect = endpoint({
  id: "hotel.bookingEngine.book",
  method: "POST",
  path: `${P}/booking-engine/bookings`,
  auth: "user",
  summary:
    "Direct booking (website / booking engine): takes the rooms from the one inventory, applies the promo code or member rate, holds a room with the chosen features and books the extras. A confirmation is recorded (not sent).",
  params: PropParams,
  body: BookingFields.extend({
    guest: GuestInput,
    source: z.enum(["booking_engine", "direct", "phone"]).default("booking_engine"),
    specialRequests: Text.default(""),
    arrivalTime: Time.optional(),
    linenReuse: z.boolean().default(false),
    marketingConsent: z.boolean().default(false),
    language: z
      .string()
      .regex(/^[a-z]{2}$/, "Use a two-letter language code")
      .optional(),
  }).refine((r) => r.departure > r.arrival, "Departure must be after arrival"),
  response: z.object({ reservation: Reservation, quote: BookingQuote }),
  status: 201,
});

// ------------------------------------------------------------------ loyalty (one programme per organisation)
export const LoyaltyTier = z.object({
  code: Code,
  name: Name,
  /** Reached with this many stays OR this many lifetime points (whichever comes first). */
  minStays: z.number().int().min(0).max(1000),
  minPoints: z.number().int().min(0).max(100_000_000),
  /** Member rate: this percentage off the nightly rate at booking. */
  discountPct: Pct,
  /** Extra points earned, e.g. 25 = 25 % more. */
  earnBonusPct: z.number().int().min(0).max(500),
});

export const LoyaltyProgramme = z.object({
  name: Name,
  /** Room revenue (minor units, before tax) that earns one point. */
  minorPerPoint: PositiveMinorUnits,
  /** What one point is worth when redeemed (minor units). */
  pointValueMinor: PositiveMinorUnits,
  tiers: z
    .array(LoyaltyTier)
    .min(1)
    .max(10)
    .refine(
      (t) => t[0]?.minStays === 0 && t[0]?.minPoints === 0,
      "The first tier is the entry tier (0 stays, 0 points)",
    ),
});

export const LoyaltyMember = z.object({
  id: z.string(),
  number: z.string(),
  guestId: z.string(),
  guestName: z.string(),
  tier: z.string(),
  points: z.number().int(),
  lifetimePoints: z.number().int(),
  stays: z.number().int(),
  joinedOn: IsoDate,
  /** Points held for redemptions not yet applied to a folio. */
  pendingPoints: z.number().int(),
});

export const LoyaltyEntry = z.object({
  id: z.string(),
  kind: z.enum(["earn", "redeem", "adjust", "reverse"]),
  points: z.number().int(),
  valueMinor: MinorUnits,
  propertyId: z.string(),
  reservationId: z.string().nullable(),
  status: z.enum(["pending", "done", "reversed"]),
  note: z.string(),
  at: IsoDateTime,
});

export const getLoyaltyProgramme = endpoint({
  id: "hotel.loyalty.programme",
  method: "GET",
  path: `${Base}/loyalty`,
  auth: "user",
  summary: "The organisation's own loyalty programme (points, tiers, member rates); null until set up",
  params: OrgParams,
  response: z.object({ programme: LoyaltyProgramme.nullable(), chainConnection: IntegrationState }),
});

export const setLoyaltyProgramme = endpoint({
  id: "hotel.loyalty.setProgramme",
  method: "PUT",
  path: `${Base}/loyalty`,
  auth: "user",
  summary: "Set up or change the programme. The point value cannot change while points are outstanding.",
  params: OrgParams,
  body: LoyaltyProgramme,
  response: z.object({ programme: LoyaltyProgramme.nullable(), chainConnection: IntegrationState }),
});

export const listLoyaltyMembers = endpoint({
  id: "hotel.loyalty.members",
  method: "GET",
  path: `${Base}/loyalty/members`,
  auth: "user",
  summary: "Loyalty members with points, tier and stays",
  params: OrgParams,
  query: z.object({ q: z.string().trim().min(2).max(120).optional() }),
  response: z.object({ members: z.array(LoyaltyMember) }),
});

export const enrolLoyaltyMember = endpoint({
  id: "hotel.loyalty.enrol",
  method: "POST",
  path: `${Base}/loyalty/members`,
  auth: "user",
  summary: "Enrol a guest profile in the programme (entry tier)",
  params: OrgParams,
  body: z.object({ guestId: Id }),
  response: LoyaltyMember,
  status: 201,
});

export const getLoyaltyMember = endpoint({
  id: "hotel.loyalty.member",
  method: "GET",
  path: `${Base}/loyalty/members/:memberId`,
  auth: "user",
  summary: "One member with every points movement",
  params: OrgParams.extend({ memberId: Id }),
  response: z.object({ member: LoyaltyMember, entries: z.array(LoyaltyEntry) }),
});

export const redeemPoints = endpoint({
  id: "hotel.loyalty.redeem",
  method: "POST",
  path: `${P}/reservations/:reservationId/loyalty-redemption`,
  auth: "user",
  summary:
    "Redeem points against a booking: the points are taken now and credited on the guest folio (at check-in, or at once if the guest is in house). Posts loyalty liability 2400 → guest ledger 1150.",
  params: PropParams.extend({ reservationId: Id }),
  body: z.object({ points: z.number().int().min(1).max(10_000_000) }),
  response: z.object({ member: LoyaltyMember, entry: LoyaltyEntry }),
  status: 201,
});

export const adjustPoints = endpoint({
  id: "hotel.loyalty.adjust",
  method: "POST",
  path: `${Base}/loyalty/members/:memberId/adjust`,
  auth: "user",
  summary: "Correct a member's points (approvers only; reason kept). Posts the liability change at the point value.",
  params: OrgParams.extend({ memberId: Id }),
  body: z.object({
    propertyId: Id,
    points: z
      .number()
      .int()
      .min(-10_000_000)
      .max(10_000_000)
      .refine((n) => n !== 0, "Give a change other than 0"),
    reason: Reason,
  }),
  response: z.object({ member: LoyaltyMember, entry: LoyaltyEntry }),
  status: 201,
});

// ------------------------------------------------------------------ guest feedback (internal surveys)
const FEEDBACK_CATEGORIES = ["cleanliness", "service", "food", "comfort", "value", "location"] as const;
export const Feedback = z.object({
  id: z.string(),
  reservationId: z.string(),
  guestId: z.string(),
  guestName: z.string(),
  score: z.number().int(),
  categories: z.record(z.string(), z.number().int()),
  comment: z.string(),
  source: z.enum(["survey", "staff", "email", "other"]),
  date: IsoDate,
  /** A low score (1–2) raises a task for the manager. */
  alertRequestId: z.string().nullable(),
});

export const recordFeedback = endpoint({
  id: "hotel.feedback.record",
  method: "POST",
  path: `${P}/feedback`,
  auth: "user",
  summary: "Record a guest's post-stay survey (one per reservation). A score of 1–2 alerts the manager.",
  params: PropParams,
  body: z.object({
    reservationId: Id,
    score: z.number().int().min(1).max(5),
    categories: z.partialRecord(z.enum(FEEDBACK_CATEGORIES), z.number().int().min(1).max(5)).default({}),
    comment: Text.default(""),
    source: z.enum(["survey", "staff", "email", "other"]).default("survey"),
  }),
  response: Feedback,
  status: 201,
});

export const listFeedback = endpoint({
  id: "hotel.feedback.list",
  method: "GET",
  path: `${P}/feedback`,
  auth: "user",
  summary: "Guest feedback recorded for a hotel",
  params: PropParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: z.object({ feedback: z.array(Feedback) }),
});

export const feedbackReport = endpoint({
  id: "hotel.reports.feedback",
  method: "GET",
  path: `${P}/reports/feedback`,
  auth: "user",
  summary:
    "Guest satisfaction and review trends: average score by month and category, low scores, recurring words (rule-based, no AI)",
  params: PropParams,
  query: Range,
  response: z.object({
    responses: z.number().int(),
    averageScore: z.number(),
    lowScores: z.number().int(),
    months: z.array(
      z.object({
        month: z.string(),
        responses: z.number().int(),
        averageScore: z.number(),
        lowScores: z.number().int(),
      }),
    ),
    categories: z.array(z.object({ category: z.string(), averageScore: z.number(), responses: z.number().int() })),
    themes: z.array(z.object({ word: z.string(), mentions: z.number().int(), averageScore: z.number() })),
    method: z.string(),
    reviewInvitations: IntegrationState,
  }),
});

// ------------------------------------------------------------------ messages: templates and automation
export const MESSAGE_TEMPLATES = [
  "confirmation",
  "pre_arrival",
  "post_stay_survey",
  "invoice",
  "low_score_alert",
  "daily_report",
  "audit_blocked",
  "statement",
] as const;
export const MessageTemplateKey = z.enum(MESSAGE_TEMPLATES);
export const MessageTemplate = z.object({
  template: MessageTemplateKey,
  language: z.string(),
  subject: z.string(),
  body: z.string(),
  /** false = the built-in wording, until the hotel writes its own */
  custom: z.boolean(),
});

export const listMessageTemplates = endpoint({
  id: "hotel.templates.list",
  method: "GET",
  path: `${P}/message-templates`,
  auth: "user",
  summary: "Message templates per language ({guest}, {hotel}, {number}, {arrival}, {departure} … are filled in)",
  params: PropParams,
  response: z.object({ templates: z.array(MessageTemplate) }),
});

export const setMessageTemplate = endpoint({
  id: "hotel.templates.set",
  method: "PUT",
  path: `${P}/message-templates/:template`,
  auth: "user",
  summary: "Write the hotel's own wording of a message in a language",
  params: PropParams.extend({ template: MessageTemplateKey }),
  body: z.object({
    language: z
      .string()
      .regex(/^[a-z]{2}$/, "Use a two-letter language code")
      .default("en"),
    subject: z.string().trim().min(2).max(200),
    body: z.string().trim().min(2).max(4000),
  }),
  response: MessageTemplate,
});

export const runAutomation = endpoint({
  id: "hotel.automation.run",
  method: "POST",
  path: `${P}/automation/run`,
  auth: "user",
  summary:
    "Record what is due today: pre-arrival messages and preventive maintenance tickets (the scheduler does this daily too)",
  params: PropParams,
  response: z.object({
    preArrival: z.number().int(),
    preventiveTickets: z.number().int(),
    messaging: IntegrationState,
  }),
});

// ------------------------------------------------------------------ multi-currency (day's rate entered by staff)
export const FxRate = z.object({
  date: IsoDate,
  currency: Currency,
  rate: z.number(),
  enteredBy: z.string().nullable(),
});

export const listFxRates = endpoint({
  id: "hotel.fx.list",
  method: "GET",
  path: `${P}/fx-rates`,
  auth: "user",
  summary: "Exchange rates entered for a date (default: the business date)",
  params: PropParams,
  query: z.object({ date: IsoDate.optional() }),
  response: z.object({ hotelCurrency: Currency, date: IsoDate, rates: z.array(FxRate), feed: IntegrationState }),
});

export const setFxRates = endpoint({
  id: "hotel.fx.set",
  method: "PUT",
  path: `${P}/fx-rates/:date`,
  auth: "user",
  summary: "Enter the day's rates: hotel currency per 1 unit of each foreign currency (no FX provider)",
  params: PropParams.extend({ date: IsoDate }),
  body: z.object({
    rates: z
      .array(
        z.object({
          currency: Currency,
          rate: z
            .number()
            .positive()
            .max(1_000_000)
            .refine((n) => Math.abs(Math.round(n * 1e6) - n * 1e6) < 1e-3, "Use at most six decimals"),
        }),
      )
      .min(1)
      .max(50),
  }),
  response: z.object({ hotelCurrency: Currency, date: IsoDate, rates: z.array(FxRate), feed: IntegrationState }),
});

export const folioInCurrency = endpoint({
  id: "hotel.fx.folio",
  method: "GET",
  path: `${P}/folios/:folioId/fx`,
  auth: "user",
  summary: "A folio's balance shown in another currency at the business date's rate",
  params: FolioParams,
  query: z.object({ currency: Currency }),
  response: z.object({
    currency: Currency,
    rate: z.number(),
    rateDate: IsoDate,
    balanceMinor: MinorUnits,
    balanceForeignMinor: MinorUnits,
  }),
});

export const recordFxPayment = endpoint({
  id: "hotel.fx.payment",
  method: "POST",
  path: `${P}/folios/:folioId/fx-payments`,
  auth: "user",
  summary:
    "Record a payment in a foreign currency, converted at the business date's rate (recorded, not processed; cash needs your shift)",
  params: FolioParams,
  body: z.object({
    currency: Currency,
    foreignAmountMinor: PositiveMinorUnits,
    method: PaymentMethod,
    reference: z.string().trim().min(2).max(120),
  }),
  response: z.object({
    folio: Folio,
    fx: z.object({
      currency: Currency,
      foreignAmountMinor: MinorUnits,
      rate: z.number(),
      localAmountMinor: MinorUnits,
    }),
  }),
  status: 201,
});

// ------------------------------------------------------------------ allowances: comps and discounts on a charge
export const postAllowance = endpoint({
  id: "hotel.folios.allowance",
  method: "POST",
  path: `${P}/folios/:folioId/lines/:lineId/allowance`,
  auth: "user",
  summary:
    "Comp or discount a charge (all or part of its net, with its taxes). Posts at once; someone else approves it; the income audit lists it.",
  params: LineParams,
  body: z.object({ kind: z.enum(["comp", "discount"]), amountMinor: PositiveMinorUnits.optional(), reason: Reason }),
  response: Folio,
  status: 201,
});

export const approveAllowance = endpoint({
  id: "hotel.folios.approveAllowance",
  method: "POST",
  path: `${P}/folios/:folioId/allowances/:allowanceId/approve`,
  auth: "user",
  summary: "Approve a comp or discount made by someone else",
  params: FolioParams.extend({ allowanceId: Id }),
  response: Folio,
});

// ------------------------------------------------------------------ tax invoices, credit notes, e-invoicing boundary
export const InvoiceLine = z.object({
  date: IsoDate,
  description: z.string(),
  department: z.string().nullable(),
  netMinor: MinorUnits,
  serviceChargeMinor: MinorUnits,
  vatMinor: MinorUnits,
  levyMinor: MinorUnits,
  totalMinor: MinorUnits,
});

export const Invoice = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(["invoice", "credit_note"]),
  folioId: z.string(),
  corporateAccountId: z.string().nullable(),
  issuedOn: IsoDate,
  currency: Currency,
  seller: z.object({ name: z.string(), taxId: z.string(), address: z.string() }),
  buyer: z.object({
    name: z.string(),
    taxId: z.string().nullable(),
    address: z.string().nullable(),
    email: z.string().nullable(),
  }),
  lines: z.array(InvoiceLine),
  totals: z.object({
    netMinor: MinorUnits,
    serviceChargeMinor: MinorUnits,
    vatMinor: MinorUnits,
    levyMinor: MinorUnits,
    totalMinor: MinorUnits,
  }),
  settlements: z.array(z.object({ date: IsoDate, description: z.string(), amountMinor: MinorUnits })),
  creditsInvoiceId: z.string().nullable(),
  cancelledById: z.string().nullable(),
  einvoicing: IntegrationState.extend({ reference: z.string().nullable() }),
});

export const issueInvoice = endpoint({
  id: "hotel.invoices.issue",
  method: "POST",
  path: `${P}/folios/:folioId/invoice`,
  auth: "user",
  summary:
    "Issue the tax invoice of a settled folio (company invoice for a company folio) with the next sequential number",
  params: FolioParams,
  body: z.object({
    buyer: z
      .object({
        name: Name.optional(),
        taxId: z.string().trim().min(2).max(60).optional(),
        address: z.string().trim().min(2).max(500).optional(),
        email: Email.optional(),
      })
      .default({}),
  }),
  response: Invoice,
  status: 201,
});

export const listInvoices = endpoint({
  id: "hotel.invoices.list",
  method: "GET",
  path: `${P}/invoices`,
  auth: "user",
  summary: "Invoices and credit notes of a hotel",
  params: PropParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: z.object({ invoices: z.array(Invoice) }),
});

const InvoiceParams = PropParams.extend({ invoiceId: Id });

export const getInvoice = endpoint({
  id: "hotel.invoices.get",
  method: "GET",
  path: `${P}/invoices/:invoiceId`,
  auth: "user",
  summary: "One invoice or credit note (an issued document never changes)",
  params: InvoiceParams,
  response: Invoice,
});

export const creditNote = endpoint({
  id: "hotel.invoices.creditNote",
  method: "POST",
  path: `${P}/invoices/:invoiceId/credit-note`,
  auth: "user",
  summary:
    "Cancel an invoice document with a credit note (someone other than its issuer), so the folio can be invoiced again. Money corrections are voids, allowances and refunds.",
  params: InvoiceParams,
  body: z.object({ reason: Reason }),
  response: Invoice,
  status: 201,
});

export const emailInvoice = endpoint({
  id: "hotel.invoices.email",
  method: "POST",
  path: `${P}/invoices/:invoiceId/email`,
  auth: "user",
  summary: "Record the invoice e-mail to the buyer in the outbox (recorded, not sent — no e-mail provider connected)",
  params: InvoiceParams,
  body: z.object({ recipient: Email.optional() }),
  response: z.object({ message: Message }),
  status: 201,
});

export const submitEInvoice = endpoint({
  id: "hotel.invoices.eInvoice",
  method: "POST",
  path: `${P}/invoices/:invoiceId/e-invoice`,
  auth: "user",
  summary: "Submit to the tax authority's e-invoicing system (BLOCKED: test adapter until a certified one exists)",
  params: InvoiceParams,
  response: Invoice,
});

// ------------------------------------------------------------------ city-ledger collections
export const CollectionAction = z.object({
  id: z.string(),
  accountId: z.string(),
  kind: z.enum(["reminder", "call", "promise", "note", "statement_sent"]),
  note: z.string(),
  promisedDate: IsoDate.nullable(),
  promisedMinor: MinorUnits.nullable(),
  nextActionDate: IsoDate.nullable(),
  messageId: z.string().nullable(),
  createdBy: z.string().nullable(),
  at: IsoDateTime,
});

export const listCollections = endpoint({
  id: "hotel.collections.list",
  method: "GET",
  path: `${Base}/corporate-accounts/:accountId/collections`,
  auth: "user",
  summary: "Collection actions on a company account",
  params: OrgParams.extend({ accountId: Id }),
  response: z.object({ actions: z.array(CollectionAction) }),
});

export const recordCollection = endpoint({
  id: "hotel.collections.record",
  method: "POST",
  path: `${Base}/corporate-accounts/:accountId/collections`,
  auth: "user",
  summary:
    "Record a collection action (reminder, call, promise to pay, note) or send a statement (recorded in the outbox, not sent)",
  params: OrgParams.extend({ accountId: Id }),
  body: z
    .object({
      kind: z.enum(["reminder", "call", "promise", "note", "statement_sent"]),
      note: z.string().trim().min(2).max(1000),
      promisedDate: IsoDate.optional(),
      promisedMinor: PositiveMinorUnits.optional(),
      nextActionDate: IsoDate.optional(),
      propertyId: Id.optional(),
    })
    .refine((b) => b.kind !== "promise" || (b.promisedDate && b.promisedMinor), "A promise has a date and an amount")
    .refine(
      (b) => !["reminder", "statement_sent"].includes(b.kind) || b.propertyId,
      "Name the hotel the reminder or statement is sent from",
    ),
  response: CollectionAction,
  status: 201,
});

export const collectionsDue = endpoint({
  id: "hotel.collections.due",
  method: "GET",
  path: `${Base}/collections`,
  auth: "user",
  summary: "Company accounts with overdue balances (past their payment terms) and the next action due",
  params: OrgParams,
  response: z.object({
    accounts: z.array(
      z.object({
        accountId: z.string(),
        name: z.string(),
        balanceMinor: MinorUnits,
        overdueMinor: MinorUnits,
        paymentTermsDays: z.number().int(),
        lastAction: CollectionAction.nullable(),
        nextActionDate: IsoDate.nullable(),
      }),
    ),
  }),
});

// ------------------------------------------------------------------ card and payment reconciliation to the bank
export const BankLine = z.object({
  id: z.string(),
  date: IsoDate,
  amountMinor: MinorUnits,
  reference: z.string(),
  description: z.string(),
  status: z.enum(["unmatched", "matched", "chargeback"]),
  feeMinor: MinorUnits,
  matches: z.array(z.object({ source: z.string(), amountMinor: MinorUnits })),
});

export const RecordedPayment = z.object({
  source: z.string(),
  date: IsoDate,
  kind: z.enum(["folio_payment", "deposit", "company_payment", "event_deposit", "tip"]),
  method: PaymentMethod,
  amountMinor: MinorUnits,
  reference: z.string(),
  matched: z.boolean(),
});

export const importBankLines = endpoint({
  id: "hotel.bank.import",
  method: "POST",
  path: `${P}/bank/imports`,
  auth: "user",
  summary:
    "Import bank statement lines (from the hotel's bank export). Lines with the same amount and reference as a recorded payment are matched at once.",
  params: PropParams,
  body: z.object({
    statementRef: z.string().trim().min(2).max(80),
    lines: z
      .array(
        z.object({
          date: IsoDate,
          amountMinor: MinorUnits.refine((n) => n !== 0, "A bank line has an amount"),
          reference: z.string().trim().min(1).max(120),
          description: z.string().trim().max(300).default(""),
        }),
      )
      .min(1)
      .max(2000),
  }),
  response: z.object({ importId: z.string(), lines: z.array(BankLine), autoMatched: z.number().int() }),
  status: 201,
});

export const listBankLines = endpoint({
  id: "hotel.bank.lines",
  method: "GET",
  path: `${P}/bank/lines`,
  auth: "user",
  summary: "Imported bank lines and what each is matched to",
  params: PropParams,
  query: z.object({ status: z.enum(["unmatched", "matched", "chargeback"]).optional() }),
  response: z.object({ lines: z.array(BankLine) }),
});

export const recordedPayments = endpoint({
  id: "hotel.bank.payments",
  method: "GET",
  path: `${P}/bank/payments`,
  auth: "user",
  summary: "Payments recorded at the hotel (folio payments, deposits, company payments, event deposits, tips)",
  params: PropParams,
  query: z.object({ from: IsoDate, to: IsoDate, unmatchedOnly: z.stringbool().default(false) }),
  response: z.object({ payments: z.array(RecordedPayment) }),
});

export const matchBankLine = endpoint({
  id: "hotel.bank.match",
  method: "POST",
  path: `${P}/bank/lines/:bankLineId/match`,
  auth: "user",
  summary:
    "Match a bank line to recorded payments: the payments less the card / provider fee must equal the line. The fee posts bank charges 5300 / bank 1000.",
  params: PropParams.extend({ bankLineId: Id }),
  body: z.object({
    sources: z.array(z.string().min(3).max(120)).min(1).max(500),
    feeMinor: NonNegativeMinor.default(0),
  }),
  response: BankLine,
});

export const recordChargeback = endpoint({
  id: "hotel.bank.chargeback",
  method: "POST",
  path: `${P}/bank/lines/:bankLineId/chargeback`,
  auth: "user",
  summary:
    "A negative bank line that reverses a guest's card payment: the money is owed again (receivables 1100 / bank 1000)",
  params: PropParams.extend({ bankLineId: Id }),
  body: z.object({ source: z.string().min(3).max(120), reason: Reason }),
  response: BankLine,
});

export const reconciliationSummary = endpoint({
  id: "hotel.bank.summary",
  method: "GET",
  path: `${P}/bank/summary`,
  auth: "user",
  summary: "Recorded payments vs the bank for a period: matched, unmatched, fees and chargebacks, by method",
  params: PropParams,
  query: Range,
  response: z.object({
    recordedMinor: MinorUnits,
    matchedMinor: MinorUnits,
    unmatchedMinor: MinorUnits,
    bankLinesMinor: MinorUnits,
    unmatchedBankMinor: MinorUnits,
    feesMinor: MinorUnits,
    chargebacksMinor: MinorUnits,
    byMethod: z.array(
      z.object({
        method: PaymentMethod,
        recordedMinor: MinorUnits,
        matchedMinor: MinorUnits,
        unmatchedMinor: MinorUnits,
      }),
    ),
  }),
});

// ------------------------------------------------------------------ outlets: menus, orders, kitchen screen, tables
export const MenuModifier = z.object({ code: Code, name: Name, priceMinor: NonNegativeMinor });
export const MenuItem = z.object({
  id: z.string(),
  outletId: z.string(),
  code: z.string(),
  name: z.string(),
  category: z.string(),
  priceMinor: MinorUnits,
  modifiers: z.array(MenuModifier),
  active: z.boolean(),
  recipe: z.array(z.object({ stockItemId: z.string(), name: z.string(), quantity: z.number() })),
  /** Ingredient cost at today's average stock cost, and its share of the price. */
  recipeCostMinor: MinorUnits,
  costPct: z.number(),
});

export const listMenu = endpoint({
  id: "hotel.menu.list",
  method: "GET",
  path: `${P}/outlets/:outletId/menu`,
  auth: "user",
  summary: "An outlet's menu with modifiers, recipes and food cost",
  params: PropParams.extend({ outletId: Id }),
  response: z.object({ items: z.array(MenuItem) }),
});

export const saveMenuItem = endpoint({
  id: "hotel.menu.save",
  method: "POST",
  path: `${P}/outlets/:outletId/menu`,
  auth: "user",
  summary: "Add or change a menu item by its code (price, category, modifiers, on sale or not)",
  params: PropParams.extend({ outletId: Id }),
  body: z.object({
    code: Code,
    name: Name,
    category: z.string().trim().max(60).default(""),
    priceMinor: PositiveMinorUnits,
    modifiers: z.array(MenuModifier).max(30).default([]),
    active: z.boolean().default(true),
  }),
  response: MenuItem,
  status: 201,
});

export const setRecipe = endpoint({
  id: "hotel.menu.recipe",
  method: "PUT",
  path: `${P}/menu-items/:itemId/recipe`,
  auth: "user",
  summary: "Replace a menu item's recipe: stock used per portion (deducted from stock on every sale)",
  params: PropParams.extend({ itemId: Id }),
  body: z.object({ lines: z.array(z.object({ stockItemId: Id, quantity: Qty })).max(40) }),
  response: MenuItem,
});

export const setOutletSeating = endpoint({
  id: "hotel.outlets.seating",
  method: "PUT",
  path: `${P}/outlets/:outletId/seating`,
  auth: "user",
  summary: "Seats and table time of a restaurant (table bookings are refused beyond the seats)",
  params: PropParams.extend({ outletId: Id }),
  body: z.object({ seats: z.number().int().min(0).max(5000), slotMinutes: z.number().int().min(15).max(480) }),
  response: z.object({ outletId: z.string(), seats: z.number().int(), slotMinutes: z.number().int() }),
});

const OrderLineInput = z.object({
  menuItemId: Id,
  quantity: z.number().int().min(1).max(100),
  modifiers: z.array(Code).max(10).default([]),
  note: z.string().trim().max(200).default(""),
});

export const PosOrder = z.object({
  id: z.string(),
  number: z.string(),
  outletId: z.string(),
  tableNo: z.string().nullable(),
  covers: z.number().int(),
  status: z.enum(["open", "settled", "cancelled"]),
  lines: z.array(
    z.object({
      id: z.string(),
      menuItemId: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      modifiers: z.array(z.string()),
      unitMinor: MinorUnits,
      netMinor: MinorUnits,
      note: z.string(),
    }),
  ),
  netMinor: MinorUnits,
  /** With the hotel's taxes, as the folio will charge it: pay exactly this. */
  totalMinor: MinorUnits,
  settledMode: z.enum(["room", "paid"]).nullable(),
  folioId: z.string().nullable(),
  tipsMinor: MinorUnits,
});

export const createPosOrder = endpoint({
  id: "hotel.pos.create",
  method: "POST",
  path: `${P}/outlets/:outletId/orders`,
  auth: "user",
  summary: "Open an order at a table; it goes to the kitchen screen at once (outlet staff: their own outlet only)",
  params: PropParams.extend({ outletId: Id }),
  body: z.object({
    tableNo: z.string().trim().min(1).max(20).optional(),
    covers: z.number().int().min(1).max(500).default(1),
    lines: z.array(OrderLineInput).min(1).max(100),
  }),
  response: PosOrder,
  status: 201,
});

export const addPosLines = endpoint({
  id: "hotel.pos.add",
  method: "POST",
  path: `${P}/pos-orders/:orderId/lines`,
  auth: "user",
  summary: "Add items to an open order (a new kitchen ticket for them)",
  params: PropParams.extend({ orderId: Id }),
  body: z.object({ lines: z.array(OrderLineInput).min(1).max(100) }),
  response: PosOrder,
});

export const listPosOrders = endpoint({
  id: "hotel.pos.list",
  method: "GET",
  path: `${P}/outlets/:outletId/orders`,
  auth: "user",
  summary: "An outlet's orders",
  params: PropParams.extend({ outletId: Id }),
  query: z.object({ status: z.enum(["open", "settled", "cancelled"]).optional() }),
  response: z.object({ orders: z.array(PosOrder) }),
});

export const settlePosOrder = endpoint({
  id: "hotel.pos.settle",
  method: "POST",
  path: `${P}/pos-orders/:orderId/settle`,
  auth: "user",
  summary:
    "Settle an order: charge it to an in-house guest's room (refused if their folio is blocked) or record payment now — split across several payments if needed. Stock is deducted by recipe; cost of sales posts.",
  params: PropParams.extend({ orderId: Id }),
  body: Settlement,
  response: PosOrder,
});

export const cancelPosOrder = endpoint({
  id: "hotel.pos.cancel",
  method: "POST",
  path: `${P}/pos-orders/:orderId/cancel`,
  auth: "user",
  summary: "Cancel an open order (nothing was charged); its kitchen tickets are cancelled",
  params: PropParams.extend({ orderId: Id }),
  body: z.object({ reason: Reason }),
  response: PosOrder,
});

export const KitchenTicket = z.object({
  id: z.string(),
  number: z.string(),
  outletId: z.string(),
  orderId: z.string(),
  tableNo: z.string().nullable(),
  items: z.array(
    z.object({ name: z.string(), quantity: z.number().int(), modifiers: z.array(z.string()), note: z.string() }),
  ),
  status: z.enum(["new", "preparing", "ready", "served", "cancelled"]),
  printer: IntegrationState,
  at: IsoDateTime,
});

export const kitchenScreen = endpoint({
  id: "hotel.kitchen.list",
  method: "GET",
  path: `${P}/outlets/:outletId/kitchen`,
  auth: "user",
  summary: "The kitchen screen: tickets by status (kitchen printers: test adapter — on-screen only)",
  params: PropParams.extend({ outletId: Id }),
  query: z.object({ status: z.enum(["new", "preparing", "ready", "served", "cancelled"]).optional() }),
  response: z.object({ tickets: z.array(KitchenTicket) }),
});

export const updateKitchenTicket = endpoint({
  id: "hotel.kitchen.update",
  method: "POST",
  path: `${P}/kitchen-tickets/:ticketId`,
  auth: "user",
  summary: "Move a kitchen ticket on: preparing → ready → served",
  params: PropParams.extend({ ticketId: Id }),
  body: z.object({ status: z.enum(["preparing", "ready", "served"]) }),
  response: KitchenTicket,
});

export const TableBooking = z.object({
  id: z.string(),
  outletId: z.string(),
  name: z.string(),
  stayId: z.string().nullable(),
  roomNumber: z.string().nullable(),
  date: IsoDate,
  time: z.string(),
  covers: z.number().int(),
  source: z.enum(["phone", "website", "in_house", "walk_in", "booking_engine"]),
  status: z.enum(["booked", "seated", "completed", "cancelled", "no_show"]),
  notes: z.string(),
});

export const listTableBookings = endpoint({
  id: "hotel.tables.list",
  method: "GET",
  path: `${P}/table-bookings`,
  auth: "user",
  summary: "Restaurant bookings for a day (or every outlet)",
  params: PropParams,
  query: z.object({ date: IsoDate.optional(), outletId: Id.optional() }),
  response: z.object({ bookings: z.array(TableBooking) }),
});

export const createTableBooking = endpoint({
  id: "hotel.tables.create",
  method: "POST",
  path: `${P}/table-bookings`,
  auth: "user",
  summary:
    "Book a table for a guest, a website visitor or an in-house guest (by room). Refused when the restaurant's seats are taken for that time.",
  params: PropParams,
  body: z.object({
    outletId: Id,
    name: Name,
    roomNumber: z.string().trim().min(1).max(20).optional(),
    date: IsoDate,
    time: Time,
    covers: z.number().int().min(1).max(200),
    source: z.enum(["phone", "website", "in_house", "walk_in", "booking_engine"]).default("phone"),
    notes: z.string().trim().max(500).default(""),
  }),
  response: TableBooking,
  status: 201,
});

export const updateTableBooking = endpoint({
  id: "hotel.tables.update",
  method: "POST",
  path: `${P}/table-bookings/:bookingId`,
  auth: "user",
  summary: "Seat, complete, cancel or mark a table booking as a no-show",
  params: PropParams.extend({ bookingId: Id }),
  body: z.object({ status: z.enum(["seated", "completed", "cancelled", "no_show"]) }),
  response: TableBooking,
});

// ------------------------------------------------------------------ stock, purchasing and three-way match
export const STOCK_CATEGORIES = ["food", "beverage", "linen", "amenity", "cleaning", "other"] as const;
export const StockCategory = z.enum(STOCK_CATEGORIES);
export type StockCategory = z.infer<typeof StockCategory>;

export const StockItem = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  category: StockCategory,
  unit: z.string(),
  quantity: z.number(),
  parLevel: z.number(),
  reorderQuantity: z.number(),
  valueMinor: MinorUnits,
  /** Average cost of one unit (value ÷ quantity), rounded. */
  unitCostMinor: MinorUnits,
  belowPar: z.boolean(),
  active: z.boolean(),
});

export const StockMove = z.object({
  id: z.string(),
  date: IsoDate,
  kind: z.enum(["receipt", "issue", "waste", "sale", "count"]),
  quantity: z.number(),
  valueMinor: MinorUnits,
  outletId: z.string().nullable(),
  ref: z.string(),
  journalId: z.string().nullable(),
});

export const listStock = endpoint({
  id: "hotel.stock.list",
  method: "GET",
  path: `${P}/stock`,
  auth: "user",
  summary: "Stock on hand with par levels and reorder alerts; the value equals inventory account 1300",
  params: PropParams,
  query: z.object({ category: StockCategory.optional(), belowPar: z.stringbool().optional() }),
  response: z.object({ items: z.array(StockItem), totalValueMinor: MinorUnits }),
});

export const createStockItem = endpoint({
  id: "hotel.stock.create",
  method: "POST",
  path: `${P}/stock`,
  auth: "user",
  summary: "Add a stock item (food, beverage, linen, amenity, cleaning) with its par level",
  params: PropParams,
  body: z.object({
    code: Code,
    name: Name,
    category: StockCategory,
    unit: z.string().trim().min(1).max(20),
    parLevel: NonNegativeQty.default(0),
    reorderQuantity: NonNegativeQty.default(0),
  }),
  response: StockItem,
  status: 201,
});

const StockParams = PropParams.extend({ itemId: Id });

export const receiveStock = endpoint({
  id: "hotel.stock.receive",
  method: "POST",
  path: `${P}/stock/:itemId/receipts`,
  auth: "user",
  summary:
    "Receive stock bought without a purchase order (market purchase): inventory 1300 / bank 1000 or payables 2000",
  params: StockParams,
  body: z.object({
    quantity: Qty,
    totalCostMinor: PositiveMinorUnits,
    paidFrom: z.enum(["bank", "payable"]),
    reference: z.string().trim().min(2).max(120),
  }),
  response: z.object({ item: StockItem, move: StockMove }),
  status: 201,
});

export const issueStock = endpoint({
  id: "hotel.stock.issue",
  method: "POST",
  path: `${P}/stock/:itemId/issues`,
  auth: "user",
  summary:
    "Issue stock for use (linen and amenities to rooms, food to a kitchen) or write off waste, at average cost: F&B cost of sales 5200 or rooms costs 5100 / inventory 1300",
  params: StockParams,
  body: z.object({
    quantity: Qty,
    kind: z.enum(["issue", "waste"]).default("issue"),
    outletId: Id.optional(),
    note: z.string().trim().min(2).max(200),
  }),
  response: z.object({ item: StockItem, move: StockMove }),
  status: 201,
});

export const countStock = endpoint({
  id: "hotel.stock.count",
  method: "POST",
  path: `${P}/stock/counts`,
  auth: "user",
  summary: "Record a stock count; each variance posts at average cost (shortage expensed, surplus credited)",
  params: PropParams,
  body: z.object({
    counts: z
      .array(z.object({ itemId: Id, quantity: NonNegativeQty }))
      .min(1)
      .max(1000),
  }),
  response: z.object({
    variances: z.array(
      z.object({ itemId: z.string(), name: z.string(), varianceQuantity: z.number(), valueMinor: MinorUnits }),
    ),
    totalVarianceMinor: MinorUnits,
  }),
});

export const stockMoves = endpoint({
  id: "hotel.stock.moves",
  method: "GET",
  path: `${P}/stock/:itemId/moves`,
  auth: "user",
  summary: "Every movement of one stock item",
  params: StockParams,
  response: z.object({ item: StockItem, moves: z.array(StockMove) }),
});

export const PurchaseOrder = z.object({
  id: z.string(),
  number: z.string(),
  supplier: z.string(),
  status: z.enum(["draft", "approved", "received", "cancelled"]),
  lines: z.array(
    z.object({
      id: z.string(),
      stockItemId: z.string(),
      name: z.string(),
      quantity: z.number(),
      receivedQuantity: z.number(),
      unitCostMinor: MinorUnits,
      lineMinor: MinorUnits,
    }),
  ),
  totalMinor: MinorUnits,
  receivedValueMinor: MinorUnits,
  billedMinor: MinorUnits,
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  bills: z.array(
    z.object({
      id: z.string(),
      supplierRef: z.string(),
      amountMinor: MinorUnits,
      vatMinor: MinorUnits,
      expectedMinor: MinorUnits,
      varianceMinor: MinorUnits,
      status: z.enum(["matched", "held", "approved"]),
      enteredBy: z.string(),
      approvedBy: z.string().nullable(),
    }),
  ),
});

export const listPurchaseOrders = endpoint({
  id: "hotel.purchasing.list",
  method: "GET",
  path: `${P}/purchase-orders`,
  auth: "user",
  summary: "Purchase orders with receipts and supplier bills",
  params: PropParams,
  query: z.object({ status: z.enum(["draft", "approved", "received", "cancelled"]).optional() }),
  response: z.object({ orders: z.array(PurchaseOrder) }),
});

export const createPurchaseOrder = endpoint({
  id: "hotel.purchasing.create",
  method: "POST",
  path: `${P}/purchase-orders`,
  auth: "user",
  summary: "Raise a purchase order for stock (e.g. the items below par); someone else approves it",
  params: PropParams,
  body: z.object({
    supplier: Name,
    lines: z
      .array(z.object({ stockItemId: Id, quantity: Qty, unitCostMinor: PositiveMinorUnits }))
      .min(1)
      .max(200),
  }),
  response: PurchaseOrder,
  status: 201,
});

const PoParams = PropParams.extend({ poId: Id });

export const approvePurchaseOrder = endpoint({
  id: "hotel.purchasing.approve",
  method: "POST",
  path: `${P}/purchase-orders/:poId/approve`,
  auth: "user",
  summary: "Approve a purchase order raised by someone else",
  params: PoParams,
  response: PurchaseOrder,
});

export const receivePurchaseOrder = endpoint({
  id: "hotel.purchasing.receive",
  method: "POST",
  path: `${P}/purchase-orders/:poId/receipts`,
  auth: "user",
  summary: "Receive goods against an approved order (part or all): inventory 1300 / goods received not invoiced 2010",
  params: PoParams,
  body: z.object({
    lines: z
      .array(z.object({ poLineId: Id, quantity: Qty }))
      .min(1)
      .max(200),
  }),
  response: PurchaseOrder,
  status: 201,
});

export const enterSupplierBill = endpoint({
  id: "hotel.purchasing.bill",
  method: "POST",
  path: `${P}/purchase-orders/:poId/bills`,
  auth: "user",
  summary:
    "Enter the supplier's bill. Three-way match: when it equals the goods received and not yet billed (at order prices) it posts GRNI 2010 + VAT 2100 / payables 2000; otherwise it is held for approval.",
  params: PoParams,
  body: z.object({
    supplierRef: z.string().trim().min(1).max(60),
    amountMinor: PositiveMinorUnits,
    vatMinor: NonNegativeMinor.default(0),
  }),
  response: PurchaseOrder,
  status: 201,
});

export const approveSupplierBill = endpoint({
  id: "hotel.purchasing.approveBill",
  method: "POST",
  path: `${P}/supplier-bills/:billId/approve`,
  auth: "user",
  summary:
    "Approve a held bill (someone other than who entered it): the price variance posts to cost of sales or rooms costs",
  params: PropParams.extend({ billId: Id }),
  body: z.object({ reason: Reason }),
  response: PurchaseOrder,
});

// ------------------------------------------------------------------ spa and activities
export const SpaService = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(["treatment", "activity"]),
  department: z.enum(["spa", "other"]),
  durationMinutes: z.number().int(),
  priceMinor: MinorUnits,
  capacity: z.number().int(),
  active: z.boolean(),
});
export const SpaProvider = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["therapist", "guide", "instructor"]),
  userId: z.string().nullable(),
  active: z.boolean(),
});
export const SpaResource = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["treatment_room", "studio", "equipment"]),
  active: z.boolean(),
});

export const getSpaSetup = endpoint({
  id: "hotel.spa.setup",
  method: "GET",
  path: `${P}/spa`,
  auth: "user",
  summary: "Treatments and activities, therapists / guides and treatment rooms",
  params: PropParams,
  response: z.object({
    services: z.array(SpaService),
    providers: z.array(SpaProvider),
    resources: z.array(SpaResource),
  }),
});

export const createSpaService = endpoint({
  id: "hotel.spa.createService",
  method: "POST",
  path: `${P}/spa/services`,
  auth: "user",
  summary: "Add a treatment (one guest) or an activity (a group up to its capacity), priced per participant",
  params: PropParams,
  body: z
    .object({
      code: Code,
      name: Name,
      kind: z.enum(["treatment", "activity"]),
      department: z.enum(["spa", "other"]).default("spa"),
      durationMinutes: z.number().int().min(5).max(1440),
      priceMinor: PositiveMinorUnits,
      capacity: z.number().int().min(1).max(500).default(1),
    })
    .refine((s) => s.kind === "activity" || s.capacity === 1, "A treatment is for one guest"),
  response: SpaService,
  status: 201,
});

export const createSpaProvider = endpoint({
  id: "hotel.spa.createProvider",
  method: "POST",
  path: `${P}/spa/providers`,
  auth: "user",
  summary: "Add a therapist, guide or instructor",
  params: PropParams,
  body: z.object({ name: Name, kind: z.enum(["therapist", "guide", "instructor"]), userId: Id.optional() }),
  response: SpaProvider,
  status: 201,
});

export const createSpaResource = endpoint({
  id: "hotel.spa.createResource",
  method: "POST",
  path: `${P}/spa/resources`,
  auth: "user",
  summary: "Add a treatment room, studio or piece of equipment that bookings take",
  params: PropParams,
  body: z.object({ name: Name, kind: z.enum(["treatment_room", "studio", "equipment"]) }),
  response: SpaResource,
  status: 201,
});

export const ServiceBooking = z.object({
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  providerId: z.string(),
  resourceId: z.string().nullable(),
  guestName: z.string(),
  stayId: z.string().nullable(),
  date: IsoDate,
  start: z.string(),
  end: z.string(),
  participants: z.number().int(),
  source: z.enum(["front_desk", "online", "in_house", "phone"]),
  status: z.enum(["booked", "completed", "cancelled", "no_show"]),
  priceMinor: MinorUnits,
  folioId: z.string().nullable(),
});

export const listServiceBookings = endpoint({
  id: "hotel.spa.bookings",
  method: "GET",
  path: `${P}/spa/bookings`,
  auth: "user",
  summary: "Treatment and activity bookings for a day",
  params: PropParams,
  query: z.object({ date: IsoDate.optional() }),
  response: z.object({ bookings: z.array(ServiceBooking) }),
});

export const bookService = endpoint({
  id: "hotel.spa.book",
  method: "POST",
  path: `${P}/spa/bookings`,
  auth: "user",
  summary:
    "Book a treatment or activity with a therapist / guide and room at a time. A therapist or room is never double-booked; an activity session holds up to its capacity.",
  params: PropParams,
  body: z
    .object({
      serviceId: Id,
      providerId: Id,
      resourceId: Id.optional(),
      date: IsoDate,
      start: Time,
      participants: z.number().int().min(1).max(500).default(1),
      roomNumber: z.string().trim().min(1).max(20).optional(),
      guestName: Name.optional(),
      source: z.enum(["front_desk", "online", "in_house", "phone"]).default("front_desk"),
    })
    .refine((b) => b.roomNumber || b.guestName, "Name the guest or their room"),
  response: ServiceBooking,
  status: 201,
});

export const completeService = endpoint({
  id: "hotel.spa.complete",
  method: "POST",
  path: `${P}/spa/bookings/:bookingId/complete`,
  auth: "user",
  summary: "Treatment given: charge it to the guest's room (in house, folio not blocked) or record payment now",
  params: PropParams.extend({ bookingId: Id }),
  body: Settlement,
  response: ServiceBooking,
});

export const cancelService = endpoint({
  id: "hotel.spa.cancel",
  method: "POST",
  path: `${P}/spa/bookings/:bookingId/cancel`,
  auth: "user",
  summary: "Cancel a booking or mark it a no-show; the therapist and room are free again",
  params: PropParams.extend({ bookingId: Id }),
  body: z.object({ reason: Reason, noShow: z.boolean().default(false) }),
  response: ServiceBooking,
});

// ------------------------------------------------------------------ events and meetings
export const Venue = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  capacity: z.number().int(),
  active: z.boolean(),
});

export const listVenues = endpoint({
  id: "hotel.venues.list",
  method: "GET",
  path: `${P}/venues`,
  auth: "user",
  summary: "Meeting and event spaces",
  params: PropParams,
  response: z.object({ venues: z.array(Venue) }),
});

export const createVenue = endpoint({
  id: "hotel.venues.create",
  method: "POST",
  path: `${P}/venues`,
  auth: "user",
  summary: "Add a meeting or event space with its capacity",
  params: PropParams,
  body: z.object({ code: Code, name: Name, capacity: z.number().int().min(1).max(100_000) }),
  response: Venue,
  status: 201,
});

const EventItemInput = z.object({
  kind: z.enum(["venue_hire", "fnb", "av", "other"]),
  description: z.string().trim().min(2).max(200),
  department: ChargeDepartment,
  quantity: z.number().int().min(1).max(100_000),
  unitMinor: PositiveMinorUnits,
  timeLabel: z.string().trim().max(60).default(""),
  notes: z.string().trim().max(500).default(""),
});

export const EVENT_SETUPS = ["theatre", "classroom", "boardroom", "banquet", "cocktail", "u_shape"] as const;
export const HotelEvent = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  corporateAccountId: z.string().nullable(),
  contactName: z.string(),
  contactEmail: z.string().nullable(),
  venueId: z.string(),
  date: IsoDate,
  start: z.string(),
  end: z.string(),
  pax: z.number().int(),
  setup: z.enum(EVENT_SETUPS),
  status: z.enum(["quote", "contract", "billed", "cancelled"]),
  contractRef: z.string().nullable(),
  beoVersion: z.number().int(),
  notes: z.string(),
  items: z.array(
    EventItemInput.extend({ id: z.string(), netMinor: MinorUnits, timeLabel: z.string(), notes: z.string() }),
  ),
  netMinor: MinorUnits,
  /** With the hotel's taxes, as the final bill will charge it. */
  estimatedTotalMinor: MinorUnits,
  deposits: z.array(
    z.object({
      id: z.string(),
      amountMinor: MinorUnits,
      method: PaymentMethod,
      reference: z.string(),
      receivedOn: IsoDate,
      applied: z.boolean(),
    }),
  ),
  folioId: z.string().nullable(),
});

const EventFields = z.object({
  name: Name,
  corporateAccountId: Id.optional(),
  contactName: Name,
  contactEmail: Email.optional(),
  venueId: Id,
  date: IsoDate,
  start: Time,
  end: Time,
  pax: z.number().int().min(1).max(100_000),
  setup: z.enum(EVENT_SETUPS),
  notes: z.string().trim().max(2000).default(""),
  items: z.array(EventItemInput).max(100).default([]),
});

export const createEvent = endpoint({
  id: "hotel.events.create",
  method: "POST",
  path: `${P}/events`,
  auth: "user",
  summary: "Quote an event: venue, times, guests, setup and the event order (menus, AV, room hire)",
  params: PropParams,
  body: EventFields.refine((e) => e.end > e.start, "The event ends after it starts"),
  response: HotelEvent,
  status: 201,
});

export const listEvents = endpoint({
  id: "hotel.events.list",
  method: "GET",
  path: `${P}/events`,
  auth: "user",
  summary: "Events between two dates",
  params: PropParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: z.object({ events: z.array(HotelEvent) }),
});

const EventParams = PropParams.extend({ eventId: Id });

export const getEvent = endpoint({
  id: "hotel.events.get",
  method: "GET",
  path: `${P}/events/:eventId`,
  auth: "user",
  summary: "One event with its order lines and deposits",
  params: EventParams,
  response: HotelEvent,
});

export const setEventItems = endpoint({
  id: "hotel.events.items",
  method: "PUT",
  path: `${P}/events/:eventId/items`,
  auth: "user",
  summary: "Replace the event order lines; after the contract each change issues a new function sheet version",
  params: EventParams,
  body: z.object({ items: z.array(EventItemInput).max(100), pax: z.number().int().min(1).max(100_000).optional() }),
  response: HotelEvent,
});

export const contractEvent = endpoint({
  id: "hotel.events.contract",
  method: "POST",
  path: `${P}/events/:eventId/contract`,
  auth: "user",
  summary:
    "Record the signed contract (document reference; e-signature not connected). The venue is then held — never double-booked.",
  params: EventParams,
  body: z.object({ contractRef: z.string().trim().min(3).max(200) }),
  response: HotelEvent,
});

export const eventDeposit = endpoint({
  id: "hotel.events.deposit",
  method: "POST",
  path: `${P}/events/:eventId/deposits`,
  auth: "user",
  summary: "Record a deposit on a contracted event (recorded, not processed): bank 1000 / deposits 2350",
  params: EventParams,
  body: z.object({
    amountMinor: PositiveMinorUnits,
    method: MethodNoCash,
    reference: z.string().trim().min(2).max(120),
  }),
  response: HotelEvent,
  status: 201,
});

export const billEvent = endpoint({
  id: "hotel.events.bill",
  method: "POST",
  path: `${P}/events/:eventId/bill`,
  auth: "user",
  summary:
    "Final bill: every order line charged by department with taxes, deposits applied, and a company event sent to the city ledger (within its credit limit)",
  params: EventParams,
  response: z.object({ event: HotelEvent, folio: Folio }),
});

export const cancelEvent = endpoint({
  id: "hotel.events.cancel",
  method: "POST",
  path: `${P}/events/:eventId/cancel`,
  auth: "user",
  summary: "Cancel an event that holds no deposit (with a deposit: bill a cancellation charge instead)",
  params: EventParams,
  body: z.object({ reason: Reason }),
  response: HotelEvent,
});

export const functionSheet = endpoint({
  id: "hotel.events.beo",
  method: "GET",
  path: `${P}/events/:eventId/function-sheet`,
  auth: "user",
  summary: "The banquet event order / function sheet: venue, setup, timings, menus, AV and notes, with its version",
  params: EventParams,
  response: z.object({
    eventId: z.string(),
    number: z.string(),
    version: z.number().int(),
    name: z.string(),
    client: z.string(),
    venue: z.string(),
    date: IsoDate,
    start: z.string(),
    end: z.string(),
    pax: z.number().int(),
    setup: z.string(),
    sections: z.array(
      z.object({
        kind: z.string(),
        title: z.string(),
        lines: z.array(
          z.object({ time: z.string(), description: z.string(), quantity: z.number().int(), notes: z.string() }),
        ),
      }),
    ),
    notes: z.string(),
  }),
});

export const functionDiary = endpoint({
  id: "hotel.events.diary",
  method: "GET",
  path: `${P}/function-diary`,
  auth: "user",
  summary: "The function diary: every venue's events per day (group sales and events)",
  params: PropParams,
  query: Range,
  response: z.object({
    days: z.array(
      z.object({
        date: IsoDate,
        events: z.array(
          z.object({
            eventId: z.string(),
            name: z.string(),
            venueId: z.string(),
            venue: z.string(),
            start: z.string(),
            end: z.string(),
            pax: z.number().int(),
            status: z.string(),
          }),
        ),
      }),
    ),
  }),
});

// ------------------------------------------------------------------ payroll inputs, tips and service charge
export const StaffPay = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  name: z.string(),
  department: StaffDepartment,
  basis: z.enum(["monthly", "hourly"]),
  monthlyMinor: MinorUnits,
  hourlyMinor: MinorUnits,
  servicePoints: z.number().int(),
  active: z.boolean(),
});

export const listStaffPay = endpoint({
  id: "hotel.payroll.staff",
  method: "GET",
  path: `${P}/payroll/staff`,
  auth: "user",
  summary: "The hotel's staff register with pay (payroll officer only — salaries are hidden from every other role)",
  params: PropParams,
  response: z.object({ staff: z.array(StaffPay) }),
});

export const saveStaffPay = endpoint({
  id: "hotel.payroll.saveStaff",
  method: "POST",
  path: `${P}/payroll/staff`,
  auth: "user",
  summary: "Add or change a staff member's pay basis, department and service-charge points",
  params: PropParams,
  body: z
    .object({
      userId: Id.optional(),
      name: Name,
      department: StaffDepartment,
      basis: z.enum(["monthly", "hourly"]),
      monthlyMinor: NonNegativeMinor.default(0),
      hourlyMinor: NonNegativeMinor.default(0),
      servicePoints: z.number().int().min(0).max(100).default(1),
      active: z.boolean().default(true),
    })
    .refine(
      (b) => (b.basis === "monthly" ? b.monthlyMinor > 0 : b.hourlyMinor > 0),
      "Give the monthly salary or the hourly rate",
    ),
  response: StaffPay,
  status: 201,
});

const DeptTotals = z.object({
  rooms: MinorUnits,
  fnb: MinorUnits,
  spa: MinorUnits,
  other: MinorUnits,
  admin: MinorUnits,
});

export const PayRun = z.object({
  id: z.string(),
  number: z.string(),
  period: z.string(),
  status: z.enum(["draft", "approved"]),
  grossMinor: MinorUnits,
  byDepartment: DeptTotals,
  staffCount: z.number().int(),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  journalId: z.string().nullable(),
  /** Individual pay: only for the payroll officer; null for everyone else. */
  lines: z
    .array(
      z.object({
        staffId: z.string(),
        name: z.string(),
        department: StaffDepartment,
        regularHours: z.number(),
        overtimeHours: z.number(),
        baseMinor: MinorUnits,
        overtimeMinor: MinorUnits,
        allowancesMinor: MinorUnits,
        grossMinor: MinorUnits,
      }),
    )
    .nullable(),
  /** Statutory deductions and net pay come from a country payroll engine (not connected). */
  statutory: IntegrationState,
});

export const listPayRuns = endpoint({
  id: "hotel.payroll.runs",
  method: "GET",
  path: `${P}/payroll/runs`,
  auth: "user",
  summary: "Pay runs (department totals; individual lines only for the payroll officer)",
  params: PropParams,
  response: z.object({ runs: z.array(PayRun) }),
});

export const preparePayRun = endpoint({
  id: "hotel.payroll.prepare",
  method: "POST",
  path: `${P}/payroll/runs`,
  auth: "user",
  summary:
    "Prepare a month's pay run from the inputs: salary, hours (from the staff schedule unless given), overtime at the hotel's multiplier, allowances",
  params: PropParams,
  body: z.object({
    period: Month,
    inputs: z
      .array(
        z.object({
          staffId: Id,
          regularHours: z.number().min(0).max(744).optional(),
          overtimeHours: z.number().min(0).max(744).optional(),
          allowancesMinor: NonNegativeMinor.default(0),
        }),
      )
      .max(2000)
      .default([]),
  }),
  response: PayRun,
  status: 201,
});

export const approvePayRun = endpoint({
  id: "hotel.payroll.approve",
  method: "POST",
  path: `${P}/payroll/runs/:runId/approve`,
  auth: "user",
  summary: "Approve a pay run prepared by someone else: departmental payroll 51x0–5950 / wages payable 2200",
  params: PropParams.extend({ runId: Id }),
  response: PayRun,
});

export const Distribution = z.object({
  id: z.string(),
  kind: z.enum(["tips", "service_charge"]),
  upTo: IsoDate,
  poolMinor: MinorUnits,
  journalId: z.string(),
  /** Individual shares: payroll officer only. */
  lines: z
    .array(z.object({ staffId: z.string(), name: z.string(), points: z.number().int(), amountMinor: MinorUnits }))
    .nullable(),
});

export const distribute = endpoint({
  id: "hotel.payroll.distribute",
  method: "POST",
  path: `${P}/payroll/distributions`,
  auth: "user",
  summary:
    "Share the tips pool (2130) or the service charge collected (2120) up to a date among active staff by their points: posts the pool to wages payable 2200",
  params: PropParams,
  body: z.object({
    kind: z.enum(["tips", "service_charge"]),
    upTo: IsoDate,
    departments: z.array(StaffDepartment).max(5).default([]),
  }),
  response: Distribution,
  status: 201,
});

export const listDistributions = endpoint({
  id: "hotel.payroll.distributions",
  method: "GET",
  path: `${P}/payroll/distributions`,
  auth: "user",
  summary: "Tips and service-charge distributions (shares only for the payroll officer)",
  params: PropParams,
  response: z.object({ distributions: z.array(Distribution) }),
});

// ------------------------------------------------------------------ labour planning
export const LabourStandard = z.object({
  department: StaffDepartment,
  basis: z.enum(["per_occupied_room", "per_cover", "per_event_guest", "fixed_per_day"]),
  minutesPerUnit: z.number().int().min(1).max(100_000),
});

export const setLabourStandards = endpoint({
  id: "hotel.labour.standards",
  method: "PUT",
  path: `${P}/labour/standards`,
  auth: "user",
  summary: "Labour standards: minutes per occupied room, per restaurant cover, per event guest, or fixed per day",
  params: PropParams,
  body: z.object({ standards: z.array(LabourStandard).max(40) }),
  response: z.object({ standards: z.array(LabourStandard) }),
});

export const StaffShift = z.object({
  id: z.string(),
  staffId: z.string(),
  name: z.string(),
  department: StaffDepartment,
  date: IsoDate,
  start: z.string(),
  end: z.string(),
  minutes: z.number().int(),
});

export const labourStaff = endpoint({
  id: "hotel.labour.staff",
  method: "GET",
  path: `${P}/labour/staff`,
  auth: "user",
  summary: "Staff names and departments for scheduling (no pay)",
  params: PropParams,
  response: z.object({
    staff: z.array(z.object({ id: z.string(), name: z.string(), department: StaffDepartment })),
  }),
});

export const scheduleShifts = endpoint({
  id: "hotel.labour.schedule",
  method: "POST",
  path: `${P}/labour/shifts`,
  auth: "user",
  summary: "Schedule shifts (a shift may end after midnight); one person never has two overlapping shifts",
  params: PropParams,
  body: z.object({
    shifts: z
      .array(z.object({ staffId: Id, date: IsoDate, start: Time, end: Time }))
      .min(1)
      .max(1000),
  }),
  response: z.object({ shifts: z.array(StaffShift) }),
  status: 201,
});

export const listStaffShifts = endpoint({
  id: "hotel.labour.shifts",
  method: "GET",
  path: `${P}/labour/shifts`,
  auth: "user",
  summary: "Scheduled shifts between two dates",
  params: PropParams,
  query: Range,
  response: z.object({ shifts: z.array(StaffShift) }),
});

export const labourPlan = endpoint({
  id: "hotel.labour.plan",
  method: "GET",
  path: `${P}/labour/plan`,
  auth: "user",
  summary:
    "Staff hours needed per department and day from occupancy on the books, table covers and event guests, against the schedule; labour cost per occupied room from the ledger",
  params: PropParams,
  query: Range,
  response: z.object({
    days: z.array(
      z.object({
        date: IsoDate,
        occupiedRooms: z.number().int(),
        covers: z.number().int(),
        eventGuests: z.number().int(),
        departments: z.array(
          z.object({
            department: StaffDepartment,
            requiredMinutes: z.number().int(),
            scheduledMinutes: z.number().int(),
            gapMinutes: z.number().int(),
          }),
        ),
      }),
    ),
    labourCostMinor: MinorUnits,
    roomsSold: z.number().int(),
    labourCostPerOccupiedRoomMinor: MinorUnits,
    method: z.string(),
  }),
});

// ------------------------------------------------------------------ budgets, manager's report, assets, FF&E
export const Budget = z.object({
  month: z.string(),
  kind: z.enum(["budget", "forecast"]),
  roomsSold: z.number().int(),
  revenue: ByDepartment.extend({ total: MinorUnits }),
  costsMinor: MinorUnits,
  gopMinor: MinorUnits,
});

export const setBudget = endpoint({
  id: "hotel.budgets.set",
  method: "PUT",
  path: `${P}/budgets/:month`,
  auth: "user",
  summary: "Set a month's budget (or reforecast) by department: rooms sold, revenue and costs",
  params: PropParams.extend({ month: Month }),
  body: z.object({
    kind: z.enum(["budget", "forecast"]).default("budget"),
    roomsSold: z.number().int().min(0).max(10_000_000),
    revenue: z.object({
      rooms: NonNegativeMinor,
      fnb: NonNegativeMinor,
      spa: NonNegativeMinor,
      other: NonNegativeMinor,
    }),
    costsMinor: NonNegativeMinor,
  }),
  response: Budget,
});

export const listBudgets = endpoint({
  id: "hotel.budgets.list",
  method: "GET",
  path: `${P}/budgets`,
  auth: "user",
  summary: "Budgets and reforecasts of a year",
  params: PropParams,
  query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
  response: z.object({ budgets: z.array(Budget) }),
});

const PeriodFigures = z.object({
  roomsSold: z.number().int(),
  occupancyPct: z.number(),
  adrMinor: MinorUnits,
  revparMinor: MinorUnits,
  revenue: ByDepartment.extend({ total: MinorUnits }),
  gopMinor: MinorUnits,
});

export const managersReport = endpoint({
  id: "hotel.reports.manager",
  method: "GET",
  path: `${P}/reports/manager`,
  auth: "user",
  summary:
    "Daily manager's report: the day, month to date and year to date — actual (from the ledger) vs budget (pro rata) and last year — and the month's forecast from bookings on the books",
  params: PropParams,
  query: z.object({ date: IsoDate }),
  response: z.object({
    date: IsoDate,
    currency: Currency,
    periods: z.array(
      z.object({
        key: z.enum(["day", "mtd", "ytd"]),
        from: IsoDate,
        to: IsoDate,
        actual: PeriodFigures,
        budget: PeriodFigures.nullable(),
        lastYear: PeriodFigures,
        varianceToBudgetMinor: MinorUnits.nullable(),
      }),
    ),
    monthForecast: z.object({
      month: z.string(),
      actualRoomRevenueToDateMinor: MinorUnits,
      onTheBooksRoomRevenueMinor: MinorUnits,
      forecastRoomRevenueMinor: MinorUnits,
      budgetRoomRevenueMinor: MinorUnits.nullable(),
      forecastRoomsSold: z.number().int(),
    }),
  }),
});

export const FixedAsset = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  category: z.enum(["ffe", "equipment", "it", "vehicle", "building"]),
  acquiredOn: IsoDate,
  costMinor: MinorUnits,
  residualMinor: MinorUnits,
  lifeMonths: z.number().int(),
  fundedFrom: z.enum(["bank", "payable", "ffe_reserve"]),
  status: z.enum(["active", "disposed"]),
  accumulatedMinor: MinorUnits,
  netBookValueMinor: MinorUnits,
  disposedOn: IsoDate.nullable(),
  proceedsMinor: MinorUnits.nullable(),
});

export const listAssets = endpoint({
  id: "hotel.assets.list",
  method: "GET",
  path: `${P}/assets`,
  auth: "user",
  summary: "Fixed assets with depreciation to date and net book value",
  params: PropParams,
  response: z.object({ assets: z.array(FixedAsset) }),
});

export const createAsset = endpoint({
  id: "hotel.assets.create",
  method: "POST",
  path: `${P}/assets`,
  auth: "user",
  summary:
    "Add a fixed asset bought today: fixed assets 1500 / bank, payables or the FF&E reserve fund (straight-line depreciation)",
  params: PropParams,
  body: z
    .object({
      name: Name,
      category: z.enum(["ffe", "equipment", "it", "vehicle", "building"]),
      costMinor: PositiveMinorUnits,
      residualMinor: NonNegativeMinor.default(0),
      lifeMonths: z.number().int().min(1).max(1200),
      fundedFrom: z.enum(["bank", "payable", "ffe_reserve"]),
    })
    .refine((a) => a.residualMinor < a.costMinor, "The residual value is below the cost"),
  response: FixedAsset,
  status: 201,
});

export const runDepreciation = endpoint({
  id: "hotel.assets.depreciate",
  method: "POST",
  path: `${P}/assets/depreciation`,
  auth: "user",
  summary: "Post a month's straight-line depreciation once (depreciation 6100 / accumulated depreciation 1590)",
  params: PropParams,
  body: z.object({ month: Month }),
  response: z.object({
    month: z.string(),
    totalMinor: MinorUnits,
    journalId: z.string().nullable(),
    assets: z.array(z.object({ assetId: z.string(), amountMinor: MinorUnits })),
  }),
});

export const disposeAsset = endpoint({
  id: "hotel.assets.dispose",
  method: "POST",
  path: `${P}/assets/:assetId/dispose`,
  auth: "user",
  summary: "Dispose of an asset: cost and depreciation removed, proceeds to the bank, the gain or loss posted",
  params: PropParams.extend({ assetId: Id }),
  body: z.object({ proceedsMinor: NonNegativeMinor, reason: Reason }),
  response: FixedAsset,
});

export const ffeReserve = endpoint({
  id: "hotel.ffe.get",
  method: "GET",
  path: `${P}/ffe-reserve`,
  auth: "user",
  summary: "The FF&E replacement reserve: rate, contributions, spending on assets and the fund balance (ledger 1020)",
  params: PropParams,
  response: z.object({
    ratePct: z.number(),
    balanceMinor: MinorUnits,
    contributedMinor: MinorUnits,
    spentMinor: MinorUnits,
    contributions: z.array(
      z.object({ month: z.string(), revenueMinor: MinorUnits, ratePct: z.number(), amountMinor: MinorUnits }),
    ),
  }),
});

export const contributeFfe = endpoint({
  id: "hotel.ffe.contribute",
  method: "POST",
  path: `${P}/ffe-reserve/contributions`,
  auth: "user",
  summary: "Put a month's share of total revenue (from the ledger) into the FF&E reserve fund, once per month",
  params: PropParams,
  body: z.object({ month: Month }),
  response: z.object({ month: z.string(), revenueMinor: MinorUnits, ratePct: z.number(), amountMinor: MinorUnits }),
  status: 201,
});

// ------------------------------------------------------------------ revenue management (rules-based, own data)
const RM_METHOD = z.string();

export const revenueForecast = endpoint({
  id: "hotel.revenue.forecast",
  method: "GET",
  path: `${P}/revenue/forecast`,
  auth: "user",
  summary:
    "Occupancy forecast from bookings on the books, pickup in the last 7 days, pace vs the same lead time last year, and a rules-based rate suggestion",
  params: PropParams,
  query: Range,
  response: z.object({
    days: z.array(
      z.object({
        date: IsoDate,
        capacity: z.number().int(),
        onTheBooks: z.number().int(),
        occupancyPct: z.number(),
        pickup7d: z.number().int(),
        lastYearSameLeadTime: z.number().int(),
        paceDelta: z.number().int(),
        expectedPickup: z.number().int(),
        forecastRooms: z.number().int(),
        forecastOccupancyPct: z.number(),
        suggestedChangePct: z.number(),
        reason: z.string(),
      }),
    ),
    segments: z.array(z.object({ source: z.string(), roomNights: z.number().int(), revenueMinor: MinorUnits })),
    competitorRates: IntegrationState,
    method: RM_METHOD,
  }),
});

export const pickupReport = endpoint({
  id: "hotel.revenue.pickup",
  method: "GET",
  path: `${P}/revenue/pickup`,
  auth: "user",
  summary: "Pickup: room nights booked and cancelled in a booking window, by stay date",
  params: PropParams,
  query: z
    .object({ bookedFrom: IsoDate, bookedTo: IsoDate, stayFrom: IsoDate, stayTo: IsoDate })
    .refine((q) => q.bookedTo >= q.bookedFrom && q.stayTo >= q.stayFrom, "An end date is before its start date"),
  response: z.object({
    days: z.array(
      z.object({ date: IsoDate, booked: z.number().int(), cancelled: z.number().int(), net: z.number().int() }),
    ),
    totals: z.object({ booked: z.number().int(), cancelled: z.number().int(), net: z.number().int() }),
  }),
});

export const RateSuggestion = z.object({
  date: IsoDate,
  roomTypeId: z.string(),
  ratePlanId: z.string(),
  currentMinor: MinorUnits,
  suggestedMinor: MinorUnits,
  changePct: z.number(),
  forecastOccupancyPct: z.number(),
  reason: z.string(),
  applied: z.boolean(),
});

export const rateSuggestions = endpoint({
  id: "hotel.revenue.suggestions",
  method: "GET",
  path: `${P}/revenue/suggestions`,
  auth: "user",
  summary: "Rules-based BAR suggestions per room type and night from the forecast and pace (no external AI)",
  params: PropParams,
  query: Range,
  response: z.object({ suggestions: z.array(RateSuggestion), method: RM_METHOD }),
});

export const applySuggestion = endpoint({
  id: "hotel.revenue.apply",
  method: "POST",
  path: `${P}/revenue/suggestions/apply`,
  auth: "user",
  summary:
    "Apply a suggestion: the BAR price of that room type and night changes (a one-night season) and goes to every channel",
  params: PropParams,
  body: z.object({ date: IsoDate, roomTypeId: Id }),
  response: RateSuggestion,
  status: 201,
});

export const displacement = endpoint({
  id: "hotel.revenue.displacement",
  method: "POST",
  path: `${P}/revenue/displacement`,
  auth: "user",
  summary:
    "Group displacement: transient room revenue the group would push out (forecast demand at BAR) vs the group's room revenue",
  params: PropParams,
  body: z
    .object({
      roomTypeId: Id,
      arrival: IsoDate,
      departure: IsoDate,
      roomsPerNight: z.number().int().min(1).max(5000),
      groupRateMinor: PositiveMinorUnits,
    })
    .refine((b) => b.departure > b.arrival, "Departure must be after arrival"),
  response: z.object({
    nights: z.array(
      z.object({
        date: IsoDate,
        capacity: z.number().int(),
        forecastTransient: z.number().int(),
        displacedRooms: z.number().int(),
        transientRateMinor: MinorUnits,
        groupRevenueMinor: MinorUnits,
        displacedRevenueMinor: MinorUnits,
      }),
    ),
    groupRevenueMinor: MinorUnits,
    displacedRevenueMinor: MinorUnits,
    netGainMinor: MinorUnits,
    recommendation: z.enum(["accept", "negotiate"]),
    method: RM_METHOD,
  }),
});

// ------------------------------------------------------------------ corporate sales: RFPs and production
export const Rfp = z.object({
  id: z.string(),
  number: z.string(),
  corporateAccountId: z.string(),
  seasonFrom: IsoDate,
  seasonTo: IsoDate,
  rates: z.array(z.object({ roomTypeId: z.string(), amountMinor: MinorUnits })),
  expectedRoomNights: z.number().int(),
  status: z.enum(["submitted", "accepted", "declined"]),
  ratePlanId: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const listRfps = endpoint({
  id: "hotel.rfps.list",
  method: "GET",
  path: `${P}/rfps`,
  auth: "user",
  summary: "Corporate RFPs (negotiated rates by account and season)",
  params: PropParams,
  response: z.object({ rfps: z.array(Rfp) }),
});

export const createRfp = endpoint({
  id: "hotel.rfps.create",
  method: "POST",
  path: `${P}/rfps`,
  auth: "user",
  summary: "Record a company's RFP: rates per room type for a season and the room nights it expects",
  params: PropParams,
  body: z
    .object({
      corporateAccountId: Id,
      seasonFrom: IsoDate,
      seasonTo: IsoDate,
      rates: z
        .array(z.object({ roomTypeId: Id, amountMinor: PositiveMinorUnits }))
        .min(1)
        .max(50),
      expectedRoomNights: z.number().int().min(0).max(10_000_000),
    })
    .refine((b) => b.seasonTo >= b.seasonFrom, "The season ends before it starts"),
  response: Rfp,
  status: 201,
});

export const decideRfp = endpoint({
  id: "hotel.rfps.decide",
  method: "POST",
  path: `${P}/rfps/:rfpId/decision`,
  auth: "user",
  summary: "Accept (creates the company's corporate rate plan with the RFP rates for the season) or decline an RFP",
  params: PropParams.extend({ rfpId: Id }),
  body: z.object({ decision: z.enum(["accepted", "declined"]), reason: Reason }),
  response: Rfp,
});

export const corporateProduction = endpoint({
  id: "hotel.reports.corporate",
  method: "GET",
  path: `${P}/reports/corporate-production`,
  auth: "user",
  summary: "Production per company and travel agent: reservations, room nights, room revenue and ADR",
  params: PropParams,
  query: Range,
  response: z.object({
    accounts: z.array(
      z.object({
        accountId: z.string(),
        name: z.string(),
        kind: z.enum(["company", "travel_agent"]),
        reservations: z.number().int(),
        roomNights: z.number().int(),
        roomRevenueMinor: MinorUnits,
        adrMinor: MinorUnits,
      }),
    ),
  }),
});

// ------------------------------------------------------------------ reports from own data
export const outletReport = endpoint({
  id: "hotel.reports.outlets",
  method: "GET",
  path: `${P}/reports/outlets`,
  auth: "user",
  summary: "Revenue by outlet (from folio lines) and F&B cost % by outlet (stock used by recipe, from the ledger)",
  params: PropParams,
  query: Range,
  response: z.object({
    outlets: z.array(
      z.object({
        outletId: z.string(),
        name: z.string(),
        department: ChargeDepartment,
        revenueMinor: MinorUnits,
        covers: z.number().int(),
        costOfSalesMinor: MinorUnits,
        costPct: z.number(),
      }),
    ),
    fnbRevenueMinor: MinorUnits,
    fnbCostOfSalesMinor: MinorUnits,
    fnbCostPct: z.number(),
  }),
});

export const housekeepingReport = endpoint({
  id: "hotel.reports.housekeeping",
  method: "GET",
  path: `${P}/reports/housekeeping`,
  auth: "user",
  summary: "Housekeeping productivity per attendant and out-of-order room nights",
  params: PropParams,
  query: Range,
  response: z.object({
    attendants: z.array(
      z.object({
        userId: z.string().nullable(),
        roomsCleaned: z.number().int(),
        averageMinutes: z.number().nullable(),
      }),
    ),
    roomsCleaned: z.number().int(),
    averageMinutes: z.number().nullable(),
    outOfOrderRoomNights: z.number().int(),
  }),
});

export const sustainabilityReport = endpoint({
  id: "hotel.reports.sustainability",
  method: "GET",
  path: `${P}/reports/sustainability`,
  auth: "user",
  summary:
    "Energy, water, waste and carbon per occupied room from meter readings the hotel records; linen-reuse opt-ins and eco-mode commands",
  params: PropParams,
  query: Range,
  response: z.object({
    occupiedRooms: z.number().int(),
    totals: z.object({ energyKwh: z.number(), waterM3: z.number(), wasteKg: z.number(), carbonKg: z.number() }),
    perOccupiedRoom: z.object({
      energyKwh: z.number(),
      waterM3: z.number(),
      wasteKg: z.number(),
      carbonKg: z.number(),
    }),
    readingDays: z.number().int(),
    linenReuseStays: z.number().int(),
    ecoModeCommands: z.number().int(),
    method: z.string(),
    sensors: IntegrationState,
  }),
});

export const recordMeterReadings = endpoint({
  id: "hotel.meters.record",
  method: "POST",
  path: `${P}/meters`,
  auth: "user",
  summary:
    "Record daily meter readings (energy kWh, water m³, waste kg) — entered by staff until sensors are connected",
  params: PropParams,
  body: z.object({
    readings: z
      .array(
        z.object({ date: IsoDate, kind: z.enum(["energy_kwh", "water_m3", "waste_kg"]), quantity: NonNegativeQty }),
      )
      .min(1)
      .max(500),
  }),
  response: z.object({ recorded: z.number().int() }),
  status: 201,
});

export const personalisation = endpoint({
  id: "hotel.reports.personalisation",
  method: "GET",
  path: `${P}/reports/personalisation`,
  auth: "user",
  summary:
    "Arrivals with what the hotel knows: preferences, allergies (with consent), VIP, past stays and spend, loyalty tier, last score and offers matched to past stays (rules)",
  params: PropParams,
  query: z.object({ date: IsoDate.optional() }),
  response: z.object({
    date: IsoDate,
    arrivals: z.array(
      z.object({
        reservationId: z.string(),
        number: z.string(),
        guestId: z.string(),
        guestName: z.string(),
        vip: z.boolean(),
        returning: z.boolean(),
        previousStays: z.number().int(),
        previousSpendMinor: MinorUnits,
        loyaltyTier: z.string().nullable(),
        preferences: z.record(z.string(), z.string()),
        allergies: z.string().nullable(),
        lastScore: z.number().int().nullable(),
        roomSetup: z.object({ temperatureC: z.number().nullable(), notes: z.array(z.string()) }),
        offers: z.array(z.string()),
      }),
    ),
    method: z.string(),
  }),
});

export const housekeepingPlan = endpoint({
  id: "hotel.housekeeping.plan",
  method: "GET",
  path: `${P}/housekeeping/plan`,
  auth: "user",
  summary:
    "Today's cleaning order (rules, no AI): rooms for today's arrivals first, then check-outs, then stay-overs, by floor; linen changes due",
  params: PropParams,
  response: z.object({
    date: IsoDate,
    rooms: z.array(
      z.object({
        roomId: z.string(),
        number: z.string(),
        floor: z.string(),
        task: z.enum(["arrival_prep", "checkout", "stayover", "vacant_dirty"]),
        priority: z.number().int(),
        linenChange: z.boolean(),
        assignedTo: z.string().nullable(),
        housekeeping: HousekeepingStatus,
      }),
    ),
    method: z.string(),
  }),
});

export const reportHousekeeping = endpoint({
  id: "hotel.housekeeping.report",
  method: "POST",
  path: `${P}/rooms/:roomId/housekeeping/report`,
  auth: "user",
  summary:
    "An attendant finishes their room with the checklist; damage reported with a photo reference opens a maintenance ticket",
  params: PropParams.extend({ roomId: Id }),
  body: z.object({
    checklist: z.record(z.string().max(60), z.boolean()),
    damage: z
      .object({ note: z.string().trim().min(3).max(500), photoRef: z.string().trim().max(300).optional() })
      .optional(),
  }),
  response: z.object({ room: Room, ticketId: z.string().nullable(), minutes: z.number().int() }),
});

export const MaintenancePlan = z.object({
  id: z.string(),
  title: z.string(),
  assetLabel: z.string(),
  roomId: z.string().nullable(),
  everyDays: z.number().int(),
  nextDue: IsoDate,
  active: z.boolean(),
});

export const listMaintenancePlans = endpoint({
  id: "hotel.maintenance.plans",
  method: "GET",
  path: `${P}/maintenance/plans`,
  auth: "user",
  summary: "Preventive maintenance schedules (AC, boilers, lifts, pool …)",
  params: PropParams,
  response: z.object({ plans: z.array(MaintenancePlan) }),
});

export const createMaintenancePlan = endpoint({
  id: "hotel.maintenance.createPlan",
  method: "POST",
  path: `${P}/maintenance/plans`,
  auth: "user",
  summary:
    "Add a recurring preventive job; a ticket opens on each due date (the scheduler and automation run raise it)",
  params: PropParams,
  body: z.object({
    title: z.string().trim().min(3).max(200),
    assetLabel: z.string().trim().min(2).max(80),
    roomId: Id.optional(),
    everyDays: z.number().int().min(1).max(3650),
    firstDue: IsoDate,
  }),
  response: MaintenancePlan,
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
export type PromoCodeOut = z.infer<typeof PromoCode>;
export type UpsellOut = z.infer<typeof Upsell>;
export type BookingQuoteOut = z.infer<typeof BookingQuote>;
export type LoyaltyProgrammeOut = z.infer<typeof LoyaltyProgramme>;
export type LoyaltyMemberOut = z.infer<typeof LoyaltyMember>;
export type LoyaltyEntryOut = z.infer<typeof LoyaltyEntry>;
export type FeedbackOut = z.infer<typeof Feedback>;
export type MessageTemplateOut = z.infer<typeof MessageTemplate>;
export type InvoiceOut = z.infer<typeof Invoice>;
export type CollectionActionOut = z.infer<typeof CollectionAction>;
export type BankLineOut = z.infer<typeof BankLine>;
export type RecordedPaymentOut = z.infer<typeof RecordedPayment>;
export type MenuItemOut = z.infer<typeof MenuItem>;
export type PosOrderOut = z.infer<typeof PosOrder>;
export type KitchenTicketOut = z.infer<typeof KitchenTicket>;
export type TableBookingOut = z.infer<typeof TableBooking>;
export type StockItemOut = z.infer<typeof StockItem>;
export type StockMoveOut = z.infer<typeof StockMove>;
export type PurchaseOrderOut = z.infer<typeof PurchaseOrder>;
export type ServiceBookingOut = z.infer<typeof ServiceBooking>;
export type HotelEventOut = z.infer<typeof HotelEvent>;
export type StaffPayOut = z.infer<typeof StaffPay>;
export type PayRunOut = z.infer<typeof PayRun>;
export type DistributionOut = z.infer<typeof Distribution>;
export type StaffShiftOut = z.infer<typeof StaffShift>;
export type BudgetOut = z.infer<typeof Budget>;
export type FixedAssetOut = z.infer<typeof FixedAsset>;
export type RateSuggestionOut = z.infer<typeof RateSuggestion>;
export type RfpOut = z.infer<typeof Rfp>;
export type MaintenancePlanOut = z.infer<typeof MaintenancePlan>;
export type IntegrationStateOut = z.infer<typeof IntegrationState>;
