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
          throw fail.invalid(`${inv.number} has only ${R.balanceOf(inv)} outstanding`);
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
      const id = await db.tx((t) => recordIn(t, s, b));
      return paymentView(s.orgId, id);
    },

    async list(s: OrgScope, f: { tenantId?: string | undefined }) {
      const rows = await R.paymentRows(db, s.orgId, "($2::text IS NULL OR p.tenant_id = $2)", [f.tenantId ?? null]);
      return { payments: await R.paymentViews(db, rows) };
    },

    async applyCredit(s: OrgScope, tenantId: string) {
      const ids = await db.tx(async (t) => {
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
      return db.tx(async (t) => {
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
      const id = await db.tx(async (t) => {
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
          throw fail.invalid(`Deductions (${deductions}) and arrears (${arrears}) exceed the deposit held (${held})`);
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
      await db.tx(async (t) => {
        const r = await refundRow(t, s.orgId, id, true);
        if (r.status !== "requested") throw fail.conflict(`This settlement is already ${r.status}`);
        if (r.requested_by === s.userId)
          throw fail.separationOfDuties("You requested this deposit settlement — someone else must approve it");
        const l = await R.leaseRow(t, s.orgId, r.lease_id, true);
        const held = (await R.depositsHeld(t, s.orgId, [l.id])).get(l.id) ?? 0;
        if (held !== r.held_minor)
          throw fail.conflict(`The deposit held changed (${r.held_minor} → ${held}) — reject this and request again`);
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
      await db.tx(async (t) => {
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
