import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { memberProductRole } from "../../../core/access/product-role.js";
import { memberCan, managerGrant } from "../../../core/access/manager-access.js";
import { resolveEntitlement } from "../../../core/subscriptions/entitlement.service.js";
import { recordAudit, SYSTEM } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { MODULE } from "../shared/access.js";
import * as R from "../shared/records.js";
import { addDays, daysBetween } from "../shared/util.js";
import type { MaintenanceService } from "./maintenance.service.js";
export const PREVENTIVE_JOB = "property.preventive_maintenance";
type Input = Omit<P.PreventivePlan, "id" | "propertyId" | "unitId" | "version">;
type Row = {
  id: string;
  org_id: string;
  property_id: string;
  unit_id: string | null;
  title: string;
  asset_label: string;
  priority: P.WorkOrder["priority"];
  every_days: number;
  next_due: string;
  active: boolean;
  version: number;
  updated_by: string;
};
const dto = (r: Row): P.PreventivePlan => ({
  id: r.id,
  propertyId: r.property_id,
  unitId: r.unit_id,
  title: r.title,
  assetLabel: r.asset_label,
  priority: r.priority,
  everyDays: r.every_days,
  nextDue: r.next_due,
  active: r.active,
  version: r.version,
});
export function preventiveService(d: PmDeps, M: MaintenanceService) {
  const { core, ctx } = d,
    db = core.db;
  async function property(t: Db, s: Pick<OrgScope, "orgId" | "propertyIds">, id: string) {
    if (s.propertyIds && !s.propertyIds.includes(id)) throw fail.notFound("Property not found");
    return R.propertyRow(t, s.orgId, id);
  }
  async function row(t: Db, s: Pick<OrgScope, "orgId" | "propertyIds">, id: string, lock = false) {
    const r = await t.row<Row>(
      `SELECT * FROM pm_preventive_plans WHERE org_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [s.orgId, id],
    );
    if (!r) throw fail.notFound("Servicing plan not found");
    await property(t, s, r.property_id);
    return r;
  }
  async function schedule(t: Db, s: OrgScope, propertyId: string) {
    const org = await t.row<{ timezone: string }>("SELECT timezone FROM organisations WHERE id=$1", [s.orgId]);
    await core.scheduler.ensureJob(t, {
      key: PREVENTIVE_JOB,
      orgId: s.orgId,
      targetId: propertyId,
      label: "Preventive property servicing",
      cron: "*/15 * * * *",
      timezone: org?.timezone ?? "UTC",
    });
  }
  return {
    async list(s: OrgScope, q: { propertyId: string; limit: number; offset: number }) {
      await property(db, s, q.propertyId);
      const total = await db.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM pm_preventive_plans WHERE org_id=$1 AND property_id=$2",
        [s.orgId, q.propertyId],
      );
      const rows = await db.rows<Row>(
        "SELECT * FROM pm_preventive_plans WHERE org_id=$1 AND property_id=$2 ORDER BY next_due,id LIMIT $3 OFFSET $4",
        [s.orgId, q.propertyId, q.limit, q.offset],
      );
      return { plans: rows.map(dto), total: total?.n ?? 0, limit: q.limit, offset: q.offset };
    },
    async get(s: OrgScope, id: string) {
      return dto(await row(db, s, id));
    },
    async create(s: OrgScope, b: Input & { propertyId: string; unitId?: string | undefined }) {
      return db.tx(async (t) => {
        await property(t, s, b.propertyId);
        if (b.unitId && (await R.unitRow(t, s.orgId, b.unitId)).property_id !== b.propertyId)
          throw fail.invalid("Select a unit in this property");
        const id = newId("pmp");
        await t.run(
          "INSERT INTO pm_preventive_plans(id,org_id,property_id,unit_id,title,asset_label,priority,every_days,next_due,active,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id,
            s.orgId,
            b.propertyId,
            b.unitId ?? null,
            b.title,
            b.assetLabel,
            b.priority,
            b.everyDays,
            b.nextDue,
            b.active,
            s.userId,
          ],
        );
        if (b.active) await schedule(t, s, b.propertyId);
        const r = await row(t, s, id);
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Preventive plan created",
          target: id,
          after: dto(r),
        });
        return dto(r);
      });
    },
    async update(s: OrgScope, id: string, b: Input & { expectedVersion: number; reason: string }) {
      return db.tx(async (t) => {
        const r = await row(t, s, id, true);
        if (r.version !== b.expectedVersion)
          throw fail.conflict("The plan or its scheduler changed. Reopen the current plan before saving.");
        await t.run(
          "UPDATE pm_preventive_plans SET title=$3,asset_label=$4,priority=$5,every_days=$6,next_due=$7,active=$8,version=version+1,updated_by=$9 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, b.title, b.assetLabel, b.priority, b.everyDays, b.nextDue, b.active, s.userId],
        );
        if (b.active) await schedule(t, s, r.property_id);
        const after = dto(await row(t, s, id));
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Preventive plan changed",
          target: id,
          detail: b.reason,
          before: dto(r),
          after,
        });
        return after;
      });
    },
    async history(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await row(t, s, id);
        const total = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND target=$2 AND action LIKE 'Preventive plan %'",
          [s.orgId, id],
        );
        const entries = await t.rows<{
          id: string;
          at: string;
          action: string;
          detail: string;
          actorRole: string | null;
          before: unknown;
          after: unknown;
        }>(
          "SELECT id::text,at,action,detail,actor_role AS \"actorRole\",before,after FROM audit_log WHERE org_id=$1 AND target=$2 AND action LIKE 'Preventive plan %' ORDER BY id DESC LIMIT $3 OFFSET $4",
          [s.orgId, id, q.limit, q.offset],
        );
        const occurrences = await t.rows<{
          dueDate: string;
          workOrderId: string;
          number: string;
          status: P.WorkOrder["status"];
        }>(
          'SELECT o.due_date AS "dueDate",o.work_order_id AS "workOrderId",w.number,w.status FROM pm_preventive_occurrences o JOIN pm_work_orders w ON w.org_id=o.org_id AND w.id=o.work_order_id WHERE o.org_id=$1 AND o.plan_id=$2 ORDER BY o.due_date DESC LIMIT $3 OFFSET $4',
          [s.orgId, id, q.limit, q.offset],
        );
        return { occurrences, events: { entries, total: total?.n ?? 0, limit: q.limit, offset: q.offset } };
      });
    },
    async automatic(orgId: string, propertyId: string, today: string) {
      const en = await resolveEntitlement(db, ctx.products, today, orgId, "property").catch(() => null);
      if (!en?.ent.usable || !en.ent.modules[MODULE.maintenance])
        return { summary: "Maintenance entitlement is unavailable — no work orders created" };
      return db.tx(async (t) => {
        const org = await t.row<{ suspended_at: string | null }>("SELECT suspended_at FROM organisations WHERE id=$1", [
          orgId,
        ]);
        if (!org || org.suspended_at) return { summary: "Organisation unavailable — no work orders created" };
        const plans = await t.rows<Row>(
          "SELECT * FROM pm_preventive_plans WHERE org_id=$1 AND property_id=$2 AND active AND next_due<=$3 ORDER BY last_checked_at NULLS FIRST,next_due,id LIMIT 100 FOR UPDATE",
          [orgId, propertyId, today],
        );
        let created = 0,
          blocked = 0;
        for (const r of plans) {
          await t.run("UPDATE pm_preventive_plans SET last_checked_at=now() WHERE org_id=$1 AND id=$2", [orgId, r.id]);
          const role = await memberProductRole(t, orgId, r.updated_by, "property");
          if (!role || !(await memberCan(t, orgId, r.updated_by, role, "property", "property.maintenance.manage"))) {
            blocked++;
            continue;
          }
          if (role === "main_manager") {
            const g = await managerGrant(t, orgId, r.updated_by, "property");
            if (g?.propertyIds && !g.propertyIds.includes(propertyId)) {
              blocked++;
              continue;
            }
          }
          const unfinished = await t.row(
            "SELECT 1 FROM pm_preventive_occurrences o JOIN pm_work_orders w ON w.id=o.work_order_id AND w.org_id=o.org_id WHERE o.org_id=$1 AND o.plan_id=$2 AND w.status NOT IN ('verified','billed','cancelled') LIMIT 1",
            [orgId, r.id],
          );
          if (unfinished) {
            blocked++;
            continue;
          }
          const existing = await t.row(
            "SELECT 1 FROM pm_preventive_occurrences WHERE org_id=$1 AND plan_id=$2 AND due_date=$3",
            [orgId, r.id, r.next_due],
          );
          let workOrderId: string | null = null;
          if (!existing) {
            workOrderId = await M.openWorkOrder(
              t,
              { orgId, userId: r.updated_by, today, actor: SYSTEM },
              {
                propertyId,
                unitId: r.unit_id ?? undefined,
                scope: r.title + (r.asset_label ? " — " + r.asset_label : ""),
                priority: r.priority,
              },
            );
            await t.run(
              "INSERT INTO pm_preventive_occurrences(org_id,plan_id,due_date,work_order_id) VALUES($1,$2,$3,$4)",
              [orgId, r.id, r.next_due, workOrderId],
            );
            created++;
          }
          const next = addDays(
            r.next_due,
            (Math.floor(daysBetween(r.next_due, today) / r.every_days) + 1) * r.every_days,
          );
          await t.run("UPDATE pm_preventive_plans SET next_due=$3,version=version+1 WHERE org_id=$1 AND id=$2", [
            orgId,
            r.id,
            next,
          ]);
          await recordAudit(t, {
            orgId,
            actor: SYSTEM,
            action: "Preventive plan scheduled",
            target: r.id,
            detail: existing ? "Existing occurrence retained" : "Work order created for due servicing",
            before: { nextDue: r.next_due, version: r.version },
            after: { nextDue: next, version: r.version + 1, workOrderId },
          });
        }
        return {
          summary: `${created} preventive work order(s) created; ${blocked} awaiting authorisation or completion. At most 100 due plans processed per run.`,
        };
      });
    },
  };
}
export type PreventiveService = ReturnType<typeof preventiveService>;
