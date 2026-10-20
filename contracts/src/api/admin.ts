// PALTAS Super Admin (staff only, second factor required at sign-in). Owning a building or paying for a subscription
// grants nothing here: a client administrator is never staff.
import { z } from "zod";
import { Product } from "../access.js";
import { Currency, Email, IsoDate, IsoDateTime, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { AuditEntry, Member, Organisation } from "./organisations.js";
import { PaymentEventResult } from "./payments.js";
import { SignupRequest, TrialPolicy } from "./signup.js";
import {
  BillingInvoice,
  CatalogueSchema,
  EntitlementsView,
  PendingChangeSchema,
  SubscriptionStatusSchema,
  TierSchema,
} from "./subscriptions.js";

export const getCatalogue = endpoint({
  id: "admin.catalogue",
  method: "GET",
  path: "/api/v1/admin/catalogue",
  auth: "staff",
  summary: "Every module and plan, with prices as PALTAS configured them",
  response: CatalogueSchema,
});

export const savePlan = endpoint({
  id: "admin.savePlan",
  method: "PUT",
  path: "/api/v1/admin/plans/:planId",
  auth: "staff",
  summary: "Create or change a plan. Issued invoices are never rewritten; changes apply to new invoices.",
  params: z.object({ planId: z.string().regex(/^[A-Z0-9-]{2,40}$/) }),
  body: z.object({
    name: z.string().trim().min(3).max(120),
    tier: TierSchema.nullable().default(null),
    product: Product,
    modules: z.array(z.string()).default([]),
    buildingsIncluded: z.number().int().min(0),
    baseMinor: z.number().int().positive().nullable().default(null),
    extraBuildingMinor: z.number().int().positive().nullable().default(null),
    currency: Currency.optional(),
    frequency: z.enum(["monthly", "quarterly", "yearly"]).default("monthly"),
    /** Not used for trials any more: the platform trial policy sets the trial length for every plan. */
    trialDays: z.number().int().min(0).max(90).default(30),
    taxPct: z.number().min(0).max(100).nullable().default(null),
    taxNote: z.string().max(300).default(""),
    capSites: z.number().int().min(0).nullable().default(null),
    capUnits: z.number().int().min(0).nullable().default(null),
  }),
  response: z.object({ ok: z.literal(true), created: z.boolean() }),
});

export const saveModule = endpoint({
  id: "admin.saveModule",
  method: "PUT",
  path: "/api/v1/admin/modules/:moduleKey",
  auth: "staff",
  summary: "Change a module's dependencies, exclusions, price, availability or scope",
  params: z.object({ moduleKey: z.string().min(1) }),
  body: z.object({
    deps: z.array(z.string()).optional(),
    excludes: z.array(z.string()).optional(),
    priceMinor: z.number().int().positive().nullable().optional(),
    currency: Currency.optional(),
    available: z.boolean().optional(),
    products: z.array(z.string()).optional(),
    scope: z.enum(["product", "organisation"]).optional(),
  }),
  response: z.object({ ok: z.literal(true) }),
});

export const AdminOrgRow = Organisation.extend({
  subscriptions: z.array(
    z.object({
      product: Product,
      plan: z.string().nullable(),
      status: SubscriptionStatusSchema,
      trialEnds: IsoDate.nullable(),
    }),
  ),
});

export const listOrganisations = endpoint({
  id: "admin.orgs.list",
  method: "GET",
  path: "/api/v1/admin/orgs",
  auth: "staff",
  summary: "Every customer organisation with its subscriptions",
  response: z.object({ organisations: z.array(AdminOrgRow) }),
});

export const createOrganisation = endpoint({
  id: "admin.orgs.create",
  method: "POST",
  path: "/api/v1/admin/orgs",
  auth: "staff",
  summary: "Create a customer organisation, its first product subscription and its administrator",
  body: z.object({
    name: z.string().trim().min(3).max(160),
    legalName: z.string().trim().max(200).optional(),
    product: Product,
    plan: z.string().min(1),
    country: z.string().trim().min(2).max(80),
    currency: Currency,
    timezone: z.string().min(1).default("UTC"),
    trial: z.boolean().default(true),
    admin: z.object({ email: Email, name: z.string().trim().min(2).max(120).optional() }),
    /** Start the trial although the same business had one inside the policy window (kept with the trial). */
    repeatTrialReason: Reason.optional(),
  }),
  response: z.object({ id: z.string(), temporaryPassword: z.string().nullable() }),
  status: 201,
});

export const setSubscriptionStatus = endpoint({
  id: "admin.orgs.status",
  method: "POST",
  path: "/api/v1/admin/orgs/:orgId/status",
  auth: "staff",
  summary: "Change the status of ONE product subscription, with a reason. Other products are not affected.",
  params: z.object({ orgId: z.string().min(1) }),
  body: z.object({
    status: z.enum(["active", "trial", "suspended", "expired"]),
    reason: Reason,
    product: Product.optional(),
  }),
  response: z.object({ ok: z.literal(true), product: Product }),
});

export const addOrgProduct = endpoint({
  id: "admin.orgs.addProduct",
  method: "POST",
  path: "/api/v1/admin/orgs/:orgId/products",
  auth: "staff",
  summary: "Give an organisation another product subscription",
  params: z.object({ orgId: z.string().min(1) }),
  body: z.object({ product: Product, plan: z.string().min(1), trial: z.boolean().default(false) }),
  response: z.object({ ok: z.literal(true) }),
  status: 201,
});

export const issueInvoice = endpoint({
  id: "admin.orgs.issueInvoice",
  method: "POST",
  path: "/api/v1/admin/orgs/:orgId/invoices",
  auth: "staff",
  summary: "Issue the subscription invoice for the next period (once per period)",
  params: z.object({ orgId: z.string().min(1) }),
  body: z.object({ product: Product.optional() }),
  response: BillingInvoice,
  status: 201,
});

export const recordReceipt = endpoint({
  id: "admin.invoices.recordReceipt",
  method: "POST",
  path: "/api/v1/admin/invoices/:invoiceId/receipts",
  auth: "staff",
  summary: "Record a payment received outside a provider (bank transfer), with the bank reference and a reason",
  params: z.object({ invoiceId: z.string().min(1) }),
  body: z.object({ ref: z.string().trim().min(4).max(120), reason: Reason }),
  response: PaymentEventResult,
});

export const adminAudit = endpoint({
  id: "admin.audit",
  method: "GET",
  path: "/api/v1/admin/audit",
  auth: "staff",
  summary: "The platform audit trail, newest first",
  query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), orgId: z.string().optional() }),
  response: z.object({ entries: z.array(AuditEntry.extend({ orgId: z.string().nullable() })) }),
});

// ---------------------------------------------------------------- the platform trial policy and sign-up review
export const getTrialPolicy = endpoint({
  id: "admin.trialPolicy.get",
  method: "GET",
  path: "/api/v1/admin/trial-policy",
  auth: "staff",
  summary: "The platform trial policy every product follows, with every earlier version",
  response: z.object({
    policy: TrialPolicy,
    history: z.array(
      z.object({
        version: z.number().int(),
        policy: z.record(z.string(), z.unknown()),
        reason: z.string(),
        changedBy: z.string().nullable(),
        changedAt: z.string(),
      }),
    ),
  }),
});

export const updateTrialPolicy = endpoint({
  id: "admin.trialPolicy.update",
  method: "PUT",
  path: "/api/v1/admin/trial-policy",
  auth: "staff",
  summary:
    "Change the platform trial policy (Super Admin, audited, kept as a new version). New trials of every product " +
    "follow it at once; a trial already running keeps the days and grace it started with.",
  body: TrialPolicy.omit({ version: true, updatedAt: true, atExpiry: true, keepRecords: true }).extend({
    /** Omitted = keep the current setting. */
    suspendUnverifiedRequiresDelivery: z.boolean().optional(),
    reason: Reason,
  }),
  response: TrialPolicy,
});

export const listSignups = endpoint({
  id: "admin.signups.list",
  method: "GET",
  path: "/api/v1/admin/signups",
  auth: "staff",
  summary: "Self-service sign-up requests (e.g. those blocked as a repeat trial, waiting for a decision)",
  query: z.object({
    status: z.enum(["created", "duplicate", "blocked_repeat", "allowed", "declined"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({ signups: z.array(SignupRequest) }),
});

const SignupParams = z.object({ signupId: z.string().min(1) });

export const allowSignup = endpoint({
  id: "admin.signups.allow",
  method: "POST",
  path: "/api/v1/admin/signups/:signupId/allow",
  auth: "staff",
  summary:
    "Override a repeat-trial block with a reason: the organisation, administrator (the password they chose) and the " +
    "trial are created now, under the current policy",
  params: SignupParams,
  body: z.object({ reason: Reason }),
  response: SignupRequest,
});

export const declineSignup = endpoint({
  id: "admin.signups.decline",
  method: "POST",
  path: "/api/v1/admin/signups/:signupId/decline",
  auth: "staff",
  summary: "Decline a sign-up blocked as a repeat trial, with a reason (the chosen password is discarded)",
  params: SignupParams,
  body: z.object({ reason: Reason }),
  response: SignupRequest,
});

export const listUpgrades = endpoint({
  id: "admin.upgrades.list",
  method: "GET",
  path: "/api/v1/admin/upgrades",
  auth: "staff",
  summary:
    "Self-service upgrades and how the customer chose to pay. A bank transfer is confirmed with " +
    "POST /api/v1/admin/invoices/:invoiceId/receipts (bank reference and reason) or a confirmed bank statement line.",
  query: z.object({ status: z.enum(["awaiting", "paid", "all"]).default("awaiting") }),
  response: z.object({
    upgrades: z.array(
      z.object({
        id: z.string(),
        orgId: z.string(),
        orgName: z.string(),
        product: Product,
        plan: z.string(),
        frequency: z.enum(["monthly", "quarterly", "yearly"]),
        method: z.enum(["provider", "bank_transfer"]),
        invoice: BillingInvoice,
        requestedAt: IsoDateTime,
      }),
    ),
  }),
});

// ---------- one organisation in full, and the changes PALTAS makes to it ----------
const AdminOrgParams = z.object({ orgId: z.string().min(1) });

export const AdminSubscriptionDetail = z.object({
  product: Product,
  plan: z.string().nullable(),
  status: SubscriptionStatusSchema,
  trialEnds: IsoDate.nullable(),
  addons: z.array(z.string()),
  disabled: z.array(z.string()),
  pending: z.array(PendingChangeSchema),
  buildings: z.object({ extra: z.number().int(), override: z.number().int().nullable() }),
  entitlement: EntitlementsView,
});

export const AdminOrgDetail = Organisation.extend({
  terms: z.object({ discountPct: z.number(), note: z.string() }),
  members: z.array(Member),
  subscriptions: z.array(AdminSubscriptionDetail),
});

export const getOrganisationDetail = endpoint({
  id: "admin.orgs.get",
  method: "GET",
  path: "/api/v1/admin/orgs/:orgId",
  auth: "staff",
  summary: "One organisation with its members, terms and every product subscription as the rules resolve it today",
  params: AdminOrgParams,
  response: AdminOrgDetail,
});

export const updateOrganisation = endpoint({
  id: "admin.orgs.update",
  method: "PUT",
  path: "/api/v1/admin/orgs/:orgId",
  auth: "staff",
  summary:
    "Change an organisation's details, or make someone its administrator. The currency is fixed once an invoice exists.",
  params: AdminOrgParams,
  body: z.object({
    name: z.string().trim().min(3).max(160).optional(),
    legalName: z.string().trim().min(1).max(200).optional(),
    country: z.string().trim().min(2).max(80).optional(),
    currency: Currency.optional(),
    timezone: z.string().min(1).optional(),
    admin: z.object({ email: Email, name: z.string().trim().min(2).max(120).optional() }).optional(),
  }),
  response: z.object({ ok: z.literal(true), temporaryPassword: z.string().nullable() }),
});

export const setOrgPlan = endpoint({
  id: "admin.orgs.plan",
  method: "PUT",
  path: "/api/v1/admin/orgs/:orgId/plan",
  auth: "staff",
  summary:
    "Move ONE product subscription to another plan of the same product, now. A scheduled plan change is dropped.",
  params: AdminOrgParams,
  body: z.object({ plan: z.string().min(1), reason: Reason }),
  response: z.object({ ok: z.literal(true), product: Product }),
});

export const setOrgTrial = endpoint({
  id: "admin.orgs.trial",
  method: "PUT",
  path: "/api/v1/admin/orgs/:orgId/trial",
  auth: "staff",
  summary: "Set the trial end date of one product subscription that is on trial",
  params: AdminOrgParams,
  body: z.object({ product: Product.optional(), trialEnds: IsoDate, reason: Reason }),
  response: z.object({ ok: z.literal(true), product: Product }),
});

export const setOrgTerms = endpoint({
  id: "admin.orgs.terms",
  method: "PUT",
  path: "/api/v1/admin/orgs/:orgId/terms",
  auth: "staff",
  summary: "Negotiated terms for the whole organisation: a discount on subscription and add-on prices, and a note",
  params: AdminOrgParams,
  body: z.object({ discountPct: z.number().min(0).max(100), note: z.string().trim().max(300).default("") }),
  response: z.object({ ok: z.literal(true) }),
});

export const setOrgAllowance = endpoint({
  id: "admin.orgs.allowance",
  method: "PUT",
  path: "/api/v1/admin/orgs/:orgId/allowance",
  auth: "staff",
  summary: "Buildings (or projects) for one product subscription: additional ones, and an override of the plan's own",
  params: AdminOrgParams,
  body: z.object({
    product: Product.optional(),
    extra: z.number().int().min(0).max(500),
    override: z.number().int().min(0).nullable().default(null),
    reason: Reason,
  }),
  response: z.object({ ok: z.literal(true), product: Product }),
});

export const setOrgModule = endpoint({
  id: "admin.orgs.module",
  method: "PUT",
  path: "/api/v1/admin/orgs/:orgId/modules/:moduleKey",
  auth: "staff",
  summary:
    "Switch one module on or off for one product subscription. Dependencies are checked; records are never deleted.",
  params: z.object({ orgId: z.string().min(1), moduleKey: z.string().min(1) }),
  body: z.object({ product: Product.optional(), on: z.boolean(), reason: Reason }),
  response: z.object({ ok: z.literal(true), product: Product, modules: z.record(z.string(), z.boolean()) }),
});

export const AdminInvoiceRow = BillingInvoice.extend({ orgId: z.string(), orgName: z.string() });

export const listInvoices = endpoint({
  id: "admin.invoices.list",
  method: "GET",
  path: "/api/v1/admin/invoices",
  auth: "staff",
  summary: "Subscription invoices across organisations, newest first",
  query: z.object({
    orgId: z.string().optional(),
    status: z.enum(["Open", "Payment failed", "Paid", "Void"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: z.object({ invoices: z.array(AdminInvoiceRow) }),
});

export const voidInvoice = endpoint({
  id: "admin.invoices.void",
  method: "POST",
  path: "/api/v1/admin/invoices/:invoiceId/void",
  auth: "staff",
  summary: "Void an unpaid invoice. It stays in the history marked Void; a paid invoice cannot be voided.",
  params: z.object({ invoiceId: z.string().min(1) }),
  body: z.object({ reason: Reason }),
  response: z.object({ ok: z.literal(true) }),
});

export { marketingOverview, createCampaign, updateCampaign, campaignAction } from "./marketing.js";
