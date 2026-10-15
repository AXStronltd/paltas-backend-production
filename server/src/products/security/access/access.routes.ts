// HTTP only: visitors, the watchlist and physical access control.
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type SecurityAccess } from "../shared/access.js";
import type { AccessService } from "./access.service.js";

export function accessRoutes(a: SecurityAccess, X: AccessService) {
  type Req = Parameters<SecurityAccess["scope"]>[0];
  const gate = (req: Req) => a.scope(req, "security.visitors");
  const gateWrite = (req: Req) => a.scope(req, "security.visitors", WRITE);
  const manage = (req: Req) => a.scope(req, "security.access.manage", WRITE);
  return [
    route(security.listVisitors, async (req) => X.listVisitors(await gate(req), req.query.view, req.query.siteId)),
    route(security.registerVisitor, async (req) => X.registerVisitor(await gateWrite(req), req.body)),
    route(security.visitorAction, async (req) => X.visitorAction(await gateWrite(req), req.params.visitorId, req.body)),
    route(security.purgeVisitors, async (req) => X.purgeVisitors(await gateWrite(req))),
    route(security.listWatchlist, async (req) => X.listWatchlist(await gate(req))),
    route(security.addWatch, async (req) => X.addWatch(await gateWrite(req), req.body)),
    route(security.removeWatch, async (req) =>
      X.removeWatch(await gateWrite(req), req.params.entryId, req.body.reason),
    ),
    route(security.accessOverview, async (req) => X.overview(await a.scope(req, "security.read"))),
    route(security.createDoor, async (req) => X.createDoor(await manage(req), req.body)),
    route(security.saveAccessGroup, async (req) => X.saveGroup(await manage(req), req.body)),
    route(security.issueCredential, async (req) => X.issueCredential(await manage(req), req.body)),
    route(security.changeCredential, async (req) =>
      X.changeCredential(await manage(req), req.params.credentialId, req.body.action, req.body.reason),
    ),
    route(security.checkAccess, async (req) =>
      X.checkAccess(await manage(req), req.body.credentialId, req.body.doorId, req.body.at),
    ),
    route(security.remoteUnlock, async (req) => X.remoteUnlock(await manage(req), req.params.doorId, req.body.reason)),
  ];
}
