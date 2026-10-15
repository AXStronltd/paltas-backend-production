/*
 * Billing extensions:
 *   - multi-currency: staff enter the day's rate (no FX feed); a foreign payment is converted at the business date's
 *     rate and recorded on the folio in the hotel's currency (bank 1000 / guest ledger 1150), the foreign amount kept;
 *   - tax invoices and credit notes: sequential numbers per organisation (HINV- / HCN-), issued only for a settled
 *     folio, never edited (database trigger); a credit note cancels the document so the folio can be invoiced again;
 *     e-invoicing goes through its adapter (test adapter: not submitted); e-mail is recorded in the outbox;
 *   - city-ledger collections: actions, promises to pay, statements recorded in the outbox, overdue list;
 *   - card and payment reconciliation: bank lines imported, matched to recorded payments (auto by amount and
 *     reference, or by hand with the provider fee: bank charges 5300 / bank 1000), chargebacks (receivables 1100 /
 *     bank 1000). A recorded payment is matched once (primary key).
 */
import type { hotel, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import * as folioRepo from "../folios/folios.repo.js";
import type { HotelScope } from "../shared/access.js";
import { daysBetween } from "../shared/dates.js";
import { fill, recordMessage, templateFor, toMessage, type MessageRow } from "../shared/outbox.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { findProperty } from "../shared/property.js";
import { fromRateMicro, toForeign, toLocal, toRateMicro } from "./fx.js";

interface InvoiceRow {
  id: string;
  number: string;
  kind: "invoice" | "credit_note";
  folio_id: string;
  corporate_account_id: string | null;
  credits_invoice_id: string | null;
  cancelled_by_id: string | null;
  issued_on: string;
  document: {
    currency: string;
    seller: hotel.InvoiceOut["seller"];
    buyer: hotel.InvoiceOut["buyer"];
    lines: hotel.InvoiceOut["lines"];
    totals: hotel.InvoiceOut["totals"];
    settlements: hotel.InvoiceOut["settlements"];
  };
  einvoice_status: string;
  einvoice_ref: string | null;
  issued_by: string | null;
  reservation_id?: string | null;
}

interface BankLineRow {
  id: string;
  date: string;
  amount_minor: number;
  reference: string;
  description: string;
  status: "unmatched" | "matched" | "chargeback";
  fee_minor: number;
}

interface PaymentRow {
  source: string;
  date: string;
  kind: hotel.RecordedPaymentOut["kind"];
  method: hotel.PaymentMethod;
  amount: number;
  reference: string;
  matched: boolean;
}

/** Every payment recorded at a hotel, as reconciliation sees it: "<kind>:<id>". */
const PAYMENTS_SQL = `
  SELECT * FROM (
    SELECT 'line:' || l.id AS source, l.business_date AS date, 'folio_payment' AS kind, l.method, -l.total_minor AS amount,
           COALESCE(l.reference, '') AS reference
      FROM hotel_folio_lines l WHERE l.property_id = $1 AND l.kind = 'payment'
    UNION ALL
    SELECT 'deposit:' || d.id, d.received_date, 'deposit', d.method, d.amount_minor, d.reference
      FROM hotel_deposits d WHERE d.property_id = $1
    UNION ALL
    SELECT 'cl:' || c.id, c.date, 'company_payment', COALESCE(c.method, 'bank_transfer'), c.amount_minor,
           COALESCE(c.bank_reference, c.reference)
      FROM hotel_city_ledger c WHERE c.property_id = $1 AND c.kind = 'payment'
    UNION ALL
    SELECT 'evdep:' || e.id, e.received_date, 'event_deposit', e.method, e.amount_minor, e.reference
      FROM hotel_event_deposits e WHERE e.property_id = $1
    UNION ALL
    SELECT 'tip:' || t.id, t.business_date, 'tip', t.method, t.amount_minor, t.reference
      FROM hotel_tips t WHERE t.property_id = $1
  ) p`;

export function billingService(d: HotelDeps, x: { folios: FoliosService }) {
  const { core, adapters } = d;
  const { db } = core;
  const { folios } = x;

  // ---------------------------------------------------------------- exchange rates
  async function ratesOn(t: Db, propertyId: string, date: string) {
    return t.rows<{ currency: string; rate_micro: number; entered_by: string | null }>(
      "SELECT currency, rate_micro, entered_by FROM hotel_fx_rates WHERE property_id = $1 AND date = $2 ORDER BY currency",
      [propertyId, date],
    );
  }

  async function rateFor(t: Db, s: HotelScope, currency: string): Promise<number> {
    if (currency === s.property.currency) throw fail.invalid(`${currency} is the hotel's own currency`);
    const r = await t.row<{ rate_micro: number }>(
      "SELECT rate_micro FROM hotel_fx_rates WHERE property_id = $1 AND date = $2 AND currency = $3",
      [s.property.id, s.property.business_date, currency],
    );
    if (!r)
      throw fail.conflict(`No ${currency} rate entered for ${s.property.business_date} — enter the day's rate first`);
    return r.rate_micro;
  }

  async function fxView(s: HotelScope, date: string) {
    const rows = await ratesOn(db, s.property.id, date);
    return {
      hotelCurrency: s.property.currency,
      date,
      rates: rows.map((r) => ({
        date,
        currency: r.currency,
        rate: fromRateMicro(r.rate_micro),
        enteredBy: r.entered_by,
      })),
      feed: adapters.fxRates.state,
    };
  }

  // ---------------------------------------------------------------- invoices
  async function invoiceRow(t: Db, propertyId: string, id: string): Promise<InvoiceRow> {
    const r = await t.row<InvoiceRow>("SELECT * FROM hotel_invoices WHERE property_id = $1 AND id = $2", [
      propertyId,
      id,
    ]);
    if (!r) throw fail.notFound("Invoice not found");
    return r;
  }

  const toInvoice = (r: InvoiceRow): hotel.InvoiceOut => ({
    id: r.id,
    number: r.number,
    kind: r.kind,
    folioId: r.folio_id,
    corporateAccountId: r.corporate_account_id,
    issuedOn: r.issued_on,
    currency: r.document.currency,
    seller: r.document.seller,
    buyer: r.document.buyer,
    lines: r.document.lines,
    totals: r.document.totals,
    settlements: r.document.settlements,
    creditsInvoiceId: r.credits_invoice_id,
    cancelledById: r.cancelled_by_id,
    einvoicing: {
      ...adapters.einvoicing.state,
      status: r.einvoice_status === "not submitted" ? adapters.einvoicing.state.status : r.einvoice_status,
      reference: r.einvoice_ref,
    },
  });

  /** The invoice document of a folio: what was charged (net of voids, allowances, moves) and how it was settled. */
  async function invoiceDocument(
    t: Db,
    s: HotelScope,
    f: folioRepo.FolioRow,
    buyerIn: Partial<hotel.InvoiceOut["buyer"]>,
  ) {
    const ls = await folioRepo.lines(t, f.id);
    const charged = ls.filter((l) => ["charge", "void", "allowance", "transfer"].includes(l.kind));
    if (!charged.some((l) => l.kind === "charge" || (l.kind === "transfer" && l.total_minor > 0)))
      throw fail.conflict(`Folio ${f.number} has no charges to invoice`);
    const lines = charged.map((l) => ({
      date: l.business_date,
      description: l.description,
      department: l.department,
      netMinor: l.net_minor,
      serviceChargeMinor: l.service_minor,
      vatMinor: l.vat_minor,
      levyMinor: l.levy_minor,
      totalMinor: l.total_minor,
    }));
    const sum = (k: keyof (typeof lines)[number]) => lines.reduce((n, l) => n + (l[k] as number), 0);
    const settlements = ls
      .filter((l) => !["charge", "void", "allowance", "transfer"].includes(l.kind))
      .map((l) => ({ date: l.business_date, description: l.description, amountMinor: -l.total_minor }));
    let buyer: hotel.InvoiceOut["buyer"];
    if (f.corporate_account_id) {
      const a = await t.row<{
        name: string;
        tax_id: string | null;
        billing_address: string | null;
        contact_email: string | null;
      }>("SELECT name, tax_id, billing_address, contact_email FROM hotel_corporate_accounts WHERE id = $1", [
        f.corporate_account_id,
      ]);
      buyer = {
        name: a?.name ?? f.name,
        taxId: a?.tax_id ?? null,
        address: a?.billing_address ?? null,
        email: a?.contact_email ?? null,
      };
    } else {
      const g = f.reservation_id
        ? await t.row<{ name: string; email: string | null }>(
            "SELECT g.name, g.email FROM hotel_reservations r JOIN hotel_guests g ON g.id = r.guest_id WHERE r.id = $1",
            [f.reservation_id],
          )
        : null;
      buyer = { name: g?.name ?? f.name, taxId: null, address: null, email: g?.email ?? null };
    }
    buyer = {
      name: buyerIn.name ?? buyer.name,
      taxId: buyerIn.taxId ?? buyer.taxId,
      address: buyerIn.address ?? buyer.address,
      email: buyerIn.email ?? buyer.email,
    };
    const p = s.property;
    return {
      currency: p.currency,
      seller: { name: p.legal_name || p.name, taxId: p.tax_id, address: p.address || `${p.city}, ${p.country}` },
      buyer,
      lines,
      totals: {
        netMinor: sum("netMinor"),
        serviceChargeMinor: sum("serviceChargeMinor"),
        vatMinor: sum("vatMinor"),
        levyMinor: sum("levyMinor"),
        totalMinor: sum("totalMinor"),
      },
      settlements,
    };
  }

  // ---------------------------------------------------------------- bank reconciliation
  async function bankLine(t: Db, propertyId: string, id: string, lock = false): Promise<BankLineRow> {
    const r = await t.row<BankLineRow>(
      `SELECT * FROM hotel_bank_lines WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [propertyId, id],
    );
    if (!r) throw fail.notFound("Bank line not found");
    return r;
  }

  async function toBankLine(t: Db, r: BankLineRow): Promise<hotel.BankLineOut> {
    const m = await t.rows<{ source: string; amount_minor: number }>(
      "SELECT source, amount_minor FROM hotel_bank_matches WHERE bank_line_id = $1 ORDER BY source",
      [r.id],
    );
    return {
      id: r.id,
      date: r.date,
      amountMinor: r.amount_minor,
      reference: r.reference,
      description: r.description,
      status: r.status,
      feeMinor: r.fee_minor,
      matches: m.map((x) => ({ source: x.source, amountMinor: x.amount_minor })),
    };
  }

  async function payments(t: Db, propertyId: string, where = "", params: unknown[] = []): Promise<PaymentRow[]> {
    return t.rows<PaymentRow>(
      `SELECT p.*, EXISTS (SELECT 1 FROM hotel_bank_matches m WHERE m.source = p.source) AS matched
       FROM (${PAYMENTS_SQL}) p ${where} ORDER BY p.date, p.source`,
      [propertyId, ...params],
    );
  }

  async function match(t: Db, s: HotelScope, line: BankLineRow, sources: PaymentRow[], fee: number) {
    for (const p of sources)
      await t.run("INSERT INTO hotel_bank_matches (source, bank_line_id, org_id, amount_minor) VALUES ($1,$2,$3,$4)", [
        p.source,
        line.id,
        s.orgId,
        p.amount,
      ]);
    let feeJournal: string | null = null;
    if (fee > 0)
      feeJournal = await postToLedger(t, core, {
        orgId: s.orgId,
        propertyId: s.property.id,
        date: s.property.business_date,
        kind: "bank",
        memo: `Card / provider fee on bank line ${line.reference} (${line.date})`,
        ref: `bankfee:${line.id}`,
        lines: [dr(ACC.bankCharges, fee), cr(ACC.bank, fee)],
      });
    await t.run(
      `UPDATE hotel_bank_lines SET status = 'matched', fee_minor = $2, fee_journal_id = $3, matched_by = $4, matched_at = now()
       WHERE id = $1`,
      [line.id, fee, feeJournal, s.userId],
    );
  }

  return {
    // ---------------------------------------------------------------- exchange rates
    listFxRates: (s: HotelScope, date?: string) => fxView(s, date ?? s.property.business_date),

    async setFxRates(s: HotelScope, date: string, rates: { currency: string; rate: number }[]) {
      if (rates.some((r) => r.currency === s.property.currency))
        throw fail.invalid(`${s.property.currency} is the hotel's own currency`);
      if (new Set(rates.map((r) => r.currency)).size !== rates.length) throw fail.invalid("One rate per currency");
      await db.tx(async (t) => {
        for (const r of rates)
          await t.run(
            `INSERT INTO hotel_fx_rates (property_id, date, currency, org_id, rate_micro, entered_by) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (property_id, date, currency) DO UPDATE SET rate_micro = EXCLUDED.rate_micro,
               entered_by = EXCLUDED.entered_by, entered_at = now()`,
            [s.property.id, date, r.currency, s.orgId, toRateMicro(r.rate), s.userId],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Exchange rates entered",
          target: `${s.property.id}:${date}`,
          after: rates,
        });
      });
      return fxView(s, date);
    },

    async folioInCurrency(s: HotelScope, folioId: string, currency: string) {
      const f = await folioRepo.folioRow(db, s.property.id, folioId);
      const rate = await rateFor(db, s, currency);
      const balance = await folioRepo.balance(db, f.id);
      return {
        currency,
        rate: fromRateMicro(rate),
        rateDate: s.property.business_date,
        balanceMinor: balance,
        balanceForeignMinor: toForeign(balance, currency, rate, s.property.currency),
      };
    },

    async recordFxPayment(s: HotelScope, folioId: string, b: z.output<typeof hotel.recordFxPayment.body>) {
      const out = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const rate = await rateFor(t, s, b.currency);
        const local = toLocal(b.foreignAmountMinor, b.currency, rate, s.property.currency);
        if (local <= 0) throw fail.invalid("The amount is too small to convert");
        const lineId = await folios.payment(t, s, folioId, {
          method: b.method,
          amountMinor: local,
          reference: `${b.reference} · ${b.currency} ${b.foreignAmountMinor} at ${fromRateMicro(rate)}`,
        });
        await t.run(
          `INSERT INTO hotel_fx_payments (line_id, org_id, currency, foreign_minor, rate_micro, rate_date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [lineId, s.orgId, b.currency, b.foreignAmountMinor, rate, s.property.business_date],
        );
        return { local, rate };
      });
      return {
        folio: await folios.get(s.property.id, folioId),
        fx: {
          currency: b.currency,
          foreignAmountMinor: b.foreignAmountMinor,
          rate: fromRateMicro(out.rate),
          localAmountMinor: out.local,
        },
      };
    },

    // ---------------------------------------------------------------- allowances (comps and discounts)
    postAllowance: (s: HotelScope, folioId: string, lineId: string, b: z.output<typeof hotel.postAllowance.body>) =>
      folios.postAllowance(s, folioId, lineId, b),
    approveAllowance: (s: HotelScope, folioId: string, allowanceId: string) =>
      folios.approveAllowance(s, folioId, allowanceId),

    // ---------------------------------------------------------------- invoices
    async issueInvoice(s: HotelScope, folioId: string, b: z.output<typeof hotel.issueInvoice.body>) {
      const id = newId("hin");
      await db.tx(async (t) => {
        const f = await folioRepo.folioRow(t, s.property.id, folioId, true);
        const balance = await folioRepo.balance(t, f.id);
        if (balance !== 0) throw fail.conflict(`Settle folio ${f.number} first (balance ${balance})`);
        if (
          await t.row(
            "SELECT 1 FROM hotel_invoices WHERE folio_id = $1 AND kind = 'invoice' AND cancelled_by_id IS NULL",
            [f.id],
          )
        )
          throw fail.conflict(`Folio ${f.number} is already invoiced — cancel that invoice with a credit note first`);
        const doc = await invoiceDocument(t, s, f, b.buyer);
        const number = await nextNumber(t, s.orgId, "HINV", 6);
        await t.run(
          `INSERT INTO hotel_invoices (id, org_id, property_id, number, kind, folio_id, corporate_account_id, issued_on,
             document, total_minor, issued_by)
           VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,$8,$9,$10)`,
          [
            id,
            s.orgId,
            s.property.id,
            number,
            f.id,
            f.corporate_account_id,
            s.property.business_date,
            JSON.stringify(doc),
            doc.totals.totalMinor,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: f.corporate_account_id ? "Company invoice issued" : "Tax invoice issued",
          target: number,
          detail: `${f.number} · ${doc.totals.totalMinor}`,
        });
      });
      return toInvoice(await invoiceRow(db, s.property.id, id));
    },

    async listInvoices(s: HotelScope, q: { from?: string | undefined; to?: string | undefined }) {
      const rows = await db.rows<InvoiceRow>(
        `SELECT * FROM hotel_invoices WHERE property_id = $1 AND ($2::date IS NULL OR issued_on >= $2)
           AND ($3::date IS NULL OR issued_on <= $3) ORDER BY number`,
        [s.property.id, q.from ?? null, q.to ?? null],
      );
      return { invoices: rows.map(toInvoice) };
    },

    getInvoice: async (s: HotelScope, id: string) => toInvoice(await invoiceRow(db, s.property.id, id)),

    async creditNote(s: HotelScope, invoiceId: string, reason: string) {
      const id = newId("hin");
      await db.tx(async (t) => {
        const inv = await t.row<InvoiceRow>(
          "SELECT * FROM hotel_invoices WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, invoiceId],
        );
        if (!inv) throw fail.notFound("Invoice not found");
        if (inv.kind !== "invoice") throw fail.invalid("A credit note cancels an invoice");
        if (inv.cancelled_by_id) throw fail.conflict(`Invoice ${inv.number} is already cancelled`);
        if (inv.issued_by === s.userId)
          throw fail.separationOfDuties("You issued this invoice — someone else must cancel it with a credit note");
        const neg = (n: number) => -n;
        const doc = {
          ...inv.document,
          lines: inv.document.lines.map((l) => ({
            ...l,
            netMinor: neg(l.netMinor),
            serviceChargeMinor: neg(l.serviceChargeMinor),
            vatMinor: neg(l.vatMinor),
            levyMinor: neg(l.levyMinor),
            totalMinor: neg(l.totalMinor),
          })),
          totals: {
            netMinor: neg(inv.document.totals.netMinor),
            serviceChargeMinor: neg(inv.document.totals.serviceChargeMinor),
            vatMinor: neg(inv.document.totals.vatMinor),
            levyMinor: neg(inv.document.totals.levyMinor),
            totalMinor: neg(inv.document.totals.totalMinor),
          },
          settlements: [],
        };
        const number = await nextNumber(t, s.orgId, "HCN", 6);
        await t.run(
          `INSERT INTO hotel_invoices (id, org_id, property_id, number, kind, folio_id, corporate_account_id,
             credits_invoice_id, issued_on, document, total_minor, issued_by)
           VALUES ($1,$2,$3,$4,'credit_note',$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            s.orgId,
            s.property.id,
            number,
            inv.folio_id,
            inv.corporate_account_id,
            inv.id,
            s.property.business_date,
            JSON.stringify(doc),
            doc.totals.totalMinor,
            s.userId,
          ],
        );
        await t.run("UPDATE hotel_invoices SET cancelled_by_id = $2 WHERE id = $1", [inv.id, id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Credit note issued",
          target: number,
          detail: `Cancels ${inv.number}: ${reason}`,
        });
      });
      return toInvoice(await invoiceRow(db, s.property.id, id));
    },

    async emailInvoice(s: HotelScope, invoiceId: string, recipient?: string) {
      const inv = await invoiceRow(db, s.property.id, invoiceId);
      const to = recipient ?? inv.document.buyer.email;
      if (!to) throw fail.invalid("The buyer has no e-mail address — give the recipient");
      const id = await db.tx(async (t) => {
        const f = await folioRepo.folioRow(t, s.property.id, inv.folio_id);
        const tpl = await templateFor(t, s.property.id, "invoice", "en");
        const vars = {
          guest: inv.document.buyer.name,
          hotel: s.property.name,
          number: inv.number,
          date: inv.issued_on,
          amount: `${inv.document.currency} ${(inv.document.totals.totalMinor / 100).toFixed(2)}`,
        };
        const mid = (await recordMessage(t, d, s, {
          reservationId: f.reservation_id,
          channel: "email",
          direction: "outbound",
          template: "invoice",
          subject: fill(tpl.subject, vars),
          body: fill(tpl.body, vars),
          recipient: to,
        })) as string;
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Invoice e-mail recorded (not sent)",
          target: inv.number,
          detail: to,
        });
        return mid;
      });
      return {
        message: toMessage(
          (await db.row<MessageRow>("SELECT * FROM hotel_messages WHERE id = $1", [id])) as MessageRow,
        ),
      };
    },

    async submitEInvoice(s: HotelScope, invoiceId: string) {
      const inv = await invoiceRow(db, s.property.id, invoiceId);
      const r = adapters.einvoicing.submit({ number: inv.number, totalMinor: inv.document.totals.totalMinor });
      await db.tx(async (t) => {
        await t.run("UPDATE hotel_invoices SET einvoice_status = $2, einvoice_ref = $3 WHERE id = $1", [
          inv.id,
          r.status,
          r.reference,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "E-invoice submission attempted",
          target: inv.number,
          detail: r.status,
        });
      });
      return toInvoice(await invoiceRow(db, s.property.id, invoiceId));
    },

    // ---------------------------------------------------------------- collections
    async listCollections(s: OrgScope, accountId: string) {
      if (!(await db.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [s.orgId, accountId])))
        throw fail.notFound("Company account not found");
      const rows = await db.rows<CollectionRow>(
        "SELECT * FROM hotel_collection_actions WHERE org_id = $1 AND account_id = $2 ORDER BY created_at DESC, id",
        [s.orgId, accountId],
      );
      return { actions: rows.map(toAction) };
    },

    async recordCollection(
      s: OrgScope,
      accountId: string,
      b: z.output<typeof hotel.recordCollection.body>,
      balanceOf: (t: Db) => Promise<number>,
      allowedProperty: (propertyId: string) => Promise<void>,
    ) {
      const id = newId("hco");
      await db.tx(async (t) => {
        const a = await t.row<{ name: string; contact_email: string | null }>(
          "SELECT name, contact_email FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2",
          [s.orgId, accountId],
        );
        if (!a) throw fail.notFound("Company account not found");
        let messageId: string | null = null;
        if (b.kind === "statement_sent" || b.kind === "reminder") {
          await allowedProperty(b.propertyId as string);
          if (!a.contact_email) throw fail.invalid(`${a.name} has no contact e-mail for statements`);
          const p = await findProperty(t, s.orgId, b.propertyId as string);
          const tpl = await templateFor(t, p.id, "statement", "en");
          const vars = {
            company: a.name,
            hotel: p.name,
            amount: `${p.currency} ${((await balanceOf(t)) / 100).toFixed(2)}`,
            date: p.business_date,
          };
          messageId = await recordMessage(
            t,
            d,
            { orgId: s.orgId, userId: s.userId, property: p },
            {
              reservationId: null,
              channel: "email",
              direction: "outbound",
              template: "statement",
              subject: fill(tpl.subject, vars),
              body: `${fill(tpl.body, vars)}${b.kind === "reminder" ? ` ${b.note}` : ""}`,
              recipient: a.contact_email,
            },
          );
        }
        await t.run(
          `INSERT INTO hotel_collection_actions (id, org_id, account_id, kind, note, promised_date, promised_minor,
             next_action_date, message_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            s.orgId,
            accountId,
            b.kind,
            b.note,
            b.promisedDate ?? null,
            b.promisedMinor ?? null,
            b.nextActionDate ?? null,
            messageId,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Collection action recorded",
          target: accountId,
          detail: `${b.kind}: ${b.note}`,
        });
      });
      return toAction(
        (await db.row<CollectionRow>("SELECT * FROM hotel_collection_actions WHERE id = $1", [id])) as CollectionRow,
      );
    },

    async collectionsDue(s: OrgScope) {
      const accounts = await db.rows<{ id: string; name: string; payment_terms_days: number }>(
        "SELECT id, name, payment_terms_days FROM hotel_corporate_accounts WHERE org_id = $1 ORDER BY name",
        [s.orgId],
      );
      const out = [];
      for (const a of accounts) {
        const entries = await db.rows<{ kind: "invoice" | "payment"; date: string; amount_minor: number }>(
          "SELECT kind, date, amount_minor FROM hotel_city_ledger WHERE account_id = $1 ORDER BY date, number",
          [a.id],
        );
        let paid = entries.filter((e) => e.kind === "payment").reduce((n, e) => n + e.amount_minor, 0);
        let balance = -paid;
        let overdue = 0;
        for (const inv of entries.filter((e) => e.kind === "invoice")) {
          balance += inv.amount_minor;
          const settled = Math.min(paid, inv.amount_minor);
          paid -= settled;
          if (inv.amount_minor - settled > 0 && daysBetween(inv.date, s.today) > a.payment_terms_days)
            overdue += inv.amount_minor - settled;
        }
        if (overdue <= 0) continue;
        const last = await db.row<CollectionRow>(
          "SELECT * FROM hotel_collection_actions WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT 1",
          [a.id],
        );
        out.push({
          accountId: a.id,
          name: a.name,
          balanceMinor: balance,
          overdueMinor: overdue,
          paymentTermsDays: a.payment_terms_days,
          lastAction: last ? toAction(last) : null,
          nextActionDate: last?.next_action_date ?? null,
        });
      }
      return { accounts: out };
    },

    // ---------------------------------------------------------------- bank reconciliation
    async importBankLines(s: HotelScope, b: z.output<typeof hotel.importBankLines.body>) {
      const importId = newId("hbi");
      const ids: string[] = [];
      let auto = 0;
      await db.tx(async (t) => {
        if (
          await t.row("SELECT 1 FROM hotel_bank_imports WHERE property_id = $1 AND statement_ref = $2", [
            s.property.id,
            b.statementRef,
          ])
        )
          throw fail.conflict(`Statement ${b.statementRef} was already imported`);
        await t.run(
          "INSERT INTO hotel_bank_imports (id, org_id, property_id, statement_ref, imported_by) VALUES ($1,$2,$3,$4,$5)",
          [importId, s.orgId, s.property.id, b.statementRef, s.userId],
        );
        for (const l of b.lines) {
          const id = newId("hbl");
          ids.push(id);
          await t.run(
            `INSERT INTO hotel_bank_lines (id, org_id, property_id, import_id, date, amount_minor, reference, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, s.orgId, s.property.id, importId, l.date, l.amountMinor, l.reference, l.description],
          );
          if (l.amountMinor <= 0) continue;
          // the same amount and reference as one unmatched recorded payment, within a week
          const hits = await payments(
            t,
            s.property.id,
            `WHERE p.amount = $2 AND lower(p.reference) = lower($3) AND abs(p.date - $4::date) <= 7
               AND NOT EXISTS (SELECT 1 FROM hotel_bank_matches m WHERE m.source = p.source)`,
            [l.amountMinor, l.reference, l.date],
          );
          if (hits.length === 1) {
            await match(t, s, await bankLine(t, s.property.id, id, true), hits, 0);
            auto++;
          }
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bank statement imported",
          target: b.statementRef,
          detail: `${b.lines.length} line(s), ${auto} matched automatically`,
        });
      });
      const lines = [];
      for (const id of ids) lines.push(await toBankLine(db, await bankLine(db, s.property.id, id)));
      return { importId, lines, autoMatched: auto };
    },

    async listBankLines(s: HotelScope, status?: BankLineRow["status"]) {
      const rows = await db.rows<BankLineRow>(
        `SELECT * FROM hotel_bank_lines WHERE property_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY date, id`,
        [s.property.id, status ?? null],
      );
      const lines = [];
      for (const r of rows) lines.push(await toBankLine(db, r));
      return { lines };
    },

    async recordedPayments(s: HotelScope, q: { from: string; to: string; unmatchedOnly: boolean }) {
      const rows = await payments(db, s.property.id, "WHERE p.date BETWEEN $2 AND $3", [q.from, q.to]);
      return {
        payments: rows
          .filter((p) => !q.unmatchedOnly || !p.matched)
          .map((p) => ({
            source: p.source,
            date: p.date,
            kind: p.kind,
            method: p.method,
            amountMinor: p.amount,
            reference: p.reference,
            matched: p.matched,
          })),
      };
    },

    async matchBankLine(s: HotelScope, lineId: string, b: { sources: string[]; feeMinor: number }) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const line = await bankLine(t, s.property.id, lineId, true);
        if (line.status !== "unmatched") throw fail.conflict("This bank line is already reconciled");
        if (line.amount_minor <= 0)
          throw fail.invalid("A money-out line is a chargeback or a payment, not a takings match");
        if (new Set(b.sources).size !== b.sources.length) throw fail.invalid("Each payment once");
        const found = await payments(t, s.property.id, "WHERE p.source = ANY($2::text[])", [b.sources]);
        if (found.length !== b.sources.length) throw fail.notFound("A payment was not found at this hotel");
        const taken = found.filter((p) => p.matched);
        if (taken.length) throw fail.conflict(`Already matched to the bank: ${taken.map((p) => p.source).join(", ")}`);
        const total = found.reduce((n, p) => n + p.amount, 0);
        if (total - b.feeMinor !== line.amount_minor)
          throw fail.invalid(
            `The payments (${total}) less the fee (${b.feeMinor}) must equal the bank line (${line.amount_minor})`,
          );
        await match(t, s, line, found, b.feeMinor);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Bank line matched",
          target: line.id,
          detail: `${found.length} payment(s), fee ${b.feeMinor}`,
        });
      });
      return toBankLine(db, await bankLine(db, s.property.id, lineId));
    },

    async chargeback(s: HotelScope, lineId: string, b: { source: string; reason: string }) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const line = await bankLine(t, s.property.id, lineId, true);
        if (line.status !== "unmatched") throw fail.conflict("This bank line is already reconciled");
        if (line.amount_minor >= 0) throw fail.invalid("A chargeback is money taken back out of the bank");
        const [p] = await payments(t, s.property.id, "WHERE p.source = $2", [b.source]);
        if (!p) throw fail.notFound("Payment not found at this hotel");
        if (!["card", "mobile_money"].includes(p.method))
          throw fail.invalid("Only card and mobile-money payments are charged back");
        if (p.amount !== -line.amount_minor)
          throw fail.invalid(`The chargeback (${-line.amount_minor}) must equal the payment (${p.amount})`);
        if (await t.row("SELECT 1 FROM hotel_bank_lines WHERE chargeback_source = $1", [p.source]))
          throw fail.conflict("This payment was already charged back");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "bank",
          memo: `Chargeback of ${p.reference} (${p.method}): ${b.reason} — owed again`,
          ref: `chargeback:${line.id}`,
          lines: [dr(ACC.receivables, p.amount), cr(ACC.bank, p.amount)],
        });
        await t.run(
          `UPDATE hotel_bank_lines SET status = 'chargeback', journal_id = $2, chargeback_source = $3, matched_by = $4,
             matched_at = now() WHERE id = $1`,
          [line.id, journalId, p.source, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Chargeback recorded",
          target: p.source,
          detail: `${p.amount}: ${b.reason}`,
        });
      });
      return toBankLine(db, await bankLine(db, s.property.id, lineId));
    },

    async summary(s: HotelScope, from: string, to: string) {
      const ps = await payments(db, s.property.id, "WHERE p.date BETWEEN $2 AND $3", [from, to]);
      const lines = await db.rows<BankLineRow>(
        "SELECT * FROM hotel_bank_lines WHERE property_id = $1 AND date BETWEEN $2 AND $3",
        [s.property.id, from, to],
      );
      const sum = (xs: { amount: number }[]) => xs.reduce((n, p) => n + p.amount, 0);
      const methods: hotel.PaymentMethod[] = ["cash", "card", "mobile_money", "bank_transfer"];
      return {
        recordedMinor: sum(ps),
        matchedMinor: sum(ps.filter((p) => p.matched)),
        unmatchedMinor: sum(ps.filter((p) => !p.matched)),
        bankLinesMinor: lines.filter((l) => l.amount_minor > 0).reduce((n, l) => n + l.amount_minor, 0),
        unmatchedBankMinor: lines.filter((l) => l.status === "unmatched").reduce((n, l) => n + l.amount_minor, 0),
        feesMinor: lines.reduce((n, l) => n + l.fee_minor, 0),
        chargebacksMinor: lines.filter((l) => l.status === "chargeback").reduce((n, l) => n - l.amount_minor, 0),
        byMethod: methods.map((m) => {
          const mine = ps.filter((p) => p.method === m);
          return {
            method: m,
            recordedMinor: sum(mine),
            matchedMinor: sum(mine.filter((p) => p.matched)),
            unmatchedMinor: sum(mine.filter((p) => !p.matched)),
          };
        }),
      };
    },
  };
}

interface CollectionRow {
  id: string;
  account_id: string;
  kind: hotel.CollectionActionOut["kind"];
  note: string;
  promised_date: string | null;
  promised_minor: number | null;
  next_action_date: string | null;
  message_id: string | null;
  created_by: string | null;
  created_at: string;
}

const toAction = (r: CollectionRow): hotel.CollectionActionOut => ({
  id: r.id,
  accountId: r.account_id,
  kind: r.kind,
  note: r.note,
  promisedDate: r.promised_date,
  promisedMinor: r.promised_minor,
  nextActionDate: r.next_action_date,
  messageId: r.message_id,
  createdBy: r.created_by,
  at: r.created_at,
});

export type BillingService = ReturnType<typeof billingService>;
