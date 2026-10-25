import { chargeLineAmount } from "../shared/charge-pricing.js";
import { invoiceDraftsService } from "./invoice-drafts.service.js";
import { quoteTariff, type TariffRow } from "../setup/finance-config.service.js";
import { calculateMeteredAmount } from "../../../core/billing/pricing.js";
import { createHash } from "node:crypto";
import { financeTransaction } from "../shared/finance-transaction.js";
/*
 * Invoicing: the monthly billing run (rent, or recurring and metered charges), one-off charge invoices, late fees per
 * each property's policy, and credit notes. Every invoice posts to the ledger as it is issued; runs are idempotent.
 */
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, BILLED_ACCOUNT } from "../accounts.js";
import type { PmDeps } from "../deps.js";
import { chargeTypeRow } from "../setup/setup.service.js";
import { allocate, issueInvoice, numberScope, type NewInvoiceLine } from "../shared/money.js";
import { cr, dr, post } from "../shared/posting.js";
import * as R from "../shared/records.js";
import {
  addDays,
  addMonths,
  applyBp,
  daysBetween,
  dueDateIn,
  lastDay,
  splitProportionally,
  sum,
} from "../shared/util.js";
import { formatMoney } from "../../../lib/money.js";

/** Who runs billing: a member (their scope) or the PALTAS scheduler (no user). */
export type BillingOp = Pick<OrgScope, "orgId" | "actor" | "today"> & { userId: string | null };

/** Rent for a month: the rent in force at the start of the lease's month, prorated by day in the first month. */
export async function rentLine(t: Db, l: R.LeaseRow, period: string): Promise<{ line: NewInvoiceLine; note: string }> {
  const first = `${period}-01`;
  const last = lastDay(period);
  const from = l.start_date > first ? l.start_date : first;
  const rent = await R.rentOn(t, l, from);
  let amount = rent;
  let note = "";
  if (l.start_date > first) {
    const days = daysBetween(l.start_date, last) + 1;
    const dim = daysBetween(first, last) + 1;
    amount = Math.round((rent * days) / dim);
    note = `Prorated ${days} of ${dim} days`;
  }
  return {
    line: {
      code: "RENT",
      description: `Rent ${period}${note ? ` (${note})` : ""}`,
      quantity: 1,
      rateMinor: amount,
      amountMinor: amount,
      payee: "owner",
      feeApplies: true,
      vatApplies: false,
    },
    note,
  };
}

export function billingService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  const view = async (orgId: string, id: string, today: string): Promise<P.Invoice> => {
    const [v] = await R.invoiceViews(db, [await R.invoiceRow(db, orgId, id)], today);
    return v as P.Invoice;
  };

  async function emailPreview(s: OrgScope, id: string, t: Db = db): Promise<P.InvoiceEmailPreview> {
    const [i] = await R.invoiceViews(t, [await R.invoiceRow(t, s.orgId, id)], s.today);
    if (!i) throw fail.notFound("Invoice");
    const tenant = await t.row<{ email: string | null; consent_email: boolean }>(
      "SELECT email,consent_email FROM contacts WHERE org_id=$1 AND id=$2",
      [s.orgId, i.tenantId],
    );
    const recipient = (tenant?.email ?? "").trim().toLowerCase();
    const org = s.entitlement.org;
    const money = (n: number) => formatMoney(n, org.currency);
    const subject = `${org.name} — invoice ${i.number}`;
    const body = [
      `Hello ${i.tenantName},`,
      "",
      `Invoice ${i.number} from ${org.name}`,
      `Unit: ${i.unitNo || "—"}`,
      `Period: ${i.period || "—"}`,
      `Issued: ${i.issueDate}`,
      `Due: ${i.dueDate}`,
      "",
      ...i.lines.map((l) => `${l.description}: ${money(l.amountMinor)}`),
      "",
      `Total: ${money(i.amountMinor)}`,
      `Paid: ${money(i.paidMinor)}`,
      `Credited: ${money(i.creditedMinor)}`,
      `Outstanding: ${money(i.balanceMinor)}`,
      "",
      "Contact your property manager for payment instructions or questions. This email does not collect money.",
      "If you already have tenant portal access, your invoices and receipts are available there.",
      "",
      "Sent through PALTAS on behalf of your property manager.",
    ].join("\n");
    const previewKey = createHash("sha256")
      .update(JSON.stringify([s.orgId, id, recipient, subject, body]))
      .digest("hex");
    const last = await t.row<{ status: string; status_note: string }>(
      "SELECT status,status_note FROM notifications WHERE org_id=$1 AND source='property_invoice' AND source_ref=$2",
      [s.orgId, `${id}:${previewKey}`],
    );
    const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient);
    const unavailableReason = !valid
      ? "Add a valid email address to this tenant's profile first."
      : !tenant?.consent_email
        ? "Email contact permission is not recorded. Confirm the tenant agrees, then update their contact preferences."
        : !core.notifications.emailDeliveryConfigured()
          ? "PALTAS transactional email delivery is not configured. The invoice remains available in the tenant portal."
          : "";
    return {
      tenantId: i.tenantId,
      recipient,
      subject,
      body,
      previewKey,
      canSend: !unavailableReason,
      unavailableReason,
      lastMessage: last ? { status: last.status, note: last.status_note } : null,
    };
  }

  async function issueChargeIn(
    t: Db,
    s: OrgScope,
    b: {
      leaseId: string;
      dueDate?: string | undefined;
      note: string;
      lines: { chargeTypeId: string; description: string; quantity: number; rateMinor: number }[];
    },
  ) {
    const lease = await R.leaseRow(t, s.orgId, b.leaseId);
    if (lease.status !== "active" && lease.status !== "ended")
      throw fail.conflict("Charges are billed on an active or ended lease");
    const lines: NewInvoiceLine[] = [];
    for (const l of b.lines) {
      const ct = await chargeTypeRow(t, s.orgId, l.chargeTypeId);
      if (!ct.active) throw fail.invalid(`${ct.name} is no longer used`);
      const amountMinor = chargeLineAmount(l.quantity, l.rateMinor);
      if (amountMinor <= 0)
        throw fail.invalid(`${ct.name}: the calculated amount must be at least one minor currency unit`);
      lines.push({
        code: ct.code,
        description: l.description || ct.name,
        quantity: l.quantity,
        rateMinor: l.rateMinor,
        amountMinor,
        payee: ct.payee,
        feeApplies: ct.fee_applies,
        vatApplies: ct.vat_applies,
      });
    }
    if (!Number.isSafeInteger(sum(lines, (x) => x.amountMinor)))
      throw fail.invalid("The invoice total exceeds the supported range");
    const dueDate = b.dueDate ?? addDays(s.today, 7);
    if (dueDate < s.today) throw fail.invalid("The due date is in the past");
    const id = await issueInvoice(t, core, {
      orgId: s.orgId,
      kind: "charge",
      lease,
      period: s.today.slice(0, 7),
      issueDate: s.today,
      dueDate,
      note: b.note,
      createdBy: s.userId,
      lines,
    });
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Charge invoice issued",
      target: id ?? "",
      detail: `${lease.number} · ${sum(lines, (l) => l.amountMinor)}`,
    });
    return id as string;
  }

  return {
    view,
    emailPreview,
    drafts: invoiceDraftsService(d, issueChargeIn),
    async emailInvoice(s: OrgScope, id: string, previewKey: string) {
      return financeTransaction(db, s.orgId, async (t) => {
        const p = await emailPreview(s, id, t);
        if (p.previewKey !== previewKey)
          throw fail.conflict("The invoice or tenant email changed. Preview it again before sending.");
        if (!p.canSend) throw fail.conflict(p.unavailableReason);
        const m = await core.notifications.record(t, {
          orgId: s.orgId,
          channel: "email",
          to: p.recipient,
          category: "transactional",
          subject: p.subject,
          body: p.body,
          source: "property_invoice",
          sourceRef: `${id}:${p.previewKey}`,
          createdBy: s.userId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Tenant invoice email confirmed",
          target: id,
          detail: `${m.id} · ${m.status}`,
        });
        return m;
      });
    },

    async runBilling(
      s: BillingOp,
      b: { propertyId: string; period: string; kind: "rent" | "charges"; allowEstimatedReadings?: boolean },
    ) {
      await R.propertyRow(db, s.orgId, b.propertyId);
      if (b.period > addMonths(s.today, 1).slice(0, 7)) throw fail.invalid("Bill at most one month ahead of today");
      const first = `${b.period}-01`;
      const last = lastDay(b.period);
      const leases = await R.leaseRows(
        db,
        s.orgId,
        "l.property_id = $2 AND l.status = 'active' AND l.start_date <= $3 AND (l.end_date IS NULL OR l.end_date >= $4)",
        [b.propertyId, last, first],
      );
      const skipped: { leaseId: string; reason: string }[] = [];
      // charges: a metered charge on a let unit needs its reading first (nobody is billed without a reading)
      if (b.kind === "charges") {
        const missing = await db.rows<{ unit_no: string; code: string }>(
          `SELECT u.unit_no, ct.code FROM pm_leases l JOIN pm_lease_charges lc ON lc.lease_id = l.id
           JOIN pm_charge_types ct ON ct.id = lc.charge_type_id AND ct.metered JOIN pm_units u ON u.id = l.unit_id
           WHERE l.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM pm_meter_readings m
             WHERE m.unit_id = l.unit_id AND m.charge_type_id = ct.id AND m.period = $2)
           ORDER BY u.unit_no, ct.code`,
          [leases.map((l) => l.id), b.period],
        );
        if (missing.length)
          throw fail.conflict(
            `${missing.length} meter reading(s) missing for ${b.period} (e.g. ${missing
              .slice(0, 3)
              .map((m) => `${m.unit_no} ${m.code}`)
              .join(", ")}) — record them first`,
            { missing },
          );
      }
      const runId = newId("prn");
      const created = await financeTransaction(db, s.orgId, async (t) => {
        const ids: string[] = [];
        await t.run(
          "INSERT INTO pm_billing_runs (id, org_id, property_id, period, kind, created, skipped, run_by) VALUES ($1, $2, $3, $4, $5, 0, 0, $6)",
          [runId, s.orgId, b.propertyId, b.period, b.kind, s.userId],
        );
        for (const l of leases) {
          const issueDate = l.start_date > first ? l.start_date : first;
          const dueDate = l.start_date > first ? l.start_date : dueDateIn(b.period, l.due_day);
          let lines: NewInvoiceLine[] = [];
          let note = "";
          if (b.kind === "rent") {
            const r = await rentLine(t, l, b.period);
            lines = [r.line];
            note = r.note;
          } else {
            const charges = await t.rows<{
              amount_minor: number | null;
              code: string;
              name: string;
              id: string;
              payee: "owner" | "agency";
              fee_applies: boolean;
              vat_applies: boolean;
              metered: boolean;
              rate_minor: number;
              unit_name: string;
            }>(
              `SELECT lc.amount_minor, ct.* FROM pm_lease_charges lc JOIN pm_charge_types ct ON ct.id = lc.charge_type_id
               WHERE lc.lease_id = $1 ORDER BY ct.code`,
              [l.id],
            );
            for (const c of charges) {
              if (c.metered) {
                const m = await t.row<{
                  id: string;
                  version: number;
                  reading_kind: string;
                  reason: string;
                  meter_id: string | null;
                  meter_serial: string | null;
                  previous: number;
                  current: number;
                }>(
                  "SELECT r.*,m.serial AS meter_serial FROM pm_meter_readings r LEFT JOIN pm_utility_meters m ON m.org_id=r.org_id AND m.id=r.meter_id WHERE r.unit_id = $1 AND r.charge_type_id = $2 AND r.period = $3",
                  [l.unit_id, c.id, b.period],
                );
                if (!m)
                  throw fail.conflict(`Missing ${c.name} meter reading for ${b.period} — record it before billing`);
                if (m.reading_kind === "estimated" && !b.allowEstimatedReadings)
                  throw fail.conflict(
                    `${c.name} for ${b.period} uses an estimated reading. Review its evidence and explicitly allow estimates before billing.`,
                  );
                const registry = await t.row<{ id: string }>(
                  "SELECT id FROM pm_utility_meters WHERE org_id=$1 AND unit_id=$2 AND charge_type_id=$3 AND from_period<=$4 AND (through_period IS NULL OR through_period>=$4)",
                  [s.orgId, l.unit_id, c.id, b.period],
                );
                if (
                  !registry &&
                  (await t.row(
                    "SELECT id FROM pm_utility_meters WHERE org_id=$1 AND unit_id=$2 AND charge_type_id=$3 AND from_period<=$4 LIMIT 1",
                    [s.orgId, l.unit_id, c.id, b.period],
                  ))
                )
                  throw fail.conflict(
                    `${c.name}: no physical meter covers this period; register its replacement and review the reading before billing`,
                  );
                if (registry && registry.id !== m.meter_id)
                  throw fail.conflict(
                    `${c.name}: reopen this unbilled reading and confirm its registered physical meter before billing`,
                  );
                const { consumption: used } = calculateMeteredAmount(String(m.previous), String(m.current), 0);
                const tariff = await t.row<TariffRow>(
                  `SELECT * FROM pm_utility_tariffs WHERE org_id=$1 AND charge_type_id=$2
                  AND (unit_id IS NULL OR unit_id=$3) AND effective_period <= $4
                  ORDER BY (unit_id IS NOT NULL) DESC,effective_period DESC LIMIT 1`,
                  [s.orgId, c.id, l.unit_id, b.period],
                );
                const org = tariff
                  ? await t.row<{ currency: string }>("SELECT currency FROM organisations WHERE id=$1", [s.orgId])
                  : null;
                let priced: ReturnType<typeof quoteTariff> | null = null;
                if (tariff) {
                  if (!org) throw fail.notFound("Organisation not found");
                  try {
                    priced = quoteTariff(tariff, String(m.previous), String(m.current), used, org.currency);
                  } catch (e) {
                    throw fail.invalid(
                      `${c.name} for ${b.period}: ${e instanceof Error ? e.message : "Invalid tariff"}`,
                    );
                  }
                }
                const billedAmount =
                  priced?.amountMinor ??
                  calculateMeteredAmount(String(m.previous), String(m.current), c.rate_minor).amountMinor;
                if (billedAmount > 0)
                  lines.push({
                    code: c.code,
                    description: `${c.name}: ${Number(m.previous)} → ${Number(m.current)} ${c.unit_name}${m.reading_kind === "estimated" ? " · ESTIMATED (reviewed)" : ""}${m.meter_serial ? ` · meter ${m.meter_serial}` : ""}${priced ? ` · tiered tariff ${priced.snapshot.effectivePeriod}; variable ${formatMoney(priced.snapshot.variableMinor, priced.snapshot.currency)}, fixed ${formatMoney(priced.snapshot.fixedMinor, priced.snapshot.currency)}` : ""}`,
                    quantity: used,
                    rateMinor: tariff ? 0 : c.rate_minor,
                    amountMinor: billedAmount,
                    pricingSnapshot: {
                      ...(priced?.snapshot ?? {}),
                      readingId: m.id,
                      readingVersion: m.version,
                      readingKind: m.reading_kind,
                      readingReason: m.reason,
                      meterId: m.meter_id,
                      meterSerial: m.meter_serial ?? priced?.snapshot.meterSerial ?? null,
                      tariffMeterSerial: priced?.snapshot.meterSerial ?? null,
                      previous: String(m.previous),
                      current: String(m.current),
                      consumption: used,
                      estimatedApproved: m.reading_kind === "estimated" && b.allowEstimatedReadings === true,
                    },
                    payee: c.payee,
                    feeApplies: c.fee_applies,
                    vatApplies: c.vat_applies,
                  });
              } else if (c.amount_minor) {
                lines.push({
                  code: c.code,
                  description: `${c.name} ${b.period}`,
                  quantity: 1,
                  rateMinor: c.amount_minor,
                  amountMinor: c.amount_minor,
                  payee: c.payee,
                  feeApplies: c.fee_applies,
                  vatApplies: c.vat_applies,
                });
              }
            }
            if (!lines.length) {
              skipped.push({ leaseId: l.id, reason: "No charges on this lease for the month" });
              continue;
            }
          }
          const id = await issueInvoice(t, core, {
            orgId: s.orgId,
            kind: b.kind === "rent" ? "rent" : "charge",
            lease: l,
            period: b.period,
            issueDate,
            dueDate,
            note,
            recurring: b.kind === "charges",
            runId,
            createdBy: s.userId,
            lines,
          });
          if (id) ids.push(id);
          else skipped.push({ leaseId: l.id, reason: `Already billed for ${b.period}` });
        }
        await t.run("UPDATE pm_billing_runs SET created = $2, skipped = $3 WHERE id = $1", [
          runId,
          ids.length,
          skipped.length,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.kind === "rent" ? "Monthly rent run" : "Monthly charges run",
          target: b.propertyId,
          detail: `${b.period} · ${ids.length} invoice(s) · ${skipped.length} skipped`,
        });
        return ids;
      });
      const rows = created.length ? await R.invoiceRows(db, s.orgId, "i.id = ANY($2)", [created]) : [];
      return {
        runId,
        propertyId: b.propertyId,
        period: b.period,
        kind: b.kind,
        created: await R.invoiceViews(db, rows, s.today),
        skipped,
      };
    },

    async list(
      s: OrgScope,
      f: {
        tenantId?: string | undefined;
        leaseId?: string | undefined;
        propertyId?: string | undefined;
        period?: string | undefined;
        open?: "true" | "false" | undefined;
      },
    ) {
      const rows = await R.invoiceRows(
        db,
        s.orgId,
        `($2::text IS NULL OR i.tenant_id = $2) AND ($3::text IS NULL OR i.lease_id = $3)
         AND ($4::text IS NULL OR i.property_id = $4) AND ($5::text IS NULL OR i.period = $5)`,
        [f.tenantId ?? null, f.leaseId ?? null, f.propertyId ?? null, f.period ?? null],
      );
      const filtered = f.open === undefined ? rows : rows.filter((r) => R.balanceOf(r) > 0 === (f.open === "true"));
      return { invoices: await R.invoiceViews(db, filtered, s.today) };
    },

    async chargeInvoice(
      s: OrgScope,
      b: {
        leaseId: string;
        dueDate?: string | undefined;
        note: string;
        lines: { chargeTypeId: string; description: string; quantity: number; rateMinor: number }[];
      },
    ) {
      const id = await financeTransaction(db, s.orgId, (t) => issueChargeIn(t, s, b));
      return view(s.orgId, id, s.today);
    },

    /** Late fees on rent overdue beyond each property's grace days; at most one per overdue invoice. */
    async runLateFees(s: BillingOp, b: { propertyId?: string | undefined }) {
      const candidates = await R.invoiceRows(
        db,
        s.orgId,
        `i.kind = 'rent' AND ($2::text IS NULL OR i.property_id = $2)
         AND NOT EXISTS (SELECT 1 FROM pm_invoices f WHERE f.source_invoice_id = i.id AND f.kind = 'late_fee')`,
        [b.propertyId ?? null],
      );
      let skipped = 0;
      const ids = await financeTransaction(db, s.orgId, async (t) => {
        const out: string[] = [];
        for (const i of candidates) {
          const balance = R.balanceOf(i);
          const p = await R.propertyRow(t, s.orgId, i.property_id as string);
          if (balance <= 0 || !p.late_fee_enabled || daysBetween(i.due_date, s.today) <= p.late_fee_grace_days) {
            skipped++;
            continue;
          }
          const amount = Math.max(p.late_fee_min_minor, applyBp(balance, p.late_fee_bp));
          if (amount <= 0) {
            skipped++;
            continue;
          }
          const lease = await R.leaseRow(t, s.orgId, i.lease_id as string);
          const id = await issueInvoice(t, core, {
            orgId: s.orgId,
            kind: "late_fee",
            lease,
            period: s.today.slice(0, 7),
            issueDate: s.today,
            dueDate: s.today,
            note: `Late fee on ${i.number}`,
            sourceInvoiceId: i.id,
            createdBy: s.userId,
            lines: [
              {
                code: "LATE",
                description: `Late fee: ${p.late_fee_bp / 100}% of ${balance} overdue on ${i.number} (due ${i.due_date})`,
                quantity: 1,
                rateMinor: amount,
                amountMinor: amount,
                payee: p.late_fee_payee,
                feeApplies: false,
                vatApplies: false,
              },
            ],
          });
          if (id) out.push(id);
          else skipped++;
        }
        if (out.length)
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Late fees charged",
            detail: `${out.length} late fee invoice(s)`,
          });
        return out;
      });
      const rows = ids.length ? await R.invoiceRows(db, s.orgId, "i.id = ANY($2)", [ids]) : [];
      return { created: await R.invoiceViews(db, rows, s.today), skipped };
    },

    /** Reduce an invoice's unpaid part: Dr the billed accounts (in proportion) / Cr 1120. */
    async creditNote(s: OrgScope, invoiceId: string, b: { amountMinor: number; reason: string }) {
      await financeTransaction(db, s.orgId, async (t) => {
        await t.run("SELECT 1 FROM pm_invoices WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, invoiceId]);
        const inv = await R.invoiceRow(t, s.orgId, invoiceId);
        if (b.amountMinor > R.balanceOf(inv))
          throw fail.conflict(
            `Only ${formatMoney(R.balanceOf(inv), s.entitlement.org.currency)} of ${inv.number} is unpaid — a credit note cannot exceed it`,
          );
        const id = newId("pcn");
        const number = await nextNumber(t, numberScope(s.orgId), "CN", 5);
        await t.run(
          "INSERT INTO pm_credit_notes (id, org_id, number, invoice_id, amount_minor, reason, date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [id, s.orgId, number, invoiceId, b.amountMinor, b.reason, s.today, s.userId],
        );
        let debits: [string, number][];
        if (inv.kind === "opening") debits = [[ACC.openingEquity, b.amountMinor]];
        else {
          const lines = await t.rows<R.LineRow>(
            "SELECT * FROM pm_invoice_lines WHERE invoice_id = $1 ORDER BY line_no",
            [invoiceId],
          );
          const shares = splitProportionally(
            b.amountMinor,
            lines.map((l) => l.amount_minor),
          );
          debits = lines.map((l, i) => [BILLED_ACCOUNT[l.payee], shares[i] ?? 0]);
        }
        const journalId = await post(t, core, {
          orgId: s.orgId,
          date: s.today,
          kind: "credit_note",
          memo: `${number} on ${inv.number} · ${b.reason}`,
          ref: `credit-note:${id}`,
          link: { propertyId: inv.property_id, ownerId: inv.owner_id, tenantId: inv.tenant_id, leaseId: inv.lease_id },
          lines: [...debits.map(([a, v]) => dr(a, v, b.reason)), cr(ACC.receivables, b.amountMinor, number)],
        });
        await t.run("UPDATE pm_credit_notes SET journal_id = $2 WHERE id = $1", [id, journalId]);
        await allocate(t, core, {
          invoice: inv,
          amount: b.amountMinor,
          date: s.today,
          by: s.userId,
          source: "credit_note",
          creditNoteId: id,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Credit note issued",
          target: number,
          detail: `${inv.number} · ${b.amountMinor} · ${b.reason}`,
        });
      });
      return view(s.orgId, invoiceId, s.today);
    },
  };
}

export type BillingService = ReturnType<typeof billingService>;
