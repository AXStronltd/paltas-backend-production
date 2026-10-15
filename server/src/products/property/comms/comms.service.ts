/*
 * Notices to the tenants of a property and document records. A notice records one message per tenant on the contact
 * store (core.contacts.recordMessage): "recorded" and handed to the notifications outbox, or "blocked" without consent
 * for the channel — never "sent" from here. Documents are metadata (name, type, file name, size, checksum, what they
 * belong to, who may see them); the files themselves stay where they were uploaded.
 */
import type { contacts as C, property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import * as R from "../shared/records.js";

interface NoticeRow {
  id: string;
  property_id: string;
  title: string;
  body: string;
  channel: "email" | "sms" | "whatsapp" | "inapp";
  recipients: number;
  recorded: number;
  blocked: number;
  published_at: string;
}

interface DocumentRow {
  id: string;
  name: string | null;
  doc_type: string;
  link_entity: string | null;
  link_id: string | null;
  filename: string;
  size_bytes: number | null;
  sha256: string | null;
  visibility: "staff" | "tenant" | "owner";
  created_at: string;
}

const toNotice = (r: NoticeRow) => ({
  id: r.id,
  propertyId: r.property_id,
  title: r.title,
  body: r.body,
  channel: r.channel,
  recipients: r.recipients,
  recorded: r.recorded,
  blocked: r.blocked,
  publishedAt: r.published_at,
});

export const toDocument = (r: DocumentRow) => ({
  id: r.id,
  name: r.name ?? r.filename,
  docType: r.doc_type,
  linkEntity: r.link_entity,
  linkId: r.link_id,
  filename: r.filename,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  visibility: r.visibility,
  createdAt: r.created_at,
});

/** The table each document link points at (the record must exist in the organisation). */
const LINK_TABLE: Record<(typeof P.DOCUMENT_LINKS)[number], string> = {
  property: "pm_properties",
  unit: "pm_units",
  lease: "pm_leases",
  contact: "contacts",
  work_order: "pm_work_orders",
  inspection: "pm_inspections",
  bill: "pm_bills",
};

export function commsService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  return {
    async publishNotice(
      s: OrgScope,
      b: { propertyId: string; title: string; body: string; channel: NoticeRow["channel"] },
    ) {
      const p = await R.propertyRow(db, s.orgId, b.propertyId);
      return db.tx(async (t) => {
        const tenants = await t.rows<{ tenant_id: string }>(
          `SELECT DISTINCT tenant_id FROM pm_leases WHERE org_id = $1 AND property_id = $2 AND status = 'active'
             AND (end_date IS NULL OR end_date >= $3) ORDER BY tenant_id`,
          [s.orgId, b.propertyId, s.today],
        );
        const id = newId("pnt");
        const messages: C.Message[] = [];
        for (const x of tenants)
          messages.push(
            await core.contacts.recordMessage(t, {
              orgId: s.orgId,
              contactId: x.tenant_id,
              channel: b.channel,
              subject: b.title,
              body: b.body,
              refType: "notice",
              refId: id,
              idempotencyKey: `notice:${id}:${x.tenant_id}`,
              by: s.userId,
            }),
          );
        const blocked = messages.filter((m) => m.status === "blocked").length;
        const row = await t.row<NoticeRow>(
          `INSERT INTO pm_notices (id, org_id, property_id, title, body, channel, recipients, recorded, blocked, published_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            id,
            s.orgId,
            b.propertyId,
            b.title,
            b.body,
            b.channel,
            messages.length,
            messages.length - blocked,
            blocked,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Notice published (recorded, not sent)",
          target: id,
          detail: `${p.name} · ${b.title} · ${messages.length} tenant(s), ${blocked} without consent for ${b.channel}`,
        });
        return { notice: toNotice(row as NoticeRow), messages };
      });
    },

    async listNotices(s: OrgScope, propertyId?: string) {
      const rows = await db.rows<NoticeRow>(
        "SELECT * FROM pm_notices WHERE org_id = $1 AND ($2::text IS NULL OR property_id = $2) ORDER BY published_at DESC",
        [s.orgId, propertyId ?? null],
      );
      return { notices: rows.map(toNotice) };
    },

    async addDocument(
      s: OrgScope,
      b: {
        name: string;
        docType: string;
        linkEntity: (typeof P.DOCUMENT_LINKS)[number];
        linkId: string;
        filename: string;
        sizeBytes?: number | undefined;
        sha256?: string | undefined;
        visibility: DocumentRow["visibility"];
      },
    ) {
      return db.tx(async (t) => {
        const exists = await t.row(`SELECT 1 FROM ${LINK_TABLE[b.linkEntity]} WHERE org_id = $1 AND id = $2`, [
          s.orgId,
          b.linkId,
        ]);
        if (!exists) throw fail.notFound(`That ${b.linkEntity.replace("_", " ")} was not found`);
        const row = await t.row<DocumentRow>(
          `INSERT INTO pm_documents (id, org_id, name, doc_type, link_entity, link_id, filename, size_bytes, sha256,
             visibility, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [
            newId("pdc"),
            s.orgId,
            b.name,
            b.docType,
            b.linkEntity,
            b.linkId,
            b.filename,
            b.sizeBytes ?? null,
            b.sha256 ?? null,
            b.visibility,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Document recorded",
          target: (row as DocumentRow).id,
          detail: `${b.name} · ${b.linkEntity} ${b.linkId} · visible to ${b.visibility}`,
        });
        return toDocument(row as DocumentRow);
      });
    },

    async listDocuments(s: OrgScope, f: { linkEntity?: string | undefined; linkId?: string | undefined }) {
      return {
        documents: (
          await documents(
            db,
            s.orgId,
            "($2::text IS NULL OR link_entity = $2) AND ($3::text IS NULL OR link_id = $3)",
            [f.linkEntity ?? null, f.linkId ?? null],
          )
        ).map(toDocument),
      };
    },
  };
}

export function documents(db: Db, orgId: string, where: string, params: unknown[]) {
  return db.rows<DocumentRow>(`SELECT * FROM pm_documents WHERE org_id = $1 AND ${where} ORDER BY created_at DESC`, [
    orgId,
    ...params,
  ]);
}

export type CommsService = ReturnType<typeof commsService>;
