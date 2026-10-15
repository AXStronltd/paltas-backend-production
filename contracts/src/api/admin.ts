// PALTAS Super Admin (staff only, second factor required at sign-in). Owning a building or paying for a subscription
// grants nothing here: a client administrator is never staff.
import { z } from "zod";
import { Product } from "../access.js";
import { Currency, Email, IsoDate, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { AuditEntry, Organisation } from "./organisations.js";
import { PaymentEventResult } from "./payments.js";
import { BillingInvoice, CatalogueSchema, SubscriptionStatusSchema, TierSchema } from "./subscriptions.js";

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
