// Billing extensions: multi-currency at the day's rate, comps and discounts, tax invoices and credit notes,
// collections, and card / payment reconciliation to the bank — every money movement checked against the ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel billing extensions", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let kofi: { reservationId: string; stayId: string; folioId: string };
  let fxLineId: string;
  let lenaPaymentId: string;
  let lenaInvoice: string;

  beforeAll(async () => {
    X = await extHotel("Billing");
    kofi = await X.inHouse("Kofi Mensah", "101");
  });
  afterAll(() => X.S.close());

  it("multi-currency: staff enter the day's rate; a foreign payment converts exactly and is recorded, not processed", async () => {
    const { st, P } = X;
    // the receptionist cannot set rates; the front office manager can
    await refused(
      api(st.receptionist).setFxRates({
        params: { ...P, date: "2026-10-11" },
        body: { rates: [{ currency: "USD", rate: 129.5 }] },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      api(st.front_office_manager).setFxRates({
        params: { ...P, date: "2026-10-11" },
        body: { rates: [{ currency: "KES", rate: 1 }] },
      }),
      400,
    );
    const set = await api(st.front_office_manager).setFxRates({
      params: { ...P, date: "2026-10-11" },
      body: {
        rates: [
          { currency: "USD", rate: 129.5 },
          { currency: "JPY", rate: 0.88 },
        ],
      },
    });
    expect(set.rates.map((r) => [r.currency, r.rate])).toEqual([
      ["JPY", 0.88],
      ["USD", 129.5],
    ]);
    expect(set.feed.connected).toBe(false);
    await api(st.receptionist).postCharge({
      params: { ...P, folioId: kofi.folioId },
      body: { department: "fnb", description: "Dinner", amountMinor: 100_000 },
    });
    // 100,000 + 10 % service + 16 % VAT on both = 127,600; in USD at 129.5 that is 985.33 → 985 cents
    const shown = await api(st.receptionist).folioInCurrency({
      params: { ...P, folioId: kofi.folioId },
      query: { currency: "USD" },
    });
    expect([shown.balanceMinor, shown.balanceForeignMinor, shown.rate]).toEqual([127_600, 985, 129.5]);
    await refused(
      api(st.receptionist).recordFxPayment({
        params: { ...P, folioId: kofi.folioId },
        body: { currency: "EUR", foreignAmountMinor: 10_000, method: "card", reference: "EUR-1" },
      }),
      409,
    );
    const bankBefore = await X.ledger("1000");
    // USD 9.85 × 129.5 = KES 1,275.575 → 127,558 minor units (half up)
    const paid = await api(st.receptionist).recordFxPayment({
      params: { ...P, folioId: kofi.folioId },
      body: { currency: "USD", foreignAmountMinor: 985, method: "card", reference: "FX-1" },
    });
    expect(paid.fx).toEqual({ currency: "USD", foreignAmountMinor: 985, rate: 129.5, localAmountMinor: 127_558 });
    expect(paid.folio.balanceMinor).toBe(127_600 - 127_558);
    fxLineId = paid.folio.lines.at(-1)!.id;
    expect(paid.folio.lines.at(-1)!.reference).toMatch(/USD 985 at 129\.5/);
    expect((await X.ledger("1000")) - bankBefore).toBe(127_558);
    // cash needs the receptionist's open cashier shift; a currency with no minor unit converts by its own decimals:
    // JPY 1,000 × 0.88 = KES 880.00
    const yen = { currency: "JPY", foreignAmountMinor: 1_000, method: "cash" as const, reference: "JPY-1" };
    await refused(api(st.receptionist).recordFxPayment({ params: { ...P, folioId: kofi.folioId }, body: yen }), 409);
    await api(st.receptionist).openShift({ params: P, body: { floatMinor: 0 } });
    const cash = await api(st.receptionist).recordFxPayment({ params: { ...P, folioId: kofi.folioId }, body: yen });
    expect(cash.fx.localAmountMinor).toBe(88_000);
    const shift = (await api(st.receptionist).listShifts({ params: P, query: { status: "open" } })).shifts[0]!;
    expect(shift.takings.cash).toBe(88_000);
    await X.closeShifts();
    const rows = await X.S.sql("SELECT currency, foreign_minor, rate_micro FROM hotel_fx_payments ORDER BY currency");
    expect(rows).toEqual([
      { currency: "JPY", foreign_minor: 1_000, rate_micro: 880_000 },
      { currency: "USD", foreign_minor: 985, rate_micro: 129_500_000 },
    ]);
  });

  it("comps and discounts: a share of the charge and its taxes is credited, someone else approves, the audit lists them", async () => {
    const { st, P } = X;
    const f = await api(st.receptionist).postCharge({
      params: { ...P, folioId: kofi.folioId },
      body: { department: "fnb", description: "Wedding cake", amountMinor: 200_000 },
    });
    const cake = f.lines.at(-1)!;
    expect(cake.totalMinor).toBe(255_200);
    const r4200 = await X.ledger("4200");
    const disc = await api(st.front_office_manager).postAllowance({
      params: { ...P, folioId: kofi.folioId, lineId: cake.id },
      body: { kind: "discount", amountMinor: 50_000, reason: "Cake arrived late" },
    });
    const d = disc.lines.at(-1)!;
    expect([d.kind, d.allowanceKind, d.netMinor, d.serviceChargeMinor, d.vatMinor, d.totalMinor]).toEqual([
      "allowance",
      "discount",
      -50_000,
      -5_000,
      -8_800,
      -63_800,
    ]);
    expect((await X.ledger("4200")) - r4200).toBe(50_000); // revenue debited by the discount
    // the person who gave it cannot approve it (and the database refuses it too)
    await refused(
      api(st.front_office_manager).approveAllowance({ params: { ...P, folioId: kofi.folioId, allowanceId: d.id } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(
      api(st.general_manager).approveAllowance({ params: { ...P, folioId: kofi.folioId, allowanceId: "nope" } }),
      404,
    );
    await expect(
      X.S.sql("UPDATE hotel_folio_lines SET allowance_approved_by = created_by WHERE id = $1", [d.id]),
    ).rejects.toThrow(/hotel_allowance_second_person/);
    // the rest of the charge is comped: exactly what is left of the net and of each tax
    const comp = await api(st.receptionist).postAllowance({
      params: { ...P, folioId: kofi.folioId, lineId: cake.id },
      body: { kind: "comp", reason: "Apology for the delay" },
    });
    expect(comp.lines.at(-1)!.totalMinor).toBe(-(255_200 - 63_800));
    await refused(
      api(st.receptionist).postAllowance({
        params: { ...P, folioId: kofi.folioId, lineId: cake.id },
        body: { kind: "comp", amountMinor: 1, reason: "One more time" },
      }),
      400,
    );
    await refused(
      api(st.receptionist).voidLine({
        params: { ...P, folioId: kofi.folioId, lineId: cake.id },
        body: { reason: "Undo it" },
      }),
      409,
    );
    // income auditors cannot give allowances; the general manager approves others' allowances
    await refused(
      api(st.income_auditor).postAllowance({
        params: { ...P, folioId: kofi.folioId, lineId: cake.id },
        body: { kind: "comp", reason: "Not my job" },
      }),
      403,
    );
    const approved = await api(st.general_manager).approveAllowance({
      params: { ...P, folioId: kofi.folioId, allowanceId: d.id },
    });
    expect(approved.lines.find((l) => l.id === d.id)!.allowanceApprovedBy).toBe(st.general_manager.userId);
    // the day closes; the income audit lists the approved discount and the comp still awaiting approval
    const run = await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    expect(run.report.reconciled).toBe(true);
    expect(run.report.revenue.fnb).toBe(-(await X.ledger("4200", "2026-10-11", "2026-10-11")));
    expect(run.report.revenue.fnb).toBe(100_000);
    const ia = await api(st.income_auditor).getIncomeAudit({ params: { ...P, date: "2026-10-11" } });
    expect(ia.findings.map((x) => [x.code, x.amountMinor])).toEqual([
      ["ALLOWANCE", 63_800],
      ["ALLOWANCE_WITHOUT_APPROVAL", 191_400],
    ]);
    expect(ia.occupancyCheck).toEqual({ occupied: 1, charged: 1 });
  });

  it("tax invoices: only for a settled folio, numbered in sequence, never edited; a credit note by someone else cancels one", async () => {
    const { st, P } = X;
    const lena = await X.inHouse("Lena Otieno", "102", { email: "lena@guest.test" });
    const charged = await api(st.receptionist).postCharge({
      params: { ...P, folioId: lena.folioId },
      body: { department: "other", description: "Laundry", amountMinor: 50_000 },
    });
    expect(charged.balanceMinor).toBe(58_000);
    await refused(api(st.receptionist).issueInvoice({ params: { ...P, folioId: lena.folioId }, body: {} }), 409);
    const paid = await api(st.receptionist).recordPayment({
      params: { ...P, folioId: lena.folioId },
      body: { method: "card", amountMinor: 58_000, reference: "CARD-LENA" },
    });
    lenaPaymentId = paid.lines.at(-1)!.id;
    const inv = await api(st.receptionist).issueInvoice({
      params: { ...P, folioId: lena.folioId },
      body: { buyer: { taxId: "P051234567X" } },
    });
    lenaInvoice = inv.id;
    expect(inv.number).toBe("HINV-000001");
    expect(inv.buyer).toEqual({ name: "Lena Otieno", taxId: "P051234567X", address: null, email: "lena@guest.test" });
    expect(inv.totals).toEqual({
      netMinor: 50_000,
      serviceChargeMinor: 0,
      vatMinor: 8_000,
      levyMinor: 0,
      totalMinor: 58_000,
    });
    expect(inv.settlements.map((x) => x.amountMinor)).toEqual([58_000]);
    expect(inv.einvoicing).toMatchObject({ connected: false, status: "Not connected — test adapter", reference: null });
    await refused(api(st.receptionist).issueInvoice({ params: { ...P, folioId: lena.folioId }, body: {} }), 409);
    await expect(X.S.sql("UPDATE hotel_invoices SET total_minor = 1 WHERE id = $1", [inv.id])).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(X.S.sql("DELETE FROM hotel_invoices WHERE id = $1", [inv.id])).rejects.toThrow(/cannot be deleted/);
    // the issuer cannot cancel their own invoice
    await refused(
      api(st.receptionist).creditNote({ params: { ...P, invoiceId: inv.id }, body: { reason: "Wrong buyer" } }),
      403,
    );
    const cn = await api(st.front_office_manager).creditNote({
      params: { ...P, invoiceId: inv.id },
      body: { reason: "Wrong buyer tax number" },
    });
    expect([cn.number, cn.kind, cn.creditsInvoiceId, cn.totals.totalMinor]).toEqual([
      "HCN-000001",
      "credit_note",
      inv.id,
      -58_000,
    ]);
    expect((await api(st.receptionist).getInvoice({ params: { ...P, invoiceId: inv.id } })).cancelledById).toBe(cn.id);
    const again = await api(st.receptionist).issueInvoice({
      params: { ...P, folioId: lena.folioId },
      body: { buyer: { taxId: "P051234567Y" } },
    });
    expect(again.number).toBe("HINV-000002");
    const all = await api(st.receptionist).listInvoices({ params: P, query: {} });
    expect(all.invoices.map((i) => i.number).sort()).toEqual(["HCN-000001", "HINV-000001", "HINV-000002"]);
    lenaInvoice = again.id;
    // e-invoicing waits for a certified adapter: nothing is submitted
    const sub = await api(st.receptionist).submitEInvoice({ params: { ...P, invoiceId: again.id } });
    expect(sub.einvoicing).toMatchObject({ connected: false, reference: null });
    expect(sub.einvoicing.status).toMatch(/Not submitted/);
  });

  it("invoice by e-mail is recorded in the PALTAS outbox, never sent", async () => {
    const { st, P } = X;
    const m = await api(st.receptionist).emailInvoice({ params: { ...P, invoiceId: lenaInvoice }, body: {} });
    expect([m.message.template, m.message.recipient, m.message.channel]).toEqual([
      "invoice",
      "lena@guest.test",
      "email",
    ]);
    expect(m.message.status).toMatch(/^Outbox: recorded/);
    const out = await X.S.sql(
      "SELECT status, to_address, source FROM notifications WHERE org_id = $1 AND subject LIKE 'Invoice HINV-000002%'",
      [X.orgId],
    );
    expect(out).toEqual([{ status: "recorded", to_address: "lena@guest.test", source: "hotel" }]);
  });

  it("a company invoice carries the company's tax number; overdue company accounts get collection actions", async () => {
    const { st, P, orgId } = X;
    const co = await api(st.credit_controller).createCorporateAccount({
      params: { orgId },
      body: {
        name: "Acme Freight",
        creditLimitMinor: 10_000_000,
        contactEmail: "ap@acme.test",
        taxId: "P000111222Z",
        billingAddress: "Moi Avenue, Mombasa",
        paymentTermsDays: 30,
      },
    });
    expect([co.taxId, co.paymentTermsDays]).toEqual(["P000111222Z", 30]);
    const r = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: { name: "Ann Acme", email: "ann@acme.test" },
        arrival: "2026-10-12",
        departure: "2026-10-13",
        rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
        corporateAccountId: co.id,
      },
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: X.H.rooms["104"]!.id },
    });
    const company = (
      await api(st.receptionist).listFolios({ params: P, query: { stayId: r.stays[0]!.id } })
    ).folios.find((f) => f.payer === "company")!;
    await api(st.receptionist).postCharge({
      params: { ...P, folioId: company.id },
      body: { department: "rooms", description: "Day room", amountMinor: 500_000 },
    });
    expect(ci.folio.payer).toBe("guest");
    const out = await api(st.receptionist).checkOut({ params: { ...P, stayId: r.stays[0]!.id } });
    expect(out.cityLedger.map((c) => c.amountMinor)).toEqual([590_000]);
    const inv = await api(st.receptionist).issueInvoice({ params: { ...P, folioId: company.id }, body: {} });
    expect([inv.corporateAccountId, inv.buyer.name, inv.buyer.taxId, inv.buyer.address]).toEqual([
      co.id,
      "Acme Freight",
      "P000111222Z",
      "Moi Avenue, Mombasa",
    ]);
    expect(inv.settlements.map((x) => x.amountMinor)).toEqual([590_000]);

    // collections: an invoice past the account's terms is overdue (its date is moved back to make it old)
    await X.S.sql("UPDATE hotel_city_ledger SET date = '2026-08-20' WHERE account_id = $1", [co.id]);
    {
      const due = await api(st.credit_controller).collectionsDue({ params: { orgId } });
      expect(due.accounts.map((a) => [a.name, a.overdueMinor])).toEqual([["Acme Freight", 590_000]]);
      await refused(
        api(st.credit_controller).recordCollection({
          params: { orgId, accountId: co.id },
          body: { kind: "promise", note: "Will pay soon" },
        }),
        400,
      );
      const sent = await api(st.credit_controller).recordCollection({
        params: { orgId, accountId: co.id },
        body: {
          kind: "statement_sent",
          note: "Statement for October",
          propertyId: P.propertyId,
          nextActionDate: "2026-12-08",
        },
      });
      expect(sent.messageId).not.toBeNull();
      const msg = await X.S.sql("SELECT recipient, template, status FROM hotel_messages WHERE id = $1", [
        sent.messageId,
      ]);
      expect(msg[0]).toMatchObject({ recipient: "ap@acme.test", template: "statement" });
      expect(msg[0].status).toMatch(/^Outbox: recorded/);
      await api(st.credit_controller).recordCollection({
        params: { orgId, accountId: co.id },
        body: { kind: "promise", note: "Promised by phone", promisedDate: "2026-12-15", promisedMinor: 590_000 },
      });
      const list = await api(st.credit_controller).listCollections({ params: { orgId, accountId: co.id } });
      expect(list.actions.map((a) => a.kind)).toEqual(["promise", "statement_sent"]);
      const again = await api(st.credit_controller).collectionsDue({ params: { orgId } });
      expect(again.accounts[0]!.lastAction!.kind).toBe("promise");
      await refused(api(st.receptionist).collectionsDue({ params: { orgId } }), 403);
    }
  });

  it("bank reconciliation: recorded payments matched to imported bank lines, card fees and chargebacks posted", async () => {
    const { st, P } = X;
    await refused(
      api(st.receptionist).importBankLines({
        params: P,
        body: { statementRef: "ST-1", lines: [{ date: "2026-10-12", amountMinor: 1, reference: "x" }] },
      }),
      403,
    );
    const imp = await api(st.accountant).importBankLines({
      params: P,
      body: {
        statementRef: "STMT-2026-10-12",
        lines: [
          { date: "2026-10-12", amountMinor: 58_000, reference: "card-lena", description: "Card settlement" },
          { date: "2026-10-12", amountMinor: 125_000, reference: "SETTLE-0412", description: "Card batch net of fees" },
          { date: "2026-10-13", amountMinor: -58_000, reference: "CB-77", description: "Chargeback" },
          { date: "2026-10-13", amountMinor: 127_558, reference: "UNKNOWN-9", description: "Unidentified credit" },
        ],
      },
    });
    expect(imp.autoMatched).toBe(1);
    expect(imp.lines[0]).toMatchObject({
      status: "matched",
      matches: [{ source: `line:${lenaPaymentId}`, amountMinor: 58_000 }],
    });
    await refused(
      api(st.accountant).importBankLines({
        params: P,
        body: { statementRef: "STMT-2026-10-12", lines: [{ date: "2026-10-12", amountMinor: 5, reference: "dup" }] },
      }),
      409,
    );
    const unmatched = await api(st.accountant).recordedPayments({
      params: P,
      query: { from: "2026-10-01", to: "2026-10-31", unmatchedOnly: "true" },
    });
    expect(unmatched.payments.map((p) => p.source)).toContain(`line:${fxLineId}`);
    // the payments less the fee must equal the line
    await refused(
      api(st.accountant).matchBankLine({
        params: { ...P, bankLineId: imp.lines[1]!.id },
        body: { sources: [`line:${fxLineId}`], feeMinor: 0 },
      }),
      400,
    );
    const fees = await X.ledger("5300");
    const m = await api(st.accountant).matchBankLine({
      params: { ...P, bankLineId: imp.lines[1]!.id },
      body: { sources: [`line:${fxLineId}`], feeMinor: 2_558 },
    });
    expect([m.status, m.feeMinor]).toEqual(["matched", 2_558]);
    expect((await X.ledger("5300")) - fees).toBe(2_558);
    // a payment is matched to the bank once
    await refused(
      api(st.accountant).matchBankLine({
        params: { ...P, bankLineId: imp.lines[3]!.id },
        body: { sources: [`line:${fxLineId}`] },
      }),
      409,
    );
    const ar = await X.ledger("1100");
    const cb = await api(st.accountant).recordChargeback({
      params: { ...P, bankLineId: imp.lines[2]!.id },
      body: { source: `line:${lenaPaymentId}`, reason: "Card holder disputes the laundry" },
    });
    expect(cb.status).toBe("chargeback");
    expect((await X.ledger("1100")) - ar).toBe(58_000);
    await refused(
      api(st.accountant).recordChargeback({
        params: { ...P, bankLineId: imp.lines[2]!.id },
        body: { source: `line:${lenaPaymentId}`, reason: "Twice is too many" },
      }),
      409,
    );
    const sum = await api(st.financial_controller).reconciliationSummary({
      params: P,
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect([sum.feesMinor, sum.chargebacksMinor, sum.unmatchedBankMinor]).toEqual([2_558, 58_000, 127_558]);
    expect(sum.byMethod.find((x) => x.method === "card")).toMatchObject({ matchedMinor: 58_000 + 127_558 });
    const cbs = await api(st.accountant).listBankLines({ params: P, query: { status: "chargeback" } });
    expect(cbs.lines.map((l) => l.id)).toEqual([imp.lines[2]!.id]);
    const matched = await api(st.accountant).listBankLines({ params: P, query: { status: "matched" } });
    expect(matched.lines.map((l) => l.id)).toContain(imp.lines[1]!.id);
  });

  it("another organisation's invoices and bank lines look like they do not exist", async () => {
    const other = await X.S.newOrg({ name: "Elsewhere Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    const p = await other.admin.api.hotel.createProperty({
      params: { orgId: other.orgId },
      body: { name: "Elsewhere Inn", country: "Kenya", city: "Nairobi", tax: { vatPct: 16 } },
    });
    await refused(
      other.admin.api.hotel.getInvoice({ params: { orgId: other.orgId, propertyId: p.id, invoiceId: lenaInvoice } }),
      404,
    );
    await refused(other.admin.api.hotel.getInvoice({ params: { ...X.P, invoiceId: lenaInvoice } }), 404);
    await refused(other.admin.api.hotel.listFxRates({ params: X.P, query: {} }), 404);
  });
});
