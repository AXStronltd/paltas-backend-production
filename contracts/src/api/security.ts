// Security Services (product "security"): client sites and contracts with service levels, guards and licences,
// rosters and shifts, attendance evidence, patrols and checkpoints, incidents and the occurrence book, alarms and
// response, visitor reception and the watchlist, physical access control, equipment, client billing and guard
// payroll posting to the organisation's ONE ledger, and reports read from that ledger.
//
// Rules the server enforces (and the database backs up):
// - a guard is never booked on two overlapping shifts (exclusion constraint);
// - the occurrence book is append-only: a mistake is corrected by a new entry that points at the old one;
// - an incident's facts cannot be edited, and whoever reported it cannot close it;
// - whoever recorded or corrected attendance cannot approve that timesheet; whoever prepared payroll cannot approve it;
// - money posts through the ledger (receivables 1100, bank 1000, VAT 2100, security accounts 18xx / 28xx / 48xx / 58xx);
// - payments are RECORDED, never processed; messages are RECORDED, never sent; access controllers, CCTV, alarm
//   panels, biometric readers and the tax authority answer "Not connected — test adapter" until a real adapter exists.
import { z } from "zod";
import { Email, IsoDate, IsoMonth, MinorUnits, PositiveMinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";

// ------------------------------------------------------------------ building blocks
const Id = z.string().min(1).max(80);
const Name = z.string().trim().min(1).max(160);
const Text = z.string().trim().max(2000);
const Code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,20}$/, "Use 1–20 letters, digits, - or _");
/** A percentage with at most two decimals, e.g. 16 or 2.5. */
const Pct = z
  .number()
  .min(0)
  .max(1000)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Use at most two decimals");
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 18:00");
const NonNegativeMinor = MinorUnits.min(0);
/** A moment with its time zone, e.g. "2026-10-10T18:00:00+03:00". */
const Moment = z.iso.datetime({ offset: true });

const Base = "/api/v1/orgs/:orgId/security";

/** An external system PALTAS talks to through an adapter. Until a real adapter is installed, it is a test adapter. */
export const IntegrationState = z.object({ adapter: z.string(), connected: z.boolean(), status: z.string() });

// ------------------------------------------------------------------ settings and payroll rules
export const Settings = z.object({
  /** Late-payment charge on overdue balances; null = not configured (late charges are refused). */
  lateFeePct: z.number().nullable(),
  licenceAlertDays: z.number().int(),
  minRestHours: z.number().int(),
  clockInEarlyMinutes: z.number().int(),
  noShowGraceMinutes: z.number().int(),
  visitorRetentionDays: z.number().int(),
});
export type Settings = z.infer<typeof Settings>;

export const getSettings = endpoint({
  id: "security.settings.get",
  method: "GET",
  path: `${Base}/settings`,
  auth: "user",
  summary: "The organisation's security settings (alert windows, rest rule, clock-in window, retention, late fee).",
  params: OrgParams,
  response: Settings,
});

export const updateSettings = endpoint({
  id: "security.settings.update",
  method: "PUT",
  path: `${Base}/settings`,
  auth: "user",
  summary: "Change security settings. Every change is audited.",
  params: OrgParams,
  body: z.object({
    lateFeePct: Pct.max(100).nullable().optional(),
    licenceAlertDays: z.number().int().min(1).max(365).optional(),
    minRestHours: z.number().int().min(0).max(48).optional(),
    clockInEarlyMinutes: z.number().int().min(0).max(240).optional(),
    noShowGraceMinutes: z.number().int().min(1).max(240).optional(),
    visitorRetentionDays: z.number().int().min(1).max(3650).optional(),
  }),
  response: Settings,
});

export const PayRate = z.object({
  grade: Name,
  hourlyMinor: PositiveMinorUnits,
  /** Overtime pay as a share of the hourly rate, e.g. 150. */
  overtimePct: Pct.min(100),
  holidayPct: Pct.min(100),
});
export const StatutoryRule = z.object({
  code: Code,
  label: Name,
  /** employee: deducted from pay; employer: an extra cost on top of pay. */
  party: z.enum(["employee", "employer"]),
  pct: Pct.max(100),
  minMinor: NonNegativeMinor.default(0),
  /** Only pay up to this amount counts (e.g. a pensionable-pay ceiling); null = no ceiling. */
  baseCapMinor: PositiveMinorUnits.nullable().default(null),
  /** Deductions that reduce taxable pay before income tax. */
  reducesTaxablePay: z.boolean().default(false),
});
export const TaxBand = z.object({ widthMinor: PositiveMinorUnits.nullable(), pct: Pct.max(100) });
export const PayrollRules = z.object({
  payRates: z.array(PayRate),
  statutory: z.array(StatutoryRule),
  /** Income-tax bands applied in order to monthly taxable pay; the last band has widthMinor null. */
  incomeTaxBands: z.array(TaxBand),
  /** Monthly personal relief taken off the income tax of each person (never below zero). */
  personalReliefMinor: NonNegativeMinor,
});
export type PayrollRules = z.infer<typeof PayrollRules>;

export const getPayrollRules = endpoint({
  id: "security.payrollRules.get",
  method: "GET",
  path: `${Base}/payroll-rules`,
  auth: "user",
  summary: "Pay rates per grade, statutory deductions and contributions, and income-tax bands (configuration rows).",
  params: OrgParams,
  response: PayrollRules,
});

export const setPayrollRules = endpoint({
  id: "security.payrollRules.set",
  method: "PUT",
  path: `${Base}/payroll-rules`,
  auth: "user",
  summary: "Replace the payroll rules. Rates are configuration: nothing in the code holds a pay rate or a tax rate.",
  params: OrgParams,
  body: PayrollRules.extend({
    payRates: z.array(PayRate).min(1).max(50),
    statutory: z.array(StatutoryRule).max(30),
    incomeTaxBands: z.array(TaxBand).max(20),
  }),
  response: PayrollRules,
});

// ------------------------------------------------------------------ clients, sites, posts, contracts
export const Client = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  contactName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  paymentTermsDays: z.number().int(),
  /** Income tax the client withholds and certifies, as a share of the net invoice. */
  whtPct: z.number(),
  /** VAT the client withholds as a VAT agent, as a share of the net invoice. */
  vatWhtPct: z.number(),
  creditLimitMinor: z.number().int(),
  portalUserIds: z.array(z.string()),
});
export type Client = z.infer<typeof Client>;

const ClientInput = z.object({
  name: Name,
  contactName: Name,
  email: Email.optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  paymentTermsDays: z.number().int().min(0).max(180),
  whtPct: Pct.max(100).default(0),
  vatWhtPct: Pct.max(100).default(0),
  creditLimitMinor: NonNegativeMinor.default(0),
});

export const listClients = endpoint({
  id: "security.clients.list",
  method: "GET",
  path: `${Base}/clients`,
  auth: "user",
  summary: "Clients of the security company.",
  params: OrgParams,
  response: z.object({ clients: z.array(Client) }),
});

export const createClient = endpoint({
  id: "security.clients.create",
  method: "POST",
  path: `${Base}/clients`,
  auth: "user",
  summary: "Add a client (terms, tax withholding, credit limit).",
  params: OrgParams,
  body: ClientInput,
  response: Client,
  status: 201,
});

export const setClientPortalUsers = endpoint({
  id: "security.clients.portalUsers",
  method: "PUT",
  path: `${Base}/clients/:clientId/portal-users`,
  auth: "user",
  summary: "Members (role: security client) who see this client's sites, reports and invoices in the client portal.",
  params: OrgParams.extend({ clientId: Id }),
  body: z.object({ userIds: z.array(Id).max(50) }),
  response: Client,
});

export const RISKS = ["low", "medium", "high"] as const;
export const Geofence = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(10).max(20_000),
});

export const Site = z.object({
  id: z.string(),
  /** null: an in-house estate site (no client to bill). */
  clientId: z.string().nullable(),
  name: z.string(),
  area: z.string(),
  kind: z.string(),
  risk: z.enum(RISKS),
  geofence: Geofence.nullable(),
  instructions: z.string(),
  alarmMonitoring: z.object({ provider: z.string(), accountRef: z.string() }).nullable(),
  active: z.boolean(),
});
export type Site = z.infer<typeof Site>;

export const COVERS = ["24h", "day", "night"] as const;
export const Post = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  cover: z.enum(COVERS),
  guardsRequired: z.number().int(),
  orderVersion: z.number().int(),
  orderText: z.string(),
  orderUpdatedAt: z.string().nullable(),
  /** Guards who acknowledged the CURRENT post order version. */
  acknowledgedBy: z.array(z.string()),
});

export const Checkpoint = z.object({
  id: z.string(),
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  tagRef: z.string(),
  seq: z.number().int(),
  /** Minutes after a round starts by which this checkpoint is due. */
  offsetMinutes: z.number().int(),
  graceMinutes: z.number().int(),
});

export const CONTRACT_STATUSES = ["active", "ended"] as const;
export const Contract = z.object({
  id: z.string(),
  number: z.string(),
  clientId: z.string(),
  siteId: z.string(),
  startDate: IsoDate,
  endDate: IsoDate.nullable(),
  monthlyFeeMinor: z.number().int(),
  /** Rate per hour for extra cover the client asks for (billed from approved timesheets). */
  extraHourRateMinor: z.number().int(),
  vatPct: z.number(),
  /** Service levels. */
  patrolTargetPct: z.number(),
  responseMinutes: z.number().int(),
  status: z.enum(CONTRACT_STATUSES),
});
export type Contract = z.infer<typeof Contract>;

export const SiteDetail = Site.extend({
  posts: z.array(Post),
  checkpoints: z.array(Checkpoint),
  contract: Contract.nullable(),
});

export const listSites = endpoint({
  id: "security.sites.list",
  method: "GET",
  path: `${Base}/sites`,
  auth: "user",
  summary: "Client and estate sites.",
  params: OrgParams,
  response: z.object({ sites: z.array(Site) }),
});

export const createSite = endpoint({
  id: "security.sites.create",
  method: "POST",
  path: `${Base}/sites`,
  auth: "user",
  summary: "Add a site, for a client or in-house. A geofence lets clock-ins be checked against the site.",
  params: OrgParams,
  body: z.object({
    clientId: Id.nullable().default(null),
    name: Name,
    area: z.string().trim().max(160).default(""),
    kind: z.string().trim().min(1).max(80),
    risk: z.enum(RISKS).default("medium"),
    geofence: Geofence.nullable().default(null),
    instructions: Text.default(""),
    alarmMonitoring: z
      .object({
        provider: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9]{2,30}$/),
        accountRef: Code,
      })
      .nullable()
      .default(null),
  }),
  response: Site,
  status: 201,
});

export const getSite = endpoint({
  id: "security.sites.get",
  method: "GET",
  path: `${Base}/sites/:siteId`,
  auth: "user",
  summary: "A site with its posts and post orders, checkpoints and active contract.",
  params: OrgParams.extend({ siteId: Id }),
  response: SiteDetail,
});

export const createPost = endpoint({
  id: "security.posts.create",
  method: "POST",
  path: `${Base}/sites/:siteId/posts`,
  auth: "user",
  summary: "Add a post (gate, patrol, desk) with how many guards it needs per shift.",
  params: OrgParams.extend({ siteId: Id }),
  body: z.object({
    name: Name,
    cover: z.enum(COVERS),
    guardsRequired: z.number().int().min(1).max(50),
    orderText: Text.default(""),
  }),
  response: Post,
  status: 201,
});

export const updatePostOrder = endpoint({
  id: "security.posts.updateOrder",
  method: "PUT",
  path: `${Base}/posts/:postId/order`,
  auth: "user",
  summary: "Publish a new post-order version. Guards must acknowledge it before they can clock in at this post.",
  params: OrgParams.extend({ postId: Id }),
  body: z.object({ orderText: z.string().trim().min(5).max(4000) }),
  response: Post,
});

export const acknowledgePostOrder = endpoint({
  id: "security.posts.acknowledgeOrder",
  method: "POST",
  path: `${Base}/posts/:postId/order/acknowledge`,
  auth: "user",
  summary: "A guard confirms they have read the current post order (guards acknowledge for themselves only).",
  params: OrgParams.extend({ postId: Id }),
  body: z.object({ guardId: Id, version: z.number().int().min(1) }),
  response: Post,
});

export const createCheckpoints = endpoint({
  id: "security.checkpoints.create",
  method: "POST",
  path: `${Base}/sites/:siteId/checkpoints`,
  auth: "user",
  summary: "Add patrol checkpoints (NFC or QR tag reference, order, when each is due in a round).",
  params: OrgParams.extend({ siteId: Id }),
  body: z.object({
    checkpoints: z
      .array(
        z.object({
          code: Code,
          name: Name,
          tagRef: z.string().trim().min(3).max(80),
          offsetMinutes: z.number().int().min(0).max(1440),
          graceMinutes: z.number().int().min(0).max(240).default(5),
        }),
      )
      .min(1)
      .max(100),
  }),
  response: z.object({ checkpoints: z.array(Checkpoint) }),
  status: 201,
});

export const listContracts = endpoint({
  id: "security.contracts.list",
  method: "GET",
  path: `${Base}/contracts`,
  auth: "user",
  summary: "Client contracts and their service levels.",
  params: OrgParams,
  response: z.object({ contracts: z.array(Contract) }),
});

export const createContract = endpoint({
  id: "security.contracts.create",
  method: "POST",
  path: `${Base}/contracts`,
  auth: "user",
  summary: "A contract for one client site: monthly fee, extra-hour rate, VAT and service levels. One active per site.",
  params: OrgParams,
  body: z.object({
    clientId: Id,
    siteId: Id,
    startDate: IsoDate,
    endDate: IsoDate.nullable().default(null),
    monthlyFeeMinor: PositiveMinorUnits,
    extraHourRateMinor: NonNegativeMinor.default(0),
    vatPct: Pct.max(100),
    patrolTargetPct: Pct.max(100).default(95),
    responseMinutes: z.number().int().min(1).max(600).default(15),
  }),
  response: Contract,
  status: 201,
});

export const endContract = endpoint({
  id: "security.contracts.end",
  method: "POST",
  path: `${Base}/contracts/:contractId/end`,
  auth: "user",
  summary: "End a contract on a date (it is no longer billed for later months).",
  params: OrgParams.extend({ contractId: Id }),
  body: z.object({ endDate: IsoDate, reason: Reason }),
  response: Contract,
});

// ------------------------------------------------------------------ sales pipeline
export const OPPORTUNITY_STAGES = ["enquiry", "survey", "quoted", "won", "lost"] as const;
export const Opportunity = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.enum(OPPORTUNITY_STAGES),
  guardsPerShift: z.number().int(),
  grade: z.string().nullable(),
  monthlyQuoteMinor: z.number().int().nullable(),
  /** Two 12-hour shifts a day for 30 days at the grade's configured hourly rate, plus employer contributions. */
  estimatedMonthlyCostMinor: z.number().int().nullable(),
  marginPct: z.number().nullable(),
  surveyDate: IsoDate.nullable(),
  clientId: z.string().nullable(),
  note: z.string(),
});

export const listOpportunities = endpoint({
  id: "security.opportunities.list",
  method: "GET",
  path: `${Base}/opportunities`,
  auth: "user",
  summary: "The sales pipeline (enquiry → survey → quote → won / lost).",
  params: OrgParams,
  response: z.object({ opportunities: z.array(Opportunity) }),
});

export const createOpportunity = endpoint({
  id: "security.opportunities.create",
  method: "POST",
  path: `${Base}/opportunities`,
  auth: "user",
  summary: "A new enquiry.",
  params: OrgParams,
  body: z.object({
    name: Name,
    guardsPerShift: z.number().int().min(1).max(200),
    grade: Name.optional(),
    note: Text.default(""),
  }),
  response: Opportunity,
  status: 201,
});

export const moveOpportunity = endpoint({
  id: "security.opportunities.move",
  method: "POST",
  path: `${Base}/opportunities/:opportunityId/move`,
  auth: "user",
  summary: "Move an opportunity on. A quote needs a monthly amount; won creates the client (contract follows).",
  params: OrgParams.extend({ opportunityId: Id }),
  body: z.object({
    stage: z.enum(OPPORTUNITY_STAGES),
    surveyDate: IsoDate.optional(),
    monthlyQuoteMinor: PositiveMinorUnits.optional(),
    grade: Name.optional(),
    client: ClientInput.optional(),
    note: Text.optional(),
  }),
  response: Opportunity,
});

// ------------------------------------------------------------------ guards, licences, training, equipment
export const GUARD_STATUSES = ["active", "leave", "suspended", "left"] as const;
export const VETTING = ["cleared", "due", "pending", "failed"] as const;

export const Guard = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  grade: z.string(),
  /** The member account the guard signs in with (guard app); null if they do not sign in. */
  userId: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.enum(GUARD_STATUSES),
  licenceNo: z.string(),
  licenceExpiry: IsoDate,
  vetting: z.enum(VETTING),
  homeSiteId: z.string().nullable(),
  training: z.array(z.object({ id: z.string(), course: z.string(), validTo: IsoDate })),
  equipment: z.array(z.object({ equipmentId: z.string(), code: z.string(), kind: z.string() })),
});
export type Guard = z.infer<typeof Guard>;

export const listGuards = endpoint({
  id: "security.guards.list",
  method: "GET",
  path: `${Base}/guards`,
  auth: "user",
  summary: "Guards. Filter: licence expiring within the alert window, or vetting not cleared.",
  params: OrgParams,
  query: z.object({ filter: z.enum(["all", "licence", "vetting"]).default("all") }),
  response: z.object({ guards: z.array(Guard) }),
});

export const createGuard = endpoint({
  id: "security.guards.create",
  method: "POST",
  path: `${Base}/guards`,
  auth: "user",
  summary: "Add a guard with licence and vetting.",
  params: OrgParams,
  body: z.object({
    name: Name,
    grade: Name,
    userId: Id.nullable().default(null),
    phone: z.string().trim().min(3).max(40).optional(),
    licenceNo: z.string().trim().min(2).max(60),
    licenceExpiry: IsoDate,
    vetting: z.enum(VETTING),
    homeSiteId: Id.nullable().default(null),
  }),
  response: Guard,
  status: 201,
});

export const updateGuard = endpoint({
  id: "security.guards.update",
  method: "PUT",
  path: `${Base}/guards/:guardId`,
  auth: "user",
  summary: "Change a guard's status, grade, licence, vetting, home site or app account.",
  params: OrgParams.extend({ guardId: Id }),
  body: z.object({
    status: z.enum(GUARD_STATUSES).optional(),
    grade: Name.optional(),
    userId: Id.nullable().optional(),
    licenceNo: z.string().trim().min(2).max(60).optional(),
    licenceExpiry: IsoDate.optional(),
    vetting: z.enum(VETTING).optional(),
    homeSiteId: Id.nullable().optional(),
  }),
  response: Guard,
});

export const addTraining = endpoint({
  id: "security.guards.addTraining",
  method: "POST",
  path: `${Base}/guards/:guardId/training`,
  auth: "user",
  summary: "Record a training course with its expiry.",
  params: OrgParams.extend({ guardId: Id }),
  body: z.object({ course: Name, validTo: IsoDate }),
  response: Guard,
  status: 201,
});

export const ExpiryAlert = z.object({
  guardId: z.string(),
  guardName: z.string(),
  kind: z.enum(["licence", "training"]),
  item: z.string(),
  expires: IsoDate,
  daysLeft: z.number().int(),
});

export const expiryAlerts = endpoint({
  id: "security.guards.expiryAlerts",
  method: "GET",
  path: `${Base}/guards/expiry-alerts`,
  auth: "user",
  summary: "Licences and training expiring within the alert window (or already expired), soonest first.",
  params: OrgParams,
  response: z.object({ windowDays: z.number().int(), alerts: z.array(ExpiryAlert) }),
});

export const EQUIPMENT_STATUSES = ["in_store", "issued", "lost", "retired"] as const;
export const Equipment = z.object({
  id: z.string(),
  code: z.string(),
  kind: z.string(),
  description: z.string(),
  status: z.enum(EQUIPMENT_STATUSES),
  holderGuardId: z.string().nullable(),
  history: z.array(
    z.object({
      guardId: z.string(),
      issuedAt: z.string(),
      returnedAt: z.string().nullable(),
      condition: z.string().nullable(),
    }),
  ),
});

export const listEquipment = endpoint({
  id: "security.equipment.list",
  method: "GET",
  path: `${Base}/equipment`,
  auth: "user",
  summary: "Radios, uniforms, torches, body cameras and other kit, with who holds each item.",
  params: OrgParams,
  response: z.object({ equipment: z.array(Equipment) }),
});

export const createEquipment = endpoint({
  id: "security.equipment.create",
  method: "POST",
  path: `${Base}/equipment`,
  auth: "user",
  summary: "Add an item to the store.",
  params: OrgParams,
  body: z.object({ code: Code, kind: Name, description: Text.default("") }),
  response: Equipment,
  status: 201,
});

export const issueEquipment = endpoint({
  id: "security.equipment.issue",
  method: "POST",
  path: `${Base}/equipment/:equipmentId/issue`,
  auth: "user",
  summary: "Issue an item to a guard (an item is held by one guard at a time).",
  params: OrgParams.extend({ equipmentId: Id }),
  body: z.object({ guardId: Id }),
  response: Equipment,
});

export const returnEquipment = endpoint({
  id: "security.equipment.return",
  method: "POST",
  path: `${Base}/equipment/:equipmentId/return`,
  auth: "user",
  summary: "Take an item back (good, damaged) or record it lost.",
  params: OrgParams.extend({ equipmentId: Id }),
  body: z.object({ condition: z.enum(["good", "damaged", "lost"]), note: Text.default("") }),
  response: Equipment,
});

// ------------------------------------------------------------------ roster, shifts, attendance, timesheets
export const EVIDENCE_METHODS = ["gps", "biometric", "nfc", "manual"] as const;
export const Evidence = z.object({
  /** When the device says it happened (offline apps sync later). */
  capturedAt: z.string(),
  /** When PALTAS received it. */
  receivedAt: z.string(),
  method: z.enum(EVIDENCE_METHODS),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  accuracyM: z.number().nullable(),
  deviceRef: z.string().nullable(),
  /** Computed by PALTAS from the submitted position and the site geofence; null when either is missing. */
  insideGeofence: z.boolean().nullable(),
  distanceM: z.number().int().nullable(),
  /** Biometric / device verification needs a connected reader; PALTAS records evidence as submitted. */
  verified: z.boolean(),
  verification: z.string(),
  recordedBy: z.string(),
});

const EvidenceInput = z.object({
  capturedAt: Moment,
  method: z.enum(EVIDENCE_METHODS),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  deviceRef: z.string().trim().max(120).optional(),
});

export const SHIFT_STATUSES = ["open", "assigned", "cancelled"] as const;
export const TIMESHEET_STATUSES = ["none", "submitted", "approved"] as const;
export const Shift = z.object({
  id: z.string(),
  siteId: z.string(),
  postId: z.string(),
  guardId: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** Extra cover the client asked for, billed per hour on top of the monthly fee. */
  extra: z.boolean(),
  holiday: z.boolean(),
  status: z.enum(SHIFT_STATUSES),
  offered: z.boolean(),
  publishedAt: z.string().nullable(),
  clockIn: Evidence.nullable(),
  clockOut: Evidence.nullable(),
  noShow: z.boolean(),
  adjustment: z.object({ inAt: z.string(), outAt: z.string(), reason: z.string(), by: z.string() }).nullable(),
  timesheet: z.object({
    status: z.enum(TIMESHEET_STATUSES),
    normalMinutes: z.number().int(),
    overtimeMinutes: z.number().int(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
  }),
});
export type Shift = z.infer<typeof Shift>;

export const listShifts = endpoint({
  id: "security.shifts.list",
  method: "GET",
  path: `${Base}/shifts`,
  auth: "user",
  summary: "Shifts starting between two moments, optionally for one site, guard or status.",
  params: OrgParams,
  query: z.object({
    from: Moment,
    to: Moment,
    siteId: Id.optional(),
    guardId: Id.optional(),
    status: z.enum(SHIFT_STATUSES).optional(),
  }),
  response: z.object({ shifts: z.array(Shift) }),
});

export const createShifts = endpoint({
  id: "security.shifts.create",
  method: "POST",
  path: `${Base}/shifts`,
  auth: "user",
  summary: "Create open shifts for a post (count = guards needed at once).",
  params: OrgParams,
  body: z.object({
    postId: Id,
    shifts: z
      .array(
        z.object({
          startsAt: Moment,
          endsAt: Moment,
          count: z.number().int().min(1).max(50).default(1),
          extra: z.boolean().default(false),
          holiday: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(200),
  }),
  response: z.object({ shifts: z.array(Shift) }),
  status: 201,
});

export const assignShift = endpoint({
  id: "security.shifts.assign",
  method: "POST",
  path: `${Base}/shifts/:shiftId/assign`,
  auth: "user",
  summary:
    "Assign a guard. Refused: guard not active, licence expired on the shift date, vetting not cleared, too little rest, or already booked at that time.",
  params: OrgParams.extend({ shiftId: Id }),
  body: z.object({ guardId: Id }),
  response: Shift,
});

export const unassignShift = endpoint({
  id: "security.shifts.unassign",
  method: "POST",
  path: `${Base}/shifts/:shiftId/unassign`,
  auth: "user",
  summary: "Take the guard off a shift that has not started (it becomes open again), or cancel it.",
  params: OrgParams.extend({ shiftId: Id }),
  body: z.object({ cancel: z.boolean().default(false), reason: Reason }),
  response: Shift,
});

export const offerShift = endpoint({
  id: "security.shifts.offer",
  method: "POST",
  path: `${Base}/shifts/:shiftId/offer`,
  auth: "user",
  summary:
    "Offer an open shift to the eligible guards (valid licence, cleared vetting, enough rest, free). The offer is recorded; no notification is sent.",
  params: OrgParams.extend({ shiftId: Id }),
  response: z.object({ shift: Shift, eligibleGuardIds: z.array(z.string()), delivery: z.string() }),
});

export const publishRoster = endpoint({
  id: "security.roster.publish",
  method: "POST",
  path: `${Base}/roster/publish`,
  auth: "user",
  summary: "Publish assigned shifts in a period to the guards. Recorded; nothing is pushed to any app.",
  params: OrgParams,
  body: z.object({ from: Moment, to: Moment }),
  response: z.object({ published: z.number().int(), delivery: z.string() }),
});

export const Coverage = z.object({
  siteId: z.string(),
  date: IsoDate,
  required: z.number().int(),
  assigned: z.number().int(),
  open: z.number().int(),
});

export const rosterCoverage = endpoint({
  id: "security.roster.coverage",
  method: "GET",
  path: `${Base}/roster/coverage`,
  auth: "user",
  summary: "Per site and day: guard shifts required (open + assigned), assigned and still open.",
  params: OrgParams,
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({ days: z.array(Coverage) }),
});

export const clockIn = endpoint({
  id: "security.shifts.clockIn",
  method: "POST",
  path: `${Base}/shifts/:shiftId/clock-in`,
  auth: "user",
  summary:
    "Clock in with location evidence, recorded as submitted. Needs the current post order acknowledged; guards clock in only for their own shifts.",
  params: OrgParams.extend({ shiftId: Id }),
  body: EvidenceInput,
  response: Shift,
});

export const clockOut = endpoint({
  id: "security.shifts.clockOut",
  method: "POST",
  path: `${Base}/shifts/:shiftId/clock-out`,
  auth: "user",
  summary: "Clock out with evidence; the timesheet is submitted for approval.",
  params: OrgParams.extend({ shiftId: Id }),
  body: EvidenceInput,
  response: Shift,
});

export const adjustAttendance = endpoint({
  id: "security.shifts.adjust",
  method: "POST",
  path: `${Base}/shifts/:shiftId/adjust`,
  auth: "user",
  summary: "Correct the worked times with a reason (the original evidence is kept). The corrector cannot approve.",
  params: OrgParams.extend({ shiftId: Id }),
  body: z.object({ inAt: Moment, outAt: Moment, reason: Reason }),
  response: Shift,
});

export const detectNoShows = endpoint({
  id: "security.roster.noShows",
  method: "POST",
  path: `${Base}/roster/no-shows`,
  auth: "user",
  summary: "Mark assigned shifts with no clock-in after the grace period as no-shows and raise an alarm for each.",
  params: OrgParams,
  response: z.object({ shiftIds: z.array(z.string()), alarmIds: z.array(z.string()) }),
});

export const listTimesheets = endpoint({
  id: "security.timesheets.list",
  method: "GET",
  path: `${Base}/timesheets`,
  auth: "user",
  summary: "Submitted (awaiting approval) or approved timesheets.",
  params: OrgParams,
  query: z.object({ status: z.enum(["submitted", "approved"]).default("submitted") }),
  response: z.object({ shifts: z.array(Shift) }),
});

export const approveTimesheets = endpoint({
  id: "security.timesheets.approve",
  method: "POST",
  path: `${Base}/timesheets/approve`,
  auth: "user",
  summary:
    "Approve submitted timesheets. Approved hours feed client billing (extra cover) and payroll. Whoever recorded or corrected the attendance cannot approve it.",
  params: OrgParams,
  body: z.object({ shiftIds: z.array(Id).min(1).max(500) }),
  response: z.object({ shifts: z.array(Shift) }),
});

// ------------------------------------------------------------------ patrols
export const Patrol = z.object({
  id: z.string(),
  siteId: z.string(),
  guardId: z.string(),
  shiftId: z.string().nullable(),
  startedAt: z.string(),
  closedAt: z.string().nullable(),
  status: z.enum(["in_progress", "closed"]),
  checkpoints: z.array(
    z.object({
      checkpointId: z.string(),
      code: z.string(),
      name: z.string(),
      dueBy: z.string(),
      scannedAt: z.string().nullable(),
      method: z.string().nullable(),
      state: z.enum(["on_time", "late", "missed", "due"]),
    }),
  ),
  /** Share of checkpoints scanned on time (closed rounds only). */
  compliancePct: z.number().nullable(),
});

export const listPatrols = endpoint({
  id: "security.patrols.list",
  method: "GET",
  path: `${Base}/patrols`,
  auth: "user",
  summary: "Patrol rounds started between two moments, optionally for one site.",
  params: OrgParams,
  query: z.object({ from: Moment, to: Moment, siteId: Id.optional() }),
  response: z.object({ patrols: z.array(Patrol) }),
});

export const startPatrol = endpoint({
  id: "security.patrols.start",
  method: "POST",
  path: `${Base}/patrols`,
  auth: "user",
  summary: "Start a patrol round at a site.",
  params: OrgParams,
  body: z.object({ siteId: Id, guardId: Id, shiftId: Id.optional(), startedAt: Moment }),
  response: Patrol,
  status: 201,
});

export const scanCheckpoint = endpoint({
  id: "security.patrols.scan",
  method: "POST",
  path: `${Base}/patrols/:patrolId/scans`,
  auth: "user",
  summary: "Record a checkpoint scan (NFC / QR tag as read by the guard app, or manual with a note).",
  params: OrgParams.extend({ patrolId: Id }),
  body: z.object({
    tagRef: z.string().trim().min(3).max(80),
    scannedAt: Moment,
    method: z.enum(["nfc", "qr", "manual"]),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    note: Text.default(""),
  }),
  response: Patrol,
});

export const closePatrol = endpoint({
  id: "security.patrols.close",
  method: "POST",
  path: `${Base}/patrols/:patrolId/close`,
  auth: "user",
  summary: "Close a round. Every checkpoint not scanned is missed and raises an alarm for the control room.",
  params: OrgParams.extend({ patrolId: Id }),
  body: z.object({ closedAt: Moment }),
  response: z.object({ patrol: Patrol, alarmIds: z.array(z.string()) }),
});

// ------------------------------------------------------------------ incidents and the occurrence book
export const SEVERITIES = ["low", "medium", "high"] as const;
export const INCIDENT_STATUSES = ["open", "investigating", "closed"] as const;
export const ATTACHMENT_KINDS = ["photo", "voice", "video", "cctv_clip", "document"] as const;
const Attachment = z.object({ kind: z.enum(ATTACHMENT_KINDS), ref: z.string().trim().min(1).max(300) });

export const OCCURRENCE_KINDS = [
  "entry",
  "incident",
  "status",
  "correction",
  "alarm",
  "handover",
  "patrol",
  "visitor",
] as const;
export const Occurrence = z.object({
  id: z.string(),
  number: z.string(),
  siteId: z.string(),
  incidentId: z.string().nullable(),
  alarmId: z.string().nullable(),
  at: z.string(),
  recordedAt: z.string(),
  recordedBy: z.string().nullable(),
  kind: z.enum(OCCURRENCE_KINDS),
  text: z.string(),
  correctsId: z.string().nullable(),
  /** Later entries that correct this one. */
  correctedBy: z.array(z.string()),
  attachments: z.array(Attachment),
});

export const Incident = z.object({
  id: z.string(),
  number: z.string(),
  siteId: z.string(),
  type: z.string(),
  severity: z.enum(SEVERITIES),
  description: z.string(),
  occurredAt: z.string(),
  reportedBy: z.string(),
  reportedAt: z.string(),
  guardId: z.string().nullable(),
  alarmId: z.string().nullable(),
  status: z.enum(INCIDENT_STATUSES),
  investigatorUserId: z.string().nullable(),
  closedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  closingNote: z.string().nullable(),
});
export const IncidentDetail = Incident.extend({ timeline: z.array(Occurrence) });

export const listIncidents = endpoint({
  id: "security.incidents.list",
  method: "GET",
  path: `${Base}/incidents`,
  auth: "user",
  summary: "Incidents, newest first. Filter: open, high severity, or one site.",
  params: OrgParams,
  query: z.object({ filter: z.enum(["all", "open", "high"]).default("all"), siteId: Id.optional() }),
  response: z.object({ incidents: z.array(Incident) }),
});

export const reportIncident = endpoint({
  id: "security.incidents.report",
  method: "POST",
  path: `${Base}/incidents`,
  auth: "user",
  summary: "Report an incident. It is written to the occurrence book; its facts can never be edited afterwards.",
  params: OrgParams,
  body: z.object({
    siteId: Id,
    type: Name,
    severity: z.enum(SEVERITIES),
    description: z.string().trim().min(5).max(4000),
    occurredAt: Moment,
    guardId: Id.optional(),
    alarmId: Id.optional(),
    attachments: z.array(Attachment).max(20).default([]),
  }),
  response: IncidentDetail,
  status: 201,
});

export const getIncident = endpoint({
  id: "security.incidents.get",
  method: "GET",
  path: `${Base}/incidents/:incidentId`,
  auth: "user",
  summary: "An incident with its timeline from the occurrence book.",
  params: OrgParams.extend({ incidentId: Id }),
  response: IncidentDetail,
});

export const assignInvestigator = endpoint({
  id: "security.incidents.assign",
  method: "POST",
  path: `${Base}/incidents/:incidentId/assign`,
  auth: "user",
  summary: "Assign an investigator (a member); the incident moves to investigating.",
  params: OrgParams.extend({ incidentId: Id }),
  body: z.object({ userId: Id }),
  response: IncidentDetail,
});

export const closeIncident = endpoint({
  id: "security.incidents.close",
  method: "POST",
  path: `${Base}/incidents/:incidentId/close`,
  auth: "user",
  summary: "Close an incident with a note. The person who reported it cannot close it.",
  params: OrgParams.extend({ incidentId: Id }),
  body: z.object({ note: Reason }),
  response: IncidentDetail,
});

export const addOccurrence = endpoint({
  id: "security.occurrences.add",
  method: "POST",
  path: `${Base}/occurrences`,
  auth: "user",
  summary:
    "Write an occurrence-book entry. Entries are never edited or deleted: to correct one, add a correction that points at it.",
  params: OrgParams,
  body: z.object({
    siteId: Id,
    kind: z.enum(["entry", "handover", "correction"]),
    text: z.string().trim().min(2).max(4000),
    at: Moment,
    incidentId: Id.optional(),
    correctsId: Id.optional(),
    attachments: z.array(Attachment).max(20).default([]),
  }),
  response: Occurrence,
  status: 201,
});

export const listOccurrences = endpoint({
  id: "security.occurrences.list",
  method: "GET",
  path: `${Base}/occurrences`,
  auth: "user",
  summary: "The occurrence book for a site between two moments, in order.",
  params: OrgParams,
  query: z.object({ siteId: Id, from: Moment, to: Moment }),
  response: z.object({ entries: z.array(Occurrence) }),
});

// ------------------------------------------------------------------ alarms and response
export const ALARM_SOURCES = ["panic", "device", "missed_checkpoint", "no_show", "manual"] as const;
export const ALARM_STATUSES = ["raised", "acknowledged", "dispatched", "resolved"] as const;
export const Alarm = z.object({
  id: z.string(),
  number: z.string(),
  siteId: z.string(),
  source: z.enum(ALARM_SOURCES),
  provider: z.string().nullable(),
  sourceRef: z.string().nullable(),
  guardId: z.string().nullable(),
  raisedAt: z.string(),
  detail: z.string(),
  status: z.enum(ALARM_STATUSES),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  dispatchUnit: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  outcome: z.enum(["genuine", "false_alarm"]).nullable(),
  resolutionNote: z.string().nullable(),
  incidentId: z.string().nullable(),
  /** Minutes from raised to acknowledged. */
  responseMinutes: z.number().nullable(),
});

export const listAlarms = endpoint({
  id: "security.alarms.list",
  method: "GET",
  path: `${Base}/alarms`,
  auth: "user",
  summary: "The alarm queue: active alarms first, then resolved ones, newest first.",
  params: OrgParams,
  query: z.object({ active: z.enum(["true", "false"]).optional(), siteId: Id.optional() }),
  response: z.object({ alarms: z.array(Alarm) }),
});

export const raisePanic = endpoint({
  id: "security.alarms.panic",
  method: "POST",
  path: `${Base}/alarms/panic`,
  auth: "user",
  summary: "A guard raises panic from the guard app (with the position as submitted). Recorded for the control room.",
  params: OrgParams,
  body: z.object({
    guardId: Id,
    siteId: Id,
    at: Moment,
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }),
  response: Alarm,
  status: 201,
});

export const raiseAlarm = endpoint({
  id: "security.alarms.raise",
  method: "POST",
  path: `${Base}/alarms`,
  auth: "user",
  summary: "The control room records an alarm by hand (e.g. a phone call from site).",
  params: OrgParams,
  body: z.object({ siteId: Id, at: Moment, detail: z.string().trim().min(3).max(1000) }),
  response: Alarm,
  status: 201,
});

export const acknowledgeAlarm = endpoint({
  id: "security.alarms.acknowledge",
  method: "POST",
  path: `${Base}/alarms/:alarmId/acknowledge`,
  auth: "user",
  summary: "Acknowledge an alarm (starts the response clock).",
  params: OrgParams.extend({ alarmId: Id }),
  body: z.object({ at: Moment }),
  response: Alarm,
});

export const dispatchAlarm = endpoint({
  id: "security.alarms.dispatch",
  method: "POST",
  path: `${Base}/alarms/:alarmId/dispatch`,
  auth: "user",
  summary: "Record the response unit dispatched (no radio or SMS is sent by PALTAS).",
  params: OrgParams.extend({ alarmId: Id }),
  body: z.object({ unit: z.string().trim().min(1).max(80), at: Moment }),
  response: Alarm,
});

export const resolveAlarm = endpoint({
  id: "security.alarms.resolve",
  method: "POST",
  path: `${Base}/alarms/:alarmId/resolve`,
  auth: "user",
  summary: "Resolve an acknowledged alarm as genuine or false, optionally opening an incident from it.",
  params: OrgParams.extend({ alarmId: Id }),
  body: z.object({
    at: Moment,
    outcome: z.enum(["genuine", "false_alarm"]),
    note: Reason,
    incident: z
      .object({ type: Name, severity: z.enum(SEVERITIES), description: z.string().trim().min(5).max(4000) })
      .optional(),
  }),
  response: Alarm,
});

export const alarmWebhook = endpoint({
  id: "security.alarms.inbound",
  method: "POST",
  path: "/api/v1/webhooks/security/alarms/:provider",
  auth: "signed-webhook",
  summary:
    "An alarm event from a monitoring provider (signed), matched to the site by the provider's account reference. Repeats are ignored.",
  params: z.object({ provider: z.string().min(1) }),
  body: z.object({
    accountRef: Code,
    eventId: z.string().trim().min(1).max(120),
    kind: z.enum(["intrusion", "panic", "fire", "tamper", "power", "other"]),
    zone: z.string().trim().max(80).default(""),
    occurredAt: Moment,
  }),
  response: z.object({ alarmId: z.string(), number: z.string(), duplicate: z.boolean() }),
});

// ------------------------------------------------------------------ visitors and watchlist
export const VISITOR_STATUSES = ["expected", "awaiting_host", "approved", "on_site", "departed", "denied"] as const;
export const Visitor = z.object({
  id: z.string(),
  number: z.string(),
  siteId: z.string(),
  name: z.string(),
  host: z.string(),
  purpose: z.string(),
  kind: z.enum(["pre_registered", "walk_in"]),
  expectedDate: IsoDate,
  expectedTime: z.string().nullable(),
  passCode: z.string().nullable(),
  plate: z.string().nullable(),
  idType: z.string().nullable(),
  /** Only the last four characters of the ID are kept. */
  idLast4: z.string().nullable(),
  status: z.enum(VISITOR_STATUSES),
  hostApprovalBy: z.string().nullable(),
  checkedInAt: z.string().nullable(),
  checkedOutAt: z.string().nullable(),
  deniedReason: z.string().nullable(),
  retainUntil: IsoDate,
  purged: z.boolean(),
  delivery: z.string().nullable(),
});

export const listVisitors = endpoint({
  id: "security.visitors.list",
  method: "GET",
  path: `${Base}/visitors`,
  auth: "user",
  summary: "Visitors: expected and pending, on site, or the full log.",
  params: OrgParams,
  query: z.object({ view: z.enum(["expected", "onsite", "log"]).default("expected"), siteId: Id.optional() }),
  response: z.object({ visitors: z.array(Visitor) }),
});

export const registerVisitor = endpoint({
  id: "security.visitors.register",
  method: "POST",
  path: `${Base}/visitors`,
  auth: "user",
  summary:
    "Pre-register a visitor (creates a pass code; not sent — give it to the visitor) or record a walk-in (awaits host approval). Watchlist matches are refused and logged.",
  params: OrgParams,
  body: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pre_registered"),
      siteId: Id,
      name: Name,
      host: Name,
      purpose: z.string().trim().min(2).max(80),
      expectedDate: IsoDate,
      expectedTime: Time,
      plate: z.string().trim().max(20).optional(),
    }),
    z.object({
      kind: z.literal("walk_in"),
      siteId: Id,
      name: Name,
      host: Name,
      purpose: z.string().trim().min(2).max(80),
      idType: z.enum(["national_id", "passport", "driving_licence", "other"]),
      idLast4: z.string().regex(/^[A-Za-z0-9]{4}$/, "Enter the last 4 characters of the ID"),
      plate: z.string().trim().max(20).optional(),
    }),
  ]),
  response: Visitor,
  status: 201,
});

export const visitorAction = endpoint({
  id: "security.visitors.action",
  method: "POST",
  path: `${Base}/visitors/:visitorId/action`,
  auth: "user",
  summary:
    "Record the host's approval, deny entry (with a reason), check in (watchlist checked again) or check out. The host is not notified (no messaging provider).",
  params: OrgParams.extend({ visitorId: Id }),
  body: z.object({
    action: z.enum(["host_approved", "deny", "check_in", "check_out"]),
    reason: Reason.optional(),
    at: Moment,
  }),
  response: Visitor,
});

export const purgeVisitors = endpoint({
  id: "security.visitors.purge",
  method: "POST",
  path: `${Base}/visitors/purge`,
  auth: "user",
  summary: "Remove personal data (name, ID, plate) of visitors past their retention date. The visit count stays.",
  params: OrgParams,
  response: z.object({ purged: z.number().int() }),
});

export const WatchEntry = z.object({
  id: z.string(),
  siteId: z.string().nullable(),
  kind: z.enum(["person", "vehicle"]),
  value: z.string(),
  reason: z.string(),
  active: z.boolean(),
  addedAt: z.string(),
  hits: z.number().int(),
});

export const listWatchlist = endpoint({
  id: "security.watchlist.list",
  method: "GET",
  path: `${Base}/watchlist`,
  auth: "user",
  summary: "The watchlist (active entries first) with how often each was matched at the gate.",
  params: OrgParams,
  response: z.object({ entries: z.array(WatchEntry) }),
});

export const addWatch = endpoint({
  id: "security.watchlist.add",
  method: "POST",
  path: `${Base}/watchlist`,
  auth: "user",
  summary: "Add a person or vehicle plate to the watchlist (one site or every site).",
  params: OrgParams,
  body: z.object({
    kind: z.enum(["person", "vehicle"]),
    value: z.string().trim().min(2).max(120),
    reason: Reason,
    siteId: Id.nullable().default(null),
  }),
  response: WatchEntry,
  status: 201,
});

export const removeWatch = endpoint({
  id: "security.watchlist.remove",
  method: "POST",
  path: `${Base}/watchlist/:entryId/remove`,
  auth: "user",
  summary: "Take an entry off the watchlist (kept in the history with the reason).",
  params: OrgParams.extend({ entryId: Id }),
  body: z.object({ reason: Reason }),
  response: WatchEntry,
});

// ------------------------------------------------------------------ physical access control
export const Door = z.object({
  id: z.string(),
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  zone: z.string(),
  reader: IntegrationState,
});
export const AccessGroup = z.object({
  id: z.string(),
  name: z.string(),
  doorIds: z.array(z.string()),
  /** Daily window; from = to means all day. A window that ends before it starts runs overnight. */
  from: Time,
  to: Time,
  credentials: z.number().int(),
});
export const CREDENTIAL_KINDS = ["card", "fob", "mobile", "pin"] as const;
export const CREDENTIAL_STATUSES = ["active", "suspended", "revoked"] as const;
export const Credential = z.object({
  id: z.string(),
  number: z.string(),
  guardId: z.string().nullable(),
  holderName: z.string(),
  kind: z.enum(CREDENTIAL_KINDS),
  groupIds: z.array(z.string()),
  validFrom: IsoDate,
  validTo: IsoDate,
  status: z.enum(CREDENTIAL_STATUSES),
  /** Active, suspended, revoked, expired or not yet valid, on today's date. */
  state: z.string(),
  statusReason: z.string().nullable(),
  replacedBy: z.string().nullable(),
  enrolment: z.string(),
  /** The credential stays valid after the holder's guard licence expires. */
  outlastsLicence: z.boolean(),
});
export const AccessDecision = z.object({
  id: z.string(),
  credentialId: z.string(),
  doorId: z.string(),
  at: z.string(),
  allowed: z.boolean(),
  reason: z.string(),
  /** A rule check run in PALTAS, not an event from a door controller. */
  source: z.string(),
});

export const accessOverview = endpoint({
  id: "security.access.overview",
  method: "GET",
  path: `${Base}/access`,
  auth: "user",
  summary: "Doors, access groups, credentials and the decision log, with the controller connection state.",
  params: OrgParams,
  response: z.object({
    controller: IntegrationState,
    doors: z.array(Door),
    groups: z.array(AccessGroup),
    credentials: z.array(Credential),
    decisions: z.array(AccessDecision),
  }),
});

export const createDoor = endpoint({
  id: "security.access.createDoor",
  method: "POST",
  path: `${Base}/access/doors`,
  auth: "user",
  summary: "Record a door, gate or barrier at a site.",
  params: OrgParams,
  body: z.object({ siteId: Id, code: Code, name: Name, zone: z.string().trim().min(1).max(60) }),
  response: Door,
  status: 201,
});

export const saveAccessGroup = endpoint({
  id: "security.access.saveGroup",
  method: "POST",
  path: `${Base}/access/groups`,
  auth: "user",
  summary: "Create or change an access group: a set of doors and a daily time window.",
  params: OrgParams,
  body: z.object({ id: Id.optional(), name: Name, doorIds: z.array(Id).min(1).max(200), from: Time, to: Time }),
  response: AccessGroup,
});

export const issueCredential = endpoint({
  id: "security.access.issueCredential",
  method: "POST",
  path: `${Base}/access/credentials`,
  auth: "user",
  summary:
    "Issue a credential to a guard or another staff member. One active credential of each kind per person. Enrolment on a reader needs a connected controller.",
  params: OrgParams,
  body: z.object({
    guardId: Id.optional(),
    holderName: Name.optional(),
    kind: z.enum(CREDENTIAL_KINDS),
    groupIds: z.array(Id).min(1).max(50),
    validFrom: IsoDate,
    validTo: IsoDate,
  }),
  response: Credential,
  status: 201,
});

export const changeCredential = endpoint({
  id: "security.access.changeCredential",
  method: "POST",
  path: `${Base}/access/credentials/:credentialId/change`,
  auth: "user",
  summary: "Suspend, reactivate, revoke, or replace a lost credential (revokes it and issues a new one).",
  params: OrgParams.extend({ credentialId: Id }),
  body: z.object({ action: z.enum(["suspend", "reactivate", "revoke", "replace"]), reason: Reason }),
  response: z.object({ credential: Credential, replacement: Credential.nullable() }),
});

export const checkAccess = endpoint({
  id: "security.access.check",
  method: "POST",
  path: `${Base}/access/check`,
  auth: "user",
  summary:
    "Run the access rule a controller would apply (status and dates, holder licence, watchlist, group and schedule) and log the decision. Not a door event.",
  params: OrgParams,
  body: z.object({ credentialId: Id, doorId: Id, at: Moment }),
  response: AccessDecision,
});

export const remoteUnlock = endpoint({
  id: "security.access.remoteUnlock",
  method: "POST",
  path: `${Base}/access/doors/:doorId/unlock`,
  auth: "user",
  summary: "Ask the door controller to unlock a door. Refused while no controller is connected (nothing is unlocked).",
  params: OrgParams.extend({ doorId: Id }),
  body: z.object({ reason: Reason }),
  response: z.object({ done: z.boolean(), status: z.string() }),
});

// ------------------------------------------------------------------ client billing (posts to the ledger)
export const PAYMENT_METHODS = ["bank_transfer", "mobile_money", "cheque", "card", "cash"] as const;
export const InvoiceLine = z.object({
  kind: z.enum(["contract", "extra_hours", "late_fee", "other"]),
  description: z.string(),
  quantity: z.number().int(),
  unit: z.string(),
  amountMinor: z.number().int(),
});
export const Invoice = z.object({
  id: z.string(),
  number: z.string(),
  clientId: z.string(),
  siteId: z.string().nullable(),
  contractId: z.string().nullable(),
  period: z.string().nullable(),
  date: IsoDate,
  dueDate: IsoDate,
  lines: z.array(InvoiceLine),
  netMinor: z.number().int(),
  vatMinor: z.number().int(),
  totalMinor: z.number().int(),
  whtExpectedMinor: z.number().int(),
  vatWhtExpectedMinor: z.number().int(),
  paidMinor: z.number().int(),
  certifiedMinor: z.number().int(),
  balanceMinor: z.number().int(),
  state: z.enum(["open", "part_paid", "paid", "overdue"]),
  journalId: z.string(),
  /** Electronic tax-invoice submission needs a tax-authority connection. */
  taxAuthority: z.string(),
});
export type Invoice = z.infer<typeof Invoice>;

export const runBilling = endpoint({
  id: "security.billing.run",
  method: "POST",
  path: `${Base}/billing/run`,
  auth: "user",
  summary:
    "Invoice every active contract for a month (once per contract and month) plus approved, not yet billed extra cover at the contract's hourly rate. Each invoice posts to the ledger.",
  params: OrgParams,
  body: z.object({ period: IsoMonth }),
  response: z.object({ invoices: z.array(Invoice), skipped: z.array(z.string()) }),
});

export const createInvoice = endpoint({
  id: "security.invoices.create",
  method: "POST",
  path: `${Base}/invoices`,
  auth: "user",
  summary: "A one-off invoice to a client (other services); posts to the ledger.",
  params: OrgParams,
  body: z.object({
    clientId: Id,
    siteId: Id.optional(),
    vatPct: Pct.max(100),
    lines: z
      .array(
        z.object({
          description: z.string().trim().min(2).max(200),
          quantity: z.number().int().min(1).max(100_000),
          unitMinor: PositiveMinorUnits,
        }),
      )
      .min(1)
      .max(30),
  }),
  response: Invoice,
  status: 201,
});

export const listInvoices = endpoint({
  id: "security.invoices.list",
  method: "GET",
  path: `${Base}/invoices`,
  auth: "user",
  summary: "Client invoices with payments, certificates and balance.",
  params: OrgParams,
  query: z.object({ clientId: Id.optional(), open: z.enum(["true", "false"]).optional() }),
  response: z.object({ invoices: z.array(Invoice) }),
});

export const Receipt = z.object({
  id: z.string(),
  number: z.string(),
  clientId: z.string(),
  date: IsoDate,
  amountMinor: z.number().int(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string(),
  allocations: z.array(z.object({ invoiceId: z.string(), amountMinor: z.number().int() })),
  journalId: z.string(),
});

export const recordReceipt = endpoint({
  id: "security.receipts.record",
  method: "POST",
  path: `${Base}/receipts`,
  auth: "user",
  summary:
    "Record a payment the client made (bank, mobile money, cheque…) and allocate it to invoices. Recorded, never processed.",
  params: OrgParams,
  body: z.object({
    clientId: Id,
    date: IsoDate,
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().min(2).max(80),
    allocations: z
      .array(z.object({ invoiceId: Id, amountMinor: PositiveMinorUnits }))
      .min(1)
      .max(50),
  }),
  response: Receipt,
  status: 201,
});

export const listReceipts = endpoint({
  id: "security.receipts.list",
  method: "GET",
  path: `${Base}/receipts`,
  auth: "user",
  summary: "Payments received, newest first.",
  params: OrgParams,
  query: z.object({ clientId: Id.optional() }),
  response: z.object({ receipts: z.array(Receipt) }),
});

export const recordCertificate = endpoint({
  id: "security.invoices.certificate",
  method: "POST",
  path: `${Base}/invoices/:invoiceId/certificates`,
  auth: "user",
  summary:
    "Record a client's withholding certificate (income tax or VAT). It settles that part of the invoice and is a tax credit.",
  params: OrgParams.extend({ invoiceId: Id }),
  body: z.object({
    kind: z.enum(["income_tax", "vat"]),
    certificateRef: z.string().trim().min(2).max(80),
    date: IsoDate,
  }),
  response: Invoice,
});

export const billLateFee = endpoint({
  id: "security.clients.lateFee",
  method: "POST",
  path: `${Base}/clients/:clientId/late-fee`,
  auth: "user",
  summary: "Invoice the configured late-payment charge on the client's overdue balance (once per day).",
  params: OrgParams.extend({ clientId: Id }),
  body: z.object({ vatPct: Pct.max(100) }),
  response: Invoice,
  status: 201,
});

export const StatementLine = z.object({
  date: IsoDate,
  kind: z.enum(["invoice", "receipt", "certificate"]),
  ref: z.string(),
  description: z.string(),
  debitMinor: z.number().int(),
  creditMinor: z.number().int(),
  balanceMinor: z.number().int(),
});

export const clientStatement = endpoint({
  id: "security.clients.statement",
  method: "GET",
  path: `${Base}/clients/:clientId/statement`,
  auth: "user",
  summary: "The client's account: invoices, payments and certificates with a running balance.",
  params: OrgParams.extend({ clientId: Id }),
  response: z.object({ client: Client, lines: z.array(StatementLine), balanceMinor: z.number().int() }),
});

export const AgeingRow = z.object({
  clientId: z.string(),
  name: z.string(),
  notDueMinor: z.number().int(),
  d1to30Minor: z.number().int(),
  d31to60Minor: z.number().int(),
  d61to90Minor: z.number().int(),
  over90Minor: z.number().int(),
  totalMinor: z.number().int(),
});

export const ageing = endpoint({
  id: "security.receivables.ageing",
  method: "GET",
  path: `${Base}/receivables/ageing`,
  auth: "user",
  summary: "What each client owes, by days past the due date. The total equals the receivables in the ledger.",
  params: OrgParams,
  response: z.object({ rows: z.array(AgeingRow), totalMinor: z.number().int() }),
});

export const ClientNote = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["call", "email", "note", "promise", "reminder"]),
  text: z.string(),
  promiseDate: IsoDate.nullable(),
  by: z.string(),
  delivery: z.string().nullable(),
});

export const listClientNotes = endpoint({
  id: "security.clients.notes",
  method: "GET",
  path: `${Base}/clients/:clientId/notes`,
  auth: "user",
  summary: "Collections activity: calls, e-mails, promises to pay and reminders.",
  params: OrgParams.extend({ clientId: Id }),
  response: z.object({ notes: z.array(ClientNote) }),
});

export const addClientNote = endpoint({
  id: "security.clients.addNote",
  method: "POST",
  path: `${Base}/clients/:clientId/notes`,
  auth: "user",
  summary: "Log collections activity. A reminder is recorded only: no e-mail or SMS provider is connected.",
  params: OrgParams.extend({ clientId: Id }),
  body: z.object({
    kind: z.enum(["call", "email", "note", "promise", "reminder"]),
    text: z.string().trim().min(2).max(2000),
    promiseDate: IsoDate.optional(),
  }),
  response: ClientNote,
  status: 201,
});

export const BankLine = z.object({
  id: z.string(),
  date: IsoDate,
  description: z.string(),
  reference: z.string(),
  amountMinor: z.number().int(),
  status: z.enum(["unmatched", "suggested", "matched", "ignored"]),
  suggestedInvoiceId: z.string().nullable(),
  receiptId: z.string().nullable(),
});

export const importBankLines = endpoint({
  id: "security.bank.import",
  method: "POST",
  path: `${Base}/bank-lines`,
  auth: "user",
  summary:
    "Import bank or mobile-money statement lines (money in positive). Lines that equal an open invoice's expected payment are suggested; a repeated line is ignored.",
  params: OrgParams,
  body: z.object({
    lines: z
      .array(
        z.object({
          date: IsoDate,
          description: z.string().trim().min(1).max(160),
          reference: z.string().trim().min(1).max(80),
          amountMinor: MinorUnits.refine((n) => n !== 0, "Amount cannot be zero"),
        }),
      )
      .min(1)
      .max(500),
  }),
  response: z.object({ added: z.number().int(), suggested: z.number().int(), lines: z.array(BankLine) }),
});

export const listBankLines = endpoint({
  id: "security.bank.list",
  method: "GET",
  path: `${Base}/bank-lines`,
  auth: "user",
  summary: "Statement lines still to reconcile, then the reconciled ones.",
  params: OrgParams,
  response: z.object({ lines: z.array(BankLine) }),
});

export const matchBankLine = endpoint({
  id: "security.bank.match",
  method: "POST",
  path: `${Base}/bank-lines/:lineId/match`,
  auth: "user",
  summary: "Confirm a money-in line against an invoice: records the receipt (the bank line is its evidence).",
  params: OrgParams.extend({ lineId: Id }),
  body: z.object({ invoiceId: Id, method: z.enum(PAYMENT_METHODS) }),
  response: z.object({ line: BankLine, receipt: Receipt }),
});

// ------------------------------------------------------------------ payroll inputs and costs (post to the ledger)
export const PayrollRun = z.object({
  id: z.string(),
  number: z.string(),
  period: z.string(),
  status: z.enum(["prepared", "approved", "paid"]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  grossMinor: z.number().int(),
  employeeDeductionsMinor: z.number().int(),
  incomeTaxMinor: z.number().int(),
  employerContributionsMinor: z.number().int(),
  netMinor: z.number().int(),
  journalId: z.string().nullable(),
  paidOn: IsoDate.nullable(),
  lines: z.array(
    z.object({
      guardId: z.string(),
      name: z.string(),
      grade: z.string(),
      normalMinutes: z.number().int(),
      overtimeMinutes: z.number().int(),
      holidayMinutes: z.number().int(),
      grossMinor: z.number().int(),
      deductions: z.array(z.object({ code: z.string(), amountMinor: z.number().int() })),
      incomeTaxMinor: z.number().int(),
      employer: z.array(z.object({ code: z.string(), amountMinor: z.number().int() })),
      netMinor: z.number().int(),
    }),
  ),
  siteCosts: z.array(z.object({ siteId: z.string(), grossMinor: z.number().int(), employerMinor: z.number().int() })),
  /** Paying salaries needs a bank / mobile-money payout connection. */
  payout: z.string(),
});
export type PayrollRun = z.infer<typeof PayrollRun>;

export const preparePayroll = endpoint({
  id: "security.payroll.prepare",
  method: "POST",
  path: `${Base}/payroll`,
  auth: "user",
  summary:
    "Prepare a month's payroll inputs from approved timesheets and the configured pay rates, deductions and tax bands.",
  params: OrgParams,
  body: z.object({ period: IsoMonth }),
  response: PayrollRun,
  status: 201,
});

export const getPayroll = endpoint({
  id: "security.payroll.get",
  method: "GET",
  path: `${Base}/payroll/:period`,
  auth: "user",
  summary: "A month's payroll run.",
  params: OrgParams.extend({ period: IsoMonth }),
  response: PayrollRun,
});

export const approvePayroll = endpoint({
  id: "security.payroll.approve",
  method: "POST",
  path: `${Base}/payroll/:period/approve`,
  auth: "user",
  summary:
    "Approve the payroll (someone other than its preparer). Wages, contributions and liabilities post to the ledger.",
  params: OrgParams.extend({ period: IsoMonth }),
  response: PayrollRun,
});

export const recordPayrollPayment = endpoint({
  id: "security.payroll.recordPayment",
  method: "POST",
  path: `${Base}/payroll/:period/paid`,
  auth: "user",
  summary: "Record that net wages were paid (outside PALTAS); clears net wages payable against the bank.",
  params: OrgParams.extend({ period: IsoMonth }),
  body: z.object({ date: IsoDate, reference: z.string().trim().min(2).max(80) }),
  response: PayrollRun,
});

export const COST_ACCOUNTS = ["5830", "5840", "5850", "5860", "5870"] as const;
export const postCost = endpoint({
  id: "security.costs.post",
  method: "POST",
  path: `${Base}/costs`,
  auth: "user",
  summary:
    "Post a direct cost (5830 uniforms and kit, 5840 training and licences, 5850 vehicles and fuel, 5860 communications, 5870 bank charges), optionally for one site.",
  params: OrgParams,
  body: z.object({
    account: z.enum(COST_ACCOUNTS),
    siteId: Id.optional(),
    date: IsoDate,
    description: z.string().trim().min(2).max(200),
    amountMinor: PositiveMinorUnits,
    paidFrom: z.enum(["bank", "payable"]),
  }),
  response: z.object({ id: z.string(), number: z.string(), journalId: z.string() }),
  status: 201,
});

export const recordRemittance = endpoint({
  id: "security.remittances.record",
  method: "POST",
  path: `${Base}/remittances`,
  auth: "user",
  summary: "Record a payment of income tax (2810) or statutory deductions (2820) to the authority. Recorded only.",
  params: OrgParams,
  body: z.object({
    account: z.enum(["2810", "2820"]),
    date: IsoDate,
    amountMinor: PositiveMinorUnits,
    reference: z.string().trim().min(2).max(80),
  }),
  response: z.object({ id: z.string(), number: z.string(), journalId: z.string() }),
  status: 201,
});

// ------------------------------------------------------------------ reports (from the ledger) and the client portal
export const Alert = z.object({
  kind: z.enum(["alarm", "no_show", "missed_checkpoint", "licence", "training", "open_shift", "overdue"]),
  severity: z.enum(["critical", "warning", "notice"]),
  title: z.string(),
  ref: z.string(),
});

export const dashboard = endpoint({
  id: "security.dashboard",
  method: "GET",
  path: `${Base}/dashboard`,
  auth: "user",
  summary: "Operations overview: guards on duty, open shifts, incidents, patrol compliance, active alarms, alerts.",
  params: OrgParams,
  response: z.object({
    date: IsoDate,
    guardsOnDuty: z.number().int(),
    shiftsNow: z.number().int(),
    openShiftsNext7Days: z.number().int(),
    incidentsToday: z.number().int(),
    openIncidents: z.number().int(),
    highSeverityOpen: z.number().int(),
    patrolCompliancePct: z.number().nullable(),
    activeAlarms: z.number().int(),
    visitorsOnSite: z.number().int(),
    watchlistHitsToday: z.number().int(),
    alerts: z.array(Alert),
  }),
});

export const FinanceKpis = z.object({
  from: IsoDate,
  to: IsoDate,
  contractRevenueMinor: z.number().int(),
  extraCoverRevenueMinor: z.number().int(),
  lateFeeRevenueMinor: z.number().int(),
  otherRevenueMinor: z.number().int(),
  revenueMinor: z.number().int(),
  wagesMinor: z.number().int(),
  employerContributionsMinor: z.number().int(),
  directCostsMinor: z.number().int(),
  grossProfitMinor: z.number().int(),
  vatChargedMinor: z.number().int(),
  cashReceivedMinor: z.number().int(),
  /** Receivables (1100) from security postings, at the end date. */
  receivablesMinor: z.number().int(),
});

export const financeKpis = endpoint({
  id: "security.finance.kpis",
  method: "GET",
  path: `${Base}/finance/kpis`,
  auth: "user",
  summary: "Revenue, wages, costs, profit, cash and receivables — read from the security postings in the ledger.",
  params: OrgParams,
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: FinanceKpis,
});

export const siteProfit = endpoint({
  id: "security.reports.siteProfit",
  method: "GET",
  path: `${Base}/reports/site-profit`,
  auth: "user",
  summary: "Per site: billed revenue, guard wages and employer contributions, and direct costs, from the ledger.",
  params: OrgParams,
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({
    sites: z.array(
      z.object({
        siteId: z.string().nullable(),
        name: z.string(),
        revenueMinor: z.number().int(),
        payrollCostMinor: z.number().int(),
        directCostMinor: z.number().int(),
        profitMinor: z.number().int(),
      }),
    ),
    total: z.object({
      revenueMinor: z.number().int(),
      payrollCostMinor: z.number().int(),
      directCostMinor: z.number().int(),
      profitMinor: z.number().int(),
    }),
  }),
});

export const SiteService = z.object({
  siteId: z.string(),
  name: z.string(),
  shiftsRequired: z.number().int(),
  shiftsCovered: z.number().int(),
  noShows: z.number().int(),
  coveragePct: z.number().nullable(),
  patrolCompliancePct: z.number().nullable(),
  patrolTargetPct: z.number().nullable(),
  patrolTargetMet: z.boolean().nullable(),
  incidents: z.number().int(),
  highSeverityIncidents: z.number().int(),
  alarms: z.number().int(),
  averageResponseMinutes: z.number().nullable(),
  responseTargetMinutes: z.number().int().nullable(),
  responseTargetMet: z.boolean().nullable(),
});

export const ClientReport = z.object({
  clientId: z.string(),
  name: z.string(),
  month: IsoMonth,
  sites: z.array(SiteService),
  invoicedMinor: z.number().int(),
  paidMinor: z.number().int(),
  balanceMinor: z.number().int(),
});

export const clientReport = endpoint({
  id: "security.clients.report",
  method: "GET",
  path: `${Base}/clients/:clientId/report`,
  auth: "user",
  summary:
    "The monthly service report for a client: coverage, patrols and response against the contract's service levels, invoices and balance.",
  params: OrgParams.extend({ clientId: Id }),
  query: z.object({ month: IsoMonth }),
  response: ClientReport,
});

export const portal = endpoint({
  id: "security.portal",
  method: "GET",
  path: `${Base}/portal`,
  auth: "user",
  summary:
    "The client portal: only the clients this person is linked to — their service report, invoices and payments.",
  params: OrgParams,
  query: z.object({ month: IsoMonth }),
  response: z.object({
    clients: z.array(z.object({ report: ClientReport, invoices: z.array(Invoice), receipts: z.array(Receipt) })),
  }),
});

export const integrations = endpoint({
  id: "security.integrations",
  method: "GET",
  path: `${Base}/integrations`,
  auth: "user",
  summary: "Every external connection and its state (test adapters until real ones are installed).",
  params: OrgParams,
  response: z.object({
    accessControl: IntegrationState,
    cctv: IntegrationState,
    alarmMonitoring: IntegrationState,
    messaging: IntegrationState,
    biometrics: IntegrationState,
    taxAuthority: IntegrationState,
    payrollPayout: IntegrationState,
  }),
});

export const sendMessage = endpoint({
  id: "security.messages.send",
  method: "POST",
  path: `${Base}/messages`,
  auth: "user",
  summary: "Message one guard or broadcast to the guards on duty. Recorded; not delivered (no messaging provider).",
  params: OrgParams,
  body: z.object({
    to: z.union([z.object({ guardId: Id }), z.object({ onDuty: z.literal(true), at: Moment })]),
    text: z.string().trim().min(2).max(1000),
  }),
  response: z.object({ recipients: z.number().int(), delivery: z.string() }),
});
