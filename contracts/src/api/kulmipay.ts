import { z } from "zod";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";
const Environment = z.enum(["sandbox", "live"]);
const Connection = z.object({
  environment: Environment,
  walletId: z.string(),
  active: z.boolean(),
  connectedAt: z.string(),
});
const Request = z.object({
  id: z.string(),
  invoiceId: z.string(),
  provider: z.enum(["M-PESA", "PESALINK"]),
  environment: Environment,
  amountMinor: z.number(),
  state: z.string(),
  feeMinor: z.number().nullable(),
  netMinor: z.number().nullable(),
  clearingStatus: z.string().nullable(),
  receiptReference: z.string().nullable(),
  checkedAt: z.string().nullable(),
  ledgerPosted: z.boolean(),
  paymentId: z.string().nullable(),
  postingError: z.string().nullable(),
  settlementId: z.string().nullable(),
});
export const connection = endpoint({
  id: "kulmiPay.connection",
  summary: "Client-owned KulmiPay connection",
  method: "GET",
  path: "/api/v1/orgs/:orgId/property/kulmipay",
  auth: "user",
  params: OrgParams,
  response: z.object({
    enabled: z.boolean(),
    sandboxCollectionEnabled: z.boolean(),
    connection: Connection.nullable(),
    liveCollectionEnabled: z.boolean(),
    automaticPostingEnabled: z.boolean(),
  }),
});
export const connect = endpoint({
  id: "kulmiPay.connect",
  summary: "Client-owned KulmiPay connect",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/property/kulmipay",
  auth: "user",
  params: OrgParams,
  body: z.object({
    environment: Environment,
    walletId: z.string().regex(/^[A-Za-z0-9_-]{1,140}$/),
    secretKey: z
      .string()
      .regex(/^ISSecretKey_(test|live)_[A-Za-z0-9_-]+$/)
      .max(300),
    challenge: z.string().min(32).max(256),
    confirmClientOwnedAccount: z.literal(true),
  }),
  response: z.object({ connection: Connection }),
});
export const pause = endpoint({
  id: "kulmiPay.pause",
  summary: "Client-owned KulmiPay pause",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/pause",
  auth: "user",
  params: OrgParams,
  body: z.object({ reason: z.string().min(5).max(500) }),
  response: z.object({ paused: z.literal(true) }),
});
export const request = endpoint({
  id: "kulmiPay.request",
  summary: "Client-owned KulmiPay request",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/requests",
  auth: "user",
  params: OrgParams,
  body: z.object({
    invoiceId: z.string(),
    expectedAmountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    provider: z.enum(["M-PESA", "PESALINK"]),
    phone: z
      .string()
      .regex(/^254[17]\d{8}$/)
      .optional(),
    confirm: z.literal(true),
  }),
  response: Request,
});
export const refresh = endpoint({
  id: "kulmiPay.refresh",
  summary: "Client-owned KulmiPay refresh",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/requests/:requestId/refresh",
  auth: "user",
  params: OrgParams.extend({ requestId: z.string() }),
  body: z.object({ providerInvoiceId: z.string().min(1).max(140).optional() }).default({}),
  response: Request,
});
export const list = endpoint({
  id: "kulmiPay.list",
  summary: "Client-owned KulmiPay list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/property/kulmipay/requests",
  auth: "user",
  params: OrgParams,
  query: z.object({ propertyId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  response: z.object({ requests: z.array(Request) }),
});
export const webhook = endpoint({
  id: "kulmiPay.webhook",
  summary: "Client-owned KulmiPay webhook",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/webhook",
  auth: "public",
  params: OrgParams,
  body: z.object({
    challenge: z.string().max(256),
    invoice_id: z.string().min(1).max(140),
    api_ref: z.string().min(1).max(140),
  }),
  response: z.object({ received: z.literal(true) }),
});

const Settlement = z.object({
  id: z.string(),
  bankLineId: z.string(),
  amountMinor: z.number(),
  reason: z.string(),
  status: z.enum(["prepared", "approved", "rejected"]),
  preparedBy: z.string(),
  approvedBy: z.string().nullable(),
  rejectedReason: z.string().nullable(),
  journalId: z.string().nullable(),
  bankReference: z.string(),
  date: z.string(),
  requestIds: z.array(z.string()),
});
const SettlementParams = OrgParams.extend({ settlementId: z.string() });
export const listSettlements = endpoint({
  id: "kulmiPay.settlements.list",
  summary: "List independently reviewed KulmiPay bank settlements",
  method: "GET",
  path: "/api/v1/orgs/:orgId/property/kulmipay/settlements",
  auth: "user",
  params: OrgParams,
  response: z.object({ settlements: z.array(Settlement) }),
});
export const prepareSettlement = endpoint({
  id: "kulmiPay.settlements.prepare",
  summary: "Prepare a manual bank statement match for net provider collections",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/settlements",
  auth: "user",
  params: OrgParams,
  body: z.object({
    bankLineId: z.string(),
    requestIds: z.array(z.string()).min(1).max(100),
    reason: z.string().min(6).max(500),
  }),
  response: Settlement,
});
export const approveSettlement = endpoint({
  id: "kulmiPay.settlements.approve",
  summary: "Independently approve a bank settlement and transfer clearing to bank ledger",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/settlements/:settlementId/approve",
  auth: "user",
  params: SettlementParams,
  body: z.object({ confirm: z.literal("CONFIRM_BANK_SETTLEMENT") }),
  response: Settlement,
});
export const rejectSettlement = endpoint({
  id: "kulmiPay.settlements.reject",
  summary: "Reject a settlement review without deleting history",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/kulmipay/settlements/:settlementId/reject",
  auth: "user",
  params: SettlementParams,
  body: z.object({ reason: z.string().min(6).max(500) }),
  response: Settlement,
});

// Receiving details are registration records, never proof of merchant onboarding or payout approval.
const ReceivingAccount = z.object({
  revision: z.number().int().positive(),
  kind: z.enum(["bank", "mpesa_mobile", "mpesa_paybill", "mpesa_till"]),
  accountHolder: z.string(),
  accountMasked: z.string(),
  bankCode: z.string().nullable(),
  accountReferenceMasked: z.string().nullable(),
  status: z.enum(["verification_pending", "paused"]),
  savedAt: z.string(),
});
export const receivingAccount = endpoint({
  id: "rentCollection.receivingAccount",
  summary: "Company receiving account registration",
  method: "GET",
  path: "/api/v1/orgs/:orgId/property/receiving-account",
  auth: "user",
  params: OrgParams,
  response: z.object({
    account: ReceivingAccount.nullable(),
    automaticSettlementEnabled: z.literal(false),
    manualInstructionsEnabled: z.boolean().default(false),
  }),
});
export const saveReceivingAccount = endpoint({
  id: "rentCollection.saveReceivingAccount",
  summary: "Save encrypted receiving details for verification",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/property/receiving-account",
  auth: "user",
  params: OrgParams,
  body: z.object({
    expectedRevision: z.number().int().nonnegative(),
    kind: z.enum(["bank", "mpesa_mobile", "mpesa_paybill", "mpesa_till"]),
    accountHolder: z.string().trim().min(2).max(160),
    accountNumber: z.string().trim().min(5).max(24).optional(),
    bankCode: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional(),
    accountReference: z.string().trim().min(1).max(20).optional(),
    reason: z.string().trim().min(6).max(500),
    confirmAuthority: z.literal(true),
  }),
  response: z.object({ account: ReceivingAccount, automaticSettlementEnabled: z.literal(false) }),
});
export const pauseReceivingAccount = endpoint({
  id: "rentCollection.pauseReceivingAccount",
  summary: "Pause a registered receiving destination",
  method: "POST",
  path: "/api/v1/orgs/:orgId/property/receiving-account/pause",
  auth: "user",
  params: OrgParams,
  body: z.object({ expectedRevision: z.number().int().positive(), reason: z.string().trim().min(6).max(500) }),
  response: z.object({ account: ReceivingAccount, automaticSettlementEnabled: z.literal(false) }),
});
