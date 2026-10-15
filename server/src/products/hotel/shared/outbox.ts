/*
 * Hotel messages. hotel_messages is the hotel's own timeline of guest messages (what staff typed, what the
 * concierge answered, what was sent automatically). Templated outbound messages — booking confirmation,
 * pre-arrival, post-stay survey, invoice, statement, low-score alert, daily report — are also handed to the
 * PALTAS notifications outbox (core.notifications.record: consent rules, provider adapters, delivery reports), and
 * the timeline keeps the outbox message id and status. No provider is connected, so nothing is sent: the outbox says
 * "recorded", and only a provider's signed delivery report could ever make it "sent".
 * Automatic guest messages are recorded once per reservation (unique index here, source reference in the outbox).
 *
 * Templates: the hotel's own wording per language (hotel_message_templates), else the built-in English wording.
 * Placeholders {guest}, {hotel}, {number}, {arrival}, {departure}, {amount}, {date}, {company} are filled in.
 */
import type { hotel } from "@paltas/contracts";
import { normaliseAddress } from "../../../core/notifications/notifications.service.js";
import type { Db } from "../../../db/database.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps, HotelOp } from "../deps.js";

export interface MessageRow {
  id: string;
  reservation_id: string | null;
  channel: hotel.MessageOut["channel"];
  direction: "inbound" | "outbound";
  body: string;
  status: string;
  template: string | null;
  subject: string | null;
  recipient: string | null;
  created_at: string;
}

export const toMessage = (m: MessageRow): hotel.MessageOut => ({
  id: m.id,
  reservationId: m.reservation_id,
  channel: m.channel,
  direction: m.direction,
  body: m.body,
  status: m.status,
  template: m.template,
  subject: m.subject,
  recipient: m.recipient,
  at: m.created_at,
});

export type TemplateKey = (typeof hotel.MESSAGE_TEMPLATES)[number];

/** The built-in wording (English), used until the hotel writes its own. */
export const DEFAULT_TEMPLATES: Record<TemplateKey, { subject: string; body: string }> = {
  confirmation: {
    subject: "Your booking {number} at {hotel}",
    body: "Dear {guest}, thank you for booking {hotel}. Your reservation {number} is confirmed from {arrival} to {departure}.",
  },
  pre_arrival: {
    subject: "See you soon at {hotel}",
    body: "Dear {guest}, we look forward to welcoming you on {arrival} (reservation {number}). Reply with your arrival time or any request; you can complete check-in online.",
  },
  post_stay_survey: {
    subject: "How was your stay at {hotel}?",
    body: "Dear {guest}, thank you for staying with us (reservation {number}). Please tell us how we did, from 1 to 5.",
  },
  invoice: {
    subject: "Invoice {number} from {hotel}",
    body: "Dear {guest}, please find invoice {number} dated {date} for {amount}.",
  },
  low_score_alert: {
    subject: "Low guest score at {hotel}",
    body: "{guest} scored their stay {amount}/5 (reservation {number}). Please follow up.",
  },
  daily_report: {
    subject: "Daily report {date} — {hotel}",
    body: "The night audit closed {date} at {hotel}. The daily report is in PALTAS.",
  },
  audit_blocked: {
    subject: "Night audit blocked — {hotel}",
    body: "The automatic night audit of {date} at {hotel} could not close the day: {reasons}",
  },
  statement: {
    subject: "Statement of account — {company}",
    body: "Dear {company}, your balance with {hotel} is {amount} as of {date}.",
  },
};

const AUTO_ONCE: TemplateKey[] = ["confirmation", "pre_arrival", "post_stay_survey"];

export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

export async function templateFor(
  db: Db,
  propertyId: string,
  template: TemplateKey,
  language: string,
): Promise<{ subject: string; body: string }> {
  const own = await db.row<{ subject: string; body: string }>(
    `SELECT subject, body FROM hotel_message_templates WHERE property_id = $1 AND template = $2 AND language IN ($3, 'en')
     ORDER BY (language = $3) DESC LIMIT 1`,
    [propertyId, template, language],
  );
  return own ?? DEFAULT_TEMPLATES[template];
}

type Deps = Pick<HotelDeps, "adapters" | "core">;
type Op = Pick<HotelOp, "orgId" | "userId" | "property">;

/** Record one message. Returns its id, or null when an automatic message for this reservation already exists. */
export async function recordMessage(
  t: Db,
  d: Deps,
  op: Op,
  m: {
    reservationId: string | null;
    channel: hotel.MessageOut["channel"];
    direction: "inbound" | "outbound";
    body: string;
    template?: TemplateKey | null;
    subject?: string | null;
    recipient?: string | null;
  },
): Promise<string | null> {
  const id = newId("hms");
  const status =
    m.direction === "inbound" ? "Received" : d.adapters.messaging.deliver({ channel: m.channel, body: m.body });
  const once = m.template && AUTO_ONCE.includes(m.template) && m.reservationId;
  const r = await t.row<{ id: string }>(
    `INSERT INTO hotel_messages (id, org_id, property_id, reservation_id, channel, direction, body, status, created_by,
       template, subject, recipient)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ${once ? "ON CONFLICT (reservation_id, template) WHERE template IN ('confirmation', 'pre_arrival', 'post_stay_survey') DO NOTHING" : ""}
     RETURNING id`,
    [
      id,
      op.orgId,
      op.property.id,
      m.reservationId,
      m.channel,
      m.direction,
      m.body,
      status,
      op.userId,
      m.template ?? null,
      m.subject ?? null,
      m.recipient ?? null,
    ],
  );
  if (!r) return null;
  if (m.direction === "outbound" && m.template && m.recipient && m.channel !== "web") {
    const channel = m.channel;
    let to: string | null = null;
    try {
      to = normaliseAddress(channel, m.recipient);
    } catch {
      await t.run("UPDATE hotel_messages SET status = $2 WHERE id = $1", [
        id,
        `Not handed to the outbox — ${m.recipient} is not a usable ${channel} address`,
      ]);
    }
    if (to) {
      const n = await d.core.notifications.record(t, {
        orgId: op.orgId,
        channel,
        to,
        category: "transactional",
        subject: m.subject ?? "",
        body: m.body,
        source: "hotel",
        sourceRef: once ? `${m.template}:${m.reservationId}` : `hotel-message:${id}`,
        createdBy: op.userId,
      });
      await t.run("UPDATE hotel_messages SET status = $2, notification_id = $3 WHERE id = $1", [
        id,
        `Outbox: ${n.status} — ${n.statusNote}`,
        n.id,
      ]);
    }
  }
  return id;
}

/**
 * Record a templated message to the guest of a reservation: e-mail when the guest has an address, else WhatsApp to
 * their phone. Returns null when the guest has neither (nothing to record) or the automatic message exists already.
 */
export async function messageGuest(
  t: Db,
  d: Deps,
  op: Op,
  template: TemplateKey,
  reservationId: string,
  extra: Record<string, string | number> = {},
): Promise<string | null> {
  const g = await t.row<{
    name: string;
    email: string | null;
    phone: string | null;
    language: string;
    number: string;
    arrival: string;
    departure: string;
  }>(
    `SELECT g.name, g.email, g.phone, g.language, r.number, r.arrival, r.departure
     FROM hotel_reservations r JOIN hotel_guests g ON g.id = r.guest_id WHERE r.id = $1`,
    [reservationId],
  );
  if (!g || (!g.email && !g.phone)) return null;
  const tpl = await templateFor(t, op.property.id, template, g.language);
  const vars = {
    guest: g.name,
    hotel: op.property.name,
    number: g.number,
    arrival: g.arrival,
    departure: g.departure,
    ...extra,
  };
  return recordMessage(t, d, op, {
    reservationId,
    channel: g.email ? "email" : "whatsapp",
    direction: "outbound",
    template,
    subject: fill(tpl.subject, vars),
    body: fill(tpl.body, vars),
    recipient: g.email ?? g.phone,
  });
}

/** E-mail addresses of the hotel's managers (general, front office, financial) who work at this hotel. */
export async function managerEmails(t: Db, orgId: string, propertyId: string): Promise<string[]> {
  const rows = await t.rows<{ email: string }>(
    `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1 AND m.status = 'active' AND u.active
       AND m.role IN ('general_manager', 'front_office_manager', 'financial_controller')
       AND EXISTS (SELECT 1 FROM hotel_property_staff ps WHERE ps.property_id = $2 AND ps.user_id = m.user_id)
     ORDER BY u.email`,
    [orgId, propertyId],
  );
  return rows.map((r) => r.email);
}

/** Record a templated message to each of the hotel's managers. Returns how many were recorded. */
export async function messageManagers(
  t: Db,
  d: Deps,
  op: Op,
  template: TemplateKey,
  vars: Record<string, string | number>,
  reservationId: string | null = null,
): Promise<number> {
  const to = await managerEmails(t, op.orgId, op.property.id);
  const tpl = await templateFor(t, op.property.id, template, "en");
  const all = { hotel: op.property.name, ...vars };
  for (const email of to)
    await recordMessage(t, d, op, {
      reservationId,
      channel: "email",
      direction: "outbound",
      template,
      subject: fill(tpl.subject, all),
      body: fill(tpl.body, all),
      recipient: email,
    });
  return to.length;
}
