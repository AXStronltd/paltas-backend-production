import type { property as P, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { memberProductRole } from "../../../core/access/product-role.js";
import { memberCan, managerGrant } from "../../../core/access/manager-access.js";
import { contactScopeSql, contactWithinScope } from "../../../core/access/property-contact-scope.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { ApiError, fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { Db } from "../../../db/database.js";
import type { PmDeps } from "../deps.js";
import { propertyRow } from "../shared/records.js";
type Item = z.infer<typeof P.createCrmWork.response>;
type Input = z.infer<typeof P.createCrmWork.body>;
const select = `SELECT w.id,w.property_id AS "propertyId",p.name AS "propertyName",w.contact_id AS "contactId",c.name AS "contactName",w.title,w.description,w.kind,w.due_at AS "dueAt",w.priority,w.assignee_id AS "assigneeId",u.name AS "assigneeName",w.status,w.version,w.created_at AS "createdAt" FROM pm_crm_work w JOIN pm_properties p ON p.org_id=w.org_id AND p.id=w.property_id JOIN users u ON u.id=w.assignee_id LEFT JOIN contacts c ON c.org_id=w.org_id AND c.id=w.contact_id`;
export function crmWorkService(d: PmDeps) {
  const { ctx, core } = d,
    { db } = ctx;
  const scope = (s: OrgScope, p: string) => {
    if (s.propertyIds && !s.propertyIds.includes(p)) throw fail.notFound("CRM record not found");
  };
  async function assignee(s: OrgScope, p: string, id: string) {
    const role = await memberProductRole(db, s.orgId, id, "property");
    if (!role || !(await memberCan(db, s.orgId, id, role, "property", "property.crm")))
      throw fail.invalid("Select an active CRM colleague");
    if (role === "main_manager") {
      const g = await managerGrant(db, s.orgId, id, "property");
      if (!g?.enabled || (g.propertyIds && !g.propertyIds.includes(p)))
        throw fail.invalid("This colleague is not assigned to this property");
    }
    const u = await db.row("SELECT id FROM users WHERE id=$1 AND active", [id]);
    if (!u) throw fail.invalid("Select an active CRM colleague");
  }
  async function check(s: OrgScope, b: Input, t: Db = db) {
    scope(s, b.propertyId);
    await propertyRow(t, s.orgId, b.propertyId);
    if (b.contactId) {
      await core.contacts.live(t, s.orgId, b.contactId);
      if (s.propertyIds && !(await contactWithinScope(t, s.orgId, b.contactId, s.propertyIds, s.userId)))
        throw fail.notFound("Contact not found");
    }
    await assignee(s, b.propertyId, b.assigneeId || s.userId);
  }
  async function get(s: OrgScope, id: string, t: Db = db, lock = false) {
    const r = await t.row<Item>(select + " WHERE w.org_id=$1 AND w.id=$2" + (lock ? " FOR UPDATE OF w" : ""), [
      s.orgId,
      id,
    ]);
    if (!r) throw fail.notFound("CRM task not found");
    scope(s, r.propertyId);
    if (s.propertyIds && r.contactId && !(await contactWithinScope(t, s.orgId, r.contactId, s.propertyIds, s.userId)))
      throw fail.notFound("CRM task not found");
    return r;
  }
  async function history(t: Db, s: OrgScope, item: Item, reason: string) {
    await t.run("INSERT INTO pm_crm_work_history(task_id,version,actor,reason,snapshot) VALUES($1,$2,$3,$4,$5)", [
      item.id,
      item.version,
      s.userId,
      reason,
      JSON.stringify(item),
    ]);
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "CRM work " + (item.version === 1 ? "created" : "updated"),
      target: item.id,
      detail: reason,
    });
    if (item.contactId)
      await core.contacts.activity(t, {
        orgId: s.orgId,
        contactId: item.contactId,
        kind: "note",
        text: `CRM ${item.kind}: ${item.title} · ${item.status} · ${reason}`,
        refType: "crm_work",
        refId: item.id,
        by: s.userId,
      });
  }
  return {
    async list(s: OrgScope, q: z.infer<typeof P.listCrmWork.query>) {
      if (q.propertyId) scope(s, q.propertyId);
      const where = ` WHERE w.org_id=$1 AND ($2::text[] IS NULL OR w.property_id=ANY($2)) AND ($3::text IS NULL OR w.property_id=$3) AND ($4::text IS NULL OR w.status=$4) AND ($5::text IS NULL OR lower(w.title||' '||w.description) LIKE '%'||lower($5)||'%') AND ($6::timestamptz IS NULL OR w.due_at>=$6) AND ($7::timestamptz IS NULL OR w.due_at<$7) AND ($8::text IS NULL OR to_char(w.due_at AT TIME ZONE (SELECT timezone FROM organisations WHERE id=w.org_id),'YYYY-MM')=$8) AND (w.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts c WHERE c.org_id=w.org_id AND c.id=w.contact_id AND ${contactScopeSql("c", "$2", "$9")}))`;
      const params = [
        s.orgId,
        s.propertyIds ?? null,
        q.propertyId ?? null,
        q.status ?? null,
        q.q ?? null,
        q.from ?? null,
        q.to ?? null,
        q.month ?? null,
        s.userId,
      ];
      const n = await db.row<{ n: number }>("SELECT count(*)::int n FROM pm_crm_work w" + where, params);
      return {
        items: await db.rows<Item>(select + where + " ORDER BY w.due_at,w.id LIMIT $10 OFFSET $11", [
          ...params,
          q.limit,
          q.offset,
        ]),
        total: n?.n ?? 0,
      };
    },
    async create(s: OrgScope, b: Input) {
      await check(s, b);
      return db.tx(async (t) => {
        const id = newId("crmwork");
        const inserted = await t.row<{ id: string }>(
          `INSERT INTO pm_crm_work(id,org_id,property_id,contact_id,title,description,kind,due_at,priority,assignee_id,request_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(org_id,request_key) DO NOTHING RETURNING id`,
          [
            id,
            s.orgId,
            b.propertyId,
            b.contactId,
            b.title,
            b.description,
            b.kind,
            b.dueAt,
            b.priority,
            b.assigneeId || s.userId,
            b.requestKey,
            s.userId,
          ],
        );
        const old =
          inserted ??
          (await t.row<{ id: string }>("SELECT id FROM pm_crm_work WHERE org_id=$1 AND request_key=$2", [
            s.orgId,
            b.requestKey,
          ]));
        if (!old) throw fail.conflict("Reopen this task before saving");
        const item = await get(s, old.id, t);
        if (
          !inserted &&
          (item.title !== b.title ||
            item.propertyId !== b.propertyId ||
            item.contactId !== b.contactId ||
            item.description !== b.description ||
            item.kind !== b.kind ||
            item.priority !== b.priority ||
            item.assigneeId !== (b.assigneeId || s.userId) ||
            new Date(item.dueAt).getTime() !== new Date(b.dueAt).getTime())
        )
          throw fail.conflict("This request was already used for another task. Reopen the form");
        if (inserted) await history(t, s, item, "Created CRM work");
        return item;
      });
    },
    async update(s: OrgScope, id: string, b: z.infer<typeof P.updateCrmWork.body>) {
      await check(s, { ...b, requestKey: "not-used-for-updates" });
      return db.tx(async (t) => {
        const old = await get(s, id, t, true);
        if (old.version !== b.expectedVersion) throw fail.conflict("This task changed. Reopen it before saving");
        if (old.status !== "open" && b.status !== "open")
          throw fail.conflict("Reopen completed, cancelled or archived work before editing it");
        if (b.propertyId !== old.propertyId)
          throw fail.invalid("Property cannot change; archive this task and create one in the correct property");
        await t.run(
          `UPDATE pm_crm_work SET contact_id=$3,title=$4,description=$5,kind=$6,due_at=$7,priority=$8,assignee_id=$9,status=$10,version=version+1 WHERE org_id=$1 AND id=$2`,
          [
            s.orgId,
            id,
            b.contactId,
            b.title,
            b.description,
            b.kind,
            b.dueAt,
            b.priority,
            b.assigneeId || s.userId,
            b.status,
          ],
        );
        const item = await get(s, id, t);
        await history(t, s, item, b.reason);
        return item;
      });
    },
    async history(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      await get(s, id);
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const count = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM pm_crm_work_history WHERE task_id=$1",
          [id],
        );
        return {
          total: count?.n ?? 0,
          limit: q.limit,
          offset: q.offset,
          events: await t.rows<{ version: number; at: string; actor: string; reason: string; snapshot: Item }>(
            "SELECT h.version,h.at,u.name AS actor,h.reason,h.snapshot FROM pm_crm_work_history h JOIN users u ON u.id=h.actor WHERE h.task_id=$1 ORDER BY h.version DESC LIMIT $2 OFFSET $3",
            [id, q.limit, q.offset],
          ),
        };
      });
    },
    async assignees(s: OrgScope, p: string) {
      scope(s, p);
      await propertyRow(db, s.orgId, p);
      const users = await db.rows<{ id: string; name: string }>(
        "SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.status='active' AND u.active ORDER BY u.name LIMIT 500",
        [s.orgId],
      );
      const allowed = [];
      for (const u of users) {
        try {
          await assignee(s, p, u.id);
          allowed.push(u);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          /* Ineligible colleagues are not offered. */
        }
      }
      return { users: allowed };
    },
    async messages(s: OrgScope, q: z.infer<typeof P.crmMessageLog.query>) {
      const where = ` FROM contact_messages m JOIN contacts c ON c.org_id=m.org_id AND c.id=m.contact_id LEFT JOIN notifications n ON n.org_id=m.org_id AND n.id=m.outbox_id WHERE m.org_id=$1 AND ${contactScopeSql("c", "$2", "$3")} AND ($4::text IS NULL OR c.id=$4) AND ($5::text IS NULL OR lower(c.name||' '||m.subject||' '||m.body) LIKE '%'||lower($5)||'%')`;
      const args = [s.orgId, s.propertyIds ?? null, s.userId, q.contactId ?? null, q.q ?? null];
      const n = await db.row<{ n: number }>("SELECT count(*)::int n" + where, args);
      return {
        items: await db.rows<z.infer<typeof P.crmMessageLog.response>["items"][number]>(
          `SELECT m.id,m.contact_id AS "contactId",c.name AS "contactName",m.channel,m.direction,m.subject,m.body,m.status,m.reason,m.at,n.status AS "deliveryStatus",n.status_note AS "deliveryNote"` +
            where +
            " ORDER BY m.at DESC,m.id DESC LIMIT $6 OFFSET $7",
          [...args, q.limit, q.offset],
        ),
        total: n?.n ?? 0,
      };
    },
  };
}
