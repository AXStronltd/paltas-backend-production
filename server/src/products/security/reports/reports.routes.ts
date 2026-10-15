// HTTP only: dashboard, KPIs, site profitability, client service reports, the client portal and integrations.
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { SecurityAccess } from "../shared/access.js";
import type { ReportsService } from "./reports.service.js";

export function reportsRoutes(a: SecurityAccess, R: ReportsService) {
  return [
    route(security.dashboard, async (req) => R.dashboard(await a.scope(req, "security.read"))),
    route(security.financeKpis, async (req) =>
      R.financeKpis(await a.scope(req, "security.reports.read"), req.query.from, req.query.to),
    ),
    route(security.siteProfit, async (req) =>
      R.siteProfit(await a.scope(req, "security.reports.read"), req.query.from, req.query.to),
    ),
    route(security.clientReport, async (req) =>
      R.clientReport(
        await a.scopeAny(req, ["security.reports.read", "security.portal"]),
        req.params.clientId,
        req.query.month,
      ),
    ),
    route(security.portal, async (req) => R.portal(await a.scope(req, "security.portal"), req.query.month)),
    route(security.integrations, async (req) => {
      await a.scope(req, "security.read");
      return R.integrations();
    }),
  ];
}
