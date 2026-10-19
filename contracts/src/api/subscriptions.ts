// A customer's own subscriptions: what they are entitled to, what they pay, and changes they can make themselves.
// Each call works on ONE product subscription (?product= or body.product; default = the first product).
// Adding or changing one product never activates or changes another.
import { z } from "zod";
import { Product } from "../access.js";
import { Confirm, Currency, IsoDate, IsoDateTime, MinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { exportOrg } from "./ops.js";
import { OrgParams, ProductQuery } from "./organisations.js";
import { SubscriptionTrial } from "./identity.js";

// ---------- catalogue (prices are PALTAS configuration, never hard-coded) ----------
export const PriceSchema = z.object({
  amount: z.number().nullable().optional(),
  ccy: z.string().optional(),
  per: z.string().optional(),
  byCcy: z.record(z.string(), z.number()).optional(),
});
export const CatalogueModuleSchema = z.object({
  key: z.string(),
  name: z.string(),
  products: z.array(z.string()),
  dep: z.array(z.string()),
  excludes: z.array(z.string()),
  scope: z.enum(["product", "organisation"]),
  price: PriceSchema.nullable(),
  available: z.boolean(),
});
export const TierSchema = z.enum(["Standard", "Pro", "Enterprise"]);
export const PlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: TierSchema.nullable(),
  products: z.array(z.string()),
  modules: z.array(z.string()),
  buildingsIncluded: z.number().int(),
  base: PriceSchema.nullable(),
  extraBuilding: PriceSchema.nullable(),
  frequency: z.enum(["monthly", "quarterly", "yearly"]),
  trialDays: z.number().int(),
  taxPct: z.number().nullable(),
  taxNote: z.string(),
  capacity: z.object({ sites: z.number().nullable(), units: z.number().nullable() }),
});
export const CatalogueSchema = z.object({ modules: z.array(CatalogueModuleSchema), plans: z.array(PlanSchema) });

// ---------- entitlement and billing records ----------
export const ModuleStateSchema = z.object({
  on: z.boolean(),
  source: z.enum(["plan", "organisation", "addon"]).nullable(),
  sharedFrom: z.string().nullable(),
  scope: z.enum(["product", "organisation"]),
  offered: z.boolean(),
  available: z.boolean(),
  cancelsOn: z.string().nullable(),
  why: z.string(),
});
export const Allowance = z.object({
  included: z.number(),
  extra: z.number(),
  allowed: z.number(),
  used: z.number(),
  left: z.number(),
  over: z.boolean(),
});
export const SubscriptionStatusSchema = z.enum(["trial", "active", "suspended", "expired", "cancelled"]);
export const PendingChangeSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["plan", "cancelAddon", "cancel"]),
  key: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  effective: IsoDate,
  reason: z.string().nullable().optional(),
});

export const BillingLine = z.object({
  kind: z.string(),
  what: z.string(),
  amountMinor: MinorUnits,
  key: z.string().optional(),
});
export const BillingInvoiceStatus = z.enum(["Open", "Payment failed", "Paid", "Void"]);
export const BillingInvoice = z.object({
  id: z.string(),
  product: Product,
  periodFrom: IsoDate,
  periodTo: IsoDate,
  lines: z.array(BillingLine),
  grossMinor: MinorUnits,
  discountMinor: MinorUnits,
  netMinor: MinorUnits,
  taxPct: z.number(),
  taxMinor: MinorUnits,
  totalMinor: MinorUnits,
  currency: Currency,
  status: BillingInvoiceStatus,
  issued: IsoDate,
  due: IsoDate,
  attempts: z.number().int(),
  paidAt: IsoDateTime.nullable(),
  note: z.string(),
});
export type BillingInvoice = z.infer<typeof BillingInvoice>;

export const BillingReceipt = z.object({
  id: z.string(),
  invoiceId: z.string(),
  amountMinor: MinorUnits,
  currency: Currency,
  ref: z.string(),
  manual: z.boolean(),
  createdAt: IsoDateTime,
});

export const Purchase = z.object({
  id: z.string(),
  product: Product,
  kind: z.enum(["addon", "plan", "allowance", "product"]),
  moduleKey: z.string().nullable(),
  planId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  status: z.string(),
  totalMinor: MinorUnits,
  currency: Currency,
});
export const PurchaseResult = z.object({ purchase: Purchase, invoice: BillingInvoice.nullable() });

export const EntitlementsView = z.object({
  product: Product,
  products: z.array(Product),
  status: SubscriptionStatusSchema,
  usable: z.boolean(),
  plan: z.string(),
  tier: TierSchema.nullable(),
  modules: z.record(z.string(), z.boolean()),
  sources: z.record(z.string(), z.enum(["plan", "organisation", "addon"]).nullable()),
  allowance: Allowance,
  essentials: z.array(z.string()),
  /** Trial days and grace left (null when this subscription is not a trial). */
  trial: SubscriptionTrial.nullable(),
});

export const MonthlyCharge = z.object({
  currency: Currency,
  lines: z.array(BillingLine),
  grossMinor: MinorUnits,
  discountMinor: MinorUnits,
  netMinor: MinorUnits,
  taxPct: z.number(),
  taxNote: z.string(),
  taxMinor: MinorUnits,
  totalMinor: MinorUnits,
  missingPrices: z.array(z.string()),
  priced: z.boolean(),
});

export const SubscriptionSummary = z.object({
  organisation: z.object({ id: z.string(), name: z.string(), currency: Currency, products: z.array(Product) }),
  product: Product,
  productName: z.string(),
  plan: z.object({ id: z.string(), name: z.string(), tier: TierSchema.nullable() }),
  status: SubscriptionStatusSchema,
  usable: z.boolean(),
  trialEnds: IsoDate.nullable(),
  trial: SubscriptionTrial.nullable(),
  nextBilling: IsoDate.nullable(),
  modules: z.record(z.string(), ModuleStateSchema),
  essentials: z.array(z.string()),
  alwaysWorks: z.array(z.string()),
  allowance: Allowance,
  pending: z.array(PendingChangeSchema),
  upgrades: z.array(
    z.object({ id: z.string(), tier: TierSchema.nullable(), name: z.string(), contactSales: z.boolean() }),
  ),
  downgrades: z.array(z.object({ id: z.string(), tier: TierSchema.nullable(), name: z.string() })),
  monthly: MonthlyCharge,
  outstandingMinor: MinorUnits,
  billingMode: z.enum(["provider", "simulated"]),
  invoices: z.array(BillingInvoice),
  receipts: z.array(BillingReceipt),
});

// ---------- endpoints ----------
export const getEntitlements = endpoint({
  id: "subscription.entitlements",
  method: "GET",
  path: "/api/v1/orgs/:orgId/entitlements",
  auth: "user",
  summary: "Which modules this product subscription may use right now",
  params: OrgParams,
  query: ProductQuery,
  response: EntitlementsView,
});

export const getSubscription = endpoint({
  id: "subscription.get",
  method: "GET",
  path: "/api/v1/orgs/:orgId/subscription",
  auth: "user",
  summary: "Plan, modules, allowance, scheduled changes, the monthly charge, invoices and receipts",
  params: OrgParams,
  query: ProductQuery,
  response: SubscriptionSummary,
});

export const listProducts = endpoint({
  id: "subscription.products",
  method: "GET",
  path: "/api/v1/orgs/:orgId/products",
  auth: "user",
  summary: "Every sellable product: subscribed or not, and the plans on offer",
  params: OrgParams,
  response: z.object({
    products: z.array(
      z.object({
        product: Product,
        name: z.string(),
        subscribed: z.boolean(),
        plan: z.string().nullable(),
        status: SubscriptionStatusSchema.nullable(),
        offer: z
          .array(
            z.object({
              id: z.string(),
              tier: TierSchema.nullable(),
              price: z.object({ amountMinor: MinorUnits, currency: Currency, per: z.string() }).nullable(),
              trialDays: z.number().int(),
            }),
          )
          .nullable(),
      }),
    ),
  }),
});

export const addProduct = endpoint({
  id: "subscription.addProduct",
  method: "POST",
  path: "/api/v1/orgs/:orgId/products",
  auth: "user",
  summary: "Add another product as a separate subscription (trial, or awaiting payment of the first invoice)",
  params: OrgParams,
  body: z.object({ product: Product, plan: z.string().min(1), confirm: Confirm }),
  response: z.object({
    product: Product,
    plan: z.string(),
    status: z.enum(["trial", "active", "awaiting payment"]),
    trialEnds: IsoDate.nullable(),
    invoice: BillingInvoice.nullable(),
  }),
  status: 201,
});

export const buyAddon = endpoint({
  id: "subscription.buyAddon",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/addons",
  auth: "user",
  summary: "Order an add-on module. It starts only when the payment is confirmed by the provider.",
  params: OrgParams,
  body: z.object({ module: z.string().min(1), confirm: Confirm, product: Product.optional() }),
  response: PurchaseResult,
  status: 201,
});

export const cancelAddon = endpoint({
  id: "subscription.cancelAddon",
  method: "DELETE",
  path: "/api/v1/orgs/:orgId/subscription/addons/:module",
  auth: "user",
  summary: "Cancel an add-on from the next billing date. Its records stay readable.",
  params: OrgParams.extend({ module: z.string().min(1) }),
  query: ProductQuery,
  response: z.object({ effective: IsoDate }),
});

export const changePlan = endpoint({
  id: "subscription.changePlan",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/plan",
  auth: "user",
  summary: "Upgrade (after payment) or schedule a downgrade for the next billing date. The plan decides the product.",
  params: OrgParams,
  body: z.object({ plan: z.string().min(1), confirm: Confirm }),
  response: z.union([
    PurchaseResult,
    z.object({ scheduled: z.literal(true), effective: IsoDate, readOnlyAfter: z.array(z.string()) }),
  ]),
});

export const buyAllowance = endpoint({
  id: "subscription.buyAllowance",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/allowance",
  auth: "user",
  summary: "Order one extra building or project allowance",
  params: OrgParams,
  body: z.object({ confirm: Confirm, product: Product.optional() }),
  response: PurchaseResult,
  status: 201,
});

export const cancelSubscription = endpoint({
  id: "subscription.cancel",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/cancel",
  auth: "user",
  summary: "Cancel this product subscription at the end of the paid period. Records are kept, read-only afterwards.",
  params: OrgParams,
  body: z.object({ reason: z.string().trim().min(3).max(500), product: Product.optional() }),
  response: z.object({ effective: IsoDate, product: Product }),
});

export const withdrawPending = endpoint({
  id: "subscription.withdrawPending",
  method: "DELETE",
  path: "/api/v1/orgs/:orgId/subscription/pending/:pendingId",
  auth: "user",
  summary: "Withdraw a scheduled change before it takes effect",
  params: OrgParams.extend({ pendingId: z.string().min(1) }),
  response: z.object({ ok: z.literal(true) }),
});

export const sendEnterpriseEnquiry = endpoint({
  id: "subscription.enterpriseEnquiry",
  method: "POST",
  path: "/api/v1/orgs/:orgId/enterprise-enquiries",
  auth: "user",
  summary: "Ask PALTAS for an Enterprise package",
  params: OrgParams,
  body: z.object({ note: Reason }),
  response: z.object({ id: z.string(), status: z.literal("New") }),
  status: 201,
});

// ---------- self-service upgrade (trial or lapsed subscription → paid) ----------
export const Frequency = z.enum(["monthly", "quarterly", "yearly"]);
export const PaymentMethod = z.enum(["provider", "bank_transfer"]);

export const getUpgradeOptions = endpoint({
  id: "subscription.upgradeOptions",
  method: "GET",
  path: "/api/v1/orgs/:orgId/subscription/upgrade-options",
  auth: "user",
  summary:
    "Plans this product subscription can move to, from the catalogue, with price, billing period and trial state",
  params: OrgParams,
  query: ProductQuery,
  response: z.object({
    product: Product,
    status: SubscriptionStatusSchema,
    trial: SubscriptionTrial.nullable(),
    emailVerified: z.boolean(),
    plans: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        tier: TierSchema.nullable(),
        frequencies: z.array(Frequency),
        price: z.object({ amountMinor: MinorUnits, currency: Currency, per: z.string() }).nullable(),
        contactSales: z.boolean(),
        current: z.boolean(),
      }),
    ),
    cardCheckout: z
      .object({
        available: z.boolean(),
        testMode: z.boolean(),
        planIds: z.array(z.string()),
        portalAvailable: z.boolean().optional(),
      })
      .optional(),
    paymentMethods: z.array(z.object({ method: PaymentMethod, available: z.boolean(), note: z.string() })),
  }),
});

export const upgrade = endpoint({
  id: "subscription.upgrade",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/upgrade",
  auth: "user",
  summary:
    "Choose a plan and billing period for a trial or lapsed subscription: an invoice is issued, and the subscription " +
    "becomes active ONLY when that invoice is paid (signed provider event, or a bank transfer confirmed by PALTAS staff)",
  params: OrgParams,
  body: z.object({
    plan: z.string().min(1),
    frequency: Frequency,
    payment: PaymentMethod,
    confirm: Confirm,
  }),
  response: PurchaseResult.extend({
    payment: z.object({ method: PaymentMethod, reference: z.string(), status: z.string(), instructions: z.string() }),
  }),
  status: 201,
});

export const exportData = endpoint({
  id: "subscription.export",
  method: "GET",
  path: "/api/v1/orgs/:orgId/export",
  auth: "user",
  summary:
    "Every record of your organisation as one JSON document, streamed — also after a trial has expired (records are " +
    "kept). Organisation administrator only; audited with the reason.",
  params: OrgParams,
  query: z.object({ reason: Reason }),
  response: exportOrg.response,
});

// Hosted Stripe checkout is optional; prices and invoice ownership are checked on the server.
export const stripeCheckout = endpoint({
  id: "subscription.stripeCheckout",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/stripe-checkout",
  auth: "user",
  summary: "Create or resume a Stripe-hosted recurring subscription checkout for an unpaid PALTAS plan invoice",
  params: OrgParams,
  body: z.object({ invoiceId: z.string().min(1).max(100) }),
  response: z.object({ url: z.url(), sessionId: z.string(), testMode: z.boolean() }),
});
export const stripeWebhook = endpoint({
  id: "webhooks.stripe",
  method: "POST",
  path: "/api/v1/webhooks/stripe",
  auth: "public",
  summary: "Receive Stripe snapshot events; raw-body Stripe signature required, replay-safe processing",
  body: z.unknown(),
  response: z.object({ received: z.literal(true), result: z.string() }),
});

export const stripePortal = endpoint({
  id: "subscription.stripePortal",
  method: "POST",
  path: "/api/v1/orgs/:orgId/subscription/stripe-portal",
  auth: "user",
  summary:
    "Open the owning organisation's dedicated Stripe billing portal; no payment or cancellation is executed by this request",
  params: OrgParams,
  body: z.object({ product: Product, action: z.enum(["manage", "cancel"]).default("manage") }),
  response: z.object({ url: z.url(), testMode: z.boolean() }),
});
