// HTTP only: dashboards and reports.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate } from "../shared/gate.js";
import type { ReportsService } from "./reports.service.js";

export function reportsRoutes(access: PmAccess, R: ReportsService) {
  const g = gate(access);
  return [
    route(api.dashboard, async (req) =>
      R.dashboard(await g.org(req, ["property.reports.read", "property.read"]), req.query),
    ),
    route(api.agedReceivables, async (req) => R.aged(await g.org(req, "property.reports.read"))),
    route(api.rentRoll, async (req) => R.rentRoll(await g.org(req, "property.reports.read"), req.query.propertyId)),
    route(api.clientMoney, async (req) => R.clientMoney(await g.org(req, "property.reports.read"))),
  ];
}
