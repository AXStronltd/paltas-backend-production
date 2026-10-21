import { admin } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { route } from "../../http/route.js";
import { consoleService } from "./console.service.js";

// The Super Admin console: the PALTAS team, client directory, people search, platform overview. All auth "staff".
export function consoleRoutes(ctx: AppContext) {
  const C = consoleService(ctx);
  return [
    route(admin.platformOverview, async (req) => C.overview(req.user)),
    route(admin.listStaff, async (req) => C.listStaff(req.user)),
    route(admin.inviteStaff, async (req) => C.inviteStaff(req.user, req.body)),
    route(admin.updateStaff, async (req) => C.updateStaff(req.user, req.params.userId, req.body)),
    route(admin.resetStaffAccess, async (req) => C.resetStaffAccess(req.user, req.params.userId, req.body)),
    route(admin.listClients, async (req) => C.listClients(req.user, req.query)),
    route(admin.searchPeople, async (req) => C.searchPeople(req.user, req.query)),
  ];
}
