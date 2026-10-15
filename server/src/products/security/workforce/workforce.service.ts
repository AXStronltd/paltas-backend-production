/*
 * The workforce: guards with licence and vetting, training records, expiry alerts (licence and training inside the
 * organisation's alert window) and equipment issued to and returned by guards (one holder per item at a time).
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { SecurityDeps } from "../deps.js";
import { loadSettings } from "../setup/setup.service.js";
import { findGuard, type GuardRow } from "../shared/access.js";
import { daysBetween, findSite, memberRole } from "../shared/util.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type GuardOut = z.infer<typeof security.Guard>;
type EquipmentOut = z.infer<typeof security.Equipment>;

interface EquipmentRow {
  id: string;
  code: string;
  kind: string;
  description: string;
  status: EquipmentOut["status"];
}

export function workforceService(d: SecurityDeps) {
  const { db } = d.core;

  async function guardOut(t: Db, g: GuardRow): Promise<GuardOut> {
    const training = await t.rows<{ id: string; course: string; valid_to: string }>(
      "SELECT id, course, valid_to FROM sec_guard_training WHERE guard_id = $1 ORDER BY valid_to",
      [g.id],
    );
    const kit = await t.rows<{ equipment_id: string; code: string; kind: string }>(
      `SELECT i.equipment_id, e.code, e.kind FROM sec_equipment_issues i JOIN sec_equipment e ON e.id = i.equipment_id
       WHERE i.guard_id = $1 AND i.returned_at IS NULL ORDER BY e.code`,
      [g.id],
    );
    return {
      id: g.id,
      number: g.number,
      name: g.name,
      grade: g.grade,
      userId: g.user_id,
      phone: g.phone,
      status: g.status,
      licenceNo: g.licence_no,
      licenceExpiry: g.licence_expiry,
      vetting: g.vetting,
      homeSiteId: g.home_site_id,
      training: training.map((x) => ({ id: x.id, course: x.course, validTo: x.valid_to })),
      equipment: kit.map((x) => ({ equipmentId: x.equipment_id, code: x.code, kind: x.kind })),
    };
  }

  async function checkUser(t: Db, s: OrgScope, userId: string | null | undefined) {
    if (!userId) return;
    if ((await memberRole(t, s.orgId, userId)) !== "guard")
      throw fail.invalid("A guard's app account must be a member with the guard role");
  }

  async function equipment(t: Db, orgId: string, id: string): Promise<EquipmentOut> {
    const e = await t.row<EquipmentRow>("SELECT * FROM sec_equipment WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!e) throw fail.notFound("Equipment not found");
    const history = await t.rows<{
      guard_id: string;
      issued_at: string;
      returned_at: string | null;
      return_condition: string | null;
    }>("SELECT * FROM sec_equipment_issues WHERE equipment_id = $1 ORDER BY issued_at DESC", [id]);
    return {
      id: e.id,
      code: e.code,
      kind: e.kind,
      description: e.description,
      status: e.status,
      holderGuardId: history.find((h) => !h.returned_at)?.guard_id ?? null,
      history: history.map((h) => ({
        guardId: h.guard_id,
        issuedAt: h.issued_at,
        returnedAt: h.returned_at,
        condition: h.return_condition,
      })),
    };
  }

  return {
    async listGuards(s: OrgScope, filter: "all" | "licence" | "vetting") {
      const settings = await loadSettings(db, s.orgId);
      const rows = await db.rows<GuardRow>(
        `SELECT * FROM sec_guards WHERE org_id = $1
           AND ($2 <> 'licence' OR licence_expiry <= $3::date + $4::int)
           AND ($2 <> 'vetting' OR vetting <> 'cleared')
         ORDER BY name`,
        [s.orgId, filter, s.today, settings.licence_alert_days],
      );
      const guards = [];
      for (const g of rows) guards.push(await guardOut(db, g));
      return { guards };
    },

    async createGuard(s: OrgScope, b: Body<typeof security.createGuard>) {
      return db.tx(async (t) => {
        await checkUser(t, s, b.userId);
        if (b.homeSiteId) await findSite(t, s.orgId, b.homeSiteId);
        const id = newId("sgd");
        try {
          await t.run(
            `INSERT INTO sec_guards (id, org_id, number, name, grade, user_id, phone, status, licence_no, licence_expiry,
               vetting, home_site_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11)`,
            [
              id,
              s.orgId,
              await nextNumber(t, s.orgId, "GRD"),
              b.name,
              b.grade,
              b.userId,
              b.phone ?? null,
              b.licenceNo,
              b.licenceExpiry,
              b.vetting,
              b.homeSiteId,
            ],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw fail.conflict("That app account is already linked to another guard");
          throw e;
        }
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Guard added", target: id, detail: b.name });
        return guardOut(t, await findGuard(t, s.orgId, id));
      });
    },

    async updateGuard(s: OrgScope, guardId: string, b: Body<typeof security.updateGuard>) {
      return db.tx(async (t) => {
        const before = await findGuard(t, s.orgId, guardId, true);
        if (b.userId !== undefined) await checkUser(t, s, b.userId);
        if (b.homeSiteId) await findSite(t, s.orgId, b.homeSiteId);
        await t.run(
          `UPDATE sec_guards SET status = COALESCE($3, status), grade = COALESCE($4, grade),
             user_id = CASE WHEN $5::boolean THEN $6 ELSE user_id END, licence_no = COALESCE($7, licence_no),
             licence_expiry = COALESCE($8, licence_expiry), vetting = COALESCE($9, vetting),
             home_site_id = CASE WHEN $10::boolean THEN $11 ELSE home_site_id END
           WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            guardId,
            b.status ?? null,
            b.grade ?? null,
            b.userId !== undefined,
            b.userId ?? null,
            b.licenceNo ?? null,
            b.licenceExpiry ?? null,
            b.vetting ?? null,
            b.homeSiteId !== undefined,
            b.homeSiteId ?? null,
          ],
        );
        const after = await findGuard(t, s.orgId, guardId);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guard changed",
          target: before.number,
          before,
          after,
        });
        return guardOut(t, after);
      });
    },

    async addTraining(s: OrgScope, guardId: string, course: string, validTo: string) {
      return db.tx(async (t) => {
        const g = await findGuard(t, s.orgId, guardId);
        await t.run("INSERT INTO sec_guard_training (id, org_id, guard_id, course, valid_to) VALUES ($1,$2,$3,$4,$5)", [
          newId("str"),
          s.orgId,
          guardId,
          course,
          validTo,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Training recorded",
          target: g.number,
          detail: course,
        });
        return guardOut(t, g);
      });
    },

    async expiryAlerts(s: OrgScope) {
      const settings = await loadSettings(db, s.orgId);
      const limit = settings.licence_alert_days;
      const lic = await db.rows<{ id: string; name: string; licence_no: string; licence_expiry: string }>(
        `SELECT id, name, licence_no, licence_expiry FROM sec_guards
         WHERE org_id = $1 AND status <> 'left' AND licence_expiry <= $2::date + $3::int`,
        [s.orgId, s.today, limit],
      );
      const tr = await db.rows<{ id: string; name: string; course: string; valid_to: string }>(
        `SELECT g.id, g.name, t.course, t.valid_to FROM sec_guard_training t JOIN sec_guards g ON g.id = t.guard_id
         WHERE g.org_id = $1 AND g.status <> 'left' AND t.valid_to <= $2::date + $3::int
           AND NOT EXISTS (SELECT 1 FROM sec_guard_training n WHERE n.guard_id = t.guard_id AND lower(n.course) = lower(t.course)
                           AND n.valid_to > t.valid_to)`,
        [s.orgId, s.today, limit],
      );
      const alerts = [
        ...lic.map((g) => ({
          guardId: g.id,
          guardName: g.name,
          kind: "licence" as const,
          item: `Licence ${g.licence_no}`,
          expires: g.licence_expiry,
          daysLeft: daysBetween(s.today, g.licence_expiry),
        })),
        ...tr.map((x) => ({
          guardId: x.id,
          guardName: x.name,
          kind: "training" as const,
          item: x.course,
          expires: x.valid_to,
          daysLeft: daysBetween(s.today, x.valid_to),
        })),
      ].sort((a, b) => a.daysLeft - b.daysLeft || a.guardName.localeCompare(b.guardName));
      return { windowDays: limit, alerts };
    },

    // ---------------------------------------------------------------- equipment
    async listEquipment(s: OrgScope) {
      const ids = await db.rows<{ id: string }>("SELECT id FROM sec_equipment WHERE org_id = $1 ORDER BY code", [
        s.orgId,
      ]);
      const list = [];
      for (const r of ids) list.push(await equipment(db, s.orgId, r.id));
      return { equipment: list };
    },

    async createEquipment(s: OrgScope, b: Body<typeof security.createEquipment>) {
      return db.tx(async (t) => {
        const id = newId("seq");
        try {
          await t.run(
            "INSERT INTO sec_equipment (id, org_id, code, kind, description, status) VALUES ($1,$2,$3,$4,$5,'in_store')",
            [id, s.orgId, b.code, b.kind, b.description],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw fail.conflict(`Item ${b.code} already exists`);
          throw e;
        }
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Equipment added", target: b.code });
        return equipment(t, s.orgId, id);
      });
    },

    async issueEquipment(s: OrgScope, equipmentId: string, guardId: string) {
      return db.tx(async (t) => {
        const e = await t.row<EquipmentRow>("SELECT * FROM sec_equipment WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          equipmentId,
        ]);
        if (!e) throw fail.notFound("Equipment not found");
        const g = await findGuard(t, s.orgId, guardId);
        if (e.status !== "in_store")
          throw fail.conflict(`${e.code} is ${e.status.replace("_", " ")}, not in the store`);
        if (g.status === "left") throw fail.conflict("This guard has left");
        await t.run(
          "INSERT INTO sec_equipment_issues (id, org_id, equipment_id, guard_id, issued_by) VALUES ($1,$2,$3,$4,$5)",
          [newId("sei"), s.orgId, equipmentId, guardId, s.userId],
        );
        await t.run("UPDATE sec_equipment SET status = 'issued' WHERE id = $1", [equipmentId]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Equipment issued",
          target: e.code,
          detail: g.number,
        });
        return equipment(t, s.orgId, equipmentId);
      });
    },

    async returnEquipment(s: OrgScope, equipmentId: string, condition: "good" | "damaged" | "lost", note: string) {
      return db.tx(async (t) => {
        const e = await t.row<EquipmentRow>("SELECT * FROM sec_equipment WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          equipmentId,
        ]);
        if (!e) throw fail.notFound("Equipment not found");
        const n = await t.run(
          `UPDATE sec_equipment_issues SET returned_at = now(), returned_by = $2, return_condition = $3, note = $4
           WHERE equipment_id = $1 AND returned_at IS NULL`,
          [equipmentId, s.userId, condition, note],
        );
        if (!n) throw fail.conflict(`${e.code} is not issued to anyone`);
        await t.run("UPDATE sec_equipment SET status = $2 WHERE id = $1", [
          equipmentId,
          condition === "lost" ? "lost" : "in_store",
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: condition === "lost" ? "Equipment recorded lost" : "Equipment returned",
          target: e.code,
          detail: `${condition}${note ? " · " + note : ""}`,
        });
        return equipment(t, s.orgId, equipmentId);
      });
    },
  };
}

export type WorkforceService = ReturnType<typeof workforceService>;
