/*
 * Development set-up: rules and approval limits, cost codes, projects with phases, buildings, floors and units,
 * unit stock (blocking), price lists (approved by someone other than the preparer), milestones (one marks practical
 * completion), the legal register and document records. Every change is audited.
 */
import { roleCan, type development, type z } from "@paltas/contracts";
import { requireAllowance, type OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { CoreServices } from "../../../core/core-services.js";
import { ensureAccounts } from "../../../core/ledger/default-chart.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import { DEV_ACCOUNTS } from "../accounts.js";
import {
  findProject,
  findUnit,
  requireDocument,
  toUnit,
  UNIT_SELECT,
  type ProjectRow,
  type UnitRow,
} from "../shared/records.js";
import { ensureDefaults, settingsOut } from "../shared/rules.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Out<T extends z.ZodType> = z.input<T>;

const SOLD = ["sold", "handed_over"];

interface MilestoneRow {
  id: string;
  project_id: string;
  phase_id: string | null;
  name: string;
  due_date: string | null;
  forecast_date: string | null;
  completed_date: string | null;
  percent: number | null;
  status: string | null;
  practical_completion: boolean;
}

const toMilestone = (m: MilestoneRow): Out<typeof development.Milestone> => ({
  id: m.id,
  projectId: m.project_id,
  phaseId: m.phase_id,
  name: m.name,
  dueDate: m.due_date,
  forecastDate: m.forecast_date,
  completedDate: m.completed_date,
  percent: m.percent,
  status: m.status,
  practicalCompletion: m.practical_completion,
});

interface PriceListRow {
  id: string;
  number: string;
  project_id: string;
  status: "draft" | "approved" | "rejected";
  effective_date: string;
  note: string;
  prepared_by: string;
  approved_by: string | null;
}

/** The legal register's status follows the expiry date: expired, renew within 60 days, otherwise valid. */
const RENEW_WITHIN_DAYS = 60;

export function setupService(core: CoreServices) {
  const { db } = core;

  async function projectOut(d: Db, p: ProjectRow): Promise<Out<typeof development.Project>> {
    const c = await d.row<{ units: number; sold: number }>(
      `SELECT count(*)::int AS units, count(*) FILTER (WHERE status = ANY($2))::int AS sold
       FROM dev_units WHERE project_id = $1`,
      [p.id, SOLD],
    );
    return {
      id: p.id,
      name: p.name,
      code: p.code,
      location: p.location,
      status: p.status,
      stage: p.stage,
      progressPct: p.progress_pct,
      startDate: p.start_date,
      endDate: p.end_date,
      forecastEndDate: p.forecast_end_date,
      unitCount: c?.units ?? 0,
      soldCount: c?.sold ?? 0,
      migrated: p.source_system !== null,
    };
  }

  async function detail(d: Db, orgId: string, id: string): Promise<Out<typeof development.ProjectDetail>> {
    const p = await findProject(d, orgId, id);
    const phases = await d.rows<{ id: string; name: string; start_date: string | null; end_date: string | null }>(
      "SELECT * FROM dev_phases WHERE project_id = $1 ORDER BY start_date NULLS LAST, name",
      [id],
    );
    const buildings = await d.rows<{ id: string; name: string; phase_id: string | null; floors_count: number | null }>(
      "SELECT * FROM dev_buildings WHERE project_id = $1 ORDER BY name",
      [id],
    );
    const counts = await d.rows<{ status: string; n: number }>(
      "SELECT COALESCE(status, 'available') AS status, count(*)::int AS n FROM dev_units WHERE project_id = $1 GROUP BY 1",
      [id],
    );
    const milestones = await d.rows<MilestoneRow>(
      "SELECT * FROM dev_milestones WHERE project_id = $1 ORDER BY due_date NULLS LAST, name",
      [id],
    );
    return {
      ...(await projectOut(d, p)),
      phases: phases.map((x) => ({ id: x.id, name: x.name, startDate: x.start_date, endDate: x.end_date })),
      buildings: buildings.map((b) => ({ id: b.id, name: b.name, phaseId: b.phase_id, floorsCount: b.floors_count })),
      unitsByStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      milestones: milestones.map(toMilestone),
    };
  }

  // ---------------------------------------------------------------- settings
  async function updateSettings(s: OrgScope, b: Body<typeof development.updateSettings>) {
    return db.tx(async (t) => {
      await ensureDefaults(t, s.orgId);
      const before = await settingsOut(t, s.orgId);
      const set: [string, unknown][] = [];
      if (b.reservationDays !== undefined) set.push(["reservation_days", b.reservationDays]);
      if (b.priceToleranceBp !== undefined) set.push(["price_tolerance_bp", b.priceToleranceBp]);
      if (b.bankHoldHours !== undefined) set.push(["bank_hold_hours", b.bankHoldHours]);
      if (b.offerRules) {
        const r = b.offerRules;
        if (r.executiveDiscountBp < r.managerDiscountBp || r.executiveMaxMonths < r.managerMaxMonths)
          throw fail.invalid("The chief executive's level must be at or above the sales manager's");
        set.push(
          ["manager_discount_bp", r.managerDiscountBp],
          ["executive_discount_bp", r.executiveDiscountBp],
          ["min_deposit_bp", r.minDepositBp],
          ["manager_max_months", r.managerMaxMonths],
          ["executive_max_months", r.executiveMaxMonths],
        );
      }
      if (set.length)
        await t.run(
          `UPDATE dev_settings SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(", ")}, updated_by = $${set.length + 2},
             updated_at = now() WHERE org_id = $1`,
          [s.orgId, ...set.map(([, v]) => v), s.userId],
        );
      if (b.limits) {
        const seen = new Set<string>();
        for (const l of b.limits) {
          const k = `${l.kind}:${l.role}`;
          if (seen.has(k)) throw fail.invalid(`Two limits for ${l.role} on ${l.kind}`);
          seen.add(k);
          if (!roleCan(l.role, "developer.approve"))
            throw fail.invalid(`The ${l.role} role cannot approve spend, so it cannot have a limit`);
        }
        await t.run("DELETE FROM dev_approval_limits WHERE org_id = $1", [s.orgId]);
        for (const l of b.limits)
          await t.run("INSERT INTO dev_approval_limits (org_id, kind, role, limit_minor) VALUES ($1, $2, $3, $4)", [
            s.orgId,
            l.kind,
            l.role,
            l.limitMinor,
          ]);
      }
      if (b.costCodes) {
        await ensureAccounts(t, s.orgId, DEV_ACCOUNTS);
        for (const c of b.costCodes) {
          const a = await t.row<{ type: string; active: boolean }>(
            "SELECT type, active FROM ledger_accounts WHERE org_id = $1 AND code = $2",
            [s.orgId, c.account],
          );
          if (!a || !a.active || !["asset", "expense"].includes(a.type))
            throw fail.invalid(
              `Cost code ${c.code}: account ${c.account} must be an active asset (WIP) or expense account`,
            );
          await t.run(
            `INSERT INTO dev_cost_codes (org_id, code, name, account_code, active) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (org_id, code) DO UPDATE SET name = $3, account_code = $4, active = $5`,
            [s.orgId, c.code, c.name, c.account, c.active],
          );
        }
      }
      const after = await settingsOut(t, s.orgId);
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Development rules changed", before, after });
      return after;
    });
  }

  // ---------------------------------------------------------------- projects
  async function createProject(s: OrgScope, b: Body<typeof development.createProject>) {
    requireAllowance(s);
    return db.tx(async (t) => {
      await ensureDefaults(t, s.orgId);
      const dup = await t.row("SELECT 1 FROM dev_projects WHERE org_id = $1 AND lower(name) = lower($2)", [
        s.orgId,
        b.name,
      ]);
      if (dup) throw fail.conflict("A project with this name already exists");
      if (b.startDate && b.endDate && b.endDate < b.startDate)
        throw fail.invalid("Completion must be after the start date");
      const id = newId("dpj");
      await t.run(
        `INSERT INTO dev_projects (id, org_id, name, code, location, status, stage, progress_pct, start_date, end_date,
           forecast_end_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          s.orgId,
          b.name,
          b.code ?? null,
          b.location ?? null,
          b.status ?? "planning",
          b.stage ?? null,
          b.progressPct ?? 0,
          b.startDate ?? null,
          b.endDate ?? null,
          b.forecastEndDate ?? b.endDate ?? null,
        ],
      );
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Project created", target: id, detail: b.name });
      return detail(t, s.orgId, id);
    });
  }

  async function updateProject(s: OrgScope, id: string, b: Body<typeof development.updateProject>) {
    return db.tx(async (t) => {
      const p = await findProject(t, s.orgId, id, true);
      const cols: Record<string, unknown> = {
        name: b.name,
        code: b.code,
        location: b.location,
        status: b.status,
        stage: b.stage,
        progress_pct: b.progressPct,
        start_date: b.startDate,
        end_date: b.endDate,
        forecast_end_date: b.forecastEndDate,
      };
      const set = Object.entries(cols).filter(([, v]) => v !== undefined);
      if (!set.length) throw fail.invalid("Nothing to change");
      await t.run(`UPDATE dev_projects SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [
        id,
        ...set.map(([, v]) => v),
      ]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Project updated",
        target: id,
        before: p,
        after: Object.fromEntries(set),
      });
      return detail(t, s.orgId, id);
    });
  }

  async function createPhase(s: OrgScope, projectId: string, b: Body<typeof development.createPhase>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      await t.run(
        "INSERT INTO dev_phases (id, org_id, project_id, name, start_date, end_date) VALUES ($1, $2, $3, $4, $5, $6)",
        [newId("dph"), s.orgId, projectId, b.name, b.startDate ?? null, b.endDate ?? null],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Phase added",
        target: projectId,
        detail: b.name,
      });
      return detail(t, s.orgId, projectId);
    });
  }

  async function createBuilding(s: OrgScope, projectId: string, b: Body<typeof development.createBuilding>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      if (b.phaseId) {
        const ph = await t.row("SELECT 1 FROM dev_phases WHERE project_id = $1 AND id = $2", [projectId, b.phaseId]);
        if (!ph) throw fail.invalid("That phase is not in this project");
      }
      const id = newId("dbl");
      await t.run(
        "INSERT INTO dev_buildings (id, org_id, project_id, phase_id, name, floors_count) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, s.orgId, projectId, b.phaseId ?? null, b.name, b.floorsCount],
      );
      for (let level = 1; level <= b.floorsCount; level++)
        await t.run("INSERT INTO dev_floors (id, org_id, building_id, level, name) VALUES ($1, $2, $3, $4, $5)", [
          newId("dfl"),
          s.orgId,
          id,
          level,
          `Level ${level}`,
        ]);
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Building added", target: id, detail: b.name });
      return detail(t, s.orgId, projectId);
    });
  }

  async function createUnits(s: OrgScope, projectId: string, b: Body<typeof development.createUnits>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId, true); // one unit-number check at a time per project
      const existing = new Set(
        (
          await t.rows<{ n: string }>("SELECT lower(unit_no) AS n FROM dev_units WHERE project_id = $1", [projectId])
        ).map((r) => r.n),
      );
      const ids: string[] = [];
      for (const u of b.units) {
        const key = u.unitNo.toLowerCase();
        if (existing.has(key)) throw fail.conflict(`Unit ${u.unitNo} already exists in this project`);
        existing.add(key);
        let floorId: string | null = null;
        if (u.buildingId) {
          const bl = await t.row("SELECT 1 FROM dev_buildings WHERE project_id = $1 AND id = $2", [
            projectId,
            u.buildingId,
          ]);
          if (!bl) throw fail.invalid(`Unit ${u.unitNo}: that building is not in this project`);
          if (u.level !== undefined && u.level !== null) {
            const f = await t.row<{ id: string }>("SELECT id FROM dev_floors WHERE building_id = $1 AND level = $2", [
              u.buildingId,
              u.level,
            ]);
            if (!f) throw fail.invalid(`Unit ${u.unitNo}: the building has no level ${u.level}`);
            floorId = f.id;
          }
        } else if (u.level !== undefined && u.level !== null) throw fail.invalid(`Unit ${u.unitNo}: give the building`);
        const id = newId("dun");
        ids.push(id);
        await t.run(
          `INSERT INTO dev_units (id, org_id, project_id, building_id, floor_id, unit_no, type, bedrooms, area_sqm,
             list_price_minor, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'available')`,
          [
            id,
            s.orgId,
            projectId,
            u.buildingId ?? null,
            floorId,
            u.unitNo,
            u.type ?? null,
            u.bedrooms ?? null,
            u.areaSqm ?? null,
            u.listPriceMinor,
          ],
        );
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Units added",
        target: projectId,
        detail: `${ids.length} unit(s)`,
      });
      const rows = await t.rows<UnitRow>(`${UNIT_SELECT} WHERE u.id = ANY($1) ORDER BY u.unit_no`, [ids]);
      return { units: rows.map(toUnit) };
    });
  }

  async function listUnits(s: OrgScope, projectId: string, status?: string) {
    await findProject(db, s.orgId, projectId);
    const rows = await db.rows<UnitRow>(
      `${UNIT_SELECT} WHERE u.org_id = $1 AND u.project_id = $2 AND ($3::text IS NULL OR COALESCE(u.status, 'available') = $3)
       ORDER BY u.unit_no`,
      [s.orgId, projectId, status ?? null],
    );
    return { units: rows.map(toUnit) };
  }

  async function setBlocked(s: OrgScope, unitId: string, blocked: boolean, reason: string) {
    return db.tx(async (t) => {
      const u = await findUnit(t, s.orgId, unitId, true);
      if (blocked && u.status !== "available")
        throw fail.conflict(`Unit ${u.unit_no} is ${u.status} — only an available unit can be blocked`);
      if (!blocked && u.status !== "blocked") throw fail.conflict(`Unit ${u.unit_no} is not blocked`);
      const status = blocked ? "blocked" : "available";
      await t.run("UPDATE dev_units SET status = $2 WHERE id = $1", [unitId, status]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: blocked ? "Unit taken off sale" : "Unit back on sale",
        target: unitId,
        detail: reason,
      });
      return toUnit({ ...u, status });
    });
  }

  // ---------------------------------------------------------------- price lists
  async function priceListOut(d: Db, l: PriceListRow): Promise<Out<typeof development.PriceList>> {
    const items = await d.rows<{
      unit_id: string;
      unit_no: string;
      old_price_minor: number | null;
      price_minor: number;
    }>(
      `SELECT i.*, u.unit_no FROM dev_price_list_items i JOIN dev_units u ON u.id = i.unit_id
       WHERE i.price_list_id = $1 ORDER BY u.unit_no`,
      [l.id],
    );
    return {
      id: l.id,
      number: l.number,
      projectId: l.project_id,
      status: l.status,
      effectiveDate: l.effective_date,
      note: l.note,
      preparedBy: l.prepared_by,
      approvedBy: l.approved_by,
      items: items.map((i) => ({
        unitId: i.unit_id,
        unitNo: i.unit_no,
        oldPriceMinor: i.old_price_minor,
        priceMinor: i.price_minor,
      })),
    };
  }

  async function createPriceList(s: OrgScope, projectId: string, b: Body<typeof development.createPriceList>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      const id = newId("dpl");
      await t.run(
        `INSERT INTO dev_price_lists (id, org_id, number, project_id, effective_date, note, status, prepared_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)`,
        [id, s.orgId, await nextNumber(t, s.orgId, "PL"), projectId, b.effectiveDate, b.note, s.userId],
      );
      const seen = new Set<string>();
      for (const it of b.items) {
        if (seen.has(it.unitId)) throw fail.invalid("A unit appears twice in the price list");
        seen.add(it.unitId);
        const u = await findUnit(t, s.orgId, it.unitId);
        if (u.project_id !== projectId) throw fail.invalid(`Unit ${u.unit_no} is not in this project`);
        if (!["available", "blocked"].includes(u.status))
          throw fail.conflict(`Unit ${u.unit_no} is ${u.status} — a price list covers unsold stock only`);
        await t.run(
          "INSERT INTO dev_price_list_items (price_list_id, unit_id, old_price_minor, price_minor) VALUES ($1, $2, $3, $4)",
          [id, it.unitId, u.list_price_minor, it.priceMinor],
        );
      }
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Price list prepared", target: id });
      return priceListOut(
        t,
        (await t.row<PriceListRow>("SELECT * FROM dev_price_lists WHERE id = $1", [id])) as PriceListRow,
      );
    });
  }

  async function listPriceLists(s: OrgScope, projectId: string) {
    await findProject(db, s.orgId, projectId);
    const rows = await db.rows<PriceListRow>(
      "SELECT * FROM dev_price_lists WHERE org_id = $1 AND project_id = $2 ORDER BY number",
      [s.orgId, projectId],
    );
    return { priceLists: await Promise.all(rows.map((l) => priceListOut(db, l))) };
  }

  async function decidePriceList(s: OrgScope, id: string, approve: boolean, reason?: string) {
    return db.tx(async (t) => {
      const l = await t.row<PriceListRow>("SELECT * FROM dev_price_lists WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        id,
      ]);
      if (!l) throw fail.notFound("Price list not found");
      if (l.status !== "draft") throw fail.conflict(`The price list is already ${l.status}`);
      if (l.prepared_by === s.userId)
        throw fail.separationOfDuties("You prepared this price list — someone else approves it");
      if (!approve) {
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason for rejecting (at least 5 characters)");
        await t.run(
          "UPDATE dev_price_lists SET status = 'rejected', approved_by = $2, decided_at = now(), reason = $3 WHERE id = $1",
          [id, s.userId, reason],
        );
      } else {
        const items = await t.rows<{ unit_id: string; price_minor: number }>(
          "SELECT unit_id, price_minor FROM dev_price_list_items WHERE price_list_id = $1",
          [id],
        );
        for (const it of items) {
          const u = await findUnit(t, s.orgId, it.unit_id, true);
          // a unit sold since the list was prepared keeps the price it was sold at
          if (!["available", "blocked"].includes(u.status)) continue;
          await t.run(
            "UPDATE dev_price_list_items SET old_price_minor = $3 WHERE price_list_id = $1 AND unit_id = $2",
            [id, u.id, u.list_price_minor],
          );
          await t.run("UPDATE dev_units SET list_price_minor = $2 WHERE id = $1", [u.id, it.price_minor]);
        }
        await t.run(
          "UPDATE dev_price_lists SET status = 'approved', approved_by = $2, decided_at = now() WHERE id = $1",
          [id, s.userId],
        );
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: approve ? "Price list approved" : "Price list rejected",
        target: id,
        detail: reason ?? "",
      });
      return priceListOut(
        t,
        (await t.row<PriceListRow>("SELECT * FROM dev_price_lists WHERE id = $1", [id])) as PriceListRow,
      );
    });
  }

  // ---------------------------------------------------------------- milestones
  async function createMilestone(s: OrgScope, projectId: string, b: Body<typeof development.createMilestone>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      if (b.practicalCompletion) {
        const pc = await t.row("SELECT 1 FROM dev_milestones WHERE project_id = $1 AND practical_completion", [
          projectId,
        ]);
        if (pc) throw fail.conflict("This project already has a practical-completion milestone");
      }
      const id = newId("dms");
      await t.run(
        `INSERT INTO dev_milestones (id, org_id, project_id, phase_id, name, due_date, forecast_date, percent, status,
           practical_completion) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'planned', $8)`,
        [
          id,
          s.orgId,
          projectId,
          b.phaseId ?? null,
          b.name,
          b.dueDate,
          b.forecastDate ?? b.dueDate,
          b.practicalCompletion,
        ],
      );
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Milestone added", target: id, detail: b.name });
      return toMilestone(
        (await t.row<MilestoneRow>("SELECT * FROM dev_milestones WHERE id = $1", [id])) as MilestoneRow,
      );
    });
  }

  async function updateMilestone(s: OrgScope, id: string, b: Body<typeof development.updateMilestone>) {
    return db.tx(async (t) => {
      const m = await t.row<MilestoneRow>("SELECT * FROM dev_milestones WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        id,
      ]);
      if (!m) throw fail.notFound("Milestone not found");
      if (b.completedDate && b.completedDate > s.today)
        throw fail.invalid("A milestone cannot be completed in the future");
      const completed = b.completedDate === undefined ? m.completed_date : b.completedDate;
      const percent = completed ? 100 : (b.percent ?? m.percent ?? 0);
      const status = completed ? "completed" : percent > 0 ? "in_progress" : "planned";
      await t.run(
        "UPDATE dev_milestones SET forecast_date = $2, percent = $3, completed_date = $4, status = $5 WHERE id = $1",
        [id, b.forecastDate === undefined ? m.forecast_date : b.forecastDate, percent, completed, status],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: completed && !m.completed_date ? "Milestone completed" : "Milestone updated",
        target: id,
        detail: m.name,
      });
      return toMilestone(
        (await t.row<MilestoneRow>("SELECT * FROM dev_milestones WHERE id = $1", [id])) as MilestoneRow,
      );
    });
  }

  // ---------------------------------------------------------------- documents and legal register
  const LINK_TABLES: Record<string, string> = {
    project: "dev_projects",
    unit: "dev_units",
    buyer: "dev_contacts",
    contract: "dev_contracts",
    reservation: "dev_reservations",
    supplier: "dev_suppliers",
    purchase_order: "dev_purchase_orders",
    invoice: "dev_supplier_invoices",
    handover: "dev_handovers",
  };

  interface DocRow {
    id: string;
    filename: string;
    size_bytes: number;
    sha256: string;
    detected_type: string;
    kind: string | null;
    link_entity: string | null;
    link_id: string | null;
    uploaded_by: string | null;
    source_system: string | null;
    created_at: string;
  }
  const toDoc = (d: DocRow): Out<typeof development.DocumentRecord> => ({
    id: d.id,
    filename: d.filename,
    sizeBytes: d.size_bytes,
    sha256: d.sha256,
    contentType: d.detected_type,
    kind: d.kind,
    linkEntity: d.link_entity,
    linkId: d.link_id,
    uploadedBy: d.uploaded_by,
    migrated: d.source_system !== null,
    createdAt: d.created_at,
  });

  async function registerDocument(s: OrgScope, b: Body<typeof development.registerDocument>) {
    if ((b.linkEntity === undefined) !== (b.linkId === undefined))
      throw fail.invalid("Give both what the document belongs to and its id, or neither");
    return db.tx(async (t) => {
      if (b.linkEntity && b.linkId) {
        const table = LINK_TABLES[b.linkEntity] ?? "";
        const r = await t.row(`SELECT 1 FROM ${table} WHERE org_id = $1 AND id = $2`, [s.orgId, b.linkId]);
        if (!r) throw fail.notFound(`No such ${b.linkEntity.replace("_", " ")}`);
      }
      const id = newId("ddc");
      await t.run(
        `INSERT INTO dev_documents (id, org_id, file_id, filename, size_bytes, sha256, detected_type, original_ref,
           link_entity, link_id, kind, uploaded_by) VALUES ($1, $2, NULL, $3, $4, $5, $6, 'paltas', $7, $8, $9, $10)`,
        [
          id,
          s.orgId,
          b.filename,
          b.sizeBytes,
          b.sha256,
          b.contentType,
          b.linkEntity ?? null,
          b.linkId ?? null,
          b.kind,
          s.userId,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Document recorded",
        target: id,
        detail: b.filename,
      });
      return toDoc((await t.row<DocRow>("SELECT * FROM dev_documents WHERE id = $1", [id])) as DocRow);
    });
  }

  async function listDocuments(s: OrgScope, q: { linkEntity?: string | undefined; linkId?: string | undefined }) {
    const rows = await db.rows<DocRow>(
      `SELECT * FROM dev_documents WHERE org_id = $1 AND ($2::text IS NULL OR link_entity = $2)
         AND ($3::text IS NULL OR link_id = $3) ORDER BY created_at, filename`,
      [s.orgId, q.linkEntity ?? null, q.linkId ?? null],
    );
    return { documents: rows.map(toDoc) };
  }

  interface LegalRow {
    id: string;
    project_id: string;
    title: string;
    kind: Out<typeof development.LegalItem>["kind"];
    expiry_date: string | null;
    in_progress: boolean;
    document_id: string | null;
  }
  const toLegal = (l: LegalRow, today: string): Out<typeof development.LegalItem> => ({
    id: l.id,
    projectId: l.project_id,
    title: l.title,
    kind: l.kind,
    expiryDate: l.expiry_date,
    status: l.in_progress
      ? "in_progress"
      : l.expiry_date && l.expiry_date < today
        ? "expired"
        : l.expiry_date && l.expiry_date <= addDays(today, RENEW_WITHIN_DAYS)
          ? "renew"
          : "valid",
    documentId: l.document_id,
  });

  async function listLegal(s: OrgScope, projectId?: string) {
    const rows = await db.rows<LegalRow>(
      `SELECT * FROM dev_legal_items WHERE org_id = $1 AND ($2::text IS NULL OR project_id = $2)
       ORDER BY expiry_date NULLS LAST, title`,
      [s.orgId, projectId ?? null],
    );
    return { items: rows.map((l) => toLegal(l, s.today)) };
  }

  async function createLegal(s: OrgScope, b: Body<typeof development.createLegal>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, b.projectId);
      if (b.documentId) await requireDocument(t, s.orgId, b.documentId);
      const id = newId("dlg");
      await t.run(
        `INSERT INTO dev_legal_items (id, org_id, project_id, title, kind, expiry_date, in_progress, document_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, s.orgId, b.projectId, b.title, b.kind, b.expiryDate ?? null, b.inProgress, b.documentId ?? null, s.userId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Legal register item added",
        target: id,
        detail: b.title,
      });
      return toLegal((await t.row<LegalRow>("SELECT * FROM dev_legal_items WHERE id = $1", [id])) as LegalRow, s.today);
    });
  }

  async function listProjects(s: OrgScope) {
    const rows = await db.rows<ProjectRow>("SELECT * FROM dev_projects WHERE org_id = $1 ORDER BY name", [s.orgId]);
    return { projects: await Promise.all(rows.map((p) => projectOut(db, p))) };
  }

  return {
    settings: async (s: OrgScope) => {
      await db.tx((t) => ensureDefaults(t, s.orgId));
      return settingsOut(db, s.orgId);
    },
    updateSettings,
    listProjects,
    getProject: (s: OrgScope, id: string) => detail(db, s.orgId, id),
    createProject,
    updateProject,
    createPhase,
    createBuilding,
    createUnits,
    listUnits,
    setBlocked,
    createPriceList,
    listPriceLists,
    decidePriceList,
    createMilestone,
    updateMilestone,
    registerDocument,
    listDocuments,
    listLegal,
    createLegal,
  };
}

export type SetupService = ReturnType<typeof setupService>;
