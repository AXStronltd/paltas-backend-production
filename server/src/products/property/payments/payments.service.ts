import { financeTransaction } from "../shared/finance-transaction.js";
/*
 * Tenant money: recorded payments (never processed) with allocation and receipt numbers, the tenant's credit, the
 * tenant statement, payments tenants report from the portal, and deposit settlements at move-out (second person).
 *
 *   payment recorded    Dr 1040 client account / Cr 1120 (allocated) / Cr 2310 tenant credit (unallocated),
 *                       then one collection posting per invoice paid (see shared/money.ts)
 *   credit applied      Dr 2310 / Cr 1120, then the collection posting
 *   deposit settled     Dr 2300 held / Cr 1120 arrears applied / Cr 2250 deductions kept for the owner / Cr 1040 refund
 */
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { PmDeps } from "../deps.js";
import { allocate, numberScope, oldestFirst, openInvoicesForUpdate } from "../shared/money.js";
import { cr, dr, post } from "../shared/posting.js";
import * as R from "../shared/records.js";
import { sum } from "../shared/util.js";
import { ownerFunds } from "../shared/owner-funds.js";
import { formatMoney } from "../../../lib/money.js";

interface ClaimRow {
  id: string;
  tenant_id: string;
  amount_minor: number;
  date: string;
  method: string;
  reference: string;
  note: string;
  status: "pending" | "matched" | "rejected";
  payment_id: string | null;
  reason: string | null;
  submitted_at: string;
}

interface RefundRow {
  id: string;
  number: string;
  lease_id: string;
  tenant_id: string;
  held_minor: number;
  arrears_minor: number;
  deductions_minor: number;
  deductions: { amountMinor: number; reason: string }[];
  refund_minor: number;
  refund_reference: string;
  status: "requested" | "approved" | "rejected";
  requested_by: string;
  decided_by: string | null;
  reject_reason: string | null;
  journal_id: string | null;
}

export const toClaim = (r: ClaimRow): P.PaymentClaim => ({
  id: r.id,
  tenantId: r.tenant_id,
  amountMinor: r.amount_minor,
  date: r.date,
  method: r.method,
  reference: r.reference,
  note: r.note,
  status: r.status,
  paymentId: r.payment_id,
  reason: r.reason,
  submittedAt: r.submitted_at,
});

const toRefund = (r: RefundRow): P.DepositRefund => ({
  id: r.id,
  number: r.number,
  leaseId: r.lease_id,
  tenantId: r.tenant_id,
  heldMinor: r.held_minor,
  arrearsMinor: r.arrears_minor,
  deductionsMinor: r.deductions_minor,
  deductions: r.deductions,
  refundMinor: r.refund_minor,
  refundReference: r.refund_reference,
  status: r.status,
  requestedBy: r.requested_by,
  decidedBy: r.decided_by,
  rejectReason: r.reject_reason,
  journalId: r.journal_id,
});

/** The invoices a deposit may settle: the lease's own, and the tenant's opening balances brought over. */
const DEPOSIT_TARGETS = "(i.lease_id = $3 OR i.kind = 'opening') AND i.kind <> 'deposit'";

export function paymentsService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  const paymentView = async (orgId: string, id: string): Promise<P.Payment> => {
    const rows = await R.paymentRows(db, orgId, "p.id = $2", [id]);
    if (!rows.length) throw fail.notFound("Payment not found");
    const [v] = await R.paymentViews(db, rows);
    return v as P.Payment;
  };

  const refundRow = async (t: Db, orgId: string, id: string, lock = false) => {
    const r = await t.row<RefundRow>(
      `SELECT * FROM pm_deposit_refunds WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!r) throw fail.notFound("Deposit settlement not found");
    return r;
  };

  /**
   * Record a payment inside the caller's transaction (also used by the bank match): allocations as given, or the
   * oldest invoices first; the rest is the tenant's credit. Returns the payment id.
   */
  async function recordIn(
    t: Db,
    s: OrgScope,
    b: {
      tenantId: string;
      date: string;
      amountMinor: number;
      method: P.PaymentMethod;
      reference: string;
      note: string;
      allocations?: { invoiceId: string; amountMinor: number }[] | undefined;
      claimId?: string | undefined;
      bankLineId?: string | null;
    },
  ): Promise<string> {
    if (b.date > s.today) throw fail.invalid("A payment cannot be dated in the future");
    // one payment at a time per tenant: allocations never race
    const tenant = await core.contacts.live(t, s.orgId, b.tenantId, true);
    const dup = await t.row<{ number: string }>(
      "SELECT number FROM pm_payments WHERE org_id = $1 AND method = $2 AND upper(btrim(reference)) = upper(btrim($3))",
      [s.orgId, b.method, b.reference],
    );
    if (dup) throw fail.conflict(`Reference ${b.reference} is already recorded as ${dup.number}`);
    const open = await openInvoicesForUpdate(t, s.orgId, b.tenantId);
    let plan: [R.InvoiceRow, number][];
    if (b.allocations?.length) {
      plan = [];
      for (const a of b.allocations) {
        const inv = open.find((i) => i.id === a.invoiceId);
        if (!inv) throw fail.invalid(`Invoice ${a.invoiceId} is not an open invoice of this tenant`);
        if (a.amountMinor > R.balanceOf(inv))
          throw fail.invalid(
            `${inv.number} has only ${formatMoney(R.balanceOf(inv), s.entitlement.org.currency)} outstanding`,
          );
        plan.push([inv, a.amountMinor]);
      }
      if (sum(plan, (p) => p[1]) > b.amountMinor) throw fail.invalid("The allocations add up to more than the payment");
    } else plan = oldestFirst(open, b.amountMinor);
    let claim: ClaimRow | null = null;
    if (b.claimId) {
      claim = await t.row<ClaimRow>("SELECT * FROM pm_payment_claims WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        s.orgId,
        b.claimId,
      ]);
      if (!claim || claim.tenant_id !== b.tenantId) throw fail.notFound("Reported payment not found");
      if (claim.status !== "pending") throw fail.conflict(`This reported payment is already ${claim.status}`);
    }
    const id = newId("ppy");
    const number = await nextNumber(t, numberScope(s.orgId), "PAY", 6);
    const receipt = await nextNumber(t, numberScope(s.orgId), "RCT", 6);
    await t.run(
      `INSERT INTO pm_payments (id, org_id, number, receipt_number, tenant_id, date, amount_minor, method, reference, note,
         claim_id, bank_line_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        s.orgId,
        number,
        receipt,
        b.tenantId,
        b.date,
        b.amountMinor,
        b.method,
        b.reference,
        b.note,
        b.claimId ?? null,
        b.bankLineId ?? null,
        s.userId,
      ],
    );
    const allocated = sum(plan, (p) => p[1]);
    const journalId = await post(t, core, {
      orgId: s.orgId,
      date: b.date,
      kind: "receipt",
      memo: `${number} · receipt ${receipt} · ${tenant.name} · ${b.method} ${b.reference} (recorded, not processed by PALTAS)`,
      ref: `payment:${id}`,
      link: { tenantId: b.tenantId },
      lines: [
        dr(ACC.clientBank, b.amountMinor, `${b.method} ${b.reference}`),
        cr(ACC.receivables, allocated, "Allocated to invoices"),
        cr(ACC.tenantCredits, b.amountMinor - allocated, "Held as the tenant's credit"),
      ],
    });
    await t.run("UPDATE pm_payments SET journal_id = $2 WHERE id = $1", [id, journalId]);
    for (const [inv, amount] of plan)
      await allocate(t, core, { invoice: inv, amount, date: b.date, by: s.userId, source: "payment", paymentId: id });
    if (claim)
      await t.run(
        "UPDATE pm_payment_claims SET status = 'matched', payment_id = $2, decided_by = $3, decided_at = now() WHERE id = $1",
        [claim.id, id, s.userId],
      );
    await core.contacts.activity(t, {
      orgId: s.orgId,
      contactId: b.tenantId,
      kind: "payment",
      text: `Payment ${number} recorded: ${b.amountMinor} by ${b.method} (${b.reference}) · receipt ${receipt}`,
      refType: "payment",
      refId: id,
      by: s.userId,
    });
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Payment recorded",
      target: number,
      detail: `${tenant.name} · ${b.amountMinor} · ${b.method} ${b.reference} · receipt ${receipt} · ${plan.length} invoice(s)`,
    });
    return id;
  }

  return {
    recordIn,
    paymentView,

    async record(s: OrgScope, b: Parameters<typeof recordIn>[2]) {
      const id = await financeTransaction(db, s.orgId, (t) => recordIn(t, s, b));
      return paymentView(s.orgId, id);
    },

    async requestReversal(s: OrgScope, id: string, reason: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const p = await t.row<R.PaymentRow>("SELECT * FROM pm_payments WHERE org_id=$1 AND id=$2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!p) throw fail.notFound("Payment not found");
        if (p.bank_line_id)
          throw fail.conflict(
            "This receipt is matched to the bank. Resolve the bank reconciliation before requesting a correction.",
          );
        const prior = await t.row<{ rejected_by: string | null }>(
          "SELECT rejected_by FROM pm_payment_reversals WHERE payment_id=$1",
          [id],
        );
        if (prior && !prior.rejected_by)
          throw fail.conflict("A correction has already been requested for this receipt");
        await t.run(
          "INSERT INTO pm_payment_reversals(payment_id,org_id,reason,requested_by) VALUES($1,$2,$3,$4) ON CONFLICT(payment_id) DO UPDATE SET reason=EXCLUDED.reason,requested_by=EXCLUDED.requested_by,requested_at=now(),rejected_by=NULL,rejected_reason=NULL,rejected_at=NULL",
          [id, s.orgId, reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Receipt correction requested",
          target: p.receipt_number,
          detail: reason,
        });
      });
      return paymentView(s.orgId, id);
    },
    async rejectReversal(s: OrgScope, id: string, reason: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await t.row<{ requested_by: string; approved_by: string | null; rejected_by: string | null }>(
          "SELECT * FROM pm_payment_reversals WHERE org_id=$1 AND payment_id=$2 FOR UPDATE",
          [s.orgId, id],
        );
        if (!r) throw fail.notFound("Receipt correction not found");
        if (r.approved_by || r.rejected_by) throw fail.conflict("This correction has already been decided");
        if (r.requested_by === s.userId)
          throw fail.separationOfDuties("Another authorised person must review your correction");
        await t.run(
          "UPDATE pm_payment_reversals SET rejected_by=$2,rejected_reason=$3,rejected_at=now() WHERE payment_id=$1",
          [id, s.userId, reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Receipt correction rejected",
          target: id,
          detail: reason,
        });
      });
      return paymentView(s.orgId, id);
    },
    async approveReversal(s: OrgScope, id: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        // The organisation-scoped financial transaction locks before checking dependencies.
        // No source receipt, allocation or journal is deleted or overwritten.
        const p = await t.row<R.PaymentRow>("SELECT * FROM pm_payments WHERE org_id=$1 AND id=$2", [s.orgId, id]);
        if (!p) throw fail.notFound("Payment not found");
        const r = await t.row<{
          requested_by: string;
          approved_by: string | null;
          rejected_by: string | null;
          reason: string;
        }>("SELECT * FROM pm_payment_reversals WHERE org_id=$1 AND payment_id=$2", [s.orgId, id]);
        if (!r) throw fail.notFound("Receipt correction not found");
        if (r.approved_by) throw fail.conflict("This receipt has already been reversed");
        if (r.rejected_by) throw fail.conflict("This correction was rejected. Request a new review before approval.");
        if (r.requested_by === s.userId)
          throw fail.separationOfDuties("Another authorised person must approve your correction");
        if (
          p.bank_line_id ||
          (await t.row("SELECT 1 FROM pm_bank_lines WHERE org_id=$1 AND matched_kind='payment' AND matched_id=$2", [
            s.orgId,
            id,
          ]))
        )
          throw fail.conflict("The receipt is matched to a bank statement and cannot be reversed here");
        if (!p.journal_id || p.date > s.today)
          throw fail.conflict("This receipt needs an accountant to review its original posting");
        const allocs = await t.rows<{
          amount_minor: number;
          journal_id: string | null;
          invoice_id: string;
          owner_id: string | null;
          lease_id: string | null;
        }>(
          "SELECT a.*,i.owner_id,i.lease_id FROM pm_allocations a JOIN pm_invoices i ON i.id=a.invoice_id WHERE a.org_id=$1 AND a.payment_id=$2",
          [s.orgId, id],
        );
        const unused = p.amount_minor - sum(allocs, (a) => a.amount_minor);
        if ((await R.tenantCredit(t, s.orgId, p.tenant_id)) < unused)
          throw fail.conflict("The receipt's credit has been used. Correct the dependent transactions first.");
        const journalIds = [p.journal_id, ...allocs.map((a) => a.journal_id).filter((x): x is string => !!x)];
        const journals = await t.rows<{
          id: string;
          owner_id: string | null;
          property_id: string | null;
          lease_id: string | null;
          kind: "receipt" | "collection";
          reversed_by: string | null;
          date: string;
        }>(
          "SELECT e.id,e.date,e.reversed_by,k.owner_id,k.property_id,k.lease_id,k.kind FROM journal_entries e JOIN pm_ledger_links k ON k.journal_id=e.id WHERE e.org_id=$1 AND e.id=ANY($2)",
          [s.orgId, journalIds],
        );
        if (journals.length !== journalIds.length || journals.some((j) => j.reversed_by))
          throw fail.conflict("The original postings have already been changed or need an accountant's review");
        const ownerIds = [...new Set(allocs.map((a) => a.owner_id).filter((x): x is string => !!x))];
        for (const ownerId of ownerIds) {
          if (
            await t.row(
              "SELECT 1 FROM pm_payouts WHERE org_id=$1 AND owner_id=$2 AND status IN ('prepared','approved')",
              [s.orgId, ownerId],
            )
          )
            throw fail.conflict("Cancel the owner's pending payout before correcting this receipt");
          const delta = await t.row<{ n: number }>(
            "SELECT COALESCE(sum(l.credit_minor-l.debit_minor),0)::bigint AS n FROM journal_lines l JOIN pm_ledger_links k ON k.journal_id=l.entry_id WHERE l.org_id=$1 AND k.owner_id=$2 AND l.account_code=$3 AND l.entry_id=ANY($4)",
            [s.orgId, ownerId, ACC.ownerFunds, journalIds],
          );
          if (((await ownerFunds(t, s.orgId, s.today, ownerId)).get(ownerId) ?? 0) < (delta?.n ?? 0))
            throw fail.conflict("The owner's funds have been used. Correct the dependent transactions first.");
        }
        const leaseIds = [...new Set(allocs.map((a) => a.lease_id).filter((x): x is string => !!x))];
        if (
          leaseIds.length &&
          (await t.row(
            "SELECT 1 FROM pm_deposit_refunds WHERE org_id=$1 AND lease_id=ANY($2) AND status IN ('requested','approved')",
            [s.orgId, leaseIds],
          ))
        )
          throw fail.conflict("A deposit settlement depends on this lease. Resolve it before correcting the receipt.");
        for (const j of journals) {
          const lines = await t.rows<{ account_code: string; debit_minor: number; credit_minor: number }>(
            "SELECT account_code,debit_minor,credit_minor FROM journal_lines WHERE org_id=$1 AND entry_id=$2 ORDER BY line_no",
            [s.orgId, j.id],
          );
          const reverseId = await post(t, core, {
            orgId: s.orgId,
            date: s.today,
            kind: j.kind,
            memo: `Correction of ${p.receipt_number}: ${r.reason}`,
            ref: `receipt-reversal:${id}:${j.id}`,
            reverses: j.id,
            link: { tenantId: p.tenant_id, ownerId: j.owner_id, propertyId: j.property_id, leaseId: j.lease_id },
            lines: lines.map((l) => ({
              account: l.account_code,
              debitMinor: l.credit_minor,
              creditMinor: l.debit_minor,
            })),
          });
          await t.run("UPDATE journal_entries SET reversed_by=$2 WHERE id=$1", [j.id, reverseId]);
        }
        await t.run("UPDATE pm_payment_reversals SET approved_by=$2,approved_at=now(),date=$3 WHERE payment_id=$1", [
          id,
          s.userId,
          s.today,
        ]);
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: p.tenant_id,
          kind: "payment",
          text: `Receipt ${p.receipt_number} reversed: ${r.reason}`,
          by: s.userId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Receipt correction approved",
          target: p.receipt_number,
          detail: r.reason,
        });
      });
      return paymentView(s.orgId, id);
    },

    async list(
      s: OrgScope,
      f: { tenantId?: string | undefined; limit?: number | undefined; offset?: number | undefined },
    ) {
      // Existing callers can still request their complete tenant statement; table views explicitly paginate.
      if (f.limit === undefined && f.offset === undefined) {
        const rows = await R.paymentRows(db, s.orgId, "($2::text IS NULL OR p.tenant_id = $2)", [f.tenantId ?? null]);
        return { payments: await R.paymentViews(db, rows) };
      }
      const limit = f.limit ?? 50,
        offset = f.offset ?? 0;
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const total = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM pm_payments WHERE org_id=$1 AND ($2::text IS NULL OR tenant_id=$2)",
          [s.orgId, f.tenantId ?? null],
        );
        const rows = await t.rows<R.PaymentRow>(
          `${R.PAYMENT_SQL} WHERE p.org_id=$1 AND ($2::text IS NULL OR p.tenant_id=$2) ORDER BY p.date DESC,p.number DESC,p.id DESC LIMIT $3 OFFSET $4`,
          [s.orgId, f.tenantId ?? null, limit, offset],
        );
        return { payments: await R.paymentViews(t, rows), total: total?.n ?? 0, limit, offset };
      });
    },

    async applyCredit(s: OrgScope, tenantId: string) {
      const ids = await financeTransaction(db, s.orgId, async (t) => {
        await core.contacts.live(t, s.orgId, tenantId, true);
        const credit = await R.tenantCredit(t, s.orgId, tenantId);
        if (credit <= 0) throw fail.conflict("This tenant has no credit to apply");
        const open = await openInvoicesForUpdate(t, s.orgId, tenantId);
        const plan = oldestFirst(open, credit);
        if (!plan.length) throw fail.conflict("This tenant has no open invoices");
        const out: string[] = [];
        for (const [inv, amount] of plan) {
          const allocId = await allocate(t, core, {
            invoice: inv,
            amount,
            date: s.today,
            by: s.userId,
            source: "credit",
          });
          await post(t, core, {
            orgId: s.orgId,
            date: s.today,
            kind: "receipt",
            memo: `Tenant credit applied to ${inv.number} · ${inv.tenant_name}`,
            ref: `credit:${allocId}`,
            link: { tenantId },
            lines: [dr(ACC.tenantCredits, amount, "Credit applied"), cr(ACC.receivables, amount, inv.number)],
          });
          out.push(allocId);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Tenant credit applied",
          target: tenantId,
          detail: `${sum(plan, (p) => p[1])} to ${plan.length} invoice(s)`,
        });
        return out;
      });
      const allocs = await db.rows<R.AllocationRow>(
        `SELECT a.*, i.number AS invoice_number FROM pm_allocations a JOIN pm_invoices i ON i.id = a.invoice_id
         WHERE a.id = ANY($1) ORDER BY a.created_at, a.id`,
        [ids],
      );
      return {
        allocations: allocs.map((a) => ({
          invoiceId: a.invoice_id,
          invoiceNumber: a.invoice_number,
          amountMinor: a.amount_minor,
          source: a.source,
          sourceId: a.id,
          date: a.date,
        })),
        creditLeftMinor: Math.max(0, await R.tenantCredit(db, s.orgId, tenantId)),
      };
    },

    async statement(s: OrgScope, tenantId: string): Promise<P.TenantStatement> {
      const tenant = await core.contacts.get(s.orgId, tenantId);
      const invoices = await R.invoiceViews(
        db,
        await R.invoiceRows(db, s.orgId, "i.tenant_id = $2", [tenantId]),
        s.today,
      );
      const payments = await R.paymentViews(db, await R.paymentRows(db, s.orgId, "p.tenant_id = $2", [tenantId]));
      const credit = Math.max(0, await R.tenantCredit(db, s.orgId, tenantId));
      const leases = await db.rows<{ id: string }>("SELECT id FROM pm_leases WHERE org_id = $1 AND tenant_id = $2", [
        s.orgId,
        tenantId,
      ]);
      const held = await R.depositsHeld(
        db,
        s.orgId,
        leases.map((l) => l.id),
      );
      const opening = await db.row<{ n: number }>(
        `SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM pm_opening_deposits o WHERE o.tenant_id = $1
           AND NOT EXISTS (SELECT 1 FROM pm_leases l WHERE l.tenant_id = o.tenant_id AND l.migrated)`,
        [tenantId],
      );
      // running account: what was billed (debits) against what paid it (payments, credit notes, deposit applied)
      const events: { date: string; kind: string; ref: string; debit: number; credit: number }[] = [];
      for (const i of invoices)
        events.push({ date: i.issueDate, kind: `invoice (${i.kind})`, ref: i.number, debit: i.amountMinor, credit: 0 });
      for (const p of payments)
        events.push({
          date: p.date,
          kind: "payment",
          ref: `${p.number} / ${p.receiptNumber}`,
          debit: 0,
          credit: p.amountMinor,
        });
      for (const p of payments)
        if (p.reversal?.approvedBy && p.reversal.date)
          events.push({
            date: p.reversal.date,
            kind: "receipt reversal",
            ref: p.receiptNumber,
            debit: p.amountMinor,
            credit: 0,
          });
      for (const i of invoices)
        for (const a of i.allocations.filter((x) => x.source === "credit_note" || x.source === "deposit"))
          events.push({
            date: a.date,
            kind: a.source === "deposit" ? "deposit applied" : "credit note",
            ref: i.number,
            debit: 0,
            credit: a.amountMinor,
          });
      events.sort((a, b) => a.date.localeCompare(b.date) || b.debit - a.debit);
      let running = 0;
      const lines = events.map((e) => {
        running += e.debit - e.credit;
        return {
          date: e.date,
          kind: e.kind,
          ref: e.ref,
          debitMinor: e.debit,
          creditMinor: e.credit,
          balanceMinor: running,
        };
      });
      return {
        tenantId,
        tenantName: tenant.name,
        invoices,
        payments,
        balanceMinor: sum(invoices, (i) => i.balanceMinor),
        creditMinor: credit,
        depositHeldMinor:
          Math.max(
            0,
            sum([...held.values()], (v) => v),
          ) + (opening?.n ?? 0),
        lines,
      };
    },

    async listClaims(s: OrgScope, status?: "pending" | "matched" | "rejected") {
      const rows = await db.rows<ClaimRow>(
        "SELECT * FROM pm_payment_claims WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY submitted_at DESC",
        [s.orgId, status ?? null],
      );
      return { claims: rows.map(toClaim) };
    },

    async rejectClaim(s: OrgScope, id: string, reason: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const c = await t.row<ClaimRow>("SELECT * FROM pm_payment_claims WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!c) throw fail.notFound("Reported payment not found");
        if (c.status !== "pending") throw fail.conflict(`This reported payment is already ${c.status}`);
        const r = await t.row<ClaimRow>(
          "UPDATE pm_payment_claims SET status = 'rejected', reason = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *",
          [id, reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Reported payment rejected",
          target: id,
          detail: reason,
        });
        return toClaim(r as ClaimRow);
      });
    },

    // ---------------------------------------------------------------- deposits
    async requestRefund(
      s: OrgScope,
      leaseId: string,
      b: { applyToArrears: boolean; deductions: { amountMinor: number; reason: string }[]; refundReference: string },
    ) {
      const id = await financeTransaction(db, s.orgId, async (t) => {
        const l = await R.leaseRow(t, s.orgId, leaseId, true);
        if (l.status !== "ended")
          throw fail.conflict("Settle the deposit once the lease has ended (move-out recorded)");
        const held = (await R.depositsHeld(t, s.orgId, [leaseId])).get(leaseId) ?? 0;
        if (held <= 0) throw fail.conflict("No deposit is held for this lease");
        const open = b.applyToArrears
          ? await openInvoicesForUpdate(t, s.orgId, l.tenant_id, DEPOSIT_TARGETS, [leaseId])
          : [];
        const arrears = Math.min(
          held,
          sum(open, (i) => R.balanceOf(i)),
        );
        const deductions = sum(b.deductions, (x) => x.amountMinor);
        if (arrears + deductions > held)
          throw fail.invalid(
            `Deductions (${formatMoney(deductions, s.entitlement.org.currency)}) and arrears (${formatMoney(arrears, s.entitlement.org.currency)}) exceed the deposit held (${formatMoney(held, s.entitlement.org.currency)})`,
          );
        const refund = held - arrears - deductions;
        if (refund > 0 && !b.refundReference)
          throw fail.invalid("Give the bank reference the refund will be paid with (it is matched on the statement)");
        const id = newId("pdr");
        const number = await nextNumber(t, numberScope(s.orgId), "DR", 5);
        await t.run(
          `INSERT INTO pm_deposit_refunds (id, org_id, number, lease_id, tenant_id, held_minor, arrears_minor, deductions_minor,
             deductions, refund_minor, refund_reference, status, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'requested', $12)`,
          [
            id,
            s.orgId,
            number,
            leaseId,
            l.tenant_id,
            held,
            arrears,
            deductions,
            JSON.stringify(b.deductions),
            refund,
            b.refundReference,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Deposit settlement requested",
          target: number,
          detail: `${l.number} · held ${held} · arrears ${arrears} · deductions ${deductions} · refund ${refund}`,
        });
        return id;
      });
      return toRefund(await refundRow(db, s.orgId, id));
    },

    async listRefunds(s: OrgScope, status?: "requested" | "approved" | "rejected", leaseId?: string) {
      const rows = await db.rows<RefundRow>(
        `SELECT * FROM pm_deposit_refunds WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR lease_id = $3) ORDER BY requested_at DESC`,
        [s.orgId, status ?? null, leaseId ?? null],
      );
      return { refunds: rows.map(toRefund) };
    },

    async approveRefund(s: OrgScope, id: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await refundRow(t, s.orgId, id, true);
        if (r.status !== "requested") throw fail.conflict(`This settlement is already ${r.status}`);
        if (r.requested_by === s.userId)
          throw fail.separationOfDuties("You requested this deposit settlement — someone else must approve it");
        const l = await R.leaseRow(t, s.orgId, r.lease_id, true);
        const held = (await R.depositsHeld(t, s.orgId, [l.id])).get(l.id) ?? 0;
        if (held !== r.held_minor)
          throw fail.conflict(
            `The deposit held changed (${formatMoney(r.held_minor, s.entitlement.org.currency)} → ${formatMoney(held, s.entitlement.org.currency)}) — reject this and request again`,
          );
        const open = r.arrears_minor
          ? await openInvoicesForUpdate(t, s.orgId, l.tenant_id, DEPOSIT_TARGETS, [l.id])
          : [];
        if (sum(open, (i) => R.balanceOf(i)) < r.arrears_minor)
          throw fail.conflict("The tenant's unpaid balance changed — reject this and request again");
        const ag = await R.agreementForUnit(t, s.orgId, l.unit_id);
        if (r.deductions_minor > 0 && !ag)
          throw fail.conflict("No owner's agreement covers the unit: deductions cannot be credited to an owner");
        const journalId = await post(t, core, {
          orgId: s.orgId,
          date: s.today,
          kind: "deposit_refund",
          memo: `${r.number} · deposit settled for ${l.number} · ${l.tenant_name} (refund recorded, paid by bank transfer outside PALTAS)`,
          ref: `deposit-refund:${r.id}`,
          link: { propertyId: l.property_id, ownerId: ag?.owner_id ?? null, tenantId: l.tenant_id, leaseId: l.id },
          lines: [
            dr(ACC.depositsHeld, r.held_minor, "Deposit released"),
            cr(ACC.receivables, r.arrears_minor, "Applied to unpaid invoices"),
            cr(ACC.ownerFunds, r.deductions_minor, "Deductions kept for the owner"),
            cr(ACC.clientBank, r.refund_minor, `Refund ${r.refund_reference}`),
          ],
        });
        for (const [inv, amount] of oldestFirst(open, r.arrears_minor))
          await allocate(t, core, {
            invoice: inv,
            amount,
            date: s.today,
            by: s.userId,
            source: "deposit",
            depositRefundId: r.id,
          });
        await t.run(
          "UPDATE pm_deposit_refunds SET status = 'approved', decided_by = $2, decided_at = now(), journal_id = $3 WHERE id = $1",
          [r.id, s.userId, journalId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Deposit settlement approved",
          target: r.number,
          detail: `refund ${r.refund_minor} · arrears ${r.arrears_minor} · deductions ${r.deductions_minor}`,
        });
      });
      return toRefund(await refundRow(db, s.orgId, id));
    },

    async rejectRefund(s: OrgScope, id: string, reason: string) {
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await refundRow(t, s.orgId, id, true);
        if (r.status !== "requested") throw fail.conflict(`This settlement is already ${r.status}`);
        if (r.requested_by === s.userId)
          throw fail.separationOfDuties("You requested this deposit settlement — someone else decides it");
        await t.run(
          "UPDATE pm_deposit_refunds SET status = 'rejected', decided_by = $2, decided_at = now(), reject_reason = $3 WHERE id = $1",
          [id, s.userId, reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Deposit settlement rejected",
          target: r.number,
          detail: reason,
        });
      });
      return toRefund(await refundRow(db, s.orgId, id));
    },
  };
}

export type PaymentsService = ReturnType<typeof paymentsService>;
