/*
 * Dashboards and the approvals inbox. Every money figure on the dashboard is shown with the ledger balance it must
 * equal: buyer receivables (1170) against billed, unpaid instalments; accounts payable (2000) and retention (2050)
 * against supplier invoices, payments and migrated opening balances; project cost against the cost lines posted for
 * approved invoices. Cash, deposits held, revenue and cost of sales are read from the ledger itself.
 */
import type { development, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { CoreServices } from "../../../core/core-services.js";
import { ACC } from "../accounts.js";
import { can } from "../shared/access.js";
import { ledgerBalance } from "../shared/posting.js";
import { findProject, lineAmount, seesBuyer } from "../shared/records.js";
import { approvalBlock, settingsRow } from "../shared/rules.js";
import { costReportOf, POSTED } from "../procurement/procurement.service.js";
import { approvalLevel } from "../sales/sales.service.js";

type Out<T extends z.ZodType> = z.input<T>;

const tie = (subledger: number, ledger: number) => ({
  subledgerMinor: subledger,
  ledgerMinor: ledger,
  agrees: subledger === ledger,
});

export function reportsService(core: CoreServices) {
  const { db } = core;

  async function dashboard(s: OrgScope, projectId?: string): Promise<Out<typeof development.Dashboard>> {
    if (projectId) await findProject(db, s.orgId, projectId);
    const pf = projectId ?? null;
    const org = await db.row<{ currency: string }>("SELECT currency FROM organisations WHERE id = $1", [s.orgId]);
    const units = await db.rows<{ status: string; n: number }>(
      `SELECT COALESCE(status, 'available') AS status, count(*)::int AS n FROM dev_units
       WHERE org_id = $1 AND ($2::text IS NULL OR project_id = $2) GROUP BY 1`,
      [s.orgId, pf],
    );
    const stock = await db.row<{ contracts: number; unsold: number; offers: number }>(
      `SELECT
         COALESCE((SELECT sum(i.amount_minor) FROM dev_instalments i JOIN dev_contracts k ON k.id = i.contract_id
                   JOIN dev_units u ON u.id = k.unit_id
                   WHERE k.org_id = $1 AND k.status IS DISTINCT FROM 'cancelled' AND ($2::text IS NULL OR u.project_id = $2)), 0)::bigint AS contracts,
         COALESCE((SELECT sum(list_price_minor) FROM dev_units WHERE org_id = $1 AND ($2::text IS NULL OR project_id = $2)
                   AND COALESCE(status, 'available') IN ('available', 'on_hold', 'reserved', 'blocked')), 0)::bigint AS unsold,
         (SELECT count(*) FROM dev_offers WHERE org_id = $1 AND ($2::text IS NULL OR project_id = $2)
            AND status IN ('draft', 'awaiting_approval', 'submitted', 'counteroffer'))::int AS offers`,
      [s.orgId, pf],
    );
    const col = await db.row<{ due: number; collected: number }>(
      `SELECT COALESCE(sum(i.amount_minor), 0)::bigint AS due,
              COALESCE(sum(LEAST(i.amount_minor, (SELECT COALESCE(sum(a.amount_minor), 0) FROM dev_payment_allocations a
                                                  WHERE a.instalment_id = i.id))), 0)::bigint AS collected
       FROM dev_instalments i JOIN dev_contracts k ON k.id = i.contract_id JOIN dev_units u ON u.id = k.unit_id
       WHERE k.org_id = $1 AND k.status IS DISTINCT FROM 'cancelled' AND i.due_date <= $3 AND ($2::text IS NULL OR u.project_id = $2)`,
      [s.orgId, pf, s.today],
    );
    // billed and unpaid, plus migrated arrears carried in the opening balance and not yet taken into the subledger
    const recv = await db.row<{ n: number }>(
      `SELECT COALESCE(sum(CASE WHEN i.billed THEN i.receivable_minor
                WHEN EXISTS (SELECT 1 FROM dev_opening_balances o WHERE o.contract_id = i.contract_id AND o.kind = 'buyer_receivable'
                             AND o.as_of >= i.due_date)
                THEN GREATEST(0, i.amount_minor - (SELECT COALESCE(sum(a.amount_minor), 0) FROM dev_payment_allocations a WHERE a.instalment_id = i.id))
                ELSE 0 END), 0)::bigint AS n
       FROM dev_instalments i WHERE i.org_id = $1`,
      [s.orgId],
    );
    const projects = pf
      ? [pf]
      : (await db.rows<{ id: string }>("SELECT id FROM dev_projects WHERE org_id = $1", [s.orgId])).map((p) => p.id);
    const cost = {
      revisedMinor: 0,
      committedMinor: 0,
      invoicedMinor: 0,
      eacMinor: 0,
      costToCompleteMinor: 0,
      varianceMinor: 0,
      ledger: 0,
    };
    for (const p of projects) {
      const r = await costReportOf(db, s.orgId, p);
      cost.revisedMinor += r.totals.revisedMinor;
      cost.committedMinor += r.totals.committedMinor;
      cost.invoicedMinor += r.totals.invoicedMinor;
      cost.eacMinor += r.totals.eacMinor;
      cost.costToCompleteMinor += r.totals.costToCompleteMinor;
      cost.varianceMinor += r.totals.varianceMinor;
      cost.ledger += r.ledger.invoicedMinor;
    }
    const ap = await db.row<{ invoices: number; paid: number; opening: number; held: number; released: number }>(
      `SELECT
         COALESCE((SELECT sum(payable_minor) FROM dev_supplier_invoices WHERE org_id = $1 AND status = ANY($2)), 0)::bigint AS invoices,
         COALESCE((SELECT sum(amount_minor + wht_minor) FROM dev_supplier_payments WHERE org_id = $1 AND status <> 'reversed'), 0)::bigint AS paid,
         COALESCE((SELECT sum(amount_minor) FROM dev_opening_balances WHERE org_id = $1 AND kind = 'supplier_payable'), 0)::bigint AS opening,
         COALESCE((SELECT sum(retention_minor) FROM dev_supplier_invoices WHERE org_id = $1 AND kind = 'invoice' AND status = ANY($2)), 0)::bigint AS held,
         COALESCE((SELECT sum(payable_minor) FROM dev_supplier_invoices WHERE org_id = $1 AND kind = 'retention_release' AND status = ANY($2)), 0)::bigint AS released`,
      [s.orgId, POSTED],
    );
    const bal = (a: string) => ledgerBalance(db, s.orgId, [a]);
    const operating = await bal(ACC.bank);
    const collections = await bal(ACC.collections);
    const due = col?.due ?? 0;
    const collected = col?.collected ?? 0;
    return {
      asOf: s.today,
      currency: org?.currency ?? "",
      sales: {
        unitsByStatus: Object.fromEntries(units.map((u) => [u.status, u.n])),
        contractValueMinor: stock?.contracts ?? 0,
        unsoldStockMinor: stock?.unsold ?? 0,
        openOffers: stock?.offers ?? 0,
      },
      collections: {
        dueToDateMinor: due,
        collectedMinor: collected,
        overdueMinor: due - collected,
        collectedPct: due ? Math.round((collected * 100) / due) : 100,
        receivables: tie(recv?.n ?? 0, await bal(ACC.receivables)),
        depositsHeldMinor: -(await bal(ACC.deposits)),
      },
      cost: {
        revisedMinor: cost.revisedMinor,
        committedMinor: cost.committedMinor,
        invoicedMinor: cost.invoicedMinor,
        eacMinor: cost.eacMinor,
        costToCompleteMinor: cost.costToCompleteMinor,
        varianceMinor: cost.varianceMinor,
        ledger: tie(cost.invoicedMinor, cost.ledger),
      },
      payables: {
        accountsPayable: tie((ap?.invoices ?? 0) - (ap?.paid ?? 0) + (ap?.opening ?? 0), -(await bal(ACC.payables))),
        retention: tie((ap?.held ?? 0) - (ap?.released ?? 0), -(await bal(ACC.retention))),
      },
      cash: { operatingMinor: operating, collectionsMinor: collections, totalMinor: operating + collections },
      revenue: { recognisedMinor: -(await bal(ACC.revenue)), costOfSalesMinor: await bal(ACC.costOfSales) },
    };
  }

  // ---------------------------------------------------------------- approvals inbox
  async function approvals(s: OrgScope): Promise<{ items: Out<typeof development.ApprovalItem>[] }> {
    const items: Out<typeof development.ApprovalItem>[] = [];
    const ok = async (kind: Parameters<typeof approvalBlock>[2], amount: number, by: string | null) =>
      !(await approvalBlock(db, s, kind, amount, by));

    for (const r of await db.rows<{
      id: string;
      number: string;
      item: string;
      qty: number;
      est_unit_price_minor: number;
      requested_by: string;
    }>("SELECT * FROM dev_requisitions WHERE org_id = $1 AND status = 'pending' ORDER BY number", [s.orgId])) {
      const amount = lineAmount(r.qty, r.est_unit_price_minor);
      if (await ok("requisition", amount, r.requested_by))
        items.push({ type: "requisition", id: r.id, reference: r.number, detail: r.item, amountMinor: amount });
    }
    for (const o of await db.rows<{
      id: string;
      number: string | null;
      description: string | null;
      amount_minor: number;
      prepared_by: string | null;
      related_party: boolean;
    }>(
      `SELECT o.*, s.related_party FROM dev_purchase_orders o JOIN dev_suppliers s ON s.id = o.supplier_id
       WHERE o.org_id = $1 AND o.status = 'pending_approval' ORDER BY o.number`,
      [s.orgId],
    ))
      if (
        (await ok("purchase_order", o.amount_minor, o.prepared_by)) &&
        (!o.related_party || can(s, "developer.executive"))
      )
        items.push({
          type: o.related_party ? "related_party_order" : "purchase_order",
          id: o.id,
          reference: o.number ?? o.id,
          detail: o.description ?? "",
          amountMinor: o.amount_minor,
        });
    for (const c of await db.rows<{
      id: string;
      number: string;
      reason: string;
      amount_minor: number;
      requested_by: string;
      kind: string;
    }>("SELECT * FROM dev_budget_changes WHERE org_id = $1 AND status = 'pending' ORDER BY number", [s.orgId]))
      if (await ok("budget_change", c.amount_minor, c.requested_by))
        items.push({ type: c.kind, id: c.id, reference: c.number, detail: c.reason, amountMinor: c.amount_minor });
    for (const i of await db.rows<{
      id: string;
      number: string;
      supplier_invoice_no: string;
      net_minor: number;
      vat_minor: number;
      payable_minor: number;
      kind: string;
      captured_by: string;
    }>("SELECT * FROM dev_supplier_invoices WHERE org_id = $1 AND status = 'matched' ORDER BY number", [s.orgId])) {
      const gross = i.kind === "retention_release" ? i.payable_minor : i.net_minor + i.vat_minor;
      if (await ok("invoice", gross, i.captured_by))
        items.push({
          type: i.kind === "retention_release" ? "retention_release" : "invoice",
          id: i.id,
          reference: i.number,
          detail: i.supplier_invoice_no,
          amountMinor: gross,
        });
    }
    for (const r of await db.rows<{
      id: string;
      number: string;
      status: string;
      prepared_by: string;
      approved_by: string | null;
      total: number;
    }>(
      `SELECT r.*, COALESCE((SELECT sum(amount_minor) FROM dev_payment_run_items i WHERE i.run_id = r.id), 0)::bigint AS total
       FROM dev_payment_runs r WHERE r.org_id = $1 AND r.status IN ('awaiting_approval', 'approved') ORDER BY r.number`,
      [s.orgId],
    )) {
      if (r.status === "awaiting_approval" && (await ok("payment_run", r.total, r.prepared_by)))
        items.push({
          type: "payment_run",
          id: r.id,
          reference: r.number,
          detail: "Approve payment run",
          amountMinor: r.total,
        });
      if (r.status === "approved" && can(s, "developer.treasury") && r.approved_by !== s.userId)
        items.push({
          type: "execute_payment_run",
          id: r.id,
          reference: r.number,
          detail: "Send the bank file",
          amountMinor: r.total,
        });
    }
    if (can(s, "developer.suppliers.verify")) {
      for (const c of await db.rows<{ id: string; supplier_id: string; logged_by: string; name: string }>(
        `SELECT b.*, s.name FROM dev_bank_changes b JOIN dev_suppliers s ON s.id = b.supplier_id
         WHERE b.org_id = $1 AND b.status = 'pending_verification' ORDER BY b.created_at`,
        [s.orgId],
      ))
        if (c.logged_by !== s.userId)
          items.push({ type: "bank_change", id: c.id, reference: c.supplier_id, detail: c.name, amountMinor: 0 });
      for (const p of await db.rows<{
        id: string;
        name: string;
        registered_by: string | null;
        missing_documents: string[];
      }>("SELECT * FROM dev_suppliers WHERE org_id = $1 AND status = 'pending' ORDER BY name", [s.orgId]))
        if (p.registered_by !== s.userId && !p.missing_documents.length)
          items.push({ type: "supplier", id: p.id, reference: p.id, detail: p.name, amountMinor: 0 });
    }
    const rules = await settingsRow(db, s.orgId);
    for (const o of await db.rows<Parameters<typeof approvalLevel>[0] & { buyer_agent: string | null }>(
      `SELECT o.*, c.agent_user_id AS buyer_agent FROM dev_offers o JOIN dev_contacts c ON c.id = o.buyer_id
       WHERE o.org_id = $1 AND o.status = 'awaiting_approval' ORDER BY o.number`,
      [s.orgId],
    )) {
      const level = o.approval_level ?? approvalLevel(o, rules);
      const may = can(s, "developer.executive") || (level === "manager" && can(s, "developer.sales.manage"));
      if (
        may &&
        seesBuyer(s, { agent_user_id: o.buyer_agent }) &&
        ![o.created_by, o.agent_user_id, o.approval_requested_by].includes(s.userId)
      )
        items.push({
          type: "offer",
          id: o.id,
          reference: o.number,
          detail: `${level} approval`,
          amountMinor: o.price_minor,
        });
    }
    if (can(s, "developer.sales.manage"))
      for (const r of await db.rows<{
        id: string;
        requested_by: string | null;
        agent: string | null;
        creator: string | null;
        price: number | null;
      }>(
        `SELECT r.id, r.requested_by, o.agent_user_id AS agent, o.created_by AS creator, o.price_minor AS price
         FROM dev_reservations r LEFT JOIN dev_offers o ON o.id = r.offer_id
         WHERE r.org_id = $1 AND r.status = 'awaiting_approval' ORDER BY r.date`,
        [s.orgId],
      ))
        if (![r.requested_by, r.agent, r.creator].includes(s.userId))
          items.push({
            type: "reservation",
            id: r.id,
            reference: r.id,
            detail: "Approve reservation",
            amountMinor: r.price ?? 0,
          });
    if (can(s, "developer.collections"))
      for (const p of await db.rows<{
        id: string;
        number: string;
        reference: string;
        amount_minor: number;
        reported_by: string;
      }>("SELECT * FROM dev_payment_reports WHERE org_id = $1 AND status = 'awaiting_verification' ORDER BY number", [
        s.orgId,
      ]))
        if (p.reported_by !== s.userId)
          items.push({
            type: "buyer_payment",
            id: p.id,
            reference: p.number,
            detail: p.reference,
            amountMinor: p.amount_minor,
          });
    if (can(s, "developer.pricing"))
      for (const l of await db.rows<{ id: string; number: string; prepared_by: string }>(
        "SELECT * FROM dev_price_lists WHERE org_id = $1 AND status = 'draft' ORDER BY number",
        [s.orgId],
      ))
        if (l.prepared_by !== s.userId)
          items.push({
            type: "price_list",
            id: l.id,
            reference: l.number,
            detail: "Approve price list",
            amountMinor: 0,
          });
    return { items };
  }

  return { dashboard, approvals };
}

export type ReportsService = ReturnType<typeof reportsService>;
