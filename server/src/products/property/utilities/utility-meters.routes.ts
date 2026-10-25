import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, FINANCE } from "../shared/gate.js";
import type { utilityMetersService } from "./utility-meters.service.js";
export function utilityMeterRoutes(access: PmAccess, M: ReturnType<typeof utilityMetersService>) {
  const g = gate(access);
  return [
    route(api.listUtilityMeters, async (req) => M.list(await g.org(req, "property.read"), req.query)),
    route(api.registerUtilityMeter, async (req) =>
      M.register(await g.org(req, "property.leases.manage", FINANCE), req.body),
    ),
    route(api.retireUtilityMeter, async (req) =>
      M.retire(await g.org(req, "property.leases.manage", FINANCE), req.params.meterId, req.body),
    ),
    route(api.meterReadingHistory, async (req) => M.history(await g.org(req, "property.read"), req.params.readingId)),
  ];
}
