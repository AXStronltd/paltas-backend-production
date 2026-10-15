// HTTP only: guards, training, expiry alerts and equipment.
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type SecurityAccess } from "../shared/access.js";
import type { WorkforceService } from "./workforce.service.js";

export function workforceRoutes(a: SecurityAccess, W: WorkforceService) {
  const manage = (req: Parameters<SecurityAccess["scope"]>[0]) => a.scope(req, "security.guards.manage", WRITE);
  return [
    route(security.listGuards, async (req) => W.listGuards(await a.scope(req, "security.read"), req.query.filter)),
    route(security.createGuard, async (req) => W.createGuard(await manage(req), req.body)),
    route(security.updateGuard, async (req) => W.updateGuard(await manage(req), req.params.guardId, req.body)),
    route(security.addTraining, async (req) =>
      W.addTraining(await manage(req), req.params.guardId, req.body.course, req.body.validTo),
    ),
    route(security.expiryAlerts, async (req) => W.expiryAlerts(await a.scope(req, "security.read"))),
    route(security.listEquipment, async (req) => W.listEquipment(await a.scope(req, "security.read"))),
    route(security.createEquipment, async (req) => W.createEquipment(await manage(req), req.body)),
    route(security.issueEquipment, async (req) =>
      W.issueEquipment(await manage(req), req.params.equipmentId, req.body.guardId),
    ),
    route(security.returnEquipment, async (req) =>
      W.returnEquipment(await manage(req), req.params.equipmentId, req.body.condition, req.body.note),
    ),
  ];
}
