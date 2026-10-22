/** Bounded read-only platform metadata. Existing staff authentication/read policy applies. */
import type { admin, z } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { staffActor } from "./admin.service.js";

type Query = z.infer<typeof admin.platformRecords.query>;
const SOURCES = {
  properties: `SELECT id,org_id,'property'::text AS product,name,'recorded'::text AS status,created_at FROM pm_properties
    UNION ALL SELECT id,org_id,'developer',name,COALESCE(status,'recorded'),created_at FROM dev_projects
    UNION ALL SELECT id,org_id,'hotel',name,'recorded',created_at FROM hotel_properties
    UNION ALL SELECT id,org_id,'security',name,'recorded',created_at FROM sec_sites
    UNION ALL SELECT id,org_id,'agency',title,status,created_at FROM agency_listings`,
  bookings: `SELECT id,org_id,'agency'::text AS product,number AS name,status,created_at FROM agency_stays WHERE kind='booking'
    UNION ALL SELECT id,org_id,'hotel',number,CASE WHEN cancelled_reason IS NULL THEN 'recorded' ELSE 'cancelled' END,created_at FROM hotel_reservations`,
  documents: `SELECT id,org_id,'property'::text AS product,COALESCE(NULLIF(name,''),filename) AS name,'recorded'::text AS status,created_at FROM pm_documents
    UNION ALL SELECT id,org_id,'developer',filename,'recorded',created_at FROM dev_documents`,
};

export function dashboardService({ db, clock }: AppContext) {
  return {
    async insights(user: Parameters<typeof staffActor>[0], days: number) {
      staffActor(user);
      const now = clock.now();
      const from = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const to = now.toISOString().slice(0, 10);
      const [totals, timeline, countries] = await Promise.all([
        db.row<{
          properties: number;
          units: number;
          projects: number;
          hotels: number;
          listings: number;
          securitySites: number;
          bookings: number;
          documents: number;
          countries: number;
        }>(
          `SELECT (SELECT count(*)::int FROM pm_properties) AS properties,
           (SELECT count(*)::int FROM pm_units u WHERE NOT EXISTS (SELECT 1 FROM pm_buildings b WHERE b.id=u.building_id AND b.is_archived)) AS units,
           (SELECT count(*)::int FROM dev_projects) AS projects, (SELECT count(*)::int FROM hotel_properties) AS hotels,
           (SELECT count(*)::int FROM agency_listings) AS listings,(SELECT count(*)::int FROM sec_sites) AS "securitySites",
           ((SELECT count(*) FROM agency_stays WHERE kind='booking')+(SELECT count(*) FROM hotel_reservations))::int AS bookings,
           ((SELECT count(*) FROM pm_documents)+(SELECT count(*) FROM dev_documents))::int AS documents,
           (SELECT count(DISTINCT country)::int FROM organisations) AS countries`,
        ),
        db.rows<{ date: string; organisations: number; users: number; bookings: number }>(
          `WITH days AS (SELECT d::date AS day FROM generate_series($1::date,$2::date,'1 day') d),
           orgs AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS n FROM organisations WHERE created_at >= ($1::date AT TIME ZONE 'UTC') AND created_at < (($2::date+1) AT TIME ZONE 'UTC') GROUP BY 1),
           people AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS n FROM users WHERE staff_role IS NULL AND created_at >= ($1::date AT TIME ZONE 'UTC') AND created_at < (($2::date+1) AT TIME ZONE 'UTC') GROUP BY 1),
           booking_rows AS (SELECT created_at FROM agency_stays WHERE kind='booking' UNION ALL SELECT created_at FROM hotel_reservations),
           bookings AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS n FROM booking_rows WHERE created_at >= ($1::date AT TIME ZONE 'UTC') AND created_at < (($2::date+1) AT TIME ZONE 'UTC') GROUP BY 1)
           SELECT days.day::text AS date,COALESCE(orgs.n,0) AS organisations,COALESCE(people.n,0) AS users,COALESCE(bookings.n,0) AS bookings
           FROM days LEFT JOIN orgs USING(day) LEFT JOIN people USING(day) LEFT JOIN bookings USING(day) ORDER BY day`,
          [from, to],
        ),
        db.rows<{ country: string; organisations: number }>(
          "SELECT country,count(*)::int AS organisations FROM organisations GROUP BY country ORDER BY organisations DESC,country LIMIT 30",
        ),
      ]);
      if (!totals) throw new Error("Dashboard aggregate did not return a row");
      return { asOf: now.toISOString(), days, totals, timeline, countries };
    },
    async records(user: Parameters<typeof staffActor>[0], q: Query) {
      staffActor(user);
      // The SQL fragments are a compile-time allowlist; all user filters are parameters.
      const base = `WITH records AS (${SOURCES[q.kind]}) SELECT r.*,o.name AS org_name FROM records r JOIN organisations o ON o.id=r.org_id
        WHERE ($1::text IS NULL OR r.org_id=$1) AND ($2::text IS NULL OR r.product=$2)
        AND ($3::text='' OR strpos(lower(r.name||' '||r.id||' '||o.name),lower($3))>0)`;
      const params = [q.orgId ?? null, q.product ?? null, q.q?.trim() ?? ""];
      const [count, rows] = await Promise.all([
        db.row<{ n: number }>(`SELECT count(*)::int AS n FROM (${base}) filtered`, params),
        db.rows<{
          id: string;
          org_id: string;
          org_name: string;
          product: "property" | "developer" | "hotel" | "agency" | "security";
          name: string;
          status: string;
          created_at: string;
        }>(`${base} ORDER BY created_at DESC,product,id LIMIT $4 OFFSET $5`, [...params, q.limit, q.offset]),
      ]);
      return {
        total: count?.n ?? 0,
        records: rows.map((r) => ({
          id: r.id,
          orgId: r.org_id,
          orgName: r.org_name,
          product: r.product,
          name: r.name,
          status: r.status,
          createdAt: r.created_at,
        })),
      };
    },
  };
}
