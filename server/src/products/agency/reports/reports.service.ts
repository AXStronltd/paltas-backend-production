/*
 * The agency summary: listings by status, the marketplace funnel, stays, and money read from the ledger itself
 * (never from the agency tables), so the figures are the books' figures.
 */
import type { agency } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { fail } from "../../../http/errors.js";
import { ACC, balance } from "../accounts.js";
import type { AgencyDeps } from "../deps.js";

export function reportsService(d: AgencyDeps) {
  const { db } = d.core;

  return {
    async summary(s: OrgScope, q: { from?: string | undefined; to?: string | undefined }) {
      const to = q.to ?? s.today;
      const from = q.from ?? to.slice(0, 8) + "01";
      if (from > to) throw fail.invalid("The period starts after it ends");
      const P = [s.orgId, from, to];
      const inPeriod = "org_id = $1 AND created_at::date BETWEEN $2 AND $3";
      const count = async (sql: string) => (await db.row<{ n: number }>(sql, P))?.n ?? 0;
      const byStatus = await db.rows<{ status: string; n: number }>(
        "SELECT status, count(*)::int AS n FROM agency_listings WHERE org_id = $1 GROUP BY status",
        [s.orgId],
      );
      const byStage = await db.rows<{ stage: string; n: number }>(
        `SELECT stage, count(*)::int AS n FROM agency_leads WHERE ${inPeriod} GROUP BY stage`,
        P,
      );
      const stays = await db.row<{ bookings: number; nights: number; completed: number }>(
        `SELECT count(*)::int AS bookings, COALESCE(sum(check_out - check_in), 0)::int AS nights,
                count(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM agency_stays WHERE org_id = $1 AND kind = 'booking' AND status IN ('confirmed', 'checked_in', 'completed')
           AND check_in BETWEEN $2 AND $3`,
        P,
      );
      const credit = async (code: string) => -(await balance(db, s.orgId, code, to));
      return {
        from,
        to,
        listings: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
        funnel: {
          enquiries: await count(`SELECT count(*)::int AS n FROM agency_enquiries WHERE ${inPeriod}`),
          leads: await count(`SELECT count(*)::int AS n FROM agency_leads WHERE ${inPeriod}`),
          viewings: await count(
            `SELECT count(*)::int AS n FROM agency_viewings WHERE ${inPeriod} AND status <> 'cancelled'`,
          ),
          offers: await count(`SELECT count(*)::int AS n FROM agency_offers WHERE ${inPeriod}`),
          won: await count(`SELECT count(*)::int AS n FROM agency_leads WHERE ${inPeriod} AND stage = 'won'`),
        },
        leadsByStage: Object.fromEntries(byStage.map((r) => [r.stage, r.n])),
        stays: { bookings: stays?.bookings ?? 0, nights: stays?.nights ?? 0, completed: stays?.completed ?? 0 },
        ledger: {
          commissionIncomeMinor: await credit(ACC.commissionIncome),
          commissionReceivableMinor: await balance(db, s.orgId, ACC.commissionReceivable, to),
          stayRevenueMinor: await credit(ACC.stayRevenue),
          managementFeesMinor: await credit(ACC.managementFees),
          ownerPayableMinor: await credit(ACC.ownerPayable),
          guestDepositsMinor: await credit(ACC.guestDeposits),
          guestReceivableMinor: await balance(db, s.orgId, ACC.guestReceivable, to),
        },
      };
    },

    async listings(s: OrgScope, q: { from?: string | undefined; to?: string | undefined }) {
      const to = q.to ?? s.today;
      const from = q.from ?? to.slice(0, 8) + "01";
      if (from > to) throw fail.invalid("The period starts after it ends");
      const rows = await db.rows<{
        id: string;
        number: string;
        title: string;
        status: string;
        views: number;
        enquiries: number;
        leads: number;
        viewings: number;
        offers: number;
        closed: boolean;
      }>(
        `SELECT l.id, l.number, l.title, l.status,
           (SELECT COALESCE(sum(v.views), 0)::int FROM agency_listing_views v WHERE v.listing_id = l.id AND v.date BETWEEN $2 AND $3) AS views,
           (SELECT count(*)::int FROM agency_enquiries e WHERE e.listing_id = l.id AND e.created_at::date BETWEEN $2 AND $3) AS enquiries,
           (SELECT count(*)::int FROM agency_leads d WHERE d.listing_id = l.id AND d.created_at::date BETWEEN $2 AND $3) AS leads,
           (SELECT count(*)::int FROM agency_viewings w WHERE w.listing_id = l.id AND w.status <> 'cancelled' AND w.date BETWEEN $2 AND $3) AS viewings,
           (SELECT count(*)::int FROM agency_offers o WHERE o.listing_id = l.id AND o.created_at::date BETWEEN $2 AND $3) AS offers,
           EXISTS (SELECT 1 FROM agency_deals x WHERE x.listing_id = l.id) AS closed
         FROM agency_listings l WHERE l.org_id = $1 ORDER BY l.number`,
        [s.orgId, from, to],
      );
      const sources = await db.rows<{ source: string; leads: number; won: number }>(
        `SELECT source, count(*)::int AS leads, count(*) FILTER (WHERE stage = 'won')::int AS won
         FROM agency_leads WHERE org_id = $1 AND created_at::date BETWEEN $2 AND $3 GROUP BY source ORDER BY source`,
        [s.orgId, from, to],
      );
      return {
        from,
        to,
        listings: rows.map((r) => ({
          listingId: r.id,
          number: r.number,
          title: r.title,
          status: r.status as agency.Listing["status"],
          views: r.views,
          enquiries: r.enquiries,
          leads: r.leads,
          viewings: r.viewings,
          offers: r.offers,
          closed: r.closed,
          enquiryRatePct: r.views ? Math.round((r.enquiries / r.views) * 1000) / 10 : null,
        })),
        sources,
      };
    },
  };
}

export type ReportsService = ReturnType<typeof reportsService>;
