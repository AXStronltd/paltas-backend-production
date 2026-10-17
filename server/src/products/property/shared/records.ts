/*
 * SQL rows of the Property Management records and how the API shows them. Balances are always computed from the
 * records themselves (an invoice's balance = its amount less what was allocated to it); the reports then prove the
 * totals equal the ledger.
 */
import type { property as P } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { daysBetween, sum, toPct } from "./util.js";

// ------------------------------------------------------------------ rows
export interface PropertyRow {
  id: string;
  org_id: string;
  name: string;
  address: string;
  kind: "residential" | "commercial" | "mixed";
  late_fee_enabled: boolean;
  late_fee_bp: number;
  late_fee_grace_days: number;
  late_fee_min_minor: number;
  late_fee_payee: "owner" | "agency";
  auto_billing: boolean;
  auto_billing_day: number;
  auto_late_fees: boolean;
  created_at: string;
}

export interface UnitRow {
  id: string;
  org_id: string;
  property_id: string;
  building_id: string | null;
  unit_no: string;
  floor: string | null;
  unit_type: string | null;
  bedrooms: number | null;
  toilets: number | null;
  area_sqm: number | null;
  market_rent_minor: number | null;
  status: "available" | "off_market";
}

export interface AgreementRow {
  id: string;
  org_id: string;
  number: string;
  property_id: string;
  unit_id: string | null;
  owner_id: string;
  owner_name: string;
  fee_bp: number;
  authority_minor: number;
  payout_day: number;
  start_date: string;
  end_date: string | null;
  status: "active" | "ended";
}

export interface LeaseRow {
  id: string;
  org_id: string;
  number: string;
  property_id: string;
  unit_id: string;
  unit_no: string;
  tenant_id: string;
  tenant_name: string;
  status: P.Lease["status"];
  start_date: string;
  end_date: string | null;
  rent_minor: number;
  deposit_minor: number;
  deposit_mode: "collect" | "held" | "none";
  due_day: number;
  escalation_bp: number;
  escalation_months: number | null;
  notice_days: number;
  notice_given_on: string | null;
  move_out_date: string | null;
  ended_reason: string | null;
  signed_on: string | null;
  application_id: string | null;
  migrated: boolean;
}

export interface InvoiceRow {
  id: string;
  org_id: string;
  number: string;
  kind: P.Invoice["kind"];
  lease_id: string | null;
  tenant_id: string;
  tenant_name: string;
  unit_id: string | null;
  unit_no: string | null;
  property_id: string | null;
  owner_id: string | null;
  agreement_id: string | null;
  period: string | null;
  issue_date: string;
  due_date: string;
  amount_minor: number;
  paid_minor: number;
  credited_minor: number;
  note: string;
  source_invoice_id: string | null;
  journal_id: string | null;
  mig_job_id: string | null;
}

export interface LineRow {
  invoice_id: string;
  line_no: number;
  code: string;
  description: string;
  quantity: number;
  rate_minor: number;
  amount_minor: number;
  payee: "owner" | "agency" | "deposit";
  fee_applies: boolean;
  vat_applies: boolean;
}

export interface AllocationRow {
  id: string;
  invoice_id: string;
  invoice_number: string;
  amount_minor: number;
  source: P.Allocation["source"];
  payment_id: string | null;
  deposit_refund_id: string | null;
  credit_note_id: string | null;
  date: string;
}

export interface PaymentRow {
  id: string;
  org_id: string;
  number: string;
  receipt_number: string;
  tenant_id: string;
  tenant_name: string;
  date: string;
  amount_minor: number;
  method: P.PaymentMethod;
  reference: string;
  note: string;
  bank_line_id: string | null;
  journal_id: string | null;
  recorded_by: string;
  reversal: P.Payment["reversal"];
}

// ------------------------------------------------------------------ mappers
export const toLateFee = (r: PropertyRow): P.LateFeePolicy => ({
  enabled: r.late_fee_enabled,
  pct: toPct(r.late_fee_bp),
  graceDays: r.late_fee_grace_days,
  minMinor: r.late_fee_min_minor,
  payee: r.late_fee_payee,
});

export const toAgreement = (r: AgreementRow): P.Agreement => ({
  id: r.id,
  number: r.number,
  propertyId: r.property_id,
  unitId: r.unit_id,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  feePct: toPct(r.fee_bp),
  authorityMinor: r.authority_minor,
  payoutDay: r.payout_day,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
});

const allocationOut = (a: AllocationRow): P.Allocation => ({
  invoiceId: a.invoice_id,
  invoiceNumber: a.invoice_number,
  amountMinor: a.amount_minor,
  source: a.source,
  sourceId: a.payment_id ?? a.deposit_refund_id ?? a.credit_note_id ?? a.id,
  date: a.date,
});

// ------------------------------------------------------------------ loaders
const AGREEMENT_SQL = `SELECT a.*, c.name AS owner_name FROM pm_agreements a JOIN contacts c ON c.id = a.owner_id`;

export const agreements = (db: Db, orgId: string, where = "TRUE", params: unknown[] = []) =>
  db.rows<AgreementRow>(`${AGREEMENT_SQL} WHERE a.org_id = $1 AND ${where} ORDER BY a.start_date, a.number`, [
    orgId,
    ...params,
  ]);

/** The active agreement covering a unit: the unit's own, else the property's. */
export async function agreementForUnit(db: Db, orgId: string, unitId: string): Promise<AgreementRow | null> {
  return db.row<AgreementRow>(
    `${AGREEMENT_SQL} JOIN pm_units u ON u.id = $2 AND u.property_id = a.property_id
     WHERE a.org_id = $1 AND a.status = 'active' AND (a.unit_id = u.id OR a.unit_id IS NULL)
     ORDER BY (a.unit_id IS NULL), a.start_date DESC LIMIT 1`,
    [orgId, unitId],
  );
}

export async function propertyRow(db: Db, orgId: string, id: string, lock = false): Promise<PropertyRow> {
  const r = await db.row<PropertyRow>(
    `SELECT * FROM pm_properties WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [orgId, id],
  );
  if (!r) throw fail.notFound("Property not found");
  return r;
}

export async function unitRow(db: Db, orgId: string, id: string): Promise<UnitRow> {
  const r = await db.row<UnitRow>("SELECT * FROM pm_units WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!r) throw fail.notFound("Unit not found");
  return r;
}

const LEASE_SQL = `SELECT l.*, u.unit_no, c.name AS tenant_name FROM pm_leases l
  JOIN pm_units u ON u.id = l.unit_id JOIN contacts c ON c.id = l.tenant_id`;

export async function leaseRow(db: Db, orgId: string, id: string, lock = false): Promise<LeaseRow> {
  if (lock) await db.run("SELECT 1 FROM pm_leases WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
  const r = await db.row<LeaseRow>(`${LEASE_SQL} WHERE l.org_id = $1 AND l.id = $2`, [orgId, id]);
  if (!r) throw fail.notFound("Lease not found");
  return r;
}

export const leaseRows = (db: Db, orgId: string, where = "TRUE", params: unknown[] = []) =>
  db.rows<LeaseRow>(`${LEASE_SQL} WHERE l.org_id = $1 AND ${where} ORDER BY l.start_date, l.number`, [
    orgId,
    ...params,
  ]);

/** The rent in force on a date: the latest step on or before it, else the lease's starting rent. */
export async function rentOn(db: Db, lease: { id: string; rent_minor: number }, date: string): Promise<number> {
  const r = await db.row<{ rent_minor: number }>(
    "SELECT rent_minor FROM pm_rent_steps WHERE lease_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1",
    [lease.id, date],
  );
  return r?.rent_minor ?? lease.rent_minor;
}

/** Deposit held for each lease: collected on its deposit invoice, plus migrated opening deposits, less settlements. */
export async function depositsHeld(db: Db, orgId: string, leaseIds: string[]): Promise<Map<string, number>> {
  if (!leaseIds.length) return new Map();
  const rows = await db.rows<{ id: string; held: number }>(
    `SELECT l.id,
       COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a JOIN pm_invoices i ON i.id = a.invoice_id
                 WHERE i.lease_id = l.id AND i.kind = 'deposit' AND a.source <> 'credit_note'), 0)
     + CASE WHEN l.migrated AND l.id = (SELECT x.id FROM pm_leases x WHERE x.tenant_id = l.tenant_id AND x.migrated
                                        ORDER BY x.start_date, x.id LIMIT 1)
            THEN COALESCE((SELECT sum(o.amount_minor) FROM pm_opening_deposits o WHERE o.tenant_id = l.tenant_id), 0)
            ELSE 0 END
     - COALESCE((SELECT sum(r.held_minor) FROM pm_deposit_refunds r WHERE r.lease_id = l.id AND r.status = 'approved'), 0)
       AS held
     FROM pm_leases l WHERE l.org_id = $1 AND l.id = ANY($2)`,
    [orgId, leaseIds],
  );
  return new Map(rows.map((r) => [r.id, r.held]));
}

export async function leaseViews(db: Db, orgId: string, rows: LeaseRow[], today: string): Promise<P.Lease[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const steps = await db.rows<{ lease_id: string; effective_from: string; rent_minor: number; reason: string }>(
    "SELECT * FROM pm_rent_steps WHERE lease_id = ANY($1) ORDER BY effective_from",
    [ids],
  );
  const charges = await db.rows<{
    lease_id: string;
    charge_type_id: string;
    code: string;
    name: string;
    amount_minor: number | null;
  }>(
    `SELECT lc.lease_id, lc.charge_type_id, ct.code, ct.name, lc.amount_minor FROM pm_lease_charges lc
     JOIN pm_charge_types ct ON ct.id = lc.charge_type_id WHERE lc.lease_id = ANY($1) ORDER BY ct.code`,
    [ids],
  );
  const held = await depositsHeld(db, orgId, ids);
  return rows.map((l) => {
    const own = steps.filter((s) => s.lease_id === l.id);
    const current = [...own].reverse().find((s) => s.effective_from <= today);
    return {
      id: l.id,
      number: l.number,
      propertyId: l.property_id,
      unitId: l.unit_id,
      unitNo: l.unit_no,
      tenantId: l.tenant_id,
      tenantName: l.tenant_name,
      status: l.status,
      startDate: l.start_date,
      endDate: l.end_date,
      rentMinor: l.rent_minor,
      currentRentMinor: current?.rent_minor ?? l.rent_minor,
      depositMinor: l.deposit_minor,
      depositMode: l.deposit_mode,
      depositHeldMinor: Math.max(0, held.get(l.id) ?? 0),
      dueDay: l.due_day,
      escalationPct: toPct(l.escalation_bp),
      escalationMonths: l.escalation_months,
      noticeDays: l.notice_days,
      noticeGivenOn: l.notice_given_on,
      moveOutDate: l.move_out_date,
      endedReason: l.ended_reason,
      signedOn: l.signed_on,
      migrated: l.migrated,
      rentSteps: own.map((s) => ({
        effectiveFrom: s.effective_from,
        rentMinor: s.rent_minor,
        reason: s.reason as P.Lease["rentSteps"][number]["reason"],
      })),
      charges: charges
        .filter((c) => c.lease_id === l.id)
        .map((c) => ({ chargeTypeId: c.charge_type_id, code: c.code, name: c.name, amountMinor: c.amount_minor })),
    };
  });
}

const INVOICE_SQL = `SELECT i.*, c.name AS tenant_name, u.unit_no,
    COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.invoice_id = i.id AND a.source <> 'credit_note'), 0)::bigint AS paid_minor,
    COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.invoice_id = i.id AND a.source = 'credit_note'), 0)::bigint AS credited_minor
  FROM pm_invoices i JOIN contacts c ON c.id = i.tenant_id LEFT JOIN pm_units u ON u.id = i.unit_id`;

export const invoiceRows = (db: Db, orgId: string, where = "TRUE", params: unknown[] = []) =>
  db.rows<InvoiceRow>(`${INVOICE_SQL} WHERE i.org_id = $1 AND ${where} ORDER BY i.due_date, i.number`, [
    orgId,
    ...params,
  ]);

export async function invoiceRow(db: Db, orgId: string, id: string): Promise<InvoiceRow> {
  const [r] = await invoiceRows(db, orgId, "i.id = $2", [id]);
  if (!r) throw fail.notFound("Invoice not found");
  return r;
}

export const balanceOf = (i: { amount_minor: number; paid_minor: number; credited_minor: number }) =>
  i.amount_minor - i.paid_minor - i.credited_minor;

export async function invoiceViews(db: Db, rows: InvoiceRow[], today: string): Promise<P.Invoice[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = await db.rows<LineRow>(
    "SELECT * FROM pm_invoice_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, line_no",
    [ids],
  );
  const allocs = await db.rows<AllocationRow>(
    `SELECT a.*, i.number AS invoice_number FROM pm_effective_allocations a JOIN pm_invoices i ON i.id = a.invoice_id
     WHERE a.invoice_id = ANY($1) ORDER BY a.date, a.created_at, a.id`,
    [ids],
  );
  return rows.map((i) => {
    const balance = balanceOf(i);
    return {
      id: i.id,
      number: i.number,
      kind: i.kind,
      leaseId: i.lease_id,
      tenantId: i.tenant_id,
      tenantName: i.tenant_name,
      unitId: i.unit_id,
      unitNo: i.unit_no,
      propertyId: i.property_id,
      ownerId: i.owner_id,
      period: i.period,
      issueDate: i.issue_date,
      dueDate: i.due_date,
      amountMinor: i.amount_minor,
      paidMinor: i.paid_minor,
      creditedMinor: i.credited_minor,
      balanceMinor: balance,
      status: balance <= 0 ? "paid" : i.paid_minor + i.credited_minor > 0 ? "part_paid" : "open",
      overdueDays: balance > 0 ? Math.max(0, daysBetween(i.due_date, today)) : 0,
      note: i.note,
      sourceInvoiceId: i.source_invoice_id,
      migrated: !!i.mig_job_id,
      lines: lines
        .filter((l) => l.invoice_id === i.id)
        .map((l) => ({
          lineNo: l.line_no,
          code: l.code,
          description: l.description,
          quantity: Number(l.quantity),
          rateMinor: l.rate_minor,
          amountMinor: l.amount_minor,
          payee: l.payee,
        })),
      allocations: allocs.filter((a) => a.invoice_id === i.id).map(allocationOut),
      journalId: i.journal_id,
    };
  });
}

export const PAYMENT_SQL = `SELECT p.*, c.name AS tenant_name, (SELECT json_build_object('reason',r.reason,'requestedBy',r.requested_by,'approvedBy',r.approved_by,'rejectedReason',r.rejected_reason,'date',r.date::text) FROM pm_payment_reversals r WHERE r.payment_id=p.id) AS reversal FROM pm_payments p JOIN contacts c ON c.id = p.tenant_id`;

export const paymentRows = (db: Db, orgId: string, where = "TRUE", params: unknown[] = []) =>
  db.rows<PaymentRow>(`${PAYMENT_SQL} WHERE p.org_id = $1 AND ${where} ORDER BY p.date, p.number`, [orgId, ...params]);

export async function paymentViews(db: Db, rows: PaymentRow[]): Promise<P.Payment[]> {
  if (!rows.length) return [];
  const allocs = await db.rows<AllocationRow>(
    `SELECT a.*, i.number AS invoice_number FROM pm_allocations a JOIN pm_invoices i ON i.id = a.invoice_id
     WHERE a.payment_id = ANY($1) ORDER BY a.created_at, a.id`,
    [rows.map((r) => r.id)],
  );
  const byPayment = new Map<string, AllocationRow[]>();
  for (const a of allocs) {
    const id = a.payment_id;
    if (!id) continue;
    const list = byPayment.get(id) || [];
    list.push(a);
    byPayment.set(id, list);
  }
  return rows.map((p) => {
    const own = byPayment.get(p.id) || [];
    const allocated = sum(own, (a) => a.amount_minor);
    return {
      id: p.id,
      number: p.number,
      receiptNumber: p.receipt_number,
      tenantId: p.tenant_id,
      tenantName: p.tenant_name,
      date: p.date,
      amountMinor: p.amount_minor,
      method: p.method,
      reference: p.reference,
      note: p.note,
      allocatedMinor: allocated,
      unallocatedMinor: p.reversal?.approvedBy ? 0 : p.amount_minor - allocated,
      reversal: p.reversal ?? null,
      allocations: own.map(allocationOut),
      bankMatched: !!p.bank_line_id,
      recordedBy: p.recorded_by,
      journalId: p.journal_id,
    };
  });
}

/** A tenant's unapplied credit: payments not allocated, less credit already applied. */
export async function tenantCredit(db: Db, orgId: string, tenantId: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT (COALESCE((SELECT sum(amount_minor) FROM pm_effective_payments WHERE org_id = $1 AND tenant_id = $2), 0)
           - COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a JOIN pm_invoices i ON i.id = a.invoice_id
                       WHERE a.org_id = $1 AND i.tenant_id = $2 AND a.source IN ('payment', 'credit')), 0))::bigint AS n`,
    [orgId, tenantId],
  );
  return r?.n ?? 0;
}
