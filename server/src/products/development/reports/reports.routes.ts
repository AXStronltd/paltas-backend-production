// HTTP only: dashboard and the approvals inbox.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { DevGate } from "../shared/access.js";
import type { ReportsService } from "./reports.service.js";

export function reportsRoutes(g: DevGate, R: ReportsService) {
  return [
    route(api.dashboard, async (req) => R.dashboard(await g(req, "developer.reports"), req.query.projectId)),
    route(api.approvals, async (req) => R.approvals(await g(req, "developer.work"))),
  ];
}
