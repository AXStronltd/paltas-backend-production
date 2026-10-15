/*
 * Client billing. Every invoice, receipt and withholding certificate posts to the organisation's ONE ledger in the
 * same transaction (1100 receivables, 48xx revenue, 2100 VAT, 1000 bank, 1810 / 1820 tax credits), linked to its
 * client and site. Payments are RECORDED (a bank, mobile-money or cheque reference), never processed.
 *
 * Contract billing runs once per contract and month (sec_invoices.run_key is unique): the monthly fee, pro-rated by
 * the days the contract covers, plus extra cover from approved timesheets at the contract's hourly rate (each shift
 * billed once). Electronic tax-invoice submission needs a tax-authority connection (test adapter).
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import { ACC, REVENUE_ACCOUNT } from "../accounts.js";
import type { SecurityDeps } from "../deps.js";
import { loadSettings, toClient, type ContractRow } from "../setup/setup.service.js";
import { cr, dr, postToLedger } from "../shared/posting.js";
import { daysBetween, findClient, findSite, must, orgTimezone, shareOf, type ClientRow } from "../shared/util.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type LineKind = security.Invoice["lines"][number]["kind"];
type ReceiptOut = z.infer<typeof security.Receipt>;

interface InvoiceRow {
  id: string;
  number: string;
  client_id: string;
  site_id: string | null;
  contract_id: string | null;
  period: string | null;
  date: string;
  due_date: string;
  net_minor: number;
  vat_minor: number;
  total_minor: number;
  wht_expected_minor: number;
  vat_wht_expected_minor: number;
  journal_id: string;
  paid: number;
  certified: number;
}

const INVOICE_SELECT = `SELECT i.*,
  COALESCE((SELECT sum(a.amount_minor) FROM sec_receipt_allocations a WHERE a.invoice_id = i.id), 0)::bigint AS paid,
  COALESCE((SELECT sum(c.amount_minor) FROM sec_tax_certificates c WHERE c.invoice_id = i.id), 0)::bigint AS certified
  FROM sec_invoices i`;

interface NewLine {
  kind: LineKind;
  description: string;
  quantity: number;
  unit: string;
  amount: number;
}

const lastDayOf = (period: string) => {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** What is still owed on an invoice and its state on a date. */
function balanceOf(i: InvoiceRow, today: string) {
  const balance = i.total_minor - i.paid - i.certified;
  const state: security.Invoice["state"] =
    balance <= 0 ? "paid" : i.due_date < today ? "overdue" : i.paid + i.certified > 0 ? "part_paid" : "open";
  return { balance, state };
}

export function billingService(d: SecurityDeps) {
  const { core } = d;
  const { db } = core;
  const { taxAuthority, messaging } = d.adapters;

  async function invoiceRow(t: Db, orgId: string, id: string, lock = false): Promise<InvoiceRow> {
    if (lock) await t.run("SELECT 1 FROM sec_invoices WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    const i = await t.row<InvoiceRow>(`${INVOICE_SELECT} WHERE i.org_id = $1 AND i.id = $2`, [orgId, id]);
    if (!i) throw fail.notFound("Invoice not found");
    return i;
  }

  async function invoiceOut(t: Db, i: InvoiceRow, today: string): Promise<security.Invoice> {
    const lines = await t.rows<{
      kind: LineKind;
      description: string;
      quantity: number;
      unit: string;
      amount_minor: number;
    }>("SELECT * FROM sec_invoice_lines WHERE invoice_id = $1 ORDER BY seq", [i.id]);
    const { balance, state } = balanceOf(i, today);
    return {
      id: i.id,
      number: i.number,
      clientId: i.client_id,
      siteId: i.site_id,
      contractId: i.contract_id,
      period: i.period,
      date: i.date,
      dueDate: i.due_date,
      lines: lines.map((l) => ({
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        amountMinor: l.amount_minor,
      })),
      netMinor: i.net_minor,
      vatMinor: i.vat_minor,
      totalMinor: i.total_minor,
      whtExpectedMinor: i.wht_expected_minor,
      vatWhtExpectedMinor: i.vat_wht_expected_minor,
      paidMinor: i.paid,
      certifiedMinor: i.certified,
      balanceMinor: balance,
      state,
      journalId: i.journal_id,
      taxAuthority: taxAuthority.submitInvoice(i.number),
    };
  }

  /** Create an invoice and post it: Dr 1100 receivables; Cr revenue per line kind; Cr 2100 VAT. */
  async function issue(
    t: Db,
    s: OrgScope,
    c: ClientRow,
    o: {
      siteId: string | null;
      contractId?: string | null;
      period?: string | null;
      runKey?: string | null;
      vatBp: number;
      lines: NewLine[];
    },
  ): Promise<string> {
    const net = o.lines.reduce((n, l) => n + l.amount, 0);
    if (net <= 0) throw fail.invalid("An invoice needs at least one line with an amount");
    const vat = shareOf(net, o.vatBp);
    const id = newId("sinv");
    const number = await nextNumber(t, s.orgId, "SINV");
    const byAccount = new Map<string, number>();
    for (const l of o.lines)
      byAccount.set(REVENUE_ACCOUNT[l.kind], (byAccount.get(REVENUE_ACCOUNT[l.kind]) ?? 0) + l.amount);
    const journalId = await postToLedger(t, core, {
      orgId: s.orgId,
      date: s.today,
      kind: "invoice",
      memo: `Invoice ${number} · ${c.name}`,
      ref: number,
      siteId: o.siteId,
      clientId: c.id,
      lines: [dr(ACC.receivables, net + vat), ...[...byAccount].map(([a, v]) => cr(a, v)), cr(ACC.vat, vat)],
    });
    await t.run(
      `INSERT INTO sec_invoices (id, org_id, number, client_id, site_id, contract_id, period, date, due_date, net_minor,
         vat_minor, total_minor, wht_expected_minor, vat_wht_expected_minor, run_key, journal_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        s.orgId,
        number,
        c.id,
        o.siteId,
        o.contractId ?? null,
        o.period ?? null,
        s.today,
        addDays(s.today, c.payment_terms_days),
        net,
        vat,
        net + vat,
        shareOf(net, c.wht_bp),
        vat > 0 ? shareOf(net, c.vat_wht_bp) : 0,
        o.runKey ?? null,
        journalId,
        s.userId,
      ],
    );
    for (const [i, l] of o.lines.entries())
      await t.run(
        `INSERT INTO sec_invoice_lines (id, org_id, invoice_id, seq, kind, description, quantity, unit, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId("sil"), s.orgId, id, i + 1, l.kind, l.description, l.quantity, l.unit, l.amount],
      );
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Security invoice issued",
      target: number,
      detail: `${c.name} · ${net + vat}`,
    });
    return id;
  }

  /** Record a receipt and its allocations: Dr 1000 bank / Cr 1100 receivables. */
  async function receive(
    t: Db,
    s: OrgScope,
    c: ClientRow,
    o: {
      date: string;
      method: ReceiptOut["method"];
      reference: string;
      allocations: { invoiceId: string; amountMinor: number }[];
    },
  ): Promise<string> {
    const merged = new Map<string, number>();
    for (const a of o.allocations) merged.set(a.invoiceId, (merged.get(a.invoiceId) ?? 0) + a.amountMinor);
    for (const [invoiceId, amount] of [...merged].sort()) {
      const inv = await invoiceRow(t, s.orgId, invoiceId, true);
      if (inv.client_id !== c.id) throw fail.invalid(`Invoice ${inv.number} belongs to another client`);
      const { balance } = balanceOf(inv, s.today);
      if (amount > balance) throw fail.conflict(`Invoice ${inv.number} has only ${balance} left to pay`);
    }
    const total = [...merged.values()].reduce((n, v) => n + v, 0);
    const id = newId("src");
    const number = await nextNumber(t, s.orgId, "SRC");
    const journalId = await postToLedger(t, core, {
      orgId: s.orgId,
      date: o.date,
      kind: "receipt",
      memo: `Payment received · ${c.name} · ${o.method.replace("_", " ")} ${o.reference}`,
      ref: number,
      clientId: c.id,
      lines: [dr(ACC.bank, total), cr(ACC.receivables, total)],
    });
    try {
      await t.run(
        `INSERT INTO sec_receipts (id, org_id, number, client_id, date, amount_minor, method, reference, journal_id, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, s.orgId, number, c.id, o.date, total, o.method, o.reference, journalId, s.userId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw fail.conflict(`A payment with reference ${o.reference} is already recorded for this client`);
      throw e;
    }
    for (const [invoiceId, amount] of merged)
      await t.run(
        "INSERT INTO sec_receipt_allocations (receipt_id, invoice_id, org_id, amount_minor) VALUES ($1,$2,$3,$4)",
        [id, invoiceId, s.orgId, amount],
      );
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Client payment recorded",
      target: number,
      detail: `${c.name} · ${total} · ${o.reference}`,
    });
    return id;
  }

  async function receiptOut(t: Db, orgId: string, id: string): Promise<ReceiptOut> {
    const r = await t.row<{
      id: string;
      number: string;
      client_id: string;
      date: string;
      amount_minor: number;
      method: ReceiptOut["method"];
      reference: string;
      journal_id: string;
    }>("SELECT * FROM sec_receipts WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!r) throw fail.notFound("Receipt not found");
    const allocations = await t.rows<{ invoice_id: string; amount_minor: number }>(
      "SELECT invoice_id, amount_minor FROM sec_receipt_allocations WHERE receipt_id = $1 ORDER BY invoice_id",
      [id],
    );
    return {
      id: r.id,
      number: r.number,
      clientId: r.client_id,
      date: r.date,
      amountMinor: r.amount_minor,
      method: r.method,
      reference: r.reference,
      allocations: allocations.map((a) => ({ invoiceId: a.invoice_id, amountMinor: a.amount_minor })),
      journalId: r.journal_id,
    };
  }

  /** The single open invoice whose remaining cash (after any withholding still to be certified) equals the amount. */
  async function suggestion(t: Db, orgId: string, amount: number, today: string): Promise<string | null> {
    const open = await t.rows<InvoiceRow & { has_wht: boolean; has_vat: boolean }>(
      `${INVOICE_SELECT.replace(
        "FROM sec_invoices i",
        `, EXISTS (SELECT 1 FROM sec_tax_certificates c WHERE c.invoice_id = i.id AND c.kind = 'income_tax') AS has_wht,
         EXISTS (SELECT 1 FROM sec_tax_certificates c WHERE c.invoice_id = i.id AND c.kind = 'vat') AS has_vat FROM sec_invoices i`,
      )}
       WHERE i.org_id = $1`,
      [orgId],
    );
    const hits = open.filter((i) => {
      const { balance } = balanceOf(i, today);
      if (balance <= 0) return false;
      const withheld = (i.has_wht ? 0 : i.wht_expected_minor) + (i.has_vat ? 0 : i.vat_wht_expected_minor);
      return balance === amount || balance - withheld === amount;
    });
    return hits.length === 1 ? (hits[0]?.id ?? null) : null;
  }

  async function bankLineOut(t: Db, orgId: string, id: string) {
    const l = await t.row<{
      id: string;
      date: string;
      description: string;
      reference: string;
      amount_minor: number;
      status: "unmatched" | "suggested" | "matched" | "ignored";
      suggested_invoice_id: string | null;
      receipt_id: string | null;
    }>("SELECT * FROM sec_bank_lines WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!l) throw fail.notFound("Statement line not found");
    return {
      id: l.id,
      date: l.date,
      description: l.description,
      reference: l.reference,
      amountMinor: l.amount_minor,
      status: l.status,
      suggestedInvoiceId: l.suggested_invoice_id,
      receiptId: l.receipt_id,
    };
  }

  return {
    async runBilling(s: OrgScope, period: string) {
      const from = `${period}-01`;
      const to = lastDayOf(period);
      return db.tx(async (t) => {
        const tz = await orgTimezone(t, s.orgId);
        const contracts = await t.rows<ContractRow>(
          `SELECT * FROM sec_contracts WHERE org_id = $1 AND start_date <= $3 AND (end_date IS NULL OR end_date >= $2)
           ORDER BY number FOR UPDATE`,
          [s.orgId, from, to],
        );
        const ids: string[] = [];
        const skipped: string[] = [];
        const monthDays = daysBetween(from, to) + 1;
        for (const k of contracts) {
          const c = await findClient(t, s.orgId, k.client_id);
          const site = await findSite(t, s.orgId, k.site_id);
          const runKey = `contract:${k.id}:${period}`;
          const billed = await t.row<{ id: string }>("SELECT id FROM sec_invoices WHERE org_id = $1 AND run_key = $2", [
            s.orgId,
            runKey,
          ]);
          const lines: NewLine[] = [];
          if (!billed) {
            const start = k.start_date > from ? k.start_date : from;
            const end = k.end_date && k.end_date < to ? k.end_date : to;
            const days = daysBetween(start, end) + 1;
            const fee =
              days === monthDays
                ? k.monthly_fee_minor
                : Math.floor((k.monthly_fee_minor * days + monthDays / 2) / monthDays);
            lines.push({
              kind: "contract",
              description: `Guarding services, ${site.name}, ${period}${days === monthDays ? "" : ` (${days} of ${monthDays} days)`}`,
              quantity: 1,
              unit: "month",
              amount: fee,
            });
          }
          const extras =
            k.extra_hour_rate_minor > 0
              ? await t.rows<{ id: string; minutes: number }>(
                  `SELECT id, (normal_minutes + overtime_minutes) AS minutes FROM sec_shifts
                   WHERE org_id = $1 AND site_id = $2 AND extra AND timesheet_status = 'approved'
                     AND billed_invoice_id IS NULL AND (starts_at AT TIME ZONE $3)::date BETWEEN $4 AND $5
                   ORDER BY starts_at FOR UPDATE`,
                  [s.orgId, k.site_id, tz, from, to],
                )
              : [];
          const minutes = extras.reduce((n, x) => n + x.minutes, 0);
          if (minutes > 0)
            lines.push({
              kind: "extra_hours",
              description: `Extra cover from approved timesheets, ${site.name}, ${period} (${extras.length} shift(s))`,
              quantity: minutes,
              unit: "minutes",
              amount: Math.round((minutes * k.extra_hour_rate_minor) / 60),
            });
          if (!lines.length) {
            skipped.push(k.number);
            continue;
          }
          const id = await issue(t, s, c, {
            siteId: k.site_id,
            contractId: k.id,
            period,
            runKey: billed ? null : runKey,
            vatBp: k.vat_bp,
            lines,
          });
          if (extras.length)
            await t.run("UPDATE sec_shifts SET billed_invoice_id = $2 WHERE id = ANY($1)", [
              extras.map((x) => x.id),
              id,
            ]);
          ids.push(id);
        }
        const invoices = [];
        for (const id of ids) invoices.push(await invoiceOut(t, await invoiceRow(t, s.orgId, id), s.today));
        return { invoices, skipped };
      });
    },

    async createInvoice(s: OrgScope, b: Body<typeof security.createInvoice>) {
      return db.tx(async (t) => {
        const c = await findClient(t, s.orgId, b.clientId);
        if (b.siteId) {
          const site = await findSite(t, s.orgId, b.siteId);
          if (site.client_id !== c.id) throw fail.invalid("This site does not belong to this client");
        }
        const id = await issue(t, s, c, {
          siteId: b.siteId ?? null,
          vatBp: Math.round(b.vatPct * 100),
          lines: b.lines.map((l) => ({
            kind: "other",
            description: l.description,
            quantity: l.quantity,
            unit: "each",
            amount: l.quantity * l.unitMinor,
          })),
        });
        return invoiceOut(t, await invoiceRow(t, s.orgId, id), s.today);
      });
    },

    async listInvoices(s: OrgScope, clientId?: string, open?: "true" | "false") {
      const rows = await db.rows<InvoiceRow>(
        `${INVOICE_SELECT} WHERE i.org_id = $1 AND ($2::text IS NULL OR i.client_id = $2) ORDER BY i.date DESC, i.number DESC`,
        [s.orgId, clientId ?? null],
      );
      const invoices = [];
      for (const r of rows) {
        const out = await invoiceOut(db, r, s.today);
        if (open === undefined || out.balanceMinor > 0 === (open === "true")) invoices.push(out);
      }
      return { invoices };
    },

    async recordReceipt(s: OrgScope, b: Body<typeof security.recordReceipt>) {
      return db.tx(async (t) => {
        const c = await findClient(t, s.orgId, b.clientId);
        return receiptOut(t, s.orgId, await receive(t, s, c, b));
      });
    },

    async listReceipts(s: OrgScope, clientId?: string) {
      const rows = await db.rows<{ id: string }>(
        `SELECT id FROM sec_receipts WHERE org_id = $1 AND ($2::text IS NULL OR client_id = $2) ORDER BY date DESC, number DESC`,
        [s.orgId, clientId ?? null],
      );
      const receipts = [];
      for (const r of rows) receipts.push(await receiptOut(db, s.orgId, r.id));
      return { receipts };
    },

    async recordCertificate(s: OrgScope, invoiceId: string, b: Body<typeof security.recordCertificate>) {
      return db.tx(async (t) => {
        const inv = await invoiceRow(t, s.orgId, invoiceId, true);
        const c = await findClient(t, s.orgId, inv.client_id);
        const amount = b.kind === "income_tax" ? inv.wht_expected_minor : inv.vat_wht_expected_minor;
        if (amount <= 0)
          throw fail.invalid(`${c.name} does not withhold ${b.kind === "vat" ? "VAT" : "income tax"} on this invoice`);
        const { balance } = balanceOf(inv, s.today);
        if (amount > balance) throw fail.conflict(`Invoice ${inv.number} has only ${balance} left to settle`);
        const exists = await t.row("SELECT 1 FROM sec_tax_certificates WHERE invoice_id = $1 AND kind = $2", [
          invoiceId,
          b.kind,
        ]);
        if (exists) throw fail.conflict("This certificate is already recorded for this invoice");
        const number = await nextNumber(t, s.orgId, "SWC");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          date: b.date,
          kind: "certificate",
          memo: `${b.kind === "vat" ? "VAT withholding" : "Withholding tax"} certificate ${b.certificateRef} · ${inv.number}`,
          ref: number,
          siteId: inv.site_id,
          clientId: c.id,
          lines: [dr(b.kind === "vat" ? ACC.vatWithheld : ACC.whtCredits, amount), cr(ACC.receivables, amount)],
        });
        await t.run(
          `INSERT INTO sec_tax_certificates (id, org_id, number, client_id, invoice_id, kind, certificate_ref, date,
             amount_minor, journal_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            newId("swc"),
            s.orgId,
            number,
            c.id,
            invoiceId,
            b.kind,
            b.certificateRef,
            b.date,
            amount,
            journalId,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Tax certificate recorded",
          target: inv.number,
          detail: b.certificateRef,
        });
        return invoiceOut(t, await invoiceRow(t, s.orgId, invoiceId), s.today);
      });
    },

    async billLateFee(s: OrgScope, clientId: string, vatPct: number) {
      return db.tx(async (t) => {
        const c = await findClient(t, s.orgId, clientId);
        const settings = await loadSettings(t, s.orgId);
        if (settings.late_fee_bp === null)
          throw fail.conflict("No late-payment charge is configured in the security settings");
        const rows = await t.rows<InvoiceRow>(
          `${INVOICE_SELECT} WHERE i.org_id = $1 AND i.client_id = $2 ORDER BY i.number`,
          [s.orgId, clientId],
        );
        const overdue = rows.filter((i) => balanceOf(i, s.today).state === "overdue");
        const base = overdue.reduce((n, i) => n + balanceOf(i, s.today).balance, 0);
        const fee = shareOf(base, settings.late_fee_bp);
        if (fee <= 0) throw fail.conflict(`${c.name} has nothing overdue`);
        const runKey = `late:${clientId}:${s.today}`;
        if (await t.row("SELECT 1 FROM sec_invoices WHERE org_id = $1 AND run_key = $2", [s.orgId, runKey]))
          throw fail.conflict("A late-payment charge was already billed to this client today");
        const id = await issue(t, s, c, {
          siteId: null,
          runKey,
          vatBp: Math.round(vatPct * 100),
          lines: [
            {
              kind: "late_fee",
              description: `Late payment charge, ${settings.late_fee_bp / 100}% of overdue ${overdue.map((i) => i.number).join(", ")}`,
              quantity: 1,
              unit: "charge",
              amount: fee,
            },
          ],
        });
        return invoiceOut(t, await invoiceRow(t, s.orgId, id), s.today);
      });
    },

    async statement(s: OrgScope, clientId: string) {
      const c = await findClient(db, s.orgId, clientId);
      const portal = await db.rows<{ user_id: string }>(
        "SELECT user_id FROM sec_client_users WHERE client_id = $1 ORDER BY user_id",
        [clientId],
      );
      const rows = await db.rows<{
        date: string;
        kind: "invoice" | "receipt" | "certificate";
        ref: string;
        description: string;
        dr: number;
        cr: number;
      }>(
        `SELECT * FROM (
         SELECT date, 'invoice' AS kind, number AS ref, 'Invoice' AS description, total_minor AS dr, 0::bigint AS cr
           FROM sec_invoices WHERE org_id = $1 AND client_id = $2
         UNION ALL
         SELECT date, 'receipt', number, 'Payment · ' || replace(method, '_', ' ') || ' ' || reference, 0, amount_minor
           FROM sec_receipts WHERE org_id = $1 AND client_id = $2
         UNION ALL
         SELECT date, 'certificate', number, 'Withholding certificate ' || certificate_ref, 0, amount_minor
           FROM sec_tax_certificates WHERE org_id = $1 AND client_id = $2
) x ORDER BY date, CASE kind WHEN 'invoice' THEN 0 WHEN 'receipt' THEN 1 ELSE 2 END, ref`,
        [s.orgId, clientId],
      );
      let balance = 0;
      const lines = rows.map((r) => {
        balance += r.dr - r.cr;
        return {
          date: r.date,
          kind: r.kind,
          ref: r.ref,
          description: r.description,
          debitMinor: r.dr,
          creditMinor: r.cr,
          balanceMinor: balance,
        };
      });
      return {
        client: toClient(
          c,
          portal.map((p) => p.user_id),
        ),
        lines,
        balanceMinor: balance,
      };
    },

    async ageing(s: OrgScope) {
      const rows = await db.rows<InvoiceRow & { name: string }>(
        `${INVOICE_SELECT.replace("FROM sec_invoices i", ", c.name FROM sec_invoices i JOIN sec_clients c ON c.id = i.client_id")}
         WHERE i.org_id = $1 ORDER BY c.name, i.number`,
        [s.orgId],
      );
      const by = new Map<string, z.infer<typeof security.AgeingRow>>();
      for (const i of rows) {
        const { balance } = balanceOf(i, s.today);
        if (balance <= 0) continue;
        const r = by.get(i.client_id) ?? {
          clientId: i.client_id,
          name: i.name,
          notDueMinor: 0,
          d1to30Minor: 0,
          d31to60Minor: 0,
          d61to90Minor: 0,
          over90Minor: 0,
          totalMinor: 0,
        };
        const late = daysBetween(i.due_date, s.today);
        if (late <= 0) r.notDueMinor += balance;
        else if (late <= 30) r.d1to30Minor += balance;
        else if (late <= 60) r.d31to60Minor += balance;
        else if (late <= 90) r.d61to90Minor += balance;
        else r.over90Minor += balance;
        r.totalMinor += balance;
        by.set(i.client_id, r);
      }
      const list = [...by.values()];
      return { rows: list, totalMinor: list.reduce((n, r) => n + r.totalMinor, 0) };
    },

    async listNotes(s: OrgScope, clientId: string) {
      await findClient(db, s.orgId, clientId);
      const rows = await db.rows<{
        id: string;
        at: string;
        kind: "call" | "email" | "note" | "promise" | "reminder";
        text: string;
        promise_date: string | null;
        by_user: string;
        delivery: string | null;
      }>("SELECT * FROM sec_client_notes WHERE client_id = $1 ORDER BY at DESC, id", [clientId]);
      return {
        notes: rows.map((n) => ({
          id: n.id,
          at: n.at,
          kind: n.kind,
          text: n.text,
          promiseDate: n.promise_date,
          by: n.by_user,
          delivery: n.delivery,
        })),
      };
    },

    async addNote(s: OrgScope, clientId: string, b: Body<typeof security.addClientNote>) {
      return db.tx(async (t) => {
        const c = await findClient(t, s.orgId, clientId);
        if (b.kind === "promise" && !b.promiseDate) throw fail.invalid("A promise to pay needs the promised date");
        const delivery = b.kind === "reminder" ? messaging.deliver({ to: c.email ?? c.name, text: b.text }) : null;
        const id = newId("scn");
        await t.run(
          `INSERT INTO sec_client_notes (id, org_id, client_id, kind, text, promise_date, by_user, delivery)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, s.orgId, clientId, b.kind, b.text, b.promiseDate ?? null, s.userId, delivery],
        );
        const n = must(await t.row<{ at: string }>("SELECT at FROM sec_client_notes WHERE id = $1", [id]), "the note");
        return { id, at: n.at, kind: b.kind, text: b.text, promiseDate: b.promiseDate ?? null, by: s.userId, delivery };
      });
    },

    async importBankLines(s: OrgScope, b: Body<typeof security.importBankLines>) {
      return db.tx(async (t) => {
        let added = 0;
        let suggested = 0;
        const ids: string[] = [];
        for (const l of b.lines) {
          const sug = l.amountMinor > 0 ? await suggestion(t, s.orgId, l.amountMinor, s.today) : null;
          const id = newId("sbl");
          const n = await t.run(
            `INSERT INTO sec_bank_lines (id, org_id, date, description, reference, amount_minor, status,
               suggested_invoice_id, imported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (org_id, date, reference, amount_minor) DO NOTHING`,
            [
              id,
              s.orgId,
              l.date,
              l.description,
              l.reference,
              l.amountMinor,
              sug ? "suggested" : "unmatched",
              sug,
              s.userId,
            ],
          );
          if (!n) continue;
          added++;
          if (sug) suggested++;
          ids.push(id);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Statement lines imported",
          detail: `${added} new · ${suggested} suggested`,
        });
        const lines = [];
        for (const id of ids) lines.push(await bankLineOut(t, s.orgId, id));
        return { added, suggested, lines };
      });
    },

    async listBankLines(s: OrgScope) {
      const rows = await db.rows<{ id: string }>(
        "SELECT id FROM sec_bank_lines WHERE org_id = $1 ORDER BY (status IN ('matched', 'ignored')), date, id",
        [s.orgId],
      );
      const lines = [];
      for (const r of rows) lines.push(await bankLineOut(db, s.orgId, r.id));
      return { lines };
    },

    async matchBankLine(s: OrgScope, lineId: string, invoiceId: string, method: ReceiptOut["method"]) {
      return db.tx(async (t) => {
        const l = await t.row<{ id: string; date: string; reference: string; amount_minor: number; status: string }>(
          "SELECT * FROM sec_bank_lines WHERE org_id = $1 AND id = $2 FOR UPDATE",
          [s.orgId, lineId],
        );
        if (!l) throw fail.notFound("Statement line not found");
        if (l.status === "matched" || l.status === "ignored") throw fail.conflict(`This line is already ${l.status}`);
        if (l.amount_minor <= 0) throw fail.invalid("Only money in can be matched to an invoice");
        const inv = await invoiceRow(t, s.orgId, invoiceId);
        const c = await findClient(t, s.orgId, inv.client_id);
        const receiptId = await receive(t, s, c, {
          date: l.date,
          method,
          reference: l.reference,
          allocations: [{ invoiceId, amountMinor: l.amount_minor }],
        });
        await t.run("UPDATE sec_bank_lines SET status = 'matched', receipt_id = $2 WHERE id = $1", [lineId, receiptId]);
        return { line: await bankLineOut(t, s.orgId, lineId), receipt: await receiptOut(t, s.orgId, receiptId) };
      });
    },
  };
}

export type BillingService = ReturnType<typeof billingService>;
