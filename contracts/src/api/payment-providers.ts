// Payment provider adapters. Each one only TRANSLATES a provider's own callback into the core payment event
// (payments.ts); whether anything is paid is decided by the core's rules alone: a valid signature
// (X-Paltas-Signature with WEBHOOK_SECRET_<PROVIDER>), then the exact amount and currency of what is owed.
//
//   M-Pesa (Daraja): STK push result callbacks and C2B confirmations, by the account reference the payer used.
//   Card (generic PSP webhook): payment.succeeded / payment.failed / refund.succeeded.
//   Bank transfers: a statement (CSV) is imported, PALTAS suggests matches, and a DIFFERENT person in finance
//   confirms each one.
//
// No live connection exists: Daraja and PSP credentials, callback registration and the relay that signs callbacks
// are not set up (BLOCKED). The adapters are tested with recorded sample payloads written from public documentation.
import { z } from "zod";
import { Currency, IsoDate, IsoDateTime, MinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";
import { PaymentEventResult } from "./payments.js";

const ProviderParams = z.object({ provider: z.string().regex(/^[a-z0-9_-]{2,40}$/) });

export const AdapterState = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["mpesa", "card", "bank"]),
  /** True only when a live provider connection exists. None does yet. */
  connected: z.boolean(),
  status: z.string(),
  /** Providers with a signing secret configured (WEBHOOK_SECRET_<PROVIDER>), so their signed callbacks are accepted. */
  signingSecretFor: z.array(z.string()),
});

export const listAdapters = endpoint({
  id: "paymentProviders.adapters",
  method: "GET",
  path: "/api/v1/admin/payment-providers",
  auth: "staff",
  summary: "Payment provider adapters and their connection state",
  response: z.object({ adapters: z.array(AdapterState) }),
});

// ---------------------------------------------------------------- M-Pesa (Daraja)

const MpesaItem = z.object({ Name: z.string(), Value: z.union([z.string(), z.number()]).optional() });

/** Daraja STK push result (Lipa na M-Pesa Online callback). */
export const MpesaStkCallback = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string().min(1).max(100),
      ResultCode: z.number().int(),
      ResultDesc: z.string(),
      CallbackMetadata: z.object({ Item: z.array(MpesaItem) }).optional(),
    }),
  }),
});

/** Daraja C2B confirmation (Pay Bill / Buy Goods). */
export const MpesaC2bConfirmation = z.object({
  TransactionType: z.string(),
  TransID: z.string().min(1).max(40),
  TransTime: z.string(),
  TransAmount: z.union([z.string(), z.number()]),
  BusinessShortCode: z.string(),
  BillRefNumber: z.string().max(100).default(""),
  InvoiceNumber: z.string().optional(),
  MSISDN: z.string().optional(),
});

export const mpesaCallback = endpoint({
  id: "webhooks.mpesa",
  method: "POST",
  path: "/api/v1/webhooks/mpesa/:provider",
  auth: "signed-webhook",
  summary: "M-Pesa STK result or C2B confirmation, signed by the PALTAS relay (WEBHOOK_SECRET_<PROVIDER>)",
  params: ProviderParams,
  body: z.union([MpesaStkCallback, MpesaC2bConfirmation]),
  // Daraja expects ResultCode 0 for an accepted callback
  response: z.object({
    ResultCode: z.literal(0),
    ResultDesc: z.string(),
    outcome: PaymentEventResult.nullable(),
  }),
});

// ---------------------------------------------------------------- card (generic PSP)

export const CardWebhookEvent = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  created: z.number().int().optional(),
  data: z.object({
    id: z.string().min(1).max(200),
    amount: MinorUnits,
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    reference: z.string().max(100).default(""),
    failure_reason: z.string().max(500).nullable().optional(),
  }),
});

export const cardEvent = endpoint({
  id: "webhooks.cards",
  method: "POST",
  path: "/api/v1/webhooks/cards/:provider",
  auth: "signed-webhook",
  summary: "Card processor webhook (generic PSP shape), signed with WEBHOOK_SECRET_<PROVIDER>",
  params: ProviderParams,
  body: CardWebhookEvent,
  response: z.object({ received: z.literal(true), outcome: PaymentEventResult.nullable(), note: z.string() }),
});

// ---------------------------------------------------------------- what payments are for

export const PaymentReference = z.object({
  id: z.string(),
  reference: z.string(),
  type: z.string(),
  invoiceId: z.string().nullable(),
  amountMinor: MinorUnits,
  currency: Currency,
  status: z.enum(["open", "settled", "cancelled"]),
  createdAt: IsoDateTime,
});

export const listReferences = endpoint({
  id: "paymentProviders.references",
  method: "GET",
  path: "/api/v1/orgs/:orgId/payment-references",
  auth: "user",
  summary: "Payment references the organisation's products issued (what M-Pesa, card and bank payments are matched to)",
  params: OrgParams,
  query: z.object({ status: z.enum(["open", "settled", "cancelled"]).optional() }),
  response: z.object({ references: z.array(PaymentReference) }),
});

// ---------------------------------------------------------------- bank statement import

export const Suggestion = z.object({
  /** A payment reference id (organisation statements) or a PALTAS invoice id (PALTAS statements). */
  id: z.string(),
  kind: z.enum(["reference", "invoice"]),
  reference: z.string(),
  orgId: z.string().nullable(),
  amountMinor: MinorUnits,
  currency: Currency,
  /** 0–100: reference quoted and amount equal = 100; amount equal only = 40. */
  score: z.number().int(),
  why: z.string(),
});

export const BankLine = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  valueDate: IsoDate,
  amountMinor: MinorUnits,
  currency: Currency,
  bankRef: z.string(),
  description: z.string(),
  status: z.enum(["unmatched", "suggested", "confirmed", "ignored", "duplicate", "outgoing"]),
  suggestions: z.array(Suggestion),
  decidedBy: z.string().nullable(),
  decidedAt: IsoDateTime.nullable(),
  decisionReason: z.string().nullable(),
  matchedReference: z.string().nullable(),
  result: z.string().nullable(),
});

export const BankStatement = z.object({
  id: z.string(),
  accountLabel: z.string(),
  currency: Currency,
  lineCount: z.number().int(),
  importedBy: z.string(),
  importedAt: IsoDateTime,
  open: z.number().int(),
});

export const ImportStatementBody = z.object({
  accountLabel: z.string().trim().min(2).max(120),
  currency: Currency,
  dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]).default("YYYY-MM-DD"),
  /** CSV with a header row: date, amount, reference, description (optional currency). Credits are positive. */
  csv: z.string().min(10).max(200_000),
});

const StatementParams = OrgParams.extend({ statementId: z.string().min(1) });
const LineParams = StatementParams.extend({ lineId: z.string().min(1) });
const StatementWithLines = z.object({ statement: BankStatement, lines: z.array(BankLine) });

export const importStatement = endpoint({
  id: "paymentProviders.bank.import",
  method: "POST",
  path: "/api/v1/orgs/:orgId/bank-statements",
  auth: "user",
  summary: "Import a bank statement and get match suggestions. Nothing is applied until someone else confirms.",
  params: OrgParams,
  body: ImportStatementBody,
  response: StatementWithLines,
  status: 201,
});

export const listStatements = endpoint({
  id: "paymentProviders.bank.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/bank-statements",
  auth: "user",
  summary: "Imported bank statements, newest first",
  params: OrgParams,
  response: z.object({ statements: z.array(BankStatement) }),
});

export const getStatement = endpoint({
  id: "paymentProviders.bank.get",
  method: "GET",
  path: "/api/v1/orgs/:orgId/bank-statements/:statementId",
  auth: "user",
  summary: "A statement's lines with their suggestions and decisions",
  params: StatementParams,
  response: StatementWithLines,
});

export const ConfirmBody = z.object({ match: z.string().min(1), reason: Reason });

export const confirmLine = endpoint({
  id: "paymentProviders.bank.confirm",
  method: "POST",
  path: "/api/v1/orgs/:orgId/bank-statements/:statementId/lines/:lineId/confirm",
  auth: "user",
  summary:
    "Confirm a match (not the person who imported the statement). The payment goes through the core payment rules.",
  params: LineParams,
  body: ConfirmBody,
  response: z.object({ line: BankLine, outcome: PaymentEventResult }),
});

export const ignoreLine = endpoint({
  id: "paymentProviders.bank.ignore",
  method: "POST",
  path: "/api/v1/orgs/:orgId/bank-statements/:statementId/lines/:lineId/ignore",
  auth: "user",
  summary: "Mark a line as not a customer payment, with a reason",
  params: LineParams,
  body: z.object({ reason: Reason }),
  response: BankLine,
});

// PALTAS's own account: subscription invoices paid by bank transfer (Super Admin)

const AdminStatementParams = z.object({ statementId: z.string().min(1) });

export const adminImportStatement = endpoint({
  id: "paymentProviders.admin.bank.import",
  method: "POST",
  path: "/api/v1/admin/bank-statements",
  auth: "staff",
  summary: "Import PALTAS's bank statement; lines are matched to open subscription invoices",
  body: ImportStatementBody,
  response: StatementWithLines,
  status: 201,
});

export const adminGetStatement = endpoint({
  id: "paymentProviders.admin.bank.get",
  method: "GET",
  path: "/api/v1/admin/bank-statements/:statementId",
  auth: "staff",
  summary: "A PALTAS statement's lines with their suggestions and decisions",
  params: AdminStatementParams,
  response: StatementWithLines,
});

export const adminConfirmLine = endpoint({
  id: "paymentProviders.admin.bank.confirm",
  method: "POST",
  path: "/api/v1/admin/bank-statements/:statementId/lines/:lineId/confirm",
  auth: "staff",
  summary: "Confirm a line pays a subscription invoice (another Super Admin than the importer)",
  params: AdminStatementParams.extend({ lineId: z.string().min(1) }),
  body: ConfirmBody,
  response: z.object({ line: BankLine, outcome: PaymentEventResult }),
});
