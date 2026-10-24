import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { kenyaMonthly } from "../dist/core/payroll/kenya.js";
import { startPropertyServer, pmOrg } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";
const input = {
  grossMinor: 10000000,
  pensionableMinor: 10000000,
  taxableBenefitsMinor: 0,
  resident: true,
  nitaLiable: false,
  nitaExemptionReason: "Reviewed test exemption basis",
  pensionMinor: 0,
  mortgageMinor: 0,
  medicalMinor: 0,
  insurancePremiumMinor: 0,
  otherDeductionsMinor: 0,
  otherEmployerMinor: 0,
};
describe("Kenya monthly payroll integer calculations", () => {
  it("calculates a reviewed KES100,000 salary with separate employer obligations", () => {
    const c = kenyaMonthly(input, "2026-10");
    expect(c).toMatchObject({
      nssfMinor: 600000,
      shifMinor: 275000,
      ahlMinor: 150000,
      taxableMinor: 8975000,
      payeMinor: 1930835,
      netMinor: 7044165,
      employerMinor: 750000,
      totalCostMinor: 10750000,
    });
  });
  it("caps NSSF, applies no personal relief to non-residents and enforces SHIF minimum", () => {
    expect(kenyaMonthly({ ...input, grossMinor: 12000000, pensionableMinor: 12000000 }, "2026-02").nssfMinor).toBe(
      648000,
    );
    expect(kenyaMonthly({ ...input, resident: false }, "2026-10").payeMinor).toBe(2170835);
    expect(kenyaMonthly({ ...input, grossMinor: 900000, pensionableMinor: 900000 }, "2026-10").shifMinor).toBe(30000);
  });
  it("caps documented pension/mortgage/insurance relief and rejects unsupported periods or negative net", () => {
    const c = kenyaMonthly(
      { ...input, pensionMinor: 3000000, mortgageMinor: 9000000, insurancePremiumMinor: 9000000 },
      "2026-10",
    );
    expect(c.insuranceReliefMinor).toBe(500000);
    expect(() => kenyaMonthly(input, "2027-02")).toThrow();
    expect(() => kenyaMonthly({ ...input, otherDeductionsMinor: 10000000 }, "2026-10")).toThrow();
    expect(() => kenyaMonthly({ ...input, grossMinor: NaN }, "2026-10")).toThrow();
  });
});
describe("property expenses and payroll share the audited ledger", () => {
  let S: TestServer, X: Awaited<ReturnType<typeof pmOrg>>, employeeId: string, runId: string;
  beforeAll(async () => {
    S = await startPropertyServer();
    X = await pmOrg(S);
  });
  afterAll(async () => {
    if (S) await S.close();
  });
  const O = () => ({ orgId: X.orgId });
  it("allows repeated employee edits, archiving and restoration with stale-write protection", async () => {
    const a = X.admin.api.property;
    let e = await a.savePayrollEmployee({
      params: { ...O(), employeeId: "new" },
      body: {
        code: "E01",
        name: "Payroll Test Employee",
        email: null,
        grossMinor: 10000000,
        active: true,
        expectedVersion: 0,
      },
    });
    employeeId = e.id;
    for (const active of [false, true])
      e = await a.savePayrollEmployee({
        params: { ...O(), employeeId: e.id },
        body: { ...e, active, expectedVersion: e.version },
      });
    expect(e.version).toBe(3);
    await expect(
      a.savePayrollEmployee({ params: { ...O(), employeeId: e.id }, body: { ...e, expectedVersion: 1 } }),
    ).rejects.toBeTruthy();
    await expect(X.staff.viewer.api.property.payrollEmployees({ params: O() })).rejects.toBeTruthy();
  });
  it("persists an editable payroll draft without posting and rejects duplicate periods", async () => {
    const a = X.admin.api.property;
    let r = await a.preparePayroll({
      params: O(),
      body: { period: "2026-10", reviewConfirmed: true, lines: [{ ...input, employeeId }] },
    });
    runId = r.id;
    expect(r.status).toBe("draft");
    expect(
      (
        await S.sql("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1 AND source_ref LIKE 'payroll:%'", [
          X.orgId,
        ])
      )[0].n,
    ).toBe(0);
    r = await a.preparePayroll({
      params: O(),
      body: {
        period: r.period,
        runId: r.id,
        expectedVersion: r.version,
        reviewConfirmed: true,
        lines: [{ ...input, employeeId }],
      },
    });
    expect(r.version).toBe(2);
    await expect(
      a.preparePayroll({
        params: O(),
        body: { period: r.period, reviewConfirmed: true, lines: [{ ...input, employeeId }] },
      }),
    ).rejects.toBeTruthy();
    await expect(
      a.payrollAction({
        params: { ...O(), runId },
        body: { action: "approve", expectedVersion: r.version, date: "2026-10-11", reason: "Reviewed monthly salary" },
      }),
    ).rejects.toBeTruthy();
  });
  it("requires independent approval, posts balanced liabilities, pays once and preserves the payslip", async () => {
    let r = (await X.admin.api.property.payrollRuns({ params: O() })).runs.find((r) => r.id === runId)!;
    r = await X.staff.accountant.api.property.payrollAction({
      params: { ...O(), runId },
      body: {
        action: "approve",
        date: "2026-10-11",
        expectedVersion: r.version,
        reason: "Reviewed all payroll inputs",
      },
    });
    expect(r.status).toBe("approved");
    const journals = await S.sql(
      "SELECT sum(debit_minor)::bigint AS dr,sum(credit_minor)::bigint AS cr FROM journal_lines WHERE entry_id=$1",
      [r.journalId],
    );
    expect(journals[0].dr).toBe(journals[0].cr);
    await expect(
      X.staff.accountant.api.property.payrollAction({
        params: { ...O(), runId },
        body: {
          action: "pay",
          date: "2026-10-11",
          expectedVersion: r.version,
          reference: "BANK-WAGES",
          reason: "Bank payment confirmed",
        },
      }),
    ).rejects.toBeTruthy();
    r = await X.staff.finance_director.api.property.payrollAction({
      params: { ...O(), runId },
      body: {
        action: "pay",
        date: "2026-10-11",
        expectedVersion: r.version,
        reference: "BANK-WAGES",
        reason: "Bank payment confirmed",
      },
    });
    expect(r.status).toBe("paid");
    await expect(
      X.staff.finance_director.api.property.payrollAction({
        params: { ...O(), runId },
        body: {
          action: "pay",
          date: "2026-10-11",
          expectedVersion: r.version,
          reference: "BANK-WAGES",
          reason: "Duplicate must fail",
        },
      }),
    ).rejects.toBeTruthy();
    const remit = await X.staff.finance_director.api.property.payrollRemit({
      params: { ...O(), runId },
      body: { kind: "PAYE", date: "2026-10-11", reference: "KRA-REMIT" },
    });
    expect(remit.remittances).toHaveLength(1);
    await expect(
      X.staff.finance_director.api.property.payrollRemit({
        params: { ...O(), runId },
        body: { kind: "PAYE", date: "2026-10-11", reference: "KRA-REMIT" },
      }),
    ).rejects.toBeTruthy();
    await expect(
      X.admin.api.property.preparePayroll({
        params: O(),
        body: {
          period: r.period,
          runId,
          expectedVersion: r.version,
          reviewConfirmed: true,
          lines: [{ ...input, employeeId }],
        },
      }),
    ).rejects.toBeTruthy();
    const other = await pmOrg(S);
    await expect(
      other.admin.api.property.payrollAction({
        params: { orgId: other.orgId, runId },
        body: { action: "cancel", date: "2026-10-11", expectedVersion: r.version, reason: "Cannot access other org" },
      }),
    ).rejects.toBeTruthy();
  });
  it("reverses approved unpaid payroll through another reviewer and preserves history", async () => {
    const a = X.admin.api.property;
    let r = await a.preparePayroll({
      params: O(),
      body: { period: "2026-09", reviewConfirmed: true, lines: [{ ...input, employeeId, nitaLiable: true }] },
    });
    await expect(
      a.preparePayroll({
        params: O(),
        body: {
          period: r.period,
          runId: r.id,
          expectedVersion: r.version,
          reviewConfirmed: true,
          lines: [{ ...input, employeeId, otherDeductionsMinor: 10000000 }],
        },
      }),
    ).rejects.toBeTruthy();
    expect((await a.payrollRuns({ params: O() })).runs.find((x) => x.id === r.id)?.version).toBe(r.version);
    r = await X.staff.accountant.api.property.payrollAction({
      params: { ...O(), runId: r.id },
      body: { action: "approve", date: "2026-09-30", expectedVersion: r.version, reason: "Reviewed September payroll" },
    });
    expect(r.lines[0]?.calculation.nitaMinor).toBe(5000);
    r = await X.staff.finance_director.api.property.payrollAction({
      params: { ...O(), runId: r.id },
      body: {
        action: "reverse",
        date: "2026-10-11",
        expectedVersion: r.version,
        reason: "Correct approved unpaid inputs",
      },
    });
    expect(r.status).toBe("reversed");
    expect(
      (
        await S.sql("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1 AND source_ref=$2", [
          X.orgId,
          "payroll-reversal:" + r.id,
        ])
      )[0].n,
    ).toBe(1);
    const manager = await S.addMember(X.orgId, X.admin.api, "main_manager");
    await S.sql(
      "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.payroll.view'],ARRAY[]::text[],$3)",
      [X.orgId, manager.userId, X.admin.userId],
    );
    await expect(manager.api.property.payrollEmployees({ params: O() })).rejects.toBeTruthy();
  });
  it("records bank charges through bill approval and payment, with corrections before posting", async () => {
    const contact = await X.admin.api.contacts.createContact({
      params: O(),
      body: { name: "Test Bank Supplier", types: ["supplier"] },
    });
    const a = X.admin.api.property;
    let b = await a.submitBill({
      params: O(),
      body: {
        supplierId: contact.contact.id,
        supplierInvoiceNo: "BANK-FEE-01",
        description: "Monthly bank fee",
        billDate: "2026-10-11",
        amountMinor: 120000,
        recoverFrom: "company",
        expenseCategory: "bank_charges",
      },
    });
    b = await a.editBill({
      params: { ...O(), billId: b.id },
      body: {
        description: "Corrected monthly bank fee",
        amountMinor: 12000,
        dueDate: null,
        expenseCategory: "bank_charges",
        expectedVersion: b.version,
        reason: "Removed extra zero",
      },
    });
    expect(b.amountMinor).toBe(12000);
    await expect(
      a.editBill({
        params: { ...O(), billId: b.id },
        body: {
          description: b.description,
          amountMinor: 12,
          dueDate: null,
          expenseCategory: "bank_charges",
          expectedVersion: 1,
          reason: "Stale save rejected",
        },
      }),
    ).rejects.toBeTruthy();
    b = await X.staff.accountant.api.property.approveBill({ params: { ...O(), billId: b.id } });
    expect(b.expenseAccount).toBe("5300");
    b = await X.staff.finance_director.api.property.payBill({
      params: { ...O(), billId: b.id },
      body: { paidDate: "2026-10-11", reference: "BANK-STATEMENT-FEE" },
    });
    expect(b.status).toBe("paid");
    await expect(
      a.editBill({
        params: { ...O(), billId: b.id },
        body: {
          description: b.description,
          amountMinor: 12,
          dueDate: null,
          expenseCategory: "bank_charges",
          expectedVersion: b.version,
          reason: "Posted entry immutable",
        },
      }),
    ).rejects.toBeTruthy();
    const result = await S.sql(
      "SELECT COALESCE(sum(l.debit_minor),0)::bigint AS n FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.org_id=$1 AND l.account_code='5300'",
      [X.orgId],
    );
    expect(result[0].n).toBe(12000);
  });
});
