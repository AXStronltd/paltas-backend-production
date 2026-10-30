import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, FINANCE } from "../shared/gate.js";
import type { ReportSchedulesService } from "./report-schedules.service.js";
export function reportScheduleRoutes(access: PmAccess, R: ReportSchedulesService) {
  const g = gate(access);
  const write = async (req: Parameters<typeof g.org>[0]) => {
    await g.org(req, "property.reports.read");
    return g.org(req, "property.billing", FINANCE);
  };
  return [
    route(api.listCollectionReportSchedules, async (r) => R.list(await g.org(r, "property.reports.read"), r.query)),
    route(api.createCollectionReportSchedule, async (r) => R.create(await write(r), r.body)),
    route(api.updateCollectionReportSchedule, async (r) => R.update(await write(r), r.params.reportScheduleId, r.body)),
    route(api.runCollectionReportSchedule, async (r) =>
      R.generate(await write(r), r.params.reportScheduleId, "manual"),
    ),
    route(api.collectionReportRuns, async (r) =>
      R.runs(await g.org(r, "property.reports.read"), r.params.reportScheduleId, r.query),
    ),
    route(api.downloadCollectionReport, async (r) =>
      R.download(await g.org(r, "property.reports.read"), r.params.reportRunId),
    ),
  ];
}
