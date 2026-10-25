import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, MAINT } from "../shared/gate.js";
import type { InspectionControlsService } from "./inspection-controls.service.js";
export function inspectionControlRoutes(access: PmAccess, M: InspectionControlsService) {
  const g = gate(access),
    read = (r: Parameters<typeof g.org>[0]) => g.org(r, "property.maintenance.manage"),
    write = (r: Parameters<typeof g.org>[0]) => g.org(r, "property.maintenance.manage", MAINT);
  return [
    route(api.inspectionTemplateHistory, async (r) =>
      M.templateHistory(await read(r), r.params.inspectionTemplateId, r.query),
    ),
    route(api.getInspectionTemplate, async (r) => M.getTemplate(await read(r), r.params.inspectionTemplateId)),
    route(api.getInspection, async (r) => M.get(await read(r), r.params.inspectionId)),
    route(api.inspectionHistory, async (r) => M.history(await read(r), r.params.inspectionId, r.query)),
    route(api.changeInspectionSchedule, async (r) => M.change(await write(r), r.params.inspectionId, r.body)),
    route(api.listInspectionTemplates, async (r) => M.listTemplates(await read(r), r.query)),
    route(api.createInspectionTemplate, async (r) => M.createTemplate(await write(r), r.body)),
    route(api.updateInspectionTemplate, async (r) =>
      M.updateTemplate(await write(r), r.params.inspectionTemplateId, r.body),
    ),
  ];
}
