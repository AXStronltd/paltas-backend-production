/*
 * Work: tasks (yours, or the team's for managers), after-sales requests from buyers with a signed contract, and
 * defects (each with a task for the person fixing it; closing needs someone other than the person who fixed it).
 */
import type { development, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import { can } from "../shared/access.js";
import { createTask, findBuyer, findProject, findUnit, requireMember } from "../shared/records.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Out<T extends z.ZodType> = z.input<T>;

/** After-sales requests are due this many days after they are recorded. */
const AFTERSALES_DAYS = 3;

interface TaskRow {
  id: string;
  title: string;
  description: string;
  due_date: string;
  priority: Out<typeof development.Task>["priority"];
  status: Out<typeof development.Task>["status"];
  category: Out<typeof development.Task>["category"];
  assignee_user_id: string;
  created_by: string | null;
  buyer_id: string | null;
  unit_id: string | null;
  project_id: string | null;
  contract_id: string | null;
}

const toTask = (t: TaskRow): Out<typeof development.Task> => ({
  id: t.id,
  title: t.title,
  description: t.description,
  dueDate: t.due_date,
  priority: t.priority,
  status: t.status,
  category: t.category,
  assigneeUserId: t.assignee_user_id,
  createdBy: t.created_by,
  links: { buyerId: t.buyer_id, unitId: t.unit_id, projectId: t.project_id, contractId: t.contract_id },
});

interface DefectRow {
  id: string;
  unit_id: string;
  handover_id: string | null;
  contractor_id: string | null;
  reported_date: string;
  description: string;
  status: "open" | "fixed" | "closed";
  fixed_date: string | null;
  fixed_by: string | null;
  task_id: string | null;
}

const toDefect = (d: DefectRow): Out<typeof development.Defect> => ({
  id: d.id,
  unitId: d.unit_id,
  handoverId: d.handover_id,
  contractorId: d.contractor_id,
  reportedDate: d.reported_date,
  description: d.description,
  status: d.status,
  fixedDate: d.fixed_date,
  taskId: d.task_id,
});

/** Managers see and assign the team's tasks. */
const manages = (s: OrgScope) =>
  can(s, "developer.sales.manage") ||
  can(s, "developer.executive") ||
  can(s, "developer.projects") ||
  can(s, "developer.budget");

export function workService(core: CoreServices) {
  const { db } = core;
  const load = async (t: Db, id: string) =>
    toTask((await t.row<TaskRow>("SELECT * FROM dev_tasks WHERE id = $1", [id])) as TaskRow);

  async function listTasks(s: OrgScope, view: "mine" | "team" | "overdue" | "done") {
    const team = manages(s) && view !== "mine";
    const rows = await db.rows<TaskRow>(
      `SELECT * FROM dev_tasks WHERE org_id = $1
         AND ($2 OR assignee_user_id = $3 OR created_by = $3)
         AND CASE $4 WHEN 'done' THEN status <> 'open' WHEN 'overdue' THEN status = 'open' AND due_date < $5
                     ELSE status = 'open' END
         AND ($4 <> 'mine' OR assignee_user_id = $3)
       ORDER BY due_date, created_at`,
      [s.orgId, team, s.userId, view, s.today],
    );
    return { tasks: rows.map(toTask) };
  }

  async function create(s: OrgScope, b: Body<typeof development.createTask>) {
    return db.tx(async (t) => {
      const assignee = b.assigneeUserId ?? s.userId;
      if (assignee !== s.userId && !manages(s))
        throw fail.forbidden("You can create tasks for yourself — ask a manager to assign others");
      await requireMember(t, s.orgId, assignee);
      if (b.buyerId) await findBuyer(t, s, b.buyerId);
      if (b.unitId) await findUnit(t, s.orgId, b.unitId);
      if (b.projectId) await findProject(t, s.orgId, b.projectId);
      const id = await createTask(t, s.orgId, {
        title: b.title,
        description: b.description,
        dueDate: b.dueDate,
        priority: b.priority,
        category: b.category,
        assignee,
        createdBy: s.userId,
        buyerId: b.buyerId ?? null,
        unitId: b.unitId ?? null,
        projectId: b.projectId ?? null,
      });
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Task created", target: id, detail: b.title });
      return load(t, id);
    });
  }

  async function complete(s: OrgScope, id: string, note?: string) {
    return db.tx(async (t) => {
      const k = await t.row<TaskRow>("SELECT * FROM dev_tasks WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, id]);
      if (!k) throw fail.notFound("Task not found");
      if (k.assignee_user_id !== s.userId && k.created_by !== s.userId && !manages(s))
        throw fail.notFound("Task not found");
      if (k.status !== "open") throw fail.conflict(`The task is already ${k.status}`);
      await t.run("UPDATE dev_tasks SET status = 'done', done_at = now(), done_by = $2, note = $3 WHERE id = $1", [
        id,
        s.userId,
        note ?? null,
      ]);
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Task completed", target: id, detail: k.title });
      return load(t, id);
    });
  }

  async function afterSales(s: OrgScope, buyerId: string, b: Body<typeof development.afterSalesRequest>) {
    return db.tx(async (t) => {
      const buyer = await findBuyer(t, s, buyerId);
      const k = await t.row<{ id: string; unit_id: string; project_id: string }>(
        `SELECT k.id, k.unit_id, u.project_id FROM dev_contracts k JOIN dev_units u ON u.id = k.unit_id
         WHERE k.buyer_id = $1 AND k.status IS DISTINCT FROM 'cancelled' ORDER BY k.date DESC LIMIT 1`,
        [buyerId],
      );
      if (!k) throw fail.conflict("After-sales support is for buyers with a signed contract");
      const id = await createTask(t, s.orgId, {
        title: `After-sales: ${b.title}`,
        description: b.description,
        dueDate: addDays(s.today, AFTERSALES_DAYS),
        priority: b.priority,
        category: "aftersales",
        assignee: buyer.agent_user_id ?? s.userId,
        createdBy: s.userId,
        buyerId,
        unitId: k.unit_id,
        projectId: k.project_id,
        contractId: k.id,
        key: `aftersales:${buyerId}:${b.title.toLowerCase()}`,
      });
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "After-sales request",
        target: buyerId,
        detail: b.title,
      });
      return load(t, id);
    });
  }

  // ---------------------------------------------------------------- defects
  const loadDefect = async (t: Db, id: string) =>
    toDefect((await t.row<DefectRow>("SELECT * FROM dev_defects WHERE id = $1", [id])) as DefectRow);

  async function listDefects(s: OrgScope, q: { unitId?: string | undefined; status?: string | undefined }) {
    const rows = await db.rows<DefectRow>(
      `SELECT * FROM dev_defects WHERE org_id = $1 AND ($2::text IS NULL OR unit_id = $2)
         AND ($3::text IS NULL OR COALESCE(status, 'open') = $3) ORDER BY reported_date, id`,
      [s.orgId, q.unitId ?? null, q.status ?? null],
    );
    return { defects: rows.map((d) => toDefect({ ...d, status: d.status ?? "open" })) };
  }

  async function reportDefect(s: OrgScope, unitId: string, b: Body<typeof development.reportDefect>) {
    return db.tx(async (t) => {
      const u = await findUnit(t, s.orgId, unitId);
      if (b.contractorId) {
        const c = await t.row("SELECT 1 FROM dev_suppliers WHERE org_id = $1 AND id = $2", [s.orgId, b.contractorId]);
        if (!c) throw fail.invalid("Unknown contractor");
      }
      await requireMember(t, s.orgId, b.assigneeUserId);
      const h = await t.row<{ id: string }>(
        "SELECT id FROM dev_handovers WHERE unit_id = $1 ORDER BY (status = 'completed') DESC, date DESC LIMIT 1",
        [unitId],
      );
      const id = newId("ddf");
      const taskId = await createTask(t, s.orgId, {
        title: `Fix defect · unit ${u.unit_no}: ${b.description.slice(0, 80)}`,
        description: b.description,
        dueDate: b.dueDate,
        priority: "high",
        category: "site",
        assignee: b.assigneeUserId,
        createdBy: s.userId,
        unitId,
        projectId: u.project_id,
        key: `defect:${id}`,
      });
      await t.run(
        `INSERT INTO dev_defects (id, org_id, unit_id, handover_id, contractor_id, reported_date, description, status, task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)`,
        [id, s.orgId, unitId, h?.id ?? null, b.contractorId ?? null, s.today, b.description, taskId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Defect recorded",
        target: id,
        detail: `unit ${u.unit_no}`,
      });
      return loadDefect(t, id);
    });
  }

  async function updateDefect(s: OrgScope, id: string, status: "fixed" | "closed" | "open", note?: string) {
    return db.tx(async (t) => {
      const d = await t.row<DefectRow>("SELECT * FROM dev_defects WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        id,
      ]);
      if (!d) throw fail.notFound("Defect not found");
      const cur = d.status ?? "open";
      if (status === "fixed") {
        if (cur !== "open") throw fail.conflict(`The defect is ${cur}`);
        await t.run("UPDATE dev_defects SET status = 'fixed', fixed_date = $2, fixed_by = $3 WHERE id = $1", [
          id,
          s.today,
          s.userId,
        ]);
        if (d.task_id)
          await t.run(
            "UPDATE dev_tasks SET status = 'done', done_at = now(), done_by = $2, note = $3 WHERE id = $1 AND status = 'open'",
            [d.task_id, s.userId, note ?? "fixed"],
          );
      } else if (status === "closed") {
        if (cur !== "fixed") throw fail.conflict("Only a fixed defect can be closed");
        if (d.fixed_by === s.userId)
          throw fail.separationOfDuties("You fixed it — someone else inspects and closes it");
        await t.run("UPDATE dev_defects SET status = 'closed', closed_by = $2 WHERE id = $1", [id, s.userId]);
      } else {
        if (cur !== "fixed") throw fail.conflict("Only a fixed defect can be reopened");
        await t.run("UPDATE dev_defects SET status = 'open', fixed_by = NULL, fixed_date = NULL WHERE id = $1", [id]);
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: `Defect ${status}`,
        target: id,
        detail: note ?? "",
      });
      return loadDefect(t, id);
    });
  }

  return { listTasks, create, complete, afterSales, listDefects, reportDefect, updateDefect };
}

export type WorkService = ReturnType<typeof workService>;
