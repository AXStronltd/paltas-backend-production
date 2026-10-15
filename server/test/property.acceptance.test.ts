// Property Management, end to end on the real server and PostgreSQL: onboard a property → units → owner and agreement
// → tenant → lease → invoice runs (idempotent) → partial payment → arrears → late fee → overpayment and credit →
// period close respected → owner bill → move-out → deposit settlement with a second person → owner statement equal to
// the ledger → owner payout (prepare / approve / release) → bank reconciliation signed off by a second person.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newTenant,
  pmOrg,
  setUpBuilding,
  startPropertyServer,
  tbBalance,
  type Building,
  type PmStaff,
} from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("Property Management acceptance: from onboarding to an owner statement equal to the ledger", () => {
  let S: TestServer;
  let orgId: string;
  let st: PmStaff;
  let pm: Person;
  let acct: Person;
  let fd: Person;
  let B: Building;
  let tenantId: string;
  let leaseId: string;
  let depositInvoiceId: string;
  let rentSep: string;
  let chargesSep: string;
  let svcId: string;
  let waterId: string;
  const O = () => ({ orgId });

  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-09-01");
    const o = await pmOrg(S, { name: "Almas Tower Management" });
    orgId = o.orgId;
    st = o.staff;
    pm = st.property_manager;
    acct = st.accountant;
    fd = st.finance_director;
  });
  afterAll(() => S.close());

  it("onboards the property: units, owner, agreement, PM accounts in the chart, charge types", async () => {
    B = await setUpBuilding(orgId, pm, { owner: { name: "Peter Mwangi", email: "peter.mwangi@example.com" } });
    const file = await pm.api.property.getProperty({ params: { orgId, propertyId: B.propertyId } });
    expect(file.units.map((u) => [u.unitNo, u.occupancy, u.ownerId])).toEqual([
      ["A-101", "vacant", B.ownerId],
      ["A-102", "vacant", B.ownerId],
      ["A-103", "vacant", B.ownerId],
    ]);
    expect(file.agreements[0]).toMatchObject({ feePct: 10, authorityMinor: 2_000_000, ownerName: "Peter Mwangi" });
    const { accounts } = await acct.api.ledger.listAccounts({ params: O() });
    for (const code of ["1040", "1120", "2150", "2160", "2170", "2250", "2300", "2310", "3900", "4650", "4660", "5650"])
      expect(accounts.find((a) => a.code === code)?.system, code).toBe(true);
    svcId = (
      await pm.api.property.createChargeType({
        params: O(),
        body: { code: "SVC", name: "Service charge", payee: "owner", feeApplies: true },
      })
    ).id;
    waterId = (
      await pm.api.property.createChargeType({
        params: O(),
        body: {
          code: "WATER",
          name: "Water (metered)",
          payee: "owner",
          metered: true,
          unitName: "m³",
          rateMinor: 15_000,
        },
      })
    ).id;
    // finance verifies the owner's bank details (the property manager cannot)
    await refused(
      pm.api.property.updateOwnerProfile({
        params: { orgId, ownerId: B.ownerId },
        body: { bankAccountMasked: "••7302" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const prof = await fd.api.property.updateOwnerProfile({
      params: { orgId, ownerId: B.ownerId },
      body: { bankAccountMasked: "••7302", verifyBank: true },
    });
    expect(prof).toMatchObject({ bankVerified: true, fundsMinor: 0 });
  });

  it("drafts and activates a lease: rent steps, deposit invoiced and posted (Dr 1120 / Cr 2160)", async () => {
    tenantId = await newTenant(pm, orgId, "John Kamau", "0712 401 214");
    const draft = await pm.api.property.createLease({
      params: O(),
      body: {
        unitId: B.units["A-101"]!,
        tenantId,
        startDate: "2026-09-01",
        endDate: "2027-08-31",
        rentMinor: 6_500_000,
        depositMinor: 13_000_000,
        dueDay: 5,
        escalationPct: 5,
        escalationMonths: 12,
        charges: [
          { chargeTypeId: svcId, amountMinor: 500_000 },
          { chargeTypeId: waterId, amountMinor: null },
        ],
      },
    });
    leaseId = draft.id;
    expect(draft.status).toBe("draft");
    const { lease, depositInvoice } = await pm.api.property.activateLease({
      params: { orgId, leaseId },
      body: { signedOn: "2026-08-28" },
    });
    expect(lease.status).toBe("active");
    // a 12-month lease: no escalation inside the term
    expect(lease.rentSteps).toEqual([{ effectiveFrom: "2026-09-01", rentMinor: 6_500_000, reason: "start" }]);
    expect(depositInvoice).toMatchObject({ kind: "deposit", amountMinor: 13_000_000, balanceMinor: 13_000_000 });
    depositInvoiceId = depositInvoice!.id;
    // the same unit cannot be let twice for overlapping dates
    const other = await newTenant(pm, orgId, "Ruth Njeri");
    const clash = await pm.api.property.createLease({
      params: O(),
      body: { unitId: B.units["A-101"]!, tenantId: other, startDate: "2027-01-01", rentMinor: 6_000_000 },
    });
    await refused(
      pm.api.property.activateLease({ params: { orgId, leaseId: clash.id }, body: { signedOn: "2026-09-01" } }),
      409,
    );
    await pm.api.property.cancelLease({ params: { orgId, leaseId: clash.id }, body: { reason: "Unit already let" } });
    expect(await tbBalance(acct, orgId, "1120")).toBe(13_000_000);
    expect(await tbBalance(acct, orgId, "2160")).toBe(-13_000_000);
  });

  it("records the deposit payment (never processed): receipt number, Dr 1040 / Cr 1120, then Dr 2160 / Cr 2300", async () => {
    const p = await acct.api.property.recordPayment({
      params: O(),
      body: {
        tenantId,
        date: "2026-09-01",
        amountMinor: 13_000_000,
        method: "bank_transfer",
        reference: "EQB-DEP-A101",
        allocations: [{ invoiceId: depositInvoiceId, amountMinor: 13_000_000 }],
      },
    });
    expect(p).toMatchObject({ receiptNumber: "RCT-000001", allocatedMinor: 13_000_000, unallocatedMinor: 0 });
    expect(await tbBalance(acct, orgId, "2300")).toBe(-13_000_000);
    expect(await tbBalance(acct, orgId, "1040")).toBe(13_000_000);
    // the same bank reference cannot be recorded twice
    await refused(
      acct.api.property.recordPayment({
        params: O(),
        body: { tenantId, date: "2026-09-01", amountMinor: 100, method: "bank_transfer", reference: "eqb-dep-a101" },
      }),
      409,
    );
  });

  it("runs September's rent and charges; running again creates nothing; a missing meter reading refuses the charges run", async () => {
    const rent = await pm.api.property.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-09", kind: "rent" },
    });
    expect(rent.created.map((i) => [i.kind, i.amountMinor, i.dueDate])).toEqual([["rent", 6_500_000, "2026-09-05"]]);
    rentSep = rent.created[0]!.id;
    const again = await pm.api.property.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-09", kind: "rent" },
    });
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([{ leaseId, reason: "Already billed for 2026-09" }]);
    await refused(
      pm.api.property.runBilling({
        params: O(),
        body: { propertyId: B.propertyId, period: "2026-09", kind: "charges" },
      }),
      409,
    );
    await pm.api.property.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-09",
        readings: [{ unitId: B.units["A-101"]!, chargeTypeId: waterId, previous: 100, current: 112 }],
      },
    });
    const charges = await pm.api.property.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-09", kind: "charges" },
    });
    expect(charges.created[0]!.lines.map((l) => [l.code, l.amountMinor])).toEqual([
      ["SVC", 500_000],
      ["WATER", 180_000],
    ]);
    chargesSep = charges.created[0]!.id;
    expect(
      (
        await pm.api.property.runBilling({
          params: O(),
          body: { propertyId: B.propertyId, period: "2026-09", kind: "charges" },
        })
      ).created,
    ).toEqual([]);
    // rent is the owner's money: billed to 2150, never to income
    expect(await tbBalance(acct, orgId, "2150")).toBe(-(6_500_000 + 680_000));
    expect(await tbBalance(acct, orgId, "4650")).toBe(0);
  });

  it("allocates a part payment oldest first; the owner is credited and the management fee taken", async () => {
    S.setToday("2026-09-10");
    const p = await acct.api.property.recordPayment({
      params: O(),
      body: { tenantId, date: "2026-09-10", amountMinor: 4_000_000, method: "mobile_money", reference: "QX7B1NZ" },
    });
    expect(p.allocations.map((a) => [a.invoiceId, a.amountMinor])).toEqual([[rentSep, 4_000_000]]);
    expect(p.receiptNumber).toBe("RCT-000002");
    expect(await tbBalance(acct, orgId, "2250")).toBe(-(4_000_000 - 400_000));
    expect(await tbBalance(acct, orgId, "4650")).toBe(-400_000);
  });

  it("shows arrears by age equal to the ledger, then charges one late fee per overdue rent invoice", async () => {
    S.setToday("2026-09-20");
    const aged = await acct.api.property.agedReceivables({ params: O() });
    expect(aged.rows).toEqual([
      expect.objectContaining({ tenantId, d1to30Minor: 2_500_000 + 680_000, totalMinor: 3_180_000, creditMinor: 0 }),
    ]);
    expect(aged.ledger).toEqual({ recordsMinor: 3_180_000, ledgerMinor: 3_180_000, agrees: true });
    const fees = await acct.api.property.runLateFees({ params: O(), body: {} });
    // 5 % of the 2,500,000 overdue rent (more than the 50,000 minimum); charges invoices carry no late fee
    expect(fees.created.map((i) => [i.kind, i.amountMinor, i.sourceInvoiceId])).toEqual([
      ["late_fee", 125_000, rentSep],
    ]);
    expect((await acct.api.property.runLateFees({ params: O(), body: {} })).created).toEqual([]);
    expect(fees.created.some((i) => i.sourceInvoiceId === chargesSep)).toBe(false);
    const dash = await pm.api.property.dashboard({ params: O(), query: { month: "2026-09" } });
    expect(dash.arrears).toMatchObject({ totalMinor: 3_305_000, overdueMinor: 3_180_000, tenantsInArrears: 1 });
    expect(dash.occupancy).toMatchObject({ units: 3, let: 1, vacant: 2 });
    expect(Object.values(dash.ledger).every((c) => c.agrees)).toBe(true);
  });

  it("an overpayment clears every open invoice and leaves the rest as the tenant's credit (2310), applied next month", async () => {
    S.setToday("2026-09-25");
    const p = await acct.api.property.recordPayment({
      params: O(),
      body: { tenantId, date: "2026-09-25", amountMinor: 5_000_000, method: "bank_transfer", reference: "EQB-77120" },
    });
    expect(p.allocatedMinor).toBe(3_305_000);
    expect(p.unallocatedMinor).toBe(1_695_000);
    expect(await tbBalance(acct, orgId, "2310")).toBe(-1_695_000);
    S.setToday("2026-10-01");
    const oct = await pm.api.property.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-10", kind: "rent" },
    });
    const applied = await acct.api.property.applyCredit({ params: { orgId, tenantId } });
    expect(applied.allocations.map((a) => [a.invoiceId, a.amountMinor])).toEqual([[oct.created[0]!.id, 1_695_000]]);
    expect(applied.creditLeftMinor).toBe(0);
    expect(await tbBalance(acct, orgId, "2310")).toBe(0);
    const stmt = await pm.api.property.tenantStatement({ params: { orgId, tenantId } });
    expect(stmt).toMatchObject({ balanceMinor: 4_805_000, creditMinor: 0, depositHeldMinor: 13_000_000 });
  });

  it("respects the closed month: nothing more posts into September", async () => {
    await fd.api.ledger.closePeriod({
      params: { orgId, month: "2026-09" },
      body: { reason: "September books closed" },
    });
    await refused(
      acct.api.property.recordPayment({
        params: O(),
        body: { tenantId, date: "2026-09-30", amountMinor: 1_000, method: "cash", reference: "LATE-CASH-1" },
      }),
      409,
      "PERIOD_CLOSED",
    );
    // a rent run for a closed month either finds it billed or is refused
    const r = await pm.api.property.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-09", kind: "rent" },
    });
    expect(r.created).toEqual([]);
  });

  it("charges an owner's repair bill: entered, approved by someone else (Dr 2250 / Cr 2000), paid by a third person", async () => {
    const plumber = await pm.api.contacts.createContact({
      params: O(),
      body: {
        name: "Maji Plumbers",
        email: "jobs@majiplumbers.example.com",
        types: ["supplier"],
        taxId: "P051112223B",
      },
    });
    const bill = await pm.api.property.submitBill({
      params: O(),
      body: {
        supplierId: plumber.contact.id,
        unitId: B.units["A-101"]!,
        description: "Kitchen tap replaced",
        supplierInvoiceNo: "MP-1001",
        billDate: "2026-10-01",
        amountMinor: 1_500_000,
        recoverFrom: "owner",
      },
    });
    expect(bill.status).toBe("submitted");
    await refused(pm.api.property.approveBill({ params: { orgId, billId: bill.id } }), 403, "SEPARATION_OF_DUTIES");
    const approved = await acct.api.property.approveBill({ params: { orgId, billId: bill.id } });
    expect(approved.status).toBe("approved");
    await refused(
      acct.api.property.payBill({
        params: { orgId, billId: bill.id },
        body: { paidDate: "2026-10-01", reference: "EQB-OUT-1" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const paid = await fd.api.property.payBill({
      params: { orgId, billId: bill.id },
      body: { paidDate: "2026-10-01", reference: "EQB-OUT-1" },
    });
    expect(paid.status).toBe("paid");
  });

  it("ends the lease at move-out and settles the deposit: arrears applied, deduction to the owner, refund — approved by a second person", async () => {
    await pm.api.property.giveNotice({
      params: { orgId, leaseId },
      body: { noticeDate: "2026-10-01", moveOutDate: "2026-10-31" },
    });
    S.setToday("2026-10-31");
    await refused(
      fd.api.property.requestDepositRefund({
        params: { orgId, leaseId },
        body: { deductions: [], refundReference: "RF-1" },
      }),
      409,
    ); // the lease has not ended yet
    const ended = await pm.api.property.terminateLease({
      params: { orgId, leaseId },
      body: { moveOutDate: "2026-10-31", reason: "Tenant moved out at the end of the notice" },
    });
    expect(ended.status).toBe("ended");
    const req = await fd.api.property.requestDepositRefund({
      params: { orgId, leaseId },
      body: {
        applyToArrears: true,
        deductions: [{ amountMinor: 1_000_000, reason: "Repaint the living room" }],
        refundReference: "EQB-RF-A101",
      },
    });
    expect(req).toMatchObject({
      heldMinor: 13_000_000,
      arrearsMinor: 4_805_000,
      deductionsMinor: 1_000_000,
      refundMinor: 7_195_000,
      status: "requested",
    });
    // the person who asked cannot approve it; a property manager cannot approve deposits at all
    await refused(
      fd.api.property.approveDepositRefund({ params: { orgId, refundId: req.id } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(
      pm.api.property.approveDepositRefund({ params: { orgId, refundId: req.id } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const ok = await acct.api.property.approveDepositRefund({ params: { orgId, refundId: req.id } });
    expect(ok.status).toBe("approved");
    expect(await tbBalance(acct, orgId, "2300")).toBe(0);
    expect(await tbBalance(acct, orgId, "1120")).toBe(0);
    const stmt = await pm.api.property.tenantStatement({ params: { orgId, tenantId } });
    expect(stmt).toMatchObject({ balanceMinor: 0, depositHeldMinor: 0 });
  });

  it("the owner statement equals the ledger: collected − fees − expenses + deductions", async () => {
    const s = await acct.api.property.ownerStatement({
      params: { orgId, ownerId: B.ownerId },
      query: { from: "2026-09-01", to: "2026-10-31" },
    });
    expect(s).toMatchObject({
      openingMinor: 0,
      collectedMinor: 13_805_000, // rent 13,000,000 + service 500,000 + water 180,000 + late fee 125,000
      managementFeesMinor: 1_350_000, // 10 % of rent and service charge collected
      vatOnFeesMinor: 0,
      expensesMinor: 1_500_000,
      depositDeductionsMinor: 1_000_000,
      payoutsMinor: 0,
      closingMinor: 11_955_000,
      ledgerClosingMinor: 11_955_000,
      agrees: true,
    });
    expect(await tbBalance(acct, orgId, "2250")).toBe(-11_955_000);
    expect(await tbBalance(acct, orgId, "4650")).toBe(-1_350_000);
    // September alone, then October from September's closing
    const sep = await acct.api.property.ownerStatement({
      params: { orgId, ownerId: B.ownerId },
      query: { from: "2026-09-01", to: "2026-09-30" },
    });
    const oct = await acct.api.property.ownerStatement({
      params: { orgId, ownerId: B.ownerId },
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(oct.openingMinor).toBe(sep.closingMinor);
    expect(sep.agrees && oct.agrees).toBe(true);
  });

  it("pays the owner out: prepared, approved by a second person, released by someone other than the approver", async () => {
    const po = await acct.api.property.preparePayout({ params: O(), body: { ownerId: B.ownerId } });
    expect(po).toMatchObject({ amountMinor: 11_955_000, status: "prepared" });
    await refused(acct.api.property.approvePayout({ params: { orgId, payoutId: po.id } }), 403, "SEPARATION_OF_DUTIES");
    await refused(acct.api.property.preparePayout({ params: O(), body: { ownerId: B.ownerId } }), 409); // one at a time
    await fd.api.property.approvePayout({ params: { orgId, payoutId: po.id } });
    await refused(fd.api.property.releasePayout({ params: { orgId, payoutId: po.id } }), 403, "SEPARATION_OF_DUTIES");
    const rel = await acct.api.property.releasePayout({ params: { orgId, payoutId: po.id } });
    expect(rel.status).toBe("released");
    expect(await tbBalance(acct, orgId, "2250")).toBe(0);
    const cm = await acct.api.property.clientMoney({ params: O() });
    // what stays in the client account is the agency's fees (not yet swept), and it covers everything owed
    expect(cm).toMatchObject({
      clientCashMinor: 1_350_000,
      ownerFundsMinor: 0,
      depositsHeldMinor: 0,
      surplusMinor: 1_350_000,
    });
    expect(cm.covered && cm.ownersAgree).toBe(true);
  });

  it("reconciles the client account with the statement: auto-match by reference, a second person signs off", async () => {
    const payout = (await acct.api.property.listPayouts({ params: O(), query: {} })).payouts[0]!;
    const imported = await acct.api.property.importBankLines({
      params: O(),
      body: {
        statement: "Equity Bank client account Sep–Oct 2026",
        lines: [
          { date: "2026-09-01", amountMinor: 13_000_000, reference: "EQB-DEP-A101", description: "J KAMAU DEPOSIT" },
          { date: "2026-09-10", amountMinor: 4_000_000, reference: "QX7B1NZ", description: "MPESA C2B" },
          { date: "2026-09-25", amountMinor: 5_000_000, reference: "EQB-77120", description: "J KAMAU" },
          { date: "2026-10-01", amountMinor: -1_500_000, reference: "EQB-OUT-1", description: "MAJI PLUMBERS" },
          { date: "2026-10-31", amountMinor: -7_195_000, reference: "EQB-RF-A101", description: "DEPOSIT REFUND" },
          { date: "2026-10-31", amountMinor: -11_955_000, reference: payout.number, description: "OWNER PAYOUT" },
        ],
      },
    });
    expect(imported).toMatchObject({ imported: 6, matched: 6, duplicates: 0 });
    expect((await acct.api.property.listPayouts({ params: O(), query: {} })).payouts[0]!.status).toBe("paid");
    const again = await acct.api.property.importBankLines({
      params: O(),
      body: {
        statement: "again",
        lines: [{ date: "2026-09-10", amountMinor: 4_000_000, reference: "QX7B1NZ", description: "" }],
      },
    });
    expect(again).toMatchObject({ imported: 0, duplicates: 1 });
    const rec = await acct.api.property.prepareReconciliation({
      params: O(),
      body: { statementDate: "2026-10-31", statementBalanceMinor: 1_350_000 },
    });
    expect(rec).toMatchObject({
      ledgerBalanceMinor: 1_350_000,
      unclearedInMinor: 0,
      unclearedOutMinor: 0,
      differenceMinor: 0,
    });
    await refused(
      acct.api.property.approveReconciliation({ params: { orgId, reconciliationId: rec.id } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect((await fd.api.property.approveReconciliation({ params: { orgId, reconciliationId: rec.id } })).status).toBe(
      "approved",
    );
  });

  it("leaves a balanced ledger and an audit trail", async () => {
    const tb = await fd.api.ledger.trialBalance({ params: O() });
    expect(tb.balanced).toBe(true);
    const journals = await S.sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM journal_entries WHERE org_id = $1 AND source = 'system:property' AND status = 'posted'",
      [orgId],
    );
    expect(journals[0]!.n).toBeGreaterThan(15);
    const unlinked = await S.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM journal_entries e WHERE e.org_id = $1 AND e.source = 'system:property'
         AND NOT EXISTS (SELECT 1 FROM pm_ledger_links k WHERE k.journal_id = e.id)`,
      [orgId],
    );
    expect(unlinked[0]!.n).toBe(0);
    const audit = await S.sql<{ action: string }>("SELECT action FROM audit_log WHERE org_id = $1", [orgId]);
    const actions = new Set(audit.map((a) => a.action));
    for (const a of [
      "Lease activated",
      "Payment recorded",
      "Late fees charged",
      "Deposit settlement approved",
      "Owner payout released",
      "Bank reconciliation signed off",
    ])
      expect(actions.has(a), a).toBe(true);
  });
});
