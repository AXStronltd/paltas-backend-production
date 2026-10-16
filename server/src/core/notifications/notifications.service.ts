/*
 * The notifications outbox, used by every product (core.notifications.record(...)).
 *
 *   record      template + organisation's wording + consent check → "recorded" (or "suppressed", never handed on)
 *   dispatch    (scheduler job, every minute) each recorded message goes to its provider adapter: the organisation's
 *               sender for its channel, or — for PALTAS's own e-mails (source "platform": verification, password
 *               reset, trial reminders) — the configured e-mail provider (PLATFORM_EMAIL_PROVIDER). A real provider's accepted
 *               answer with its message id → "sent"; the test adapter → "queued" (nothing sent); a refusal →
 *               "failed"; a temporary problem → stays "recorded" and is tried again (at most MAX_ATTEMPTS times).
 *   report      the provider's signed delivery webhook → "delivered" / "bounced" (or "failed" before acceptance).
 *
 * Consent rules (latest entry per organisation, channel, address and purpose decides):
 *   - marketing on any channel needs an explicit opt-in;
 *   - WhatsApp needs an explicit opt-in for the purpose (WhatsApp Business policy), transactional included;
 *   - other transactional messages go unless the person opted out of that channel.
 */
import type { notifications as N } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import type { OrgScope } from "../access/org-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { defaultAdapters, type Channel, type NotificationAdapter } from "./adapters.js";
import { emailAdapter, MAX_ATTEMPTS, type EmailEvent, type EmailTransport } from "./email-providers.js";

type Category = "transactional" | "marketing";
type Status = N.NotificationStatus;

interface NotificationRow {
  id: string;
  org_id: string;
  channel: Channel;
  to_address: string;
  category: Category;
  template_key: string | null;
  subject: string;
  body: string;
  status: Status;
  status_note: string;
  provider: string | null;
  provider_message_id: string | null;
  source: string;
  source_ref: string | null;
  created_by: string | null;
  created_at: string;
  queued_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  failed_at: string | null;
  attempts: number;
}

interface SenderRow {
  channel: Channel;
  provider: string;
  from_name: string;
  from_address: string;
  reply_to: string;
  enabled: boolean;
  updated_at: string;
}

interface TemplateRow {
  org_id: string | null;
  key: string;
  channel: Channel;
  subject: string;
  body: string;
  updated_at: string;
}

interface ConsentRow {
  channel: Channel;
  address: string;
  purpose: Category;
  granted: boolean;
  source: string;
  recorded_by: string | null;
  recorded_at: string;
}

export interface RecordInput {
  orgId: string;
  channel: Channel;
  to: string;
  category: Category;
  /** A template (the organisation's wording, else the PALTAS default) with its variables … */
  templateKey?: string;
  vars?: Record<string, string>;
  /** … or the text itself. */
  subject?: string;
  body?: string;
  /** Which area records it ("hotel", "property", …) and its own key: the same source + ref is recorded once. */
  source: string;
  sourceRef?: string | null;
  createdBy?: string | null;
}

const CHANNELS: readonly Channel[] = ["email", "sms", "whatsapp", "push"];
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export const variablesOf = (...texts: string[]) =>
  [...new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1] as string)))].sort();

/** Fill {{placeholders}}; every one must have a value. */
export function render(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_, k: string) => vars[k] as string);
}

/** One canonical form per address, so consent and messages always refer to the same person. */
export function normaliseAddress(channel: Channel, raw: string): string {
  const v = raw.trim();
  if (channel === "email") {
    const e = v.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw fail.invalid("That e-mail address looks wrong");
    return e;
  }
  if (channel === "push") {
    if (!/^[A-Za-z0-9:_\-.]{10,500}$/.test(v)) throw fail.invalid("That device token looks wrong");
    return v;
  }
  const phone = v.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    throw fail.invalid("Give the phone number in international form, e.g. +254700000000");
  return phone;
}

const toMessage = (r: NotificationRow): N.Notification => ({
  id: r.id,
  channel: r.channel,
  to: r.to_address,
  category: r.category,
  templateKey: r.template_key,
  subject: r.subject,
  body: r.body,
  status: r.status,
  statusNote: r.status_note,
  provider: r.provider,
  providerMessageId: r.provider_message_id,
  source: r.source,
  sourceRef: r.source_ref,
  createdBy: r.created_by,
  createdAt: r.created_at,
  queuedAt: r.queued_at,
  sentAt: r.sent_at,
  deliveredAt: r.delivered_at,
  bouncedAt: r.bounced_at,
  failedAt: r.failed_at,
});

const toConsent = (c: ConsentRow) => ({
  channel: c.channel,
  address: c.address,
  purpose: c.purpose,
  granted: c.granted,
  source: c.source,
  recordedBy: c.recorded_by,
  recordedAt: c.recorded_at,
});

/** PALTAS's own sender ("platform_smtp", "platform_resend", …): never an organisation's. */
const isPlatformKey = (key: string) => key.startsWith("platform_");

export function notificationsService(ctx: AppContext, transport: EmailTransport = {}) {
  const { db, log, config } = ctx;
  const adapters = new Map<string, NotificationAdapter>();
  const adapterKey = (channel: Channel, key: string) => `${channel}:${key}`;
  for (const a of defaultAdapters()) adapters.set(adapterKey(a.channel, a.key), a);
  // PALTAS's own e-mail provider (PLATFORM_EMAIL_PROVIDER): none configured = recorded only, as before. It is
  // registered as "platform_<provider>" and no organisation can ever choose it as its own sender.
  const email = config.email;
  const platformEmail = email.provider ? emailAdapter({ ...email, provider: email.provider }, transport) : null;
  if (platformEmail) adapters.set(adapterKey("email", platformEmail.key), platformEmail);
  else if (email.notConfigured)
    log.warn({ reason: email.notConfigured }, "E-mail provider not in use: messages are recorded only");
  const helpEmail = email.fromAddress;

  async function latestConsent(t: Db, orgId: string, channel: Channel, address: string, purpose: Category) {
    return t.row<{ granted: boolean }>(
      `SELECT granted FROM notification_consents WHERE org_id = $1 AND channel = $2 AND address = $3 AND purpose = $4
       ORDER BY id DESC LIMIT 1`,
      [orgId, channel, address, purpose],
    );
  }

  /** null = may be recorded; otherwise why it is suppressed. */
  async function consentRefusal(t: Db, orgId: string, channel: Channel, address: string, category: Category) {
    const c = await latestConsent(t, orgId, channel, address, category);
    if (category === "marketing" && c?.granted !== true)
      return "Suppressed — no marketing consent recorded for this address";
    if (channel === "whatsapp" && c?.granted !== true)
      return "Suppressed — no WhatsApp opt-in recorded for this address";
    if (c?.granted === false) return `Suppressed — the person opted out of ${channel} messages`;
    return null;
  }

  async function template(t: Db, orgId: string, key: string, channel: Channel) {
    return t.row<TemplateRow>(
      `SELECT * FROM notification_templates WHERE key = $2 AND channel = $3 AND (org_id = $1 OR org_id IS NULL)
       ORDER BY org_id NULLS LAST LIMIT 1`,
      [orgId, key, channel],
    );
  }

  /** Record a message (products call this inside their own transaction). Idempotent on source + sourceRef. */
  async function record(t: Db, input: RecordInput): Promise<N.Notification> {
    if (input.sourceRef) {
      const seen = await t.row<NotificationRow>(
        "SELECT * FROM notifications WHERE org_id = $1 AND source = $2 AND source_ref = $3",
        [input.orgId, input.source, input.sourceRef],
      );
      if (seen) return toMessage(seen);
    }
    const to = normaliseAddress(input.channel, input.to);
    let subject = input.subject ?? "";
    let body = input.body ?? "";
    if (input.templateKey) {
      const tpl = await template(t, input.orgId, input.templateKey, input.channel);
      if (!tpl) throw fail.invalid(`No ${input.channel} template "${input.templateKey}"`);
      const org = await t.row<{ name: string }>("SELECT name FROM organisations WHERE id = $1", [input.orgId]);
      const vars: Record<string, string> = { orgName: org?.name ?? "", helpEmail, ...input.vars };
      const missing = variablesOf(tpl.subject, tpl.body).filter((v) => vars[v] === undefined);
      if (missing.length) throw fail.invalid(`The template needs a value for: ${missing.join(", ")}`, { missing });
      subject = render(tpl.subject, vars);
      body = render(tpl.body, vars);
    }
    if (!body.trim()) throw fail.invalid("Give a template or the message text");
    const refusal = await consentRefusal(t, input.orgId, input.channel, to, input.category);
    const row = await t.row<NotificationRow>(
      `INSERT INTO notifications (id, org_id, channel, to_address, category, template_key, subject, body, status,
         status_note, source, source_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        newId("ntf"),
        input.orgId,
        input.channel,
        to,
        input.category,
        input.templateKey ?? null,
        subject,
        body,
        refusal ? "suppressed" : "recorded",
        refusal ?? "Recorded — waiting to be handed to the provider",
        input.source,
        input.sourceRef ?? null,
        input.createdBy ?? null,
      ],
    );
    return toMessage(row as NotificationRow);
  }

  /**
   * One delivery outcome on a message. queued → sent / delivered / failed; sent → delivered / bounced;
   * delivered → bounced (a late bounce). Anything else (a report for a failed or bounced message) changes nothing.
   */
  async function applyOutcome(t: Db, n: NotificationRow, kind: "sent" | "delivered" | "undelivered", note: string) {
    const from = n.status;
    let to: Status | null = null;
    if (kind === "sent" && from === "queued") to = "sent";
    else if (kind === "delivered" && (from === "queued" || from === "sent")) to = "delivered";
    else if (kind === "undelivered")
      to = from === "queued" ? "failed" : from === "sent" || from === "delivered" ? "bounced" : null;
    if (!to) return from;
    await t.run(
      `UPDATE notifications SET status = $2, status_note = $3,
         sent_at = CASE WHEN $2 IN ('sent', 'delivered') THEN COALESCE(sent_at, now()) ELSE sent_at END,
         delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
         bounced_at = CASE WHEN $2 = 'bounced' THEN now() ELSE bounced_at END,
         failed_at = CASE WHEN $2 = 'failed' THEN now() ELSE failed_at END
       WHERE id = $1`,
      [n.id, to, note.slice(0, 500)],
    );
    return to;
  }

  async function senders(orgId: string) {
    const rows = await db.rows<SenderRow>("SELECT * FROM notification_senders WHERE org_id = $1", [orgId]);
    return CHANNELS.map((channel) => {
      const r = rows.find((x) => x.channel === channel);
      const provider = r?.provider ?? "test";
      return {
        channel,
        provider,
        providerStatus: adapters.get(adapterKey(channel, provider))?.status ?? "Provider not available",
        fromName: r?.from_name ?? "",
        fromAddress: r?.from_address ?? "",
        replyTo: r?.reply_to ?? "",
        enabled: r?.enabled ?? true,
        updatedAt: r?.updated_at ?? null,
      };
    });
  }

  return {
    record,

    /** Install a provider adapter (a certified live adapter, or a stand-in in tests). */
    registerAdapter(a: NotificationAdapter) {
      adapters.set(adapterKey(a.channel, a.key), a);
    },

    /** The providers an organisation can choose from (PALTAS's own platform sender is not one of them). */
    providers() {
      return [...adapters.values()]
        .filter((a) => !isPlatformKey(a.key))
        .map((a) => ({
          key: a.key,
          channel: a.channel,
          label: a.label,
          connected: a.connected,
          status: a.status,
        }));
    },

    senders,

    async saveSender(
      s: OrgScope,
      channel: Channel,
      b: { provider: string; fromName: string; fromAddress: string; replyTo: string; enabled: boolean },
    ) {
      if (isPlatformKey(b.provider)) throw fail.forbidden("The PALTAS platform sender is managed by PALTAS");
      const a = adapters.get(adapterKey(channel, b.provider));
      if (!a) throw fail.invalid(`No ${channel} provider "${b.provider}"`);
      if (!a.connected && a.key !== "test") throw fail.conflict(`${a.label} is not connected: ${a.status}`);
      if (channel === "email" && b.fromAddress) normaliseAddress("email", b.fromAddress);
      await db.tx(async (t) => {
        const before = await t.row("SELECT * FROM notification_senders WHERE org_id = $1 AND channel = $2", [
          s.orgId,
          channel,
        ]);
        await t.run(
          `INSERT INTO notification_senders (org_id, channel, provider, from_name, from_address, reply_to, enabled, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT (org_id, channel) DO UPDATE SET provider = EXCLUDED.provider, from_name = EXCLUDED.from_name,
             from_address = EXCLUDED.from_address, reply_to = EXCLUDED.reply_to, enabled = EXCLUDED.enabled,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [s.orgId, channel, b.provider, b.fromName, b.fromAddress, b.replyTo, b.enabled, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Notification sender changed",
          target: channel,
          before,
          after: b,
        });
      });
      return (await senders(s.orgId)).find((x) => x.channel === channel) as Awaited<ReturnType<typeof senders>>[0];
    },

    async templates(orgId: string) {
      const rows = await db.rows<TemplateRow>(
        `SELECT DISTINCT ON (key, channel) * FROM notification_templates WHERE org_id = $1 OR org_id IS NULL
         ORDER BY key, channel, org_id NULLS LAST`,
        [orgId],
      );
      return rows.map((r) => ({
        key: r.key,
        channel: r.channel,
        subject: r.subject,
        body: r.body,
        source: r.org_id ? ("organisation" as const) : ("paltas" as const),
        variables: variablesOf(r.subject, r.body),
        updatedAt: r.updated_at,
      }));
    },

    async saveTemplate(s: OrgScope, key: string, channel: Channel, b: { subject: string; body: string }) {
      return db.tx(async (t) => {
        const before = await t.row<TemplateRow>(
          "SELECT * FROM notification_templates WHERE org_id = $1 AND key = $2 AND channel = $3 FOR UPDATE",
          [s.orgId, key, channel],
        );
        const row = before
          ? await t.row<TemplateRow>(
              `UPDATE notification_templates SET subject = $4, body = $5, updated_by = $6, updated_at = now()
               WHERE org_id = $1 AND key = $2 AND channel = $3 RETURNING *`,
              [s.orgId, key, channel, b.subject, b.body, s.userId],
            )
          : await t.row<TemplateRow>(
              `INSERT INTO notification_templates (id, org_id, key, channel, subject, body, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [newId("tpl"), s.orgId, key, channel, b.subject, b.body, s.userId],
            );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Notification template saved",
          target: `${key} · ${channel}`,
          before: before ? { subject: before.subject, body: before.body } : undefined,
          after: b,
        });
        const r = row as TemplateRow;
        return {
          key: r.key,
          channel: r.channel,
          subject: r.subject,
          body: r.body,
          source: "organisation" as const,
          variables: variablesOf(r.subject, r.body),
          updatedAt: r.updated_at,
        };
      });
    },

    async consents(orgId: string, address?: string) {
      const rows = await db.rows<ConsentRow>(
        `SELECT * FROM notification_consents WHERE org_id = $1 AND ($2::text IS NULL OR lower(address) = lower($2))
         ORDER BY id DESC LIMIT 500`,
        [orgId, address?.replace(/[\s()-]/g, "") ?? null],
      );
      return rows.map(toConsent);
    },

    async recordConsent(
      s: OrgScope,
      b: { channel: Channel; address: string; purpose: Category; granted: boolean; source: string },
    ) {
      const address = normaliseAddress(b.channel, b.address);
      return db.tx(async (t) => {
        const row = await t.row<ConsentRow>(
          `INSERT INTO notification_consents (org_id, channel, address, purpose, granted, source, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [s.orgId, b.channel, address, b.purpose, b.granted, b.source, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.granted ? "Consent given" : "Consent withdrawn",
          target: `${b.channel} · ${address}`,
          detail: `${b.purpose} · ${b.source}`,
        });
        return toConsent(row as ConsentRow);
      });
    },

    async messages(orgId: string, q: { status?: Status | undefined; channel?: Channel | undefined; limit: number }) {
      const rows = await db.rows<NotificationRow>(
        `SELECT * FROM notifications WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR channel = $3) ORDER BY created_at DESC, id LIMIT $4`,
        [orgId, q.status ?? null, q.channel ?? null, q.limit],
      );
      return rows.map(toMessage);
    },

    async message(orgId: string, id: string) {
      const r = await db.row<NotificationRow>("SELECT * FROM notifications WHERE id = $1 AND org_id = $2", [id, orgId]);
      if (!r) throw fail.notFound("Message not found");
      const events = await db.rows<{
        provider: string;
        provider_event_id: string;
        status: string;
        detail: string;
        received_at: string;
      }>("SELECT * FROM notification_events WHERE notification_id = $1 ORDER BY id", [id]);
      return {
        message: toMessage(r),
        events: events.map((e) => ({
          provider: e.provider,
          providerEventId: e.provider_event_id,
          status: e.status,
          detail: e.detail,
          receivedAt: e.received_at,
        })),
      };
    },

    /** Recorded by a person from the workspace (audited). */
    async recordByHand(
      s: OrgScope,
      b: {
        channel: Channel;
        to: string;
        category: Category;
        templateKey: string;
        vars: Record<string, string>;
        ref?: string | undefined;
      },
    ) {
      return db.tx(async (t) => {
        const m = await record(t, {
          orgId: s.orgId,
          channel: b.channel,
          to: b.to,
          category: b.category,
          templateKey: b.templateKey,
          vars: b.vars,
          source: "manual",
          sourceRef: b.ref ?? null,
          createdBy: s.userId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Message recorded",
          target: m.id,
          detail: `${m.channel} · ${m.status}`,
        });
        return m;
      });
    },

    /**
     * Hand recorded messages to their provider adapter (the scheduler runs this every minute).
     * Accepted → "queued"; refused by the adapter → "failed". A turned-off sender keeps them waiting.
     */
    async dispatchPending(limit = 100) {
      const counts = { sent: 0, queued: 0, failed: 0, waiting: 0, retrying: 0 };
      await db.tx(async (t) => {
        const rows = await t.rows<
          NotificationRow & {
            s_provider: string | null;
            s_enabled: boolean | null;
            s_from_name: string | null;
            s_from_address: string | null;
            s_reply_to: string | null;
          }
        >(
          `SELECT n.*, s.provider AS s_provider, s.enabled AS s_enabled, s.from_name AS s_from_name,
                  s.from_address AS s_from_address, s.reply_to AS s_reply_to
           FROM notifications n
           LEFT JOIN notification_senders s ON s.org_id = n.org_id AND s.channel = n.channel
           JOIN organisations o ON o.id = n.org_id AND o.suspended_at IS NULL
           WHERE n.status = 'recorded' ORDER BY n.created_at, n.id LIMIT $1 FOR UPDATE OF n SKIP LOCKED`,
          [limit],
        );
        for (const n of rows) {
          // PALTAS's own transactional e-mails (verification, password reset, trial notices) go through the platform
          // provider whatever the organisation's sender settings say; nothing else ever does
          const platform =
            !!platformEmail && n.source === "platform" && n.channel === "email" && n.category === "transactional";
          if (!platform && n.s_enabled === false) {
            counts.waiting++;
            await t.run("UPDATE notifications SET status_note = $2 WHERE id = $1", [
              n.id,
              "Waiting — the organisation turned this channel's sender off",
            ]);
            continue;
          }
          const provider = platform ? (platformEmail as NotificationAdapter).key : (n.s_provider ?? "test");
          const a = !platform && isPlatformKey(provider) ? undefined : adapters.get(adapterKey(n.channel, provider));
          let res: Awaited<ReturnType<NotificationAdapter["submit"]>>;
          try {
            res = a
              ? await a.submit({
                  id: n.id,
                  orgId: n.org_id,
                  channel: n.channel,
                  to: n.to_address,
                  subject: n.subject,
                  body: n.body,
                  from: { name: n.s_from_name ?? "", address: n.s_from_address ?? "", replyTo: n.s_reply_to ?? "" },
                })
              : { accepted: false, note: `Provider "${provider}" is not available on this server` };
          } catch (err) {
            log.warn({ err, message: n.id, provider }, "Notification adapter error");
            res = { accepted: false, note: `${provider}: ${(err as Error).message}`.slice(0, 500) };
          }
          if (res.accepted && res.sent && res.providerMessageId) {
            counts.sent++;
            await t.run(
              `UPDATE notifications SET status = 'sent', provider = $2, provider_message_id = $3, status_note = $4,
                 queued_at = now(), sent_at = now(), attempts = attempts + 1 WHERE id = $1`,
              [n.id, provider, res.providerMessageId, res.note],
            );
          } else if (!res.accepted && res.retry && n.attempts + 1 < MAX_ATTEMPTS) {
            counts.retrying++;
            await t.run("UPDATE notifications SET status_note = $2, attempts = attempts + 1 WHERE id = $1", [
              n.id,
              `${res.note} (attempt ${n.attempts + 1} of ${MAX_ATTEMPTS})`.slice(0, 500),
            ]);
          } else if (res.accepted) {
            counts.queued++;
            await t.run(
              `UPDATE notifications SET status = 'queued', provider = $2, provider_message_id = $3, status_note = $4,
                 queued_at = now(), attempts = attempts + 1 WHERE id = $1`,
              [n.id, provider, res.providerMessageId, res.note],
            );
          } else {
            counts.failed++;
            await t.run(
              `UPDATE notifications SET status = 'failed', provider = $2, status_note = $3, failed_at = now(),
                 attempts = attempts + 1 WHERE id = $1`,
              [n.id, provider, res.note],
            );
          }
        }
      });
      return counts;
    },

    /** A provider's delivery report (already signature-checked). The only way a message becomes "sent". */
    async receiveReport(provider: string, r: N.DeliveryReportInput) {
      return db.tx(async (t) => {
        const n = await t.row<NotificationRow>(
          "SELECT * FROM notifications WHERE provider = $1 AND provider_message_id = $2 FOR UPDATE",
          [provider, r.messageId],
        );
        if (!n) throw fail.notFound("Unknown message for this provider");
        const inserted = await t.run(
          `INSERT INTO notification_events (notification_id, org_id, provider, provider_event_id, status, detail)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, provider_event_id) DO NOTHING`,
          [n.id, n.org_id, provider, r.id, r.status, r.detail ?? ""],
        );
        if (!inserted) return { duplicate: true, messageId: n.id, status: n.status };
        const kind = r.status === "sent" ? "sent" : r.status === "delivered" ? "delivered" : "undelivered";
        const to = await applyOutcome(
          t,
          n,
          kind,
          `${r.status}${r.detail ? ": " + r.detail : ""} — reported by ${provider}`,
        );
        return { duplicate: false, messageId: n.id, status: to };
      });
    },

    /** Is a real e-mail provider configured for PALTAS's own messages (verification, reset, reminders)? */
    emailDeliveryConfigured: () => !!platformEmail,

    /** Delivery outcomes from the configured e-mail provider's webhook (already verified with its own scheme). */
    async receiveEmailEvents(provider: string, events: EmailEvent[]) {
      let applied = 0;
      for (const e of events) {
        await db.tx(async (t) => {
          const n = await t.row<NotificationRow>(
            "SELECT * FROM notifications WHERE provider = $1 AND provider_message_id = $2 FOR UPDATE",
            [`platform_${provider}`, e.messageId],
          );
          if (!n) return; // not a PALTAS message (or another provider's): acknowledged, nothing to do
          const inserted = await t.run(
            `INSERT INTO notification_events (notification_id, org_id, provider, provider_event_id, status, detail)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, provider_event_id) DO NOTHING`,
            [n.id, n.org_id, provider, e.eventId, e.outcome, e.detail.slice(0, 500)],
          );
          if (!inserted || e.outcome === "other" || e.outcome === "complained") return;
          const before = n.status;
          const after = await applyOutcome(
            t,
            n,
            e.outcome === "delivered" ? "delivered" : "undelivered",
            `${e.outcome}: ${e.detail} — reported by ${provider}`,
          );
          if (after !== before) applied++;
        });
      }
      return { received: events.length, applied };
    },
  };
}

export type NotificationsService = ReturnType<typeof notificationsService>;
