// HTTP only: the tenant and owner portals (the signed-in person's own records only).
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, MAINT, WRITE } from "../shared/gate.js";
import type { PortalService } from "./portal.service.js";

export function portalRoutes(access: PmAccess, T: PortalService) {
  const g = gate(access);
  return [
    route(api.tenantPortal, async (req) => T.tenant(await g.tenant(req))),
    route(api.tenantRequest, async (req) => T.tenantRequest(await g.tenant(req, MAINT), req.body)),
    route(api.tenantPaymentReport, async (req) => T.tenantPaymentReport(await g.tenant(req, WRITE), req.body)),
    route(api.ownerPortal, async (req) => T.owner(await g.owner(req), req.query)),
    route(api.ownerApproveBill, async (req) => T.ownerApproveBill(await g.owner(req, WRITE), req.params.billId)),
    route(api.ownerApprovePurchaseOrder, async (req) =>
      T.ownerApprovePo(await g.owner(req, WRITE), req.params.workOrderId),
    ),
  ];
}
