// HTTP only: settings, payroll rules, clients, sites, posts, checkpoints, contracts and the sales pipeline.
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { FINANCE_WRITE, WRITE, type SecurityAccess } from "../shared/access.js";
import type { SetupService } from "./setup.service.js";

export function setupRoutes(a: SecurityAccess, S: SetupService) {
  return [
    route(security.getSettings, async (req) => S.getSettings(await a.scope(req, "security.read"))),
    route(security.updateSettings, async (req) =>
      S.updateSettings(await a.scope(req, "security.setup", WRITE), req.body),
    ),
    route(security.getPayrollRules, async (req) =>
      S.getPayrollRules(await a.scopeAny(req, ["security.payroll.approve", "security.payroll.prepare"])),
    ),
    route(security.setPayrollRules, async (req) =>
      S.setPayrollRules(await a.scope(req, "security.payroll.approve", FINANCE_WRITE), req.body),
    ),
    route(security.listClients, async (req) =>
      S.listClients(await a.scopeAny(req, ["security.read", "security.billing"])),
    ),
    route(security.createClient, async (req) => S.createClient(await a.scope(req, "security.setup", WRITE), req.body)),
    route(security.setClientPortalUsers, async (req) =>
      S.setPortalUsers(await a.scope(req, "security.setup", WRITE), req.params.clientId, req.body.userIds),
    ),
    // the gate / reception officer chooses the site at the desk, so the site list is open to security.visitors too
    route(security.listSites, async (req) =>
      S.listSites(await a.scopeAny(req, ["security.read", "security.visitors"])),
    ),
    route(security.updateSite, async (req) =>
      S.updateSite(await a.scope(req, "security.setup", WRITE), req.params.siteId, req.body),
    ),
    route(security.createSite, async (req) => S.createSite(await a.scope(req, "security.setup", WRITE), req.body)),
    route(security.getSite, async (req) => S.getSite(await a.scope(req, "security.read"), req.params.siteId)),
    route(security.createPost, async (req) =>
      S.createPost(await a.scope(req, "security.setup", WRITE), req.params.siteId, req.body),
    ),
    route(security.updatePostOrder, async (req) =>
      S.updatePostOrder(await a.scope(req, "security.setup", WRITE), req.params.postId, req.body.orderText),
    ),
    route(security.acknowledgePostOrder, async (req) =>
      S.acknowledgePostOrder(
        await a.scope(req, "security.field", WRITE),
        req.params.postId,
        req.body.guardId,
        req.body.version,
      ),
    ),
    route(security.createCheckpoints, async (req) =>
      S.createCheckpoints(await a.scope(req, "security.setup", WRITE), req.params.siteId, req.body),
    ),
    route(security.listContracts, async (req) =>
      S.listContracts(await a.scopeAny(req, ["security.read", "security.billing"])),
    ),
    route(security.createContract, async (req) =>
      S.createContract(await a.scope(req, "security.setup", WRITE), req.body),
    ),
    route(security.endContract, async (req) =>
      S.endContract(
        await a.scope(req, "security.setup", WRITE),
        req.params.contractId,
        req.body.endDate,
        req.body.reason,
      ),
    ),
    route(security.listOpportunities, async (req) => S.listOpportunities(await a.scope(req, "security.read"))),
    route(security.createOpportunity, async (req) =>
      S.createOpportunity(await a.scope(req, "security.setup", WRITE), req.body),
    ),
    route(security.moveOpportunity, async (req) =>
      S.moveOpportunity(await a.scope(req, "security.setup", WRITE), req.params.opportunityId, req.body),
    ),
  ];
}
