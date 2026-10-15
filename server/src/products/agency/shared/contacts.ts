/*
 * The agency's people live in the organisation's ONE contact store (core.contacts): enquirers, buyers and guests
 * are prospects, sellers, landlords and stay owners are owners; the agency role is kept as a tag. A person is found
 * by e-mail or phone, never duplicated. Personal data never leaves through a public endpoint.
 */
import type { Actor } from "../../../core/audit/audit.service.js";
import type { ContactRow } from "../../../core/contacts/contacts.repo.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { Db } from "../../../db/database.js";

export interface Person {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
}

/** What the person is to the agency. */
export type AgencyRole = "enquirer" | "buyer" | "guest" | "seller" | "landlord" | "owner";

const TYPE = {
  enquirer: "prospect",
  buyer: "prospect",
  guest: "prospect",
  seller: "owner",
  landlord: "owner",
  owner: "owner",
} as const;

export const contactRef = (r: { id: string; name: string; email: string | null; phone: string | null }) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
});

/**
 * Find the person in the organisation's contacts (by e-mail or phone) or add them. They gain the agency role as a
 * type and a tag; consent only grows: replies by the channel they gave, marketing only when they asked for it.
 */
export async function linkContact(
  core: CoreServices,
  t: Db,
  o: { orgId: string; person: Person; as: AgencyRole; marketing?: boolean; source: string; actor: Actor },
): Promise<ContactRow> {
  const { contact } = await core.contacts.findOrCreate(
    t,
    o.orgId,
    {
      name: o.person.name,
      email: o.person.email ?? null,
      phone: o.person.phone ?? null,
      types: [TYPE[o.as]],
      tags: [o.as],
      consent: { email: !!o.person.email, sms: !!o.person.phone, marketing: !!o.marketing, source: o.source },
    },
    o.actor,
  );
  await tag(t, o.orgId, contact.id, o.as);
  return contact;
}

/** Give an existing contact an agency role (e.g. the client of a commission agreement). */
export async function tag(t: Db, orgId: string, contactId: string, as: AgencyRole): Promise<void> {
  await t.run(
    `UPDATE contacts SET tags = ARRAY(SELECT DISTINCT unnest(tags || $3::text[]) ORDER BY 1),
       types = ARRAY(SELECT DISTINCT unnest(types || $4::text[]) ORDER BY 1), updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, contactId, [as], [TYPE[as]]],
  );
}

/** A live contact of this organisation, or 404 (another organisation's contact looks like none). */
export function findContact(core: CoreServices, t: Db, orgId: string, id: string): Promise<ContactRow> {
  return core.contacts.live(t, orgId, id);
}

/** Note something on the contact's timeline (shared with every product). */
export async function noteOnContact(
  core: CoreServices,
  t: Db,
  a: {
    orgId: string;
    contactId: string;
    kind: "enquiry" | "viewing" | "stage" | "payment" | "system";
    text: string;
    refType: string;
    refId: string;
    by: string | null;
  },
): Promise<void> {
  await core.contacts.activity(t, a);
}
