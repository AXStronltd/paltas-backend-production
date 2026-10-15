/*
 * Payroll inputs, tips and service charge. The staff register with pay is seen only by the payroll officer
 * (capability hotel.payroll): every other role — including the approver — sees department totals, never a salary.
 *
 *   pay run      prepared from salary / hourly rate, hours (from the staff schedule unless given; time beyond the
 *                hotel's standard day is overtime at its multiplier) and allowances; approved by someone other than
 *                the preparer (database constraint too): departmental payroll 5150 / 5250 / 5350 / 5450 / 5950 →
 *                wages payable 2200. Statutory deductions and net pay need a country payroll engine (not connected).
 *   distribution the tips pool (2130) or the service charge collected (2120) accrued up to a date and not yet shared,
 *                split among active staff by their points (largest remainder, to the minor unit): → wages payable 2200.
 */
import { roleCan, type hotel, type z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, PAYROLL_ACCOUNT } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";

interface StaffRow {
  id: string;
  user_id: string | null;
  name: string;
  department: hotel.StaffDepartment;
  basis: "monthly" | "hourly";
  monthly_minor: number;
  hourly_minor: number;
  service_points: number;
  active: boolean;
}

interface RunRow {
  id: string;
  number: string;
  period: string;
  status: "draft" | "approved";
  gross_minor: number;
  prepared_by: string;
  approved_by: string | null;
  journal_id: string | null;
}

const toStaff = (r: StaffRow): hotel.StaffPayOut => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  department: r.department,
  basis: r.basis,
  monthlyMinor: r.monthly_minor,
  hourlyMinor: r.hourly_minor,
  servicePoints: r.service_points,
  active: r.active,
});

const DEPTS: hotel.StaffDepartment[] = ["rooms", "fnb", "spa", "other", "admin"];

/** Share `pool` by weights, to the minor unit (largest remainder; ties by order). */
export function shareOut(pool: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (pool * w) / total);
  const out = raw.map(Math.floor);
  let left = pool - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rest: r - Math.floor(r) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    out[o.i] = (out[o.i] as number) + 1;
    left--;
  }
  return out;
}

const lastDay = (period: string) => {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export function payrollService(d: HotelDeps) {
  const { core } = d;
  const { db } = core;

  const seesPay = (s: HotelScope) => roleCan(s.role, "hotel.payroll");

  async function runOut(t: Db, s: HotelScope, r: RunRow): Promise<hotel.PayRunOut> {
    const lines = await t.rows<{
      staff_id: string;
      name: string;
      department: hotel.StaffDepartment;
      regular_minutes: number;
      overtime_minutes: number;
      base_minor: number;
      overtime_minor: number;
      allowances_minor: number;
      gross_minor: number;
    }>(
      `SELECT l.*, p.name FROM hotel_pay_run_lines l JOIN hotel_staff_pay p ON p.id = l.staff_id WHERE l.run_id = $1
       ORDER BY l.department, p.name`,
      [r.id],
    );
    const byDepartment = { rooms: 0, fnb: 0, spa: 0, other: 0, admin: 0 };
    for (const l of lines) byDepartment[l.department] += l.gross_minor;
    return {
      id: r.id,
      number: r.number,
      period: r.period,
      status: r.status,
      grossMinor: r.gross_minor,
      byDepartment,
      staffCount: lines.length,
      preparedBy: r.prepared_by,
      approvedBy: r.approved_by,
      journalId: r.journal_id,
      lines: seesPay(s)
        ? lines.map((l) => ({
            staffId: l.staff_id,
            name: l.name,
            department: l.department,
            regularHours: l.regular_minutes / 60,
            overtimeHours: l.overtime_minutes / 60,
            baseMinor: l.base_minor,
            overtimeMinor: l.overtime_minor,
            allowancesMinor: l.allowances_minor,
            grossMinor: l.gross_minor,
          }))
        : null,
      statutory: d.adapters.payrollEngine.state,
    };
  }

  async function runRow(t: Db, propertyId: string, id: string, lock = false): Promise<RunRow> {
    const r = await t.row<RunRow>(
      `SELECT * FROM hotel_pay_runs WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [propertyId, id],
    );
    if (!r) throw fail.notFound("Pay run not found");
    return r;
  }

  /** What an account accrued for this hotel up to a date, leaving out payroll postings (the distributions). */
  async function accrued(t: Db, propertyId: string, account: string, upTo: string): Promise<number> {
    const r = await t.row<{ n: number }>(
      `SELECT COALESCE(sum(l.credit_minor - l.debit_minor), 0)::bigint AS n
       FROM hotel_ledger_links k JOIN journal_entries e ON e.id = k.journal_id AND e.status = 'posted'
       JOIN journal_lines l ON l.entry_id = e.id
       WHERE k.property_id = $1 AND k.business_date <= $2 AND k.kind <> 'payroll' AND l.account_code = $3`,
      [propertyId, upTo, account],
    );
    return r?.n ?? 0;
  }

  async function distributionOut(t: Db, s: HotelScope, id: string): Promise<hotel.DistributionOut> {
    const r = (await t.row<{
      id: string;
      kind: "tips" | "service_charge";
      up_to: string;
      pool_minor: number;
      journal_id: string;
    }>("SELECT * FROM hotel_distributions WHERE id = $1", [id])) as {
      id: string;
      kind: "tips" | "service_charge";
      up_to: string;
      pool_minor: number;
      journal_id: string;
    };
    const lines = await t.rows<{ staff_id: string; name: string; points: number; amount_minor: number }>(
      `SELECT l.*, p.name FROM hotel_distribution_lines l JOIN hotel_staff_pay p ON p.id = l.staff_id
       WHERE l.distribution_id = $1 ORDER BY p.name`,
      [id],
    );
    return {
      id: r.id,
      kind: r.kind,
      upTo: r.up_to,
      poolMinor: r.pool_minor,
      journalId: r.journal_id,
      lines: seesPay(s)
        ? lines.map((l) => ({ staffId: l.staff_id, name: l.name, points: l.points, amountMinor: l.amount_minor }))
        : null,
    };
  }

  return {
    async listStaff(s: HotelScope) {
      const rows = await db.rows<StaffRow>(
        "SELECT * FROM hotel_staff_pay WHERE property_id = $1 ORDER BY department, name",
        [s.property.id],
      );
      return { staff: rows.map(toStaff) };
    },

    async saveStaff(s: HotelScope, b: z.output<typeof hotel.saveStaffPay.body>) {
      const id = await db.tx(async (t) => {
        if (
          b.userId &&
          !(await t.row("SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2", [s.orgId, b.userId]))
        )
          throw fail.invalid("That person is not a member of this organisation");
        const existing = await t.row<{ id: string }>(
          `SELECT id FROM hotel_staff_pay WHERE property_id = $1 AND (($2::text IS NOT NULL AND user_id = $2) OR lower(name) = lower($3))
           ORDER BY (user_id = $2) DESC NULLS LAST LIMIT 1`,
          [s.property.id, b.userId ?? null, b.name],
        );
        const sid = existing?.id ?? newId("hsp");
        await t.run(
          `INSERT INTO hotel_staff_pay (id, org_id, property_id, user_id, name, department, basis, monthly_minor, hourly_minor,
             service_points, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name, department = EXCLUDED.department,
             basis = EXCLUDED.basis, monthly_minor = EXCLUDED.monthly_minor, hourly_minor = EXCLUDED.hourly_minor,
             service_points = EXCLUDED.service_points, active = EXCLUDED.active`,
          [
            sid,
            s.orgId,
            s.property.id,
            b.userId ?? null,
            b.name,
            b.department,
            b.basis,
            b.monthlyMinor,
            b.hourlyMinor,
            b.servicePoints,
            b.active,
          ],
        );
        // the audit trail names who changed whose pay, never the amount (salaries stay with payroll)
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Staff pay record saved", target: sid });
        return sid;
      });
      return toStaff((await db.row<StaffRow>("SELECT * FROM hotel_staff_pay WHERE id = $1", [id])) as StaffRow);
    },

    async listRuns(s: HotelScope) {
      const rows = await db.rows<RunRow>("SELECT * FROM hotel_pay_runs WHERE property_id = $1 ORDER BY period DESC", [
        s.property.id,
      ]);
      const runs = [];
      for (const r of rows) runs.push(await runOut(db, s, r));
      return { runs };
    },

    async prepare(s: HotelScope, b: z.output<typeof hotel.preparePayRun.body>) {
      const id = await db.tx(async (t) => {
        const old = await t.row<RunRow>(
          "SELECT * FROM hotel_pay_runs WHERE property_id = $1 AND period = $2 FOR UPDATE",
          [s.property.id, b.period],
        );
        if (old?.status === "approved") throw fail.conflict(`The ${b.period} pay run is already approved`);
        if (old) {
          await t.run("DELETE FROM hotel_pay_run_lines WHERE run_id = $1", [old.id]);
          await t.run("DELETE FROM hotel_pay_runs WHERE id = $1", [old.id]);
        }
        const staff = await t.rows<StaffRow>(
          "SELECT * FROM hotel_staff_pay WHERE property_id = $1 AND active ORDER BY id",
          [s.property.id],
        );
        const inputs = new Map(b.inputs.map((i) => [i.staffId, i]));
        for (const k of inputs.keys())
          if (!staff.some((x) => x.id === k)) throw fail.invalid("An input names someone who is not active staff here");
        const std = s.property.standard_day_hours * 60;
        const lines = [];
        for (const st of staff) {
          const shifts = await t.rows<{ minutes: number }>(
            "SELECT minutes FROM hotel_staff_shifts WHERE staff_id = $1 AND date BETWEEN $2 AND $3",
            [st.id, `${b.period}-01`, lastDay(b.period)],
          );
          const inp = inputs.get(st.id);
          const reg =
            inp?.regularHours != null
              ? Math.round(inp.regularHours * 60)
              : shifts.reduce((n, x) => n + Math.min(x.minutes, std), 0);
          const ot =
            inp?.overtimeHours != null
              ? Math.round(inp.overtimeHours * 60)
              : shifts.reduce((n, x) => n + Math.max(0, x.minutes - std), 0);
          const base = st.basis === "monthly" ? st.monthly_minor : Math.round((reg * st.hourly_minor) / 60);
          const overtime = Math.round((ot * st.hourly_minor * s.property.overtime_bp) / (60 * 10_000));
          const allowances = inp?.allowancesMinor ?? 0;
          lines.push({ st, reg, ot, base, overtime, allowances, gross: base + overtime + allowances });
        }
        const gross = lines.reduce((n, l) => n + l.gross, 0);
        if (gross <= 0) throw fail.conflict("Nothing to pay for this period — add staff pay records or hours");
        const rid = newId("hpr");
        const number = await nextNumber(t, s.orgId, "PAY", 5);
        await t.run(
          "INSERT INTO hotel_pay_runs (id, org_id, property_id, number, period, gross_minor, prepared_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [rid, s.orgId, s.property.id, number, b.period, gross, s.userId],
        );
        for (const l of lines)
          await t.run(
            `INSERT INTO hotel_pay_run_lines (run_id, staff_id, department, regular_minutes, overtime_minutes, base_minor,
               overtime_minor, allowances_minor, gross_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [rid, l.st.id, l.st.department, l.reg, l.ot, l.base, l.overtime, l.allowances, l.gross],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Pay run prepared",
          target: number,
          detail: `${b.period} · ${lines.length} staff`,
        });
        return rid;
      });
      return runOut(db, s, await runRow(db, s.property.id, id));
    },

    async approve(s: HotelScope, runId: string) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const r = await runRow(t, s.property.id, runId, true);
        if (r.status !== "draft") throw fail.conflict(`Pay run ${r.number} is already approved`);
        if (r.prepared_by === s.userId)
          throw fail.separationOfDuties("You prepared this pay run — someone else must approve it");
        const by = await t.rows<{ department: hotel.StaffDepartment; n: number }>(
          "SELECT department, sum(gross_minor)::bigint AS n FROM hotel_pay_run_lines WHERE run_id = $1 GROUP BY department",
          [runId],
        );
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "payroll",
          memo: `Pay run ${r.number} (${r.period}) — gross pay by department`,
          ref: `payrun:${r.id}`,
          lines: [
            ...DEPTS.map((dep) => dr(PAYROLL_ACCOUNT[dep], by.find((x) => x.department === dep)?.n ?? 0)),
            cr(ACC.wages, r.gross_minor),
          ],
        });
        await t.run("UPDATE hotel_pay_runs SET status = 'approved', approved_by = $2, journal_id = $3 WHERE id = $1", [
          r.id,
          s.userId,
          journalId,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Pay run approved",
          target: r.number,
          detail: `${r.period} · ${r.gross_minor}`,
        });
      });
      return runOut(db, s, await runRow(db, s.property.id, runId));
    },

    async distribute(s: HotelScope, b: z.output<typeof hotel.distribute.body>) {
      const id = newId("hds");
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        if (b.upTo > s.property.business_date)
          throw fail.invalid("Distribute what was collected up to the business date");
        await t.run("SELECT 1 FROM hotel_properties WHERE id = $1 FOR UPDATE", [s.property.id]);
        const last = await t.row<{ up_to: string }>(
          "SELECT max(up_to) AS up_to FROM hotel_distributions WHERE property_id = $1 AND kind = $2",
          [s.property.id, b.kind],
        );
        if (last?.up_to && b.upTo < last.up_to) throw fail.conflict(`Already distributed up to ${last.up_to}`);
        const account = b.kind === "tips" ? ACC.tips : ACC.serviceCharge;
        const shared = await t.row<{ n: number }>(
          "SELECT COALESCE(sum(pool_minor), 0)::bigint AS n FROM hotel_distributions WHERE property_id = $1 AND kind = $2",
          [s.property.id, b.kind],
        );
        const pool = (await accrued(t, s.property.id, account, b.upTo)) - (shared?.n ?? 0);
        if (pool <= 0) throw fail.conflict(`No ${b.kind === "tips" ? "tips" : "service charge"} left to distribute`);
        const staff = (
          await t.rows<StaffRow>(
            "SELECT * FROM hotel_staff_pay WHERE property_id = $1 AND active AND service_points > 0 ORDER BY name, id",
            [s.property.id],
          )
        ).filter((x) => !b.departments.length || b.departments.includes(x.department));
        if (!staff.length) throw fail.conflict("No active staff with points to share it among");
        const shares = shareOut(
          pool,
          staff.map((x) => x.service_points),
        );
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "payroll",
          memo: `${b.kind === "tips" ? "Tips" : "Service charge"} up to ${b.upTo} shared among ${staff.length} staff`,
          ref: `distribution:${id}`,
          lines: [dr(account, pool), cr(ACC.wages, pool)],
        });
        await t.run(
          "INSERT INTO hotel_distributions (id, org_id, property_id, kind, up_to, pool_minor, journal_id, prepared_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [id, s.orgId, s.property.id, b.kind, b.upTo, pool, journalId, s.userId],
        );
        for (const [i, x] of staff.entries())
          await t.run(
            "INSERT INTO hotel_distribution_lines (distribution_id, staff_id, points, amount_minor) VALUES ($1,$2,$3,$4)",
            [id, x.id, x.service_points, shares[i]],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.kind === "tips" ? "Tips distributed" : "Service charge distributed",
          target: id,
          detail: `${pool} among ${staff.length} staff`,
        });
      });
      return distributionOut(db, s, id);
    },

    async listDistributions(s: HotelScope) {
      const rows = await db.rows<{ id: string }>(
        "SELECT id FROM hotel_distributions WHERE property_id = $1 ORDER BY created_at, id",
        [s.property.id],
      );
      const distributions = [];
      for (const r of rows) distributions.push(await distributionOut(db, s, r.id));
      return { distributions };
    },
  };
}

export type PayrollService = ReturnType<typeof payrollService>;
