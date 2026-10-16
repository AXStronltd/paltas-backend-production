// The notifications outbox: every e-mail, SMS, WhatsApp message and push notification any product wants to send is
// RECORDED here first, with its template, the organisation's sender settings and a consent check.
//
//   recorded → sent (a real provider ACCEPTED it and returned its message id) → delivered / bounced (ONLY from the
//   provider's signed delivery webhook). queued = handed to the test adapter: nothing sent. failed = refused.
//   suppressed = refused by the consent rules, never handed to anyone.
//
// PALTAS's own e-mail goes through SMTP, Resend, Postmark or SendGrid once PLATFORM_EMAIL_PROVIDER and its credentials are
// set (SMTP: "sent" = accepted by the mail server, never "delivered"); until then, and for
// SMS, WhatsApp and push, a test adapter says "Not connected — test adapter" and never makes a message "sent" (the
// database refuses "sent", "delivered" and "bounced" without a real provider's message id).
import { z } from "zod";
import { Email, IsoDateTime } from "../common.js";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";

export const CHANNELS = ["email", "sms", "whatsapp", "push"] as const;
export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

export const NotificationStatus = z.enum([
  "recorded",
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "suppressed",
]);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

/** transactional: about something the person asked for (a booking, an invoice). marketing: anything else. */
export const Category = z.enum(["transactional", "marketing"]);

export const TemplateKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/, "Use 2–80 characters: a-z 0-9 . _ -");

export const ProviderState = z.object({
  key: z.string(),
  channel: Channel,
  label: z.string(),
  connected: z.boolean(),
  /** "Not connected — test adapter", or "BLOCKED — needs provider credentials". */
  status: z.string(),
});

export const listProviders = endpoint({
  id: "notifications.providers",
  method: "GET",
  path: "/api/v1/orgs/:orgId/notifications/providers",
  auth: "user",
  summary: "Delivery providers per channel and whether each is connected (none is yet: test adapters only)",
  params: OrgParams,
  response: z.object({ providers: z.array(ProviderState) }),
});

export const Sender = z.object({
  channel: Channel,
  provider: z.string(),
  providerStatus: z.string(),
  fromName: z.string(),
  fromAddress: z.string(),
  replyTo: z.string(),
  enabled: z.boolean(),
  updatedAt: IsoDateTime.nullable(),
});

export const listSenders = endpoint({
  id: "notifications.senders.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/notifications/senders",
  auth: "user",
  summary: "The organisation's sender settings for each channel (defaults where none are saved)",
  params: OrgParams,
  response: z.object({ senders: z.array(Sender) }),
});

export const saveSender = endpoint({
  id: "notifications.senders.save",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/notifications/senders/:channel",
  auth: "user",
  summary:
    "Sender name, address and provider for one channel. Only a connected provider (or the test adapter) can be chosen.",
  params: OrgParams.extend({ channel: Channel }),
  body: z.object({
    provider: z.string().min(1).max(40).default("test"),
    fromName: z.string().trim().max(120).default(""),
    fromAddress: z.string().trim().max(200).default(""),
    replyTo: z.union([Email, z.literal("")]).default(""),
    enabled: z.boolean().default(true),
  }),
  response: Sender,
});

export const Template = z.object({
  key: z.string(),
  channel: Channel,
  subject: z.string(),
  body: z.string(),
  /** The organisation's own wording, or the PALTAS default. */
  source: z.enum(["organisation", "paltas"]),
  variables: z.array(z.string()),
  updatedAt: IsoDateTime,
});

export const listTemplates = endpoint({
  id: "notifications.templates.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/notifications/templates",
  auth: "user",
  summary: "Templates the organisation can use: its own, and the PALTAS defaults it has not replaced",
  params: OrgParams,
  response: z.object({ templates: z.array(Template) }),
});

export const saveTemplate = endpoint({
  id: "notifications.templates.save",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/notifications/templates/:key/:channel",
  auth: "user",
  summary: "Save the organisation's own wording of a template. Placeholders: {{name}}.",
  params: OrgParams.extend({ key: TemplateKey, channel: Channel }),
  body: z.object({ subject: z.string().max(300).default(""), body: z.string().min(1).max(10_000) }),
  response: Template,
});

export const Consent = z.object({
  channel: Channel,
  address: z.string(),
  purpose: Category,
  granted: z.boolean(),
  source: z.string(),
  recordedBy: z.string().nullable(),
  recordedAt: IsoDateTime,
});

export const listConsents = endpoint({
  id: "notifications.consents.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/notifications/consents",
  auth: "user",
  summary: "Consent history (newest first), optionally for one address",
  params: OrgParams,
  query: z.object({ address: z.string().max(200).optional() }),
  response: z.object({ consents: z.array(Consent) }),
});

export const recordConsent = endpoint({
  id: "notifications.consents.record",
  method: "POST",
  path: "/api/v1/orgs/:orgId/notifications/consents",
  auth: "user",
  summary: "Record that a person gave or withdrew consent, and where (kept as history; never edited)",
  params: OrgParams,
  body: z.object({
    channel: Channel,
    address: z.string().trim().min(3).max(200),
    purpose: Category,
    granted: z.boolean(),
    source: z.string().trim().min(3).max(200),
  }),
  response: Consent,
  status: 201,
});

export const NotificationEvent = z.object({
  provider: z.string(),
  providerEventId: z.string(),
  status: z.string(),
  detail: z.string(),
  receivedAt: IsoDateTime,
});

export const Notification = z.object({
  id: z.string(),
  channel: Channel,
  to: z.string(),
  category: Category,
  templateKey: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  status: NotificationStatus,
  statusNote: z.string(),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  source: z.string(),
  sourceRef: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: IsoDateTime,
  queuedAt: IsoDateTime.nullable(),
  sentAt: IsoDateTime.nullable(),
  deliveredAt: IsoDateTime.nullable(),
  bouncedAt: IsoDateTime.nullable(),
  failedAt: IsoDateTime.nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const listMessages = endpoint({
  id: "notifications.messages.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/notifications/messages",
  auth: "user",
  summary: "The organisation's outbox, newest first",
  params: OrgParams,
  query: z.object({
    status: NotificationStatus.optional(),
    channel: Channel.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({ messages: z.array(Notification) }),
});

export const getMessage = endpoint({
  id: "notifications.messages.get",
  method: "GET",
  path: "/api/v1/orgs/:orgId/notifications/messages/:messageId",
  auth: "user",
  summary: "One message with every delivery report received for it",
  params: OrgParams.extend({ messageId: z.string().min(1) }),
  response: z.object({ message: Notification, events: z.array(NotificationEvent) }),
});

export const recordMessage = endpoint({
  id: "notifications.messages.record",
  method: "POST",
  path: "/api/v1/orgs/:orgId/notifications/messages",
  auth: "user",
  summary:
    "Record a message from a template. The consent rules decide whether it is recorded or suppressed; nothing is sent here.",
  params: OrgParams,
  body: z.object({
    channel: Channel,
    to: z.string().trim().min(3).max(200),
    category: Category,
    templateKey: TemplateKey,
    vars: z.record(z.string(), z.string().max(2000)).default({}),
    /** Your own key: recording the same ref twice returns the first message. */
    ref: z.string().trim().min(1).max(120).optional(),
  }),
  response: Notification,
  status: 201,
});

/** A provider's delivery report, translated by its adapter and signed like payment events. */
export const DeliveryReport = z.object({
  /** The provider's own event id (idempotent). */
  id: z.string().min(1).max(200),
  /** The provider's message id returned when the message was queued. */
  messageId: z.string().min(1).max(200),
  status: z.enum(["sent", "delivered", "failed", "undelivered", "rejected"]),
  detail: z.string().max(500).optional(),
});
export type DeliveryReportInput = z.infer<typeof DeliveryReport>;

export const deliveryWebhook = endpoint({
  id: "webhooks.notifications",
  method: "POST",
  path: "/api/v1/webhooks/notifications/:provider",
  auth: "signed-webhook",
  summary: "Delivery report from a messaging provider adapter (signed with WEBHOOK_SECRET_<PROVIDER>)",
  params: z.object({ provider: z.string().regex(/^[a-z0-9_-]{2,40}$/) }),
  body: DeliveryReport,
  response: z.object({ duplicate: z.boolean(), messageId: z.string(), status: NotificationStatus }),
});

/**
 * The configured e-mail provider's own delivery webhook (Resend, Postmark or SendGrid), verified with that provider's
 * documented scheme (Svix signature, basic auth, signed event webhook — PLATFORM_EMAIL_WEBHOOK_SECRET). Delivered → delivered,
 * bounced / dropped → bounced. Any other provider answers 404.
 */
export const emailWebhook = endpoint({
  id: "webhooks.email",
  method: "POST",
  path: "/api/v1/webhooks/email/:provider",
  auth: "public",
  summary: "Delivery events from the configured e-mail provider (verified with the provider's own signature scheme)",
  params: z.object({ provider: z.enum(["resend", "postmark", "sendgrid"]) }),
  body: z.unknown(),
  response: z.object({ received: z.number().int(), applied: z.number().int() }),
});
