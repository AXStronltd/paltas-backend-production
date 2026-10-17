// Property Management (product "property", also the Almas Tower pilot): portfolio, owners and management agreements,
// leases, rent and charge invoicing, recorded payments with allocation and receipts, arrears and late fees, deposits,
// owner statements and payouts, supplier bills, maintenance and work orders, inspections, CRM pipeline (on the one
// contact store), notices and documents, bank reconciliation of recorded money, dashboards, and the tenant and owner
// portals.
//
// Rules the server enforces (and the database backs up):
// - every money movement posts to the organisation's ONE ledger (trust accounting: rent is the owner's money, 2150 →
//   2250; deposits are a liability, 2300; only management fees 4650 and agency charges 4660 are income);
// - an invoice run is idempotent per lease and month: running it again creates nothing new;
// - payments are RECORDED, never processed; messages and notices are RECORDED, never sent;
// - deposit refunds, owner payouts, supplier bills, purchase orders, applications and bank reconciliations need a
//   second person; nothing posts into a closed month;
// - another organisation's records answer "not found"; a tenant or owner sees only their own records.
import { z } from "zod";
import { IsoDate, IsoDateTime, IsoMonth, MinorUnits, PositiveMinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { Contact, Message } from "./contacts.js";
import { OrgParams } from "./organisations.js";

// ------------------------------------------------------------------ building blocks
const Id = z.string().min(1).max(80);
const Name = z.string().trim().min(1).max(160);
const Text = z.string().trim().max(2000);
const NonNegativeMinor = MinorUnits.min(0);
/** A percentage with at most two decimals, e.g. 10 or 7.5. Stored as basis points. */
const Pct = z
  .number()
  .min(0)
  .max(50)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Use at most two decimals");
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:00");
const FileName = z.string().trim().min(1).max(200);

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const Priority = z.enum(PRIORITIES);
export const PAYEES = ["owner", "agency"] as const;
export const Payee = z.enum(PAYEES);
export const PAYMENT_METHODS = ["bank_transfer", "mobile_money", "cash", "cheque", "card", "other"] as const;
export const PaymentMethod = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

// ------------------------------------------------------------------ settings and catalogue
export const Settings = z.object({
  /** VAT on management fees and VAT-able agency charges (0 = not VAT-registered). */
  vatPct: z.number(),
  vatFrom: IsoDate.nullable(),
  /** Purchase-order approval limit per role, minor units (finance director and org admin: unlimited). */
  poLimits: z.record(z.string(), NonNegativeMinor),
  /** A supplier invoice may exceed its purchase order by this much before it is held. */
  matchTolerancePct: z.number(),
  /** Days to finish a work order, by priority. */
  slaDays: z.object({
    urgent: z.number().int(),
    high: z.number().int(),
    normal: z.number().int(),
    low: z.number().int(),
  }),
});
export type Settings = z.infer<typeof Settings>;

export const ChargeType = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  /** owner: the owner's money, like rent; agency: the agency's income. */
  payee: Payee,
  feeApplies: z.boolean(),
  vatApplies: z.boolean(),
  metered: z.boolean(),
  unitName: z.string(),
  /** Metered: price per unit consumed; otherwise the default amount (0 = set per lease). */
  rateMinor: NonNegativeMinor,
  active: z.boolean(),
});
export type ChargeType = z.infer<typeof ChargeType>;

const ChargeTypeFields = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{2,16}$/, "Use 2–16 capital letters, digits or _"),
  name: Name,
  payee: Payee,
  feeApplies: z.boolean().default(false),
  vatApplies: z.boolean().default(false),
  metered: z.boolean().default(false),
  unitName: z.string().trim().max(20).default(""),
  rateMinor: NonNegativeMinor.default(0),
});

// ------------------------------------------------------------------ portfolio
export const LateFeePolicy = z.object({
  enabled: z.boolean(),
  /** Percentage of the overdue balance. */
  pct: Pct,
  graceDays: z.number().int().min(0).max(90),
  minMinor: NonNegativeMinor,
  payee: Payee,
});
export type LateFeePolicy = z.infer<typeof LateFeePolicy>;

export const Building = z.object({
  id: z.string(),
  name: z.string(),
  floors: z.number().int().nullable(),
  isArchived: z.boolean(),
  unitCount: z.number().int().nonnegative(),
  activeLeaseCount: z.number().int().nonnegative(),
});

export const Unit = z.object({
  id: z.string(),
  propertyId: z.string(),
  buildingId: z.string().nullable(),
  unitNo: z.string(),
  floor: z.string().nullable(),
  unitType: z.string().nullable(),
  bedrooms: z.number().int().nullable(),
  toilets: z.number().int().nullable(),
  areaSqm: z.number().nullable(),
  marketRentMinor: MinorUnits.nullable(),
  status: z.enum(["available", "off_market"]),
  /** From the leases: let while an active lease covers today. */
  occupancy: z.enum(["let", "vacant"]),
  leaseId: z.string().nullable(),
  ownerId: z.string().nullable(),
});
export type Building = z.infer<typeof Building>;

export type Unit = z.infer<typeof Unit>;

export const Automation = z.object({
  /** The monthly billing run (rent, then charges) on this day of the month, by the PALTAS scheduler. */
  monthlyBilling: z.boolean(),
  billingDay: z.number().int().min(1).max(28),
  /** Late fees charged every morning per the property's policy. */
  lateFees: z.boolean(),
});
export type Automation = z.infer<typeof Automation>;

export const PropertyRecord = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  kind: z.enum(["residential", "commercial", "mixed"]),
  lateFee: LateFeePolicy,
  automation: Automation,
  buildings: z.array(Building),
  unitCount: z.number().int(),
  letCount: z.number().int(),
  ownerId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type PropertyRecord = z.infer<typeof PropertyRecord>;

const PropertyFields = z.object({
  name: Name,
  address: Text.default(""),
  kind: z.enum(["residential", "commercial", "mixed"]).default("residential"),
  lateFee: LateFeePolicy.default({ enabled: false, pct: 0, graceDays: 0, minMinor: 0, payee: "owner" }),
});

const UnitFields = z.object({
  unitNo: z.string().trim().min(1).max(30),
  buildingId: Id.optional(),
  floor: z.string().trim().max(20).optional(),
  unitType: z.string().trim().max(60).optional(),
  bedrooms: z.number().int().min(0).max(50).optional(),
  toilets: z.number().int().min(0).max(50).optional(),
  areaSqm: z.number().min(0).max(1_000_000).optional(),
  marketRentMinor: NonNegativeMinor.optional(),
  status: z.enum(["available", "off_market"]).default("available"),
});

export const Agreement = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  unitId: z.string().nullable(),
  ownerId: z.string(),
  ownerName: z.string(),
  /** Management fee, % of rent collected. */
  feePct: z.number(),
  /** Bills above this need the owner's approval. */
  authorityMinor: NonNegativeMinor,
  payoutDay: z.number().int(),
  startDate: IsoDate,
  endDate: IsoDate.nullable(),
  status: z.enum(["active", "ended"]),
});
export type Agreement = z.infer<typeof Agreement>;

export const OwnerSummary = z.object({
  ownerId: z.string(),
  name: z.string(),
  bankAccountMasked: z.string(),
  bankVerified: z.boolean(),
  reserveMinor: NonNegativeMinor,
  /** Owner funds held now (from the ledger, account 2250). */
  fundsMinor: MinorUnits,
  agreements: z.array(Agreement),
});
export type OwnerSummary = z.infer<typeof OwnerSummary>;

// ------------------------------------------------------------------ leases
export const LEASE_STATUSES = ["draft", "active", "ended", "cancelled"] as const;
export const LeaseStatus = z.enum(LEASE_STATUSES);
export const RentStep = z.object({
  effectiveFrom: IsoDate,
  rentMinor: PositiveMinorUnits,
  reason: z.enum(["start", "escalation", "renewal", "review"]),
});
export type RentStep = z.infer<typeof RentStep>;

export const LeaseCharge = z.object({
  chargeTypeId: z.string(),
  code: z.string(),
  name: z.string(),
  /** null for metered charges (billed from meter readings). */
  amountMinor: PositiveMinorUnits.nullable(),
});
export type LeaseCharge = z.infer<typeof LeaseCharge>;

export const Lease = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  unitId: z.string(),
  unitNo: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  status: LeaseStatus,
  startDate: IsoDate,
  /** null = periodic (month to month). */
  endDate: IsoDate.nullable(),
  rentMinor: PositiveMinorUnits,
  /** The rent in force today (after escalations and renewals). */
  currentRentMinor: PositiveMinorUnits,
  depositMinor: NonNegativeMinor,
  depositMode: z.enum(["collect", "held", "none"]),
  /** Deposit actually held for this lease (collected, or brought over by a migration). */
  depositHeldMinor: NonNegativeMinor,
  dueDay: z.number().int(),
  escalationPct: z.number(),
  escalationMonths: z.number().int().nullable(),
  noticeDays: z.number().int(),
  noticeGivenOn: IsoDate.nullable(),
  moveOutDate: IsoDate.nullable(),
  endedReason: z.string().nullable(),
  signedOn: IsoDate.nullable(),
  migrated: z.boolean(),
  rentSteps: z.array(RentStep),
  charges: z.array(LeaseCharge),
});
export type Lease = z.infer<typeof Lease>;

const LeaseChargeInput = z.object({ chargeTypeId: Id, amountMinor: PositiveMinorUnits.nullable().default(null) });

const LeaseTerms = z.object({
  startDate: IsoDate,
  endDate: IsoDate.nullable().default(null),
  rentMinor: PositiveMinorUnits,
  depositMinor: NonNegativeMinor.default(0),
  depositMode: z.enum(["collect", "held", "none"]).default("collect"),
  dueDay: z.number().int().min(1).max(28).default(5),
  escalationPct: Pct.default(0),
  escalationMonths: z.number().int().min(1).max(120).nullable().default(null),
  noticeDays: z.number().int().min(0).max(365).default(30),
  charges: z.array(LeaseChargeInput).max(20).default([]),
});

// ------------------------------------------------------------------ invoices and payments
export const INVOICE_KINDS = ["rent", "deposit", "charge", "late_fee", "opening"] as const;
export const InvoiceKind = z.enum(INVOICE_KINDS);
export const InvoiceLine = z.object({
  lineNo: z.number().int(),
  code: z.string(),
  description: z.string(),
  quantity: z.number(),
  rateMinor: MinorUnits,
  amountMinor: PositiveMinorUnits,
  payee: z.enum(["owner", "agency", "deposit"]),
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const Allocation = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  amountMinor: PositiveMinorUnits,
  source: z.enum(["payment", "credit", "deposit", "credit_note"]),
  sourceId: z.string(),
  date: IsoDate,
});
export type Allocation = z.infer<typeof Allocation>;

export const Invoice = z.object({
  id: z.string(),
  number: z.string(),
  kind: InvoiceKind,
  leaseId: z.string().nullable(),
  tenantId: z.string(),
  tenantName: z.string(),
  unitId: z.string().nullable(),
  unitNo: z.string().nullable(),
  propertyId: z.string().nullable(),
  ownerId: z.string().nullable(),
  period: IsoMonth.nullable(),
  issueDate: IsoDate,
  dueDate: IsoDate,
  amountMinor: PositiveMinorUnits,
  paidMinor: NonNegativeMinor,
  creditedMinor: NonNegativeMinor,
  balanceMinor: NonNegativeMinor,
  status: z.enum(["open", "part_paid", "paid"]),
  /** Days past the due date while a balance remains (0 otherwise). */
  overdueDays: z.number().int(),
  note: z.string(),
  sourceInvoiceId: z.string().nullable(),
  migrated: z.boolean(),
  lines: z.array(InvoiceLine),
  allocations: z.array(Allocation),
  journalId: z.string().nullable(),
});
export type Invoice = z.infer<typeof Invoice>;

export const Payment = z.object({
  id: z.string(),
  number: z.string(),
  receiptNumber: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  date: IsoDate,
  amountMinor: PositiveMinorUnits,
  method: PaymentMethod,
  reference: z.string(),
  note: z.string(),
  allocatedMinor: NonNegativeMinor,
  /** Held as the tenant's credit (2310) until applied. */
  unallocatedMinor: NonNegativeMinor,
  allocations: z.array(Allocation),
  /** Matched to a bank statement line. A recorded payment is never "processed" by PALTAS. */
  bankMatched: z.boolean(),
  recordedBy: z.string(),
  journalId: z.string().nullable(),
});
export type Payment = z.infer<typeof Payment>;

export const PaymentClaim = z.object({
  id: z.string(),
  tenantId: z.string(),
  amountMinor: PositiveMinorUnits,
  date: IsoDate,
  method: z.string(),
  reference: z.string(),
  note: z.string(),
  status: z.enum(["pending", "matched", "rejected"]),
  paymentId: z.string().nullable(),
  reason: z.string().nullable(),
  submittedAt: IsoDateTime,
});
export type PaymentClaim = z.infer<typeof PaymentClaim>;

export const DepositRefund = z.object({
  id: z.string(),
  number: z.string(),
  leaseId: z.string(),
  tenantId: z.string(),
  heldMinor: PositiveMinorUnits,
  /** Applied to the tenant's unpaid invoices. */
  arrearsMinor: NonNegativeMinor,
  /** Kept for the owner (damage, cleaning …), with reasons. */
  deductionsMinor: NonNegativeMinor,
  deductions: z.array(z.object({ amountMinor: PositiveMinorUnits, reason: z.string() })),
  refundMinor: NonNegativeMinor,
  refundReference: z.string(),
  status: z.enum(["requested", "approved", "rejected"]),
  requestedBy: z.string(),
  decidedBy: z.string().nullable(),
  rejectReason: z.string().nullable(),
  journalId: z.string().nullable(),
});
export type DepositRefund = z.infer<typeof DepositRefund>;

export const BillingRunResult = z.object({
  runId: z.string(),
  propertyId: z.string(),
  period: IsoMonth,
  kind: z.enum(["rent", "charges"]),
  created: z.array(Invoice),
  /** Leases already billed for this month (the run is idempotent) or not billable, with the reason. */
  skipped: z.array(z.object({ leaseId: z.string(), reason: z.string() })),
});
export type BillingRunResult = z.infer<typeof BillingRunResult>;

export const MeterReading = z.object({
  id: z.string(),
  unitId: z.string(),
  unitNo: z.string(),
  chargeTypeId: z.string(),
  code: z.string(),
  period: IsoMonth,
  previous: z.number(),
  current: z.number(),
  consumption: z.number(),
});
export type MeterReading = z.infer<typeof MeterReading>;

// ------------------------------------------------------------------ owners
export const OwnerStatement = z.object({
  ownerId: z.string(),
  ownerName: z.string(),
  from: IsoDate,
  to: IsoDate,
  openingMinor: MinorUnits,
  /** Rent and owner charges collected (credited to the owner). */
  collectedMinor: MinorUnits,
  managementFeesMinor: MinorUnits,
  vatOnFeesMinor: MinorUnits,
  expensesMinor: MinorUnits,
  depositDeductionsMinor: MinorUnits,
  payoutsMinor: MinorUnits,
  openingBroughtForwardMinor: MinorUnits,
  otherMinor: MinorUnits,
  closingMinor: MinorUnits,
  /** The owner's 2250 balance in the ledger at `to`; equals closingMinor. */
  ledgerClosingMinor: MinorUnits,
  agrees: z.boolean(),
  lines: z.array(
    z.object({
      date: IsoDate,
      journalId: z.string().nullable(),
      kind: z.string(),
      memo: z.string(),
      creditMinor: NonNegativeMinor,
      debitMinor: NonNegativeMinor,
    }),
  ),
});
export type OwnerStatement = z.infer<typeof OwnerStatement>;

export const Payout = z.object({
  id: z.string(),
  number: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  amountMinor: PositiveMinorUnits,
  balanceMinor: MinorUnits,
  reserveMinor: NonNegativeMinor,
  asOf: IsoDate,
  status: z.enum(["prepared", "approved", "released", "paid", "cancelled"]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  releasedBy: z.string().nullable(),
  releaseDate: IsoDate.nullable(),
  journalId: z.string().nullable(),
});
export type Payout = z.infer<typeof Payout>;

// ------------------------------------------------------------------ bills and maintenance
export const BILL_STATUSES = ["submitted", "held", "awaiting_owner", "approved", "rejected", "paid"] as const;
export const Bill = z.object({
  id: z.string(),
  number: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  propertyId: z.string().nullable(),
  unitId: z.string().nullable(),
  workOrderId: z.string().nullable(),
  description: z.string(),
  supplierInvoiceNo: z.string().nullable(),
  billDate: IsoDate,
  dueDate: IsoDate.nullable(),
  amountMinor: PositiveMinorUnits,
  recoverFrom: z.enum(["owner", "company"]),
  ownerId: z.string().nullable(),
  status: z.enum(BILL_STATUSES),
  matchIssues: z.array(z.string()),
  submittedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  ownerApprovedBy: z.string().nullable(),
  paidBy: z.string().nullable(),
  paidDate: IsoDate.nullable(),
  paidReference: z.string().nullable(),
  migrated: z.boolean(),
});
export type Bill = z.infer<typeof Bill>;

export const MaintenanceRequest = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  unitId: z.string().nullable(),
  reporterId: z.string().nullable(),
  title: z.string(),
  category: z.string(),
  priority: Priority,
  status: z.enum(["open", "assigned", "resolved", "closed"]),
  source: z.enum(["staff", "tenant_portal", "inspection"]),
  openedAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
  workOrderId: z.string().nullable(),
});
export type MaintenanceRequest = z.infer<typeof MaintenanceRequest>;

export const WORK_ORDER_STATUSES = [
  "requesting_quotes",
  "quoted",
  "po_pending",
  "awaiting_owner",
  "approved",
  "completed",
  "verified",
  "billed",
  "cancelled",
] as const;
export const WorkOrder = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  unitId: z.string().nullable(),
  requestId: z.string().nullable(),
  scope: z.string(),
  priority: Priority,
  status: z.enum(WORK_ORDER_STATUSES),
  dueDate: IsoDate,
  overdue: z.boolean(),
  quotes: z.array(
    z.object({
      supplierId: z.string(),
      supplierName: z.string(),
      amountMinor: PositiveMinorUnits,
      days: z.number().int().nullable(),
      fileName: z.string(),
    }),
  ),
  po: z
    .object({
      number: z.string(),
      supplierId: z.string(),
      amountMinor: PositiveMinorUnits,
      raisedBy: z.string(),
      approvedBy: z.string().nullable(),
      needsOwner: z.boolean(),
      ownerApprovedBy: z.string().nullable(),
    })
    .nullable(),
  completion: z
    .object({ by: z.string(), at: IsoDateTime, notes: z.string(), evidence: z.array(z.string()) })
    .nullable(),
  verifiedBy: z.string().nullable(),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

export const INSPECTION_CONDITIONS = ["good", "fair", "needs_repair", "damaged"] as const;
export const InspectionItem = z.object({
  area: z.string().trim().min(1).max(80),
  condition: z.enum(INSPECTION_CONDITIONS),
  note: z.string().trim().max(500).default(""),
});
export type InspectionItem = z.infer<typeof InspectionItem>;

export const Inspection = z.object({
  id: z.string(),
  number: z.string(),
  propertyId: z.string(),
  unitId: z.string().nullable(),
  leaseId: z.string().nullable(),
  kind: z.enum(["move_in", "move_out", "routine"]),
  scheduledDate: IsoDate,
  status: z.enum(["scheduled", "completed"]),
  items: z.array(InspectionItem),
  completedBy: z.string().nullable(),
  /** Maintenance requests opened from items needing repair. */
  requestIds: z.array(z.string()),
});
export type Inspection = z.infer<typeof Inspection>;

// ------------------------------------------------------------------ CRM pipeline
export const LEAD_STAGES = [
  "new",
  "contacted",
  "qualified",
  "viewing",
  "viewed",
  "application",
  "approved",
  "won",
  "lost",
] as const;
export const LeadStage = z.enum(LEAD_STAGES);
export const LOST_REASONS = [
  "price",
  "location",
  "unit_taken",
  "no_response",
  "chose_competitor",
  "not_qualified",
  "other",
] as const;

export const Lead = z.object({
  id: z.string(),
  number: z.string(),
  contactId: z.string(),
  contactName: z.string(),
  source: z.string(),
  campaign: z.string().nullable(),
  unitId: z.string().nullable(),
  budgetMinor: NonNegativeMinor.nullable(),
  bedrooms: z.number().int().nullable(),
  moveIn: IsoDate.nullable(),
  stage: LeadStage,
  stageAt: IsoDateTime,
  agentId: z.string().nullable(),
  lostReason: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Lead = z.infer<typeof Lead>;

export const Viewing = z.object({
  id: z.string(),
  leadId: z.string(),
  contactId: z.string(),
  unitId: z.string(),
  agentId: z.string(),
  date: IsoDate,
  time: Time,
  status: z.enum(["scheduled", "completed", "no_show", "cancelled"]),
  feedback: z.string(),
  interest: z.number().int().nullable(),
});
export type Viewing = z.infer<typeof Viewing>;

export const Application = z.object({
  id: z.string(),
  number: z.string(),
  leadId: z.string(),
  contactId: z.string(),
  unitId: z.string(),
  status: z.enum(["submitted", "screening", "approved", "rejected", "withdrawn", "converted"]),
  employer: z.string(),
  incomeMinor: NonNegativeMinor.nullable(),
  occupants: z.number().int(),
  offer: z.object({
    rentMinor: PositiveMinorUnits,
    depositMinor: NonNegativeMinor,
    startDate: IsoDate,
    months: z.number().int(),
  }),
  checks: z.object({ identity: z.boolean(), income: z.boolean(), reference: z.boolean() }),
  screenedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  leaseId: z.string().nullable(),
});
export type Application = z.infer<typeof Application>;

// ------------------------------------------------------------------ notices, documents, bank
export const Notice = z.object({
  id: z.string(),
  propertyId: z.string(),
  title: z.string(),
  body: z.string(),
  channel: z.enum(["email", "sms", "whatsapp", "inapp"]),
  recipients: z.number().int(),
  /** Recorded for delivery — NOT sent (no delivery provider is connected). */
  recorded: z.number().int(),
  /** Not recorded for delivery: the tenant has not consented to this channel. */
  blocked: z.number().int(),
  publishedAt: IsoDateTime,
});
export type Notice = z.infer<typeof Notice>;

export const DOCUMENT_LINKS = ["property", "unit", "lease", "contact", "work_order", "inspection", "bill"] as const;
export const DocumentRecord = z.object({
  id: z.string(),
  name: z.string(),
  docType: z.string(),
  fileStored: z.boolean().default(false),
  linkEntity: z.string().nullable(),
  linkId: z.string().nullable(),
  filename: z.string(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  visibility: z.enum(["staff", "tenant", "owner"]),
  createdAt: IsoDateTime,
});
export type DocumentRecord = z.infer<typeof DocumentRecord>;

export const BankLine = z.object({
  id: z.string(),
  accountCode: z.string(),
  date: IsoDate,
  amountMinor: MinorUnits,
  reference: z.string(),
  description: z.string(),
  status: z.enum(["unmatched", "matched", "ignored"]),
  matchedKind: z.enum(["payment", "payout", "bill_payment", "deposit_refund"]).nullable(),
  matchedId: z.string().nullable(),
  note: z.string(),
});
export type BankLine = z.infer<typeof BankLine>;

export const Reconciliation = z.object({
  id: z.string(),
  accountCode: z.string(),
  statementDate: IsoDate,
  statementBalanceMinor: MinorUnits,
  /** Ledger balance of the account at the statement date. */
  ledgerBalanceMinor: MinorUnits,
  /** Recorded receipts not yet on the statement. */
  unclearedInMinor: MinorUnits,
  /** Recorded payouts, bill payments and refunds not yet on the statement. */
  unclearedOutMinor: MinorUnits,
  /** Statement lines not matched to anything recorded. */
  unmatchedLinesMinor: MinorUnits,
  /** statement + uncleared in − uncleared out − unmatched lines − ledger: 0 when reconciled. */
  differenceMinor: MinorUnits,
  status: z.enum(["prepared", "approved"]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

// ------------------------------------------------------------------ reports
const LedgerCheck = z.object({ recordsMinor: MinorUnits, ledgerMinor: MinorUnits, agrees: z.boolean() });

export const Dashboard = z.object({
  asOf: IsoDate,
  month: IsoMonth,
  propertyId: z.string().nullable(),
  occupancy: z.object({
    units: z.number().int(),
    let: z.number().int(),
    vacant: z.number().int(),
    offMarket: z.number().int(),
    ratePct: z.number(),
  }),
  billedMinor: NonNegativeMinor,
  collectedMinor: NonNegativeMinor,
  collectionRatePct: z.number(),
  arrears: z.object({
    totalMinor: NonNegativeMinor,
    overdueMinor: NonNegativeMinor,
    tenantsInArrears: z.number().int(),
  }),
  leasesExpiring60Days: z.number().int(),
  openMaintenance: z.number().int(),
  /** Every money figure agrees with the ledger (organisation-wide; filtered views show records only). */
  ledger: z.object({
    receivables: LedgerCheck,
    depositsHeld: LedgerCheck,
    ownerFunds: LedgerCheck,
    tenantCredits: LedgerCheck,
  }),
});
export type Dashboard = z.infer<typeof Dashboard>;

export const AgedReceivables = z.object({
  asOf: IsoDate,
  rows: z.array(
    z.object({
      tenantId: z.string(),
      tenantName: z.string(),
      currentMinor: NonNegativeMinor,
      d1to30Minor: NonNegativeMinor,
      d31to60Minor: NonNegativeMinor,
      d61to90Minor: NonNegativeMinor,
      over90Minor: NonNegativeMinor,
      totalMinor: NonNegativeMinor,
      creditMinor: NonNegativeMinor,
    }),
  ),
  totals: z.object({
    currentMinor: NonNegativeMinor,
    d1to30Minor: NonNegativeMinor,
    d31to60Minor: NonNegativeMinor,
    d61to90Minor: NonNegativeMinor,
    over90Minor: NonNegativeMinor,
    totalMinor: NonNegativeMinor,
  }),
  ledger: LedgerCheck,
});
export type AgedReceivables = z.infer<typeof AgedReceivables>;

export const RentRoll = z.object({
  asOf: IsoDate,
  rows: z.array(
    z.object({
      unitId: z.string(),
      unitNo: z.string(),
      propertyId: z.string(),
      buildingId: z.string().nullable(),
      blockName: z.string().nullable(),
      floor: z.string().nullable(),
      blockArchived: z.boolean(),
      status: z.enum(["let", "vacant", "off_market"]),
      leaseId: z.string().nullable(),
      tenantId: z.string().nullable(),
      tenantName: z.string().nullable(),
      rentMinor: NonNegativeMinor,
      marketRentMinor: NonNegativeMinor.nullable(),
      leaseEnd: IsoDate.nullable(),
      balanceMinor: NonNegativeMinor,
    }),
  ),
  totals: z.object({ rentMinor: NonNegativeMinor, balanceMinor: NonNegativeMinor }),
});
export type RentRoll = z.infer<typeof RentRoll>;

export const TenantStatement = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  invoices: z.array(Invoice),
  payments: z.array(Payment),
  balanceMinor: NonNegativeMinor,
  creditMinor: NonNegativeMinor,
  depositHeldMinor: NonNegativeMinor,
  lines: z.array(
    z.object({
      date: IsoDate,
      kind: z.string(),
      ref: z.string(),
      debitMinor: NonNegativeMinor,
      creditMinor: NonNegativeMinor,
      balanceMinor: MinorUnits,
    }),
  ),
});
export type TenantStatement = z.infer<typeof TenantStatement>;

export const ClientMoney = z.object({
  asOf: IsoDate,
  /** Client account 1040 in the ledger. */
  clientCashMinor: MinorUnits,
  ownerFundsMinor: MinorUnits,
  depositsHeldMinor: MinorUnits,
  tenantCreditsMinor: MinorUnits,
  /** Money in the client account that belongs to the agency (fees not yet swept) or is short. */
  surplusMinor: MinorUnits,
  /** Client money covers everything owed to owners and tenants. */
  covered: z.boolean(),
  ownersAgree: z.boolean(),
  owners: z.array(z.object({ ownerId: z.string(), name: z.string(), fundsMinor: MinorUnits })),
  unassignedOwnerFundsMinor: MinorUnits,
});
export type ClientMoney = z.infer<typeof ClientMoney>;

// ------------------------------------------------------------------ portals
export const TenantPortal = z.object({
  contact: Contact,
  leases: z.array(Lease),
  invoices: z.array(Invoice),
  payments: z.array(Payment),
  claims: z.array(PaymentClaim),
  requests: z.array(MaintenanceRequest),
  documents: z.array(DocumentRecord),
  balanceMinor: NonNegativeMinor,
  creditMinor: NonNegativeMinor,
});
export type TenantPortal = z.infer<typeof TenantPortal>;

export const OwnerPortal = z.object({
  contact: Contact,
  properties: z.array(PropertyRecord),
  statement: OwnerStatement,
  billsAwaitingApproval: z.array(Bill),
  workOrdersAwaitingApproval: z.array(WorkOrder),
  payouts: z.array(Payout),
  documents: z.array(DocumentRecord).default([]),
});
export type OwnerPortal = z.infer<typeof OwnerPortal>;

// ================================================================== endpoints
const Base = "/api/v1/orgs/:orgId/property";
const P = `${Base}/properties/:propertyId`;
const PropertyParams = OrgParams.extend({ propertyId: Id });
const LeaseParams = OrgParams.extend({ leaseId: Id });
const InvoiceParams = OrgParams.extend({ invoiceId: Id });
const OwnerParams = OrgParams.extend({ ownerId: Id });
const TenantParams = OrgParams.extend({ tenantId: Id });
const BillParams = OrgParams.extend({ billId: Id });
const PayoutParams = OrgParams.extend({ payoutId: Id });
const WoParams = OrgParams.extend({ workOrderId: Id });
const RefundParams = OrgParams.extend({ refundId: Id });

// ---- settings and catalogue
export const getSettings = endpoint({
  id: "property.settings.get",
  method: "GET",
  path: `${Base}/settings`,
  auth: "user",
  summary: "Property Management settings: VAT on fees, purchase-order approval limits, bill match tolerance, SLAs",
  params: OrgParams,
  response: Settings,
});

export const updateSettings = endpoint({
  id: "property.settings.update",
  method: "PUT",
  path: `${Base}/settings`,
  auth: "user",
  summary: "Change the Property Management settings",
  params: OrgParams,
  body: z.object({
    vatPct: Pct.optional(),
    vatFrom: IsoDate.nullable().optional(),
    poLimits: z
      .object({
        property_manager: NonNegativeMinor.optional(),
        accountant: NonNegativeMinor.optional(),
        maintenance_manager: NonNegativeMinor.optional(),
      })
      .optional(),
    matchTolerancePct: Pct.optional(),
    slaDays: z
      .object({
        urgent: z.number().int().min(0).max(60),
        high: z.number().int().min(0).max(60),
        normal: z.number().int().min(0).max(120),
        low: z.number().int().min(0).max(365),
      })
      .optional(),
  }),
  response: Settings,
});

export const listChargeTypes = endpoint({
  id: "property.chargeTypes.list",
  method: "GET",
  path: `${Base}/charge-types`,
  auth: "user",
  summary: "What can be billed besides rent (service charge, metered water, parking, admin fee …)",
  params: OrgParams,
  response: z.object({ chargeTypes: z.array(ChargeType) }),
});

export const createChargeType = endpoint({
  id: "property.chargeTypes.create",
  method: "POST",
  path: `${Base}/charge-types`,
  auth: "user",
  summary: "Add a charge type (an owner charge may carry the management fee; an agency charge may carry VAT)",
  params: OrgParams,
  body: ChargeTypeFields,
  response: ChargeType,
  status: 201,
});

export const updateChargeType = endpoint({
  id: "property.chargeTypes.update",
  method: "PUT",
  path: `${Base}/charge-types/:chargeTypeId`,
  auth: "user",
  summary: "Change a charge type's name, rate or whether it is still used",
  params: OrgParams.extend({ chargeTypeId: Id }),
  body: z.object({ name: Name.optional(), rateMinor: NonNegativeMinor.optional(), active: z.boolean().optional() }),
  response: ChargeType,
});

// ---- portfolio
export const listProperties = endpoint({
  id: "property.properties.list",
  method: "GET",
  path: `${Base}/properties`,
  auth: "user",
  summary: "The organisation's properties with unit counts and occupancy",
  params: OrgParams,
  response: z.object({ properties: z.array(PropertyRecord) }),
});

export const createProperty = endpoint({
  id: "property.properties.create",
  method: "POST",
  path: `${Base}/properties`,
  auth: "user",
  summary: "Add a property (uses one of the plan's building allowances), with its late-fee policy",
  params: OrgParams,
  body: PropertyFields,
  response: PropertyRecord,
  status: 201,
});

export const getProperty = endpoint({
  id: "property.properties.get",
  method: "GET",
  path: P,
  auth: "user",
  summary: "A property file: buildings, units with occupancy, agreements",
  params: PropertyParams,
  response: z.object({ property: PropertyRecord, units: z.array(Unit), agreements: z.array(Agreement) }),
});

export const updateProperty = endpoint({
  id: "property.properties.update",
  method: "PUT",
  path: P,
  auth: "user",
  summary: "Change a property's name, address or late-fee policy",
  params: PropertyParams,
  body: PropertyFields.partial(),
  response: PropertyRecord,
});

export const setAutomation = endpoint({
  id: "property.properties.automation",
  method: "PUT",
  path: `${P}/automation`,
  auth: "user",
  summary:
    "Turn on the automatic monthly billing run (day of the month) and daily late fees for a property; the PALTAS scheduler runs them (idempotent per month and per overdue invoice)",
  params: PropertyParams,
  body: Automation,
  response: PropertyRecord,
});

export const createBuilding = endpoint({
  id: "property.buildings.create",
  method: "POST",
  path: `${P}/buildings`,
  auth: "user",
  summary: "Add a block or tower to a property",
  params: PropertyParams,
  body: z.object({ name: Name, floors: z.number().int().min(0).max(300).optional() }),
  response: Building,
  status: 201,
});

const BuildingParams = OrgParams.extend({ buildingId: Id });
export const updateBuilding = endpoint({
  id: "property.buildings.update",
  method: "PUT",
  path: `${Base}/buildings/:buildingId`,
  auth: "user",
  summary: "Rename a block without changing its units or financial history",
  params: BuildingParams,
  body: z.object({ name: z.string().trim().min(1).max(160) }),
  response: Building,
});
export const deleteBuilding = endpoint({
  id: "property.buildings.delete",
  method: "DELETE",
  path: `${Base}/buildings/:buildingId`,
  auth: "user",
  summary: "Delete an empty block or archive a block with units; refuses any active leases",
  params: BuildingParams,
  response: z.object({ id: Id, action: z.enum(["deleted", "archived"]) }),
});

export const createUnits = endpoint({
  id: "property.units.create",
  method: "POST",
  path: `${P}/units`,
  auth: "user",
  summary: "Add units to a property (unit numbers are unique in the property)",
  params: PropertyParams,
  body: z.object({ units: z.array(UnitFields).min(1).max(500) }),
  response: z.object({ units: z.array(Unit) }),
  status: 201,
});

export const updateUnit = endpoint({
  id: "property.units.update",
  method: "PUT",
  path: `${Base}/units/:unitId`,
  auth: "user",
  summary: "Change a unit's details or take it off the market",
  params: OrgParams.extend({ unitId: Id }),
  body: UnitFields.omit({ status: true })
    .partial()
    .extend({ status: z.enum(["available", "off_market"]).optional() }),
  response: Unit,
});

export const listAgreements = endpoint({
  id: "property.agreements.list",
  method: "GET",
  path: `${Base}/agreements`,
  auth: "user",
  summary: "Management agreements (owner mandates)",
  params: OrgParams,
  query: z.object({ propertyId: Id.optional(), ownerId: Id.optional() }),
  response: z.object({ agreements: z.array(Agreement) }),
});

export const createAgreement = endpoint({
  id: "property.agreements.create",
  method: "POST",
  path: `${Base}/agreements`,
  auth: "user",
  summary:
    "Record an owner's management agreement for a property (or one unit): fee %, spending authority, payout day. The owner becomes a contact of type owner.",
  params: OrgParams,
  body: z.object({
    propertyId: Id,
    unitId: Id.optional(),
    ownerId: Id,
    feePct: z.number().min(0).max(30),
    authorityMinor: NonNegativeMinor,
    payoutDay: z.number().int().min(1).max(28).default(10),
    startDate: IsoDate,
  }),
  response: Agreement,
  status: 201,
});

export const endAgreement = endpoint({
  id: "property.agreements.end",
  method: "POST",
  path: `${Base}/agreements/:agreementId/end`,
  auth: "user",
  summary: "End a management agreement",
  params: OrgParams.extend({ agreementId: Id }),
  body: z.object({ endDate: IsoDate, reason: Reason }),
  response: Agreement,
});

export const listOwners = endpoint({
  id: "property.owners.list",
  method: "GET",
  path: `${Base}/owners`,
  auth: "user",
  summary: "Owners with their agreements, payout details and funds held (from the ledger)",
  params: OrgParams,
  response: z.object({ owners: z.array(OwnerSummary) }),
});

export const updateOwnerProfile = endpoint({
  id: "property.owners.profile",
  method: "PUT",
  path: `${Base}/owners/:ownerId/profile`,
  auth: "user",
  summary: "An owner's payout details (masked bank account, verification) and reserve",
  params: OwnerParams,
  body: z.object({
    bankAccountMasked: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 •*.-]{2,40}$/, "Keep only a masked reference, e.g. ••7302")
      .optional(),
    verifyBank: z.boolean().optional(),
    reserveMinor: NonNegativeMinor.optional(),
  }),
  response: OwnerSummary,
});

// ---- leases
export const listLeases = endpoint({
  id: "property.leases.list",
  method: "GET",
  path: `${Base}/leases`,
  auth: "user",
  summary: "Leases, by status or property",
  params: OrgParams,
  query: z.object({ status: LeaseStatus.optional(), propertyId: Id.optional(), tenantId: Id.optional() }),
  response: z.object({ leases: z.array(Lease) }),
});

export const createLease = endpoint({
  id: "property.leases.create",
  method: "POST",
  path: `${Base}/leases`,
  auth: "user",
  summary: "Draft a lease for a unit and a tenant (a contact; it becomes type tenant)",
  params: OrgParams,
  body: LeaseTerms.extend({
    unitId: Id,
    tenantId: Id,
    buildingId: Id.optional(),
    floor: z.string().trim().max(20).optional(),
  }),
  response: Lease,
  status: 201,
});

export const getLease = endpoint({
  id: "property.leases.get",
  method: "GET",
  path: `${Base}/leases/:leaseId`,
  auth: "user",
  summary: "A lease with its rent steps, charges, invoices and deposit",
  params: LeaseParams,
  response: z.object({ lease: Lease, invoices: z.array(Invoice), depositRefunds: z.array(DepositRefund) }),
});

export const updateLease = endpoint({
  id: "property.leases.update",
  method: "PUT",
  path: `${Base}/leases/:leaseId`,
  auth: "user",
  summary: "Change a draft lease's terms",
  params: LeaseParams,
  body: LeaseTerms.partial(),
  response: Lease,
});

export const activateLease = endpoint({
  id: "property.leases.activate",
  method: "POST",
  path: `${Base}/leases/:leaseId/activate`,
  auth: "user",
  summary:
    "Activate a signed lease: the unit must be free for its dates and covered by a management agreement; rent steps are written for escalations and the deposit is invoiced",
  params: LeaseParams,
  body: z.object({ signedOn: IsoDate }),
  response: z.object({ lease: Lease, depositInvoice: Invoice.nullable() }),
});

export const renewLease = endpoint({
  id: "property.leases.renew",
  method: "POST",
  path: `${Base}/leases/:leaseId/renew`,
  auth: "user",
  summary: "Renew an active lease: a new end date and the rent from a date",
  params: LeaseParams,
  body: z.object({ endDate: IsoDate.nullable(), rentMinor: PositiveMinorUnits, effectiveFrom: IsoDate }),
  response: Lease,
});

export const reviewRent = endpoint({
  id: "property.leases.rentReview",
  method: "POST",
  path: `${Base}/leases/:leaseId/rent-review`,
  auth: "user",
  summary: "Change the rent of an active lease from a date (rent review)",
  params: LeaseParams,
  body: z.object({ rentMinor: PositiveMinorUnits, effectiveFrom: IsoDate, reason: Reason }),
  response: Lease,
});

export const giveNotice = endpoint({
  id: "property.leases.notice",
  method: "POST",
  path: `${Base}/leases/:leaseId/notice`,
  auth: "user",
  summary: "Record notice to end the lease and the planned move-out date",
  params: LeaseParams,
  body: z.object({ noticeDate: IsoDate, moveOutDate: IsoDate }),
  response: Lease,
});

export const terminateLease = endpoint({
  id: "property.leases.terminate",
  method: "POST",
  path: `${Base}/leases/:leaseId/terminate`,
  auth: "user",
  summary: "End an active lease at move-out (no rent is billed after it); the deposit is then settled",
  params: LeaseParams,
  body: z.object({ moveOutDate: IsoDate, reason: Reason }),
  response: Lease,
});

export const cancelLease = endpoint({
  id: "property.leases.cancel",
  method: "POST",
  path: `${Base}/leases/:leaseId/cancel`,
  auth: "user",
  summary: "Cancel a draft lease",
  params: LeaseParams,
  body: z.object({ reason: Reason }),
  response: Lease,
});

export const setLeaseCharges = endpoint({
  id: "property.leases.charges",
  method: "PUT",
  path: `${Base}/leases/:leaseId/charges`,
  auth: "user",
  summary: "The recurring charges billed with a lease each month (metered charges are billed from readings)",
  params: LeaseParams,
  body: z.object({ charges: z.array(LeaseChargeInput).max(20) }),
  response: Lease,
});

export const recordMeterReadings = endpoint({
  id: "property.meters.record",
  method: "POST",
  path: `${Base}/meter-readings`,
  auth: "user",
  summary: "Record meter readings for a month (one per unit and metered charge)",
  params: OrgParams,
  body: z.object({
    period: IsoMonth,
    readings: z
      .array(
        z.object({
          unitId: Id,
          chargeTypeId: Id,
          previous: z.number().min(0).max(1e9),
          current: z.number().min(0).max(1e9),
        }),
      )
      .min(1)
      .max(1000),
  }),
  response: z.object({ readings: z.array(MeterReading) }),
  status: 201,
});

export const listMeterReadings = endpoint({
  id: "property.meters.list",
  method: "GET",
  path: `${Base}/meter-readings`,
  auth: "user",
  summary: "Meter readings of a month",
  params: OrgParams,
  query: z.object({ period: IsoMonth, propertyId: Id.optional() }),
  response: z.object({ readings: z.array(MeterReading) }),
});

// ---- invoicing
export const runBilling = endpoint({
  id: "property.billing.run",
  method: "POST",
  path: `${Base}/billing-runs`,
  auth: "user",
  summary:
    "Monthly billing run for a property: rent (prorated in the first month) or charges (recurring + metered; refused while a reading is missing). Idempotent per lease and month.",
  params: OrgParams,
  body: z.object({ propertyId: Id, period: IsoMonth, kind: z.enum(["rent", "charges"]) }),
  response: BillingRunResult,
  status: 201,
});

export const listInvoices = endpoint({
  id: "property.invoices.list",
  method: "GET",
  path: `${Base}/invoices`,
  auth: "user",
  summary: "Invoices with their paid amount and balance",
  params: OrgParams,
  query: z.object({
    tenantId: Id.optional(),
    leaseId: Id.optional(),
    propertyId: Id.optional(),
    period: IsoMonth.optional(),
    open: z.enum(["true", "false"]).optional(),
  }),
  response: z.object({ invoices: z.array(Invoice) }),
});

export const getInvoice = endpoint({
  id: "property.invoices.get",
  method: "GET",
  path: `${Base}/invoices/:invoiceId`,
  auth: "user",
  summary: "One invoice with lines and what paid it",
  params: InvoiceParams,
  response: Invoice,
});

export const createChargeInvoice = endpoint({
  id: "property.invoices.charge",
  method: "POST",
  path: `${Base}/invoices`,
  auth: "user",
  summary: "Issue a one-off charge invoice on a lease (repairs recharge, admin fee …)",
  params: OrgParams,
  body: z.object({
    leaseId: Id,
    dueDate: IsoDate.optional(),
    note: Text.default(""),
    lines: z
      .array(
        z.object({
          chargeTypeId: Id,
          description: z.string().trim().max(200).default(""),
          quantity: z.number().positive().max(1e6).default(1),
          rateMinor: PositiveMinorUnits,
        }),
      )
      .min(1)
      .max(20),
  }),
  response: Invoice,
  status: 201,
});

export const runLateFees = endpoint({
  id: "property.lateFees.run",
  method: "POST",
  path: `${Base}/late-fees/run`,
  auth: "user",
  summary:
    "Charge late fees per each property's policy on rent overdue beyond the grace days (at most once per overdue invoice)",
  params: OrgParams,
  body: z.object({ propertyId: Id.optional() }),
  response: z.object({ created: z.array(Invoice), skipped: z.number().int() }),
  status: 201,
});

export const createCreditNote = endpoint({
  id: "property.invoices.creditNote",
  method: "POST",
  path: `${Base}/invoices/:invoiceId/credit-notes`,
  auth: "user",
  summary: "Reduce what an invoice asks for (posts the reversal of the unpaid part)",
  params: InvoiceParams,
  body: z.object({ amountMinor: PositiveMinorUnits, reason: Reason }),
  response: Invoice,
  status: 201,
});

// ---- payments
export const recordPayment = endpoint({
  id: "property.payments.record",
  method: "POST",
  path: `${Base}/payments`,
  auth: "user",
  summary:
    "Record a payment a tenant made (bank transfer, mobile money, cash, cheque). PALTAS does not process payments. It is allocated to the given invoices, or the oldest first; the rest is the tenant's credit. A receipt number is issued.",
  params: OrgParams,
  body: z.object({
    tenantId: Id,
    date: IsoDate,
    amountMinor: PositiveMinorUnits,
    method: PaymentMethod,
    reference: z.string().trim().min(2).max(80),
    note: Text.default(""),
    allocations: z
      .array(z.object({ invoiceId: Id, amountMinor: PositiveMinorUnits }))
      .max(50)
      .optional(),
    claimId: Id.optional(),
  }),
  response: Payment,
  status: 201,
});

export const listPayments = endpoint({
  id: "property.payments.list",
  method: "GET",
  path: `${Base}/payments`,
  auth: "user",
  summary: "Recorded payments and their receipts",
  params: OrgParams,
  query: z.object({ tenantId: Id.optional() }),
  response: z.object({ payments: z.array(Payment) }),
});

export const getPayment = endpoint({
  id: "property.payments.get",
  method: "GET",
  path: `${Base}/payments/:paymentId`,
  auth: "user",
  summary: "One recorded payment with its receipt and allocations",
  params: OrgParams.extend({ paymentId: Id }),
  response: Payment,
});

export const applyCredit = endpoint({
  id: "property.tenants.applyCredit",
  method: "POST",
  path: `${Base}/tenants/:tenantId/apply-credit`,
  auth: "user",
  summary: "Apply a tenant's credit (unallocated payments) to their open invoices, oldest first",
  params: TenantParams,
  response: z.object({ allocations: z.array(Allocation), creditLeftMinor: NonNegativeMinor }),
});

export const tenantStatement = endpoint({
  id: "property.tenants.statement",
  method: "GET",
  path: `${Base}/tenants/:tenantId/statement`,
  auth: "user",
  summary: "A tenant's account: invoices, payments, running balance, credit and deposit held",
  params: TenantParams,
  response: TenantStatement,
});

export const listClaims = endpoint({
  id: "property.claims.list",
  method: "GET",
  path: `${Base}/payment-claims`,
  auth: "user",
  summary: "Payments tenants reported from the portal, to check against the bank",
  params: OrgParams,
  query: z.object({ status: z.enum(["pending", "matched", "rejected"]).optional() }),
  response: z.object({ claims: z.array(PaymentClaim) }),
});

export const rejectClaim = endpoint({
  id: "property.claims.reject",
  method: "POST",
  path: `${Base}/payment-claims/:claimId/reject`,
  auth: "user",
  summary: "Reject a reported payment that is not on the bank statement",
  params: OrgParams.extend({ claimId: Id }),
  body: z.object({ reason: Reason }),
  response: PaymentClaim,
});

// ---- deposits
export const requestDepositRefund = endpoint({
  id: "property.deposits.request",
  method: "POST",
  path: `${Base}/leases/:leaseId/deposit-refunds`,
  auth: "user",
  summary:
    "Settle the deposit of an ended lease: apply it to unpaid invoices (optional), keep deductions for the owner with reasons, refund the rest. Someone else approves.",
  params: LeaseParams,
  body: z.object({
    applyToArrears: z.boolean().default(true),
    deductions: z
      .array(z.object({ amountMinor: PositiveMinorUnits, reason: z.string().trim().min(3).max(200) }))
      .max(20)
      .default([]),
    refundReference: z.string().trim().max(80).default(""),
  }),
  response: DepositRefund,
  status: 201,
});

export const listDepositRefunds = endpoint({
  id: "property.deposits.list",
  method: "GET",
  path: `${Base}/deposit-refunds`,
  auth: "user",
  summary: "Deposit settlements, requested and decided",
  params: OrgParams,
  query: z.object({ status: z.enum(["requested", "approved", "rejected"]).optional() }),
  response: z.object({ refunds: z.array(DepositRefund) }),
});

export const approveDepositRefund = endpoint({
  id: "property.deposits.approve",
  method: "POST",
  path: `${Base}/deposit-refunds/:refundId/approve`,
  auth: "user",
  summary: "Approve a deposit settlement requested by someone else; it posts to the ledger (refund recorded, not paid)",
  params: RefundParams,
  response: DepositRefund,
});

export const rejectDepositRefund = endpoint({
  id: "property.deposits.reject",
  method: "POST",
  path: `${Base}/deposit-refunds/:refundId/reject`,
  auth: "user",
  summary: "Reject a deposit settlement",
  params: RefundParams,
  body: z.object({ reason: Reason }),
  response: DepositRefund,
});

// ---- owners: statements and payouts
export const ownerStatement = endpoint({
  id: "property.owners.statement",
  method: "GET",
  path: `${Base}/owners/:ownerId/statement`,
  auth: "user",
  summary: "Owner statement for a period, built from the owner's ledger postings (closing = ledger)",
  params: OwnerParams,
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: OwnerStatement,
});

export const preparePayout = endpoint({
  id: "property.payouts.prepare",
  method: "POST",
  path: `${Base}/payouts`,
  auth: "user",
  summary:
    "Prepare an owner payout: the owner's funds (ledger) less the reserve. Needs verified bank details; one payout in progress per owner.",
  params: OrgParams,
  body: z.object({ ownerId: Id }),
  response: Payout,
  status: 201,
});

export const listPayouts = endpoint({
  id: "property.payouts.list",
  method: "GET",
  path: `${Base}/payouts`,
  auth: "user",
  summary: "Owner payouts",
  params: OrgParams,
  query: z.object({ ownerId: Id.optional() }),
  response: z.object({ payouts: z.array(Payout) }),
});

export const approvePayout = endpoint({
  id: "property.payouts.approve",
  method: "POST",
  path: `${Base}/payouts/:payoutId/approve`,
  auth: "user",
  summary: "Approve a payout prepared by someone else",
  params: PayoutParams,
  response: Payout,
});

export const releasePayout = endpoint({
  id: "property.payouts.release",
  method: "POST",
  path: `${Base}/payouts/:payoutId/release`,
  auth: "user",
  summary:
    "Release an approved payout (someone other than the approver): posts Dr 2250 / Cr 1040. No bank is connected — upload the bank file yourself; it is paid when matched on the statement.",
  params: PayoutParams,
  response: Payout,
});

export const cancelPayout = endpoint({
  id: "property.payouts.cancel",
  method: "POST",
  path: `${Base}/payouts/:payoutId/cancel`,
  auth: "user",
  summary: "Cancel a payout that has not been released",
  params: PayoutParams,
  body: z.object({ reason: Reason }),
  response: Payout,
});

// ---- supplier bills
export const submitBill = endpoint({
  id: "property.bills.submit",
  method: "POST",
  path: `${Base}/bills`,
  auth: "user",
  summary:
    "Enter a supplier bill. Bills on a work order are matched to its purchase order (amount, tolerance, work checked) and possible duplicates are held.",
  params: OrgParams,
  body: z.object({
    supplierId: Id,
    propertyId: Id.optional(),
    unitId: Id.optional(),
    workOrderId: Id.optional(),
    description: z.string().trim().min(2).max(500),
    supplierInvoiceNo: z.string().trim().min(1).max(60),
    billDate: IsoDate,
    dueDate: IsoDate.optional(),
    amountMinor: PositiveMinorUnits,
    recoverFrom: z.enum(["owner", "company"]).default("owner"),
  }),
  response: Bill,
  status: 201,
});

export const listBills = endpoint({
  id: "property.bills.list",
  method: "GET",
  path: `${Base}/bills`,
  auth: "user",
  summary: "Supplier bills by status",
  params: OrgParams,
  query: z.object({ status: z.enum(BILL_STATUSES).optional() }),
  response: z.object({ bills: z.array(Bill) }),
});

export const approveBill = endpoint({
  id: "property.bills.approve",
  method: "POST",
  path: `${Base}/bills/:billId/approve`,
  auth: "user",
  summary:
    "Approve a bill someone else entered. Above the owner's authority it waits for the owner. Approval posts to the ledger.",
  params: BillParams,
  response: Bill,
});

export const clearBillHold = endpoint({
  id: "property.bills.clearHold",
  method: "POST",
  path: `${Base}/bills/:billId/clear-hold`,
  auth: "user",
  summary: "Release a held bill after checking its match exceptions (with the reason)",
  params: BillParams,
  body: z.object({ reason: Reason }),
  response: Bill,
});

export const rejectBill = endpoint({
  id: "property.bills.reject",
  method: "POST",
  path: `${Base}/bills/:billId/reject`,
  auth: "user",
  summary: "Reject a bill that is not yet paid (an approved bill's posting is reversed)",
  params: BillParams,
  body: z.object({ reason: Reason }),
  response: Bill,
});

export const payBill = endpoint({
  id: "property.bills.pay",
  method: "POST",
  path: `${Base}/bills/:billId/pay`,
  auth: "user",
  summary:
    "Record that an approved bill was paid (by someone other than the approver), with the bank reference. PALTAS moves no money.",
  params: BillParams,
  body: z.object({ paidDate: IsoDate, reference: z.string().trim().min(2).max(80) }),
  response: Bill,
});

// ---- maintenance
export const listRequests = endpoint({
  id: "property.maintenance.list",
  method: "GET",
  path: `${Base}/maintenance`,
  auth: "user",
  summary: "Maintenance requests",
  params: OrgParams,
  query: z.object({ status: z.enum(["open", "assigned", "resolved", "closed"]).optional(), propertyId: Id.optional() }),
  response: z.object({ requests: z.array(MaintenanceRequest) }),
});

export const createRequest = endpoint({
  id: "property.maintenance.create",
  method: "POST",
  path: `${Base}/maintenance`,
  auth: "user",
  summary: "Log a maintenance request for a unit or a common area",
  params: OrgParams,
  body: z.object({
    propertyId: Id,
    unitId: Id.optional(),
    reporterId: Id.optional(),
    title: z.string().trim().min(3).max(200),
    category: z.string().trim().max(60).default("general"),
    priority: Priority.default("normal"),
  }),
  response: MaintenanceRequest,
  status: 201,
});

export const closeRequest = endpoint({
  id: "property.maintenance.close",
  method: "POST",
  path: `${Base}/maintenance/:requestId/close`,
  auth: "user",
  summary: "Close a request (resolved without a work order, or after it)",
  params: OrgParams.extend({ requestId: Id }),
  body: z.object({ note: z.string().trim().min(2).max(500) }),
  response: MaintenanceRequest,
});

export const listWorkOrders = endpoint({
  id: "property.workOrders.list",
  method: "GET",
  path: `${Base}/work-orders`,
  auth: "user",
  summary: "Work orders with quotes, purchase order and completion",
  params: OrgParams,
  query: z.object({ status: z.enum(WORK_ORDER_STATUSES).optional(), propertyId: Id.optional() }),
  response: z.object({ workOrders: z.array(WorkOrder) }),
});

export const createWorkOrder = endpoint({
  id: "property.workOrders.create",
  method: "POST",
  path: `${Base}/work-orders`,
  auth: "user",
  summary: "Open a work order (from a request or directly); due date from the SLA for its priority",
  params: OrgParams,
  body: z.object({
    propertyId: Id,
    unitId: Id.optional(),
    requestId: Id.optional(),
    scope: z.string().trim().min(3).max(1000),
    priority: Priority.default("normal"),
  }),
  response: WorkOrder,
  status: 201,
});

export const addQuote = endpoint({
  id: "property.workOrders.quote",
  method: "POST",
  path: `${Base}/work-orders/:workOrderId/quotes`,
  auth: "user",
  summary: "Record a supplier's quotation (one per supplier; a new one replaces it)",
  params: WoParams,
  body: z.object({
    supplierId: Id,
    amountMinor: PositiveMinorUnits,
    days: z.number().int().min(0).max(365).optional(),
    fileName: FileName,
  }),
  response: WorkOrder,
  status: 201,
});

export const raisePurchaseOrder = endpoint({
  id: "property.workOrders.raisePo",
  method: "POST",
  path: `${Base}/work-orders/:workOrderId/purchase-order`,
  auth: "user",
  summary: "Raise the purchase order for a quoted supplier (someone else approves it)",
  params: WoParams,
  body: z.object({ supplierId: Id }),
  response: WorkOrder,
});

export const approvePurchaseOrder = endpoint({
  id: "property.workOrders.approvePo",
  method: "POST",
  path: `${Base}/work-orders/:workOrderId/purchase-order/approve`,
  auth: "user",
  summary:
    "Approve a purchase order raised by someone else, within your approval limit; above the owner's authority it also needs the owner",
  params: WoParams,
  response: WorkOrder,
});

export const completeWorkOrder = endpoint({
  id: "property.workOrders.complete",
  method: "POST",
  path: `${Base}/work-orders/:workOrderId/complete`,
  auth: "user",
  summary: "Mark the work done, with at least one piece of evidence (photo or report file name)",
  params: WoParams,
  body: z.object({ notes: Text.default(""), evidence: z.array(FileName).min(1).max(20) }),
  response: WorkOrder,
});

export const verifyWorkOrder = endpoint({
  id: "property.workOrders.verify",
  method: "POST",
  path: `${Base}/work-orders/:workOrderId/verify`,
  auth: "user",
  summary: "Check the finished work: accept (the request is resolved) or send it back",
  params: WoParams,
  body: z.object({ accepted: z.boolean(), note: z.string().trim().max(500).default("") }),
  response: WorkOrder,
});

export const cancelWorkOrder = endpoint({
  id: "property.workOrders.cancel",
  method: "POST",
  path: `${Base}/work-orders/:workOrderId/cancel`,
  auth: "user",
  summary: "Cancel a work order that has not been billed",
  params: WoParams,
  body: z.object({ reason: Reason }),
  response: WorkOrder,
});

export const listInspections = endpoint({
  id: "property.inspections.list",
  method: "GET",
  path: `${Base}/inspections`,
  auth: "user",
  summary: "Inspections",
  params: OrgParams,
  query: z.object({ propertyId: Id.optional() }),
  response: z.object({ inspections: z.array(Inspection) }),
});

export const scheduleInspection = endpoint({
  id: "property.inspections.schedule",
  method: "POST",
  path: `${Base}/inspections`,
  auth: "user",
  summary: "Schedule a move-in, move-out or routine inspection",
  params: OrgParams,
  body: z.object({
    propertyId: Id,
    unitId: Id.optional(),
    leaseId: Id.optional(),
    kind: z.enum(["move_in", "move_out", "routine"]),
    scheduledDate: IsoDate,
  }),
  response: Inspection,
  status: 201,
});

export const completeInspection = endpoint({
  id: "property.inspections.complete",
  method: "POST",
  path: `${Base}/inspections/:inspectionId/complete`,
  auth: "user",
  summary: "Record the inspection; every area needing repair or damaged opens a maintenance request",
  params: OrgParams.extend({ inspectionId: Id }),
  body: z.object({ items: z.array(InspectionItem).min(1).max(100) }),
  response: Inspection,
});

// ---- CRM pipeline
export const createEnquiry = endpoint({
  id: "property.crm.enquiry",
  method: "POST",
  path: `${Base}/crm/enquiries`,
  auth: "user",
  summary:
    "A new enquiry: the contact is found by email or phone (or added), an open lead for the same unit is reused, and the same idempotency key never creates a second lead",
  params: OrgParams,
  body: z.object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    unitId: Id.optional(),
    source: z.string().trim().min(2).max(80).default("Direct"),
    campaign: z.string().trim().max(80).optional(),
    message: z.string().trim().max(2000).optional(),
    budgetMinor: NonNegativeMinor.optional(),
    bedrooms: z.number().int().min(0).max(50).optional(),
    moveIn: IsoDate.optional(),
    consent: z.object({ email: z.boolean(), sms: z.boolean(), marketing: z.boolean() }).optional(),
    idempotencyKey: z.string().trim().min(4).max(120).optional(),
  }),
  response: z.object({ lead: Lead, contactReused: z.boolean(), leadReused: z.boolean() }),
  status: 201,
});

export const listLeads = endpoint({
  id: "property.crm.leads",
  method: "GET",
  path: `${Base}/crm/leads`,
  auth: "user",
  summary: "Leads in the pipeline",
  params: OrgParams,
  query: z.object({ stage: LeadStage.optional() }),
  response: z.object({ leads: z.array(Lead) }),
});

export const moveLead = endpoint({
  id: "property.crm.stage",
  method: "POST",
  path: `${Base}/crm/leads/:leadId/stage`,
  auth: "user",
  summary: "Move a lead to another open stage (won comes from the lease; lost needs a reason)",
  params: OrgParams.extend({ leadId: Id }),
  body: z.object({ stage: z.enum(["new", "contacted", "qualified"]), note: z.string().trim().max(500).default("") }),
  response: Lead,
});

export const loseLead = endpoint({
  id: "property.crm.lost",
  method: "POST",
  path: `${Base}/crm/leads/:leadId/lost`,
  auth: "user",
  summary: "Mark a lead lost, with the reason",
  params: OrgParams.extend({ leadId: Id }),
  body: z.object({ reason: z.enum(LOST_REASONS), note: z.string().trim().max(500).default("") }),
  response: Lead,
});

export const scheduleViewing = endpoint({
  id: "property.crm.viewing",
  method: "POST",
  path: `${Base}/crm/viewings`,
  auth: "user",
  summary: "Book a viewing (refused for a let unit or when the agent already has a viewing within the hour)",
  params: OrgParams,
  body: z.object({ leadId: Id, unitId: Id.optional(), date: IsoDate, time: Time, agentId: Id.optional() }),
  response: Viewing,
  status: 201,
});

export const viewingOutcome = endpoint({
  id: "property.crm.viewingOutcome",
  method: "POST",
  path: `${Base}/crm/viewings/:viewingId/outcome`,
  auth: "user",
  summary: "Record whether the viewing happened, the feedback and the interest (1–5)",
  params: OrgParams.extend({ viewingId: Id }),
  body: z.object({
    attended: z.boolean(),
    feedback: z.string().trim().max(1000).default(""),
    interest: z.number().int().min(1).max(5).optional(),
  }),
  response: Viewing,
});

export const listViewings = endpoint({
  id: "property.crm.viewings",
  method: "GET",
  path: `${Base}/crm/viewings`,
  auth: "user",
  summary: "Viewings",
  params: OrgParams,
  query: z.object({ date: IsoDate.optional() }),
  response: z.object({ viewings: z.array(Viewing) }),
});

export const startApplication = endpoint({
  id: "property.crm.application",
  method: "POST",
  path: `${Base}/crm/applications`,
  auth: "user",
  summary: "Start a rental application for the lead's unit with the offer (one open application per lead and unit)",
  params: OrgParams,
  body: z.object({
    leadId: Id,
    unitId: Id.optional(),
    employer: z.string().trim().max(160).default(""),
    incomeMinor: NonNegativeMinor.optional(),
    occupants: z.number().int().min(1).max(50).default(1),
    offer: z.object({
      rentMinor: PositiveMinorUnits,
      depositMinor: NonNegativeMinor,
      startDate: IsoDate,
      months: z.number().int().min(1).max(120),
    }),
  }),
  response: Application,
  status: 201,
});

export const listApplications = endpoint({
  id: "property.crm.applications",
  method: "GET",
  path: `${Base}/crm/applications`,
  auth: "user",
  summary: "Rental applications",
  params: OrgParams,
  response: z.object({ applications: z.array(Application) }),
});

export const screenApplication = endpoint({
  id: "property.crm.screen",
  method: "POST",
  path: `${Base}/crm/applications/:applicationId/screening`,
  auth: "user",
  summary: "Record the screening checks (identity, income, reference)",
  params: OrgParams.extend({ applicationId: Id }),
  body: z.object({ identity: z.boolean(), income: z.boolean(), reference: z.boolean() }),
  response: Application,
});

export const decideApplication = endpoint({
  id: "property.crm.decide",
  method: "POST",
  path: `${Base}/crm/applications/:applicationId/decision`,
  auth: "user",
  summary: "Approve (all checks passed; not by the person who screened it) or reject an application",
  params: OrgParams.extend({ applicationId: Id }),
  body: z.object({ approve: z.boolean(), note: z.string().trim().max(500).default("") }),
  response: Application,
});

export const convertApplication = endpoint({
  id: "property.crm.convert",
  method: "POST",
  path: `${Base}/crm/applications/:applicationId/convert`,
  auth: "user",
  summary:
    "Turn an approved application into a draft lease (the applicant contact becomes a tenant). Activating the lease marks the lead won.",
  params: OrgParams.extend({ applicationId: Id }),
  response: z.object({ application: Application, lease: Lease }),
});

// ---- notices and documents
export const publishNotice = endpoint({
  id: "property.notices.publish",
  method: "POST",
  path: `${Base}/notices`,
  auth: "user",
  summary:
    "A notice to every tenant of a property: one message per tenant is RECORDED (not sent — no delivery provider is connected); tenants without consent for the channel are counted as blocked",
  params: OrgParams,
  body: z.object({
    propertyId: Id,
    title: z.string().trim().min(3).max(160),
    body: z.string().trim().min(3).max(5000),
    channel: z.enum(["email", "sms", "whatsapp", "inapp"]).default("inapp"),
  }),
  response: z.object({ notice: Notice, messages: z.array(Message) }),
  status: 201,
});

export const listNotices = endpoint({
  id: "property.notices.list",
  method: "GET",
  path: `${Base}/notices`,
  auth: "user",
  summary: "Notices published",
  params: OrgParams,
  query: z.object({ propertyId: Id.optional() }),
  response: z.object({ notices: z.array(Notice) }),
});

export const addDocument = endpoint({
  id: "property.documents.add",
  method: "POST",
  path: `${Base}/documents`,
  auth: "user",
  summary:
    "Record a document (metadata) and what it belongs to; tenant- or owner-visible documents show in the portals",
  params: OrgParams,
  body: z.object({
    name: Name,
    docType: z.string().trim().min(2).max(60),
    linkEntity: z.enum(DOCUMENT_LINKS),
    linkId: Id,
    filename: FileName,
    sizeBytes: z.number().int().min(0).max(1e10).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    visibility: z.enum(["staff", "tenant", "owner"]).default("staff"),
  }),
  response: DocumentRecord,
  status: 201,
});

export const listDocuments = endpoint({
  id: "property.documents.list",
  method: "GET",
  path: `${Base}/documents`,
  auth: "user",
  summary: "Documents, by what they belong to",
  params: OrgParams,
  query: z.object({ linkEntity: z.enum(DOCUMENT_LINKS).optional(), linkId: Id.optional() }),
  response: z.object({ documents: z.array(DocumentRecord) }),
});

/** Document bytes stay private; access always passes the organisation gate. Files are never served inline. */
const DocumentFile = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\\/]+$/)
    .refine(
      (value) => [...value].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127),
      "Filename contains control characters",
    ),
  mediaType: z.enum(["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv"]),
  contentBase64: z
    .string()
    .min(4)
    .max(2796204)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
const DocumentParams = OrgParams.extend({ documentId: Id });
export const uploadDocumentFile = endpoint({
  id: "property.documents.upload",
  method: "POST",
  path: `${Base}/documents/:documentId/file`,
  auth: "user",
  summary: "Store a private document file up to 2 MiB; 256 MiB total per company",
  params: DocumentParams,
  body: DocumentFile,
  response: z.object({ stored: z.literal(true), sizeBytes: z.number().int(), sha256: z.string() }),
});
export const downloadDocumentFile = endpoint({
  id: "property.documents.download",
  method: "GET",
  path: `${Base}/documents/:documentId/file`,
  auth: "user",
  summary: "Read private document bytes after company and permission checks; treat downloads as untrusted files",
  params: DocumentParams,
  response: DocumentFile.extend({ sha256: z.string() }),
});

// ---- bank reconciliation
export const importBankLines = endpoint({
  id: "property.bank.import",
  method: "POST",
  path: `${Base}/bank/lines`,
  auth: "user",
  summary:
    "Import client-account statement lines (lines already imported are skipped) and match them to recorded receipts, payouts, bill payments and refunds by reference and amount",
  params: OrgParams,
  body: z.object({
    statement: z.string().trim().min(1).max(120),
    lines: z
      .array(
        z.object({
          date: IsoDate,
          amountMinor: MinorUnits.refine((n) => n !== 0, "An amount of zero is not a statement line"),
          reference: z.string().trim().min(1).max(120),
          description: z.string().trim().max(300).default(""),
        }),
      )
      .min(1)
      .max(2000),
  }),
  response: z.object({
    imported: z.number().int(),
    duplicates: z.number().int(),
    matched: z.number().int(),
    lines: z.array(BankLine),
  }),
  status: 201,
});

export const listBankLines = endpoint({
  id: "property.bank.lines",
  method: "GET",
  path: `${Base}/bank/lines`,
  auth: "user",
  summary: "Statement lines and their match",
  params: OrgParams,
  query: z.object({ status: z.enum(["unmatched", "matched", "ignored"]).optional() }),
  response: z.object({ lines: z.array(BankLine) }),
});

export const matchBankLine = endpoint({
  id: "property.bank.match",
  method: "POST",
  path: `${Base}/bank/lines/:lineId/match`,
  auth: "user",
  summary:
    "Match a statement line by hand: to something recorded (same amount), or record it as a tenant's payment (money in only)",
  params: OrgParams.extend({ lineId: Id }),
  body: z.discriminatedUnion("to", [
    z.object({
      to: z.enum(["payment", "payout", "bill_payment", "deposit_refund"]),
      id: Id,
    }),
    z.object({ to: z.literal("new_payment"), tenantId: Id, method: PaymentMethod.default("bank_transfer") }),
  ]),
  response: BankLine,
});

export const ignoreBankLine = endpoint({
  id: "property.bank.ignore",
  method: "POST",
  path: `${Base}/bank/lines/:lineId/ignore`,
  auth: "user",
  summary: "Set aside a statement line that is not client money (with the reason)",
  params: OrgParams.extend({ lineId: Id }),
  body: z.object({ reason: Reason }),
  response: BankLine,
});

export const prepareReconciliation = endpoint({
  id: "property.bank.reconcile",
  method: "POST",
  path: `${Base}/bank/reconciliations`,
  auth: "user",
  summary: "Reconcile the client account at a statement date: ledger vs statement, with uncleared and unmatched items",
  params: OrgParams,
  body: z.object({ statementDate: IsoDate, statementBalanceMinor: MinorUnits }),
  response: Reconciliation,
  status: 201,
});

export const listReconciliations = endpoint({
  id: "property.bank.reconciliations",
  method: "GET",
  path: `${Base}/bank/reconciliations`,
  auth: "user",
  summary: "Reconciliations prepared and approved",
  params: OrgParams,
  response: z.object({ reconciliations: z.array(Reconciliation) }),
});

export const approveReconciliation = endpoint({
  id: "property.bank.approve",
  method: "POST",
  path: `${Base}/bank/reconciliations/:reconciliationId/approve`,
  auth: "user",
  summary: "Sign off a reconciliation prepared by someone else (only when the difference is zero)",
  params: OrgParams.extend({ reconciliationId: Id }),
  response: Reconciliation,
});

// ---- reports
export const dashboard = endpoint({
  id: "property.reports.dashboard",
  method: "GET",
  path: `${Base}/dashboard`,
  auth: "user",
  summary:
    "Occupancy, billing and collections for a month, arrears, expiring leases — every money figure checked against the ledger",
  params: OrgParams,
  query: z.object({ month: IsoMonth.optional(), propertyId: Id.optional() }),
  response: Dashboard,
});

export const agedReceivables = endpoint({
  id: "property.reports.aged",
  method: "GET",
  path: `${Base}/reports/aged-receivables`,
  auth: "user",
  summary: "Arrears by tenant and age (current, 1–30, 31–60, 61–90, over 90 days); total equals the ledger",
  params: OrgParams,
  response: AgedReceivables,
});

export const rentRoll = endpoint({
  id: "property.reports.rentRoll",
  method: "GET",
  path: `${Base}/reports/rent-roll`,
  auth: "user",
  summary: "Rent roll: every unit, its tenant, rent, lease end and balance",
  params: OrgParams,
  query: z.object({ propertyId: Id.optional() }),
  response: RentRoll,
});

export const clientMoney = endpoint({
  id: "property.reports.clientMoney",
  method: "GET",
  path: `${Base}/reports/client-money`,
  auth: "user",
  summary:
    "Client money check: the client account against everything owed to owners and tenants; owner balances against the ledger",
  params: OrgParams,
  response: ClientMoney,
});

// ---- portals
export const tenantPortal = endpoint({
  id: "property.portal.tenant",
  method: "GET",
  path: `${Base}/portal/tenant`,
  auth: "user",
  summary: "The signed-in tenant's own leases, invoices, payments, requests and documents (nothing else)",
  params: OrgParams,
  response: TenantPortal,
});

export const tenantRequest = endpoint({
  id: "property.portal.tenantRequest",
  method: "POST",
  path: `${Base}/portal/tenant/requests`,
  auth: "user",
  summary: "A tenant reports a problem in their own unit",
  params: OrgParams,
  body: z.object({
    leaseId: Id,
    title: z.string().trim().min(3).max(200),
    category: z.string().trim().max(60).default("general"),
    priority: Priority.default("normal"),
  }),
  response: MaintenanceRequest,
  status: 201,
});

export const tenantPaymentReport = endpoint({
  id: "property.portal.tenantPayment",
  method: "POST",
  path: `${Base}/portal/tenant/payment-reports`,
  auth: "user",
  summary:
    "A tenant reports a payment they made (bank or mobile money reference). It is a claim staff check against the bank — never a payment by itself.",
  params: OrgParams,
  body: z.object({
    amountMinor: PositiveMinorUnits,
    date: IsoDate,
    method: PaymentMethod,
    reference: z.string().trim().min(2).max(80),
    note: z.string().trim().max(500).default(""),
  }),
  response: PaymentClaim,
  status: 201,
});

export const ownerPortal = endpoint({
  id: "property.portal.owner",
  method: "GET",
  path: `${Base}/portal/owner`,
  auth: "user",
  summary: "The signed-in owner's properties, statement for a period, bills and purchase orders awaiting them, payouts",
  params: OrgParams,
  query: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }),
  response: OwnerPortal,
});

export const ownerApproveBill = endpoint({
  id: "property.portal.ownerApproveBill",
  method: "POST",
  path: `${Base}/portal/owner/bills/:billId/approve`,
  auth: "user",
  summary: "The owner approves a bill above the agreement's authority on their own property",
  params: BillParams,
  response: Bill,
});

export const ownerApprovePurchaseOrder = endpoint({
  id: "property.portal.ownerApprovePo",
  method: "POST",
  path: `${Base}/portal/owner/work-orders/:workOrderId/approve`,
  auth: "user",
  summary: "The owner approves a purchase order above the agreement's authority on their own property",
  params: WoParams,
  response: WorkOrder,
});
