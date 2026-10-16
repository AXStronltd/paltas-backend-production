/*
 * Guard payroll inputs and costs. A month's run is prepared from APPROVED timesheets and the organisation's own
 * payroll rules (pay rate per grade with overtime and holiday multipliers, statutory deductions and employer
 * contributions, income-tax bands and relief) — no rate lives in code. Someone other than the preparer approves it;
 * approval posts one journal: Dr 5810 wages, Dr 5820 employer contributions; Cr 2810 income tax, Cr 2820 statutory
 * deductions and contributions, Cr 2830 net wages. Salaries are paid outside PALTAS (no payout connection) and the
 * payment is RECORDED: Dr 2830 / Cr 1000. Wages and contributions are also split per site (sec_payroll_site_costs),
 * summing exactly to the journal, for site profitability.
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { SecurityDeps } from "../deps.js";
import { payrollRules } from "../setup/setup.service.js";
import { cr, dr, postToLedger } from "../shared/posting.js";
import { findSite, must, orgTimezone, shareOf, toBp } from "../shared/util.js";
import { formatMoney } from "../../../lib/money.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type Amount = { code: string; amountMinor: number };

interface RunRow {
  id: string;
  number: string;
  period: string;
  status: security.PayrollRun["status"];
  prepared_by: string;
  approved_by: string | null;
  gross_minor: number;
  employee_deductions_minor: number;
  income_tax_minor: number;
  employer_minor: number;
  net_minor: number;
  journal_id: string | null;
  paid_on: string | null;
}

/** Progressive income tax on monthly taxable pay, less relief, never below zero. */
function incomeTax(taxable: number, bands: security.PayrollRules["incomeTaxBands"], relief: number): number {
  let rest = Math.max(0, taxable);
  let tax = 0;
  for (const b of bands) {
    const slice = b.widthMinor === null ? rest : Math.min(rest, b.widthMinor);
    tax += shareOf(slice, toBp(b.pct));
    rest -= slice;
    if (rest <= 0) break;
  }
  return Math.max(0, tax - relief);
}

function statutory(gross: number, rule: security.PayrollRules["statutory"][number]): number {
  if (gross <= 0) return 0;
  const base = rule.baseCapMinor === null ? gross : Math.min(gross, rule.baseCapMinor);
  return Math.max(rule.minMinor, shareOf(base, toBp(rule.pct)));
}

/** Split an amount over weights so the parts add up exactly (largest remainder to the largest weight). */
function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((n, w) => n + w, 0);
  if (!total) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((amount * w) / total));
  const biggest = weights.indexOf(Math.max(...weights));
  parts[biggest] = (parts[biggest] ?? 0) + amount - parts.reduce((n, p) => n + p, 0);
  return parts;
}

const payMinor = (minutes: number, hourly: number, bp: number) => Math.round((minutes * hourly * bp) / 600_000);

export function payrollService(d: SecurityDeps) {
  const { core } = d;
  const { db } = core;
  const { payrollPayout } = d.adapters;

  async function runRow(t: Db, orgId: string, period: string, lock = false): Promise<RunRow> {
    const r = await t.row<RunRow>(
      `SELECT * FROM sec_payroll_runs WHERE org_id = $1 AND period = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, period],
    );
    if (!r) throw fail.notFound(`No payroll prepared for ${period}`);
    return r;
  }

  async function runOut(t: Db, r: RunRow): Promise<security.PayrollRun> {
    const lines = await t.rows<{
      guard_id: string;
      name: string;
      grade: string;
      normal_minutes: number;
      overtime_minutes: number;
      holiday_minutes: number;
      gross_minor: number;
      deductions: Amount[];
      income_tax_minor: number;
      employer: Amount[];
      net_minor: number;
    }>(
      `SELECT l.*, g.name FROM sec_payroll_lines l JOIN sec_guards g ON g.id = l.guard_id WHERE l.run_id = $1
       ORDER BY g.number`,
      [r.id],
    );
    const sites = await t.rows<{ site_id: string; gross_minor: number; employer_minor: number }>(
      "SELECT * FROM sec_payroll_site_costs WHERE run_id = $1 ORDER BY site_id",
      [r.id],
    );
    return {
      id: r.id,
      number: r.number,
      period: r.period,
      status: r.status,
      preparedBy: r.prepared_by,
      approvedBy: r.approved_by,
      grossMinor: r.gross_minor,
      employeeDeductionsMinor: r.employee_deductions_minor,
      incomeTaxMinor: r.income_tax_minor,
      employerContributionsMinor: r.employer_minor,
      netMinor: r.net_minor,
      journalId: r.journal_id,
      paidOn: r.paid_on,
      lines: lines.map((l) => ({
        guardId: l.guard_id,
        name: l.name,
        grade: l.grade,
        normalMinutes: l.normal_minutes,
        overtimeMinutes: l.overtime_minutes,
        holidayMinutes: l.holiday_minutes,
        grossMinor: l.gross_minor,
        deductions: l.deductions,
        incomeTaxMinor: l.income_tax_minor,
        employer: l.employer,
        netMinor: l.net_minor,
      })),
      siteCosts: sites.map((x) => ({ siteId: x.site_id, grossMinor: x.gross_minor, employerMinor: x.employer_minor })),
      payout: payrollPayout.payout(r.period),
    };
  }

  /** Credit balance (credit − debit) of an account in the ledger today. */
  async function creditBalance(t: Db, orgId: string, code: string): Promise<number> {
    const r = await t.row<{ n: number }>(
      `SELECT COALESCE(sum(l.credit_minor - l.debit_minor), 0)::bigint AS n FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
       WHERE e.org_id = $1 AND l.account_code = $2`,
      [orgId, code],
    );
    return r?.n ?? 0;
  }

  return {
    async prepare(s: OrgScope, period: string) {
      return db.tx(async (t) => {
        // one run per month: the advisory lock makes two concurrent "prepare" calls queue
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", [`sec-payroll:${s.orgId}:${period}`]);
        if (await t.row("SELECT 1 FROM sec_payroll_runs WHERE org_id = $1 AND period = $2", [s.orgId, period]))
          throw fail.conflict(`Payroll for ${period} is already prepared`);
        const tz = await orgTimezone(t, s.orgId);
        const shifts = await t.rows<{
          id: string;
          guard_id: string;
          grade: string;
          site_id: string;
          holiday: boolean;
          normal_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT sh.id, sh.guard_id, g.grade, sh.site_id, sh.holiday, sh.normal_minutes, sh.overtime_minutes
           FROM sec_shifts sh JOIN sec_guards g ON g.id = sh.guard_id
           WHERE sh.org_id = $1 AND sh.timesheet_status = 'approved' AND sh.payroll_run_id IS NULL
             AND to_char(sh.starts_at AT TIME ZONE $2, 'YYYY-MM') = $3
           ORDER BY sh.guard_id, sh.starts_at FOR UPDATE OF sh`,
          [s.orgId, tz, period],
        );
        if (!shifts.length) throw fail.conflict(`No approved timesheets for ${period} are waiting for payroll`);
        const rules = await payrollRules(t, s.orgId);
        const rate = new Map(rules.payRates.map((r) => [r.grade.toLowerCase(), r]));
        const missing = [...new Set(shifts.map((x) => x.grade))].filter((g) => !rate.has(g.toLowerCase()));
        if (missing.length) throw fail.conflict(`No pay rate is configured for grade(s): ${missing.join(", ")}`);

        const guards = new Map<
          string,
          {
            grade: string;
            normal: number;
            overtime: number;
            holiday: number;
            gross: number;
            bySite: Map<string, number>;
          }
        >();
        for (const x of shifts) {
          const r = must(rate.get(x.grade.toLowerCase()), "a pay rate");
          const pay =
            payMinor(x.normal_minutes, r.hourlyMinor, x.holiday ? toBp(r.holidayPct) : 10000) +
            payMinor(x.overtime_minutes, r.hourlyMinor, toBp(r.overtimePct));
          const g = guards.get(x.guard_id) ?? {
            grade: x.grade,
            normal: 0,
            overtime: 0,
            holiday: 0,
            gross: 0,
            bySite: new Map(),
          };
          if (x.holiday) g.holiday += x.normal_minutes;
          else g.normal += x.normal_minutes;
          g.overtime += x.overtime_minutes;
          g.gross += pay;
          g.bySite.set(x.site_id, (g.bySite.get(x.site_id) ?? 0) + pay);
          guards.set(x.guard_id, g);
        }

        const id = newId("spr");
        const number = await nextNumber(t, s.orgId, "SPR");
        const T = { gross: 0, deductions: 0, tax: 0, employer: 0, net: 0 };
        const siteCost = new Map<string, { gross: number; employer: number }>();
        const lines: unknown[][] = [];
        for (const [guardId, g] of guards) {
          const deductions: Amount[] = rules.statutory
            .filter((r) => r.party === "employee")
            .map((r) => ({ code: r.code, amountMinor: statutory(g.gross, r) }));
          const employer: Amount[] = rules.statutory
            .filter((r) => r.party === "employer")
            .map((r) => ({ code: r.code, amountMinor: statutory(g.gross, r) }));
          const relief = rules.statutory
            .filter((r) => r.party === "employee" && r.reducesTaxablePay)
            .reduce((n, r) => n + statutory(g.gross, r), 0);
          const tax = incomeTax(g.gross - relief, rules.incomeTaxBands, rules.personalReliefMinor);
          const ded = deductions.reduce((n, x) => n + x.amountMinor, 0);
          const emp = employer.reduce((n, x) => n + x.amountMinor, 0);
          const net = g.gross - ded - tax;
          if (net < 0) throw fail.conflict(`Deductions exceed the pay of guard ${guardId}: check the payroll rules`);
          T.gross += g.gross;
          T.deductions += ded;
          T.tax += tax;
          T.employer += emp;
          T.net += net;
          const siteIds = [...g.bySite.keys()].sort();
          const shares = allocate(
            emp,
            siteIds.map((x) => g.bySite.get(x) ?? 0),
          );
          siteIds.forEach((sid, i) => {
            const c = siteCost.get(sid) ?? { gross: 0, employer: 0 };
            c.gross += g.bySite.get(sid) ?? 0;
            c.employer += shares[i] ?? 0;
            siteCost.set(sid, c);
          });
          lines.push([guardId, g.grade, g.normal, g.overtime, g.holiday, g.gross, deductions, tax, employer, net]);
        }
        await t.run(
          `INSERT INTO sec_payroll_runs (id, org_id, number, period, status, prepared_by, gross_minor,
             employee_deductions_minor, income_tax_minor, employer_minor, net_minor)
           VALUES ($1,$2,$3,$4,'prepared',$5,$6,$7,$8,$9,$10)`,
          [id, s.orgId, number, period, s.userId, T.gross, T.deductions, T.tax, T.employer, T.net],
        );
        for (const l of lines)
          await t.run(
            `INSERT INTO sec_payroll_lines (run_id, org_id, guard_id, grade, normal_minutes, overtime_minutes,
               holiday_minutes, gross_minor, deductions, income_tax_minor, employer, net_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [id, s.orgId, l[0], l[1], l[2], l[3], l[4], l[5], JSON.stringify(l[6]), l[7], JSON.stringify(l[8]), l[9]],
          );
        for (const [sid, c] of siteCost)
          await t.run(
            "INSERT INTO sec_payroll_site_costs (run_id, org_id, site_id, gross_minor, employer_minor) VALUES ($1,$2,$3,$4,$5)",
            [id, s.orgId, sid, c.gross, c.employer],
          );
        await t.run("UPDATE sec_shifts SET payroll_run_id = $2 WHERE id = ANY($1)", [shifts.map((x) => x.id), id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Payroll prepared",
          target: number,
          detail: `${period} · ${guards.size} guard(s) · gross ${T.gross}`,
        });
        return runOut(t, await runRow(t, s.orgId, period));
      });
    },

    async get(s: OrgScope, period: string) {
      return runOut(db, await runRow(db, s.orgId, period));
    },

    async approve(s: OrgScope, period: string) {
      return db.tx(async (t) => {
        const r = await runRow(t, s.orgId, period, true);
        if (r.status !== "prepared") throw fail.conflict(`Payroll for ${period} is already ${r.status}`);
        if (r.prepared_by === s.userId)
          throw fail.separationOfDuties("You prepared this payroll: someone else must approve it");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          date: s.today,
          kind: "payroll",
          memo: `Guard payroll ${period} (${r.number})`,
          ref: r.number,
          lines: [
            dr(ACC.wages, r.gross_minor),
            dr(ACC.employer, r.employer_minor),
            cr(ACC.incomeTax, r.income_tax_minor),
            cr(ACC.statutory, r.employee_deductions_minor + r.employer_minor),
            cr(ACC.netWages, r.net_minor),
          ],
        });
        await t.run(
          "UPDATE sec_payroll_runs SET status = 'approved', approved_by = $2, approved_at = now(), journal_id = $3 WHERE id = $1",
          [r.id, s.userId, journalId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Payroll approved and posted",
          target: r.number,
        });
        return runOut(t, await runRow(t, s.orgId, period));
      });
    },

    async recordPayment(s: OrgScope, period: string, date: string, reference: string) {
      return db.tx(async (t) => {
        const r = await runRow(t, s.orgId, period, true);
        if (r.status !== "approved")
          throw fail.conflict(r.status === "paid" ? "Already recorded as paid" : "Approve the payroll first");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          date,
          kind: "payroll_payment",
          memo: `Net wages paid ${period} · ${reference} (paid outside PALTAS)`,
          ref: `${r.number}-PAID`,
          lines: [dr(ACC.netWages, r.net_minor), cr(ACC.bank, r.net_minor)],
        });
        await t.run(
          "UPDATE sec_payroll_runs SET status = 'paid', paid_on = $2, paid_reference = $3, paid_journal_id = $4 WHERE id = $1",
          [r.id, date, reference, journalId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Net wages payment recorded",
          target: r.number,
          detail: reference,
        });
        return runOut(t, await runRow(t, s.orgId, period));
      });
    },

    async postCost(s: OrgScope, b: Body<typeof security.postCost>) {
      return db.tx(async (t) => {
        if (b.siteId) await findSite(t, s.orgId, b.siteId);
        const id = newId("sco");
        const number = await nextNumber(t, s.orgId, "SCO");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          date: b.date,
          kind: "cost",
          memo: `${b.description} (${number})`,
          ref: number,
          siteId: b.siteId ?? null,
          lines: [dr(b.account, b.amountMinor), cr(b.paidFrom === "bank" ? ACC.bank : ACC.payables, b.amountMinor)],
        });
        await t.run(
          `INSERT INTO sec_costs (id, org_id, number, site_id, account, date, description, amount_minor, paid_from, journal_id,
             recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            s.orgId,
            number,
            b.siteId ?? null,
            b.account,
            b.date,
            b.description,
            b.amountMinor,
            b.paidFrom,
            journalId,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Security cost posted",
          target: number,
          detail: b.description,
        });
        return { id, number, journalId };
      });
    },

    async recordRemittance(s: OrgScope, b: Body<typeof security.recordRemittance>) {
      return db.tx(async (t) => {
        await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", [`sec-remit:${s.orgId}:${b.account}`]);
        const owed = await creditBalance(t, s.orgId, b.account);
        if (b.amountMinor > owed)
          throw fail.conflict(`Only ${formatMoney(owed, s.entitlement.org.currency)} is owed on account ${b.account}`);
        const id = newId("srm");
        const number = await nextNumber(t, s.orgId, "SRM");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          date: b.date,
          kind: "remittance",
          memo: `Remittance ${b.account === ACC.incomeTax ? "income tax" : "statutory deductions"} · ${b.reference}`,
          ref: number,
          lines: [dr(b.account, b.amountMinor), cr(ACC.bank, b.amountMinor)],
        });
        await t.run(
          `INSERT INTO sec_remittances (id, org_id, number, account, date, amount_minor, reference, journal_id, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, s.orgId, number, b.account, b.date, b.amountMinor, b.reference, journalId, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Remittance recorded",
          target: number,
          detail: b.reference,
        });
        return { id, number, journalId };
      });
    },
  };
}

export type PayrollService = ReturnType<typeof payrollService>;
