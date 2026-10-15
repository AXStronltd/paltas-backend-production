// The ONE contact store of an organisation (core, shared by every product): tenants, owners, prospects, suppliers,
// guarantors. Products link their records to a contact by id; nobody keeps a second list of people.
//
// Rules the server enforces:
// - duplicates are found by email (case-insensitive) and phone (last 9 digits); creating a duplicate is refused
//   unless the caller asks to reuse the existing contact;
// - merging never deletes: every record that pointed at the merged contact (in any product) moves to the one kept,
//   and the merged contact keeps a pointer to it;
// - consent is kept per channel; a message on a channel without consent is recorded as blocked;
// - messages are RECORDED here, never sent: outgoing e-mail, SMS and WhatsApp are handed to the notifications outbox
//   (core/notifications), the only place that talks to delivery providers.
import { z } from "zod";
import { Email, IsoDateTime, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";

const Id = z.string().min(1).max(80);
const Name = z.string().trim().min(2).max(160);
const Text = z.string().trim().max(2000);
const Phone = z
  .string()
  .trim()
  .regex(/^\+?[\d\s().-]{7,20}$/, "Phone number looks wrong");

export const CONTACT_TYPES = ["tenant", "owner", "supplier", "prospect", "guarantor", "other"] as const;
export const ContactType = z.enum(CONTACT_TYPES);
export type ContactType = z.infer<typeof ContactType>;

export const CHANNELS = ["email", "sms", "whatsapp", "inapp"] as const;
export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

export const Consent = z.object({
  email: z.boolean(),
  sms: z.boolean(),
  whatsapp: z.boolean(),
  inapp: z.boolean(),
  marketing: z.boolean(),
  source: z.string(),
  at: IsoDateTime.nullable(),
});
export type Consent = z.infer<typeof Consent>;

export const Contact = z.object({
  id: z.string(),
  name: z.string(),
  partyType: z.enum(["individual", "company"]),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  types: z.array(ContactType),
  tags: z.array(z.string()),
  taxId: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string(),
  consent: Consent,
  /** A portal sign-in (tenant or owner) linked to this contact. */
  userId: z.string().nullable(),
  mergedInto: z.string().nullable(),
  /** Set when the record came from a data migration. */
  source: z.object({ system: z.string(), recordId: z.string() }).nullable(),
  createdAt: IsoDateTime,
});
export type Contact = z.infer<typeof Contact>;

export const ACTIVITY_KINDS = [
  "note",
  "call",
  "meeting",
  "email",
  "enquiry",
  "stage",
  "viewing",
  "application",
  "lease",
  "maintenance",
  "payment",
  "message",
  "system",
] as const;
export const Activity = z.object({
  id: z.string(),
  contactId: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  text: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  at: IsoDateTime,
  by: z.string().nullable(),
});
export type Activity = z.infer<typeof Activity>;

export const MESSAGE_STATUSES = ["recorded", "blocked", "received", "internal"] as const;
export const Message = z.object({
  id: z.string(),
  contactId: z.string(),
  channel: z.enum(["email", "sms", "whatsapp", "inapp", "note"]),
  direction: z.enum(["out", "in"]),
  subject: z.string(),
  body: z.string(),
  /** recorded = kept in PALTAS, NOT sent (no delivery provider is connected); blocked = no consent for that channel. */
  status: z.enum(MESSAGE_STATUSES),
  reason: z.string(),
  marketing: z.boolean(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  /** E-mail, SMS and WhatsApp go on to the notifications outbox, which alone hands messages to providers. */
  outboxId: z.string().nullable(),
  at: IsoDateTime,
  by: z.string().nullable(),
});
export type Message = z.infer<typeof Message>;

const ConsentInput = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  inapp: z.boolean().optional(),
  marketing: z.boolean().optional(),
  /** Where the consent was given (form, signed lease, call …). */
  source: z.string().trim().min(2).max(200).optional(),
});

const ContactFields = z.object({
  name: Name,
  partyType: z.enum(["individual", "company"]).default("individual"),
  email: Email.optional(),
  phone: Phone.optional(),
  types: z.array(ContactType).max(6).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  taxId: z.string().trim().max(60).optional(),
  address: Text.optional(),
  notes: Text.optional(),
  consent: ConsentInput.optional(),
});

const Base = "/api/v1/orgs/:orgId/contacts";
const ContactParams = OrgParams.extend({ contactId: Id });

export const listContacts = endpoint({
  id: "contacts.list",
  method: "GET",
  path: Base,
  auth: "user",
  summary: "The organisation's contacts (merged records hidden unless asked for)",
  params: OrgParams,
  query: z.object({
    q: z.string().trim().max(120).optional(),
    type: ContactType.optional(),
    includeMerged: z.enum(["true", "false"]).optional(),
  }),
  response: z.object({ contacts: z.array(Contact) }),
});

export const createContact = endpoint({
  id: "contacts.create",
  method: "POST",
  path: Base,
  auth: "user",
  summary:
    "Add a contact. A contact with the same email or phone is a duplicate: refused (409, with the matches) unless reuseExisting, which adds the types to the existing contact instead.",
  params: OrgParams,
  body: ContactFields.extend({ reuseExisting: z.boolean().default(false) }),
  response: z.object({ contact: Contact, reused: z.boolean() }),
  status: 201,
});

export const getContact = endpoint({
  id: "contacts.get",
  method: "GET",
  path: `${Base}/:contactId`,
  auth: "user",
  summary: "One contact with its activity and recorded messages",
  params: ContactParams,
  response: z.object({ contact: Contact, activities: z.array(Activity), messages: z.array(Message) }),
});

export const updateContact = endpoint({
  id: "contacts.update",
  method: "PUT",
  path: `${Base}/:contactId`,
  auth: "user",
  summary: "Change a contact's details, types, tags or consent (a change of email or phone is checked for duplicates)",
  params: ContactParams,
  body: ContactFields.partial().extend({
    /** Link a portal sign-in: the person must be a member of the organisation with the tenant or owner role. */
    userId: Id.nullable().optional(),
  }),
  response: Contact,
});

export const listDuplicates = endpoint({
  id: "contacts.duplicates",
  method: "GET",
  path: `${Base}/duplicates`,
  auth: "user",
  summary: "Groups of contacts that share an email or phone number",
  params: OrgParams,
  response: z.object({ groups: z.array(z.array(Contact)) }),
});

export const mergeContacts = endpoint({
  id: "contacts.merge",
  method: "POST",
  path: `${Base}/:contactId/merge`,
  auth: "user",
  summary:
    "Merge another contact into this one. Every record in every product that pointed at it moves here; nothing is deleted; consent becomes the stricter of the two.",
  params: ContactParams,
  body: z.object({ mergeId: Id, reason: Reason }),
  response: z.object({ contact: Contact, moved: z.number().int() }),
});

export const addActivity = endpoint({
  id: "contacts.activities.add",
  method: "POST",
  path: `${Base}/:contactId/activities`,
  auth: "user",
  summary: "Log a note, call, meeting or e-mail with a contact",
  params: ContactParams,
  body: z.object({ kind: z.enum(["note", "call", "meeting", "email"]), text: z.string().trim().min(2).max(2000) }),
  response: Activity,
  status: 201,
});

export const recordMessage = endpoint({
  id: "contacts.messages.record",
  method: "POST",
  path: `${Base}/:contactId/messages`,
  auth: "user",
  summary:
    "Record a message to (or from) a contact. It is NOT sent: no delivery provider is connected. Without consent for the channel (or for marketing) it is recorded as blocked.",
  params: ContactParams,
  body: z.object({
    channel: Channel,
    direction: z.enum(["out", "in"]).default("out"),
    subject: z.string().trim().max(200).default(""),
    body: z.string().trim().min(1).max(5000),
    marketing: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(4).max(120).optional(),
  }),
  response: Message,
  status: 201,
});
