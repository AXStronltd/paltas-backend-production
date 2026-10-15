// HTTP only: tasks, after-sales requests and defects.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { SALES, WRITE, type DevGate } from "../shared/access.js";
import type { WorkService } from "./work.service.js";

export function workRoutes(g: DevGate, W: WorkService) {
  return [
    route(api.listTasks, async (req) => W.listTasks(await g(req, "developer.work"), req.query.view)),
    route(api.createTask, async (req) => W.create(await g(req, "developer.work", WRITE), req.body)),
    route(api.completeTask, async (req) =>
      W.complete(await g(req, "developer.work", WRITE), req.params.taskId, req.body.note),
    ),
    route(api.afterSalesRequest, async (req) =>
      W.afterSales(await g(req, "developer.sales", SALES), req.params.buyerId, req.body),
    ),
    route(api.listDefects, async (req) => W.listDefects(await g(req, "developer.read"), req.query)),
    route(api.reportDefect, async (req) =>
      W.reportDefect(await g(req, "developer.delivery", WRITE), req.params.unitId, req.body),
    ),
    route(api.updateDefect, async (req) =>
      W.updateDefect(await g(req, "developer.delivery", WRITE), req.params.defectId, req.body.status, req.body.note),
    ),
  ];
}
