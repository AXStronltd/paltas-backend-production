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
 * policy and every self-service plan with its tier, modules and price (catalogue rows; none is in code). Enterprise
 * and unpriced plans are agreed with PALTAS and are not listed. No staff or organisation record is exposed.
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
    profileRequired: z.boolean().default(false),
    plans: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        product: Product,
        tier: z.enum(["Standard", "Pro", "Enterprise"]).nullable(),
        /** The modules the plan includes, named in words. */
        modules: z.array(z.object({ key: z.string(), name: z.string() })),
        /** Amount in major units (e.g. 150000 = KES 150,000) per billing period. */
        price: z.object({
          amount: z.number(),
          currency: z.string(),
          frequency: z.enum(["monthly", "quarterly", "yearly"]),
        }),
      }),
    ),
  }),
});

/** A phone number in international form (+254700000000); spaces, brackets and dashes are allowed and ignored. */
export const Phone = z
  .string()
  .trim()
  .regex(/^\+[1-9][\d\s()-]{7,24}$/, "Give the phone number in international form, e.g. +254700000000");

/** Company-supplied registration details; this is not government identity verification. */
export const CompanyRegistrationProfile = z.object({
  version: z.literal("2026-10"),
  companyType: z.enum(["limited_company", "sole_trader", "partnership", "non_profit", "other"]),
  registrationNumber: z.string().trim().max(80).optional(),
  tradingName: z.string().trim().max(160).optional(),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(100),
  region: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  companyEmail: Email.optional(),
  website: z
    .url()
    .max(300)
    .refine((value) => {
      const u = new URL(value);
      return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
    }, "Use an http or https company website without credentials")
    .optional(),
  administratorPhone: Phone.optional(),
  administratorTitle: z.string().trim().max(120).optional(),
  authorityAccepted: z.literal(true),
  requestedTier: z.enum(["Standard", "Pro", "Enterprise"]),
  enterpriseRequirements: z.string().trim().max(1000).optional(),
});
export type CompanyRegistrationProfile = z.infer<typeof CompanyRegistrationProfile>;

export const SignupBody = z.object({
  company: z.string().trim().min(2).max(160),
  companyProfile: CompanyRegistrationProfile.optional(),
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
