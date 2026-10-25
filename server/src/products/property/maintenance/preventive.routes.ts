import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, MAINT } from "../shared/gate.js";
import type { PreventiveService } from "./preventive.service.js";
export function preventiveRoutes(access: PmAccess, M: PreventiveService) {
  const g = gate(access),
    read = (r: Parameters<typeof g.org>[0]) => g.org(r, "property.maintenance.manage");
  return [
    route(api.listPreventivePlans, async (r) => M.list(await read(r), r.query)),
    route(api.getPreventivePlan, async (r) => M.get(await read(r), r.params.preventivePlanId)),
    route(api.createPreventivePlan, async (r) =>
      M.create(await g.org(r, "property.maintenance.manage", MAINT), r.body),
    ),
    route(api.updatePreventivePlan, async (r) =>
      M.update(await g.org(r, "property.maintenance.manage", MAINT), r.params.preventivePlanId, r.body),
    ),
    route(api.preventivePlanHistory, async (r) => M.history(await read(r), r.params.preventivePlanId, r.query)),
  ];
}
