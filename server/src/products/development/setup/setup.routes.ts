// HTTP only: rules, projects, units, price lists, milestones, documents and the legal register.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { SALES, WRITE, type DevGate } from "../shared/access.js";
import type { SetupService } from "./setup.service.js";

export function setupRoutes(g: DevGate, S: SetupService) {
  return [
    route(api.getSettings, async (req) => S.settings(await g(req, "developer.read"))),
    route(api.updateSettings, async (req) => S.updateSettings(await g(req, "developer.settings", WRITE), req.body)),
    route(api.listProjects, async (req) => S.listProjects(await g(req, "developer.read"))),
    route(api.createProject, async (req) => S.createProject(await g(req, "developer.projects", WRITE), req.body)),
    route(api.getProject, async (req) => S.getProject(await g(req, "developer.read"), req.params.projectId)),
    route(api.updateProject, async (req) =>
      S.updateProject(await g(req, "developer.projects", WRITE), req.params.projectId, req.body),
    ),
    route(api.createPhase, async (req) =>
      S.createPhase(await g(req, "developer.projects", WRITE), req.params.projectId, req.body),
    ),
    route(api.createBuilding, async (req) =>
      S.createBuilding(await g(req, "developer.projects", WRITE), req.params.projectId, req.body),
    ),
    route(api.createUnits, async (req) =>
      S.createUnits(await g(req, "developer.projects", WRITE), req.params.projectId, req.body),
    ),
    route(api.listUnits, async (req) =>
      S.listUnits(await g(req, "developer.read"), req.params.projectId, req.query.status),
    ),
    route(api.setUnitBlocked, async (req) =>
      S.setBlocked(await g(req, "developer.pricing", SALES), req.params.unitId, req.body.blocked, req.body.reason),
    ),
    route(api.createPriceList, async (req) =>
      S.createPriceList(await g(req, "developer.pricing", SALES), req.params.projectId, req.body),
    ),
    route(api.listPriceLists, async (req) => S.listPriceLists(await g(req, "developer.read"), req.params.projectId)),
    route(api.decidePriceList, async (req) =>
      S.decidePriceList(
        await g(req, "developer.pricing", SALES),
        req.params.priceListId,
        req.body.approve,
        req.body.reason,
      ),
    ),
    route(api.createMilestone, async (req) =>
      S.createMilestone(await g(req, "developer.projects", WRITE), req.params.projectId, req.body),
    ),
    route(api.updateMilestone, async (req) =>
      S.updateMilestone(await g(req, "developer.projects", WRITE), req.params.milestoneId, req.body),
    ),
    route(api.registerDocument, async (req) => S.registerDocument(await g(req, "developer.work", WRITE), req.body)),
    route(api.listDocuments, async (req) => S.listDocuments(await g(req, "developer.read"), req.query)),
    route(api.listLegal, async (req) => S.listLegal(await g(req, "developer.read"), req.query.projectId)),
    route(api.createLegal, async (req) => S.createLegal(await g(req, "developer.projects", WRITE), req.body)),
  ];
}
