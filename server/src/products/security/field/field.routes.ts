// HTTP only: patrols, incidents, the occurrence book and alarms (including the signed alarm webhook).
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type SecurityAccess } from "../shared/access.js";
import type { FieldService } from "./field.service.js";

export function fieldRoutes(a: SecurityAccess, F: FieldService) {
  type Req = Parameters<SecurityAccess["scope"]>[0];
  const field = (req: Req) => a.scope(req, "security.field", WRITE);
  const control = (req: Req) => a.scope(req, "security.control", WRITE);
  const read = (req: Req) => a.scope(req, "security.read");
  return [
    route(security.listPatrols, async (req) => F.listPatrols(await read(req), req.query)),
    route(security.startPatrol, async (req) => F.startPatrol(await field(req), req.body)),
    route(security.scanCheckpoint, async (req) => F.scanCheckpoint(await field(req), req.params.patrolId, req.body)),
    route(security.closePatrol, async (req) => F.closePatrol(await field(req), req.params.patrolId, req.body.closedAt)),
    route(security.listIncidents, async (req) => F.listIncidents(await read(req), req.query.filter, req.query.siteId)),
    route(security.reportIncident, async (req) =>
      F.reportIncident(await a.scope(req, "security.occurrences.write", WRITE), req.body),
    ),
    route(security.getIncident, async (req) => F.getIncident(await read(req), req.params.incidentId)),
    route(security.assignInvestigator, async (req) =>
      F.assignInvestigator(
        await a.scope(req, "security.incidents.manage", WRITE),
        req.params.incidentId,
        req.body.userId,
      ),
    ),
    route(security.closeIncident, async (req) =>
      F.closeIncident(await a.scope(req, "security.incidents.manage", WRITE), req.params.incidentId, req.body.note),
    ),
    route(security.addOccurrence, async (req) =>
      F.addOccurrence(await a.scope(req, "security.occurrences.write", WRITE), req.body),
    ),
    route(security.listOccurrences, async (req) => F.listOccurrences(await read(req), req.query)),
    route(security.listAlarms, async (req) => F.listAlarms(await read(req), req.query.active, req.query.siteId)),
    route(security.raisePanic, async (req) => F.raisePanic(await field(req), req.body)),
    route(security.raiseAlarm, async (req) => F.raiseAlarm(await control(req), req.body)),
    route(security.acknowledgeAlarm, async (req) =>
      F.acknowledgeAlarm(await control(req), req.params.alarmId, req.body.at),
    ),
    route(security.dispatchAlarm, async (req) =>
      F.dispatchAlarm(await control(req), req.params.alarmId, req.body.unit, req.body.at),
    ),
    route(security.resolveAlarm, async (req) => F.resolveAlarm(await control(req), req.params.alarmId, req.body)),
    // the signature (checked by the route layer) proves the provider; the site's account must be configured for it
    route(security.alarmWebhook, async (req) => F.inboundAlarm(req.params.provider.toLowerCase(), req.body)),
  ];
}
