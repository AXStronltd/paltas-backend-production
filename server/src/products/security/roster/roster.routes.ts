// HTTP only: shifts, roster, attendance, timesheets and messages to guards.
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type SecurityAccess } from "../shared/access.js";
import type { RosterService } from "./roster.service.js";

export function rosterRoutes(a: SecurityAccess, R: RosterService) {
  type Req = Parameters<SecurityAccess["scope"]>[0];
  const roster = (req: Req) => a.scope(req, "security.roster.manage", WRITE);
  const field = (req: Req) => a.scope(req, "security.field", WRITE);
  return [
    route(security.listShifts, async (req) => R.listShifts(await a.scope(req, "security.read"), req.query)),
    route(security.createShifts, async (req) => R.createShifts(await roster(req), req.body)),
    route(security.assignShift, async (req) => R.assignShift(await roster(req), req.params.shiftId, req.body.guardId)),
    route(security.unassignShift, async (req) =>
      R.unassignShift(await roster(req), req.params.shiftId, req.body.cancel, req.body.reason),
    ),
    route(security.offerShift, async (req) => R.offerShift(await roster(req), req.params.shiftId)),
    route(security.publishRoster, async (req) => R.publishRoster(await roster(req), req.body.from, req.body.to)),
    route(security.rosterCoverage, async (req) =>
      R.coverage(await a.scope(req, "security.read"), req.query.from, req.query.to),
    ),
    route(security.clockIn, async (req) => R.clockIn(await field(req), req.params.shiftId, req.body)),
    route(security.clockOut, async (req) => R.clockOut(await field(req), req.params.shiftId, req.body)),
    route(security.adjustAttendance, async (req) =>
      R.adjustAttendance(await roster(req), req.params.shiftId, req.body.inAt, req.body.outAt, req.body.reason),
    ),
    route(security.detectNoShows, async (req) => R.detectNoShows(await a.scope(req, "security.control", WRITE))),
    route(security.listTimesheets, async (req) =>
      R.listTimesheets(await a.scope(req, "security.read"), req.query.status),
    ),
    route(security.approveTimesheets, async (req) =>
      R.approveTimesheets(await a.scope(req, "security.timesheets.approve", WRITE), req.body.shiftIds),
    ),
    route(security.sendMessage, async (req) => R.sendMessage(await a.scope(req, "security.control", WRITE), req.body)),
  ];
}
