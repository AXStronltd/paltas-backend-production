// Real Estate Development (product "developer"): projects, phases, buildings and units; price lists; buyers, offers,
// reservations, sale agreements with payment plans; buyer payments reported, verified by finance and posted to the ONE
// ledger; statements of account; suppliers, budgets by cost code, requisitions, quotations, purchase orders and
// contracts, deliveries, supplier invoices with three-way checks, payment runs, retention; milestones, handover with
// revenue recognition, defects and after-sales; legal register and document records; dashboards read from the ledger.
//
// Rules the server enforces (the database backs up the ones marked *):
// - a unit is never sold twice: one open reservation* and one live contract* per unit, rows locked before a change;
// - approvals use the organisation's approval limits per role, and are never made by the person who prepared the
//   record* (requisitions, orders, budget changes, invoices, payment runs, price lists, bank changes, buyer payments);
// - buyer money is RECORDED, never processed: a reported payment counts only once finance verifies it against the bank;
// - supplier payments are executed as a bank file for the bank portal (no bank is connected) and marked paid only when
//   the bank statement is matched by someone other than the person who executed the run;
// - postings (source "system:development"): receipts Dr 1010 / Cr 1170 (billed) or 2400 (in advance); instalments
//   billed Dr 1170 / Cr 2400; handover Dr 2400 (and 3900 for receipts before a migration cut-over) / Cr 4600, cost of
//   sale Dr 5700 / Cr WIP; supplier invoices Dr cost account + 1200 VAT / Cr 2000 + 2050 retention; payments
//   Dr 2000 / Cr 1000 + 2200 withholding tax; retention release Dr 2050 / Cr 2000.
import { z } from "zod";
import { Email, IsoDate, IsoDateTime, MinorUnits, PositiveMinorUnits, Reason } from "../common.js";
import { Role } from "../access.js";
import { endpoint } from "../endpoint.js";
import { AccountCode } from "./ledger.js";
import { OrgParams } from "./organisations.js";

// ------------------------------------------------------------------ building blocks
const Id = z.string().min(1).max(80);
const Name = z.string().trim().min(1).max(160);
const Text = z.string().trim().max(2000);
const ShortText = z.string().trim().max(200);
const NonNegativeMinor = MinorUnits.min(0);
/** A share in basis points: 1000 = 10 %. */
const Bp = z.number().int().min(0).max(10_000);
/** A quantity with at most three decimals (bags, m², tonnes). */
const Qty = z
  .number()
  .positive()
  .max(1e9)
  .refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, "Use at most three decimals");
const CostCodeKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9.-]{1,12}$/, "Use 1–12 letters, digits, . or -");

export const UNIT_STATUSES = ["available", "on_hold", "reserved", "sold", "handed_over", "blocked"] as const;
export const UnitStatus = z.enum(UNIT_STATUSES);
export const PROJECT_STATUSES = ["planning", "construction", "selling", "completed"] as const;
export const OFFER_STATUSES = [
  "draft",
  "awaiting_approval",
  "submitted",
  "counteroffer",
  "accepted",
  "rejected",
  "withdrawn",
  "expired",
] as const;
export const RESERVATION_STATUSES = ["awaiting_approval", "active", "converted", "cancelled", "expired"] as const;
export const APPROVAL_KINDS = ["requisition", "purchase_order", "invoice", "budget_change", "payment_run"] as const;
export const ApprovalKind = z.enum(APPROVAL_KINDS);
export const PAYMENT_METHODS = ["bank_transfer", "mobile_money", "mortgage_drawdown", "cheque", "cash"] as const;
export const PaymentMethod = z.enum(PAYMENT_METHODS);
export const INVOICE_STATUSES = [
  "captured",
  "matched",
  "exception",
  "approved",
  "in_run",
  "sent",
  "paid",
  "disputed",
  "rejected",
  "duplicate",
] as const;

/** Payment plan: deposit + instalments over `months` + balance on completion = 100 %. */
export const Plan = z
  .object({
    depositBp: Bp,
    instalmentsBp: Bp,
    months: z.number().int().min(0).max(36),
    completionBp: Bp,
  })
  .refine(
    (p) => p.depositBp + p.instalmentsBp + p.completionBp === 10_000,
    "Deposit + instalments + completion must be 100 %",
  )
  .refine((p) => p.instalmentsBp === 0 || p.months > 0, "Spread the instalments over at least one month");
export type Plan = z.infer<typeof Plan>;

// ------------------------------------------------------------------ settings
export const OfferRules = z.object({
  /** Discounts above this need a sales manager. */
  managerDiscountBp: Bp,
  /** Discounts above this need the chief executive (organisation administrator). */
  executiveDiscountBp: Bp,
  /** A deposit below this needs the chief executive. */
  minDepositBp: Bp,
  /** More instalment months than this need a sales manager … */
  managerMaxMonths: z.number().int().min(0).max(36),
  /** … and more than this the chief executive. */
  executiveMaxMonths: z.number().int().min(0).max(36),
});

export const ApprovalLimit = z.object({
  kind: ApprovalKind,
  role: Role,
  /** null = no limit. */
  limitMinor: NonNegativeMinor.nullable(),
});

export const CostCode = z.object({
  code: CostCodeKey,
  name: Name,
  /** The ledger account its costs post to (WIP asset or expense). */
  account: AccountCode,
  active: z.boolean().default(true),
});

export const Settings = z.object({
  reservationDays: z.number().int().min(1).max(120),
  /** Price tolerance in the three-way match. */
  priceToleranceBp: Bp,
  /** Payments to a supplier wait this long after a verified bank-detail change. */
  bankHoldHours: z.number().int().min(0).max(720),
  offerRules: OfferRules,
  limits: z.array(ApprovalLimit),
  costCodes: z.array(CostCode),
});

// ------------------------------------------------------------------ projects and units
export const Project = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  location: z.string().nullable(),
  status: z.string().nullable(),
  stage: z.string().nullable(),
  progressPct: z.number().int(),
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(),
  forecastEndDate: IsoDate.nullable(),
  unitCount: z.number().int(),
  soldCount: z.number().int(),
  migrated: z.boolean(),
});

export const Unit = z.object({
  id: z.string(),
  projectId: z.string(),
  buildingId: z.string().nullable(),
  floorId: z.string().nullable(),
  unitNo: z.string(),
  type: z.string().nullable(),
  bedrooms: z.number().int().nullable(),
  areaSqm: z.number().nullable(),
  listPriceMinor: MinorUnits.nullable(),
  status: UnitStatus,
  migrated: z.boolean(),
});

export const Milestone = z.object({
  id: z.string(),
  projectId: z.string(),
  phaseId: z.string().nullable(),
  name: z.string(),
  dueDate: IsoDate.nullable(),
  forecastDate: IsoDate.nullable(),
  completedDate: IsoDate.nullable(),
  percent: z.number().int().nullable(),
  status: z.string().nullable(),
  practicalCompletion: z.boolean(),
});

export const ProjectDetail = Project.extend({
  phases: z.array(
    z.object({ id: z.string(), name: z.string(), startDate: IsoDate.nullable(), endDate: IsoDate.nullable() }),
  ),
  buildings: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      phaseId: z.string().nullable(),
      floorsCount: z.number().int().nullable(),
    }),
  ),
  unitsByStatus: z.record(z.string(), z.number().int()),
  milestones: z.array(Milestone),
});

export const PriceList = z.object({
  id: z.string(),
  number: z.string(),
  projectId: z.string(),
  status: z.enum(["draft", "approved", "rejected"]),
  effectiveDate: IsoDate,
  note: z.string(),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  items: z.array(
    z.object({ unitId: z.string(), unitNo: z.string(), oldPriceMinor: MinorUnits.nullable(), priceMinor: MinorUnits }),
  ),
});

// ------------------------------------------------------------------ buyers and sales
export const Buyer = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  nationalId: z.string().nullable(),
  partyType: z.string().nullable(),
  address: z.string().nullable(),
  source: z.string().nullable(),
  agentUserId: z.string().nullable(),
  /** The same person in the organisation's one contact store (core contacts). */
  contactId: z.string().nullable(),
  status: z.enum(["active", "lost", "merged"]),
  mergedInto: z.string().nullable(),
  stage: z.string(),
  nextFollowUp: IsoDate.nullable(),
  migrated: z.boolean(),
});

export const Offer = z.object({
  id: z.string(),
  number: z.string(),
  buyerId: z.string(),
  unitId: z.string(),
  projectId: z.string(),
  askingMinor: MinorUnits,
  priceMinor: MinorUnits,
  discountBp: z.number().int(),
  plan: Plan,
  validDays: z.number().int(),
  validUntil: IsoDate.nullable(),
  conditions: z.string(),
  status: z.enum(OFFER_STATUSES),
  round: z.number().int(),
  agentUserId: z.string().nullable(),
  createdBy: z.string(),
  approval: z
    .object({
      level: z.enum(["manager", "executive"]),
      status: z.enum(["pending", "approved", "declined"]),
      requestedBy: z.string(),
      decidedBy: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  counter: z.object({ priceMinor: MinorUnits, plan: Plan, note: z.string() }).nullable(),
  reservationId: z.string().nullable(),
});
export type Offer = z.infer<typeof Offer>;

export const Reservation = z.object({
  id: z.string(),
  unitId: z.string(),
  buyerId: z.string(),
  offerId: z.string().nullable(),
  date: IsoDate,
  expiryDate: IsoDate.nullable(),
  status: z.enum(RESERVATION_STATUSES),
  depositMinor: MinorUnits.nullable(),
  approvedBy: z.string().nullable(),
  contractId: z.string().nullable(),
  migrated: z.boolean(),
});

export const Instalment = z.object({
  id: z.string(),
  seq: z.number().int(),
  dueDate: IsoDate,
  description: z.string().nullable(),
  amountMinor: MinorUnits,
  paidMinor: MinorUnits,
  openMinor: MinorUnits,
  /** Billed and not yet collected: held in 1170 Buyer receivables. */
  receivableMinor: MinorUnits,
});

export const Contract = z.object({
  id: z.string(),
  number: z.string().nullable(),
  unitId: z.string(),
  buyerId: z.string(),
  reservationId: z.string().nullable(),
  offerId: z.string().nullable(),
  date: IsoDate,
  priceMinor: MinorUnits,
  status: z.string().nullable(),
  plan: Plan.nullable(),
  signedDocumentId: z.string().nullable(),
  instalments: z.array(Instalment),
  handedOver: z.boolean(),
  migrated: z.boolean(),
});
export type Contract = z.infer<typeof Contract>;

export const StatementLine = z.object({
  date: IsoDate,
  kind: z.enum(["instalment", "receipt", "refund", "amendment"]),
  reference: z.string(),
  description: z.string(),
  /** What the buyer owes (instalments falling due, price increases). */
  debitMinor: MinorUnits,
  /** What the buyer paid (receipts) or what was taken off. */
  creditMinor: MinorUnits,
});

export const Statement = z.object({
  contractId: z.string(),
  number: z.string().nullable(),
  buyer: z.object({ id: z.string(), name: z.string() }),
  unit: z.object({ id: z.string(), unitNo: z.string() }),
  asOf: IsoDate,
  priceMinor: MinorUnits,
  lines: z.array(StatementLine),
  instalments: z.array(Instalment),
  totals: z.object({
    dueToDateMinor: MinorUnits,
    paidMinor: MinorUnits,
    overdueMinor: MinorUnits,
    notYetDueMinor: MinorUnits,
    balanceMinor: MinorUnits,
  }),
});

export const PaymentReport = z.object({
  id: z.string(),
  number: z.string(),
  contractId: z.string(),
  instalmentId: z.string().nullable(),
  buyerId: z.string(),
  amountMinor: MinorUnits,
  method: PaymentMethod,
  reference: z.string(),
  date: IsoDate,
  proofDocumentId: z.string().nullable(),
  source: z.string(),
  status: z.enum(["awaiting_verification", "verified", "rejected"]),
  reportedBy: z.string(),
  verifiedBy: z.string().nullable(),
  reason: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  journalId: z.string().nullable(),
});

export const Correspondence = z.object({
  id: z.string(),
  buyerId: z.string().nullable(),
  contractId: z.string().nullable(),
  date: IsoDate,
  channel: z.string().nullable(),
  subject: z.string(),
  summary: z.string().nullable(),
  /** Messages are recorded here, never sent: no e-mail, SMS or WhatsApp provider is connected. */
  delivery: z.string(),
});

export const Dispute = z.object({
  id: z.string(),
  buyerId: z.string(),
  contractId: z.string().nullable(),
  openedDate: IsoDate,
  subject: z.string(),
  status: z.string().nullable(),
  amountMinor: MinorUnits.nullable(),
  resolution: z.string().nullable(),
});

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  dueDate: IsoDate,
  priority: z.enum(["low", "normal", "high", "urgent"]),
  status: z.enum(["open", "done", "cancelled"]),
  category: z.enum(["sales", "finance", "aftersales", "site", "general"]),
  assigneeUserId: z.string(),
  createdBy: z.string().nullable(),
  links: z.object({
    buyerId: z.string().nullable(),
    unitId: z.string().nullable(),
    projectId: z.string().nullable(),
    contractId: z.string().nullable(),
  }),
});

export const BuyerProfile = Buyer.extend({
  contracts: z.array(Contract),
  offers: z.array(Offer),
  reservations: z.array(Reservation),
  disputes: z.array(Dispute),
  correspondence: z.array(Correspondence),
  money: z.object({
    dueMinor: MinorUnits,
    paidMinor: MinorUnits,
    overdueMinor: MinorUnits,
    outstandingMinor: MinorUnits,
  }),
  history: z.array(
    z.object({ at: IsoDateTime, action: z.string(), detail: z.string(), actorUserId: z.string().nullable() }),
  ),
});

// ------------------------------------------------------------------ suppliers, budgets, procurement
export const Supplier = z.object({
  id: z.string(),
  kind: z.enum(["supplier", "contractor"]),
  name: z.string(),
  taxId: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  trade: z.string().nullable(),
  status: z.enum(["pending", "approved", "suspended"]),
  relatedParty: z.boolean(),
  relatedNote: z.string().nullable(),
  missingDocuments: z.array(z.string()),
  bankAccount: z.string().nullable(),
  bankVerifiedAt: IsoDateTime.nullable(),
  rating: z.number().nullable(),
  paymentsBlocked: z.boolean(),
  migrated: z.boolean(),
});

export const BankChange = z.object({
  id: z.string(),
  supplierId: z.string(),
  newAccount: z.string(),
  receivedVia: z.string(),
  loggedBy: z.string(),
  status: z.enum(["pending_verification", "on_hold", "verified"]),
  verifiedBy: z.string().nullable(),
  callbackNote: z.string().nullable(),
  holdUntil: IsoDateTime.nullable(),
});

export const CostRow = z.object({
  costCode: z.string(),
  name: z.string(),
  originalMinor: MinorUnits,
  revisedMinor: MinorUnits,
  proposedMinor: MinorUnits,
  committedMinor: MinorUnits,
  invoicedMinor: MinorUnits,
  paidMinor: MinorUnits,
  openCommitmentMinor: MinorUnits,
  /** Uncommitted forecast (estimate to complete for scope with no order yet). */
  etcMinor: MinorUnits,
  /** Forecast final cost = invoiced + open commitment + uncommitted forecast. */
  eacMinor: MinorUnits,
  costToCompleteMinor: MinorUnits,
  /** Revised budget − forecast final (negative = over budget). */
  varianceMinor: MinorUnits,
  note: z.string(),
});

const CostTotals = CostRow.omit({ costCode: true, name: true, note: true });

export const CostReport = z.object({
  projectId: z.string(),
  rows: z.array(CostRow),
  totals: CostTotals,
  ledger: z.object({
    /** Costs posted to the ledger for this project (debits − credits on cost lines). */
    invoicedMinor: MinorUnits,
    agrees: z.boolean(),
  }),
});

export const BudgetChange = z.object({
  id: z.string(),
  number: z.string(),
  projectId: z.string(),
  kind: z.enum(["transfer", "change_order"]),
  fromCode: z.string(),
  toCode: z.string(),
  amountMinor: MinorUnits,
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
});

export const Requisition = z.object({
  id: z.string(),
  number: z.string(),
  projectId: z.string(),
  costCode: z.string(),
  item: z.string(),
  qty: z.number(),
  unit: z.string(),
  estUnitPriceMinor: MinorUnits,
  estimateMinor: MinorUnits,
  needBy: IsoDate.nullable(),
  status: z.enum(["pending", "approved", "rejected", "rfq", "ordered"]),
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  rfqId: z.string().nullable(),
});

export const Rfq = z.object({
  id: z.string(),
  number: z.string(),
  requisitionId: z.string(),
  projectId: z.string(),
  costCode: z.string(),
  item: z.string(),
  qty: z.number(),
  unit: z.string(),
  closes: IsoDate,
  status: z.enum(["open", "awarded"]),
  invitedSupplierIds: z.array(z.string()),
  bids: z.array(
    z.object({
      supplierId: z.string(),
      unitPriceMinor: MinorUnits,
      leadDays: z.number().int(),
      note: z.string(),
      /** Weighted score: price 60, lead time 20, supplier rating 20. */
      score: z.number().int(),
    }),
  ),
  awardedSupplierId: z.string().nullable(),
  purchaseOrderId: z.string().nullable(),
});

export const PoLine = z.object({
  id: z.string(),
  item: z.string(),
  unit: z.string(),
  qty: z.number(),
  unitPriceMinor: MinorUnits,
  acceptedQty: z.number(),
  invoicedQty: z.number(),
});

export const PurchaseOrder = z.object({
  id: z.string(),
  number: z.string().nullable(),
  kind: z.enum(["po", "contract"]),
  supplierId: z.string(),
  projectId: z.string(),
  costCode: z.string().nullable(),
  date: IsoDate,
  amountMinor: MinorUnits,
  retentionBp: z.number().int(),
  status: z.string().nullable(),
  description: z.string().nullable(),
  lines: z.array(PoLine),
  preparedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  relatedParty: z.boolean(),
  invoicedMinor: MinorUnits,
  retentionHeldMinor: MinorUnits,
  retentionReleasedMinor: MinorUnits,
  migrated: z.boolean(),
});

export const Delivery = z.object({
  id: z.string(),
  number: z.string(),
  purchaseOrderId: z.string(),
  date: IsoDate,
  note: z.string(),
  receivedBy: z.string(),
  lines: z.array(z.object({ poLineId: z.string(), receivedQty: z.number(), acceptedQty: z.number() })),
});

export const MatchLine = z.object({
  item: z.string(),
  poQty: z.number(),
  poUnitPriceMinor: MinorUnits,
  acceptedQty: z.number(),
  availableQty: z.number(),
  invoicedQty: z.number(),
  invoicedUnitPriceMinor: MinorUnits,
  qtyOk: z.boolean(),
  priceOk: z.boolean(),
});

export const SupplierInvoice = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(["invoice", "retention_release"]),
  supplierId: z.string(),
  projectId: z.string(),
  costCode: z.string().nullable(),
  purchaseOrderId: z.string().nullable(),
  supplierInvoiceNo: z.string(),
  date: IsoDate,
  dueDate: IsoDate,
  description: z.string(),
  netMinor: MinorUnits,
  vatMinor: MinorUnits,
  grossMinor: MinorUnits,
  retentionMinor: MinorUnits,
  whtMinor: MinorUnits,
  /** Owed to the supplier on the ledger (gross − retention). */
  payableMinor: MinorUnits,
  /** Cash to the supplier (payable − withholding tax). */
  cashMinor: MinorUnits,
  sentMinor: MinorUnits,
  paidMinor: MinorUnits,
  openMinor: MinorUnits,
  status: z.enum(INVOICE_STATUSES),
  exceptions: z.array(z.string()),
  capturedBy: z.string(),
  approvedBy: z.string().nullable(),
  evidenceDocumentId: z.string().nullable(),
  dispute: z.object({ amountMinor: MinorUnits, reason: z.string(), status: z.enum(["open", "settled"]) }).nullable(),
  creditNotesMinor: MinorUnits,
  journalId: z.string().nullable(),
  match: z.array(MatchLine).nullable(),
});

export const SupplierPayment = z.object({
  id: z.string(),
  invoiceId: z.string(),
  supplierId: z.string(),
  amountMinor: MinorUnits,
  whtMinor: MinorUnits,
  reference: z.string(),
  status: z.enum(["sent", "reconciled", "reversed"]),
  journalId: z.string().nullable(),
});

export const PaymentRun = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(["awaiting_approval", "approved", "sent", "reconciled", "rejected"]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  executedBy: z.string().nullable(),
  totalMinor: MinorUnits,
  invoiceIds: z.array(z.string()),
  payments: z.array(SupplierPayment),
});

// ------------------------------------------------------------------ delivery, documents, legal
export const Defect = z.object({
  id: z.string(),
  unitId: z.string(),
  handoverId: z.string().nullable(),
  contractorId: z.string().nullable(),
  reportedDate: IsoDate,
  description: z.string(),
  status: z.enum(["open", "fixed", "closed"]),
  fixedDate: IsoDate.nullable(),
  taskId: z.string().nullable(),
});

export const Handover = z.object({
  id: z.string(),
  unitId: z.string(),
  contractId: z.string().nullable(),
  date: IsoDate,
  status: z.string().nullable(),
  certificateDocumentId: z.string().nullable(),
  revenueJournalId: z.string().nullable(),
  costJournalId: z.string().nullable(),
  revenueMinor: MinorUnits,
  costOfSaleMinor: MinorUnits,
});

export const DocumentRecord = z.object({
  id: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  contentType: z.string(),
  kind: z.string().nullable(),
  linkEntity: z.string().nullable(),
  linkId: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  migrated: z.boolean(),
  createdAt: IsoDateTime,
});

export const LegalItem = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  kind: z.enum(["title", "approval", "licence", "insurance", "contract", "certificate", "other"]),
  expiryDate: IsoDate.nullable(),
  status: z.enum(["valid", "renew", "expired", "in_progress"]),
  documentId: z.string().nullable(),
});

export const ApprovalItem = z.object({
  type: z.string(),
  id: z.string(),
  reference: z.string(),
  detail: z.string(),
  amountMinor: MinorUnits,
});

const LedgerTie = z.object({ subledgerMinor: MinorUnits, ledgerMinor: MinorUnits, agrees: z.boolean() });

export const Dashboard = z.object({
  asOf: IsoDate,
  currency: z.string(),
  sales: z.object({
    unitsByStatus: z.record(z.string(), z.number().int()),
    contractValueMinor: MinorUnits,
    unsoldStockMinor: MinorUnits,
    openOffers: z.number().int(),
  }),
  collections: z.object({
    dueToDateMinor: MinorUnits,
    collectedMinor: MinorUnits,
    overdueMinor: MinorUnits,
    collectedPct: z.number().int(),
    /** Billed and unpaid instalments (subledger) against 1170 Buyer receivables. */
    receivables: LedgerTie,
    /** Buyer money held until handover (2400). */
    depositsHeldMinor: MinorUnits,
  }),
  cost: z.object({
    revisedMinor: MinorUnits,
    committedMinor: MinorUnits,
    invoicedMinor: MinorUnits,
    eacMinor: MinorUnits,
    costToCompleteMinor: MinorUnits,
    varianceMinor: MinorUnits,
    /** Costs on the cost report against the ledger's cost postings. */
    ledger: LedgerTie,
  }),
  payables: z.object({
    /** Supplier invoices owed (2000) and retention held (2050) against the ledger. */
    accountsPayable: LedgerTie,
    retention: LedgerTie,
  }),
  cash: z.object({ operatingMinor: MinorUnits, collectionsMinor: MinorUnits, totalMinor: MinorUnits }),
  revenue: z.object({ recognisedMinor: MinorUnits, costOfSalesMinor: MinorUnits }),
});

// ------------------------------------------------------------------ params
const Base = "/api/v1/orgs/:orgId/developer";
const ProjectParams = OrgParams.extend({ projectId: Id });
const p = <K extends string>(k: K) => OrgParams.extend({ [k]: Id } as Record<K, typeof Id>);

// ================================================================== endpoints: settings
export const getSettings = endpoint({
  id: "developer.settings.get",
  method: "GET",
  path: `${Base}/settings`,
  auth: "user",
  summary: "Reservation, matching and offer-approval rules, approval limits per role, and the cost codes",
  params: OrgParams,
  response: Settings,
});

export const updateSettings = endpoint({
  id: "developer.settings.update",
  method: "PUT",
  path: `${Base}/settings`,
  auth: "user",
  summary: "Change the rules, approval limits (replaces the whole table) and cost codes (upserted by code)",
  params: OrgParams,
  body: z.object({
    reservationDays: z.number().int().min(1).max(120).optional(),
    priceToleranceBp: Bp.optional(),
    bankHoldHours: z.number().int().min(0).max(720).optional(),
    offerRules: OfferRules.optional(),
    limits: z.array(ApprovalLimit).max(200).optional(),
    costCodes: z.array(CostCode).max(200).optional(),
  }),
  response: Settings,
});

// ================================================================== projects, units, price lists, milestones
export const listProjects = endpoint({
  id: "developer.projects.list",
  method: "GET",
  path: `${Base}/projects`,
  auth: "user",
  summary: "The organisation's development projects (including migrated ones)",
  params: OrgParams,
  response: z.object({ projects: z.array(Project) }),
});

const ProjectFields = z.object({
  name: Name,
  code: z.string().trim().max(20).nullable().optional(),
  location: ShortText.nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  stage: ShortText.nullable().optional(),
  progressPct: z.number().int().min(0).max(100).optional(),
  startDate: IsoDate.nullable().optional(),
  endDate: IsoDate.nullable().optional(),
  forecastEndDate: IsoDate.nullable().optional(),
});

export const createProject = endpoint({
  id: "developer.projects.create",
  method: "POST",
  path: `${Base}/projects`,
  auth: "user",
  summary: "Add a project (counts against the plan's project allowance)",
  params: OrgParams,
  body: ProjectFields,
  response: ProjectDetail,
  status: 201,
});

export const getProject = endpoint({
  id: "developer.projects.get",
  method: "GET",
  path: `${Base}/projects/:projectId`,
  auth: "user",
  summary: "A project with its phases, buildings, milestones and unit counts by status",
  params: ProjectParams,
  response: ProjectDetail,
});

export const updateProject = endpoint({
  id: "developer.projects.update",
  method: "PUT",
  path: `${Base}/projects/:projectId`,
  auth: "user",
  summary: "Change a project's status, stage, progress and dates",
  params: ProjectParams,
  body: ProjectFields.partial(),
  response: ProjectDetail,
});

export const createPhase = endpoint({
  id: "developer.phases.create",
  method: "POST",
  path: `${Base}/projects/:projectId/phases`,
  auth: "user",
  summary: "Add a phase to a project",
  params: ProjectParams,
  body: z.object({ name: Name, startDate: IsoDate.nullable().optional(), endDate: IsoDate.nullable().optional() }),
  response: ProjectDetail,
  status: 201,
});

export const createBuilding = endpoint({
  id: "developer.buildings.create",
  method: "POST",
  path: `${Base}/projects/:projectId/buildings`,
  auth: "user",
  summary: "Add a building or block; its floors are created from the number of floors",
  params: ProjectParams,
  body: z.object({
    name: Name,
    phaseId: Id.nullable().optional(),
    floorsCount: z.number().int().min(1).max(300),
  }),
  response: ProjectDetail,
  status: 201,
});

export const createUnits = endpoint({
  id: "developer.units.create",
  method: "POST",
  path: `${Base}/projects/:projectId/units`,
  auth: "user",
  summary: "Add units (unit numbers are unique in a project)",
  params: ProjectParams,
  body: z.object({
    units: z
      .array(
        z.object({
          unitNo: z.string().trim().min(1).max(40),
          buildingId: Id.nullable().optional(),
          level: z.number().int().min(-10).max(300).nullable().optional(),
          type: ShortText.nullable().optional(),
          bedrooms: z.number().int().min(0).max(50).nullable().optional(),
          areaSqm: z.number().positive().max(1e6).nullable().optional(),
          listPriceMinor: PositiveMinorUnits,
        }),
      )
      .min(1)
      .max(1000),
  }),
  response: z.object({ units: z.array(Unit) }),
  status: 201,
});

export const listUnits = endpoint({
  id: "developer.units.list",
  method: "GET",
  path: `${Base}/projects/:projectId/units`,
  auth: "user",
  summary: "A project's unit stock with status and list price",
  params: ProjectParams,
  query: z.object({ status: UnitStatus.optional() }),
  response: z.object({ units: z.array(Unit) }),
});

export const setUnitBlocked = endpoint({
  id: "developer.units.block",
  method: "POST",
  path: `${Base}/units/:unitId/block`,
  auth: "user",
  summary: "Take an available unit off sale (blocked) or put a blocked unit back on sale",
  params: p("unitId"),
  body: z.object({ blocked: z.boolean(), reason: Reason }),
  response: Unit,
});

export const createPriceList = endpoint({
  id: "developer.priceLists.create",
  method: "POST",
  path: `${Base}/projects/:projectId/price-lists`,
  auth: "user",
  summary: "Prepare a price list for unsold units; prices change only when someone else approves it",
  params: ProjectParams,
  body: z.object({
    effectiveDate: IsoDate,
    note: Text.default(""),
    items: z
      .array(z.object({ unitId: Id, priceMinor: PositiveMinorUnits }))
      .min(1)
      .max(2000),
  }),
  response: PriceList,
  status: 201,
});

export const listPriceLists = endpoint({
  id: "developer.priceLists.list",
  method: "GET",
  path: `${Base}/projects/:projectId/price-lists`,
  auth: "user",
  summary: "A project's price lists",
  params: ProjectParams,
  response: z.object({ priceLists: z.array(PriceList) }),
});

export const decidePriceList = endpoint({
  id: "developer.priceLists.decide",
  method: "POST",
  path: `${Base}/price-lists/:priceListId/decision`,
  auth: "user",
  summary: "Approve (new list prices apply to units still unsold) or reject a price list — not by its preparer",
  params: p("priceListId"),
  body: z.object({ approve: z.boolean(), reason: Text.optional() }),
  response: PriceList,
});

export const createMilestone = endpoint({
  id: "developer.milestones.create",
  method: "POST",
  path: `${Base}/projects/:projectId/milestones`,
  auth: "user",
  summary: "Add a construction milestone (mark the one that is practical completion)",
  params: ProjectParams,
  body: z.object({
    name: Name,
    phaseId: Id.nullable().optional(),
    dueDate: IsoDate,
    forecastDate: IsoDate.nullable().optional(),
    practicalCompletion: z.boolean().default(false),
  }),
  response: Milestone,
  status: 201,
});

export const updateMilestone = endpoint({
  id: "developer.milestones.update",
  method: "PUT",
  path: `${Base}/milestones/:milestoneId`,
  auth: "user",
  summary: "Record progress, a new forecast date or completion of a milestone",
  params: p("milestoneId"),
  body: z.object({
    forecastDate: IsoDate.nullable().optional(),
    percent: z.number().int().min(0).max(100).optional(),
    completedDate: IsoDate.nullable().optional(),
  }),
  response: Milestone,
});

// ================================================================== buyers
export const listBuyers = endpoint({
  id: "developer.buyers.list",
  method: "GET",
  path: `${Base}/buyers`,
  auth: "user",
  summary: "Buyers you may see (a sales agent sees only their own)",
  params: OrgParams,
  query: z.object({ q: z.string().trim().max(100).optional() }),
  response: z.object({ buyers: z.array(Buyer) }),
});

const BuyerFields = z.object({
  name: z.string().trim().min(3).max(160),
  email: Email.nullable().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{9,20}$/, "Phone number looks wrong")
    .nullable()
    .optional(),
  nationalId: z.string().trim().max(40).nullable().optional(),
  partyType: z.enum(["individual", "company"]).optional(),
  address: ShortText.nullable().optional(),
  source: ShortText.nullable().optional(),
});

export const createBuyer = endpoint({
  id: "developer.buyers.create",
  method: "POST",
  path: `${Base}/buyers`,
  auth: "user",
  summary: "Record a buyer enquiry. Refused when the same email, phone or ID already exists (open that buyer instead).",
  params: OrgParams,
  body: BuyerFields.extend({ agentUserId: Id.optional() }).refine(
    (b) => !!b.email || !!b.phone,
    "Enter a phone number or an email",
  ),
  response: Buyer,
  status: 201,
});

export const getBuyer = endpoint({
  id: "developer.buyers.get",
  method: "GET",
  path: `${Base}/buyers/:buyerId`,
  auth: "user",
  summary: "A buyer's profile: contracts, offers, reservations, money owed, disputes, correspondence and history",
  params: p("buyerId"),
  response: BuyerProfile,
});

export const updateBuyer = endpoint({
  id: "developer.buyers.update",
  method: "PUT",
  path: `${Base}/buyers/:buyerId`,
  auth: "user",
  summary: "Change a buyer's details, status or next follow-up",
  params: p("buyerId"),
  body: BuyerFields.partial().extend({
    status: z.enum(["active", "lost"]).optional(),
    nextFollowUp: IsoDate.nullable().optional(),
  }),
  response: Buyer,
});

export const assignBuyer = endpoint({
  id: "developer.buyers.assign",
  method: "POST",
  path: `${Base}/buyers/:buyerId/assign`,
  auth: "user",
  summary: "Reassign a buyer (and their open tasks) to another sales agent",
  params: p("buyerId"),
  body: z.object({ agentUserId: Id }),
  response: Buyer,
});

export const mergeBuyers = endpoint({
  id: "developer.buyers.merge",
  method: "POST",
  path: `${Base}/buyers/:buyerId/merge`,
  auth: "user",
  summary: "Merge a duplicate buyer into this one: offers, reservations, contracts, payments and tasks move across",
  params: p("buyerId"),
  body: z.object({ duplicateId: Id, reason: Reason }),
  response: Buyer,
});

export const recordCorrespondence = endpoint({
  id: "developer.buyers.correspondence",
  method: "POST",
  path: `${Base}/buyers/:buyerId/correspondence`,
  auth: "user",
  summary:
    "Record a call, meeting, letter or message with a buyer. Nothing is sent: no messaging provider is connected.",
  params: p("buyerId"),
  body: z.object({
    channel: z.enum(["email", "letter", "call", "meeting", "sms", "whatsapp", "other"]),
    subject: Name,
    summary: Text.optional(),
    contractId: Id.nullable().optional(),
    date: IsoDate.optional(),
  }),
  response: Correspondence,
  status: 201,
});

export const openDispute = endpoint({
  id: "developer.disputes.create",
  method: "POST",
  path: `${Base}/buyers/:buyerId/disputes`,
  auth: "user",
  summary: "Open a dispute or complaint with a buyer",
  params: p("buyerId"),
  body: z.object({ subject: Name, contractId: Id.nullable().optional(), amountMinor: NonNegativeMinor.optional() }),
  response: Dispute,
  status: 201,
});

export const resolveDispute = endpoint({
  id: "developer.disputes.resolve",
  method: "POST",
  path: `${Base}/disputes/:disputeId/resolve`,
  auth: "user",
  summary: "Resolve a buyer dispute with the outcome recorded",
  params: p("disputeId"),
  body: z.object({ resolution: Reason }),
  response: Dispute,
});

// ================================================================== offers, reservations, contracts
export const listOffers = endpoint({
  id: "developer.offers.list",
  method: "GET",
  path: `${Base}/offers`,
  auth: "user",
  summary: "Offers on buyers you may see (expired offers are marked expired first)",
  params: OrgParams,
  query: z.object({ status: z.enum(OFFER_STATUSES).optional(), buyerId: Id.optional() }),
  response: z.object({ offers: z.array(Offer) }),
});

const OfferTerms = z.object({
  priceMinor: PositiveMinorUnits,
  plan: Plan,
  validDays: z.number().int().min(1).max(30).default(7),
  conditions: Text.default(""),
});

export const createOffer = endpoint({
  id: "developer.offers.create",
  method: "POST",
  path: `${Base}/offers`,
  auth: "user",
  summary: "Draft an offer on an available unit for a buyer",
  params: OrgParams,
  body: OfferTerms.extend({ buyerId: Id, unitId: Id }),
  response: Offer,
  status: 201,
});

export const reviseOffer = endpoint({
  id: "developer.offers.revise",
  method: "PUT",
  path: `${Base}/offers/:offerId`,
  auth: "user",
  summary: "Revise a draft or countered offer (any earlier approval no longer applies)",
  params: p("offerId"),
  body: OfferTerms.partial(),
  response: Offer,
});

export const submitOffer = endpoint({
  id: "developer.offers.submit",
  method: "POST",
  path: `${Base}/offers/:offerId/submit`,
  auth: "user",
  summary: "Send an offer to the buyer — or, when its discount or plan needs it, to a sales manager or the CEO first",
  params: p("offerId"),
  response: Offer,
});

export const decideOffer = endpoint({
  id: "developer.offers.decide",
  method: "POST",
  path: `${Base}/offers/:offerId/decision`,
  auth: "user",
  summary: "Approve or decline an offer's terms (never by its preparer or agent)",
  params: p("offerId"),
  body: z.object({ approve: z.boolean(), reason: Text.optional() }),
  response: Offer,
});

export const respondToOffer = endpoint({
  id: "developer.offers.respond",
  method: "POST",
  path: `${Base}/offers/:offerId/response`,
  auth: "user",
  summary:
    "Record the buyer's answer: accept (the unit goes on hold and a reservation awaits approval), reject or counter",
  params: p("offerId"),
  body: z.object({
    response: z.enum(["accept", "reject", "counter"]),
    counter: z.object({ priceMinor: PositiveMinorUnits, plan: Plan, note: Text.default("") }).optional(),
    note: Text.optional(),
  }),
  response: Offer,
});

export const acceptCounter = endpoint({
  id: "developer.offers.acceptCounter",
  method: "POST",
  path: `${Base}/offers/:offerId/accept-counter`,
  auth: "user",
  summary: "Accept the buyer's counteroffer (sent for approval first when its terms need it)",
  params: p("offerId"),
  response: Offer,
});

export const withdrawOffer = endpoint({
  id: "developer.offers.withdraw",
  method: "POST",
  path: `${Base}/offers/:offerId/withdraw`,
  auth: "user",
  summary: "Withdraw an open offer",
  params: p("offerId"),
  body: z.object({ reason: Reason }),
  response: Offer,
});

export const listReservations = endpoint({
  id: "developer.reservations.list",
  method: "GET",
  path: `${Base}/reservations`,
  auth: "user",
  summary: "Reservations on buyers you may see (lapsed reservations are expired and their units released first)",
  params: OrgParams,
  query: z.object({ status: z.enum(RESERVATION_STATUSES).optional() }),
  response: z.object({ reservations: z.array(Reservation) }),
});

export const approveReservation = endpoint({
  id: "developer.reservations.approve",
  method: "POST",
  path: `${Base}/reservations/:reservationId/approve`,
  auth: "user",
  summary: "Approve a reservation: the unit is reserved until the expiry date (not by the person who owns the sale)",
  params: p("reservationId"),
  response: Reservation,
});

export const cancelReservation = endpoint({
  id: "developer.reservations.cancel",
  method: "POST",
  path: `${Base}/reservations/:reservationId/cancel`,
  auth: "user",
  summary: "Cancel a reservation; the unit is available again",
  params: p("reservationId"),
  body: z.object({ reason: Reason }),
  response: Reservation,
});

export const expireSales = endpoint({
  id: "developer.sales.expire",
  method: "POST",
  path: `${Base}/sales/expire`,
  auth: "user",
  summary: "Expire offers past their validity and reservations past their expiry date (units released)",
  params: OrgParams,
  response: z.object({ offersExpired: z.number().int(), reservationsExpired: z.number().int() }),
});

export const signContract = endpoint({
  id: "developer.contracts.sign",
  method: "POST",
  path: `${Base}/reservations/:reservationId/contract`,
  auth: "user",
  summary:
    "Record the signed sale agreement for an active reservation: the contract and its instalment schedule are created from the accepted terms",
  params: p("reservationId"),
  body: z.object({
    date: IsoDate,
    signedDocumentId: Id,
    number: z.string().trim().max(40).optional(),
    /** Only for a reservation brought over by data migration, which has no accepted offer. */
    priceMinor: PositiveMinorUnits.optional(),
    plan: Plan.optional(),
  }),
  response: Contract,
  status: 201,
});

export const listContracts = endpoint({
  id: "developer.contracts.list",
  method: "GET",
  path: `${Base}/contracts`,
  auth: "user",
  summary: "Sale contracts on buyers you may see, with their instalments",
  params: OrgParams,
  query: z.object({ projectId: Id.optional(), buyerId: Id.optional() }),
  response: z.object({ contracts: z.array(Contract) }),
});

export const contractStatement = endpoint({
  id: "developer.contracts.statement",
  method: "GET",
  path: `${Base}/contracts/:contractId/statement`,
  auth: "user",
  summary: "Statement of account: instalments falling due, amendments and verified receipts, with the balance",
  params: p("contractId"),
  query: z.object({ asOf: IsoDate.optional() }),
  response: Statement,
});

// ================================================================== collections
export const reportPayment = endpoint({
  id: "developer.payments.report",
  method: "POST",
  path: `${Base}/contracts/:contractId/payment-reports`,
  auth: "user",
  summary:
    "Record a buyer payment with its bank or mobile-money reference for finance to verify. Sales staff report one instalment in full; finance may record any amount (allocated to the oldest open instalments).",
  params: p("contractId"),
  body: z.object({
    instalmentId: Id.optional(),
    amountMinor: PositiveMinorUnits,
    method: PaymentMethod,
    reference: z.string().trim().min(6).max(60),
    date: IsoDate,
    proofDocumentId: Id.optional(),
  }),
  response: PaymentReport,
  status: 201,
});

export const listPaymentReports = endpoint({
  id: "developer.payments.list",
  method: "GET",
  path: `${Base}/payment-reports`,
  auth: "user",
  summary: "Reported buyer payments",
  params: OrgParams,
  query: z.object({ status: z.enum(["awaiting_verification", "verified", "rejected"]).optional() }),
  response: z.object({ reports: z.array(PaymentReport) }),
});

export const verifyPayment = endpoint({
  id: "developer.payments.verify",
  method: "POST",
  path: `${Base}/payment-reports/:reportId/verify`,
  auth: "user",
  summary:
    "Finance confirms the payment against the bank (not the person who reported it): a receipt is issued, the instalments are paid and the money posts to the ledger. Or reject it with a reason.",
  params: p("reportId"),
  body: z.object({ approve: z.boolean(), reason: Text.optional() }),
  response: PaymentReport,
});

export const billInstalments = endpoint({
  id: "developer.receivables.bill",
  method: "POST",
  path: `${Base}/receivables/bill`,
  auth: "user",
  summary:
    "Bill every instalment due by the date and not yet paid: Dr 1170 Buyer receivables / Cr 2400 Buyer deposits held (once per instalment)",
  params: OrgParams,
  body: z.object({ asOf: IsoDate.optional() }),
  response: z.object({ billed: z.number().int(), amountMinor: MinorUnits, journalIds: z.array(z.string()) }),
});

// ================================================================== handover, defects, tasks
export const recordHandover = endpoint({
  id: "developer.handovers.record",
  method: "POST",
  path: `${Base}/contracts/:contractId/handover`,
  auth: "user",
  summary:
    "Hand over a fully paid unit after practical completion, with the signed certificate: revenue and cost of sale are recognised",
  params: p("contractId"),
  body: z.object({ date: IsoDate, certificateDocumentId: Id }),
  response: Handover,
  status: 201,
});

export const listDefects = endpoint({
  id: "developer.defects.list",
  method: "GET",
  path: `${Base}/defects`,
  auth: "user",
  summary: "Defects and snags",
  params: OrgParams,
  query: z.object({ unitId: Id.optional(), status: z.enum(["open", "fixed", "closed"]).optional() }),
  response: z.object({ defects: z.array(Defect) }),
});

export const reportDefect = endpoint({
  id: "developer.defects.create",
  method: "POST",
  path: `${Base}/units/:unitId/defects`,
  auth: "user",
  summary: "Record a defect on a unit (a task is created for the person who fixes it)",
  params: p("unitId"),
  body: z.object({
    description: z.string().trim().min(3).max(1000),
    contractorId: Id.nullable().optional(),
    assigneeUserId: Id,
    dueDate: IsoDate,
  }),
  response: Defect,
  status: 201,
});

export const updateDefect = endpoint({
  id: "developer.defects.update",
  method: "POST",
  path: `${Base}/defects/:defectId/status`,
  auth: "user",
  summary: "Mark a defect fixed, or close it (closing needs someone other than the person who marked it fixed)",
  params: p("defectId"),
  body: z.object({ status: z.enum(["fixed", "closed", "open"]), note: Text.optional() }),
  response: Defect,
});

export const listTasks = endpoint({
  id: "developer.tasks.list",
  method: "GET",
  path: `${Base}/tasks`,
  auth: "user",
  summary: "Tasks: yours, or the team's for managers",
  params: OrgParams,
  query: z.object({ view: z.enum(["mine", "team", "overdue", "done"]).default("mine") }),
  response: z.object({ tasks: z.array(Task) }),
});

export const createTask = endpoint({
  id: "developer.tasks.create",
  method: "POST",
  path: `${Base}/tasks`,
  auth: "user",
  summary: "Create a task (for yourself, or for others if you manage)",
  params: OrgParams,
  body: z.object({
    title: z.string().trim().min(3).max(200),
    description: Text.default(""),
    dueDate: IsoDate,
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    category: z.enum(["sales", "finance", "aftersales", "site", "general"]).default("general"),
    assigneeUserId: Id.optional(),
    buyerId: Id.optional(),
    unitId: Id.optional(),
    projectId: Id.optional(),
  }),
  response: Task,
  status: 201,
});

export const completeTask = endpoint({
  id: "developer.tasks.complete",
  method: "POST",
  path: `${Base}/tasks/:taskId/complete`,
  auth: "user",
  summary: "Complete a task",
  params: p("taskId"),
  body: z.object({ note: Text.optional() }),
  response: Task,
});

export const afterSalesRequest = endpoint({
  id: "developer.aftersales.create",
  method: "POST",
  path: `${Base}/buyers/:buyerId/aftersales`,
  auth: "user",
  summary: "Record an after-sales request from a buyer with a signed contract (a task for their agent)",
  params: p("buyerId"),
  body: z.object({
    title: z.string().trim().min(5).max(200),
    description: Text.default(""),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  }),
  response: Task,
  status: 201,
});

// ================================================================== suppliers
export const listSuppliers = endpoint({
  id: "developer.suppliers.list",
  method: "GET",
  path: `${Base}/suppliers`,
  auth: "user",
  summary: "Suppliers and contractors with their status and payment blocks",
  params: OrgParams,
  response: z.object({ suppliers: z.array(Supplier), bankChanges: z.array(BankChange) }),
});

export const registerSupplier = endpoint({
  id: "developer.suppliers.create",
  method: "POST",
  path: `${Base}/suppliers`,
  auth: "user",
  summary: "Register a supplier or contractor: pending verification, nothing is paid until it is approved",
  params: OrgParams,
  body: z.object({
    kind: z.enum(["supplier", "contractor"]),
    name: Name,
    taxId: z.string().trim().min(3).max(40),
    email: Email.nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    trade: ShortText.nullable().optional(),
    bankAccount: z.string().trim().min(4).max(60),
    relatedParty: z.boolean().default(false),
    relatedNote: Text.optional(),
    missingDocuments: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
  }),
  response: Supplier,
  status: 201,
});

export const approveSupplier = endpoint({
  id: "developer.suppliers.approve",
  method: "POST",
  path: `${Base}/suppliers/:supplierId/approve`,
  auth: "user",
  summary: "Approve a supplier whose documents are complete (not by the person who registered it)",
  params: p("supplierId"),
  body: z.object({ rating: z.number().min(0).max(5).optional() }),
  response: Supplier,
});

export const logBankChange = endpoint({
  id: "developer.suppliers.bankChange",
  method: "POST",
  path: `${Base}/suppliers/:supplierId/bank-changes`,
  auth: "user",
  summary: "Log a change of a supplier's bank details: payments to it stop until a callback and the hold period",
  params: p("supplierId"),
  body: z.object({ newAccount: z.string().trim().min(4).max(60), receivedVia: z.string().trim().min(3).max(300) }),
  response: BankChange,
  status: 201,
});

export const verifyBankChange = endpoint({
  id: "developer.suppliers.verifyBankChange",
  method: "POST",
  path: `${Base}/bank-changes/:changeId/verify`,
  auth: "user",
  summary:
    "Record the callback on the number already on file (not by the person who logged the change); the hold starts",
  params: p("changeId"),
  body: z.object({ callbackNote: z.string().trim().min(5).max(300) }),
  response: BankChange,
});

// ================================================================== budgets and cost control
export const setBudget = endpoint({
  id: "developer.budgets.set",
  method: "PUT",
  path: `${Base}/projects/:projectId/budget`,
  auth: "user",
  summary:
    "Set the original budget per cost code (once; later changes go through transfers and change orders) and the uncommitted forecast",
  params: ProjectParams,
  body: z.object({
    lines: z
      .array(
        z.object({
          costCode: CostCodeKey,
          originalMinor: NonNegativeMinor.optional(),
          etcMinor: NonNegativeMinor.optional(),
          note: ShortText.optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  response: CostReport,
});

export const costReport = endpoint({
  id: "developer.budgets.report",
  method: "GET",
  path: `${Base}/projects/:projectId/cost-report`,
  auth: "user",
  summary: "Budget against committed, invoiced, paid and forecast final cost per cost code, tied to the ledger",
  params: ProjectParams,
  response: CostReport,
});

export const requestBudgetChange = endpoint({
  id: "developer.budgetChanges.create",
  method: "POST",
  path: `${Base}/projects/:projectId/budget-changes`,
  auth: "user",
  summary: "Request a budget transfer or a change order (funded from another cost code, usually contingency)",
  params: ProjectParams,
  body: z.object({
    kind: z.enum(["transfer", "change_order"]),
    fromCode: CostCodeKey,
    toCode: CostCodeKey,
    amountMinor: PositiveMinorUnits,
    reason: Reason,
  }),
  response: BudgetChange,
  status: 201,
});

export const listBudgetChanges = endpoint({
  id: "developer.budgetChanges.list",
  method: "GET",
  path: `${Base}/projects/:projectId/budget-changes`,
  auth: "user",
  summary: "A project's budget transfers and change orders",
  params: ProjectParams,
  response: z.object({ changes: z.array(BudgetChange) }),
});

export const decideBudgetChange = endpoint({
  id: "developer.budgetChanges.decide",
  method: "POST",
  path: `${Base}/budget-changes/:changeId/decision`,
  auth: "user",
  summary: "Approve (within your limit, not your own request) or reject a budget change",
  params: p("changeId"),
  body: z.object({ approve: z.boolean(), reason: Text.optional() }),
  response: BudgetChange,
});

// ================================================================== procurement
export const createRequisition = endpoint({
  id: "developer.requisitions.create",
  method: "POST",
  path: `${Base}/projects/:projectId/requisitions`,
  auth: "user",
  summary: "Raise a purchase requisition against a cost code (shown as proposed in cost control)",
  params: ProjectParams,
  body: z.object({
    costCode: CostCodeKey,
    item: Name,
    qty: Qty,
    unit: z.string().trim().min(1).max(20),
    estUnitPriceMinor: PositiveMinorUnits,
    needBy: IsoDate.optional(),
  }),
  response: Requisition,
  status: 201,
});

export const listRequisitions = endpoint({
  id: "developer.requisitions.list",
  method: "GET",
  path: `${Base}/requisitions`,
  auth: "user",
  summary: "Purchase requisitions",
  params: OrgParams,
  query: z.object({ projectId: Id.optional() }),
  response: z.object({ requisitions: z.array(Requisition) }),
});

export const decideRequisition = endpoint({
  id: "developer.requisitions.decide",
  method: "POST",
  path: `${Base}/requisitions/:requisitionId/decision`,
  auth: "user",
  summary: "Approve (within your limit, not your own) or reject a requisition",
  params: p("requisitionId"),
  body: z.object({ approve: z.boolean(), reason: Text.optional() }),
  response: Requisition,
});

export const createRfq = endpoint({
  id: "developer.rfqs.create",
  method: "POST",
  path: `${Base}/requisitions/:requisitionId/rfq`,
  auth: "user",
  summary: "Invite approved suppliers to quote for an approved requisition",
  params: p("requisitionId"),
  body: z.object({ supplierIds: z.array(Id).min(1).max(20), closes: IsoDate }),
  response: Rfq,
  status: 201,
});

export const getRfq = endpoint({
  id: "developer.rfqs.get",
  method: "GET",
  path: `${Base}/rfqs/:rfqId`,
  auth: "user",
  summary: "A request for quotation with its bids, ranked by weighted score",
  params: p("rfqId"),
  response: Rfq,
});

export const recordBid = endpoint({
  id: "developer.rfqs.bid",
  method: "POST",
  path: `${Base}/rfqs/:rfqId/bids`,
  auth: "user",
  summary: "Record an invited supplier's bid",
  params: p("rfqId"),
  body: z.object({
    supplierId: Id,
    unitPriceMinor: PositiveMinorUnits,
    leadDays: z.number().int().min(1).max(365),
    note: Text.default(""),
  }),
  response: Rfq,
});

export const awardRfq = endpoint({
  id: "developer.rfqs.award",
  method: "POST",
  path: `${Base}/rfqs/:rfqId/award`,
  auth: "user",
  summary: "Award to the best-scoring bid (or a named bidder, with a reason): a purchase order is raised for approval",
  params: p("rfqId"),
  body: z.object({ supplierId: Id.optional(), reason: Text.optional() }),
  response: Rfq,
});

const PoLineInput = z.object({
  item: Name,
  unit: z.string().trim().min(1).max(20),
  qty: Qty,
  unitPriceMinor: PositiveMinorUnits,
});

export const createPurchaseOrder = endpoint({
  id: "developer.purchaseOrders.create",
  method: "POST",
  path: `${Base}/projects/:projectId/purchase-orders`,
  auth: "user",
  summary:
    "Raise a purchase order (with lines) or a works contract (lump sum, with retention) for approval; it commits budget once approved",
  params: ProjectParams,
  body: z
    .object({
      kind: z.enum(["po", "contract"]),
      supplierId: Id,
      costCode: CostCodeKey,
      description: Name,
      lines: z.array(PoLineInput).max(200).default([]),
      amountMinor: PositiveMinorUnits.optional(),
      retentionBp: Bp.default(0),
      requisitionId: Id.optional(),
    })
    .refine((b) => b.lines.length > 0 || b.amountMinor !== undefined, "Give the order lines or a contract amount"),
  response: PurchaseOrder,
  status: 201,
});

export const listPurchaseOrders = endpoint({
  id: "developer.purchaseOrders.list",
  method: "GET",
  path: `${Base}/purchase-orders`,
  auth: "user",
  summary: "Purchase orders and contracts with delivery and invoicing progress",
  params: OrgParams,
  query: z.object({ projectId: Id.optional(), supplierId: Id.optional() }),
  response: z.object({ purchaseOrders: z.array(PurchaseOrder) }),
});

export const decidePurchaseOrder = endpoint({
  id: "developer.purchaseOrders.decide",
  method: "POST",
  path: `${Base}/purchase-orders/:poId/decision`,
  auth: "user",
  summary:
    "Approve (within your limit, not your own; related-party orders and orders over budget need the CEO) or reject an order",
  params: p("poId"),
  body: z.object({ approve: z.boolean(), reason: Text.optional() }),
  response: PurchaseOrder,
});

export const recordDelivery = endpoint({
  id: "developer.purchaseOrders.delivery",
  method: "POST",
  path: `${Base}/purchase-orders/:poId/deliveries`,
  auth: "user",
  summary: "Record a delivery note: quantities received and accepted after the quality check",
  params: p("poId"),
  body: z.object({
    date: IsoDate,
    note: Text.default(""),
    lines: z
      .array(z.object({ poLineId: Id, receivedQty: Qty, acceptedQty: z.number().min(0) }))
      .min(1)
      .max(200),
  }),
  response: Delivery,
  status: 201,
});

export const releaseRetention = endpoint({
  id: "developer.retention.release",
  method: "POST",
  path: `${Base}/purchase-orders/:poId/retention-release`,
  auth: "user",
  summary: "Prepare the release of retention held on a contract; it becomes payable once approved like an invoice",
  params: p("poId"),
  body: z.object({ amountMinor: PositiveMinorUnits, reason: Reason, dueDate: IsoDate }),
  response: SupplierInvoice,
  status: 201,
});

// ================================================================== supplier invoices and payments
export const captureInvoice = endpoint({
  id: "developer.invoices.capture",
  method: "POST",
  path: `${Base}/supplier-invoices`,
  auth: "user",
  summary:
    "Capture a supplier invoice with its evidence; checks run at once (duplicates, three-way match, supplier status, evidence)",
  params: OrgParams,
  body: z.object({
    supplierId: Id,
    projectId: Id,
    costCode: CostCodeKey.optional(),
    purchaseOrderId: Id.optional(),
    supplierInvoiceNo: z.string().trim().min(1).max(60),
    date: IsoDate,
    dueDate: IsoDate,
    description: Name,
    /** Order lines invoiced (three-way match); without lines, give the net amount. */
    lines: z
      .array(z.object({ poLineId: Id, qty: Qty, unitPriceMinor: PositiveMinorUnits }))
      .max(200)
      .default([]),
    netMinor: PositiveMinorUnits.optional(),
    vatBp: Bp,
    whtBp: Bp.default(0),
    retentionBp: Bp.optional(),
    evidenceDocumentId: Id.optional(),
  }),
  response: SupplierInvoice,
  status: 201,
});

export const listInvoices = endpoint({
  id: "developer.invoices.list",
  method: "GET",
  path: `${Base}/supplier-invoices`,
  auth: "user",
  summary: "Supplier invoices",
  params: OrgParams,
  query: z.object({ status: z.enum(INVOICE_STATUSES).optional(), projectId: Id.optional() }),
  response: z.object({ invoices: z.array(SupplierInvoice) }),
});

export const getInvoice = endpoint({
  id: "developer.invoices.get",
  method: "GET",
  path: `${Base}/supplier-invoices/:invoiceId`,
  auth: "user",
  summary: "A supplier invoice with its three-way match, exceptions and payments",
  params: p("invoiceId"),
  response: SupplierInvoice,
});

export const checkInvoice = endpoint({
  id: "developer.invoices.check",
  method: "POST",
  path: `${Base}/supplier-invoices/:invoiceId/check`,
  auth: "user",
  summary: "Run the checks again (after a delivery, credit note or supplier approval)",
  params: p("invoiceId"),
  response: SupplierInvoice,
});

export const decideInvoice = endpoint({
  id: "developer.invoices.decide",
  method: "POST",
  path: `${Base}/supplier-invoices/:invoiceId/decision`,
  auth: "user",
  summary:
    "approve a matched invoice (within your limit, not the capturer; it posts to the ledger), reject it, mark it a duplicate, or override an exception (CEO, with a reason)",
  params: p("invoiceId"),
  body: z.object({
    action: z.enum(["approve", "reject", "duplicate", "override"]),
    reason: Text.optional(),
  }),
  response: SupplierInvoice,
});

export const disputeInvoice = endpoint({
  id: "developer.invoices.dispute",
  method: "POST",
  path: `${Base}/supplier-invoices/:invoiceId/dispute`,
  auth: "user",
  summary: "Dispute part of an invoice before approval (it cannot be approved or paid while disputed)",
  params: p("invoiceId"),
  body: z.object({ amountMinor: PositiveMinorUnits, reason: Reason }),
  response: SupplierInvoice,
});

export const settleInvoiceDispute = endpoint({
  id: "developer.invoices.settleDispute",
  method: "POST",
  path: `${Base}/supplier-invoices/:invoiceId/settle-dispute`,
  auth: "user",
  summary: "Settle a dispute by accepting the supplier's credit for the disputed amount; the rest goes back to checks",
  params: p("invoiceId"),
  response: SupplierInvoice,
});

export const applyCreditNote = endpoint({
  id: "developer.invoices.creditNote",
  method: "POST",
  path: `${Base}/supplier-invoices/:invoiceId/credit-notes`,
  auth: "user",
  summary: "Apply a supplier credit note to an invoice not yet approved (quantities on lines, or an amount)",
  params: p("invoiceId"),
  body: z
    .object({
      supplierCreditNo: z.string().trim().min(1).max(60),
      reason: Reason,
      lines: z
        .array(z.object({ poLineId: Id, qty: Qty }))
        .max(200)
        .default([]),
      netMinor: PositiveMinorUnits.optional(),
    })
    .refine((b) => b.lines.length > 0 || b.netMinor !== undefined, "Give the credited quantities or an amount"),
  response: SupplierInvoice,
});

export const preparePaymentRun = endpoint({
  id: "developer.paymentRuns.prepare",
  method: "POST",
  path: `${Base}/payment-runs`,
  auth: "user",
  summary:
    "Prepare a payment run from approved invoices due within the window (suppliers with an unverified bank change are left out)",
  params: OrgParams,
  body: z.object({
    dueWithinDays: z.number().int().min(0).max(365).default(10),
    invoiceIds: z.array(Id).max(500).optional(),
  }),
  response: PaymentRun,
  status: 201,
});

export const listPaymentRuns = endpoint({
  id: "developer.paymentRuns.list",
  method: "GET",
  path: `${Base}/payment-runs`,
  auth: "user",
  summary: "Payment runs with their payments",
  params: OrgParams,
  response: z.object({ runs: z.array(PaymentRun) }),
});

export const approvePaymentRun = endpoint({
  id: "developer.paymentRuns.approve",
  method: "POST",
  path: `${Base}/payment-runs/:runId/approve`,
  auth: "user",
  summary: "Approve a payment run (within your limit; never the person who prepared it)",
  params: p("runId"),
  response: PaymentRun,
});

export const executePaymentRun = endpoint({
  id: "developer.paymentRuns.execute",
  method: "POST",
  path: `${Base}/payment-runs/:runId/execute`,
  auth: "user",
  summary:
    "Treasury generates the bank file for upload on the bank portal (no bank is connected; not the approver). Payments post to the ledger as sent.",
  params: p("runId"),
  response: z.object({ run: PaymentRun, bankFile: z.object({ filename: z.string(), content: z.string() }) }),
});

export const reconcilePayments = endpoint({
  id: "developer.paymentRuns.reconcile",
  method: "POST",
  path: `${Base}/payment-runs/reconcile`,
  auth: "user",
  summary:
    "Match bank statement lines to sent payments by reference and amount (not by the person who executed the run); matched invoices become paid",
  params: OrgParams,
  body: z.object({
    lines: z
      .array(z.object({ date: IsoDate, reference: z.string().trim().min(1).max(80), amountMinor: MinorUnits }))
      .min(1)
      .max(2000),
  }),
  response: z.object({
    matched: z.number().int(),
    unmatched: z.array(z.object({ reference: z.string(), amountMinor: MinorUnits, reason: z.string() })),
  }),
});

export const reverseSupplierPayment = endpoint({
  id: "developer.supplierPayments.reverse",
  method: "POST",
  path: `${Base}/supplier-payments/:paymentId/reverse`,
  auth: "user",
  summary:
    "Reverse a supplier payment (returned or wrong account): a reversing entry is posted, the invoice is owed again",
  params: p("paymentId"),
  body: z.object({ reason: Reason }),
  response: SupplierPayment,
});

// ================================================================== documents and legal register
export const registerDocument = endpoint({
  id: "developer.documents.register",
  method: "POST",
  path: `${Base}/documents`,
  auth: "user",
  summary:
    "Record a document's metadata (name, size, SHA-256) and what it belongs to — signed agreements, certificates, invoices, proofs of payment",
  params: OrgParams,
  body: z.object({
    filename: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().min(1).max(500_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 as 64 lowercase hex characters"),
    contentType: z.string().trim().min(3).max(100),
    kind: z.string().trim().min(2).max(60),
    linkEntity: z
      .enum([
        "project",
        "unit",
        "buyer",
        "contract",
        "reservation",
        "supplier",
        "purchase_order",
        "invoice",
        "handover",
      ])
      .optional(),
    linkId: Id.optional(),
  }),
  response: DocumentRecord,
  status: 201,
});

export const listDocuments = endpoint({
  id: "developer.documents.list",
  method: "GET",
  path: `${Base}/documents`,
  auth: "user",
  summary: "Document records (created here or brought over by data migration)",
  params: OrgParams,
  query: z.object({ linkEntity: z.string().max(40).optional(), linkId: Id.optional() }),
  response: z.object({ documents: z.array(DocumentRecord) }),
});

export const listLegal = endpoint({
  id: "developer.legal.list",
  method: "GET",
  path: `${Base}/legal`,
  auth: "user",
  summary: "Legal and compliance register with expiry tracking (status follows the expiry date)",
  params: OrgParams,
  query: z.object({ projectId: Id.optional() }),
  response: z.object({ items: z.array(LegalItem) }),
});

export const createLegal = endpoint({
  id: "developer.legal.create",
  method: "POST",
  path: `${Base}/legal`,
  auth: "user",
  summary: "Add a title, approval, licence, insurance or other compliance item",
  params: OrgParams,
  body: z.object({
    projectId: Id,
    title: Name,
    kind: LegalItem.shape.kind,
    expiryDate: IsoDate.nullable().optional(),
    inProgress: z.boolean().default(false),
    documentId: Id.nullable().optional(),
  }),
  response: LegalItem,
  status: 201,
});

// ================================================================== dashboards and approvals
export const dashboard = endpoint({
  id: "developer.dashboard",
  method: "GET",
  path: `${Base}/dashboard`,
  auth: "user",
  summary:
    "Sales, collections, cost to complete, payables, cash and revenue — every money figure shown next to the ledger balance it must equal",
  params: OrgParams,
  query: z.object({ projectId: Id.optional() }),
  response: Dashboard,
});

export const approvals = endpoint({
  id: "developer.approvals",
  method: "GET",
  path: `${Base}/approvals`,
  auth: "user",
  summary: "Everything waiting for a decision that you may take (limits and separation of duties applied)",
  params: OrgParams,
  response: z.object({ items: z.array(ApprovalItem) }),
});
