/*
 * Delivery provider boundaries for the notifications outbox. PALTAS hands a message to a provider ONLY through one of
 * these adapters; the provider later reports "sent" / "failed" through the signed delivery webhook.
 *
 * Adapters:
 *   - "test" (every channel): accepts the message into the queue and says "Not connected — test adapter". It never
 *     returns a provider message id, so nothing it handles can ever become "sent" (the database refuses that too).
 *   - PALTAS's own e-mail ("platform_smtp" / "platform_resend" / …, email-providers.ts): registered only when
 *     PLATFORM_EMAIL_PROVIDER and its credentials are set; used only for PALTAS's own transactional e-mails and never
 *     selectable by an organisation. Acceptance makes a message "sent"; an HTTPS provider's webhook
 *     "delivered"/"bounced"; SMTP never reports delivery.
 *   - an organisation's own SMTP, SMS API, WhatsApp Cloud API, push: BLOCKED until credentials and a certified adapter exist. They are
 *     listed so the settings screen shows them, and they cannot be selected.
 */
import type { notifications } from "@paltas/contracts";

export type Channel = notifications.Channel;

export interface OutboundMessage {
  id: string;
  orgId: string;
  channel: Channel;
  to: string;
  subject: string;
  body: string;
  from: { name: string; address: string; replyTo: string };
}

/**
 * accepted + sent: the provider took the message and returned its id ("sent"); accepted without sent: handed on
 * without a provider id ("queued", the test adapter); not accepted: refused ("failed"), or with retry a temporary
 * problem (stays "recorded" for the next dispatch).
 */
export type SubmitResult =
  | { accepted: true; providerMessageId: string | null; note: string; sent?: boolean }
  | { accepted: false; note: string; retry?: boolean };

export interface NotificationAdapter {
  key: string;
  channel: Channel;
  label: string;
  connected: boolean;
  status: string;
  /** Hand one message to the provider. Must not report delivery: that comes from the provider's webhook. */
  submit(message: OutboundMessage): Promise<SubmitResult>;
}

export const TEST_ADAPTER_STATUS = "Not connected — test adapter";
export const BLOCKED_STATUS = "BLOCKED — needs provider credentials and a certified adapter";

function testAdapter(channel: Channel): NotificationAdapter {
  return {
    key: "test",
    channel,
    label: `Test adapter (${channel})`,
    connected: false,
    status: TEST_ADAPTER_STATUS,
    submit: async () => ({
      accepted: true,
      providerMessageId: null,
      note: `${TEST_ADAPTER_STATUS}: queued in PALTAS only — nothing was sent`,
    }),
  };
}

function blocked(key: string, channel: Channel, label: string): NotificationAdapter {
  return {
    key,
    channel,
    label,
    connected: false,
    status: BLOCKED_STATUS,
    submit: async () => ({ accepted: false, note: `${label}: ${BLOCKED_STATUS}` }),
  };
}

export function defaultAdapters(): NotificationAdapter[] {
  return [
    testAdapter("email"),
    testAdapter("sms"),
    testAdapter("whatsapp"),
    testAdapter("push"),
    blocked("smtp", "email", "E-mail over SMTP"),
    blocked("email_api", "email", "E-mail sending API"),
    blocked("sms_api", "sms", "SMS gateway API"),
    blocked("whatsapp_cloud", "whatsapp", "WhatsApp Business Cloud API"),
    blocked("push_fcm", "push", "Mobile push (FCM / APNs)"),
  ];
}
