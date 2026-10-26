import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { contactScopeSql, contactWithinScope } from "../../../core/access/property-contact-scope.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { leaseRow } from "../shared/records.js";

type Fields = {
  kind: "occupant" | "emergency_contact";
  relationship: string;
  note: string;
  startDate: string | null;
  endDate: string | null;
};
type Row = {
  id: string;
  lease_id: string;
  contact_id: string;
  kind: Fields["kind"];
  relationship: string;
  note: string;
  start_date: string | null;
  end_date: string | null;
  archived: boolean;
  version: number;
  created_at: string;
};
const snapshot = (r: Row) => ({
  id: r.id,
  contactId: r.contact_id,
  kind: r.kind,
  relationship: r.relationship,
  note: r.note,
  startDate: r.start_date,
  endDate: r.end_date,
  archived: r.archived,
  version: r.version,
});
export function leasePeopleService(d: PmDeps) {
  const db = d.core.db;
  async function lease(t: Db, s: OrgScope, id: string, lock = false) {
    const l = await leaseRow(t, s.orgId, id, lock);
    if (s.propertyIds && !s.propertyIds.includes(l.property_id)) throw fail.notFound("Lease not found");
    return l;
  }
  function dates(b: Fields) {
    if (b.startDate && b.endDate && b.endDate < b.startDate)
      throw fail.invalid("The relationship end date is before its start date");
  }
  async function contact(t: Db, s: OrgScope, id: string) {
    if (s.propertyIds && !(await contactWithinScope(t, s.orgId, id, s.propertyIds, s.userId)))
      throw fail.notFound("Contact not found within your assigned properties");
    const c = await t.row<{ id: string }>(
      "SELECT id FROM contacts WHERE org_id=$1 AND id=$2 AND merged_into IS NULL AND party_type='individual' FOR SHARE",
      [s.orgId, id],
    );
    if (!c) throw fail.invalid("Select a current individual contact in this company");
  }
  async function view(t: Db, s: OrgScope, id: string): Promise<P.LeasePerson> {
    const allowed = contactScopeSql("c", "$3", "$4");
    const r = await t.row<
      Row & { contact_name: string; email: string | null; phone: string | null; accessible: boolean }
    >(
      `SELECT p.*,CASE WHEN ${allowed} THEN c.name ELSE 'Contact access restricted' END contact_name,CASE WHEN ${allowed} THEN c.email ELSE NULL END email,CASE WHEN ${allowed} THEN c.phone ELSE NULL END phone,${allowed} accessible FROM pm_lease_people p JOIN contacts c ON c.org_id=p.org_id AND c.id=p.contact_id WHERE p.org_id=$1 AND p.id=$2`,
      [s.orgId, id, s.propertyIds ?? null, s.userId],
    );
    if (!r) throw fail.notFound("Lease person not found");
    return {
      ...snapshot(r),
      leaseId: r.lease_id,
      contactName: r.contact_name,
      email: r.email,
      phone: r.phone,
      contactAccessible: r.accessible,
      createdAt: r.created_at,
    };
  }
  async function duplicate(
    t: Db,
    s: OrgScope,
    leaseId: string,
    contactId: string,
    kind: Fields["kind"],
    except: string | null = null,
  ) {
    if (
      await t.row(
        "SELECT 1 FROM pm_lease_people WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3 AND kind=$4 AND ($5::text IS NULL OR id<>$5)",
        [s.orgId, leaseId, contactId, kind, except],
      )
    )
      throw fail.conflict(
        "This person already has that relationship. Reopen the existing record or restore it from archived people.",
      );
  }
  return {
    async get(s: OrgScope, leaseId: string, id: string) {
      await lease(db, s, leaseId);
      if (
        !(await db.row("SELECT 1 FROM pm_lease_people WHERE org_id=$1 AND lease_id=$2 AND id=$3", [
          s.orgId,
          leaseId,
          id,
        ]))
      )
        throw fail.notFound("Lease person not found");
      return view(db, s, id);
    },
    async list(
      s: OrgScope,
      leaseId: string,
      q: { status: "active" | "archived" | "all"; limit: number; offset: number },
    ) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await lease(t, s, leaseId);
        const where = "org_id=$1 AND lease_id=$2 AND ($3='all' OR archived=($3='archived'))",
          args = [s.orgId, leaseId, q.status];
        const count = await t.row<{ n: number }>(`SELECT count(*)::int n FROM pm_lease_people WHERE ${where}`, args);
        const ids = await t.rows<{ id: string }>(
          `SELECT id FROM pm_lease_people WHERE ${where} ORDER BY archived,created_at,id LIMIT $4 OFFSET $5`,
          [...args, q.limit, q.offset],
        );
        return {
          people: await Promise.all(ids.map((x) => view(t, s, x.id))),
          total: count?.n ?? 0,
          limit: q.limit,
          offset: q.offset,
        };
      });
    },
    async create(s: OrgScope, leaseId: string, b: Fields & { contactId: string }) {
      return db.tx(async (t) => {
        dates(b);
        const l = await lease(t, s, leaseId, true);
        if (!["draft", "active"].includes(l.status))
          throw fail.conflict("Add people only to a draft or active lease. Closed lease history is retained.");
        if (l.tenant_id === b.contactId)
          throw fail.invalid("The primary tenant is already linked to this lease. Select an additional person.");
        await contact(t, s, b.contactId);
        await duplicate(t, s, leaseId, b.contactId, b.kind);
        const n = await t.row<{ n: number }>(
          "SELECT count(*)::int n FROM pm_lease_people WHERE org_id=$1 AND lease_id=$2 AND NOT archived",
          [s.orgId, leaseId],
        );
        if ((n?.n ?? 0) >= 100)
          throw fail.invalid(
            "A lease supports up to 100 active household and emergency contacts. Archive inactive relationships first.",
          );
        const id = newId("plp");
        await t.run(
          "INSERT INTO pm_lease_people(id,org_id,lease_id,contact_id,kind,relationship,note,start_date,end_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [id, s.orgId, leaseId, b.contactId, b.kind, b.relationship, b.note, b.startDate, b.endDate, s.userId],
        );
        const result = await view(t, s, id);
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Lease person added",
          target: leaseId,
          after: { ...b, id },
        });
        return result;
      });
    },
    async update(
      s: OrgScope,
      leaseId: string,
      id: string,
      b: Fields & { expectedVersion: number; archived: boolean; reason: string },
    ) {
      return db.tx(async (t) => {
        dates(b);
        const l = await lease(t, s, leaseId, true);
        const before = await t.row<Row>(
          "SELECT * FROM pm_lease_people WHERE org_id=$1 AND lease_id=$2 AND id=$3 FOR UPDATE",
          [s.orgId, leaseId, id],
        );
        if (!before) throw fail.notFound("Lease person not found");
        if (before.version !== b.expectedVersion)
          throw fail.conflict("This relationship changed. Reopen it before saving.");
        if (before.archived && !b.archived && !["draft", "active"].includes(l.status))
          throw fail.conflict("Restore people only on a draft or active lease");
        if (!b.archived) await contact(t, s, before.contact_id);
        await duplicate(t, s, leaseId, before.contact_id, b.kind, id);
        if (before.archived && !b.archived) {
          const n = await t.row<{ n: number }>(
            "SELECT count(*)::int n FROM pm_lease_people WHERE org_id=$1 AND lease_id=$2 AND NOT archived",
            [s.orgId, leaseId],
          );
          if ((n?.n ?? 0) >= 100)
            throw fail.invalid(
              "Archive an inactive relationship before restoring this person; this lease already has 100 active people.",
            );
        }
        await t.run(
          "UPDATE pm_lease_people SET kind=$4,relationship=$5,note=$6,start_date=$7,end_date=$8,archived=$9,version=version+1 WHERE org_id=$1 AND lease_id=$2 AND id=$3",
          [s.orgId, leaseId, id, b.kind, b.relationship, b.note, b.startDate, b.endDate, b.archived],
        );
        const result = await view(t, s, id);
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action:
            b.archived && !before.archived
              ? "Lease person archived"
              : !b.archived && before.archived
                ? "Lease person restored"
                : "Lease person corrected",
          target: leaseId,
          detail: b.reason,
          before: snapshot(before),
          after: {
            id,
            kind: b.kind,
            relationship: b.relationship,
            note: b.note,
            startDate: b.startDate,
            endDate: b.endDate,
            archived: b.archived,
            version: result.version,
          },
        });
        return result;
      });
    },
    async history(s: OrgScope, leaseId: string, q: { limit: number; offset: number }) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await lease(t, s, leaseId);
        const where =
            "org_id=$1 AND target=$2 AND action IN ('Lease person added','Lease person corrected','Lease person archived','Lease person restored','Lease person identity merged')",
          args = [s.orgId, leaseId];
        const total = await t.row<{ n: number }>(`SELECT count(*)::int n FROM audit_log WHERE ${where}`, args);
        const entries = await t.rows<{
          id: string;
          at: string;
          action: string;
          detail: string;
          actorRole: string | null;
          before: unknown;
          after: unknown;
        }>(
          `SELECT id::text,at,action,detail,actor_role AS "actorRole",before,after FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $3 OFFSET $4`,
          [...args, q.limit, q.offset],
        );
        return { entries, total: total?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
  };
}
