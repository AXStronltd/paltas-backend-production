// Security billing and payroll equal the ledger: invoices (contract fee, pro-rated fee, extra cover, one-off,
// late charge), recorded receipts, withholding certificates, bank-line matching, payroll inputs and approval,
// costs and remittances — each posted once to the ONE ledger, and every security report reading that ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOps,
  securityOrg,
  startSecurityServer,
  workOctober,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("security billing and payroll equal the ledger", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let ops: TestOps;
  let client2: string;
  let site2: string;
  const P = () => ({ orgId });
  const acc = () => st.accountant.api.security;
  const inv: Record<string, string> = {};

  beforeAll(async () => {
    S = await startSecurityServer();
    const o = await securityOrg(S, "Ulinzi Security");
    orgId = o.orgId;
    st = o.staff;
    ops = await buildOps(orgId, st);
    await workOctober(orgId, st, ops);
    const om = st.operations_manager.api.security;
    client2 = (
      await om.createClient({
        params: P(),
        body: { name: "Kilimani Heights MC", contactName: "Ruth Atieno", paymentTermsDays: 30 },
      })
    ).id;
    site2 = (
      await om.createSite({ params: P(), body: { clientId: client2, name: "Kilimani Heights", kind: "Apartments" } })
    ).id;
    await om.createContract({
      params: P(),
      body: { clientId: client2, siteId: site2, startDate: "2026-10-16", monthlyFeeMinor: 31_000_000, vatPct: 16 },
    });
    await om.updateSettings({ params: P(), body: { lateFeePct: 2 } });
  });
  afterAll(() => S.close());

  const journalLines = async (journalId: string) =>
    (
      await S.sql<{ account_code: string; debit_minor: number; credit_minor: number }>(
        "SELECT account_code, debit_minor, credit_minor FROM journal_lines WHERE entry_id = $1 ORDER BY account_code",
        [journalId],
      )
    ).map((l) => [l.account_code, l.debit_minor, l.credit_minor]);

  it("contract billing: monthly fee, pro-rated fee for a part month, approved extra cover — once per contract and month", async () => {
    const run = await acc().runBilling({ params: P(), body: { period: "2026-10" } });
    expect(run.invoices).toHaveLength(2);
    const a = run.invoices.find((i) => i.clientId === ops.clientId)!;
    const b = run.invoices.find((i) => i.clientId === client2)!;
    expect(a.lines).toEqual([
      {
        kind: "contract",
        description: "Guarding services, Westlands Office Park, 2026-10",
        quantity: 1,
        unit: "month",
        amountMinor: 118_000_000,
      },
      {
        kind: "extra_hours",
        description: expect.stringMatching(/1 shift/),
        quantity: 720,
        unit: "minutes",
        amountMinor: 540_000,
      },
    ]);
    expect(a).toMatchObject({
      netMinor: 118_540_000,
      vatMinor: 18_966_400,
      totalMinor: 137_506_400,
      whtExpectedMinor: 3_556_200,
      vatWhtExpectedMinor: 2_370_800,
      date: "2026-10-11",
      dueDate: "2026-11-10",
      state: "open",
      taxAuthority: "Not submitted — no tax-authority connection (test adapter)",
    });
    expect(await journalLines(a.journalId)).toEqual([
      ["1100", 137_506_400, 0],
      ["2100", 0, 18_966_400],
      ["4810", 0, 118_000_000],
      ["4820", 0, 540_000],
    ]);
    // 16 of 31 days of 310,000.00
    expect(b.lines[0]).toMatchObject({ description: expect.stringMatching(/16 of 31 days/), amountMinor: 16_000_000 });
    expect(b).toMatchObject({ vatMinor: 2_560_000, totalMinor: 18_560_000, whtExpectedMinor: 0 });
    inv.contract = a.id;
    inv.part = b.id;
    // running the month again bills nothing twice
    const again = await acc().runBilling({ params: P(), body: { period: "2026-10" } });
    expect(again.invoices).toEqual([]);
    expect(again.skipped).toHaveLength(2);
    const billed = await S.sql(
      "SELECT count(*)::int AS n FROM sec_shifts WHERE org_id = $1 AND billed_invoice_id = $2",
      [orgId, a.id],
    );
    expect(billed[0].n).toBe(1);
  });

  it("receipts are recorded (never processed), certificates settle the withheld tax", async () => {
    const r = await acc().recordReceipt({
      params: P(),
      body: {
        clientId: ops.clientId,
        date: "2026-10-11",
        method: "bank_transfer",
        reference: "RTGS260001",
        allocations: [{ invoiceId: inv.contract!, amountMinor: 131_579_400 }],
      },
    });
    expect(await journalLines(r.journalId)).toEqual([
      ["1000", 131_579_400, 0],
      ["1100", 0, 131_579_400],
    ]);
    await refused(
      acc().recordReceipt({
        params: P(),
        body: {
          clientId: ops.clientId,
          date: "2026-10-11",
          method: "cheque",
          reference: "rtgs260001",
          allocations: [{ invoiceId: inv.contract!, amountMinor: 1 }],
        },
      }),
      409,
    );
    await refused(
      acc().recordReceipt({
        params: P(),
        body: {
          clientId: ops.clientId,
          date: "2026-10-11",
          method: "cheque",
          reference: "CHQ-1",
          allocations: [{ invoiceId: inv.contract!, amountMinor: 5_927_001 }],
        },
      }),
      409,
    );
    await refused(
      acc().recordReceipt({
        params: P(),
        body: {
          clientId: client2,
          date: "2026-10-11",
          method: "cheque",
          reference: "CHQ-2",
          allocations: [{ invoiceId: inv.contract!, amountMinor: 1 }],
        },
      }),
      400,
    );
    await acc().recordCertificate({
      params: { orgId, invoiceId: inv.contract! },
      body: { kind: "income_tax", certificateRef: "WHT-77812", date: "2026-10-11" },
    });
    const paid = await acc().recordCertificate({
      params: { orgId, invoiceId: inv.contract! },
      body: { kind: "vat", certificateRef: "VWH-1203", date: "2026-10-11" },
    });
    expect(paid).toMatchObject({ paidMinor: 131_579_400, certifiedMinor: 5_927_000, balanceMinor: 0, state: "paid" });
    await refused(
      acc().recordCertificate({
        params: { orgId, invoiceId: inv.contract! },
        body: { kind: "vat", certificateRef: "VWH-1203", date: "2026-10-11" },
      }),
      409,
    );
    await refused(
      acc().recordCertificate({
        params: { orgId, invoiceId: inv.part! },
        body: { kind: "income_tax", certificateRef: "X-1", date: "2026-10-11" },
      }),
      400,
    );
  });

  it("one-off invoices and bank lines: suggested on the expected cash, confirmed into a receipt, repeats ignored", async () => {
    const one = await acc().createInvoice({
      params: P(),
      body: {
        clientId: ops.clientId,
        siteId: ops.siteId,
        vatPct: 16,
        lines: [{ description: "Event cover guards", quantity: 2, unitMinor: 1_000_000 }],
      },
    });
    expect(one).toMatchObject({
      netMinor: 2_000_000,
      totalMinor: 2_320_000,
      whtExpectedMinor: 60_000,
      vatWhtExpectedMinor: 40_000,
    });
    inv.oneOff = one.id;
    const lines = [
      {
        date: "2026-10-11",
        description: "EFT IN WESTGATE PROPERTIES",
        reference: "EFT-0091187",
        amountMinor: 2_220_000,
      },
      { date: "2026-10-11", description: "MPESA CHARGES", reference: "MPC-OCT", amountMinor: -64_000 },
    ];
    const imp = await acc().importBankLines({ params: P(), body: { lines } });
    expect(imp).toMatchObject({ added: 2, suggested: 1 });
    expect(imp.lines[0]).toMatchObject({ status: "suggested", suggestedInvoiceId: one.id });
    expect((await acc().importBankLines({ params: P(), body: { lines } })).added).toBe(0);
    await refused(
      acc().matchBankLine({
        params: { orgId, lineId: imp.lines[1]!.id },
        body: { invoiceId: one.id, method: "mobile_money" },
      }),
      400,
    );
    const m = await acc().matchBankLine({
      params: { orgId, lineId: imp.lines[0]!.id },
      body: { invoiceId: one.id, method: "bank_transfer" },
    });
    expect(m.line).toMatchObject({ status: "matched", receiptId: m.receipt.id });
    expect(m.receipt).toMatchObject({ amountMinor: 2_220_000, reference: "EFT-0091187", date: "2026-10-11" });
    await refused(
      acc().matchBankLine({
        params: { orgId, lineId: imp.lines[0]!.id },
        body: { invoiceId: one.id, method: "bank_transfer" },
      }),
      409,
    );
    const listed = (await acc().listInvoices({ params: P(), query: { open: "true" } })).invoices.map((i) => [
      i.number,
      i.balanceMinor,
      i.state,
    ]);
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual([one.number, 100_000, "part_paid"]);
  });

  it("late-payment charge: the configured rate on the overdue balance, once a day", async () => {
    S.setToday("2026-12-15");
    try {
      const fee = await acc().billLateFee({ params: { orgId, clientId: ops.clientId }, body: { vatPct: 16 } });
      expect(fee.lines).toEqual([expect.objectContaining({ kind: "late_fee", amountMinor: 2_000 })]);
      expect(fee).toMatchObject({ vatMinor: 320, totalMinor: 2_320, date: "2026-12-15" });
      await refused(acc().billLateFee({ params: { orgId, clientId: ops.clientId }, body: { vatPct: 16 } }), 409);
      // collections activity: a promise needs its date; a reminder is recorded, never sent
      const notes = { orgId, clientId: ops.clientId };
      await refused(acc().addClientNote({ params: notes, body: { kind: "promise", text: "Will pay next week" } }), 400);
      await acc().addClientNote({
        params: notes,
        body: { kind: "promise", text: "RTGS promised", promiseDate: "2026-12-20" },
      });
      const reminder = await acc().addClientNote({
        params: notes,
        body: { kind: "reminder", text: "Invoice overdue" },
      });
      expect(reminder.delivery).toBe("Recorded — not sent (no messaging provider connected)");
      const listedNotes = await acc().listClientNotes({ params: notes });
      expect(listedNotes.notes.map((n) => [n.kind, n.promiseDate])).toEqual(
        expect.arrayContaining([
          ["promise", "2026-12-20"],
          ["reminder", null],
        ]),
      );
      const ageing = await acc().ageing({ params: P() });
      expect(ageing.rows.find((r) => r.clientId === client2)).toMatchObject({ d31to60Minor: 18_560_000 });
    } finally {
      S.setToday("2026-10-11");
    }
  });

  it("payroll: prepared from approved timesheets and configured rules, approved by someone else, posted once", async () => {
    const run = await acc().preparePayroll({ params: P(), body: { period: "2026-10" } });
    const a = run.lines.find((l) => l.guardId === ops.guards.A)!;
    const b = run.lines.find((l) => l.guardId === ops.guards.B)!;
    expect(a).toMatchObject({
      normalMinutes: 1410,
      overtimeMinutes: 35,
      grossMinor: 243_750,
      deductions: [
        { code: "PEN", amountMinor: 14_625 },
        { code: "HLT", amountMinor: 30_000 },
      ],
      incomeTaxMinor: 25_281,
      employer: [{ code: "PEN", amountMinor: 14_625 }],
      netMinor: 173_844,
    });
    expect(b).toMatchObject({ grossMinor: 240_000, incomeTaxMinor: 24_400, netMinor: 171_200 });
    expect(run).toMatchObject({
      status: "prepared",
      grossMinor: 483_750,
      employeeDeductionsMinor: 89_025,
      incomeTaxMinor: 49_681,
      employerContributionsMinor: 29_025,
      netMinor: 345_044,
      journalId: null,
      siteCosts: [{ siteId: ops.siteId, grossMinor: 483_750, employerMinor: 29_025 }],
    });
    expect(run.payout).toMatch(/Not paid out/);
    await refused(acc().preparePayroll({ params: P(), body: { period: "2026-10" } }), 409);
    await refused(acc().approvePayroll({ params: { orgId, period: "2026-10" } }), 403, "ROLE_NOT_ALLOWED");
    const ok = await st.finance_director.api.security.approvePayroll({ params: { orgId, period: "2026-10" } });
    expect(await journalLines(ok.journalId!)).toEqual([
      ["2810", 0, 49_681],
      ["2820", 0, 118_050],
      ["2830", 0, 345_044],
      ["5810", 483_750, 0],
      ["5820", 29_025, 0],
    ]);
    const paid = await acc().recordPayrollPayment({
      params: { orgId, period: "2026-10" },
      body: { date: "2026-10-28", reference: "BULK-OCT" },
    });
    expect(paid).toMatchObject({ status: "paid", paidOn: "2026-10-28" });
    await refused(
      acc().recordPayrollPayment({
        params: { orgId, period: "2026-10" },
        body: { date: "2026-10-28", reference: "BULK-OCT" },
      }),
      409,
    );
  });

  it("costs and remittances post to the ledger; a remittance cannot exceed what is owed", async () => {
    await acc().postCost({
      params: P(),
      body: {
        account: "5850",
        siteId: ops.siteId,
        date: "2026-10-11",
        description: "Fuel for response vehicle RV-2",
        amountMinor: 2_200_000,
        paidFrom: "bank",
      },
    });
    await acc().postCost({
      params: P(),
      body: {
        account: "5870",
        date: "2026-10-11",
        description: "M-Pesa charges October",
        amountMinor: 64_000,
        paidFrom: "bank",
      },
    });
    await acc().recordRemittance({
      params: P(),
      body: { account: "2810", date: "2026-11-09", amountMinor: 49_681, reference: "PRN-2026110001" },
    });
    await refused(
      acc().recordRemittance({
        params: P(),
        body: { account: "2810", date: "2026-11-09", amountMinor: 1, reference: "PRN-2" },
      }),
      409,
    );
  });

  it("KPIs, ageing, statement and site profit equal the ledger's trial balance", async () => {
    const tb = await st.accountant.api.ledger.trialBalance({ params: P(), query: { asOf: "2026-12-31" } });
    expect(tb.balanced).toBe(true);
    const bal = (code: string) => {
      const r = tb.rows.find((x) => x.code === code);
      return r ? r.debitMinor - r.creditMinor : 0;
    };
    const k = await acc().financeKpis({ params: P(), query: { from: "2026-10-01", to: "2026-12-31" } });
    expect(k).toMatchObject({
      contractRevenueMinor: 134_000_000,
      extraCoverRevenueMinor: 540_000,
      lateFeeRevenueMinor: 2_000,
      otherRevenueMinor: 2_000_000,
      revenueMinor: 136_542_000,
      wagesMinor: 483_750,
      employerContributionsMinor: 29_025,
      directCostsMinor: 2_264_000,
      grossProfitMinor: 133_765_225,
      vatChargedMinor: 21_846_720,
      cashReceivedMinor: 133_799_400,
      receivablesMinor: 18_662_320,
    });
    expect(k.contractRevenueMinor).toBe(-bal("4810"));
    expect(k.extraCoverRevenueMinor).toBe(-bal("4820"));
    expect(k.lateFeeRevenueMinor).toBe(-bal("4830"));
    expect(k.otherRevenueMinor).toBe(-bal("4840"));
    expect(k.wagesMinor).toBe(bal("5810"));
    expect(k.employerContributionsMinor).toBe(bal("5820"));
    expect(k.directCostsMinor).toBe(bal("5850") + bal("5870"));
    expect(k.vatChargedMinor).toBe(-bal("2100"));
    expect(k.receivablesMinor).toBe(bal("1100"));
    expect(bal("1810")).toBe(3_556_200);
    expect(bal("1820")).toBe(2_370_800);
    expect(bal("2810")).toBe(0);
    expect(bal("2820")).toBe(-118_050);
    expect(bal("2830")).toBe(0);
    expect(bal("1000")).toBe(131_579_400 + 2_220_000 - 345_044 - 2_264_000 - 49_681);
    // invoices and receipts summed from the security records equal the ledger too
    const invoices = (await acc().listInvoices({ params: P(), query: {} })).invoices;
    expect(invoices.reduce((n, i) => n + i.balanceMinor, 0)).toBe(bal("1100"));
    const ageing = await acc().ageing({ params: P() });
    expect(ageing.totalMinor).toBe(bal("1100"));
    const stmt = await acc().clientStatement({ params: { orgId, clientId: ops.clientId } });
    expect(stmt.lines.map((l) => l.kind)).toEqual([
      "invoice",
      "invoice",
      "receipt",
      "receipt",
      "certificate",
      "certificate",
      "invoice",
    ]);
    expect(stmt.balanceMinor).toBe(102_320);
    expect(ageing.rows.find((r) => r.clientId === ops.clientId)!.totalMinor).toBe(102_320);
    // site profitability: the rows add up to the ledger totals
    const sp = await acc().siteProfit({ params: P(), query: { from: "2026-10-01", to: "2026-12-31" } });
    expect(sp.sites.map((s) => [s.name, s.revenueMinor, s.payrollCostMinor, s.directCostMinor])).toEqual([
      ["Kilimani Heights", 16_000_000, 0, 0],
      ["Westlands Office Park", 120_540_000, 512_775, 2_200_000],
      ["Not tied to a site", 2_000, 0, 64_000],
    ]);
    for (const f of ["revenueMinor", "payrollCostMinor", "directCostMinor", "profitMinor"] as const)
      expect(sp.sites.reduce((n, s) => n + s[f], 0)).toBe(sp.total[f]);
    expect(sp.total.profitMinor).toBe(k.grossProfitMinor);
    // every security journal is linked, posted once, from the security module
    const links = await S.sql("SELECT count(*)::int AS n FROM sec_ledger_links WHERE org_id = $1", [orgId]);
    const journals = await S.sql(
      "SELECT count(*)::int AS n FROM journal_entries WHERE org_id = $1 AND source = 'system:security'",
      [orgId],
    );
    expect(links[0].n).toBe(journals[0].n);
    expect(journals[0].n).toBe(13);
  });
});
