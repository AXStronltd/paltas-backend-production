/*
 * Maintenance: requests (staff, the tenant portal, inspections) → work orders with supplier quotes → purchase order
 * raised by one person and approved by another within their approval limit (and by the owner above the agreement's
 * authority) → work completed with evidence → checked by a manager (the request is resolved) → billed (bills.service).
 * Inspections record the condition per area; every area needing repair opens a request.
 */
import type { property as P, Role } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit, type Actor } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { settingsOf } from "../setup/setup.service.js";
import { numberScope } from "../shared/money.js";
import * as R from "../shared/records.js";
import { addDays } from "../shared/util.js";
import { formatMoney } from "../../../lib/money.js";
import { orgCurrency } from "../shared/money.js";

interface RequestRow {
  version: number;
  id: string;
  number: string;
  property_id: string;
  unit_id: string | null;
  reporter_id: string | null;
  title: string;
  category: string;
  priority: P.MaintenanceRequest["priority"];
  status: P.MaintenanceRequest["status"];
  source: P.MaintenanceRequest["source"];
  opened_at: string;
  resolved_at: string | null;
  work_order_id: string | null;
}

interface WorkOrderRow {
  id: string;
  number: string;
  property_id: string;
  unit_id: string | null;
  request_id: string | null;
  scope: string;
  priority: P.WorkOrder["priority"];
  status: P.WorkOrder["status"];
  due_date: string;
  po_number: string | null;
  po_supplier_id: string | null;
  po_amount_minor: number | null;
  po_raised_by: string | null;
  po_approved_by: string | null;
  needs_owner: boolean;
  owner_approved_by: string | null;
  completed_by: string | null;
  completed_at: string | null;
  completion_notes: string | null;
  evidence: string[];
  verified_by: string | null;
}

interface InspectionRow {
  id: string;
  number: string;
  property_id: string;
  unit_id: string | null;
  lease_id: string | null;
  kind: "move_in" | "move_out" | "routine";
  scheduled_date: string;
  status: "scheduled" | "completed";
  items: { area: string; condition: "good" | "fair" | "needs_repair" | "damaged"; note: string }[];
  completed_by: string | null;
}

/** Roles that approve purchase orders of any amount (others: the limit in the settings, default none). */
const UNLIMITED: readonly Role[] = ["finance_director", "org_admin"];

const REQUEST_SQL = `SELECT r.*, (SELECT w.id FROM pm_work_orders w WHERE w.request_id = r.id AND w.status <> 'cancelled'
  ORDER BY w.created_at DESC LIMIT 1) AS work_order_id FROM pm_maintenance_requests r`;

const toRequest = (r: RequestRow): P.MaintenanceRequest => ({
  version: r.version,
  id: r.id,
  number: r.number,
  propertyId: r.property_id,
  unitId: r.unit_id,
  reporterId: r.reporter_id,
  title: r.title,
  category: r.category,
  priority: r.priority,
  status: r.status,
  source: r.source,
  openedAt: r.opened_at,
  resolvedAt: r.resolved_at,
  workOrderId: r.work_order_id,
});

export function maintenanceService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  async function requestRow(t: Db, orgId: string, id: string, lock = false): Promise<RequestRow> {
    const r = await t.row<RequestRow>(
      `${REQUEST_SQL} WHERE r.org_id = $1 AND r.id = $2${lock ? " FOR UPDATE OF r" : ""}`,
      [orgId, id],
    );
    if (!r) throw fail.notFound("Maintenance request not found");
    return r;
  }

  async function woRow(t: Db, orgId: string, id: string, lock = false): Promise<WorkOrderRow> {
    const r = await t.row<WorkOrderRow>(
      `SELECT * FROM pm_work_orders WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!r) throw fail.notFound("Work order not found");
    return r;
  }

  async function woViews(rows: WorkOrderRow[], today: string): Promise<P.WorkOrder[]> {
    if (!rows.length) return [];
    const quotes = await db.rows<{
      work_order_id: string;
      supplier_id: string;
      supplier_name: string;
      amount_minor: number;
      days: number | null;
      file_name: string;
    }>(
      `SELECT q.*, c.name AS supplier_name FROM pm_wo_quotes q JOIN contacts c ON c.id = q.supplier_id
       WHERE q.work_order_id = ANY($1) ORDER BY q.amount_minor`,
      [rows.map((r) => r.id)],
    );
    return rows.map((w) => ({
      id: w.id,
      number: w.number,
      propertyId: w.property_id,
      unitId: w.unit_id,
      requestId: w.request_id,
      scope: w.scope,
      priority: w.priority,
      status: w.status,
      dueDate: w.due_date,
      overdue: w.due_date < today && !["completed", "verified", "billed", "cancelled"].includes(w.status),
      quotes: quotes
        .filter((q) => q.work_order_id === w.id)
        .map((q) => ({
          supplierId: q.supplier_id,
          supplierName: q.supplier_name,
          amountMinor: q.amount_minor,
          days: q.days,
          fileName: q.file_name,
        })),
      po:
        w.po_number && w.po_supplier_id && w.po_amount_minor && w.po_raised_by
          ? {
              number: w.po_number,
              supplierId: w.po_supplier_id,
              amountMinor: w.po_amount_minor,
              raisedBy: w.po_raised_by,
              approvedBy: w.po_approved_by,
              needsOwner: w.needs_owner,
              ownerApprovedBy: w.owner_approved_by,
            }
          : null,
      completion:
        w.completed_by && w.completed_at
          ? { by: w.completed_by, at: w.completed_at, notes: w.completion_notes ?? "", evidence: w.evidence }
          : null,
      verifiedBy: w.verified_by,
    }));
  }

  const woView = async (orgId: string, id: string, today: string) =>
    (await woViews([await woRow(db, orgId, id)], today))[0] as P.WorkOrder;

  /** Open a request (inside the caller's transaction). */
  async function openRequest(
    t: Db,
    s: { orgId: string; userId: string },
    b: {
      propertyId: string;
      unitId?: string | null;
      reporterId?: string | null;
      title: string;
      category: string;
      priority: P.MaintenanceRequest["priority"];
      source: P.MaintenanceRequest["source"];
      inspectionId?: string | null;
    },
  ): Promise<string> {
    await R.propertyRow(t, s.orgId, b.propertyId);
    if (b.unitId) {
      const u = await R.unitRow(t, s.orgId, b.unitId);
      if (u.property_id !== b.propertyId) throw fail.invalid("That unit is not in this property");
    }
    if (b.reporterId) await core.contacts.live(t, s.orgId, b.reporterId);
    const id = newId("pmq");
    await t.run(
      `INSERT INTO pm_maintenance_requests (id, org_id, number, property_id, unit_id, reporter_id, title, category, priority,
         status, source, opened_by, inspection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12)`,
      [
        id,
        s.orgId,
        await nextNumber(t, numberScope(s.orgId), "MR", 5),
        b.propertyId,
        b.unitId ?? null,
        b.reporterId ?? null,
        b.title,
        b.category,
        b.priority,
        b.source,
        s.userId,
        b.inspectionId ?? null,
      ],
    );
    if (b.reporterId)
      await core.contacts.activity(t, {
        orgId: s.orgId,
        contactId: b.reporterId,
        kind: "maintenance",
        text: `Maintenance request: ${b.title} (${b.priority})`,
        refType: "maintenance",
        refId: id,
        by: s.userId,
      });
    return id;
  }

  /** Approve a purchase order as staff (limit, second person) or record the owner's approval. */
  async function approvePo(
    t: Db,
    orgId: string,
    id: string,
    by: { userId: string; role: Role | "owner" },
    actor: Actor,
  ) {
    const w = await woRow(t, orgId, id, true);
    if (w.status !== "po_pending" && w.status !== "awaiting_owner")
      throw fail.conflict("This work order has no purchase order waiting for approval");
    if (by.role === "owner") {
      if (!w.needs_owner || w.owner_approved_by) throw fail.conflict("This purchase order does not need the owner");
      await t.run("UPDATE pm_work_orders SET owner_approved_by = $2 WHERE id = $1", [id, by.userId]);
    } else {
      if (w.po_approved_by) throw fail.conflict("The purchase order is already approved by staff");
      if (w.po_raised_by === by.userId)
        throw fail.separationOfDuties("You raised this purchase order — someone else must approve it");
      if (!UNLIMITED.includes(by.role)) {
        const limit = (await settingsOf(t, orgId)).poLimits[by.role] ?? 0;
        if ((w.po_amount_minor ?? 0) > limit)
          throw fail.forbidden(
            `Above your approval limit (${formatMoney(limit, await orgCurrency(t, orgId))}) — the finance director must approve it`,
          );
      }
      await t.run("UPDATE pm_work_orders SET po_approved_by = $2 WHERE id = $1", [id, by.userId]);
    }
    const after = await woRow(t, orgId, id);
    const done = !!after.po_approved_by && (!after.needs_owner || !!after.owner_approved_by);
    const status = done ? "approved" : after.po_approved_by ? "awaiting_owner" : "po_pending";
    await t.run("UPDATE pm_work_orders SET status = $2 WHERE id = $1", [id, status]);
    await recordAudit(t, {
      actor,
      orgId,
      action: by.role === "owner" ? "Purchase order approved by the owner" : "Purchase order approved",
      target: w.po_number ?? w.number,
      detail: done ? "work can start" : "waiting for the owner",
    });
  }

  async function inspectionView(orgId: string, r: InspectionRow) {
    const reqs = await db.rows<{ id: string }>(
      "SELECT id FROM pm_maintenance_requests WHERE org_id = $1 AND inspection_id = $2 ORDER BY opened_at, id",
      [orgId, r.id],
    );
    return {
      id: r.id,
      number: r.number,
      propertyId: r.property_id,
      unitId: r.unit_id,
      leaseId: r.lease_id,
      kind: r.kind,
      scheduledDate: r.scheduled_date,
      status: r.status,
      items: r.items,
      completedBy: r.completed_by,
      requestIds: reqs.map((x) => x.id),
    };
  }

  return {
    openRequest,
    woViews,
    approvePo,
    toRequest,
    REQUEST_SQL,

    async requestHistory(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const r = await requestRow(t, s.orgId, id);
        const where = "org_id=$1 AND target IN ($2,$3) AND action LIKE 'Maintenance request %'";
        const args = [s.orgId, id, r.number];
        const total = await t.row<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, args);
        const entries = await t.rows<{
          id: string;
          at: string;
          action: string;
          detail: string;
          actorRole: string | null;
          before: unknown;
          after: unknown;
        }>(
          `SELECT id::text,at,action,detail,actor_role AS "actorRole",before,after FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $4 OFFSET $5`,
          [...args, q.limit, q.offset],
        );
        return { entries, total: total?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
    async getRequest(s: OrgScope, id: string) {
      return toRequest(await requestRow(db, s.orgId, id));
    },
    async updateRequest(
      s: OrgScope,
      id: string,
      b: {
        expectedVersion: number;
        title: string;
        category: string;
        priority: P.MaintenanceRequest["priority"];
        reason: string;
      },
    ) {
      await db.tx(async (t) => {
        const r = await requestRow(t, s.orgId, id, true);
        if (r.version !== b.expectedVersion)
          throw fail.conflict("This request changed. Reopen it to review the latest details before saving.");
        if (r.status !== "open" && b.priority !== r.priority)
          throw fail.conflict(
            "Reopen a closed request to change its priority. For assigned work, review the work order and its agreed schedule.",
          );
        await t.run("UPDATE pm_maintenance_requests SET title=$3,category=$4,priority=$5 WHERE org_id=$1 AND id=$2", [
          s.orgId,
          id,
          b.title,
          b.category,
          b.priority,
        ]);
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Maintenance request corrected",
          target: id,
          detail: b.reason,
          before: { title: r.title, category: r.category, priority: r.priority, version: r.version },
          after: { title: b.title, category: b.category, priority: b.priority, version: r.version + 1 },
        });
      });
      return toRequest(await requestRow(db, s.orgId, id));
    },
    async reopenRequest(s: OrgScope, id: string, b: { expectedVersion: number; reason: string }) {
      await db.tx(async (t) => {
        const r = await requestRow(t, s.orgId, id, true);
        if (r.version !== b.expectedVersion)
          throw fail.conflict("This request changed. Reopen its details before continuing.");
        if (!["closed", "resolved"].includes(r.status)) throw fail.conflict("This request is already open or assigned");
        await t.run("UPDATE pm_maintenance_requests SET status='open',resolved_at=NULL WHERE org_id=$1 AND id=$2", [
          s.orgId,
          id,
        ]);
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Maintenance request reopened",
          target: id,
          detail: b.reason,
          before: { status: r.status, resolvedAt: r.resolved_at, version: r.version },
          after: { status: "open", resolvedAt: null, version: r.version + 1 },
        });
      });
      return toRequest(await requestRow(db, s.orgId, id));
    },
    async listRequests(
      s: OrgScope,
      f: { status?: P.MaintenanceRequest["status"] | undefined; propertyId?: string | undefined },
    ) {
      const rows = await db.rows<RequestRow>(
        `${REQUEST_SQL} WHERE r.org_id = $1 AND ($2::text IS NULL OR r.status = $2) AND ($3::text IS NULL OR r.property_id = $3)
         ORDER BY r.opened_at DESC`,
        [s.orgId, f.status ?? null, f.propertyId ?? null],
      );
      return { requests: rows.map(toRequest) };
    },

    async createRequest(
      s: OrgScope,
      b: {
        propertyId: string;
        unitId?: string | undefined;
        reporterId?: string | undefined;
        title: string;
        category: string;
        priority: P.MaintenanceRequest["priority"];
      },
    ) {
      const id = await db.tx(async (t) => {
        const id = await openRequest(t, s, { ...b, source: "staff" });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Maintenance request opened",
          target: id,
          detail: b.title,
        });
        return id;
      });
      return toRequest(await requestRow(db, s.orgId, id));
    },

    async closeRequest(s: OrgScope, id: string, note: string) {
      await db.tx(async (t) => {
        const r = await requestRow(t, s.orgId, id, true);
        if (r.status === "closed") throw fail.conflict("This request is already closed");
        const open = await t.row(
          "SELECT 1 FROM pm_work_orders WHERE request_id = $1 AND status NOT IN ('verified', 'billed', 'cancelled')",
          [id],
        );
        if (open) throw fail.conflict("Its work order is still open — finish or cancel it first");
        await t.run(
          "UPDATE pm_maintenance_requests SET status = 'closed', resolved_at = COALESCE(resolved_at, now()) WHERE id = $1",
          [id],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Maintenance request closed",
          target: r.number,
          detail: note,
        });
      });
      return toRequest(await requestRow(db, s.orgId, id));
    },

    async listWorkOrders(
      s: OrgScope,
      f: { status?: P.WorkOrder["status"] | undefined; propertyId?: string | undefined },
    ) {
      const rows = await db.rows<WorkOrderRow>(
        `SELECT * FROM pm_work_orders WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR property_id = $3) ORDER BY created_at DESC`,
        [s.orgId, f.status ?? null, f.propertyId ?? null],
      );
      return { workOrders: await woViews(rows, s.today) };
    },

    async createWorkOrder(
      s: OrgScope,
      b: {
        propertyId: string;
        unitId?: string | undefined;
        requestId?: string | undefined;
        scope: string;
        priority: P.WorkOrder["priority"];
      },
    ) {
      const sla = (await settingsOf(db, s.orgId)).slaDays;
      const id = await db.tx(async (t) => {
        let propertyId = b.propertyId;
        let unitId = b.unitId ?? null;
        if (b.requestId) {
          const r = await requestRow(t, s.orgId, b.requestId, true);
          if (b.propertyId !== r.property_id || (b.unitId && r.unit_id && b.unitId !== r.unit_id))
            throw fail.invalid("Use the property and unit linked to this maintenance request");
          if (r.status === "closed" || r.status === "resolved") throw fail.conflict("That request is already resolved");
          const existing = await t.row<WorkOrderRow>(
            "SELECT * FROM pm_work_orders WHERE org_id=$1 AND request_id=$2 AND status NOT IN ('verified','billed','cancelled') ORDER BY created_at,id LIMIT 1",
            [s.orgId, r.id],
          );
          if (existing) {
            if (existing.scope !== b.scope || existing.priority !== b.priority)
              throw fail.conflict(
                "This request already has an active work order. Open that order before changing the scope or priority.",
              );
            return existing.id;
          }
          propertyId = r.property_id;
          unitId = unitId ?? r.unit_id;
          await t.run("UPDATE pm_maintenance_requests SET status = 'assigned' WHERE id = $1", [r.id]);
        }
        await R.propertyRow(t, s.orgId, propertyId);
        if (unitId && (await R.unitRow(t, s.orgId, unitId)).property_id !== propertyId)
          throw fail.invalid("That unit is not in this property");
        const id = newId("pwo");
        const number = await nextNumber(t, numberScope(s.orgId), "WO", 5);
        await t.run(
          `INSERT INTO pm_work_orders (id, org_id, number, property_id, unit_id, request_id, scope, priority, status, due_date,
             created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requesting_quotes', $9, $10)`,
          [
            id,
            s.orgId,
            number,
            propertyId,
            unitId,
            b.requestId ?? null,
            b.scope,
            b.priority,
            addDays(s.today, sla[b.priority]),
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Work order opened",
          target: number,
          detail: b.scope,
        });
        return id;
      });
      return woView(s.orgId, id, s.today);
    },

    async addQuote(
      s: OrgScope,
      id: string,
      b: { supplierId: string; amountMinor: number; days?: number | undefined; fileName: string },
    ) {
      await db.tx(async (t) => {
        const w = await woRow(t, s.orgId, id, true);
        if (w.status !== "requesting_quotes" && w.status !== "quoted")
          throw fail.conflict("Quotes are closed for this work order");
        const supplier = await core.contacts.live(t, s.orgId, b.supplierId);
        await core.contacts.addTypes(t, s.orgId, b.supplierId, ["supplier"]);
        await t.run(
          `INSERT INTO pm_wo_quotes (work_order_id, supplier_id, org_id, amount_minor, days, file_name, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (work_order_id, supplier_id) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, days = EXCLUDED.days,
             file_name = EXCLUDED.file_name, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
          [id, b.supplierId, s.orgId, b.amountMinor, b.days ?? null, b.fileName, s.userId],
        );
        await t.run("UPDATE pm_work_orders SET status = 'quoted' WHERE id = $1", [id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Quotation recorded",
          target: w.number,
          detail: `${supplier.name} · ${b.amountMinor}`,
        });
      });
      return woView(s.orgId, id, s.today);
    },

    async raisePo(s: OrgScope, id: string, supplierId: string) {
      await db.tx(async (t) => {
        const w = await woRow(t, s.orgId, id, true);
        if (w.po_number) throw fail.conflict("A purchase order already exists");
        if (w.status !== "quoted") throw fail.conflict("Record at least one quotation first");
        const q = await t.row<{ amount_minor: number }>(
          "SELECT amount_minor FROM pm_wo_quotes WHERE work_order_id = $1 AND supplier_id = $2",
          [id, supplierId],
        );
        if (!q) throw fail.invalid("Pick a supplier who quoted");
        const cheapest = await t.row<{ n: number }>(
          "SELECT min(amount_minor)::bigint AS n FROM pm_wo_quotes WHERE work_order_id = $1",
          [id],
        );
        const ag = w.unit_id
          ? await R.agreementForUnit(t, s.orgId, w.unit_id)
          : (
              await R.agreements(t, s.orgId, "a.property_id = $2 AND a.unit_id IS NULL AND a.status = 'active'", [
                w.property_id,
              ])
            )[0];
        const number = await nextNumber(t, numberScope(s.orgId), "PO", 5);
        await t.run(
          `UPDATE pm_work_orders SET po_number = $2, po_supplier_id = $3, po_amount_minor = $4, po_raised_by = $5,
             needs_owner = $6, status = 'po_pending' WHERE id = $1`,
          [id, number, supplierId, q.amount_minor, s.userId, !!ag && q.amount_minor > ag.authority_minor],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Purchase order raised",
          target: number,
          detail: `${w.number} · ${q.amount_minor}${cheapest && q.amount_minor > cheapest.n ? " — not the cheapest quotation" : ""}`,
        });
      });
      return woView(s.orgId, id, s.today);
    },

    async approvePoAsStaff(s: OrgScope, id: string) {
      await db.tx((t) => approvePo(t, s.orgId, id, { userId: s.userId, role: s.role }, s.actor));
      return woView(s.orgId, id, s.today);
    },

    async complete(s: OrgScope, id: string, b: { notes: string; evidence: string[] }) {
      await db.tx(async (t) => {
        const w = await woRow(t, s.orgId, id, true);
        if (w.status !== "approved") throw fail.conflict("Work can be completed once its purchase order is approved");
        await t.run(
          `UPDATE pm_work_orders SET status = 'completed', completed_by = $2, completed_at = now(), completion_notes = $3,
             evidence = $4 WHERE id = $1`,
          [id, s.userId, b.notes, JSON.stringify(b.evidence)],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Work completed",
          target: w.number,
          detail: `${b.evidence.length} piece(s) of evidence`,
        });
      });
      return woView(s.orgId, id, s.today);
    },

    async verify(s: OrgScope, id: string, b: { accepted: boolean; note: string }) {
      await db.tx(async (t) => {
        const w = await woRow(t, s.orgId, id, true);
        if (w.status !== "completed") throw fail.conflict("The work is not marked complete");
        if (w.completed_by === s.userId)
          throw fail.separationOfDuties("You marked this work complete — someone else checks it");
        if (b.accepted) {
          await t.run(
            "UPDATE pm_work_orders SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1",
            [id, s.userId],
          );
          if (w.request_id)
            await t.run(
              "UPDATE pm_maintenance_requests SET status = 'resolved', resolved_at = now() WHERE id = $1 AND status <> 'closed'",
              [w.request_id],
            );
        } else
          await t.run(
            `UPDATE pm_work_orders SET status = 'approved', completed_by = NULL, completed_at = NULL, completion_notes = NULL,
               evidence = '[]' WHERE id = $1`,
            [id],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.accepted ? "Work checked and accepted" : "Work sent back",
          target: w.number,
          detail: b.note,
        });
      });
      return woView(s.orgId, id, s.today);
    },

    async cancel(s: OrgScope, id: string, reason: string) {
      await db.tx(async (t) => {
        const w = await woRow(t, s.orgId, id, true);
        if (w.status === "billed" || w.status === "cancelled")
          throw fail.conflict(`A ${w.status} work order cannot be cancelled`);
        const bill = await t.row("SELECT 1 FROM pm_bills WHERE work_order_id = $1 AND status <> 'rejected'", [id]);
        if (bill) throw fail.conflict("A bill references this work order — reject it first");
        await t.run("UPDATE pm_work_orders SET status = 'cancelled' WHERE id = $1", [id]);
        if (w.request_id)
          await t.run("UPDATE pm_maintenance_requests SET status = 'open' WHERE id = $1 AND status = 'assigned'", [
            w.request_id,
          ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Work order cancelled",
          target: w.number,
          detail: reason,
        });
      });
      return woView(s.orgId, id, s.today);
    },

    // ---------------------------------------------------------------- inspections
    async listInspections(s: OrgScope, propertyId?: string) {
      const rows = await db.rows<InspectionRow>(
        "SELECT * FROM pm_inspections WHERE org_id = $1 AND ($2::text IS NULL OR property_id = $2) ORDER BY scheduled_date DESC",
        [s.orgId, propertyId ?? null],
      );
      const inspections = [];
      for (const r of rows) inspections.push(await inspectionView(s.orgId, r));
      return { inspections };
    },

    async scheduleInspection(
      s: OrgScope,
      b: {
        propertyId: string;
        unitId?: string | undefined;
        leaseId?: string | undefined;
        kind: InspectionRow["kind"];
        scheduledDate: string;
      },
    ) {
      await R.propertyRow(db, s.orgId, b.propertyId);
      let unitId = b.unitId ?? null;
      if (b.leaseId) {
        const l = await R.leaseRow(db, s.orgId, b.leaseId);
        if (l.property_id !== b.propertyId) throw fail.invalid("That lease is not in this property");
        unitId = unitId ?? l.unit_id;
      }
      if (unitId && (await R.unitRow(db, s.orgId, unitId)).property_id !== b.propertyId)
        throw fail.invalid("That unit is not in this property");
      if (b.kind !== "routine" && !unitId) throw fail.invalid("A move-in or move-out inspection is of a unit");
      const id = newId("pis");
      await db.tx(async (t) => {
        const number = await nextNumber(t, numberScope(s.orgId), "INS", 5);
        await t.run(
          `INSERT INTO pm_inspections (id, org_id, number, property_id, unit_id, lease_id, kind, scheduled_date, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9)`,
          [id, s.orgId, number, b.propertyId, unitId, b.leaseId ?? null, b.kind, b.scheduledDate, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Inspection scheduled",
          target: number,
          detail: b.kind,
        });
      });
      return inspectionView(
        s.orgId,
        (await db.row<InspectionRow>("SELECT * FROM pm_inspections WHERE id = $1", [id])) as InspectionRow,
      );
    },

    async completeInspection(
      s: OrgScope,
      id: string,
      items: { area: string; condition: InspectionRow["items"][number]["condition"]; note: string }[],
    ) {
      await db.tx(async (t) => {
        const r = await t.row<InspectionRow>("SELECT * FROM pm_inspections WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!r) throw fail.notFound("Inspection not found");
        if (r.status === "completed") throw fail.conflict("This inspection is already completed");
        await t.run(
          "UPDATE pm_inspections SET status = 'completed', items = $2, completed_by = $3, completed_at = now() WHERE id = $1",
          [id, JSON.stringify(items), s.userId],
        );
        const bad = items.filter((x) => x.condition === "needs_repair" || x.condition === "damaged");
        for (const x of bad)
          await openRequest(t, s, {
            propertyId: r.property_id,
            unitId: r.unit_id,
            title: `${x.area}: ${x.note || x.condition.replace("_", " ")} (${r.number})`,
            category: "inspection",
            priority: x.condition === "damaged" ? "high" : "normal",
            source: "inspection",
            inspectionId: r.id,
          });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Inspection completed",
          target: r.number,
          detail: `${items.length} area(s) · ${bad.length} opened as maintenance`,
        });
      });
      return inspectionView(
        s.orgId,
        (await db.row<InspectionRow>("SELECT * FROM pm_inspections WHERE id = $1", [id])) as InspectionRow,
      );
    },

    async requestView(orgId: string, id: string) {
      return toRequest(await requestRow(db, orgId, id));
    },

    woView,
  };
}

export type MaintenanceService = ReturnType<typeof maintenanceService>;
