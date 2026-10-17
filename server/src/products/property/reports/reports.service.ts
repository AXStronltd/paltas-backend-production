/*
 * Dashboards and reports. Figures are computed from the records (units, leases, invoices, allocations, payments,
 * deposits) and every money figure is checked against the ledger: receivables 1120, deposits held 2300, owner funds
 * 2250 and tenant credits 2310 (Property Management postings and PM migration opening balances).
 */
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { Db } from "../../../db/database.js";
import { ACC } from "../accounts.js";
import type { PmDeps } from "../deps.js";
import { ownerFunds } from "../shared/owner-funds.js";
import { pmBalance } from "../shared/posting.js";
import * as R from "../shared/records.js";
import { addDays, daysBetween, lastDay, sum } from "../shared/util.js";

const check = (recordsMinor: number, ledgerMinor: number) => ({
  recordsMinor,
  ledgerMinor,
  agrees: recordsMinor === ledgerMinor,
});

/** Organisation-wide figures from the records, to compare with the ledger. */
async function recordTotals(db: Db, orgId: string) {
  const r = await db.row<{ receivables: number; deposits: number; credits: number }>(
    `SELECT
       (SELECT COALESCE(sum(i.amount_minor), 0) FROM pm_invoices i WHERE i.org_id = $1)
       - (SELECT COALESCE(sum(a.amount_minor), 0) FROM pm_effective_allocations a WHERE a.org_id = $1) AS receivables,
       (SELECT COALESCE(sum(o.amount_minor), 0) FROM pm_opening_deposits o WHERE o.org_id = $1)
       + (SELECT COALESCE(sum(a.amount_minor), 0) FROM pm_effective_allocations a JOIN pm_invoices i ON i.id = a.invoice_id
          WHERE a.org_id = $1 AND i.kind = 'deposit' AND a.source <> 'credit_note')
       - (SELECT COALESCE(sum(r.held_minor), 0) FROM pm_deposit_refunds r WHERE r.org_id = $1 AND r.status = 'approved')
         AS deposits,
       (SELECT COALESCE(sum(p.amount_minor), 0) FROM pm_effective_payments p WHERE p.org_id = $1)
       - (SELECT COALESCE(sum(a.amount_minor), 0) FROM pm_effective_allocations a WHERE a.org_id = $1 AND a.source IN ('payment', 'credit'))
         AS credits`,
    [orgId],
  );
  return { receivables: r?.receivables ?? 0, deposits: r?.deposits ?? 0, credits: r?.credits ?? 0 };
}

export function reportsService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  async function ledgerChecks(orgId: string) {
    const totals = await recordTotals(db, orgId);
    const owners = await ownerFunds(db, orgId, "9999-12-31");
    return {
      receivables: check(totals.receivables, await pmBalance(db, orgId, ACC.receivables, "9999-12-31")),
      depositsHeld: check(totals.deposits, -(await pmBalance(db, orgId, ACC.depositsHeld, "9999-12-31"))),
      ownerFunds: check(
        sum([...owners.values()], (v) => v),
        -(await pmBalance(db, orgId, ACC.ownerFunds, "9999-12-31")),
      ),
      tenantCredits: check(totals.credits, -(await pmBalance(db, orgId, ACC.tenantCredits, "9999-12-31"))),
    };
  }

  return {
    async dashboard(
      s: OrgScope,
      f: { month?: string | undefined; propertyId?: string | undefined },
    ): Promise<P.Dashboard> {
      const month = f.month ?? s.today.slice(0, 7);
      const from = `${month}-01`;
      const to = lastDay(month);
      const pid = f.propertyId ?? null;
      if (pid) await R.propertyRow(db, s.orgId, pid);
      const occ = await db.row<{ units: number; let: number; off: number }>(
        `SELECT count(*)::int AS units,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pm_leases l WHERE l.unit_id = u.id AND l.status = 'active'
             AND l.start_date <= $3 AND (l.end_date IS NULL OR l.end_date >= $3)))::int AS let,
           count(*) FILTER (WHERE u.status = 'off_market')::int AS off
         FROM pm_units u WHERE u.org_id = $1 AND ($2::text IS NULL OR u.property_id = $2)`,
        [s.orgId, pid, s.today],
      );
      const units = occ?.units ?? 0;
      const lettable = units - (occ?.off ?? 0);
      const billed = await db.row<{ n: number }>(
        `SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM pm_invoices WHERE org_id = $1 AND kind <> 'opening'
           AND kind <> 'deposit' AND issue_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR property_id = $4)`,
        [s.orgId, from, to, pid],
      );
      const collected = await db.row<{ n: number }>(
        `SELECT COALESCE(sum(x.n),0)::bigint AS n FROM (
          SELECT a.amount_minor AS n FROM pm_allocations a JOIN pm_invoices i ON i.id=a.invoice_id
          WHERE a.org_id=$1 AND a.source<>'credit_note' AND i.kind<>'deposit' AND a.date BETWEEN $2 AND $3 AND ($4::text IS NULL OR i.property_id=$4)
          UNION ALL
          SELECT -a.amount_minor AS n FROM pm_allocations a JOIN pm_invoices i ON i.id=a.invoice_id JOIN pm_payment_reversals r ON r.payment_id=a.payment_id
          WHERE a.org_id=$1 AND r.approved_by IS NOT NULL AND i.kind<>'deposit' AND r.date BETWEEN $2 AND $3 AND ($4::text IS NULL OR i.property_id=$4)
         ) x`,
        [s.orgId, from, to, pid],
      );
      const open = (await R.invoiceRows(db, s.orgId, "($2::text IS NULL OR i.property_id = $2)", [pid])).filter(
        (i) => R.balanceOf(i) > 0,
      );
      const overdue = open.filter((i) => i.due_date < s.today);
      const expiring = await db.row<{ n: number }>(
        `SELECT count(*)::int AS n FROM pm_leases WHERE org_id = $1 AND status = 'active' AND end_date BETWEEN $2 AND $3
           AND ($4::text IS NULL OR property_id = $4)`,
        [s.orgId, s.today, addDays(s.today, 60), pid],
      );
      const maint = await db.row<{ n: number }>(
        `SELECT count(*)::int AS n FROM pm_maintenance_requests WHERE org_id = $1 AND status IN ('open', 'assigned')
           AND ($2::text IS NULL OR property_id = $2)`,
        [s.orgId, pid],
      );
      const billedN = billed?.n ?? 0;
      const collectedN = collected?.n ?? 0;
      const checks = await ledgerChecks(s.orgId);
      return {
        asOf: s.today,
        month,
        propertyId: pid,
        occupancy: {
          units,
          let: occ?.let ?? 0,
          vacant: lettable - (occ?.let ?? 0),
          offMarket: occ?.off ?? 0,
          ratePct: lettable ? Math.round(((occ?.let ?? 0) * 10_000) / lettable) / 100 : 0,
        },
        billedMinor: billedN,
        collectedMinor: collectedN,
        collectionRatePct: billedN ? Math.round((collectedN * 10_000) / billedN) / 100 : 0,
        arrears: {
          totalMinor: sum(open, (i) => R.balanceOf(i)),
          overdueMinor: sum(overdue, (i) => R.balanceOf(i)),
          tenantsInArrears: new Set(overdue.map((i) => i.tenant_id)).size,
        },
        leasesExpiring60Days: expiring?.n ?? 0,
        openMaintenance: maint?.n ?? 0,
        ledger: checks,
      };
    },

    async aged(s: OrgScope) {
      const open = (await R.invoiceRows(db, s.orgId)).filter((i) => R.balanceOf(i) > 0);
      const byTenant = new Map<string, { name: string; b: number[] }>();
      for (const i of open) {
        const days = daysBetween(i.due_date, s.today);
        const k = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
        const e = byTenant.get(i.tenant_id) ?? { name: i.tenant_name, b: [0, 0, 0, 0, 0] };
        e.b[k] = (e.b[k] ?? 0) + R.balanceOf(i);
        byTenant.set(i.tenant_id, e);
      }
      const rows = [];
      for (const [tenantId, e] of [...byTenant].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
        const [c = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0] = e.b;
        rows.push({
          tenantId,
          tenantName: e.name,
          currentMinor: c,
          d1to30Minor: d1,
          d31to60Minor: d2,
          d61to90Minor: d3,
          over90Minor: d4,
          totalMinor: c + d1 + d2 + d3 + d4,
          creditMinor: Math.max(0, await R.tenantCredit(db, s.orgId, tenantId)),
        });
      }
      const totals = {
        currentMinor: sum(rows, (r) => r.currentMinor),
        d1to30Minor: sum(rows, (r) => r.d1to30Minor),
        d31to60Minor: sum(rows, (r) => r.d31to60Minor),
        d61to90Minor: sum(rows, (r) => r.d61to90Minor),
        over90Minor: sum(rows, (r) => r.over90Minor),
        totalMinor: sum(rows, (r) => r.totalMinor),
      };
      return {
        asOf: s.today,
        rows,
        totals,
        ledger: check(totals.totalMinor, await pmBalance(db, s.orgId, ACC.receivables, "9999-12-31")),
      };
    },

    async rentRoll(s: OrgScope, propertyId?: string) {
      if (propertyId) await R.propertyRow(db, s.orgId, propertyId);
      const units = await db.rows<R.UnitRow>(
        "SELECT * FROM pm_units WHERE org_id = $1 AND ($2::text IS NULL OR property_id = $2) ORDER BY property_id, upper(unit_no)",
        [s.orgId, propertyId ?? null],
      );
      const leases = await R.leaseRows(
        db,
        s.orgId,
        "l.status = 'active' AND l.start_date <= $2 AND (l.end_date IS NULL OR l.end_date >= $2)",
        [s.today],
      );
      const open = (await R.invoiceRows(db, s.orgId)).filter((i) => R.balanceOf(i) > 0);
      const rows = [];
      for (const u of units) {
        const l = leases.find((x) => x.unit_id === u.id);
        rows.push({
          unitId: u.id,
          unitNo: u.unit_no,
          propertyId: u.property_id,
          status: (u.status === "off_market" ? "off_market" : l ? "let" : "vacant") as "let" | "vacant" | "off_market",
          leaseId: l?.id ?? null,
          tenantId: l?.tenant_id ?? null,
          tenantName: l?.tenant_name ?? null,
          rentMinor: l ? await R.rentOn(db, l, s.today) : 0,
          marketRentMinor: u.market_rent_minor,
          leaseEnd: l?.end_date ?? null,
          balanceMinor: l
            ? sum(
                open.filter((i) => i.lease_id === l.id),
                (i) => R.balanceOf(i),
              )
            : 0,
        });
      }
      return {
        asOf: s.today,
        rows,
        totals: { rentMinor: sum(rows, (r) => r.rentMinor), balanceMinor: sum(rows, (r) => r.balanceMinor) },
      };
    },

    async clientMoney(s: OrgScope) {
      const end = "9999-12-31";
      const cash = await pmBalance(db, s.orgId, ACC.clientBank, end);
      const owners = -(await pmBalance(db, s.orgId, ACC.ownerFunds, end));
      const deposits = -(await pmBalance(db, s.orgId, ACC.depositsHeld, end));
      const credits = -(await pmBalance(db, s.orgId, ACC.tenantCredits, end));
      const per = await ownerFunds(db, s.orgId, end);
      const names = per.size
        ? await db.rows<{ id: string; name: string }>("SELECT id, name FROM contacts WHERE id = ANY($1)", [
            [...per.keys()],
          ])
        : [];
      const assigned = sum([...per.values()], (v) => v);
      return {
        asOf: s.today,
        clientCashMinor: cash,
        ownerFundsMinor: owners,
        depositsHeldMinor: deposits,
        tenantCreditsMinor: credits,
        surplusMinor: cash - owners - deposits - credits,
        covered: cash >= owners + deposits + credits,
        ownersAgree: assigned === owners,
        owners: [...per].map(([ownerId, fundsMinor]) => ({
          ownerId,
          name: names.find((n) => n.id === ownerId)?.name ?? ownerId,
          fundsMinor,
        })),
        unassignedOwnerFundsMinor: owners - assigned,
      };
    },
  };
}

export type ReportsService = ReturnType<typeof reportsService>;
