import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { invoiceRow, balanceOf, type InvoiceRow } from "../shared/records.js";

type Row = {
  id: string;
  org_id: string;
  invoice_id: string;
  tenant_id: string;
  kind: P.CollectionPlanInput["kind"];
  status: P.CollectionPlan["status"];
  schedule: P.CollectionPlanInput["schedule"];
  target_minor: number;
  evidence_ref: string;
  note: string;
  version: number;
  baseline_cash_minor: number;
  baseline_credit_minor: number;
  closed_settled_minor: number | null;
  approved_by: string | null;
  created_by: string;
  updated_by: string;
  updated_at: string;
  invoice_number: string;
  tenant_name: string;
  unit_no: string | null;
  property_id: string | null;
};
const SQL = `SELECT p.*,i.number AS invoice_number,i.property_id,c.name AS tenant_name,u.unit_no FROM pm_collection_plans p JOIN pm_invoices i ON i.id=p.invoice_id AND i.org_id=p.org_id JOIN contacts c ON c.id=p.tenant_id AND c.org_id=p.org_id LEFT JOIN pm_units u ON u.id=i.unit_id AND u.org_id=i.org_id`;
/** Allocation progress is derived from the existing invoice; it never posts a second receivable. */
export function collectionPlanProgress(schedule: P.CollectionPlanInput["schedule"], settled: number, today: string) {
  let remaining = settled,
    overdueMinor = 0;
  const instalments = schedule.map((x) => {
    const applied = Math.min(x.amountMinor, remaining);
    remaining -= applied;
    const open = x.amountMinor - applied;
    if (x.dueDate < today) overdueMinor += open;
    return {
      ...x,
      settledMinor: applied,
      remainingMinor: open,
      status: (open === 0 ? "settled" : applied > 0 ? "partial" : "unpaid") as "settled" | "partial" | "unpaid",
    };
  });
  return { instalments, overdueMinor };
}
export function collectionPlansService(d: PmDeps) {
  const db = d.core.db;
  const scope = (s: OrgScope, invoice: InvoiceRow, tenantId?: string) => {
    if (
      (tenantId && invoice.tenant_id !== tenantId) ||
      (s.propertyIds && (!invoice.property_id || !s.propertyIds.includes(invoice.property_id)))
    )
      throw fail.notFound("Invoice not found");
  };
  async function row(t: Db, s: OrgScope, id: string, lock = false, tenantId?: string) {
    const r = await t.row<Row>(`${SQL} WHERE p.org_id=$1 AND p.id=$2 ${lock ? "FOR UPDATE OF p" : ""}`, [s.orgId, id]);
    if (!r) throw fail.notFound("Collection plan not found");
    const invoice = await invoiceRow(t, s.orgId, r.invoice_id);
    scope(s, invoice, tenantId);
    return { r, invoice };
  }
  async function view(t: Db, s: OrgScope, r: Row, invoice: InvoiceRow): Promise<P.CollectionPlan> {
    const current = Math.max(
      0,
      invoice.paid_minor + invoice.credited_minor - r.baseline_cash_minor - r.baseline_credit_minor,
    );
    const proposed = r.status === "proposed";
    const settledMinor = proposed ? 0 : Math.min(r.target_minor, r.closed_settled_minor ?? current);
    const expectedRemaining = r.target_minor - settledMinor;
    const invoiceBalanceMinor = balanceOf(invoice);
    const events = await t.rows<P.CollectionPlan["events"][number]>(
      `SELECT id,action,reason,snapshot,created_at AS "createdAt" FROM pm_collection_plan_events WHERE org_id=$1 AND plan_id=$2 ORDER BY created_at,id`,
      [s.orgId, r.id],
    );
    return {
      id: r.id,
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      tenantName: r.tenant_name,
      unitNo: r.unit_no,
      input: { invoiceId: r.invoice_id, kind: r.kind, schedule: r.schedule, evidenceRef: r.evidence_ref, note: r.note },
      status: r.status,
      version: r.version,
      targetMinor: r.target_minor,
      settledMinor,
      invoiceBalanceMinor,
      unplannedBalanceMinor: Math.max(0, invoiceBalanceMinor - expectedRemaining),
      reviewRequired: proposed ? invoiceBalanceMinor !== r.target_minor : invoiceBalanceMinor > expectedRemaining,
      approvedBy: r.approved_by,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
      events,
      ...collectionPlanProgress(r.schedule, settledMinor, s.today),
    };
  }
  async function validate(t: Db, s: OrgScope, b: P.CollectionPlanInput, tenantId?: string) {
    const inv = await invoiceRow(t, s.orgId, b.invoiceId);
    scope(s, inv, tenantId);
    const sum = b.schedule.reduce((n, x) => n + BigInt(x.amountMinor), 0n);
    if (sum > BigInt(Number.MAX_SAFE_INTEGER))
      throw fail.invalid("The plan total exceeds the supported monetary range");
    if (sum !== BigInt(balanceOf(inv)))
      throw fail.conflict(
        "The instalment total must equal the invoice's current outstanding balance. Refresh the invoice and adjust the proposed schedule.",
      );
    if (sum <= 0n) throw fail.invalid("This invoice has no outstanding balance to arrange");
    return { inv, target: Number(sum) };
  }
  async function event(t: Db, s: OrgScope, id: string, action: string, reason: string) {
    const { r } = await row(t, s, id);
    const snapshot = {
      input: { invoiceId: r.invoice_id, kind: r.kind, schedule: r.schedule, evidenceRef: r.evidence_ref, note: r.note },
      status: r.status,
      version: r.version,
      targetMinor: r.target_minor,
      approvedBy: r.approved_by,
    };
    await t.run(
      "INSERT INTO pm_collection_plan_events(id,org_id,plan_id,action,reason,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [newId("pce"), s.orgId, id, action, reason, JSON.stringify(snapshot), s.userId],
    );
    await recordAudit(t, {
      orgId: s.orgId,
      actor: s.actor,
      action: `Collection plan ${action}`,
      target: id,
      detail: reason,
    });
  }
  return {
    async list(s: OrgScope, q: P.PlanQuery, tenantId?: string) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const where = `WHERE p.org_id=$1 AND ($2::text IS NULL OR i.property_id=$2) AND ($3::text IS NULL OR p.invoice_id=$3) AND ($4::text[] IS NULL OR i.property_id=ANY($4)) AND ($5::text IS NULL OR p.tenant_id=$5)`;
        const args = [s.orgId, q.propertyId ?? null, q.invoiceId ?? null, s.propertyIds ?? null, tenantId ?? null];
        const count = await t.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM pm_collection_plans p JOIN pm_invoices i ON i.id=p.invoice_id AND i.org_id=p.org_id ${where}`,
          args,
        );
        const rows = await t.rows<Row>(`${SQL} ${where} ORDER BY p.updated_at DESC,p.id DESC LIMIT $6 OFFSET $7`, [
          ...args,
          q.limit,
          q.offset,
        ]);
        const plans = [];
        for (const r of rows) plans.push(await view(t, s, r, await invoiceRow(t, s.orgId, r.invoice_id)));
        return { plans, total: count?.n ?? 0, limit: q.limit, offset: q.offset };
      });
    },
    async create(s: OrgScope, b: P.CollectionPlanInput, tenantId?: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const { target, inv } = await validate(t, s, b, tenantId);
        if (
          await t.row(
            "SELECT id FROM pm_collection_plans WHERE org_id=$1 AND invoice_id=$2 AND status IN ('proposed','active','paused')",
            [s.orgId, b.invoiceId],
          )
        )
          throw fail.conflict("An open arrangement already covers this invoice");
        const id = newId("pcp");
        await t.run(
          "INSERT INTO pm_collection_plans(id,org_id,invoice_id,tenant_id,kind,schedule,target_minor,evidence_ref,note,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)",
          [
            id,
            s.orgId,
            b.invoiceId,
            inv.tenant_id,
            b.kind,
            JSON.stringify(b.schedule),
            target,
            b.evidenceRef,
            b.note,
            s.userId,
          ],
        );
        await event(t, s, id, "proposed", b.note || b.evidenceRef);
        const saved = await row(t, s, id, false, tenantId);
        return view(t, s, saved.r, saved.invoice);
      });
    },
    async update(s: OrgScope, id: string, expectedVersion: number, b: P.CollectionPlanInput, tenantId?: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const { r } = await row(t, s, id, true, tenantId);
        if (r.version !== expectedVersion) throw fail.conflict("The arrangement changed. Reopen it before editing.");
        if (r.status !== "proposed")
          throw fail.conflict(
            "Only a proposed arrangement can be edited; retain approved history and use a new reviewed proposal.",
          );
        if (b.invoiceId !== r.invoice_id)
          throw fail.invalid("An existing arrangement cannot be moved to another invoice");
        const { target } = await validate(t, s, b, tenantId);
        await t.run(
          "UPDATE pm_collection_plans SET kind=$3,schedule=$4,target_minor=$5,evidence_ref=$6,note=$7,version=version+1,updated_by=$8,updated_at=now() WHERE org_id=$1 AND id=$2",
          [s.orgId, id, b.kind, JSON.stringify(b.schedule), target, b.evidenceRef, b.note, s.userId],
        );
        await event(t, s, id, "edited", b.note || b.evidenceRef);
        const saved = await row(t, s, id);
        return view(t, s, saved.r, saved.invoice);
      });
    },
    async action(s: OrgScope, id: string, b: P.PlanAction, tenantId?: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const { r, invoice } = await row(t, s, id, true, tenantId);
        if (tenantId && (r.status !== "proposed" || b.action !== "cancel"))
          throw fail.forbidden(
            "You can withdraw an unapproved proposal; ask your manager to change an approved arrangement",
          );
        if (r.version !== b.expectedVersion)
          throw fail.conflict("The arrangement changed. Reopen it before continuing.");
        let status: P.CollectionPlan["status"];
        let approved = r.approved_by,
          cash = r.baseline_cash_minor,
          credit = r.baseline_credit_minor,
          closed = r.closed_settled_minor;
        if (b.action === "approve") {
          if (r.status !== "proposed") throw fail.conflict("Only a proposal can be approved");
          if (s.role !== "org_admin" && (r.created_by === s.userId || r.updated_by === s.userId))
            throw fail.separationOfDuties("Another authorised manager must review this proposal");
          await validate(t, s, {
            invoiceId: r.invoice_id,
            kind: r.kind,
            schedule: r.schedule,
            evidenceRef: r.evidence_ref,
            note: r.note,
          });
          status = "active";
          approved = s.userId;
          cash = invoice.paid_minor;
          credit = invoice.credited_minor;
          closed = null;
        } else if (b.action === "pause") {
          if (r.status !== "active") throw fail.conflict("Only an active plan can be paused");
          status = "paused";
        } else if (b.action === "resume") {
          if (r.status !== "paused") throw fail.conflict("Only a paused plan can resume");
          status = "active";
        } else if (b.action === "complete") {
          if (!["active", "paused"].includes(r.status))
            throw fail.conflict("Only an approved arrangement can be completed");
          if (balanceOf(invoice) !== 0) throw fail.conflict("The original invoice is not fully settled");
          status = "completed";
          closed = r.target_minor;
        } else if (b.action === "cancel") {
          if (!["proposed", "active", "paused"].includes(r.status))
            throw fail.conflict("This arrangement is already closed");
          status = "cancelled";
          closed =
            r.status === "proposed"
              ? 0
              : Math.min(r.target_minor, Math.max(0, invoice.paid_minor + invoice.credited_minor - cash - credit));
        } else {
          if (!["cancelled", "completed"].includes(r.status))
            throw fail.conflict("Only a closed arrangement can be reopened");
          if (balanceOf(invoice) <= 0) throw fail.conflict("The original invoice is already settled");
          if (
            await t.row(
              "SELECT id FROM pm_collection_plans WHERE org_id=$1 AND invoice_id=$2 AND id<>$3 AND status IN ('proposed','active','paused')",
              [s.orgId, r.invoice_id, id],
            )
          )
            throw fail.conflict("Another arrangement already covers this invoice");
          status = "proposed";
          approved = null;
          cash = 0;
          credit = 0;
          closed = null;
        }
        await t.run(
          "UPDATE pm_collection_plans SET status=$3,approved_by=$4,baseline_cash_minor=$5,baseline_credit_minor=$6,closed_settled_minor=$7,version=version+1,updated_by=$8,updated_at=now() WHERE org_id=$1 AND id=$2",
          [s.orgId, id, status, approved, cash, credit, closed, s.userId],
        );
        await event(t, s, id, b.action, b.reason);
        const saved = await row(t, s, id);
        return view(t, s, saved.r, saved.invoice);
      });
    },
  };
}
