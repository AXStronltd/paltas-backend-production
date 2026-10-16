// SQL for the one contact store (migrations 0007 and 0018): contacts, their activities and recorded messages.
import type { contacts as C } from "@paltas/contracts";
import type { Db } from "../../db/database.js";

export interface ContactRow {
  id: string;
  org_id: string;
  name: string;
  party_type: "individual" | "company";
  email: string | null;
  email_norm: string | null;
  phone: string | null;
  phone_norm: string | null;
  other_phones: string[];
  other_emails: string[];
  types: C.ContactType[];
  tags: string[];
  tax_id: string | null;
  address: string | null;
  notes: string;
  consent_email: boolean;
  consent_sms: boolean;
  consent_whatsapp: boolean;
  consent_inapp: boolean;
  consent_marketing: boolean;
  consent_source: string;
  consent_at: string | null;
  user_id: string | null;
  merged_into: string | null;
  source_system: string | null;
  source_record_id: string | null;
  created_at: string;
}

export interface ActivityRow {
  id: string;
  contact_id: string;
  kind: C.Activity["kind"];
  text: string;
  ref_type: string | null;
  ref_id: string | null;
  at: string;
  by_user: string | null;
}

export interface MessageRow {
  id: string;
  contact_id: string;
  channel: C.Message["channel"];
  direction: "out" | "in";
  subject: string;
  body: string;
  status: C.Message["status"];
  reason: string;
  marketing: boolean;
  ref_type: string | null;
  ref_id: string | null;
  outbox_id: string | null;
  at: string;
  recorded_by: string | null;
}

export const toContact = (r: ContactRow): C.Contact => ({
  id: r.id,
  name: r.name,
  partyType: r.party_type,
  email: r.email,
  phone: r.phone,
  otherPhones: r.other_phones,
  otherEmails: r.other_emails,
  types: r.types,
  tags: r.tags,
  taxId: r.tax_id,
  address: r.address,
  notes: r.notes,
  consent: {
    email: r.consent_email,
    sms: r.consent_sms,
    whatsapp: r.consent_whatsapp,
    inapp: r.consent_inapp,
    marketing: r.consent_marketing,
    source: r.consent_source,
    at: r.consent_at,
  },
  userId: r.user_id,
  mergedInto: r.merged_into,
  source: r.source_system && r.source_record_id ? { system: r.source_system, recordId: r.source_record_id } : null,
  createdAt: r.created_at,
});

export const toActivity = (r: ActivityRow): C.Activity => ({
  id: r.id,
  contactId: r.contact_id,
  kind: r.kind,
  text: r.text,
  refType: r.ref_type,
  refId: r.ref_id,
  at: r.at,
  by: r.by_user,
});

export const toMessage = (r: MessageRow): C.Message => ({
  id: r.id,
  contactId: r.contact_id,
  channel: r.channel,
  direction: r.direction,
  subject: r.subject,
  body: r.body,
  status: r.status,
  reason: r.reason,
  marketing: r.marketing,
  refType: r.ref_type,
  refId: r.ref_id,
  outboxId: r.outbox_id,
  at: r.at,
  by: r.recorded_by,
});

export const contactById = (db: Db, orgId: string, id: string, lock = false) =>
  db.row<ContactRow>(`SELECT * FROM contacts WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [orgId, id]);

/** The same dedupe keys the database generates: lower-case email, last 9 digits of the phone. */
export function normEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e || null;
}

export function normPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d ? d.slice(-9) : null;
}

/** Live (not merged) contacts sharing the email or phone, other than `exceptId`. */
export function duplicatesOf(
  db: Db,
  orgId: string,
  email: string | null,
  phone: string | null,
  exceptId: string | null = null,
) {
  return db.rows<ContactRow>(
    `SELECT * FROM contacts WHERE org_id = $1 AND merged_into IS NULL AND ($4::text IS NULL OR id <> $4)
       AND ((email_norm IS NOT NULL AND email_norm = $2) OR (phone_norm IS NOT NULL AND phone_norm = $3))
     ORDER BY created_at, id`,
    [orgId, normEmail(email), normPhone(phone), exceptId],
  );
}
