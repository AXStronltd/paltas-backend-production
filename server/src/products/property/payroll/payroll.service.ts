import type { property as P, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { kenyaMonthly, type KenyaCalculation } from "../../../core/payroll/kenya.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { Db } from "../../../db/database.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { post, dr, cr } from "../shared/posting.js";
type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Employee = z.output<typeof P.Employee>;
interface ERow {
  id: string;
  code: string;
  name: string;
  email: string | null;
  gross_minor: number;
  active: boolean;
  version: number;
}
interface Run {
  id: string;
  period: string;
  status: P.PayrollRun["status"];
  version: number;
  prepared_by: string;
  approved_by: string | null;
  approved_on: string | null;
  paid_on: string | null;
  paid_reference: string | null;
  journal_id: string | null;
}
interface Line {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  inputs: z.output<typeof P.PayrollInput>;
  calculation: KenyaCalculation;
}
const outEmployee = (e: ERow): Employee => ({
  id: e.id,
  code: e.code,
  name: e.name,
  email: e.email,
  grossMinor: e.gross_minor,
  active: e.active,
  version: e.version,
});
const total = (lines: Line[], key: keyof KenyaCalculation) => lines.reduce((a, l) => a + Number(l.calculation[key]), 0);
export function propertyPayrollService(d: PmDeps) {
  const { core } = d,
    { db } = core;
  async function scope(s: OrgScope) {
    if (s.propertyIds != null)
      throw fail.forbidden("Organisation-wide payroll requires an unrestricted payroll assignment.");
    if (s.entitlement.org.currency !== "KES") throw fail.conflict("Kenya payroll requires a KES organisation.");
  }
  async function row(t: Db, org: string, id: string) {
    const r = await t.row<Run>("SELECT * FROM pm_payroll_runs WHERE org_id=$1 AND id=$2 FOR UPDATE", [org, id]);
    if (!r) throw fail.notFound("Payroll run not found");
    return r;
  }
  async function lines(t: Db, id: string) {
    return t.rows<Line>("SELECT * FROM pm_payroll_lines WHERE run_id=$1 ORDER BY employee_code", [id]);
  }
  async function out(t: Db, org: string, id: string): Promise<P.PayrollRun> {
    const r = await t.row<Run>("SELECT * FROM pm_payroll_runs WHERE org_id=$1 AND id=$2", [org, id]);
    if (!r) throw fail.notFound("Payroll run not found");
    return {
      id: r.id,
      period: r.period,
      status: r.status,
      version: r.version,
      preparedBy: r.prepared_by,
      approvedBy: r.approved_by,
      paidOn: r.paid_on,
      paidReference: r.paid_reference,
      journalId: r.journal_id,
      lines: (await lines(t, id)).map((l) => ({
        employeeId: l.employee_id,
        employeeCode: l.employee_code,
        employeeName: l.employee_name,
        inputs: l.inputs,
        calculation: l.calculation,
      })),
      remittances: (
        await t.rows<{ kind: string; amount_minor: number; paid_on: string; reference: string }>(
          "SELECT kind,amount_minor,paid_on,reference FROM pm_payroll_remittances WHERE run_id=$1 ORDER BY kind",
          [id],
        )
      ).map((r) => ({ kind: r.kind, amountMinor: r.amount_minor, paidOn: r.paid_on, reference: r.reference })),
    };
  }
  const liability = (L: Line[]) => ({
    PAYE: total(L, "payeMinor"),
    NSSF: total(L, "nssfMinor") + total(L, "employerNssfMinor"),
    SHIF: total(L, "shifMinor"),
    AHL: total(L, "ahlMinor") + total(L, "employerAhlMinor"),
    NITA: total(L, "nitaMinor"),
    pension: L.reduce((a, l) => a + l.inputs.pensionMinor, 0),
    medical: L.reduce((a, l) => a + l.inputs.medicalMinor, 0),
    other_employee: L.reduce((a, l) => a + l.inputs.otherDeductionsMinor, 0),
    other_employer: total(L, "otherEmployerMinor"),
  });
  const accounts = {
    PAYE: "2671",
    NSSF: "2672",
    SHIF: "2673",
    AHL: "2674",
    NITA: "2675",
    pension: "2675",
    medical: "2675",
    other_employee: "2675",
    other_employer: "2675",
  };
  function posting(L: Line[]) {
    const owed = liability(L);
    return [
      dr("5670", total(L, "grossMinor")),
      dr("5671", total(L, "employerMinor")),
      cr("2670", total(L, "netMinor")),
      ...Object.entries(owed).map(([k, v]) => cr(accounts[k as keyof typeof accounts], v)),
    ];
  }
  function date(s: OrgScope, value: string) {
    if (value > s.today) throw fail.invalid("Only record payments or postings that have already occurred.");
  }
  return {
    async employees(s: OrgScope) {
      await scope(s);
      return {
        employees: (await db.rows<ERow>("SELECT * FROM pm_employees WHERE org_id=$1 ORDER BY code", [s.orgId])).map(
          outEmployee,
        ),
      };
    },
    async employee(s: OrgScope, id: string, b: Body<typeof P.savePayrollEmployee>) {
      await scope(s);
      let key = id;
      await financeTransaction(db, s.orgId, async (t) => {
        const old = await t.row<ERow>("SELECT * FROM pm_employees WHERE org_id=$1 AND id=$2 FOR UPDATE", [s.orgId, id]);
        if (id !== "new" && !old) throw fail.notFound("Employee not found");
        if ((old?.version ?? 0) !== b.expectedVersion)
          throw fail.conflict("Employee changed. Reopen the latest record before saving.");
        const duplicate = await t.row(
          "SELECT 1 FROM pm_employees WHERE org_id=$1 AND upper(code)=upper($2) AND id<>$3",
          [s.orgId, b.code, id],
        );
        if (duplicate) throw fail.conflict("Employee code is already in use.");
        key = old?.id ?? newId("pme");
        if (old)
          await t.run(
            "UPDATE pm_employees SET code=$3,name=$4,email=$5,gross_minor=$6,active=$7,version=version+1 WHERE org_id=$1 AND id=$2",
            [s.orgId, key, b.code.toUpperCase(), b.name, b.email, b.grossMinor, b.active],
          );
        else
          await t.run(
            "INSERT INTO pm_employees(id,org_id,code,name,email,gross_minor,active) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [key, s.orgId, b.code.toUpperCase(), b.name, b.email, b.grossMinor, b.active],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: old ? "Payroll employee updated" : "Payroll employee registered",
          target: key,
          detail: "Historical payslips preserved",
          before: old ? { name: old.name, grossMinor: old.gross_minor, active: old.active } : null,
          after: { name: b.name, grossMinor: b.grossMinor, active: b.active },
        });
      });
      const result = await db.row<ERow>("SELECT * FROM pm_employees WHERE org_id=$1 AND id=$2", [s.orgId, key]);
      if (!result) throw fail.notFound("Employee not found");
      return outEmployee(result);
    },
    async list(s: OrgScope) {
      await scope(s);
      const rows = await db.rows<{ id: string }>(
        "SELECT id FROM pm_payroll_runs WHERE org_id=$1 ORDER BY period DESC,created_at DESC LIMIT 120",
        [s.orgId],
      );
      return { runs: await Promise.all(rows.map((r) => out(db, s.orgId, r.id))) };
    },
    async prepare(s: OrgScope, b: Body<typeof P.preparePayroll>) {
      await scope(s);
      const id = b.runId ?? newId("ppr");
      await financeTransaction(db, s.orgId, async (t) => {
        if (b.runId) {
          const old = await row(t, s.orgId, b.runId);
          if (old.status !== "draft")
            throw fail.conflict("Only draft payroll can be edited. Reverse an approved run through review.");
          if (old.version !== b.expectedVersion) throw fail.conflict("Payroll changed. Reopen the latest run.");
          await t.run("DELETE FROM pm_payroll_lines WHERE run_id=$1", [id]);
          await t.run("UPDATE pm_payroll_runs SET period=$2,prepared_by=$3,version=version+1 WHERE id=$1", [
            id,
            b.period,
            s.userId,
          ]);
        }
        const dup = await t.row(
          "SELECT 1 FROM pm_payroll_runs WHERE org_id=$1 AND period=$2 AND id<>$3 AND status NOT IN ('cancelled','reversed')",
          [s.orgId, b.period, id],
        );
        if (dup) throw fail.conflict("A payroll run already exists for this month. Open and edit its draft.");
        if (!b.runId)
          await t.run("INSERT INTO pm_payroll_runs(id,org_id,period,status,prepared_by) VALUES($1,$2,$3,'draft',$4)", [
            id,
            s.orgId,
            b.period,
            s.userId,
          ]);
        const ids = new Set<string>();
        for (const input of b.lines) {
          if (!input.nitaLiable && input.nitaExemptionReason.trim().length < 5)
            throw fail.invalid("Record the reviewed NITA exemption basis, or include the employer levy.");
          if (ids.has(input.employeeId)) throw fail.invalid("Employee appears twice in this run.");
          ids.add(input.employeeId);
          const employee = await t.row<ERow>("SELECT * FROM pm_employees WHERE org_id=$1 AND id=$2 AND active", [
            s.orgId,
            input.employeeId,
          ]);
          if (!employee) throw fail.notFound("Active employee not found");
          let calculation: KenyaCalculation;
          try {
            calculation = kenyaMonthly(input, b.period);
          } catch (e) {
            throw fail.invalid((e as Error).message);
          }
          await t.run(
            "INSERT INTO pm_payroll_lines(run_id,employee_id,employee_code,employee_name,inputs,calculation) VALUES($1,$2,$3,$4,$5,$6)",
            [id, employee.id, employee.code, employee.name, JSON.stringify(input), JSON.stringify(calculation)],
          );
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Payroll draft prepared",
          target: id,
          detail: `${b.period}; ${b.lines.length} reviewed employees; no posting`,
        });
      });
      return out(db, s.orgId, id);
    },
    async action(s: OrgScope, id: string, b: Body<typeof P.payrollAction>) {
      await scope(s);
      date(s, b.date);
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await row(t, s.orgId, id);
        if (r.version !== b.expectedVersion) throw fail.conflict("Payroll changed. Reopen the latest run.");
        const L = await lines(t, id);
        if (b.action !== "approve" && r.approved_on && b.date < r.approved_on)
          throw fail.invalid("Payment or reversal date cannot precede the payroll posting date.");
        if (b.action === "approve") {
          if (r.status !== "draft") throw fail.conflict("Only a draft can be approved.");
          if (r.prepared_by === s.userId)
            throw fail.forbidden("Another authorised person must approve the payroll you prepared.");
          if (b.date.slice(0, 7) !== r.period)
            throw fail.invalid("Approval posting date must be within the payroll month.");
          const journal = await post(t, core, {
            orgId: s.orgId,
            date: b.date,
            kind: "payroll",
            memo: `Payroll ${r.period}`,
            ref: `payroll:${id}`,
            link: {},
            lines: posting(L),
          });
          await t.run(
            "UPDATE pm_payroll_runs SET status='approved',approved_by=$2,approved_on=$3,journal_id=$4,version=version+1 WHERE id=$1",
            [id, s.userId, b.date, journal],
          );
        }
        if (b.action === "pay") {
          if (r.status !== "approved") throw fail.conflict("Only approved unpaid payroll can be paid.");
          if (r.approved_by === s.userId) throw fail.forbidden("A person other than the approver must record payment.");
          if (!b.reference) throw fail.invalid("Enter the external bank payment reference.");
          const j =
            total(L, "netMinor") > 0
              ? await post(t, core, {
                  orgId: s.orgId,
                  date: b.date,
                  kind: "payroll_payment",
                  memo: `Payroll paid ${r.period}: ${b.reference}`,
                  ref: `payroll-payment:${id}`,
                  link: {},
                  lines: [dr("2670", total(L, "netMinor")), cr("1000", total(L, "netMinor"))],
                })
              : null;
          await t.run(
            "UPDATE pm_payroll_runs SET status='paid',paid_by=$2,paid_on=$3,paid_reference=$4,payment_journal_id=$5,version=version+1 WHERE id=$1",
            [id, s.userId, b.date, b.reference, j],
          );
        }
        if (b.action === "cancel") {
          if (r.status !== "draft") throw fail.conflict("Only a draft can be cancelled.");
          await t.run("UPDATE pm_payroll_runs SET status='cancelled',version=version+1 WHERE id=$1", [id]);
        }
        if (b.action === "reverse") {
          if (r.status !== "approved")
            throw fail.conflict(
              "Only approved, unpaid payroll may be reversed here. Paid wages require a separately reconciled recovery.",
            );
          if (r.approved_by === s.userId || r.prepared_by === s.userId)
            throw fail.forbidden("A different authorised approver must review this reversal.");
          if (await t.row("SELECT 1 FROM pm_payroll_remittances WHERE run_id=$1", [id]))
            throw fail.conflict("Statutory payments have been recorded; reconcile those before reversing payroll.");
          if (!r.journal_id) throw fail.conflict("Original journal is missing.");
          await post(t, core, {
            orgId: s.orgId,
            date: b.date,
            kind: "payroll_reversal",
            memo: `Payroll reversal ${r.period}: ${b.reason}`,
            ref: `payroll-reversal:${id}`,
            reverses: r.journal_id,
            link: {},
            lines: posting(L).map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
          });
          await t.run("UPDATE pm_payroll_runs SET status='reversed',version=version+1 WHERE id=$1", [id]);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: `Payroll ${b.action}`,
          target: id,
          detail: b.reason,
        });
      });
      return out(db, s.orgId, id);
    },
    async remit(s: OrgScope, id: string, b: Body<typeof P.payrollRemit>) {
      await scope(s);
      date(s, b.date);
      await financeTransaction(db, s.orgId, async (t) => {
        const r = await row(t, s.orgId, id);
        if (!["approved", "paid"].includes(r.status))
          throw fail.conflict("Approve payroll before recording remittances.");
        if (r.approved_by === s.userId) throw fail.forbidden("A person other than the approver records remittances.");
        if (await t.row("SELECT 1 FROM pm_payroll_remittances WHERE run_id=$1 AND kind=$2", [id, b.kind]))
          throw fail.conflict("This remittance is already recorded.");
        if (r.approved_on && b.date < r.approved_on)
          throw fail.invalid("Remittance date cannot precede the payroll posting date.");
        const amount = liability(await lines(t, id))[b.kind];
        if (!amount) throw fail.invalid("There is no liability of this kind in this run.");
        const j = await post(t, core, {
          orgId: s.orgId,
          date: b.date,
          kind: "payroll_remittance",
          memo: `Payroll ${b.kind} remitted: ${b.reference}`,
          ref: `payroll-remit:${id}:${b.kind}`,
          link: {},
          lines: [dr(accounts[b.kind], amount), cr("1000", amount)],
        });
        await t.run(
          "INSERT INTO pm_payroll_remittances(id,run_id,kind,amount_minor,paid_on,reference,recorded_by,journal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [newId("prm"), id, b.kind, amount, b.date, b.reference, s.userId, j],
        );
        await t.run("UPDATE pm_payroll_runs SET version=version+1 WHERE id=$1", [id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Payroll remittance recorded",
          target: id,
          detail: `${b.kind}; ${amount}; ${b.reference}; no funds transferred by PALTAS`,
        });
      });
      return out(db, s.orgId, id);
    },
  };
}
