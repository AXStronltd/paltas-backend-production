/*
 * Payables: supplier invoices and the money that leaves.
 *
 *   capture   with its evidence; checks run at once: possible duplicate (same supplier and number after removing
 *             spaces and symbols, or the same gross within 7 days), three-way match per line (ordered, accepted on
 *             delivery and not yet invoiced; price within the organisation's tolerance), supplier approved, evidence;
 *   approve   a matched invoice, within the approver's limit and never by the person who captured it; an invoice with
 *             no order that would take its cost code over budget needs the chief executive. It posts:
 *               Dr cost-code account (net) + Dr 1200 VAT / Cr 2000 payable (gross − retention) + Cr 2050 retention;
 *   runs      accounts payable prepares, a finance approver (within limit, not the preparer) approves, treasury (not the
 *             approver) executes — a bank file for the bank portal; each payment posts
 *               Dr 2000 (cash + withholding tax) / Cr 1000 cash + Cr 2200 withholding tax;
 *             invoices are paid only when the bank statement is matched by someone other than the executor;
 *   retention released on a contract becomes payable once approved: Dr 2050 / Cr 2000.
 */
import type { development, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { CoreServices } from "../../../core/core-services.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import { can } from "../shared/access.js";
import { cr, dr, post } from "../shared/posting.js";
import { bpOf, findProject, lineAmount, requireDocument } from "../shared/records.js";
import { costCode, requireApproval, settingsRow } from "../shared/rules.js";
import {
  COMMITTED,
  costReportOf,
  findSupplier,
  POSTED,
  settleBankChanges,
} from "../procurement/procurement.service.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Out<T extends z.ZodType> = z.input<T>;

/** Two invoices of the same gross from one supplier this close together look like the same invoice. */
const DUPLICATE_WINDOW_DAYS = 7;

interface InvoiceRow {
  id: string;
  number: string;
  kind: "invoice" | "retention_release";
  supplier_id: string;
  project_id: string;
  cost_code: string | null;
  po_id: string | null;
  supplier_invoice_no: string;
  normalized_no: string;
  date: string;
  due_date: string;
  description: string;
  net_minor: number;
  credit_minor: number;
  vat_bp: number;
  wht_bp: number;
  retention_bp: number;
  vat_minor: number;
  retention_minor: number;
  wht_minor: number;
  payable_minor: number;
  cash_minor: number;
  status: Out<typeof development.SupplierInvoice>["status"];
  exceptions: string[];
  captured_by: string;
  approved_by: string | null;
  evidence_document_id: string | null;
  dispute_amount_minor: number | null;
  dispute_reason: string | null;
  dispute_status: "open" | "settled" | null;
  journal_id: string | null;
  sent: number;
  reconciled: number;
  wht_settled: number;
}

const INVOICE_SELECT = `SELECT i.*,
    COALESCE((SELECT sum(p.amount_minor) FROM dev_supplier_payments p WHERE p.invoice_id = i.id AND p.status = 'sent'), 0)::bigint AS sent,
    COALESCE((SELECT sum(p.amount_minor) FROM dev_supplier_payments p WHERE p.invoice_id = i.id AND p.status = 'reconciled'), 0)::bigint AS reconciled,
    COALESCE((SELECT sum(p.wht_minor) FROM dev_supplier_payments p WHERE p.invoice_id = i.id AND p.status <> 'reversed'), 0)::bigint AS wht_settled
  FROM dev_supplier_invoices i`;

const normalise = (no: string) => no.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** VAT, retention and withholding tax on a net amount (basis points), and what is owed and paid out. */
export function amounts(net: number, vatBp: number, whtBp: number, retentionBp: number) {
  const vat = bpOf(net, vatBp);
  const retention = bpOf(net, retentionBp);
  const wht = bpOf(net, whtBp);
  const payable = net + vat - retention;
  return { vat, retention, wht, payable, cash: payable - wht };
}

const open = (i: InvoiceRow) => Math.max(0, i.cash_minor - i.sent - i.reconciled);

interface PaymentRow {
  id: string;
  run_id: string;
  invoice_id: string;
  supplier_id: string;
  amount_minor: number;
  wht_minor: number;
  reference: string;
  status: "sent" | "reconciled" | "reversed";
  journal_id: string | null;
  executed_by: string;
}

const toPayment = (p: PaymentRow): Out<typeof development.SupplierPayment> => ({
  id: p.id,
  invoiceId: p.invoice_id,
  supplierId: p.supplier_id,
  amountMinor: p.amount_minor,
  whtMinor: p.wht_minor,
  reference: p.reference,
  status: p.status,
  journalId: p.journal_id,
});

interface RunRow {
  id: string;
  number: string;
  status: Out<typeof development.PaymentRun>["status"];
  prepared_by: string;
  approved_by: string | null;
  executed_by: string | null;
}

export function payablesService(core: CoreServices) {
  const { db } = core;

  async function findInvoice(t: Db, orgId: string, id: string, lock = false): Promise<InvoiceRow> {
    if (lock) await t.run("SELECT 1 FROM dev_supplier_invoices WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    const i = await t.row<InvoiceRow>(`${INVOICE_SELECT} WHERE i.org_id = $1 AND i.id = $2`, [orgId, id]);
    if (!i) throw fail.notFound("Supplier invoice not found");
    return i;
  }

  /** Three-way match per invoiced order line (null for an invoice without order lines). */
  async function match(t: Db, i: InvoiceRow, toleranceBp: number): Promise<Out<typeof development.MatchLine>[] | null> {
    const lines = await t.rows<{
      po_line_id: string;
      qty: number;
      credited_qty: number;
      unit_price_minor: number;
      item: string;
      po_qty: number;
      po_price: number;
    }>(
      `SELECT l.*, p.item, p.qty AS po_qty, p.unit_price_minor AS po_price
       FROM dev_invoice_lines l JOIN dev_po_lines p ON p.id = l.po_line_id WHERE l.invoice_id = $1 ORDER BY l.line_no`,
      [i.id],
    );
    if (!lines.length) return null;
    const out = [];
    for (const l of lines) {
      const acc = await t.row<{ n: number }>(
        "SELECT COALESCE(sum(accepted_qty), 0) AS n FROM dev_delivery_lines WHERE po_line_id = $1",
        [l.po_line_id],
      );
      const elsewhere = await t.row<{ n: number }>(
        `SELECT COALESCE(sum(x.qty - x.credited_qty), 0) AS n FROM dev_invoice_lines x JOIN dev_supplier_invoices v ON v.id = x.invoice_id
         WHERE x.po_line_id = $1 AND x.invoice_id <> $2 AND v.status IN ('matched', 'approved', 'in_run', 'sent', 'paid')`,
        [l.po_line_id, i.id],
      );
      const accepted = acc?.n ?? 0;
      const available = accepted - (elsewhere?.n ?? 0);
      const qty = l.qty - l.credited_qty;
      out.push({
        item: l.item,
        poQty: l.po_qty,
        poUnitPriceMinor: l.po_price,
        acceptedQty: accepted,
        availableQty: available,
        invoicedQty: qty,
        invoicedUnitPriceMinor: l.unit_price_minor,
        qtyOk: qty <= available + 1e-9,
        priceOk: Math.abs(l.unit_price_minor - l.po_price) * 10_000 <= toleranceBp * l.po_price,
      });
    }
    return out;
  }

  /** Run the checks and set matched / exception. */
  async function runChecks(t: Db, orgId: string, id: string): Promise<void> {
    const i = await findInvoice(t, orgId, id);
    if (!["captured", "matched", "exception"].includes(i.status)) return;
    const fails: string[] = [];
    const gross = i.net_minor + i.vat_minor;
    const dup = await t.row<{ number: string; supplier_invoice_no: string }>(
      `SELECT number, supplier_invoice_no FROM dev_supplier_invoices
       WHERE org_id = $1 AND supplier_id = $2 AND id <> $3 AND number < $4 AND kind = 'invoice'
         AND status NOT IN ('rejected', 'duplicate')
         AND (normalized_no = $5 OR (net_minor + vat_minor = $6 AND abs(date - $7::date) <= $8))
       ORDER BY number LIMIT 1`,
      [orgId, i.supplier_id, i.id, i.number, i.normalized_no, gross, i.date, DUPLICATE_WINDOW_DAYS],
    );
    if (i.kind === "invoice" && dup) fails.push(`Possible duplicate of ${dup.supplier_invoice_no} (${dup.number})`);
    const tolerance = (await settingsRow(t, orgId)).price_tolerance_bp;
    for (const m of (await match(t, i, tolerance)) ?? []) {
      if (!m.qtyOk)
        fails.push(`${m.item}: billed ${m.invoicedQty}, only ${m.availableQty} accepted and not yet invoiced`);
      if (!m.priceOk)
        fails.push(`${m.item}: price ${m.invoicedUnitPriceMinor} against ${m.poUnitPriceMinor} on the order`);
    }
    const sp = await findSupplier(t, orgId, i.supplier_id);
    if (sp.status !== "approved") fails.push("Supplier not approved");
    if (i.kind === "invoice" && !i.evidence_document_id) fails.push("No evidence attached");
    await t.run("UPDATE dev_supplier_invoices SET status = $2, exceptions = $3 WHERE id = $1", [
      id,
      fails.length ? "exception" : "matched",
      fails,
    ]);
  }

  async function out(t: Db, orgId: string, id: string): Promise<Out<typeof development.SupplierInvoice>> {
    const i = await findInvoice(t, orgId, id);
    const tolerance = (await settingsRow(t, orgId)).price_tolerance_bp;
    return {
      id: i.id,
      number: i.number,
      kind: i.kind,
      supplierId: i.supplier_id,
      projectId: i.project_id,
      costCode: i.cost_code,
      purchaseOrderId: i.po_id,
      supplierInvoiceNo: i.supplier_invoice_no,
      date: i.date,
      dueDate: i.due_date,
      description: i.description,
      netMinor: i.net_minor,
      vatMinor: i.vat_minor,
      grossMinor: i.net_minor + i.vat_minor,
      retentionMinor: i.retention_minor,
      whtMinor: i.wht_minor,
      payableMinor: i.payable_minor,
      cashMinor: i.cash_minor,
      sentMinor: i.sent,
      paidMinor: i.reconciled,
      openMinor: open(i),
      status: i.status,
      exceptions: i.exceptions,
      capturedBy: i.captured_by,
      approvedBy: i.approved_by,
      evidenceDocumentId: i.evidence_document_id,
      dispute:
        i.dispute_status && i.dispute_amount_minor !== null
          ? { amountMinor: i.dispute_amount_minor, reason: i.dispute_reason ?? "", status: i.dispute_status }
          : null,
      creditNotesMinor: i.credit_minor,
      journalId: i.journal_id,
      match: await match(t, i, tolerance),
    };
  }

  /** Store a new net amount and everything that follows from it. */
  async function setNet(t: Db, i: InvoiceRow, net: number, credit: number) {
    const a = amounts(net, i.vat_bp, i.wht_bp, i.retention_bp);
    await t.run(
      `UPDATE dev_supplier_invoices SET net_minor = $2, credit_minor = $3, vat_minor = $4, retention_minor = $5, wht_minor = $6,
         payable_minor = $7, cash_minor = $8 WHERE id = $1`,
      [i.id, net, credit, a.vat, a.retention, a.wht, a.payable, a.cash],
    );
  }

  // ---------------------------------------------------------------- capture, check, decide
  async function capture(s: OrgScope, b: Body<typeof development.captureInvoice>) {
    if (b.dueDate < b.date) throw fail.invalid("The due date is before the invoice date");
    if (b.date > s.today) throw fail.invalid("The invoice date is in the future");
    return db.tx(async (t) => {
      await findProject(t, s.orgId, b.projectId);
      await findSupplier(t, s.orgId, b.supplierId);
      let code = b.costCode ?? null;
      let retentionBp = b.retentionBp ?? 0;
      const lines: { poLineId: string; qty: number; unitPriceMinor: number }[] = [];
      if (b.purchaseOrderId) {
        const po = await t.row<{
          supplier_id: string;
          project_id: string;
          status: string | null;
          cost_code: string | null;
          retention_bp: number;
        }>("SELECT * FROM dev_purchase_orders WHERE org_id = $1 AND id = $2", [s.orgId, b.purchaseOrderId]);
        if (!po) throw fail.notFound("Purchase order not found");
        if (po.supplier_id !== b.supplierId || po.project_id !== b.projectId)
          throw fail.invalid("The order is for another supplier or project");
        if (!COMMITTED.includes(po.status ?? "")) throw fail.conflict("The order is not approved");
        code = code ?? po.cost_code;
        retentionBp = b.retentionBp ?? po.retention_bp;
        for (const l of b.lines) {
          const pl = await t.row("SELECT 1 FROM dev_po_lines WHERE po_id = $1 AND id = $2", [
            b.purchaseOrderId,
            l.poLineId,
          ]);
          if (!pl) throw fail.invalid("An invoiced line is not on the order");
          lines.push(l);
        }
      } else if (b.lines.length) throw fail.invalid("Order lines need the purchase order");
      if (!code) throw fail.invalid("Give the cost code");
      await costCode(t, s.orgId, code);
      const net = lines.length ? lines.reduce((n, l) => n + lineAmount(l.qty, l.unitPriceMinor), 0) : b.netMinor;
      if (net === undefined) throw fail.invalid("Give the invoice lines or the net amount");
      if (lines.length && b.netMinor !== undefined && b.netMinor !== net)
        throw fail.invalid(`The net amount (${b.netMinor}) is not the total of the lines (${net})`);
      if (b.evidenceDocumentId) await requireDocument(t, s.orgId, b.evidenceDocumentId);
      const a = amounts(net, b.vatBp, b.whtBp, retentionBp);
      const id = newId("dsi");
      await t.run(
        `INSERT INTO dev_supplier_invoices (id, org_id, number, kind, supplier_id, project_id, cost_code, po_id, supplier_invoice_no,
           normalized_no, date, due_date, description, net_minor, vat_bp, wht_bp, retention_bp, vat_minor, retention_minor, wht_minor,
           payable_minor, cash_minor, status, captured_by, evidence_document_id)
         VALUES ($1, $2, $3, 'invoice', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
           'captured', $22, $23)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "SI"),
          b.supplierId,
          b.projectId,
          code,
          b.purchaseOrderId ?? null,
          b.supplierInvoiceNo,
          normalise(b.supplierInvoiceNo),
          b.date,
          b.dueDate,
          b.description,
          net,
          b.vatBp,
          b.whtBp,
          retentionBp,
          a.vat,
          a.retention,
          a.wht,
          a.payable,
          a.cash,
          s.userId,
          b.evidenceDocumentId ?? null,
        ],
      );
      let n = 0;
      for (const l of lines)
        await t.run(
          "INSERT INTO dev_invoice_lines (invoice_id, line_no, po_line_id, qty, unit_price_minor) VALUES ($1, $2, $3, $4, $5)",
          [id, ++n, l.poLineId, l.qty, l.unitPriceMinor],
        );
      await runChecks(t, s.orgId, id);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Supplier invoice captured",
        target: id,
        detail: b.supplierInvoiceNo,
      });
      return out(t, s.orgId, id);
    });
  }

  async function list(s: OrgScope, q: { status?: string | undefined; projectId?: string | undefined }) {
    const rows = await db.rows<{ id: string }>(
      `SELECT id FROM dev_supplier_invoices WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR project_id = $3) ORDER BY number`,
      [s.orgId, q.status ?? null, q.projectId ?? null],
    );
    return { invoices: await Promise.all(rows.map((r) => out(db, s.orgId, r.id))) };
  }

  async function check(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const i = await findInvoice(t, s.orgId, id, true);
      if (!["captured", "matched", "exception"].includes(i.status)) throw fail.conflict(`The invoice is ${i.status}`);
      await runChecks(t, s.orgId, id);
      await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Invoice checks run", target: id });
      return out(t, s.orgId, id);
    });
  }

  async function approve(t: Db, s: OrgScope, i: InvoiceRow) {
    await runChecks(t, s.orgId, i.id);
    const fresh = await findInvoice(t, s.orgId, i.id);
    if (fresh.status !== "matched") throw fail.conflict(`The checks fail: ${fresh.exceptions.join("; ")}`);
    const gross = fresh.kind === "retention_release" ? fresh.payable_minor : fresh.net_minor + fresh.vat_minor;
    await requireApproval(t, s, "invoice", gross, fresh.captured_by);
    let journal: string;
    const supplierDims = { project: fresh.project_id, supplier: fresh.supplier_id, invoice: fresh.id };
    if (fresh.kind === "retention_release") {
      journal = await post(t, core, {
        orgId: s.orgId,
        date: s.today,
        memo: `Retention released · ${fresh.supplier_invoice_no}`,
        ref: `invoice:${fresh.id}`,
        lines: [
          dr(ACC.retention, fresh.payable_minor, "Retention released", supplierDims),
          cr(ACC.payables, fresh.payable_minor, "Now owed to the contractor", supplierDims),
        ],
      });
    } else {
      if (!fresh.po_id) {
        // no order: the invoice itself commits budget
        await findProject(t, s.orgId, fresh.project_id, true);
        const line = (await costReportOf(t, s.orgId, fresh.project_id)).rows.find(
          (r) => r.costCode === fresh.cost_code,
        );
        if ((!line || line.committedMinor + fresh.net_minor > line.revisedMinor) && !can(s, "developer.executive"))
          throw fail.conflict(
            `Blocked: ${fresh.cost_code ?? "the cost code"} would go over its revised budget — needs the chief executive or a budget transfer`,
          );
      }
      const code = await costCode(t, s.orgId, fresh.cost_code ?? "");
      journal = await post(t, core, {
        orgId: s.orgId,
        date: s.today,
        memo: `Supplier invoice ${fresh.supplier_invoice_no} · ${fresh.number}`,
        ref: `invoice:${fresh.id}`,
        lines: [
          dr(code.account_code, fresh.net_minor, fresh.description, {
            ...supplierDims,
            kind: "cost",
            costCode: code.code,
          }),
          dr(ACC.vatInput, fresh.vat_minor, "VAT on purchases", supplierDims),
          cr(ACC.payables, fresh.payable_minor, `Owed to supplier · ${fresh.supplier_invoice_no}`, supplierDims),
          cr(ACC.retention, fresh.retention_minor, "Retention held", supplierDims),
        ],
      });
    }
    await t.run(
      "UPDATE dev_supplier_invoices SET status = 'approved', approved_by = $2, approved_at = now(), journal_id = $3 WHERE id = $1",
      [fresh.id, s.userId, journal],
    );
  }

  async function decide(
    s: OrgScope,
    id: string,
    action: "approve" | "reject" | "duplicate" | "override",
    reason?: string,
  ) {
    return db.tx(async (t) => {
      const i = await findInvoice(t, s.orgId, id, true);
      if (action === "approve") {
        if (i.status !== "matched") throw fail.conflict(`Only a matched invoice can be approved (it is ${i.status})`);
        await approve(t, s, i);
      } else if (action === "reject") {
        if (!can(s, "developer.approve")) throw fail.roleNotAllowed("Your role cannot reject invoices");
        if (!["captured", "matched", "exception", "disputed"].includes(i.status))
          throw fail.conflict(`The invoice is ${i.status}`);
        if (!reason || reason.length < 5) throw fail.invalid("Give the reason (at least 5 characters)");
        await t.run("UPDATE dev_supplier_invoices SET status = 'rejected' WHERE id = $1", [id]);
      } else if (action === "duplicate") {
        if (!can(s, "developer.payables")) throw fail.roleNotAllowed("Your role cannot mark duplicates");
        if (!["captured", "matched", "exception"].includes(i.status)) throw fail.conflict(`The invoice is ${i.status}`);
        await t.run("UPDATE dev_supplier_invoices SET status = 'duplicate' WHERE id = $1", [id]);
      } else {
        if (!can(s, "developer.executive")) throw fail.roleNotAllowed("Exception approvals need the chief executive");
        if (i.status !== "exception") throw fail.conflict("Only an invoice with exceptions can be overridden");
        if (!reason || reason.length < 5)
          throw fail.invalid("Record the reason for the exception (at least 5 characters)");
        await t.run(
          "UPDATE dev_supplier_invoices SET status = 'matched', override_by = $2, override_reason = $3 WHERE id = $1",
          [id, s.userId, reason],
        );
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: {
          approve: "Invoice approved and posted",
          reject: "Invoice rejected",
          duplicate: "Invoice marked duplicate",
          override: "Invoice exception approved",
        }[action],
        target: id,
        detail: reason ?? "",
      });
      return out(t, s.orgId, id);
    });
  }

  async function dispute(s: OrgScope, id: string, amount: number, reason: string) {
    return db.tx(async (t) => {
      const i = await findInvoice(t, s.orgId, id, true);
      if (!["captured", "matched", "exception"].includes(i.status)) throw fail.conflict(`The invoice is ${i.status}`);
      if (amount > i.net_minor) throw fail.invalid("The disputed amount is more than the invoice");
      await t.run(
        "UPDATE dev_supplier_invoices SET status = 'disputed', dispute_amount_minor = $2, dispute_reason = $3, dispute_status = 'open' WHERE id = $1",
        [id, amount, reason],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Invoice disputed",
        target: id,
        detail: `${amount}: ${reason}`,
      });
      return out(t, s.orgId, id);
    });
  }

  async function settleDispute(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const i = await findInvoice(t, s.orgId, id, true);
      if (i.status !== "disputed" || i.dispute_amount_minor === null)
        throw fail.conflict("The invoice is not disputed");
      await setNet(t, i, i.net_minor - i.dispute_amount_minor, i.credit_minor + i.dispute_amount_minor);
      await t.run("UPDATE dev_supplier_invoices SET status = 'captured', dispute_status = 'settled' WHERE id = $1", [
        id,
      ]);
      await runChecks(t, s.orgId, id);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Invoice dispute settled — credit accepted",
        target: id,
        detail: `${i.dispute_amount_minor}`,
      });
      return out(t, s.orgId, id);
    });
  }

  async function creditNote(s: OrgScope, id: string, b: Body<typeof development.applyCreditNote>) {
    return db.tx(async (t) => {
      const i = await findInvoice(t, s.orgId, id, true);
      if (!["captured", "matched", "exception", "disputed"].includes(i.status))
        throw fail.conflict(`A credit note applies to an invoice before approval (it is ${i.status})`);
      let credit = 0;
      if (b.lines.length) {
        for (const l of b.lines) {
          const il = await t.row<{ line_no: number; qty: number; credited_qty: number; unit_price_minor: number }>(
            "SELECT * FROM dev_invoice_lines WHERE invoice_id = $1 AND po_line_id = $2",
            [id, l.poLineId],
          );
          if (!il) throw fail.invalid("That line is not on the invoice");
          if (l.qty > il.qty - il.credited_qty + 1e-9) throw fail.invalid("More is credited than was invoiced");
          await t.run(
            "UPDATE dev_invoice_lines SET credited_qty = credited_qty + $3 WHERE invoice_id = $1 AND line_no = $2",
            [id, il.line_no, l.qty],
          );
          credit += lineAmount(l.qty, il.unit_price_minor);
        }
      } else credit = b.netMinor ?? 0;
      if (credit <= 0 || credit > i.net_minor)
        throw fail.invalid("The credit must be more than nothing and not more than the invoice");
      await t.run(
        "INSERT INTO dev_credit_notes (id, org_id, invoice_id, supplier_credit_no, reason, net_minor, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [newId("dcn"), s.orgId, id, b.supplierCreditNo, b.reason, credit, s.userId],
      );
      await setNet(t, i, i.net_minor - credit, i.credit_minor + credit);
      await runChecks(t, s.orgId, id);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Credit note applied",
        target: id,
        detail: `${b.supplierCreditNo} · ${credit}`,
      });
      return out(t, s.orgId, id);
    });
  }

  async function releaseRetention(s: OrgScope, poId: string, b: Body<typeof development.releaseRetention>) {
    if (b.dueDate < s.today) throw fail.invalid("The due date has passed");
    return db.tx(async (t) => {
      const po = await t.row<{
        id: string;
        number: string | null;
        supplier_id: string;
        project_id: string;
        cost_code: string | null;
      }>("SELECT * FROM dev_purchase_orders WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, poId]);
      if (!po) throw fail.notFound("Purchase order not found");
      const m = await t.row<{ held: number; released: number; n: number }>(
        `SELECT COALESCE(sum(retention_minor) FILTER (WHERE kind = 'invoice' AND status = ANY($2)), 0)::bigint AS held,
                COALESCE(sum(payable_minor) FILTER (WHERE kind = 'retention_release' AND status NOT IN ('rejected', 'duplicate')), 0)::bigint AS released,
                count(*) FILTER (WHERE kind = 'retention_release')::int AS n
         FROM dev_supplier_invoices WHERE po_id = $1`,
        [poId, POSTED],
      );
      const left = (m?.held ?? 0) - (m?.released ?? 0);
      if (b.amountMinor > left)
        throw fail.invalid(`Only ${left} of retention is held on this contract`, { heldMinor: left });
      const id = newId("dsi");
      const no = `RET-${po.number ?? po.id}-${(m?.n ?? 0) + 1}`;
      await t.run(
        `INSERT INTO dev_supplier_invoices (id, org_id, number, kind, supplier_id, project_id, cost_code, po_id, supplier_invoice_no,
           normalized_no, date, due_date, description, net_minor, payable_minor, cash_minor, status, captured_by)
         VALUES ($1, $2, $3, 'retention_release', $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $13, 'captured', $14)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "SI"),
          po.supplier_id,
          po.project_id,
          po.cost_code,
          poId,
          no,
          normalise(no),
          s.today,
          b.dueDate,
          b.reason,
          b.amountMinor,
          s.userId,
        ],
      );
      await runChecks(t, s.orgId, id);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Retention release prepared",
        target: id,
        detail: `${b.amountMinor}: ${b.reason}`,
      });
      return out(t, s.orgId, id);
    });
  }

  // ---------------------------------------------------------------- payment runs
  async function runOut(t: Db, orgId: string, id: string): Promise<Out<typeof development.PaymentRun>> {
    const r = await t.row<RunRow>("SELECT * FROM dev_payment_runs WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!r) throw fail.notFound("Payment run not found");
    const items = await t.rows<{ invoice_id: string; amount_minor: number }>(
      "SELECT * FROM dev_payment_run_items WHERE run_id = $1 ORDER BY invoice_id",
      [id],
    );
    const pays = await t.rows<PaymentRow>("SELECT * FROM dev_supplier_payments WHERE run_id = $1 ORDER BY reference", [
      id,
    ]);
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      preparedBy: r.prepared_by,
      approvedBy: r.approved_by,
      executedBy: r.executed_by,
      totalMinor: items.reduce((n, i) => n + i.amount_minor, 0),
      invoiceIds: items.map((i) => i.invoice_id),
      payments: pays.map(toPayment),
    };
  }

  /** Why an invoice cannot be paid now (null: it can). */
  async function payBlock(t: Db, orgId: string, i: InvoiceRow): Promise<string | null> {
    if (i.status !== "approved") return `${i.number} is ${i.status}`;
    if (open(i) <= 0) return `${i.number} has nothing left to pay`;
    const sp = await findSupplier(t, orgId, i.supplier_id);
    if (sp.status !== "approved") return `${sp.name} is not approved`;
    if (sp.blocked_change) return `${sp.name} has an unverified bank-detail change`;
    return null;
  }

  async function prepareRun(s: OrgScope, b: Body<typeof development.preparePaymentRun>) {
    return db.tx(async (t) => {
      await settleBankChanges(t, s.orgId);
      const ids = b.invoiceIds
        ? b.invoiceIds
        : (
            await t.rows<{ id: string }>(
              "SELECT id FROM dev_supplier_invoices WHERE org_id = $1 AND status = 'approved' AND due_date <= $2 ORDER BY due_date, number",
              [s.orgId, addDays(s.today, b.dueWithinDays)],
            )
          ).map((r) => r.id);
      const picked: InvoiceRow[] = [];
      for (const id of ids) {
        const i = await findInvoice(t, s.orgId, id, true);
        const why = await payBlock(t, s.orgId, i);
        if (why && b.invoiceIds) throw fail.conflict(`Cannot pay: ${why}`);
        if (!why) picked.push(i);
      }
      if (!picked.length) throw fail.conflict("No approved invoices are ready to pay");
      const id = newId("drn");
      await t.run(
        "INSERT INTO dev_payment_runs (id, org_id, number, status, prepared_by) VALUES ($1, $2, $3, 'awaiting_approval', $4)",
        [id, s.orgId, await nextNumber(t, s.orgId, "RUN"), s.userId],
      );
      for (const i of picked) {
        await t.run("INSERT INTO dev_payment_run_items (run_id, invoice_id, amount_minor) VALUES ($1, $2, $3)", [
          id,
          i.id,
          open(i),
        ]);
        await t.run("UPDATE dev_supplier_invoices SET status = 'in_run' WHERE id = $1", [i.id]);
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Payment run prepared",
        target: id,
        detail: `${picked.length} invoice(s)`,
      });
      return runOut(t, s.orgId, id);
    });
  }

  async function listRuns(s: OrgScope) {
    const rows = await db.rows<{ id: string }>("SELECT id FROM dev_payment_runs WHERE org_id = $1 ORDER BY number", [
      s.orgId,
    ]);
    return { runs: await Promise.all(rows.map((r) => runOut(db, s.orgId, r.id))) };
  }

  async function lockRun(t: Db, orgId: string, id: string): Promise<RunRow> {
    const r = await t.row<RunRow>("SELECT * FROM dev_payment_runs WHERE org_id = $1 AND id = $2 FOR UPDATE", [
      orgId,
      id,
    ]);
    if (!r) throw fail.notFound("Payment run not found");
    return r;
  }

  async function approveRun(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const r = await lockRun(t, s.orgId, id);
      if (r.status !== "awaiting_approval") throw fail.conflict(`The run is ${r.status.replace("_", " ")}`);
      const view = await runOut(t, s.orgId, id);
      await requireApproval(t, s, "payment_run", view.totalMinor, r.prepared_by);
      await t.run(
        "UPDATE dev_payment_runs SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
        [id, s.userId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Payment run approved",
        target: id,
        detail: `${view.totalMinor}`,
      });
      return runOut(t, s.orgId, id);
    });
  }

  async function executeRun(s: OrgScope, id: string) {
    return db.tx(async (t) => {
      const r = await lockRun(t, s.orgId, id);
      if (r.status !== "approved") throw fail.conflict("Only an approved run can be executed");
      if (r.approved_by === s.userId) throw fail.separationOfDuties("You approved this run — someone else executes it");
      await settleBankChanges(t, s.orgId);
      const items = await t.rows<{ invoice_id: string; amount_minor: number }>(
        "SELECT * FROM dev_payment_run_items WHERE run_id = $1 ORDER BY invoice_id",
        [id],
      );
      const file = ["reference,supplier,account,amount_minor"];
      let k = 0;
      for (const it of items) {
        const i = await findInvoice(t, s.orgId, it.invoice_id, true);
        const sp = await findSupplier(t, s.orgId, i.supplier_id);
        if (sp.blocked_change)
          throw fail.conflict(`${sp.name} has an unverified bank-detail change — take it out of the run`);
        const ref = `${r.number}-${String(++k).padStart(2, "0")}`;
        // the withholding tax still to settle on this invoice goes with its last payment
        const wht = Math.max(0, i.wht_minor - i.wht_settled);
        const pid = newId("dsy");
        const dims = { project: i.project_id, supplier: i.supplier_id, invoice: i.id };
        const journal = await post(t, core, {
          orgId: s.orgId,
          date: s.today,
          memo: `Supplier payment ${ref} · ${sp.name}`,
          ref: `pay:${pid}`,
          lines: [
            dr(ACC.payables, it.amount_minor + wht, `Paid ${i.supplier_invoice_no}`, dims),
            cr(ACC.bank, it.amount_minor, `Bank transfer ${ref}`, dims),
            cr(ACC.wht, wht, "Withholding tax kept for the tax authority", dims),
          ],
        });
        await t.run(
          `INSERT INTO dev_supplier_payments (id, org_id, run_id, invoice_id, supplier_id, amount_minor, wht_minor, reference, status,
             journal_id, executed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', $9, $10)`,
          [pid, s.orgId, id, i.id, i.supplier_id, it.amount_minor, wht, ref, journal, s.userId],
        );
        await t.run("UPDATE dev_supplier_invoices SET status = 'sent' WHERE id = $1", [i.id]);
        file.push([ref, `"${sp.name.replace(/"/g, '""')}"`, sp.bank_account ?? "", it.amount_minor].join(","));
      }
      await t.run("UPDATE dev_payment_runs SET status = 'sent', executed_by = $2, executed_at = now() WHERE id = $1", [
        id,
        s.userId,
      ]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Payment run executed — bank file generated (no bank is connected)",
        target: id,
      });
      return {
        run: await runOut(t, s.orgId, id),
        bankFile: { filename: `${r.number}-bank-file.csv`, content: file.join("\r\n") + "\r\n" },
      };
    });
  }

  async function reconcile(s: OrgScope, lines: Body<typeof development.reconcilePayments>["lines"]) {
    return db.tx(async (t) => {
      let matched = 0;
      const unmatched: { reference: string; amountMinor: number; reason: string }[] = [];
      const touched = new Set<string>();
      for (const l of lines) {
        const p = await t.row<PaymentRow>(
          "SELECT * FROM dev_supplier_payments WHERE org_id = $1 AND upper(reference) = upper($2) AND status = 'sent' FOR UPDATE",
          [s.orgId, l.reference],
        );
        const why = !p
          ? "No sent payment with this reference"
          : p.amount_minor !== Math.abs(l.amountMinor)
            ? "The amount differs from the payment"
            : p.executed_by === s.userId
              ? "You executed this payment — someone else reconciles it"
              : null;
        if (why || !p) {
          unmatched.push({ reference: l.reference, amountMinor: l.amountMinor, reason: why ?? "" });
          continue;
        }
        await t.run(
          "UPDATE dev_supplier_payments SET status = 'reconciled', reconciled_by = $2, reconciled_at = now(), statement_date = $3 WHERE id = $1",
          [p.id, s.userId, l.date],
        );
        touched.add(p.invoice_id);
        matched++;
        const left = await t.row("SELECT 1 FROM dev_supplier_payments WHERE run_id = $1 AND status = 'sent'", [
          p.run_id,
        ]);
        if (!left) await t.run("UPDATE dev_payment_runs SET status = 'reconciled' WHERE id = $1", [p.run_id]);
      }
      for (const invoiceId of touched) {
        const i = await findInvoice(t, s.orgId, invoiceId, true);
        if (i.status === "sent" && i.sent === 0 && i.reconciled >= i.cash_minor)
          await t.run("UPDATE dev_supplier_invoices SET status = 'paid' WHERE id = $1", [i.id]);
      }
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Bank statement matched",
        detail: `${lines.length} line(s) · ${matched} payment(s) confirmed`,
      });
      return { matched, unmatched };
    });
  }

  async function reverse(s: OrgScope, id: string, reason: string) {
    return db.tx(async (t) => {
      const p = await t.row<PaymentRow>(
        "SELECT * FROM dev_supplier_payments WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [s.orgId, id],
      );
      if (!p) throw fail.notFound("Payment not found");
      if (p.status === "reversed") throw fail.conflict("The payment is already reversed");
      const i = await findInvoice(t, s.orgId, p.invoice_id, true);
      const dims = { project: i.project_id, supplier: i.supplier_id, invoice: i.id };
      const journal = await post(t, core, {
        orgId: s.orgId,
        date: s.today,
        memo: `Reversal of supplier payment ${p.reference}: ${reason}`,
        ref: `payrev:${p.id}`,
        lines: [
          dr(ACC.bank, p.amount_minor, `Returned ${p.reference}`, dims),
          dr(ACC.wht, p.wht_minor, "Withholding tax not due", dims),
          cr(ACC.payables, p.amount_minor + p.wht_minor, `Owed again · ${i.supplier_invoice_no}`, dims),
        ],
      });
      await t.run(
        "UPDATE dev_supplier_payments SET status = 'reversed', reversal_journal_id = $2, reverse_reason = $3 WHERE id = $1",
        [id, journal, reason],
      );
      await t.run("UPDATE dev_supplier_invoices SET status = 'approved' WHERE id = $1", [i.id]);
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Supplier payment reversed",
        target: id,
        detail: reason,
      });
      return toPayment(
        (await t.row<PaymentRow>("SELECT * FROM dev_supplier_payments WHERE id = $1", [id])) as PaymentRow,
      );
    });
  }

  return {
    capture,
    list,
    get: (s: OrgScope, id: string) => out(db, s.orgId, id),
    check,
    decide,
    dispute,
    settleDispute,
    creditNote,
    releaseRetention,
    prepareRun,
    listRuns,
    approveRun,
    executeRun,
    reconcile,
    reverse,
  };
}

export type PayablesService = ReturnType<typeof payablesService>;
