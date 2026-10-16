// Self-service sign-up, e-mail verification and the ONE platform trial policy (every product follows it).
//
// A business signs itself up (public), uses the product fully during the trial, verifies its e-mail address, and
// upgrades itself (subscriptions.upgrade). The answer to a sign-up is the same whatever happened, so it never tells
// anyone which e-mail addresses or businesses already use PALTAS. PALTAS staff review sign-ups that were blocked as
// a repeat trial (admin.signups*).
import { z } from "zod";
import { Product } from "../access.js";
import { Email, IsoDate, IsoDateTime } from "../common.js";
import { endpoint } from "../endpoint.js";
import { NewPassword } from "./identity.js";

export const TrialPolicy = z.object({
  version: z.number().int(),
  trialDays: z.number().int().min(1).max(90),
  graceDays: z.number().int().min(0).max(30),
  reminderDays: z.array(z.number().int().min(1).max(90)).max(10),
  verifyWithinDays: z.number().int().min(1).max(60),
  verifyLinkHours: z.number().int().min(1).max(168),
  repeatWindowDays: z.number().int().min(0).max(3650),
  repeatMatch: z.array(z.enum(["email", "phone", "company"])),
  secondProduct: z.enum(["own_trial", "no_trial"]),
  atExpiry: z.literal("read_only"),
  keepRecords: z.literal(true),
  exportAllowed: z.boolean(),
  /** On: an unverified sign-up is suspended only while an e-mail provider is configured (nobody is suspended for a
   * link that could never reach them). */
  suspendUnverifiedRequiresDelivery: z.boolean(),
  updatedAt: IsoDateTime,
});
export type TrialPolicy = z.infer<typeof TrialPolicy>;

export const getPolicy = endpoint({
  id: "signup.policy",
  method: "GET",
  path: "/api/v1/public/trial-policy",
  auth: "public",
  summary: "The platform trial policy every product follows (trial and grace days, reminders, what happens at expiry)",
  response: TrialPolicy.omit({
    updatedAt: true,
    repeatWindowDays: true,
    repeatMatch: true,
    suspendUnverifiedRequiresDelivery: true,
  }),
});

/**
 * Public registration metadata: whether sign-up is open, the terms to accept, the trial length of the platform trial
 * policy and every self-service plan with its tier, modules and price (catalogue rows; none is in code). A plan PALTAS
 * prices on request is listed only when it is open for a free trial (price null, contactSales). No staff or
 * organisation record is exposed.
 */
export const getOptions = endpoint({
  id: "signup.options",
  method: "GET",
  path: "/api/v1/public/signup-options",
  auth: "public",
  summary: "Available signup plans (tier, modules, price), current terms, trial days and whether registration is open",
  response: z.object({
    enabled: z.boolean(),
    termsVersion: z.string(),
    termsUrl: z.string().nullable(),
    trialDays: z.number().int(),
    plans: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        product: Product,
        tier: z.enum(["Standard", "Pro", "Enterprise"]).nullable(),
        /** The modules the plan includes, named in words. */
        modules: z.array(z.object({ key: z.string(), name: z.string() })),
        /** Amount in major units (e.g. 150000 = KES 150,000) per billing period; null when PALTAS prices it on request. */
        price: z
          .object({
            amount: z.number(),
            currency: z.string(),
            frequency: z.enum(["monthly", "quarterly", "yearly"]),
          })
          .nullable(),
        /** Priced on request ("Talk to us"); a free trial can still be started. */
        contactSales: z.boolean(),
      }),
    ),
  }),
});

/**
 * The public plan comparison for one product, built from the catalogue: every active plan (price, or "Talk to us"),
 * and every feature in words grouped by area, with the plans that include it.
 */
export const getComparison = endpoint({
  id: "signup.comparison",
  method: "GET",
  path: "/api/v1/public/plan-comparison",
  auth: "public",
  summary: "What each plan of a product includes, by area, from the catalogue (prices, or Talk to us)",
  query: z.object({ product: Product }),
  response: z.object({
    product: Product,
    trialDays: z.number().int(),
    plans: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        tier: z.enum(["Standard", "Pro", "Enterprise"]).nullable(),
        price: z
          .object({ amount: z.number(), currency: z.string(), frequency: z.enum(["monthly", "quarterly", "yearly"]) })
          .nullable(),
        contactSales: z.boolean(),
        /** A free trial can be started from sign-up. */
        trial: z.boolean(),
        buildingsIncluded: z.number().int(),
        modules: z.array(z.object({ key: z.string(), name: z.string() })),
      }),
    ),
    areas: z.array(
      z.object({
        area: z.string(),
        features: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            /** The module that brings it; null = in every plan. */
            module: z.object({ key: z.string(), name: z.string() }).nullable(),
            /** Plan ids that include it. */
            plans: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
});

/** A phone number in international form (+254700000000); spaces, brackets and dashes are allowed and ignored. */
export const Phone = z
  .string()
  .trim()
  .regex(/^\+[1-9][\d\s()-]{7,24}$/, "Give the phone number in international form, e.g. +254700000000");

export const SignupBody = z.object({
  company: z.string().trim().min(2).max(160),
  country: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(1).max(60).default("UTC"),
  product: Product,
  /** A plan from the public catalogue for that product (never hard-coded); its currency becomes the organisation's. */
  plan: z.string().min(1).max(40),
  adminName: z.string().trim().min(2).max(120),
  email: Email,
  phone: Phone,
  password: NewPassword,
  terms: z.object({ accepted: z.literal(true), version: z.string().trim().min(1).max(40) }),
});

/** The same answer for every outcome (created, duplicate, blocked for review): nothing about existing accounts. */
export const SignupReceived = z.object({ received: z.literal(true), message: z.string() });

export const create = endpoint({
  id: "signup.create",
  method: "POST",
  path: "/api/v1/public/signup",
  auth: "public",
  summary:
    "Sign a business up for a free trial: organisation, its administrator and the trial, in one transaction. " +
    "The answer never says whether the e-mail or business already uses PALTAS. Limited per address and per e-mail.",
  body: SignupBody,
  response: SignupReceived,
  status: 201,
});

export const verify = endpoint({
  id: "signup.verify",
  method: "POST",
  path: "/api/v1/public/signup/verify",
  auth: "public",
  summary: "Verify an e-mail address with the token from the verification link (single use, expires)",
  body: z.object({ token: z.string().trim().min(20).max(200) }),
  response: z.object({ verified: z.literal(true) }),
});

export const resend = endpoint({
  id: "signup.resend",
  method: "POST",
  path: "/api/v1/me/email-verification",
  auth: "user",
  summary: "Record a new verification message for your e-mail address (earlier links stop working)",
  response: z.object({ recorded: z.literal(true), expiresAt: IsoDateTime, delivery: z.string() }),
  status: 201,
});

export const SignupRequest = z.object({
  id: z.string(),
  status: z.enum(["created", "duplicate", "blocked_repeat", "allowed", "declined"]),
  orgId: z.string().nullable(),
  company: z.string(),
  country: z.string(),
  product: Product,
  plan: z.string(),
  adminName: z.string(),
  email: z.string(),
  phone: z.string(),
  termsVersion: z.string(),
  signedUpOn: IsoDate,
  matched: z.array(
    z.object({ by: z.enum(["email", "phone", "company", "account", "name"]), orgId: z.string().nullable() }),
  ),
  emailVerified: z.boolean().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  createdAt: IsoDateTime,
});
