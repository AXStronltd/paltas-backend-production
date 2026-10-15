// HTTP only: the agency summary and listing performance.
import { agency } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { AgencyGate } from "../shared/access.js";
import type { ReportsService } from "./reports.service.js";

export function reportsRoutes(g: AgencyGate, S: ReportsService) {
  return [
    route(agency.summary, async (req) => S.summary(await g.agency(req, "agency.reports.read"), req.query)),
    route(agency.listingPerformance, async (req) =>
      S.listings(await g.listings(req, "agency.reports.read"), req.query),
    ),
  ];
}
