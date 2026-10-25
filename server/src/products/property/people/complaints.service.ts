import { ROLE_DEFINITIONS, roleCan, type Role, type property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { memberProductRole } from "../../../core/access/product-role.js";
import { managerGrant, memberCan } from "../../../core/access/manager-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";

type Row = {
  id: string;
  org_id: string;
  lease_id: string;
  lease_number: string;
  property_id: string;
  unit_no: string;
  tenant_id: string;
  tenant_name: string;
  title: string;
  category: string;
  description: string;
  status: P.Complaint["status"];
  assigned_user_id: string | null;
  assigned_name: string | null;
  resolution: string;
  version: number;
  created_at: string;
  updated_at: string;
};
const FROM = `FROM pm_complaints c JOIN pm_leases l ON l.org_id=c.org_id AND l.id=c.lease_id JOIN pm_units u ON u.org_id=l.org_id AND u.id=l.unit_id JOIN contacts t ON t.org_id=l.org_id AND t.id=l.tenant_id LEFT JOIN users a ON a.id=c.assigned_user_id`;
const SELECT = `SELECT c.*,l.number AS lease_number,l.property_id,l.tenant_id,u.unit_no,t.name AS tenant_name,a.name AS assigned_name ${FROM}`;
export function complaintsService(d: PmDeps) {
  const db = d.core.db;
  function scope(s: OrgScope, propertyId: string) {
    if (s.propertyIds && !s.propertyIds.includes(propertyId))
      throw fail.notFound("Complaint not found in assigned properties");
  }
  async function read(t: Db, s: OrgScope, id: string, tenantId?: string, lock = false): Promise<Row> {
    const r = await t.row<Row>(`${SELECT} WHERE c.org_id=$1 AND c.id=$2 ${lock ? "FOR UPDATE OF c" : ""}`, [
      s.orgId,
      id,
    ]);
    if (!r || (tenantId && r.tenant_id !== tenantId)) throw fail.notFound("Complaint not found");
    scope(s, r.property_id);
    return r;
  }
  async function view(t: Db, r: Row, tenantId?: string): Promise<P.Complaint> {
    const events = await t.rows<P.Complaint["events"][number]>(
      `SELECT id,action,reason,internal,created_at AS "createdAt" FROM pm_complaint_events WHERE org_id=$1 AND complaint_id=$2 AND ($3::boolean=false OR internal=false) ORDER BY created_at,id`,
      [r.org_id, r.id, !!tenantId],
    );
    const evidence = await t.rows<P.Complaint["evidence"][number]>(
      `SELECT d.id AS "documentId",COALESCE(d.name,d.filename) AS name,d.filename,d.visibility,EXISTS(SELECT 1 FROM pm_document_files f WHERE f.org_id=d.org_id AND f.document_id=d.id) AS "fileStored" FROM pm_complaint_evidence e JOIN pm_documents d ON d.id=e.document_id AND d.org_id=e.org_id WHERE e.org_id=$1 AND e.complaint_id=$2 AND ($3::boolean=false OR d.visibility='tenant') ORDER BY e.created_at,d.id`,
      [r.org_id, r.id, !!tenantId],
    );
    return {
      id: r.id,
      leaseId: r.lease_id,
      leaseNumber: r.lease_number,
      propertyId: r.property_id,
      unitNo: r.unit_no,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      title: r.title,
      category: r.category,
      description: r.description,
      status: r.status,
      assignedUserId: r.assigned_user_id,
      assignedName: r.assigned_name,
      resolution: r.resolution,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      events,
      evidence,
    };
  }
  async function event(t: Db, s: OrgScope, id: string, action: string, reason: string, internal = false) {
    await t.run(
      "INSERT INTO pm_complaint_events(id,org_id,complaint_id,action,reason,internal,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [newId("pce"), s.orgId, id, action, reason, internal, s.userId],
    );
    // Do not duplicate private complaint contents in broad activity feeds.
    await recordAudit(t, {
      orgId: s.orgId,
      actor: s.actor,
      action: `Complaint ${action}`,
      target: id,
      detail: internal ? "Internal case update recorded" : "Case update recorded",
    });
  }
  return {
    async assignees(s: OrgScope, id: string, search: string) {
      const c = await read(db, s, id);
      const roles = (Object.keys(ROLE_DEFINITIONS) as Role[]).filter(
        (r) => r !== "main_manager" && roleCan(r, "property.maintenance.manage"),
      );
      const members = await db.rows<{ userId: string; name: string }>(
        `SELECT m.user_id AS "userId",u.name FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN main_manager_grants g ON g.org_id=m.org_id AND g.user_id=m.user_id AND g.product='property'
        WHERE m.org_id=$1 AND m.status='active' AND u.active AND strpos(lower(u.name),lower($3))>0 AND
        (COALESCE(m.product_roles->>'property',CASE WHEN m.product_roles IS NULL THEN m.role END)=ANY($4::text[]) OR
        (COALESCE(m.product_roles->>'property',CASE WHEN m.product_roles IS NULL THEN m.role END)='main_manager' AND g.enabled AND 'property.maintenance.manage'=ANY(g.capabilities) AND (g.property_ids IS NULL OR $2=ANY(g.property_ids)))) ORDER BY lower(u.name),m.user_id LIMIT 51`,
        [s.orgId, c.property_id, search, roles],
      );
      return { members: members.slice(0, 50), more: members.length > 50 };
    },
    async get(s: OrgScope, id: string, tenantId?: string) {
      return db.tx(async (t) => view(t, await read(t, s, id, tenantId), tenantId));
    },
    async list(s: OrgScope, q: P.ComplaintQuery, tenantId?: string) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const where = `WHERE c.org_id=$1 AND ($2::text IS NULL OR l.property_id=$2) AND ($3::text[] IS NULL OR l.property_id=ANY($3)) AND ($4::text IS NULL OR l.tenant_id=$4) AND ($5::text IS NULL OR c.status=$5) AND ($6::text IS NULL OR strpos(lower(c.title || ' ' || c.category || ' ' || u.unit_no),lower($6))>0)`;
        const args = [
          s.orgId,
          q.propertyId ?? null,
          s.propertyIds ?? null,
          tenantId ?? null,
          q.status ?? null,
          q.search || null,
        ];
        const total = await t.row<{ n: number }>(`SELECT count(*)::int AS n ${FROM} ${where}`, args);
        const rows = await t.rows<Row>(`${SELECT} ${where} ORDER BY c.updated_at DESC,c.id DESC LIMIT $7 OFFSET $8`, [
          ...args,
          q.limit,
          q.offset,
        ]);
        const complaints = [];
        for (const r of rows) complaints.push(await view(t, r, tenantId));
        return { complaints, total: total?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
    async create(s: OrgScope, b: P.ComplaintInput, tenantId?: string) {
      return db.tx(async (t) => {
        const lease = await t.row<{ tenant_id: string; property_id: string }>(
          "SELECT tenant_id,property_id FROM pm_leases WHERE org_id=$1 AND id=$2",
          [s.orgId, b.leaseId],
        );
        if (!lease || (tenantId && lease.tenant_id !== tenantId)) throw fail.notFound("Lease not found");
        scope(s, lease.property_id);
        const id = newId("pcm");
        await t.run(
          "INSERT INTO pm_complaints(id,org_id,lease_id,title,category,description,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",
          [id, s.orgId, b.leaseId, b.title, b.category, b.description, s.userId],
        );
        await event(t, s, id, "opened", b.description);
        return view(t, await read(t, s, id, tenantId), tenantId);
      });
    },
    async action(s: OrgScope, id: string, b: P.ComplaintAction, tenantId?: string) {
      return db.tx(async (t) => {
        const r = await read(t, s, id, tenantId, true);
        if (r.version !== b.expectedVersion)
          throw fail.conflict("This case changed. Reopen it to review the latest information.");
        if (tenantId && (!["comment", "reopen"].includes(b.action) || b.internal))
          throw fail.forbidden("Your manager must perform this case action");
        if (b.internal && b.action !== "comment")
          throw fail.invalid("Only staff comments may be internal. Decisions must be visible to the tenant.");
        if (b.assignedUserId && b.action !== "assign")
          throw fail.invalid("Choose Assign to change the responsible employee");
        if (b.category && b.action !== "categorise") throw fail.invalid("Choose Categorise to change the category");
        if (b.documentId && b.action !== "evidence") throw fail.invalid("Choose Attach evidence to link a document");
        let status = r.status,
          resolution = r.resolution,
          assigned = r.assigned_user_id,
          category = r.category;
        const finished = ["resolved", "closed"].includes(status);
        if (b.action === "reopen") {
          if (!finished) throw fail.conflict("This case is already open");
          status = "open";
          resolution = "";
        } else if (b.action === "comment") {
          if (status === "closed") throw fail.conflict("Reopen the closed case before adding a comment");
        } else if (b.action === "close") {
          if (status !== "resolved") throw fail.conflict("Record a resolution before closing this case");
          status = "closed";
        } else {
          if (finished) throw fail.conflict("Reopen the case before changing its decision or assignment");
          if (b.action === "evidence") {
            if (!b.documentId) throw fail.invalid("Select a document attached to this lease");
            const doc = await t.row<{ visibility: string }>(
              "SELECT visibility FROM pm_documents WHERE org_id=$1 AND id=$2 AND link_entity='lease' AND link_id=$3 AND visibility IN ('staff','tenant')",
              [s.orgId, b.documentId, r.lease_id],
            );
            if (!doc) throw fail.notFound("Evidence document not found on this lease");
            await t.run(
              "INSERT INTO pm_complaint_evidence(org_id,complaint_id,document_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
              [s.orgId, id, b.documentId, s.userId],
            );
          } else if (b.action === "assign") {
            if (!b.assignedUserId) throw fail.invalid("Select an active, authorised employee");
            const member = await t.row(
              "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.status='active' AND u.active FOR SHARE OF m",
              [s.orgId, b.assignedUserId],
            );
            const role = await memberProductRole(t, s.orgId, b.assignedUserId, "property");
            if (
              !member ||
              !role ||
              !(await memberCan(t, s.orgId, b.assignedUserId, role, "property", "property.maintenance.manage"))
            )
              throw fail.invalid("Select an active employee authorised to manage cases");
            if (role === "main_manager") {
              const grant = await managerGrant(t, s.orgId, b.assignedUserId, "property");
              if (!grant?.enabled || (grant.propertyIds && !grant.propertyIds.includes(r.property_id)))
                throw fail.invalid("This employee is not assigned to the case property");
            }
            assigned = b.assignedUserId;
          } else if (b.action === "categorise") {
            if (!b.category) throw fail.invalid("Enter the complaint category");
            category = b.category;
          } else if (b.action === "review") status = "reviewing";
          else if (b.action === "escalate") status = "escalated";
          else if (b.action === "resolve") {
            status = "resolved";
            resolution = b.reason;
          }
        }
        await t.run(
          "UPDATE pm_complaints SET status=$3,resolution=$4,assigned_user_id=$5,category=$6,version=version+1,updated_by=$7,updated_at=now() WHERE org_id=$1 AND id=$2",
          [s.orgId, id, status, resolution, assigned, category, s.userId],
        );
        await event(t, s, id, b.action, b.reason, b.internal);
        return view(t, await read(t, s, id, tenantId), tenantId);
      });
    },
  };
}
