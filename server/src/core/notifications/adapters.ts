/*
 * Delivery provider boundaries for the notifications outbox. PALTAS hands a message to a provider ONLY through one of
 * these adapters; the provider later reports "sent" / "failed" through the signed delivery webhook.
 *
 * No provider is connected yet:
 *   - "test" (every channel): accepts the message into the queue and says "Not connected — test adapter". It never
 *     returns a provider message id, so nothing it handles can ever become "sent" (the database refuses that too).
 *   - SMTP / e-mail API, SMS API, WhatsApp Cloud API, push: BLOCKED until credentials and a certified adapter exist.
 *     They are listed so the settings screen shows them, and they cannot be selected.
 * A real adapter replaces a blocked one here (connected: true) and returns the provider's message id.
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

export type SubmitResult =
  { accepted: true; providerMessageId: string | null; note: string } | { accepted: false; note: string };

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
