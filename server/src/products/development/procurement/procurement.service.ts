/*
 * Procurement and cost control: suppliers (pending until someone other than the registrar approves them; bank-detail
 * changes block payments until a callback by another person and a hold period), budgets by cost code, transfers and
 * change orders, requisitions, requests for quotation with weighted bid scores, purchase orders and works contracts,
 * deliveries, and the cost report.
 *
 * Cost report (per cost code, each amount counted once):
 *   revised      = original + approved transfers / change orders in − out
 *   committed    = approved orders and contracts + approved invoices without an order
 *   invoiced     = approved supplier invoices, net of VAT — what the ledger carries as project cost
 *   paid         = the invoiced amount whose payments are matched to a bank statement
 *   open         = committed − invoiced on each order (never below zero)
 *   etc          = uncommitted forecast (reduced when an order is approved, so nothing is counted twice)
 *   eac          = invoiced + open + etc;  cost to complete = eac − invoiced;  variance = revised − eac
 *   proposed     = requisitions, orders and change orders awaiting approval (not in the forecast)
 */
import type { development, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { CoreServices } from "../../../core/core-services.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { can } from "../shared/access.js";
import { findProject, lineAmount } from "../shared/records.js";
import { costCode, requireApproval, settingsRow } from "../shared/rules.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Out<T extends z.ZodType> = z.input<T>;

/** Order statuses that commit budget (approved here, or brought over by data migration). */
export const COMMITTED = ["approved", "open", "received", "closed"];
/** Invoice statuses that are actual cost (approved and posted). */
export const POSTED = ["approved", "in_run", "sent", "paid"];

export interface SupplierRow {
  id: string;
  kind: "supplier" | "contractor";
  name: string;
  tax_id: string | null;
  email: string | null;
  phone: string | null;
  trade: string | null;
  status: "pending" | "approved" | "suspended";
  related_party: boolean;
  related_note: string | null;
  missing_documents: string[];
  bank_account: string | null;
  bank_verified_at: string | null;
  rating: number | null;
  registered_by: string | null;
  source_system: string | null;
  blocked_change: boolean;
}

const SUPPLIER_SELECT = `SELECT s.*, EXISTS (SELECT 1 FROM dev_bank_changes b WHERE b.supplier_id = s.id
    AND b.status IN ('pending_verification', 'on_hold')) AS blocked_change FROM dev_suppliers s`;

export const toSupplier = (s: SupplierRow): Out<typeof development.Supplier> => ({
  id: s.id,
  kind: s.kind,
  name: s.name,
  taxId: s.tax_id,
  email: s.email,
  phone: s.phone,
  trade: s.trade,
  status: s.status,
  relatedParty: s.related_party,
  relatedNote: s.related_note,
  missingDocuments: s.missing_documents,
  bankAccount: s.bank_account,
  bankVerifiedAt: s.bank_verified_at,
  rating: s.rating,
  paymentsBlocked: s.status !== "approved" || s.blocked_change,
  migrated: s.source_system !== null,
});

/** Only the last four characters of a bank account are kept (PALTAS does not move money). */
const mask = (acct: string) => `••${acct.replace(/\s/g, "").slice(-4)}`;

export async function findSupplier(db: Db, orgId: string, id: string, lock = false): Promise<SupplierRow> {
  if (lock) await db.run("SELECT 1 FROM dev_suppliers WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
  const s = await db.row<SupplierRow>(`${SUPPLIER_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
  if (!s) throw fail.notFound("Supplier not found");
  return s;
}

/** Bank-detail changes whose hold has passed take effect (run before anything that pays suppliers). */
export async function settleBankChanges(t: Db, orgId: string): Promise<void> {
  const due = await t.rows<{ id: string; supplier_id: string; new_account: string }>(
    `UPDATE dev_bank_changes SET status = 'verified' WHERE org_id = $1 AND status = 'on_hold' AND hold_until <= now()
     RETURNING id, supplier_id, new_account`,
    [orgId],
  );
  for (const c of due)
    await t.run("UPDATE dev_suppliers SET bank_account = $2, bank_verified_at = now() WHERE id = $1", [
      c.supplier_id,
      c.new_account,
    ]);
}

interface PoRow {
  id: string;
  number: string | null;
  kind: "po" | "contract";
  supplier_id: string;
  project_id: string;
  cost_code: string | null;
  date: string;
  amount_minor: number;
  retention_bp: number;
  status: string | null;
  description: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  related_party: boolean;
  source_system: string | null;
  requisition_id: string | null;
}

const PO_SELECT = `SELECT o.*, s.related_party FROM dev_purchase_orders o JOIN dev_suppliers s ON s.id = o.supplier_id`;

interface RequisitionRow {
  id: string;
  number: string;
  project_id: string;
  cost_code: string;
  item: string;
  qty: number;
  unit: string;
  est_unit_price_minor: number;
  need_by: string | null;
  status: Out<typeof development.Requisition>["status"];
  requested_by: string;
  approved_by: string | null;
  rfq_id: string | null;
}

const toRequisition = (r: RequisitionRow): Out<typeof development.Requisition> => ({
  id: r.id,
  number: r.number,
  projectId: r.project_id,
  costCode: r.cost_code,
  item: r.item,
  qty: r.qty,
  unit: r.unit,
  estUnitPriceMinor: r.est_unit_price_minor,
  estimateMinor: lineAmount(r.qty, r.est_unit_price_minor),
  needBy: r.need_by,
  status: r.status,
  requestedBy: r.requested_by,
  approvedBy: r.approved_by,
  rfqId: r.rfq_id,
});

const REQ_SELECT =
  "SELECT r.*, (SELECT q.id FROM dev_rfqs q WHERE q.requisition_id = r.id) AS rfq_id FROM dev_requisitions r";

interface ChangeRow {
  id: string;
  number: string;
  project_id: string;
  kind: "transfer" | "change_order";
  from_code: string;
  to_code: string;
  amount_minor: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_by: string;
  approved_by: string | null;
}

const toChange = (c: ChangeRow): Out<typeof development.BudgetChange> => ({
  id: c.id,
  number: c.number,
  projectId: c.project_id,
  kind: c.kind,
  fromCode: c.from_code,
  toCode: c.to_code,
  amountMinor: c.amount_minor,
  reason: c.reason,
  status: c.status,
  requestedBy: c.requested_by,
  approvedBy: c.approved_by,
});

type CostRow = Out<typeof development.CostRow>;
const AMOUNTS = [
  "originalMinor",
  "revisedMinor",
  "proposedMinor",
  "committedMinor",
  "invoicedMinor",
  "paidMinor",
  "openCommitmentMinor",
  "etcMinor",
  "eacMinor",
  "costToCompleteMinor",
  "varianceMinor",
] as const;

/** The cost report of one project, tied to the cost lines the ledger carries for it. */
export async function costReportOf(
  db: Db,
  orgId: string,
  projectId: string,
): Promise<Out<typeof development.CostReport>> {
  const rows = new Map<string, CostRow>();
  const codes = new Map(
    (
      await db.rows<{ code: string; name: string }>("SELECT code, name FROM dev_cost_codes WHERE org_id = $1", [orgId])
    ).map((c) => [c.code, c.name]),
  );
  const row = (code: string | null): CostRow => {
    const key = code ?? "—";
    let r = rows.get(key);
    if (!r) {
      r = {
        costCode: key,
        name: code ? (codes.get(code) ?? code) : "Not allocated to a cost code",
        note: "",
        ...Object.fromEntries(AMOUNTS.map((a) => [a, 0])),
      } as CostRow;
      rows.set(key, r);
    }
    return r;
  };
  for (const b of await db.rows<{ cost_code: string; original_minor: number; etc_minor: number; note: string }>(
    "SELECT * FROM dev_budget_lines WHERE project_id = $1",
    [projectId],
  )) {
    const r = row(b.cost_code);
    r.originalMinor = b.original_minor;
    r.etcMinor = b.etc_minor;
    r.note = b.note;
  }
  for (const c of await db.rows<ChangeRow>(
    "SELECT * FROM dev_budget_changes WHERE project_id = $1 AND status <> 'rejected'",
    [projectId],
  )) {
    if (c.status === "approved") {
      row(c.from_code).revisedMinor -= c.amount_minor;
      row(c.to_code).revisedMinor += c.amount_minor;
    } else if (c.kind === "change_order") row(c.to_code).proposedMinor += c.amount_minor;
  }
  // invoices posted as cost, and what was paid on them (bank-matched)
  const invoices = await db.rows<{
    po_id: string | null;
    cost_code: string | null;
    net_minor: number;
    cash_minor: number;
    reconciled: number;
  }>(
    `SELECT i.po_id, i.cost_code, i.net_minor, i.cash_minor,
       COALESCE((SELECT sum(p.amount_minor) FROM dev_supplier_payments p WHERE p.invoice_id = i.id AND p.status = 'reconciled'), 0)::bigint
         AS reconciled
     FROM dev_supplier_invoices i WHERE i.project_id = $1 AND i.kind = 'invoice' AND i.status = ANY($2)`,
    [projectId, POSTED],
  );
  const invoicedByPo = new Map<string, number>();
  for (const i of invoices) {
    const r = row(i.cost_code);
    r.invoicedMinor += i.net_minor;
    r.paidMinor +=
      i.cash_minor > 0 ? Math.round((i.net_minor * Math.min(i.reconciled, i.cash_minor)) / i.cash_minor) : 0;
    if (i.po_id) invoicedByPo.set(i.po_id, (invoicedByPo.get(i.po_id) ?? 0) + i.net_minor);
    else r.committedMinor += i.net_minor;
  }
  for (const o of await db.rows<PoRow>("SELECT * FROM dev_purchase_orders WHERE project_id = $1", [projectId])) {
    const r = row(o.cost_code);
    if (COMMITTED.includes(o.status ?? "")) {
      r.committedMinor += o.amount_minor;
      r.openCommitmentMinor += Math.max(0, o.amount_minor - (invoicedByPo.get(o.id) ?? 0));
    } else if (o.status === "pending_approval") r.proposedMinor += o.amount_minor;
  }
  for (const q of await db.rows<{ cost_code: string; qty: number; est_unit_price_minor: number }>(
    "SELECT cost_code, qty, est_unit_price_minor FROM dev_requisitions WHERE project_id = $1 AND status = 'pending'",
    [projectId],
  ))
    row(q.cost_code).proposedMinor += lineAmount(q.qty, q.est_unit_price_minor);
  for (const r of rows.values()) {
    r.revisedMinor += r.originalMinor;
    r.eacMinor = r.invoicedMinor + r.openCommitmentMinor + r.etcMinor;
    r.costToCompleteMinor = r.eacMinor - r.invoicedMinor;
    r.varianceMinor = r.revisedMinor - r.eacMinor;
  }
  // cost codes in order; anything not allocated to a code (e.g. migrated orders) last
  const list = [...rows.values()].sort((a, b) =>
    a.costCode === "—" ? 1 : b.costCode === "—" ? -1 : a.costCode.localeCompare(b.costCode),
  );
  const totals = Object.fromEntries(AMOUNTS.map((a) => [a, list.reduce((n, r) => n + r[a], 0)])) as Record<
    (typeof AMOUNTS)[number],
    number
  >;
  const ledgerCost = await ledgerBalanceOfCost(db, orgId, projectId);
  return {
    projectId,
    rows: list,
    totals,
    ledger: { invoicedMinor: ledgerCost, agrees: ledgerCost === totals.invoicedMinor },
  };
}

/** Project cost on the ledger: the cost lines of approved supplier invoices (debits − credits). */
async function ledgerBalanceOfCost(db: Db, orgId: string, projectId: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT COALESCE(sum(l.debit_minor - l.credit_minor), 0)::bigint AS n
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
     WHERE l.org_id = $1 AND l.dimensions @> $2::jsonb`,
    [orgId, JSON.stringify({ kind: "cost", project: projectId })],
  );
  return r?.n ?? 0;
}

export function procurementService(core: CoreServices) {
  const { db } = core;

  // ---------------------------------------------------------------- suppliers
  async function listSuppliers(s: OrgScope) {
    await db.tx((t) => settleBankChanges(t, s.orgId));
    const suppliers = await db.rows<SupplierRow>(`${SUPPLIER_SELECT} WHERE s.org_id = $1 ORDER BY s.name`, [s.orgId]);
    const changes = await db.rows<BankChangeRow>(
      "SELECT * FROM dev_bank_changes WHERE org_id = $1 ORDER BY created_at",
      [s.orgId],
    );
    return { suppliers: suppliers.map(toSupplier), bankChanges: changes.map(toBankChange) };
  }

  async function register(s: OrgScope, b: Body<typeof development.registerSupplier>) {
    return db.tx(async (t) => {
      const dup = await t.row<{ name: string }>(
        `SELECT name FROM dev_suppliers WHERE org_id = $1 AND kind = $2
           AND (lower(name) = lower($3) OR upper(replace(tax_id, ' ', '')) = upper(replace($4, ' ', '')))`,
        [s.orgId, b.kind, b.name, b.taxId],
      );
      if (dup) throw fail.conflict(`Already registered as ${dup.name} (same name or tax ID)`);
      const id = newId("dsp");
      await t.run(
        `INSERT INTO dev_suppliers (id, org_id, kind, name, tax_id, email, phone, trade, status, related_party, related_note,
           missing_documents, bank_account, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13)`,
        [
          id,
          s.orgId,
          b.kind,
          b.name,
          b.taxId,
          b.email ?? null,
          b.phone ?? null,
          b.trade ?? null,
          b.relatedParty,
          b.relatedNote ?? null,
          b.missingDocuments,
          mask(b.bankAccount),
          s.userId,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Supplier registered",
        target: id,
        detail: b.name,
      });
      return toSupplier(await findSupplier(t, s.orgId, id));
    });
  }

  async function approveSupplier(s: OrgScope, id: string, rating?: number) {
    return db.tx(async (t) => {
      const sp = await findSupplier(t, s.orgId, id, true);
      if (sp.status !== "pending") throw fail.conflict(`The supplier is already ${sp.status}`);
      if (sp.registered_by === s.userId)
        throw fail.separationOfDuties("You registered this supplier — someone else approves it");
      if (sp.missing_documents.length)
        throw fail.conflict(`Cannot approve: missing ${sp.missing_documents.join(", ")}`);
      await t.run(
        "UPDATE dev_suppliers SET status = 'approved', approved_by = $2, rating = COALESCE($3, rating) WHERE id = $1",
        [id, s.userId, rating ?? null],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Supplier approved",
        target: id,
        detail: sp.name,
      });
      return toSupplier(await findSupplier(t, s.orgId, id));
    });
  }

  interface BankChangeRow {
    id: string;
    supplier_id: string;
    new_account: string;
    received_via: string;
    logged_by: string;
    status: Out<typeof development.BankChange>["status"];
    verified_by: string | null;
    callback_note: string | null;
    hold_until: string | null;
  }
  const toBankChange = (c: BankChangeRow): Out<typeof development.BankChange> => ({
    id: c.id,
    supplierId: c.supplier_id,
    newAccount: c.new_account,
    receivedVia: c.received_via,
    loggedBy: c.logged_by,
    status: c.status,
    verifiedBy: c.verified_by,
    callbackNote: c.callback_note,
    holdUntil: c.hold_until,
  });

  async function logBankChange(s: OrgScope, supplierId: string, b: Body<typeof development.logBankChange>) {
    return db.tx(async (t) => {
      const sp = await findSupplier(t, s.orgId, supplierId, true);
      const id = newId("dbc");
      await t.run(
        `INSERT INTO dev_bank_changes (id, org_id, supplier_id, new_account, received_via, logged_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_verification')`,
        [id, s.orgId, supplierId, mask(b.newAccount), b.receivedVia, s.userId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Bank detail change logged — payments blocked",
        target: supplierId,
        detail: `${sp.name} · ${b.receivedVia}`,
      });
      return toBankChange(
        (await t.row<BankChangeRow>("SELECT * FROM dev_bank_changes WHERE id = $1", [id])) as BankChangeRow,
      );
    });
  }

  async function verifyBankChange(s: OrgScope, id: string, note: string) {
    return db.tx(async (t) => {
      const c = await t.row<BankChangeRow>("SELECT * FROM dev_bank_changes WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        id,
      ]);
      if (!c) throw fail.notFound("Bank detail change not found");
      if (c.status !== "pending_verification") throw fail.conflict("This change is already verified");
      if (c.logged_by === s.userId)
        throw fail.separationOfDuties("You logged this change — a different person calls back");
      const hours = (await settingsRow(t, s.orgId)).bank_hold_hours;
      await t.run(
        `UPDATE dev_bank_changes SET status = 'on_hold', verified_by = $2, callback_note = $3,
           hold_until = now() + make_interval(hours => $4) WHERE id = $1`,
        [id, s.userId, note, hours],
      );
      await settleBankChanges(t, s.orgId);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Bank detail change verified by callback",
        target: c.supplier_id,
        detail: note,
      });
      return toBankChange(
        (await t.row<BankChangeRow>("SELECT * FROM dev_bank_changes WHERE id = $1", [id])) as BankChangeRow,
      );
    });
  }

  // ---------------------------------------------------------------- budgets
  async function ensureLine(t: Db, orgId: string, projectId: string, code: string) {
    await costCode(t, orgId, code);
    await t.run(
      "INSERT INTO dev_budget_lines (org_id, project_id, cost_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [orgId, projectId, code],
    );
  }

  async function setBudget(s: OrgScope, projectId: string, b: Body<typeof development.setBudget>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId, true);
      for (const l of b.lines) {
        await ensureLine(t, s.orgId, projectId, l.costCode);
        const cur = await t.row<{ original_set: boolean; original_minor: number; etc_minor: number }>(
          "SELECT * FROM dev_budget_lines WHERE project_id = $1 AND cost_code = $2 FOR UPDATE",
          [projectId, l.costCode],
        );
        if (l.originalMinor !== undefined && cur?.original_set && cur.original_minor !== l.originalMinor)
          throw fail.conflict(
            `The original budget for ${l.costCode} is set — change it with a transfer or change order`,
          );
        await t.run(
          `UPDATE dev_budget_lines SET original_minor = COALESCE($3, original_minor), original_set = original_set OR $3 IS NOT NULL,
             etc_minor = COALESCE($4, etc_minor), note = COALESCE($5, note) WHERE project_id = $1 AND cost_code = $2`,
          [projectId, l.costCode, l.originalMinor ?? null, l.etcMinor ?? null, l.note ?? null],
        );
      }
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Budget set", target: projectId, after: b.lines });
      return costReportOf(t, s.orgId, projectId);
    });
  }

  async function requestChange(s: OrgScope, projectId: string, b: Body<typeof development.requestBudgetChange>) {
    if (b.fromCode === b.toCode) throw fail.invalid("Pick two different cost codes");
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      await costCode(t, s.orgId, b.fromCode);
      await costCode(t, s.orgId, b.toCode);
      const id = newId("dbg");
      await t.run(
        `INSERT INTO dev_budget_changes (id, org_id, number, project_id, kind, from_code, to_code, amount_minor, reason, status,
           requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "BCH"),
          projectId,
          b.kind,
          b.fromCode,
          b.toCode,
          b.amountMinor,
          b.reason,
          s.userId,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: `Budget ${b.kind.replace("_", " ")} requested`,
        target: id,
        detail: b.reason,
      });
      return toChange((await t.row<ChangeRow>("SELECT * FROM dev_budget_changes WHERE id = $1", [id])) as ChangeRow);
    });
  }

  async function listChanges(s: OrgScope, projectId: string) {
    await findProject(db, s.orgId, projectId);
    const rows = await db.rows<ChangeRow>(
      "SELECT * FROM dev_budget_changes WHERE org_id = $1 AND project_id = $2 ORDER BY number",
      [s.orgId, projectId],
    );
    return { changes: rows.map(toChange) };
  }

  async function decideChange(s: OrgScope, id: string, approve: boolean, reason?: string) {
    return db.tx(async (t) => {
      const c = await t.row<ChangeRow>("SELECT * FROM dev_budget_changes WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        id,
      ]);
      if (!c) throw fail.notFound("Budget change not found");
      if (c.status !== "pending") throw fail.conflict(`The change is already ${c.status}`);
      if (approve) {
        await requireApproval(t, s, "budget_change", c.amount_minor, c.requested_by);
        await findProject(t, s.orgId, c.project_id, true);
        const report = await costReportOf(t, s.orgId, c.project_id);
        const from = report.rows.find((r) => r.costCode === c.from_code);
        if (!from || from.revisedMinor < c.amount_minor)
          throw fail.conflict(`Not enough budget left on ${c.from_code} (${from?.revisedMinor ?? 0})`);
        await ensureLine(t, s.orgId, c.project_id, c.from_code);
        await ensureLine(t, s.orgId, c.project_id, c.to_code);
        // a change order adds scope: it goes into the forecast of the receiving line
        if (c.kind === "change_order")
          await t.run(
            "UPDATE dev_budget_lines SET etc_minor = etc_minor + $3 WHERE project_id = $1 AND cost_code = $2",
            [c.project_id, c.to_code, c.amount_minor],
          );
      } else {
        if (!can(s, "developer.approve")) throw fail.roleNotAllowed("Your role cannot decide budget changes");
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason (at least 5 characters)");
      }
      await t.run(
        "UPDATE dev_budget_changes SET status = $2, approved_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1",
        [id, approve ? "approved" : "rejected", approve ? s.userId : null, reason ?? null],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: approve ? "Budget change approved" : "Budget change rejected",
        target: id,
        detail: `${c.amount_minor}`,
      });
      return toChange((await t.row<ChangeRow>("SELECT * FROM dev_budget_changes WHERE id = $1", [id])) as ChangeRow);
    });
  }

  // ---------------------------------------------------------------- requisitions and quotations
  const loadReq = async (t: Db, id: string) =>
    toRequisition((await t.row<RequisitionRow>(`${REQ_SELECT} WHERE r.id = $1`, [id])) as RequisitionRow);

  async function findReq(t: Db, orgId: string, id: string, lock = false): Promise<RequisitionRow> {
    if (lock) await t.run("SELECT 1 FROM dev_requisitions WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    const r = await t.row<RequisitionRow>(`${REQ_SELECT} WHERE r.org_id = $1 AND r.id = $2`, [orgId, id]);
    if (!r) throw fail.notFound("Requisition not found");
    return r;
  }

  async function createRequisition(s: OrgScope, projectId: string, b: Body<typeof development.createRequisition>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      await costCode(t, s.orgId, b.costCode);
      const id = newId("drq");
      await t.run(
        `INSERT INTO dev_requisitions (id, org_id, number, project_id, cost_code, item, qty, unit, est_unit_price_minor, need_by,
           status, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "PRQ"),
          projectId,
          b.costCode,
          b.item,
          b.qty,
          b.unit,
          b.estUnitPriceMinor,
          b.needBy ?? null,
          s.userId,
        ],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Requisition raised",
        target: id,
        detail: b.item,
      });
      return loadReq(t, id);
    });
  }

  async function listRequisitions(s: OrgScope, projectId?: string) {
    const rows = await db.rows<RequisitionRow>(
      `${REQ_SELECT} WHERE r.org_id = $1 AND ($2::text IS NULL OR r.project_id = $2) ORDER BY r.number`,
      [s.orgId, projectId ?? null],
    );
    return { requisitions: rows.map(toRequisition) };
  }

  async function decideRequisition(s: OrgScope, id: string, approve: boolean, reason?: string) {
    return db.tx(async (t) => {
      const r = await findReq(t, s.orgId, id, true);
      if (r.status !== "pending") throw fail.conflict(`The requisition is already ${r.status}`);
      if (approve)
        await requireApproval(t, s, "requisition", lineAmount(r.qty, r.est_unit_price_minor), r.requested_by);
      else {
        if (!can(s, "developer.approve")) throw fail.roleNotAllowed("Your role cannot decide requisitions");
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason (at least 5 characters)");
      }
      await t.run(
        "UPDATE dev_requisitions SET status = $2, approved_by = $3, decided_at = now(), reason = $4 WHERE id = $1",
        [id, approve ? "approved" : "rejected", approve ? s.userId : null, reason ?? null],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: approve ? "Requisition approved" : "Requisition rejected",
        target: id,
      });
      return loadReq(t, id);
    });
  }

  interface RfqRow {
    id: string;
    number: string;
    requisition_id: string;
    closes: string;
    status: "open" | "awarded";
    invited: string[];
    awarded_supplier_id: string | null;
    purchase_order_id: string | null;
  }

  async function rfqOut(t: Db, orgId: string, id: string): Promise<Out<typeof development.Rfq>> {
    const q = await t.row<RfqRow>("SELECT * FROM dev_rfqs WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!q) throw fail.notFound("Request for quotation not found");
    const r = await findReq(t, orgId, q.requisition_id);
    const bids = await t.rows<{
      supplier_id: string;
      unit_price_minor: number;
      lead_days: number;
      note: string;
      rating: number | null;
    }>(`SELECT b.*, s.rating FROM dev_rfq_bids b JOIN dev_suppliers s ON s.id = b.supplier_id WHERE b.rfq_id = $1`, [
      id,
    ]);
    const minP = Math.min(...bids.map((b) => b.unit_price_minor));
    const minL = Math.min(...bids.map((b) => b.lead_days));
    const scored = bids
      .map((b) => ({
        supplierId: b.supplier_id,
        unitPriceMinor: b.unit_price_minor,
        leadDays: b.lead_days,
        note: b.note,
        score: Math.round((60 * minP) / b.unit_price_minor + (20 * minL) / b.lead_days + (20 * (b.rating ?? 0)) / 5),
      }))
      .sort((a, b) => b.score - a.score || a.unitPriceMinor - b.unitPriceMinor);
    return {
      id: q.id,
      number: q.number,
      requisitionId: r.id,
      projectId: r.project_id,
      costCode: r.cost_code,
      item: r.item,
      qty: r.qty,
      unit: r.unit,
      closes: q.closes,
      status: q.status,
      invitedSupplierIds: q.invited,
      bids: scored,
      awardedSupplierId: q.awarded_supplier_id,
      purchaseOrderId: q.purchase_order_id,
    };
  }

  async function createRfq(s: OrgScope, requisitionId: string, b: Body<typeof development.createRfq>) {
    return db.tx(async (t) => {
      const r = await findReq(t, s.orgId, requisitionId, true);
      if (r.status !== "approved") throw fail.conflict("Only an approved requisition goes out for quotation");
      if (b.closes < s.today) throw fail.invalid("The closing date has passed");
      const invited = [...new Set(b.supplierIds)];
      for (const id of invited) {
        const sp = await findSupplier(t, s.orgId, id);
        if (sp.status !== "approved") throw fail.conflict(`${sp.name} is not an approved supplier`);
      }
      const id = newId("dfq");
      await t.run(
        `INSERT INTO dev_rfqs (id, org_id, number, requisition_id, closes, status, invited, created_by)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)`,
        [id, s.orgId, await nextNumber(t, s.orgId, "RFQ"), r.id, b.closes, invited, s.userId],
      );
      await t.run("UPDATE dev_requisitions SET status = 'rfq' WHERE id = $1", [r.id]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Quotations requested",
        target: id,
        detail: `${invited.length} supplier(s)`,
      });
      return rfqOut(t, s.orgId, id);
    });
  }

  async function recordBid(s: OrgScope, rfqId: string, b: Body<typeof development.recordBid>) {
    return db.tx(async (t) => {
      const q = await t.row<RfqRow>("SELECT * FROM dev_rfqs WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        rfqId,
      ]);
      if (!q) throw fail.notFound("Request for quotation not found");
      if (q.status !== "open") throw fail.conflict("The quotation is already awarded");
      if (!q.invited.includes(b.supplierId)) throw fail.invalid("That supplier was not invited");
      await t.run(
        `INSERT INTO dev_rfq_bids (rfq_id, supplier_id, unit_price_minor, lead_days, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (rfq_id, supplier_id) DO UPDATE SET unit_price_minor = $3, lead_days = $4, note = $5, recorded_by = $6`,
        [rfqId, b.supplierId, b.unitPriceMinor, b.leadDays, b.note, s.userId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Bid recorded",
        target: rfqId,
        detail: `${b.supplierId} · ${b.unitPriceMinor}`,
      });
      return rfqOut(t, s.orgId, rfqId);
    });
  }

  async function award(s: OrgScope, rfqId: string, b: Body<typeof development.awardRfq>) {
    return db.tx(async (t) => {
      const q = await t.row<RfqRow>("SELECT * FROM dev_rfqs WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        rfqId,
      ]);
      if (!q) throw fail.notFound("Request for quotation not found");
      if (q.status !== "open") throw fail.conflict("The quotation is already awarded");
      const view = await rfqOut(t, s.orgId, rfqId);
      const best = view.bids[0];
      if (!best) throw fail.conflict("No bids yet");
      const pick = b.supplierId ? view.bids.find((x) => x.supplierId === b.supplierId) : best;
      if (!pick) throw fail.invalid("That supplier has not bid");
      if (pick.supplierId !== best.supplierId && (!b.reason || b.reason.length < 5))
        throw fail.invalid("Give the reason for not awarding to the best-scoring bid");
      const r = await findReq(t, s.orgId, q.requisition_id, true);
      const poId = newId("dpo");
      const amount = lineAmount(r.qty, pick.unitPriceMinor);
      await t.run(
        `INSERT INTO dev_purchase_orders (id, org_id, supplier_id, project_id, number, date, amount_minor, status, description,
           kind, cost_code, prepared_by, requisition_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8, 'po', $9, $10, $11)`,
        [
          poId,
          s.orgId,
          pick.supplierId,
          r.project_id,
          await nextNumber(t, s.orgId, "PO"),
          s.today,
          amount,
          r.item,
          r.cost_code,
          s.userId,
          r.id,
        ],
      );
      await t.run(
        `INSERT INTO dev_po_lines (id, org_id, po_id, line_no, item, unit, qty, unit_price_minor) VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
        [newId("dpl"), s.orgId, poId, r.item, r.unit, r.qty, pick.unitPriceMinor],
      );
      await t.run(
        "UPDATE dev_rfqs SET status = 'awarded', awarded_supplier_id = $2, purchase_order_id = $3, award_reason = $4 WHERE id = $1",
        [rfqId, pick.supplierId, poId, b.reason ?? null],
      );
      await t.run("UPDATE dev_requisitions SET status = 'ordered' WHERE id = $1", [r.id]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Quotation awarded — order raised for approval",
        target: rfqId,
        detail: `${pick.supplierId} · ${amount}`,
      });
      return rfqOut(t, s.orgId, rfqId);
    });
  }

  // ---------------------------------------------------------------- purchase orders and contracts
  async function poOut(t: Db, o: PoRow): Promise<Out<typeof development.PurchaseOrder>> {
    const lines = await t.rows<{
      id: string;
      item: string;
      unit: string;
      qty: number;
      unit_price_minor: number;
      accepted: number;
      invoiced: number;
    }>(
      `SELECT l.*,
         COALESCE((SELECT sum(d.accepted_qty) FROM dev_delivery_lines d WHERE d.po_line_id = l.id), 0) AS accepted,
         COALESCE((SELECT sum(i.qty - i.credited_qty) FROM dev_invoice_lines i JOIN dev_supplier_invoices v ON v.id = i.invoice_id
                   WHERE i.po_line_id = l.id AND v.status NOT IN ('rejected', 'duplicate')), 0) AS invoiced
       FROM dev_po_lines l WHERE l.po_id = $1 ORDER BY l.line_no`,
      [o.id],
    );
    const money = await t.row<{ invoiced: number; held: number; released: number }>(
      `SELECT COALESCE(sum(net_minor) FILTER (WHERE kind = 'invoice'), 0)::bigint AS invoiced,
              COALESCE(sum(retention_minor) FILTER (WHERE kind = 'invoice'), 0)::bigint AS held,
              COALESCE(sum(payable_minor) FILTER (WHERE kind = 'retention_release'), 0)::bigint AS released
       FROM dev_supplier_invoices WHERE po_id = $1 AND status = ANY($2)`,
      [o.id, POSTED],
    );
    return {
      id: o.id,
      number: o.number,
      kind: o.kind,
      supplierId: o.supplier_id,
      projectId: o.project_id,
      costCode: o.cost_code,
      date: o.date,
      amountMinor: o.amount_minor,
      retentionBp: o.retention_bp,
      status: o.status,
      description: o.description,
      lines: lines.map((l) => ({
        id: l.id,
        item: l.item,
        unit: l.unit,
        qty: l.qty,
        unitPriceMinor: l.unit_price_minor,
        acceptedQty: l.accepted,
        invoicedQty: l.invoiced,
      })),
      preparedBy: o.prepared_by,
      approvedBy: o.approved_by,
      relatedParty: o.related_party,
      invoicedMinor: money?.invoiced ?? 0,
      retentionHeldMinor: money?.held ?? 0,
      retentionReleasedMinor: money?.released ?? 0,
      migrated: o.source_system !== null,
    };
  }

  async function findPo(t: Db, orgId: string, id: string, lock = false): Promise<PoRow> {
    if (lock) await t.run("SELECT 1 FROM dev_purchase_orders WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    const o = await t.row<PoRow>(`${PO_SELECT} WHERE o.org_id = $1 AND o.id = $2`, [orgId, id]);
    if (!o) throw fail.notFound("Purchase order not found");
    return o;
  }

  async function createPo(s: OrgScope, projectId: string, b: Body<typeof development.createPurchaseOrder>) {
    return db.tx(async (t) => {
      await findProject(t, s.orgId, projectId);
      await costCode(t, s.orgId, b.costCode);
      const sp = await findSupplier(t, s.orgId, b.supplierId);
      if (sp.status !== "approved") throw fail.conflict(`${sp.name} is not an approved supplier yet`);
      const fromLines = b.lines.reduce((n, l) => n + lineAmount(l.qty, l.unitPriceMinor), 0);
      if (b.lines.length && b.amountMinor !== undefined && b.amountMinor !== fromLines)
        throw fail.invalid(`The amount (${b.amountMinor}) is not the total of the lines (${fromLines})`);
      const amount = b.lines.length ? fromLines : (b.amountMinor ?? 0);
      if (b.requisitionId) {
        const r = await findReq(t, s.orgId, b.requisitionId, true);
        if (r.project_id !== projectId || r.status !== "approved")
          throw fail.conflict("The requisition must be approved and for this project");
        await t.run("UPDATE dev_requisitions SET status = 'ordered' WHERE id = $1", [r.id]);
      }
      const id = newId("dpo");
      await t.run(
        `INSERT INTO dev_purchase_orders (id, org_id, supplier_id, project_id, number, date, amount_minor, status, description,
           kind, cost_code, retention_bp, prepared_by, requisition_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8, $9, $10, $11, $12, $13)`,
        [
          id,
          s.orgId,
          b.supplierId,
          projectId,
          await nextNumber(t, s.orgId, b.kind === "contract" ? "SC" : "PO"),
          s.today,
          amount,
          b.description,
          b.kind,
          b.costCode,
          b.retentionBp,
          s.userId,
          b.requisitionId ?? null,
        ],
      );
      let n = 0;
      for (const l of b.lines)
        await t.run(
          "INSERT INTO dev_po_lines (id, org_id, po_id, line_no, item, unit, qty, unit_price_minor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [newId("dpl"), s.orgId, id, ++n, l.item, l.unit, l.qty, l.unitPriceMinor],
        );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Order raised for approval",
        target: id,
        detail: `${sp.name} · ${amount}`,
      });
      return poOut(t, await findPo(t, s.orgId, id));
    });
  }

  async function listPos(s: OrgScope, q: { projectId?: string | undefined; supplierId?: string | undefined }) {
    const rows = await db.rows<PoRow>(
      `${PO_SELECT} WHERE o.org_id = $1 AND ($2::text IS NULL OR o.project_id = $2) AND ($3::text IS NULL OR o.supplier_id = $3)
       ORDER BY o.date, o.number`,
      [s.orgId, q.projectId ?? null, q.supplierId ?? null],
    );
    return { purchaseOrders: await Promise.all(rows.map((o) => poOut(db, o))) };
  }

  async function decidePo(s: OrgScope, id: string, approve: boolean, reason?: string) {
    return db.tx(async (t) => {
      const o = await findPo(t, s.orgId, id, true);
      if (o.status !== "pending_approval") throw fail.conflict(`The order is ${o.status ?? "not awaiting approval"}`);
      if (approve) {
        await requireApproval(t, s, "purchase_order", o.amount_minor, o.prepared_by);
        if (o.related_party && !can(s, "developer.executive"))
          throw fail.forbidden("Orders with a related party need the chief executive, with disclosure");
        await findProject(t, s.orgId, o.project_id, true);
        const report = await costReportOf(t, s.orgId, o.project_id);
        const line = report.rows.find((r) => r.costCode === o.cost_code);
        const over = !line || line.committedMinor + o.amount_minor > line.revisedMinor;
        if (over && !can(s, "developer.executive"))
          throw fail.conflict(
            `Blocked: the commitment would exceed the revised budget for ${o.cost_code ?? "this cost code"} — needs the chief executive or a budget transfer`,
          );
        // what is now committed leaves the uncommitted forecast (counted once)
        if (o.cost_code)
          await t.run(
            "UPDATE dev_budget_lines SET etc_minor = etc_minor - LEAST(etc_minor, $3) WHERE project_id = $1 AND cost_code = $2",
            [o.project_id, o.cost_code, o.amount_minor],
          );
        await t.run(
          "UPDATE dev_purchase_orders SET status = 'approved', approved_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1",
          [
            id,
            s.userId,
            over ? `Chief executive exception: over budget${reason ? ` — ${reason}` : ""}` : (reason ?? null),
          ],
        );
      } else {
        if (!can(s, "developer.approve")) throw fail.roleNotAllowed("Your role cannot decide orders");
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason (at least 5 characters)");
        await t.run(
          "UPDATE dev_purchase_orders SET status = 'rejected', decided_at = now(), decision_reason = $2 WHERE id = $1",
          [id, reason],
        );
        if (o.requisition_id)
          await t.run("UPDATE dev_requisitions SET status = 'approved' WHERE id = $1 AND status = 'ordered'", [
            o.requisition_id,
          ]);
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: approve
          ? o.related_party
            ? "Related-party order approved with disclosure"
            : "Order approved"
          : "Order rejected",
        target: id,
        detail: `${o.amount_minor}`,
      });
      return poOut(t, await findPo(t, s.orgId, id));
    });
  }

  async function recordDelivery(s: OrgScope, poId: string, b: Body<typeof development.recordDelivery>) {
    if (b.date > s.today) throw fail.invalid("A delivery cannot be dated in the future");
    return db.tx(async (t) => {
      const o = await findPo(t, s.orgId, poId, true);
      if (!COMMITTED.includes(o.status ?? "")) throw fail.conflict("Deliveries are recorded against an approved order");
      const view = await poOut(t, o);
      const id = newId("dgr");
      await t.run(
        "INSERT INTO dev_deliveries (id, org_id, number, po_id, date, note, received_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [id, s.orgId, await nextNumber(t, s.orgId, "GRN"), poId, b.date, b.note, s.userId],
      );
      for (const l of b.lines) {
        const pl = view.lines.find((x) => x.id === l.poLineId);
        if (!pl) throw fail.invalid("That line is not on this order");
        if (l.acceptedQty > l.receivedQty) throw fail.invalid("Accepted cannot exceed received");
        if (l.acceptedQty + pl.acceptedQty > pl.qty + 1e-9)
          throw fail.invalid(`${pl.item}: more than ordered would be accepted`);
        await t.run(
          "INSERT INTO dev_delivery_lines (delivery_id, po_line_id, received_qty, accepted_qty) VALUES ($1, $2, $3, $4)",
          [id, l.poLineId, l.receivedQty, l.acceptedQty],
        );
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Delivery recorded",
        target: poId,
        detail: b.note,
      });
      const d = await t.row<{ number: string }>("SELECT number FROM dev_deliveries WHERE id = $1", [id]);
      return {
        id,
        number: d?.number ?? "",
        purchaseOrderId: poId,
        date: b.date,
        note: b.note,
        receivedBy: s.userId,
        lines: b.lines.map((l) => ({ poLineId: l.poLineId, receivedQty: l.receivedQty, acceptedQty: l.acceptedQty })),
      };
    });
  }

  return {
    listSuppliers,
    register,
    approveSupplier,
    logBankChange,
    verifyBankChange,
    setBudget,
    costReport: async (s: OrgScope, projectId: string) => {
      await findProject(db, s.orgId, projectId);
      return costReportOf(db, s.orgId, projectId);
    },
    requestChange,
    listChanges,
    decideChange,
    createRequisition,
    listRequisitions,
    decideRequisition,
    createRfq,
    getRfq: (s: OrgScope, id: string) => rfqOut(db, s.orgId, id),
    recordBid,
    award,
    createPo,
    listPos,
    decidePo,
    recordDelivery,
    findPo,
    poOut,
  };
}

export type ProcurementService = ReturnType<typeof procurementService>;
