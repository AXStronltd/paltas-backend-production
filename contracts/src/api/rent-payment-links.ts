import { z } from "zod";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const create = endpoint({
  id: "rentPaymentLinks.create",
  summary: "rentPaymentLinks create",
  method: "POST",
  auth: "user",
  path: "/api/v1/orgs/:orgId/property/invoices/:invoiceId/payment-links",
  params: OrgParams.extend({ invoiceId: z.string() }),
  body: z.object({
    expiresDays: z.number().int().min(1).max(14).default(3),
    includeManualInstructions: z.boolean().default(true),
    confirmShare: z.literal(true),
  }),
  response: z.object({ id: z.string(), url: z.string().url(), expiresAt: z.string() }),
});
export const revoke = endpoint({
  id: "rentPaymentLinks.revoke",
  summary: "rentPaymentLinks revoke",
  method: "POST",
  auth: "user",
  path: "/api/v1/orgs/:orgId/property/payment-links/:linkId/revoke",
  params: OrgParams.extend({ linkId: z.string() }),
  body: z.object({ reason: z.string().trim().min(6).max(500) }),
  response: z.object({ revoked: z.literal(true) }),
});
const Instructions = z.object({
  kind: z.enum(["bank", "mpesa_mobile", "mpesa_paybill", "mpesa_till"]),
  accountHolder: z.string(),
  accountNumber: z.string(),
  bankCode: z.string().nullable(),
  accountReference: z.string().nullable(),
});
const Preview = z.object({
  business: z.string(),
  invoiceNumber: z.string(),
  currency: z.string(),
  balanceMinor: z.number().int(),
  dueDate: z.string(),
  expiresAt: z.string(),
  manualInstructions: Instructions.nullable(),
  mpesaAvailable: z.boolean(),
  paymentState: z.string().nullable(),
  receiptRecorded: z.boolean(),
});
export const preview = endpoint({
  id: "rentPaymentLinks.public.preview",
  summary: "rentPaymentLinks public preview",
  method: "POST",
  auth: "public",
  path: "/api/v1/public/rent-payment-links/preview",
  body: z.object({ token: Token }),
  response: Preview,
});
export const collect = endpoint({
  id: "rentPaymentLinks.public.collect",
  summary: "rentPaymentLinks public collect",
  method: "POST",
  auth: "public",
  path: "/api/v1/public/rent-payment-links/collect",
  body: z.object({
    token: Token,
    phone: z.string().regex(/^254[17]\d{8}$/),
    expectedAmountMinor: z.number().int().positive(),
    confirm: z.literal(true),
  }),
  response: Preview,
});
export const refresh = endpoint({
  id: "rentPaymentLinks.public.refresh",
  summary: "rentPaymentLinks public refresh",
  method: "POST",
  auth: "public",
  path: "/api/v1/public/rent-payment-links/refresh",
  body: z.object({ token: Token }),
  response: Preview,
});
export const confirmInstructions = endpoint({
  id: "rentPaymentLinks.confirmInstructions",
  summary: "rentPaymentLinks confirmInstructions",
  method: "POST",
  auth: "user",
  path: "/api/v1/orgs/:orgId/property/receiving-account/manual-instructions",
  params: OrgParams,
  body: z.object({
    expectedRevision: z.number().int().positive(),
    confirmAuthority: z.literal(true),
    confirmShare: z.literal(true),
    reason: z.string().trim().min(6).max(500),
  }),
  response: z.object({ manualInstructionsEnabled: z.literal(true) }),
});

export const list = endpoint({
  id: "rentPaymentLinks.list",
  summary: "Invoice payment link metadata; tokens are never returned again",
  method: "GET",
  auth: "user",
  path: "/api/v1/orgs/:orgId/property/invoices/:invoiceId/payment-links",
  params: OrgParams.extend({ invoiceId: z.string() }),
  response: z.object({
    links: z.array(
      z.object({ id: z.string(), createdAt: z.string(), expiresAt: z.string(), revokedAt: z.string().nullable() }),
    ),
  }),
});
