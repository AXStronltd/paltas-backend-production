import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { propertyRow } from "../shared/records.js";
import type { MaintenanceService } from "./maintenance.service.js";
type TemplateRow = { id: string; property_id: string; name: string; areas: string[]; active: boolean; version: number };
const dto = (r: TemplateRow): P.InspectionTemplate => ({
  id: r.id,
  propertyId: r.property_id,
  name: r.name,
  areas: r.areas,
  active: r.active,
  version: r.version,
});
export function inspectionControlsService(d: PmDeps, M: MaintenanceService) {
  const db = d.core.db;
  async function property(t: Db, s: OrgScope, id: string) {
    if (s.propertyIds && !s.propertyIds.includes(id)) throw fail.notFound("Property not found");
    await propertyRow(t, s.orgId, id);
  }
  async function template(t: Db, s: OrgScope, id: string, lock = false) {
    const r = await t.row<TemplateRow>(
      `SELECT * FROM pm_inspection_templates WHERE org_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [s.orgId, id],
    );
    if (!r) throw fail.notFound("Inspection checklist not found");
    await property(t, s, r.property_id);
    return r;
  }
  async function inspection(t: Db, s: OrgScope, id: string, lock = false) {
    const r = await t.row<{
      id: string;
      number: string;
      property_id: string;
      version: number;
      status: P.Inspection["status"];
      scheduled_date: string;
    }>(`SELECT * FROM pm_inspections WHERE org_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [s.orgId, id]);
    if (!r) throw fail.notFound("Inspection not found");
    await property(t, s, r.property_id);
    return r;
  }
  async function view(s: OrgScope, id: string) {
    await inspection(db, s, id);
    const r = await db.row<Parameters<MaintenanceService["inspectionView"]>[1]>(
      "SELECT * FROM pm_inspections WHERE org_id=$1 AND id=$2",
      [s.orgId, id],
    );
    if (!r) throw fail.notFound("Inspection not found");
    return M.inspectionView(s.orgId, r);
  }

  return {
    get: view,
    async templateHistory(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await template(t, s, id);
        const args = [s.orgId, id],
          where =
            "org_id=$1 AND target=$2 AND action IN ('Inspection checklist created','Inspection checklist changed')";
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
    async getTemplate(s: OrgScope, id: string) {
      return dto(await template(db, s, id));
    },
    async listTemplates(s: OrgScope, q: { propertyId: string; q: string; limit: number; offset: number }) {
      await property(db, s, q.propertyId);
      const args = [s.orgId, q.propertyId, q.q];
      const where = "org_id=$1 AND property_id=$2 AND strpos(lower(name),lower($3))>0";
      const total = await db.row<{ n: number }>(
        `SELECT count(*)::int n FROM pm_inspection_templates WHERE ${where}`,
        args,
      );
      return {
        templates: (
          await db.rows<TemplateRow>(
            `SELECT * FROM pm_inspection_templates WHERE ${where} ORDER BY active DESC,lower(name),id LIMIT $4 OFFSET $5`,
            [...args, q.limit, q.offset],
          )
        ).map(dto),
        total: total?.n ?? 0,
        limit: q.limit,
        offset: q.offset,
      };
    },
    async createTemplate(s: OrgScope, b: { propertyId: string; name: string; areas: string[]; active: boolean }) {
      return db.tx(async (t) => {
        await property(t, s, b.propertyId);
        const id = newId("pit");
        await t.run(
          "INSERT INTO pm_inspection_templates(id,org_id,property_id,name,areas,active,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, s.orgId, b.propertyId, b.name, JSON.stringify(b.areas), b.active, s.userId],
        );
        const after = dto(await template(t, s, id));
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Inspection checklist created",
          target: id,
          after,
        });
        return after;
      });
    },
    async updateTemplate(
      s: OrgScope,
      id: string,
      b: { expectedVersion: number; name: string; areas: string[]; active: boolean; reason: string },
    ) {
      return db.tx(async (t) => {
        const before = await template(t, s, id, true);
        if (before.version !== b.expectedVersion)
          throw fail.conflict("The checklist changed. Reopen it before saving.");
        await t.run(
          "UPDATE pm_inspection_templates SET name=$3,areas=$4,active=$5,version=version+1,updated_by=$6 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, b.name, JSON.stringify(b.areas), b.active, s.userId],
        );
        const after = dto(await template(t, s, id));
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Inspection checklist changed",
          target: id,
          detail: b.reason,
          before: dto(before),
          after,
        });
        return after;
      });
    },
    async change(
      s: OrgScope,
      id: string,
      b: {
        expectedVersion: number;
        action: "reschedule" | "cancel" | "restore";
        scheduledDate?: string | undefined;
        reason: string;
      },
    ) {
      await db.tx(async (t) => {
        const r = await inspection(t, s, id, true);
        if (r.version !== b.expectedVersion)
          throw fail.conflict("The inspection changed. Reopen it before continuing.");
        if (r.status === "completed")
          throw fail.conflict("Completed findings are retained. Schedule a follow-up inspection instead.");
        if (b.action === "restore" && r.status !== "cancelled")
          throw fail.conflict("Only a cancelled inspection can be restored");
        if (b.action !== "restore" && r.status !== "scheduled")
          throw fail.conflict("Restore the cancelled inspection before rescheduling");
        if (b.action === "reschedule" && !b.scheduledDate) throw fail.invalid("Choose the new inspection date");
        const status = b.action === "cancel" ? "cancelled" : "scheduled";
        const date = b.action === "reschedule" ? (b.scheduledDate ?? r.scheduled_date) : r.scheduled_date;
        await t.run("UPDATE pm_inspections SET status=$3,scheduled_date=$4 WHERE org_id=$1 AND id=$2", [
          s.orgId,
          id,
          status,
          date,
        ]);
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Inspection schedule changed",
          target: r.number,
          detail: b.reason,
          before: { status: r.status, scheduledDate: r.scheduled_date, version: r.version },
          after: { status, scheduledDate: date, version: r.version + 1 },
        });
      });
      return view(s, id);
    },
    async history(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const r = await inspection(t, s, id);
        const where =
            "org_id=$1 AND target=$2 AND action IN ('Inspection scheduled','Inspection completed','Inspection schedule changed')",
          args = [s.orgId, r.number];
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
export type InspectionControlsService = ReturnType<typeof inspectionControlsService>;
