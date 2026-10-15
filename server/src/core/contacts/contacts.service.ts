/*
 * The organisation's ONE contact store, used by every product (core.contacts). Products link their records to a
 * contact id; nobody keeps a second list of people.
 *
 *   findOrCreate   dedupe by email (case-insensitive) or phone (last 9 digits): reuse, never duplicate
 *   merge          every record in every table that points at the merged contact moves to the one kept (found from
 *                  the database's own foreign keys, so products added later are covered); nothing is deleted
 *   consent        per channel; recordMessage logs a message as "recorded" or "blocked" (no consent for the
 *                  channel or for marketing, or no address). A recorded e-mail / SMS / WhatsApp is handed to the one
 *                  notifications outbox (core/notifications), the only place that talks to delivery providers — it
 *                  is never "sent" from here.
 */
import type { contacts as C, Role } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { ApiError, fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import type { OrgScope } from "../access/org-access.js";
import { recordAudit, type Actor } from "../audit/audit.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import * as repo from "./contacts.repo.js";

export interface ContactInput {
  name: string;
  partyType?: "individual" | "company" | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  types?: C.ContactType[] | undefined;
  tags?: string[] | undefined;
  taxId?: string | null | undefined;
  address?: string | null | undefined;
  notes?: string | undefined;
  consent?:
    | {
        email?: boolean | undefined;
        sms?: boolean | undefined;
        whatsapp?: boolean | undefined;
        inapp?: boolean | undefined;
        marketing?: boolean | undefined;
        source?: string | undefined;
      }
    | undefined;
}

export interface ActivityInput {
  orgId: string;
  contactId: string;
  kind: C.Activity["kind"];
  text: string;
  refType?: string | null;
  refId?: string | null;
  by: string | null;
}

export interface MessageInput {
  orgId: string;
  contactId: string;
  channel: C.Channel | "note";
  direction?: "out" | "in";
  subject?: string;
  body: string;
  marketing?: boolean;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey?: string | null;
  by: string | null;
}

/** Roles a contact's portal sign-in may have. */
const PORTAL_ROLES: readonly Role[] = ["tenant", "owner"];

const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function contactsService(ctx: AppContext, deps: { notifications: NotificationsService }) {
  const { db } = ctx;

  async function load(t: Db, orgId: string, id: string): Promise<repo.ContactRow> {
    const c = await repo.contactById(t, orgId, id);
    if (!c) throw fail.notFound("Contact not found");
    return c;
  }

  /** A contact that may be worked with: exists in this organisation and was not merged away. */
  async function live(t: Db, orgId: string, id: string, lock = false): Promise<repo.ContactRow> {
    const c = await repo.contactById(t, orgId, id, lock);
    if (!c) throw fail.notFound("Contact not found");
    if (c.merged_into) throw fail.conflict(`This contact was merged into ${c.merged_into} — use that one`);
    return c;
  }

  async function insert(t: Db, orgId: string, input: ContactInput, by: string | null): Promise<repo.ContactRow> {
    const id = newId("con");
    const consentGiven = !!input.consent && Object.values(input.consent).some((v) => v === true);
    await t.run(
      `INSERT INTO contacts (id, org_id, name, party_type, email, phone, types, tags, tax_id, address, notes,
         consent_email, consent_sms, consent_whatsapp, consent_inapp, consent_marketing, consent_source, consent_at,
         created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        id,
        orgId,
        input.name.trim(),
        input.partyType ?? "individual",
        input.email ?? null,
        input.phone ?? null,
        uniq(input.types ?? []),
        uniq(input.tags ?? []),
        input.taxId ?? null,
        input.address ?? null,
        input.notes ?? "",
        input.consent?.email ?? false,
        input.consent?.sms ?? false,
        input.consent?.whatsapp ?? false,
        input.consent?.inapp ?? true,
        input.consent?.marketing ?? false,
        input.consent?.source ?? "",
        consentGiven ? new Date().toISOString() : null,
        by,
      ],
    );
    return load(t, orgId, id);
  }

  async function addTypes(t: Db, orgId: string, id: string, types: C.ContactType[]): Promise<void> {
    if (!types.length) return;
    await t.run(
      `UPDATE contacts SET types = ARRAY(SELECT DISTINCT unnest(types || $3::text[]) ORDER BY 1), updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [orgId, id, types],
    );
  }

  async function activity(t: Db, a: ActivityInput): Promise<C.Activity> {
    const id = newId("act");
    const r = await t.row<repo.ActivityRow>(
      `INSERT INTO contact_activities (id, org_id, contact_id, kind, text, ref_type, ref_id, by_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, a.orgId, a.contactId, a.kind, a.text, a.refType ?? null, a.refId ?? null, a.by],
    );
    return repo.toActivity(r as repo.ActivityRow);
  }

  /**
   * Record a message. It is never sent: no delivery provider is connected. Outgoing messages without consent for the
   * channel (or for marketing) are recorded as blocked, with the reason. The same idempotency key records once.
   */
  async function recordMessage(t: Db, m: MessageInput): Promise<C.Message> {
    if (m.idempotencyKey) {
      const existing = await t.row<repo.MessageRow>(
        "SELECT * FROM contact_messages WHERE org_id = $1 AND idempotency_key = $2",
        [m.orgId, m.idempotencyKey],
      );
      if (existing) return repo.toMessage(existing);
    }
    const c = await live(t, m.orgId, m.contactId);
    const direction = m.direction ?? "out";
    let status: C.Message["status"] = "recorded";
    let reason = "Recorded in PALTAS — not sent";
    if (m.channel === "note") {
      status = "internal";
      reason = "";
    } else if (direction === "in") {
      status = "received";
      reason = "";
    } else {
      const consent = {
        email: c.consent_email,
        sms: c.consent_sms,
        whatsapp: c.consent_whatsapp,
        inapp: c.consent_inapp,
      }[m.channel];
      if (m.channel === "email" && !c.email_norm) {
        status = "blocked";
        reason = "The contact has no email address";
      } else if ((m.channel === "sms" || m.channel === "whatsapp") && !c.phone_norm) {
        status = "blocked";
        reason = "The contact has no phone number";
      } else if (!consent) {
        status = "blocked";
        reason = `No consent to contact by ${m.channel}`;
      } else if (m.marketing && !c.consent_marketing) {
        status = "blocked";
        reason = "No marketing consent";
      }
    }
    const id = newId("msg");
    let outboxId: string | null = null;
    if (status === "recorded" && (m.channel === "email" || m.channel === "sms" || m.channel === "whatsapp")) {
      try {
        const n = await deps.notifications.record(t, {
          orgId: m.orgId,
          channel: m.channel,
          to: (m.channel === "email" ? c.email : c.phone) as string,
          category: m.marketing ? "marketing" : "transactional",
          subject: m.subject ?? "",
          body: m.body,
          source: "contacts",
          sourceRef: id,
          createdBy: m.by,
        });
        outboxId = n.id;
        reason = `Handed to the notifications outbox (${n.status}) — not sent until a connected provider confirms it`;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        reason = `Recorded only — the notifications outbox refused it: ${e.message}`;
      }
    }
    const r = await t.row<repo.MessageRow>(
      `INSERT INTO contact_messages (id, org_id, contact_id, channel, direction, subject, body, status, reason, marketing,
         ref_type, ref_id, idempotency_key, outbox_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        id,
        m.orgId,
        c.id,
        m.channel,
        direction,
        m.subject ?? "",
        m.body,
        status,
        reason,
        !!m.marketing,
        m.refType ?? null,
        m.refId ?? null,
        m.idempotencyKey ?? null,
        outboxId,
        m.by,
      ],
    );
    return repo.toMessage(r as repo.MessageRow);
  }

  /**
   * Find the contact by email or phone, or add it. A found contact gains the given types and any missing email or
   * phone; consent only grows when the person gave it now. Never creates a duplicate.
   */
  async function findOrCreate(
    t: Db,
    orgId: string,
    input: ContactInput,
    actor: Actor,
  ): Promise<{ contact: repo.ContactRow; reused: boolean }> {
    if (!input.email && !input.phone) throw fail.invalid("Give an email or a phone number for the contact");
    const [found] = await repo.duplicatesOf(t, orgId, input.email ?? null, input.phone ?? null);
    if (!found) {
      const contact = await insert(t, orgId, input, actor.userId);
      await recordAudit(t, { actor, orgId, action: "Contact added", target: contact.id, detail: contact.name });
      return { contact, reused: false };
    }
    await addTypes(t, orgId, found.id, input.types ?? []);
    await t.run(
      `UPDATE contacts SET email = COALESCE(email, $3), phone = COALESCE(phone, $4),
         consent_email = consent_email OR $5, consent_sms = consent_sms OR $6, consent_marketing = consent_marketing OR $7,
         updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [
        orgId,
        found.id,
        input.email ?? null,
        input.phone ?? null,
        input.consent?.email === true,
        input.consent?.sms === true,
        input.consent?.marketing === true,
      ],
    );
    return { contact: await load(t, orgId, found.id), reused: true };
  }

  async function assertPortalUser(t: Db, orgId: string, userId: string): Promise<void> {
    const m = await t.row<{ role: Role; status: string }>(
      "SELECT role, status FROM memberships WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
    );
    if (!m || m.status !== "active") throw fail.invalid("That person is not a member of this organisation");
    if (!PORTAL_ROLES.includes(m.role))
      throw fail.invalid("Only a member with the tenant or owner role can be linked to a contact");
  }

  return {
    live,
    findOrCreate,
    addTypes,
    activity,
    recordMessage,

    /** A contact as the API shows it (404 for another organisation's contact). */
    async get(orgId: string, id: string, t: Db = db): Promise<C.Contact> {
      return repo.toContact(await load(t, orgId, id));
    },

    /** The contact a signed-in portal user is linked to. */
    async ofUser(orgId: string, userId: string): Promise<repo.ContactRow | null> {
      return db.row<repo.ContactRow>(
        "SELECT * FROM contacts WHERE org_id = $1 AND user_id = $2 AND merged_into IS NULL",
        [orgId, userId],
      );
    },

    async list(orgId: string, f: { q?: string | undefined; type?: C.ContactType | undefined; includeMerged: boolean }) {
      const rows = await db.rows<repo.ContactRow>(
        `SELECT * FROM contacts WHERE org_id = $1 AND ($2 OR merged_into IS NULL)
           AND ($3::text IS NULL OR $3 = ANY (types))
           AND ($4::text IS NULL OR lower(name) LIKE '%' || lower($4) || '%' OR email_norm LIKE '%' || lower($4) || '%'
                OR phone LIKE '%' || $4 || '%')
         ORDER BY lower(name), id LIMIT 1000`,
        [orgId, f.includeMerged, f.type ?? null, f.q ?? null],
      );
      return rows.map(repo.toContact);
    },

    async create(s: OrgScope, input: ContactInput & { reuseExisting: boolean }) {
      return db.tx(async (t) => {
        if (input.email || input.phone) {
          const dups = await repo.duplicatesOf(t, s.orgId, input.email ?? null, input.phone ?? null);
          if (dups.length && !input.reuseExisting)
            throw fail.conflict("A contact with the same email or phone already exists", {
              duplicates: dups.map((d) => ({ id: d.id, name: d.name, email: d.email, phone: d.phone })),
            });
          if (dups.length) {
            const r = await findOrCreate(t, s.orgId, input, s.actor);
            return { contact: repo.toContact(r.contact), reused: true };
          }
        }
        const c = await insert(t, s.orgId, input, s.userId);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Contact added", target: c.id, detail: c.name });
        return { contact: repo.toContact(c), reused: false };
      });
    },

    async update(s: OrgScope, id: string, input: Partial<ContactInput> & { userId?: string | null | undefined }) {
      return db.tx(async (t) => {
        const before = await live(t, s.orgId, id, true);
        const email = input.email === undefined ? before.email : input.email;
        const phone = input.phone === undefined ? before.phone : input.phone;
        if (input.email !== undefined || input.phone !== undefined) {
          const dups = await repo.duplicatesOf(t, s.orgId, email, phone, id);
          if (dups.length)
            throw fail.conflict("Another contact has the same email or phone — merge them instead", {
              duplicates: dups.map((d) => ({ id: d.id, name: d.name })),
            });
        }
        if (input.userId) await assertPortalUser(t, s.orgId, input.userId);
        const c = input.consent;
        const consentChanged = !!c && Object.keys(c).length > 0;
        await t.run(
          `UPDATE contacts SET name = $3, party_type = $4, email = $5, phone = $6, types = $7, tags = $8, tax_id = $9,
             address = $10, notes = $11, consent_email = $12, consent_sms = $13, consent_whatsapp = $14,
             consent_inapp = $15, consent_marketing = $16, consent_source = $17,
             consent_at = CASE WHEN $18 THEN now() ELSE consent_at END, user_id = $19, updated_at = now()
           WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            id,
            input.name?.trim() ?? before.name,
            input.partyType ?? before.party_type,
            email ?? null,
            phone ?? null,
            input.types ? uniq(input.types) : before.types,
            input.tags ? uniq(input.tags) : before.tags,
            input.taxId === undefined ? before.tax_id : input.taxId,
            input.address === undefined ? before.address : input.address,
            input.notes ?? before.notes,
            c?.email ?? before.consent_email,
            c?.sms ?? before.consent_sms,
            c?.whatsapp ?? before.consent_whatsapp,
            c?.inapp ?? before.consent_inapp,
            c?.marketing ?? before.consent_marketing,
            c?.source ?? (consentChanged ? "Changed by staff" : before.consent_source),
            consentChanged,
            input.userId === undefined ? before.user_id : input.userId,
          ],
        );
        const after = await load(t, s.orgId, id);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Contact changed",
          target: id,
          before: repo.toContact(before),
          after: repo.toContact(after),
        });
        return repo.toContact(after);
      });
    },

    async duplicates(orgId: string): Promise<C.Contact[][]> {
      const rows = await db.rows<repo.ContactRow>(
        "SELECT * FROM contacts WHERE org_id = $1 AND merged_into IS NULL ORDER BY created_at, id",
        [orgId],
      );
      const seen = new Set<string>();
      const groups: C.Contact[][] = [];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        // transitive: contacts linked by email or by phone end up in one group
        const group = [r];
        for (let i = 0; i < group.length; i++) {
          const g = group[i] as repo.ContactRow;
          for (const x of rows)
            if (
              !seen.has(x.id) &&
              !group.includes(x) &&
              ((g.email_norm && x.email_norm === g.email_norm) || (g.phone_norm && x.phone_norm === g.phone_norm))
            )
              group.push(x);
        }
        if (group.length > 1) {
          group.forEach((x) => seen.add(x.id));
          groups.push(group.map(repo.toContact));
        }
      }
      return groups;
    },

    /**
     * Merge `mergeId` into `keepId`. Every row in any table whose foreign key points at the merged contact moves to the
     * one kept; the merged contact stays (pointing at the one kept); consent becomes the stricter of the two.
     */
    async merge(s: OrgScope, keepId: string, mergeId: string, reason: string) {
      if (keepId === mergeId) throw fail.invalid("Pick two different contacts");
      return db.tx(async (t) => {
        const [first, second] = [keepId, mergeId].sort();
        await live(t, s.orgId, first as string, true);
        await live(t, s.orgId, second as string, true);
        const keep = await load(t, s.orgId, keepId);
        const drop = await load(t, s.orgId, mergeId);
        if (keep.user_id && drop.user_id && keep.user_id !== drop.user_id)
          throw fail.conflict("Both contacts are linked to different portal sign-ins — unlink one first");
        const refs = await t.rows<{ tbl: string; col: string }>(
          `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
           FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
           WHERE c.contype = 'f' AND c.confrelid = 'contacts'::regclass
           ORDER BY 1, 2`,
        );
        let moved = 0;
        for (const r of refs) {
          if (r.tbl === "contacts") continue;
          if (!/^[a-z_][a-z0-9_]*$/.test(r.tbl) || !/^[a-z_][a-z0-9_]*$/.test(r.col)) continue;
          await t.run("SAVEPOINT contact_merge");
          try {
            moved += await t.run(`UPDATE ${r.tbl} SET ${r.col} = $1 WHERE ${r.col} = $2`, [keepId, mergeId]);
            await t.run("RELEASE SAVEPOINT contact_merge");
          } catch (e) {
            await t.run("ROLLBACK TO SAVEPOINT contact_merge");
            if ((e as { code?: string }).code === "23505" || (e as { code?: string }).code === "23P01")
              throw fail.conflict(
                `Both contacts have a record in ${r.tbl} that can exist only once — resolve it before merging`,
              );
            throw e;
          }
        }
        const userId = keep.user_id ?? drop.user_id;
        await t.run("UPDATE contacts SET user_id = NULL WHERE id = $1", [mergeId]);
        await t.run(
          `UPDATE contacts SET
             types = ARRAY(SELECT DISTINCT unnest(types || $3::text[]) ORDER BY 1),
             tags = ARRAY(SELECT DISTINCT unnest(tags || $4::text[]) ORDER BY 1),
             email = COALESCE(email, $5), phone = COALESCE(phone, $6), tax_id = COALESCE(tax_id, $7),
             address = COALESCE(address, $8), user_id = $9,
             consent_email = consent_email AND $10, consent_sms = consent_sms AND $11,
             consent_whatsapp = consent_whatsapp AND $12, consent_inapp = consent_inapp AND $13,
             consent_marketing = consent_marketing AND $14, updated_at = now()
           WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            keepId,
            drop.types,
            drop.tags,
            drop.email,
            drop.phone,
            drop.tax_id,
            drop.address,
            userId,
            drop.consent_email,
            drop.consent_sms,
            drop.consent_whatsapp,
            drop.consent_inapp,
            drop.consent_marketing,
          ],
        );
        await t.run(
          "UPDATE contacts SET merged_into = $2, merged_at = now(), merged_by = $3, updated_at = now() WHERE id = $1",
          [mergeId, keepId, s.userId],
        );
        // contacts that were merged into the merged one now point at the one kept
        await t.run("UPDATE contacts SET merged_into = $1 WHERE org_id = $2 AND merged_into = $3 AND id <> $1", [
          keepId,
          s.orgId,
          mergeId,
        ]);
        await activity(t, {
          orgId: s.orgId,
          contactId: keepId,
          kind: "system",
          text: `Merged ${mergeId} (${drop.name}) into this contact · ${moved} linked record(s) moved · nothing deleted`,
          by: s.userId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Contacts merged",
          target: keepId,
          detail: `${mergeId} → ${keepId} · ${moved} record(s) moved · ${reason}`,
        });
        return { contact: repo.toContact(await load(t, s.orgId, keepId)), moved };
      });
    },

    async detail(orgId: string, id: string) {
      const c = await load(db, orgId, id);
      const activities = await db.rows<repo.ActivityRow>(
        "SELECT * FROM contact_activities WHERE org_id = $1 AND contact_id = $2 ORDER BY at DESC, id DESC LIMIT 500",
        [orgId, id],
      );
      const messages = await db.rows<repo.MessageRow>(
        "SELECT * FROM contact_messages WHERE org_id = $1 AND contact_id = $2 ORDER BY at DESC, id DESC LIMIT 500",
        [orgId, id],
      );
      return {
        contact: repo.toContact(c),
        activities: activities.map(repo.toActivity),
        messages: messages.map(repo.toMessage),
      };
    },
  };
}

export type ContactsService = ReturnType<typeof contactsService>;
