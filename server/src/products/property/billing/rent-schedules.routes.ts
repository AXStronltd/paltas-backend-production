import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate } from "../shared/gate.js";
import type { rentSchedulesService } from "./rent-schedules.service.js";
export function rentScheduleRoutes(access: PmAccess, b: ReturnType<typeof rentSchedulesService>) {
  const g = gate(access);
  return [
    route(api.getRentSchedule, async (req) => b.get(await g.org(req, "property.read"), req.params.leaseId)),
    route(api.previewRentSchedule, async (req) =>
      b.preview(await g.org(req, "property.billing", FINANCE), req.params.leaseId, req.body),
    ),
    route(api.saveRentSchedule, async (req) =>
      b.save(await g.org(req, "property.billing", FINANCE), req.params.leaseId, req.body),
    ),
    route(api.setRentScheduleStatus, async (req) =>
      b.status(await g.org(req, "property.billing", FINANCE), req.params.leaseId, req.body),
    ),
    route(api.previewRentScheduleRun, async (req) =>
      b.previewRun(await g.org(req, "property.billing", FINANCE), req.params.leaseId),
    ),
    route(api.runRentSchedule, async (req) =>
      b.issueNext(await g.org(req, "property.billing", FINANCE), req.params.leaseId, req.body.previewKey),
    ),
  ];
}
