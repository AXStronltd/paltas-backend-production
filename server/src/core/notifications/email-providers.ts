/*
 * Real e-mail delivery, with Node's own fetch, crypto, net and tls (no SDK, no new dependency). Chosen by
 * PLATFORM_EMAIL_PROVIDER with PLATFORM_EMAIL_FROM. The adapter is registered as "platform_<provider>":
 *   - smtp (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD, e.g. Gmail with an app password): the mail server's
 *     acceptance makes a message "sent (accepted by mail server)"; SMTP has no delivery report, so an SMTP message
 *     is never "delivered" or "bounced";
 *   - resend | postmark | sendgrid (RESEND_API_KEY | POSTMARK_SERVER_TOKEN | SENDGRID_API_KEY): the provider's HTTPS
 *     API, and its delivery webhook.
 * Without a provider and its credentials nothing here is used and every message stays "recorded — not sent" (the
 * test adapter), exactly as before.
 *
 *   submit   the provider's ACCEPTED answer with its message id is the only thing that makes a message "sent";
 *            a refusal (4xx) makes it "failed"; a timeout, network error, 429 or 5xx leaves it "recorded" to be tried
 *            again by the next dispatch (at most MAX_ATTEMPTS times, then "failed").
 *   webhook  "delivered" / "bounced" come only from the provider's delivery webhook, verified with that provider's
 *            documented scheme:
 *              - Resend (Svix):  svix-id / svix-timestamp / svix-signature headers; v1 = base64 HMAC-SHA256 of
 *                                "<id>.<timestamp>.<body>" with the base64 key after "whsec_"; 5-minute tolerance;
 *              - Postmark:       HTTP basic auth on the webhook URL (Postmark's documented protection), compared in
 *                                constant time with PLATFORM_EMAIL_WEBHOOK_SECRET "user:password";
 *              - SendGrid:       Signed Event Webhook: ECDSA (P-256, SHA-256) signature of "<timestamp><body>" in
 *                                X-Twilio-Email-Event-Webhook-Signature, checked with the verification public key.
 *
 * Messages go out from PLATFORM_EMAIL_FROM (the provider only sends from a verified domain); an organisation's own sender name
 * is the display name and its address the reply-to. Live delivery is unverified until the owner adds a real key.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { EmailSettings } from "../../config.js";
import { fail } from "../../http/errors.js";
import type { NotificationAdapter, OutboundMessage, SubmitResult } from "./adapters.js";
import { htmlFromText, sendSmtp } from "./smtp.js";

export type EmailProvider = NonNullable<EmailSettings["provider"]>;
export type HttpEmailProvider = Exclude<EmailProvider, "smtp">;

/** How the adapter reaches the provider (tests: real fetch / TLS against local fakes). */
export interface EmailTransport {
  fetch?: typeof fetch;
  /** Extra trusted certificate authority for SMTP over TLS (tests: the fake server's certificate). */
  smtpCa?: string | Buffer;
}

export const EMAIL_PROVIDER_LABEL: Record<EmailProvider, string> = {
  smtp: "SMTP mail server",
  resend: "Resend (e-mail API)",
  postmark: "Postmark (e-mail API)",
  sendgrid: "SendGrid (e-mail API)",
};

const DEFAULT_API: Record<HttpEmailProvider, string> = {
  resend: "https://api.resend.com",
  postmark: "https://api.postmarkapp.com",
  sendgrid: "https://api.sendgrid.com",
};

export const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 15_000;
const TOLERANCE_SECONDS = 300;

/** One delivery outcome from a provider webhook, translated. */
export interface EmailEvent {
  eventId: string;
  messageId: string;
  outcome: "delivered" | "bounced" | "complained" | "other";
  detail: string;
}

type Fetch = typeof fetch;

function mailbox(name: string, address: string) {
  const clean = name.replace(/["<>\r\n]/g, "").trim();
  return clean ? `"${clean}" <${address}>` : address;
}

async function post(
  f: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; header(n: string): string | null } | { error: string }> {
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { message: text.slice(0, 200) };
    }
    return { status: res.status, json, header: (n) => res.headers.get(n) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const transient = (status: number) => status === 429 || status >= 500;
const why = (json: Record<string, unknown>) =>
  String(json.message ?? json.Message ?? (json.errors as { message?: string }[] | undefined)?.[0]?.message ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 200);

/** SMTP: "sent" means the mail server accepted it — nothing more is ever known. */
function smtpAdapter(s: EmailSettings, t: EmailTransport): NotificationAdapter {
  const o = s.smtp as NonNullable<EmailSettings["smtp"]>;
  const label = `${EMAIL_PROVIDER_LABEL.smtp} (${o.host}:${o.port})`;
  return {
    key: "platform_smtp",
    channel: "email",
    label,
    connected: true,
    status: `Connected — ${label}; SMTP reports acceptance only, never delivery`,
    async submit(m) {
      const r = await sendSmtp(
        { ...o, ...(t.smtpCa ? { ca: t.smtpCa } : {}) },
        {
          from: { name: m.from.name || s.fromName, address: s.fromAddress },
          to: m.to,
          replyTo: m.from.replyTo || m.from.address || s.fromAddress,
          subject: m.subject,
          text: m.body,
          ref: m.id,
        },
      );
      if (r.ok)
        return {
          accepted: true,
          sent: true,
          providerMessageId: r.messageId,
          note: `Sent (accepted by mail server ${o.host}: ${r.response}) — SMTP gives no delivery report`.slice(0, 500),
        };
      if (r.transient) return { accepted: false, retry: true, note: `SMTP ${r.stage}: ${r.response} — will retry` };
      return { accepted: false, note: `SMTP ${r.stage} refused: ${r.response}` };
    },
  };
}

/** The live adapter for the configured provider. */
export function emailAdapter(
  s: EmailSettings & { provider: EmailProvider },
  t: EmailTransport = {},
): NotificationAdapter {
  if (s.provider === "smtp") return smtpAdapter(s, t);
  const provider: HttpEmailProvider = s.provider;
  const f: Fetch = t.fetch ?? fetch;
  const label = EMAIL_PROVIDER_LABEL[provider];
  const base = s.apiUrl ?? DEFAULT_API[provider];
  const key = s.apiKey as string;

  async function submit(m: OutboundMessage): Promise<SubmitResult> {
    const fromName = m.from.name || s.fromName;
    const replyTo = m.from.replyTo || m.from.address || s.fromAddress;
    const html = htmlFromText(m.body);
    let r: Awaited<ReturnType<typeof post>>;
    let id: string | null = null;
    if (provider === "resend") {
      r = await post(
        f,
        `${base}/emails`,
        { Authorization: `Bearer ${key}`, "Idempotency-Key": m.id },
        {
          from: mailbox(fromName, s.fromAddress),
          to: [m.to],
          subject: m.subject,
          text: m.body,
          html,
          reply_to: replyTo,
          tags: [{ name: "paltas_id", value: m.id }],
        },
      );
      if (!("error" in r) && r.status >= 200 && r.status < 300) id = typeof r.json.id === "string" ? r.json.id : null;
    } else if (provider === "postmark") {
      r = await post(
        f,
        `${base}/email`,
        { "X-Postmark-Server-Token": key },
        {
          From: mailbox(fromName, s.fromAddress),
          To: m.to,
          Subject: m.subject,
          TextBody: m.body,
          HtmlBody: html,
          ReplyTo: replyTo,
          MessageStream: "outbound",
          Metadata: { paltas_id: m.id },
        },
      );
      if (!("error" in r) && r.status === 200 && Number(r.json.ErrorCode ?? 0) === 0)
        id = typeof r.json.MessageID === "string" ? r.json.MessageID : null;
    } else {
      r = await post(
        f,
        `${base}/v3/mail/send`,
        { Authorization: `Bearer ${key}` },
        {
          personalizations: [{ to: [{ email: m.to }], custom_args: { paltas_id: m.id } }],
          from: { email: s.fromAddress, name: fromName },
          reply_to: { email: replyTo },
          subject: m.subject,
          content: [
            { type: "text/plain", value: m.body },
            { type: "text/html", value: html },
          ],
        },
      );
      if (!("error" in r) && r.status === 202) id = r.header("x-message-id");
    }
    if ("error" in r) return { accepted: false, retry: true, note: `${label}: not reached (${r.error}) — will retry` };
    if (id) return { accepted: true, sent: true, providerMessageId: id, note: `Sent — accepted by ${label}` };
    if (transient(r.status))
      return { accepted: false, retry: true, note: `${label}: answered ${r.status} ${why(r.json)} — will retry` };
    return { accepted: false, note: `${label} refused the message: ${r.status} ${why(r.json)}`.trim() };
  }

  return {
    key: `platform_${provider}`,
    channel: "email",
    label,
    connected: true,
    status: `Connected — ${label}`,
    submit,
  };
}

// ---------------------------------------------------------------- delivery webhooks

const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

function verifyResend(secret: string, h: (n: string) => string | undefined, raw: Buffer, now: number) {
  const id = h("svix-id");
  const ts = h("svix-timestamp");
  const sigs = h("svix-signature");
  if (!id || !ts || !sigs) throw fail.notSignedIn("Missing webhook signature");
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > TOLERANCE_SECONDS) throw fail.notSignedIn("Signature too old");
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", keyBytes)
    .update(`${id}.${ts}.${raw.toString("utf8")}`)
    .digest();
  const ok = sigs
    .split(" ")
    .map((p) => p.split(","))
    .some(([v, sig]) => v === "v1" && !!sig && eq(Buffer.from(sig, "base64"), want));
  if (!ok) throw fail.notSignedIn("Signature does not match");
}

function verifyPostmark(secret: string, h: (n: string) => string | undefined) {
  const m = /^Basic\s+(\S+)$/.exec(h("authorization") ?? "");
  if (!m?.[1]) throw fail.notSignedIn("Missing webhook credentials");
  if (!eq(Buffer.from(m[1], "base64"), Buffer.from(secret, "utf8")))
    throw fail.notSignedIn("Webhook credentials do not match");
}

function verifySendgrid(publicKey: string, h: (n: string) => string | undefined, raw: Buffer, now: number) {
  const sig = h("x-twilio-email-event-webhook-signature");
  const ts = h("x-twilio-email-event-webhook-timestamp");
  if (!sig || !ts) throw fail.notSignedIn("Missing webhook signature");
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > TOLERANCE_SECONDS) throw fail.notSignedIn("Signature too old");
  let ok: boolean;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    ok = verify("sha256", Buffer.concat([Buffer.from(ts, "utf8"), raw]), key, Buffer.from(sig, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw fail.notSignedIn("Signature does not match");
}

/** Check a delivery webhook with the provider's own scheme. Throws 404 for a provider that is not configured. */
export function verifyEmailWebhook(
  s: EmailSettings,
  provider: string,
  header: (name: string) => string | undefined,
  raw: Buffer,
  nowSeconds: number = Date.now() / 1000,
) {
  // SMTP has no delivery webhook at all
  if (provider === "smtp" || provider !== s.provider || !s.webhookSecret)
    throw fail.notFound("No e-mail provider webhook here");
  if (provider === "resend") verifyResend(s.webhookSecret, header, raw, nowSeconds);
  else if (provider === "postmark") verifyPostmark(s.webhookSecret, header);
  else verifySendgrid(s.webhookSecret, header, raw, nowSeconds);
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Translate a verified webhook body into delivery outcomes (unknown kinds are kept as "other"). */
export function parseEmailEvents(
  provider: HttpEmailProvider,
  body: unknown,
  header: (n: string) => string | undefined,
): EmailEvent[] {
  if (provider === "resend") {
    const b = body as { type?: string; data?: { email_id?: string; bounce?: { message?: string } } };
    const type = str(b?.type);
    const outcome =
      type === "email.delivered"
        ? "delivered"
        : type === "email.bounced"
          ? "bounced"
          : type === "email.complained"
            ? "complained"
            : "other";
    const messageId = str(b?.data?.email_id);
    return messageId
      ? [{ eventId: str(header("svix-id")), messageId, outcome, detail: str(b?.data?.bounce?.message) || type }]
      : [];
  }
  if (provider === "postmark") {
    const b = body as Record<string, unknown>;
    const type = str(b?.RecordType);
    const outcome =
      type === "Delivery"
        ? "delivered"
        : type === "Bounce"
          ? "bounced"
          : type === "SpamComplaint"
            ? "complained"
            : "other";
    const messageId = str(b?.MessageID);
    const eventId = `${type}:${messageId}:${str(b?.ID) || str(b?.DeliveredAt) || str(b?.BouncedAt)}`;
    return messageId ? [{ eventId, messageId, outcome, detail: str(b?.Details) || str(b?.Description) || type }] : [];
  }
  const list = Array.isArray(body) ? body : [];
  return list.flatMap((e: Record<string, unknown>) => {
    const ev = str(e?.event);
    const messageId = str(e?.sg_message_id).split(".")[0] ?? "";
    if (!messageId || !str(e?.sg_event_id)) return [];
    const outcome =
      ev === "delivered"
        ? "delivered"
        : ev === "bounce" || ev === "dropped"
          ? "bounced"
          : ev === "spamreport"
            ? "complained"
            : "other";
    return [{ eventId: str(e.sg_event_id), messageId, outcome, detail: str(e.reason) || ev } as EmailEvent];
  });
}
