/*
 * Security reports. Money figures are read from the SAME ledger postings Finance sees (journals linked through
 * sec_ledger_links), so the KPIs, site profitability and the client account always equal the ledger. Operational
 * figures (coverage, patrol compliance, response times) are read from the roster, patrols and alarms.
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import type { SecurityDeps } from "../deps.js";
import { patrolOut } from "../field/field.service.js";
import type { BillingService } from "../finance/billing.service.js";
import type { ContractRow } from "../setup/setup.service.js";
import { visibleClients } from "../shared/access.js";
import { daysBetween, findClient, fromBp, minutesBetween, orgTimezone } from "../shared/util.js";
import type { WorkforceService } from "../workforce/workforce.service.js";

type ClientReportOut = z.infer<typeof security.ClientReport>;
type Alert = z.infer<typeof security.Alert>;

const lastDayOf = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/** debit − credit per account over security postings dated in [from, to] (from null: since the beginning). */
async function ledgerNet(db: Db, orgId: string, from: string | null, to: string, kinds?: string[]) {
  const rows = await db.rows<{ code: string; site_id: string | null; n: number }>(
    `SELECT l.account_code AS code, k.site_id, sum(l.debit_minor - l.credit_minor)::bigint AS n
     FROM sec_ledger_links k JOIN journal_entries e ON e.id = k.journal_id AND e.status = 'posted'
     JOIN journal_lines l ON l.entry_id = e.id
     WHERE k.org_id = $1 AND ($2::date IS NULL OR k.date >= $2) AND k.date <= $3
       AND ($4::text[] IS NULL OR k.kind = ANY($4))
     GROUP BY 1, 2`,
    [orgId, from, to, kinds ?? null],
  );
  const total = (codes: string[]) => rows.filter((r) => codes.includes(r.code)).reduce((n, r) => n + r.n, 0);
  const bySite = (codes: string[]) => {
    const m = new Map<string | null, number>();
    for (const r of rows.filter((x) => codes.includes(x.code))) m.set(r.site_id, (m.get(r.site_id) ?? 0) + r.n);
    return m;
  };
  return { total, bySite };
}

const REVENUE = ["4810", "4820", "4830", "4840"];
const DIRECT = ["5830", "5840", "5850", "5860", "5870"];

export function reportsService(d: SecurityDeps, deps: { billing: BillingService; workforce: WorkforceService }) {
  const { db } = d.core;
  const { adapters } = d;

  async function clientReport(s: OrgScope, clientId: string, month: string): Promise<ClientReportOut> {
    const c = await findClient(db, s.orgId, clientId);
    const from = `${month}-01`;
    const to = lastDayOf(month);
    const tz = await orgTimezone(db, s.orgId);
    const sites = await db.rows<{ id: string; name: string }>(
      "SELECT id, name FROM sec_sites WHERE org_id = $1 AND client_id = $2 ORDER BY name",
      [s.orgId, clientId],
    );
    const out: ClientReportOut["sites"] = [];
    for (const site of sites) {
      const sh = await db.row<{ total: number; covered: number; no_shows: number }>(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE clock_in IS NOT NULL OR adjusted_in_at IS NOT NULL)::int AS covered,
           count(*) FILTER (WHERE no_show)::int AS no_shows
         FROM sec_shifts WHERE site_id = $1 AND status <> 'cancelled' AND (starts_at AT TIME ZONE $2)::date BETWEEN $3 AND $4`,
        [site.id, tz, from, to],
      );
      const patrols = await db.rows<{ id: string }>(
        `SELECT id FROM sec_patrols WHERE site_id = $1 AND closed_at IS NOT NULL
           AND (started_at AT TIME ZONE $2)::date BETWEEN $3 AND $4`,
        [site.id, tz, from, to],
      );
      let onTime = 0;
      let expected = 0;
      for (const p of patrols) {
        const r = await patrolOut(db, s.orgId, p.id);
        expected += r.checkpoints.length;
        onTime += r.checkpoints.filter((x) => x.state === "on_time").length;
      }
      const inc = await db.row<{ n: number; high: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE severity = 'high')::int AS high FROM sec_incidents
         WHERE site_id = $1 AND (occurred_at AT TIME ZONE $2)::date BETWEEN $3 AND $4`,
        [site.id, tz, from, to],
      );
      const alarms = await db.rows<{ raised_at: string; acknowledged_at: string | null }>(
        `SELECT raised_at, acknowledged_at FROM sec_alarms WHERE site_id = $1
           AND (raised_at AT TIME ZONE $2)::date BETWEEN $3 AND $4`,
        [site.id, tz, from, to],
      );
      const times = alarms.flatMap((a) => (a.acknowledged_at ? [minutesBetween(a.raised_at, a.acknowledged_at)] : []));
      const avg = times.length ? Math.round((times.reduce((n, m) => n + m, 0) / times.length) * 10) / 10 : null;
      const k = await db.row<ContractRow>(
        `SELECT * FROM sec_contracts WHERE site_id = $1 AND start_date <= $3 AND (end_date IS NULL OR end_date >= $2)
         ORDER BY start_date DESC LIMIT 1`,
        [site.id, from, to],
      );
      const patrolPct = pct(onTime, expected);
      const target = k ? fromBp(k.patrol_target_bp) : null;
      out.push({
        siteId: site.id,
        name: site.name,
        shiftsRequired: sh?.total ?? 0,
        shiftsCovered: sh?.covered ?? 0,
        noShows: sh?.no_shows ?? 0,
        coveragePct: pct(sh?.covered ?? 0, sh?.total ?? 0),
        patrolCompliancePct: patrolPct,
        patrolTargetPct: target,
        patrolTargetMet: patrolPct === null || target === null ? null : patrolPct >= target,
        incidents: inc?.n ?? 0,
        highSeverityIncidents: inc?.high ?? 0,
        alarms: alarms.length,
        averageResponseMinutes: avg,
        responseTargetMinutes: k?.response_minutes ?? null,
        responseTargetMet: avg === null || !k ? null : avg <= k.response_minutes,
      });
    }
    const money = await db.row<{ invoiced: number; paid: number }>(
      `SELECT
         COALESCE((SELECT sum(total_minor) FROM sec_invoices WHERE client_id = $1 AND date BETWEEN $2 AND $3), 0)::bigint AS invoiced,
         COALESCE((SELECT sum(amount_minor) FROM sec_receipts WHERE client_id = $1 AND date BETWEEN $2 AND $3), 0)::bigint AS paid`,
      [clientId, from, to],
    );
    const statement = await deps.billing.statement(s, clientId);
    return {
      clientId: c.id,
      name: c.name,
      month,
      sites: out,
      invoicedMinor: money?.invoiced ?? 0,
      paidMinor: money?.paid ?? 0,
      balanceMinor: statement.balanceMinor,
    };
  }

  /** The client ids this member may see in a report, refusing anyone else's client (as "not found"). */
  async function checkClient(s: OrgScope, clientId: string) {
    const visible = await visibleClients(db, s);
    if (visible !== null && !visible.includes(clientId)) throw fail.notFound("Client not found");
  }

  return {
    async dashboard(s: OrgScope) {
      const tz = await orgTimezone(db, s.orgId);
      const now = d.ctx.clock.now().toISOString();
      const one = async (sql: string, params: unknown[]) => (await db.row<{ n: number }>(sql, params))?.n ?? 0;
      const guardsOnDuty = await one(
        `SELECT count(DISTINCT guard_id)::int AS n FROM sec_shifts WHERE org_id = $1 AND status = 'assigned'
           AND clock_in IS NOT NULL AND clock_out IS NULL`,
        [s.orgId],
      );
      const shiftsNow = await one(
        "SELECT count(*)::int AS n FROM sec_shifts WHERE org_id = $1 AND status <> 'cancelled' AND starts_at <= $2 AND ends_at > $2",
        [s.orgId, now],
      );
      const openShifts = await db.rows<{ id: string; starts_at: string }>(
        `SELECT id, starts_at FROM sec_shifts WHERE org_id = $1 AND status = 'open' AND starts_at >= $2
           AND starts_at < $2::timestamptz + interval '7 days' ORDER BY starts_at`,
        [s.orgId, now],
      );
      const incidents = await db.row<{ today: number; open: number; high: number }>(
        `SELECT count(*) FILTER (WHERE (occurred_at AT TIME ZONE $2)::date = $3)::int AS today,
           count(*) FILTER (WHERE status <> 'closed')::int AS open,
           count(*) FILTER (WHERE status <> 'closed' AND severity = 'high')::int AS high
         FROM sec_incidents WHERE org_id = $1`,
        [s.orgId, tz, s.today],
      );
      const patrols = await db.rows<{ id: string }>(
        "SELECT id FROM sec_patrols WHERE org_id = $1 AND closed_at IS NOT NULL AND closed_at >= $2::timestamptz - interval '7 days'",
        [s.orgId, now],
      );
      let onTime = 0;
      let expected = 0;
      for (const p of patrols) {
        const r = await patrolOut(db, s.orgId, p.id);
        expected += r.checkpoints.length;
        onTime += r.checkpoints.filter((x) => x.state === "on_time").length;
      }
      const alarms = await db.rows<{ number: string; source: string; detail: string }>(
        "SELECT number, source, detail FROM sec_alarms WHERE org_id = $1 AND status <> 'resolved' ORDER BY raised_at DESC",
        [s.orgId],
      );
      const visitorsOnSite = await one(
        "SELECT count(*)::int AS n FROM sec_visitors WHERE org_id = $1 AND status = 'on_site'",
        [s.orgId],
      );
      const hits = await one(
        "SELECT count(*)::int AS n FROM sec_watchlist_hits WHERE org_id = $1 AND (at AT TIME ZONE $2)::date = $3",
        [s.orgId, tz, s.today],
      );
      const overdue = (await deps.billing.listInvoices(s, undefined, "true")).invoices.filter(
        (i) => i.state === "overdue",
      );
      const expiries = await deps.workforce.expiryAlerts(s);
      const alerts: Alert[] = [
        ...alarms.map((a) => ({
          kind: (a.source === "no_show"
            ? "no_show"
            : a.source === "missed_checkpoint"
              ? "missed_checkpoint"
              : "alarm") as Alert["kind"],
          severity: (a.source === "missed_checkpoint" || a.source === "manual"
            ? "warning"
            : "critical") as Alert["severity"],
          title: a.detail,
          ref: a.number,
        })),
        ...expiries.alerts.map((x) => ({
          kind: x.kind,
          severity: (x.daysLeft <= 14 ? "critical" : "warning") as Alert["severity"],
          title: `${x.guardName}: ${x.item} ${x.daysLeft < 0 ? "expired" : `expires in ${x.daysLeft} day(s)`}`,
          ref: x.guardId,
        })),
        ...openShifts
          .filter((x) => new Date(x.starts_at).getTime() - new Date(now).getTime() < 24 * 3_600_000)
          .map((x) => ({
            kind: "open_shift" as const,
            severity: "warning" as const,
            title: `Open shift at ${x.starts_at}`,
            ref: x.id,
          })),
        ...overdue.map((i) => ({
          kind: "overdue" as const,
          severity: "notice" as const,
          title: `${i.number} overdue ${daysBetween(i.dueDate, s.today)} day(s)`,
          ref: i.id,
        })),
      ];
      return {
        date: s.today,
        guardsOnDuty,
        shiftsNow,
        openShiftsNext7Days: openShifts.length,
        incidentsToday: incidents?.today ?? 0,
        openIncidents: incidents?.open ?? 0,
        highSeverityOpen: incidents?.high ?? 0,
        patrolCompliancePct: pct(onTime, expected),
        activeAlarms: alarms.length,
        visitorsOnSite,
        watchlistHitsToday: hits,
        alerts,
      };
    },

    async financeKpis(s: OrgScope, from: string, to: string) {
      if (from > to) throw fail.invalid("The start date is after the end date");
      const p = await ledgerNet(db, s.orgId, from, to);
      const cash = await ledgerNet(db, s.orgId, from, to, ["receipt"]);
      const sales = await ledgerNet(db, s.orgId, from, to, ["invoice"]);
      const ar = await ledgerNet(db, s.orgId, null, to);
      const revenue = -p.total(REVENUE);
      const wages = p.total(["5810"]);
      const employer = p.total(["5820"]);
      const direct = p.total(DIRECT);
      return {
        from,
        to,
        contractRevenueMinor: -p.total(["4810"]),
        extraCoverRevenueMinor: -p.total(["4820"]),
        lateFeeRevenueMinor: -p.total(["4830"]),
        otherRevenueMinor: -p.total(["4840"]),
        revenueMinor: revenue,
        wagesMinor: wages,
        employerContributionsMinor: employer,
        directCostsMinor: direct,
        grossProfitMinor: revenue - wages - employer - direct,
        vatChargedMinor: -sales.total(["2100"]),
        cashReceivedMinor: cash.total(["1000"]),
        receivablesMinor: ar.total(["1100"]),
      };
    },

    async siteProfit(s: OrgScope, from: string, to: string) {
      if (from > to) throw fail.invalid("The start date is after the end date");
      const p = await ledgerNet(db, s.orgId, from, to);
      const revenue = p.bySite(REVENUE);
      const direct = p.bySite(DIRECT);
      const payroll = new Map<string | null, number>();
      const sitePay = await db.rows<{ site_id: string; n: number }>(
        `SELECT c.site_id, sum(c.gross_minor + c.employer_minor)::bigint AS n FROM sec_payroll_site_costs c
         JOIN sec_payroll_runs r ON r.id = c.run_id JOIN sec_ledger_links k ON k.journal_id = r.journal_id
         WHERE r.org_id = $1 AND k.date BETWEEN $2 AND $3 GROUP BY 1`,
        [s.orgId, from, to],
      );
      for (const r of sitePay) payroll.set(r.site_id, r.n);
      const names = new Map(
        (
          await db.rows<{ id: string; name: string }>("SELECT id, name FROM sec_sites WHERE org_id = $1", [s.orgId])
        ).map((x) => [x.id, x.name]),
      );
      // sites by name; postings not tied to a site last
      const keys = [...new Set([...revenue.keys(), ...direct.keys(), ...payroll.keys()])].sort((a, b) =>
        a === null ? 1 : b === null ? -1 : (names.get(a) ?? "").localeCompare(names.get(b) ?? ""),
      );
      const sites = keys.map((k) => {
        const rev = -(revenue.get(k) ?? 0);
        const pay = payroll.get(k) ?? 0;
        const dc = direct.get(k) ?? 0;
        return {
          siteId: k,
          name: k === null ? "Not tied to a site" : (names.get(k) ?? k),
          revenueMinor: rev,
          payrollCostMinor: pay,
          directCostMinor: dc,
          profitMinor: rev - pay - dc,
        };
      });
      const total = {
        revenueMinor: -p.total(REVENUE),
        payrollCostMinor: p.total(["5810", "5820"]),
        directCostMinor: p.total(DIRECT),
        profitMinor: 0,
      };
      total.profitMinor = total.revenueMinor - total.payrollCostMinor - total.directCostMinor;
      return { sites, total };
    },

    async clientReport(s: OrgScope, clientId: string, month: string) {
      await checkClient(s, clientId);
      return clientReport(s, clientId, month);
    },

    async portal(s: OrgScope, month: string) {
      const visible = await visibleClients(db, s);
      if (visible === null) throw fail.forbidden("The client portal is for client members; staff use the reports");
      const clients = [];
      for (const id of [...visible].sort()) {
        clients.push({
          report: await clientReport(s, id, month),
          invoices: (await deps.billing.listInvoices(s, id)).invoices,
          receipts: (await deps.billing.listReceipts(s, id)).receipts,
        });
      }
      return { clients };
    },

    integrations() {
      return {
        accessControl: adapters.accessControl.state,
        cctv: adapters.cctv.state,
        alarmMonitoring: adapters.alarmMonitoring.state,
        messaging: adapters.messaging.state,
        biometrics: adapters.biometrics.state,
        taxAuthority: adapters.taxAuthority.state,
        payrollPayout: adapters.payrollPayout.state,
      };
    },
  };
}

export type ReportsService = ReturnType<typeof reportsService>;
