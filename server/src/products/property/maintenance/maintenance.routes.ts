// HTTP only: maintenance requests, work orders (quotes, purchase orders, completion, checks), inspections.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { ANY_PM_READ, gate, MAINT } from "../shared/gate.js";
import type { MaintenanceService } from "./maintenance.service.js";

export function maintenanceRoutes(access: PmAccess, M: MaintenanceService) {
  const g = gate(access);
  const manage = (req: Parameters<typeof g.org>[0]) => g.org(req, "property.maintenance.manage", MAINT);
  return [
    route(api.getWorkOrder, async (req) => M.getWorkOrder(await g.org(req, ANY_PM_READ), req.params.workOrderId)),
    route(api.updateWorkOrder, async (req) => M.updateWorkOrder(await manage(req), req.params.workOrderId, req.body)),
    route(api.workOrderHistory, async (req) =>
      M.workOrderHistory(await manage(req), req.params.workOrderId, req.query),
    ),
    route(api.maintenanceRequestHistory, async (req) =>
      M.requestHistory(await g.org(req, "property.maintenance.manage"), req.params.requestId, req.query),
    ),
    route(api.getMaintenanceRequest, async (req) => M.getRequest(await g.org(req, ANY_PM_READ), req.params.requestId)),
    route(api.updateMaintenanceRequest, async (req) =>
      M.updateRequest(await manage(req), req.params.requestId, req.body),
    ),
    route(api.reopenMaintenanceRequest, async (req) =>
      M.reopenRequest(await manage(req), req.params.requestId, req.body),
    ),
    route(api.listRequests, async (req) => M.listRequests(await g.org(req, ANY_PM_READ), req.query)),
    route(api.createRequest, async (req) =>
      M.createRequest(await g.org(req, "property.maintenance.request", MAINT), req.body),
    ),
    route(api.closeRequest, async (req) => M.closeRequest(await manage(req), req.params.requestId, req.body.note)),
    route(api.listWorkOrders, async (req) => M.listWorkOrders(await g.org(req, ANY_PM_READ), req.query)),
    route(api.createWorkOrder, async (req) => M.createWorkOrder(await manage(req), req.body)),
    route(api.addQuote, async (req) => M.addQuote(await manage(req), req.params.workOrderId, req.body)),
    route(api.raisePurchaseOrder, async (req) =>
      M.raisePo(await manage(req), req.params.workOrderId, req.body.supplierId),
    ),
    route(api.approvePurchaseOrder, async (req) =>
      M.approvePoAsStaff(await g.org(req, "property.maintenance.approve", MAINT), req.params.workOrderId),
    ),
    route(api.completeWorkOrder, async (req) =>
      M.complete(
        await g.org(req, ["property.maintenance.work", "property.maintenance.manage"], MAINT),
        req.params.workOrderId,
        req.body,
      ),
    ),
    route(api.verifyWorkOrder, async (req) => M.verify(await manage(req), req.params.workOrderId, req.body)),
    route(api.cancelWorkOrder, async (req) => M.cancel(await manage(req), req.params.workOrderId, req.body.reason)),
    route(api.listInspections, async (req) => M.listInspections(await g.org(req, ANY_PM_READ), req.query.propertyId)),
    route(api.scheduleInspection, async (req) => M.scheduleInspection(await manage(req), req.body)),
    route(api.completeInspection, async (req) =>
      M.completeInspection(await manage(req), req.params.inspectionId, req.body.items),
    ),
  ];
}
