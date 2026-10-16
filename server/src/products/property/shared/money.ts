/*
 * The two money movements every PM workflow is built from, each posting to the ONE ledger:
 *
 *   issueInvoice  an invoice and its lines; Dr 1120 tenant receivables, Cr 2150 / 2170 / 2160 by payee.
 *                 Idempotent: rent once per lease and month, recurring charges once per lease and month, one deposit
 *                 invoice per lease, one late fee per overdue invoice (unique indexes; the lease is locked first).
 *   allocate      money applied to an invoice (from a payment, the tenant's credit or the deposit) and its collection
 *                 posting, split over the invoice's lines in proportion: the owner's share Dr 2150 / Cr 2250 less the
 *                 management fee (Dr 2250 / Cr 4650, + VAT Dr 2250 / Cr 2100 when registered); the agency's share
 *                 Dr 2170 / Cr 4660 (+ VAT); deposits Dr 2160 / Cr 2300. An opening invoice brought over by a
 *                 migration was already income in the previous system: collecting it posts nothing more.
 */
import type { property as P } from "@paltas/contracts";
import type { CoreServices } from "../../../core/core-services.js";
import type { NewLine } from "../../../core/ledger/ledger.repo.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, BILLED_ACCOUNT } from "../accounts.js";
import { settingsOf } from "../setup/setup.service.js";
import { cr, dr, post } from "./posting.js";
import * as R from "./records.js";
import { applyBp, splitProportionally, sum, toBp } from "./util.js";
import { formatMoney } from "../../../lib/money.js";

export interface NewInvoiceLine {
  code: string;
  description: string;
  quantity: number;
  rateMinor: number;
  amountMinor: number;
  payee: "owner" | "agency" | "deposit";
  feeApplies: boolean;
  vatApplies: boolean;
}

export interface NewInvoice {
  orgId: string;
  kind: "rent" | "deposit" | "charge" | "late_fee";
  lease: R.LeaseRow;
  period: string | null;
  issueDate: string;
  dueDate: string;
  note: string;
  recurring?: boolean;
  sourceInvoiceId?: string | null;
  runId?: string | null;
  createdBy: string | null;
  lines: NewInvoiceLine[];
}

export const numberScope = (orgId: string) => `pm:${orgId}`;

/** Issue an invoice, or return null when that lease was already billed for it (rent / charges / deposit / late fee). */
export async function issueInvoice(t: Db, core: CoreServices, inv: NewInvoice): Promise<string | null> {
  const lines = inv.lines.filter((l) => l.amountMinor > 0);
  if (!lines.length) throw fail.invalid("An invoice needs at least one line above zero");
  // one at a time per lease: the existence check and the insert cannot interleave (no gaps in invoice numbers)
  await t.run("SELECT pg_advisory_xact_lock(hashtext('pm-lease:' || $1))", [inv.lease.id]);
  const exists = await t.row<{ id: string }>(
    `SELECT id FROM pm_invoices WHERE lease_id = $1 AND (
       (kind = 'rent' AND $2 = 'rent' AND period = $3) OR
       (kind = 'charge' AND $2 = 'charge' AND recurring AND $4 AND period = $3) OR
       (kind = 'deposit' AND $2 = 'deposit') OR
       (kind = 'late_fee' AND $2 = 'late_fee' AND source_invoice_id = $5))`,
    [inv.lease.id, inv.kind, inv.period, !!inv.recurring, inv.sourceInvoiceId ?? null],
  );
  if (exists) return null;
  const ag = await R.agreementForUnit(t, inv.orgId, inv.lease.unit_id);
  if (!ag)
    throw fail.conflict(
      `No active management agreement covers unit ${inv.lease.unit_no} — record the owner's agreement first`,
    );
  const id = newId("pin");
  const number = await nextNumber(t, numberScope(inv.orgId), inv.kind === "deposit" ? "DEP" : "INV", 6);
  const amount = sum(lines, (l) => l.amountMinor);
  await t.run(
    `INSERT INTO pm_invoices (id, org_id, number, kind, lease_id, tenant_id, unit_id, property_id, owner_id, agreement_id,
       period, issue_date, due_date, amount_minor, note, recurring, source_invoice_id, run_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id,
      inv.orgId,
      number,
      inv.kind,
      inv.lease.id,
      inv.lease.tenant_id,
      inv.lease.unit_id,
      inv.lease.property_id,
      ag.owner_id,
      ag.id,
      inv.period,
      inv.issueDate,
      inv.dueDate,
      amount,
      inv.note,
      !!inv.recurring,
      inv.sourceInvoiceId ?? null,
      inv.runId ?? null,
      inv.createdBy,
    ],
  );
  let n = 0;
  for (const l of lines)
    await t.run(
      `INSERT INTO pm_invoice_lines (invoice_id, line_no, org_id, code, description, quantity, rate_minor, amount_minor,
         payee, fee_applies, vat_applies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        ++n,
        inv.orgId,
        l.code,
        l.description,
        l.quantity,
        l.rateMinor,
        l.amountMinor,
        l.payee,
        l.feeApplies,
        l.vatApplies,
      ],
    );
  const byAccount = new Map<string, number>();
  for (const l of lines)
    byAccount.set(BILLED_ACCOUNT[l.payee], (byAccount.get(BILLED_ACCOUNT[l.payee]) ?? 0) + l.amountMinor);
  const journalId = await post(t, core, {
    orgId: inv.orgId,
    date: inv.issueDate,
    kind: "invoice",
    memo: `${number} · ${inv.kind === "late_fee" ? "late fee" : inv.kind} · ${inv.lease.tenant_name} · ${inv.lease.unit_no}${inv.period ? ` · ${inv.period}` : ""}`,
    ref: `invoice:${id}`,
    link: {
      propertyId: inv.lease.property_id,
      ownerId: ag.owner_id,
      tenantId: inv.lease.tenant_id,
      leaseId: inv.lease.id,
    },
    lines: [dr(ACC.receivables, amount, "Tenant receivable"), ...[...byAccount].map(([a, v]) => cr(a, v))],
  });
  await t.run("UPDATE pm_invoices SET journal_id = $2 WHERE id = $1", [id, journalId]);
  return id;
}

export interface AllocationSource {
  source: P.Allocation["source"];
  paymentId?: string | null;
  depositRefundId?: string | null;
  creditNoteId?: string | null;
}

/** Is VAT charged on a date (the organisation is VAT-registered from vat_from)? Returns the rate in basis points. */
async function vatOn(t: Db, orgId: string, date: string): Promise<number> {
  const st = await settingsOf(t, orgId);
  return st.vatPct > 0 && st.vatFrom && st.vatFrom <= date ? toBp(st.vatPct) : 0;
}

/** The lines of a collection posting: what `amount` of this invoice, now collected, means for owner and agency. */
async function collectionLines(t: Db, invoice: R.InvoiceRow, amount: number, date: string): Promise<NewLine[]> {
  const lines = await t.rows<R.LineRow>("SELECT * FROM pm_invoice_lines WHERE invoice_id = $1 ORDER BY line_no", [
    invoice.id,
  ]);
  const ag = invoice.agreement_id
    ? await t.row<{ fee_bp: number }>("SELECT fee_bp FROM pm_agreements WHERE id = $1", [invoice.agreement_id])
    : null;
  const vat = await vatOn(t, invoice.org_id, date);
  const shares = splitProportionally(
    amount,
    lines.map((l) => l.amount_minor),
  );
  const out: NewLine[] = [];
  lines.forEach((l, i) => {
    const share = shares[i] ?? 0;
    if (share <= 0) return;
    if (l.payee === "deposit") {
      out.push(dr(ACC.depositBilled, share, l.description), cr(ACC.depositsHeld, share, "Deposit held"));
    } else if (l.payee === "agency") {
      const net = l.vat_applies && vat ? Math.round((share * 10_000) / (10_000 + vat)) : share;
      out.push(dr(ACC.agencyBilled, share, l.description), cr(ACC.agencyIncome, net, l.description));
      if (share - net > 0) out.push(cr(ACC.vat, share - net, `VAT on ${l.description}`));
    } else {
      out.push(dr(ACC.ownerBilled, share, l.description), cr(ACC.ownerFunds, share, `Collected: ${l.description}`));
      if (l.fee_applies && ag && ag.fee_bp > 0) {
        const fee = applyBp(share, ag.fee_bp);
        if (fee > 0) {
          out.push(dr(ACC.ownerFunds, fee, "Management fee"), cr(ACC.managementFees, fee, "Management fee"));
          const tax = applyBp(fee, vat);
          if (tax > 0)
            out.push(dr(ACC.ownerFunds, tax, "VAT on management fee"), cr(ACC.vat, tax, "VAT on management fee"));
        }
      }
    }
  });
  return out;
}

/**
 * Apply money to an invoice: the allocation record and its collection posting (none for an opening invoice). The
 * caller has locked the invoice (and checked it belongs to the payer); the database refuses over-allocation too.
 */
export async function allocate(
  t: Db,
  core: CoreServices,
  a: { invoice: R.InvoiceRow; amount: number; date: string; by: string | null } & AllocationSource,
): Promise<string> {
  if (a.amount <= 0) throw fail.invalid("An allocation must be above zero");
  if (a.amount > R.balanceOf(a.invoice))
    throw fail.conflict(
      `${a.invoice.number} has only ${formatMoney(R.balanceOf(a.invoice), await orgCurrency(t, a.invoice.org_id))} outstanding`,
    );
  const id = newId("pal");
  await t.run(
    `INSERT INTO pm_allocations (id, org_id, invoice_id, amount_minor, source, payment_id, deposit_refund_id, credit_note_id,
       date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      a.invoice.org_id,
      a.invoice.id,
      a.amount,
      a.source,
      a.paymentId ?? null,
      a.depositRefundId ?? null,
      a.creditNoteId ?? null,
      a.date,
      a.by,
    ],
  );
  if (a.invoice.kind !== "opening" && a.source !== "credit_note") {
    const journalId = await post(t, core, {
      orgId: a.invoice.org_id,
      date: a.date,
      kind: "collection",
      memo: `Collected on ${a.invoice.number} · ${a.invoice.tenant_name}`,
      ref: `collection:${id}`,
      link: {
        propertyId: a.invoice.property_id,
        ownerId: a.invoice.owner_id,
        tenantId: a.invoice.tenant_id,
        leaseId: a.invoice.lease_id,
      },
      lines: await collectionLines(t, a.invoice, a.amount, a.date),
    });
    await t.run("UPDATE pm_allocations SET journal_id = $2 WHERE id = $1", [id, journalId]);
  }
  // keep the in-memory row current for a caller allocating several times in one transaction
  if (a.source === "credit_note") a.invoice.credited_minor += a.amount;
  else a.invoice.paid_minor += a.amount;
  return id;
}

/** Lock a tenant's open invoices (oldest due first) and return them with current balances. */
export async function openInvoicesForUpdate(
  t: Db,
  orgId: string,
  tenantId: string,
  where = "TRUE",
  params: unknown[] = [],
): Promise<R.InvoiceRow[]> {
  await t.run(
    `SELECT 1 FROM pm_invoices i WHERE i.org_id = $1 AND i.tenant_id = $2 AND ${where} ORDER BY id FOR UPDATE`,
    [orgId, tenantId, ...params],
  );
  const rows = await R.invoiceRows(t, orgId, `i.tenant_id = $2 AND ${where}`, [tenantId, ...params]);
  return rows.filter((i) => R.balanceOf(i) > 0);
}

/** Spread an amount over invoices oldest first; returns [invoice, amount] pairs. */
export function oldestFirst(invoices: R.InvoiceRow[], amount: number): [R.InvoiceRow, number][] {
  const out: [R.InvoiceRow, number][] = [];
  let left = amount;
  for (const i of [...invoices].sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || a.number.localeCompare(b.number),
  )) {
    if (left <= 0) break;
    const take = Math.min(left, R.balanceOf(i));
    if (take > 0) out.push([i, take]);
    left -= take;
  }
  return out;
}

/** The organisation's currency, for messages that quote money. */
export async function orgCurrency(t: Db, orgId: string): Promise<string> {
  return (
    (await t.row<{ currency: string }>("SELECT currency FROM organisations WHERE id = $1", [orgId]))?.currency ?? "KES"
  );
}
