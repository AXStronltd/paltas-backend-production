// HTTP only: suppliers, bank-detail changes, budgets, requisitions, quotations, orders and deliveries.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { requireAny, SPEND, type DevGate } from "../shared/access.js";
import type { ProcurementService } from "./procurement.service.js";

export function procurementRoutes(g: DevGate, P: ProcurementService) {
  return [
    route(api.listSuppliers, async (req) => P.listSuppliers(await g(req, "developer.read"))),
    route(api.registerSupplier, async (req) => P.register(await g(req, "developer.procurement", SPEND), req.body)),
    route(api.approveSupplier, async (req) =>
      P.approveSupplier(await g(req, "developer.suppliers.verify", SPEND), req.params.supplierId, req.body.rating),
    ),
    route(api.logBankChange, async (req) => {
      const s = await g(req, "developer.read", SPEND);
      requireAny(s, ["developer.procurement", "developer.payables", "developer.suppliers.verify"], "log bank changes");
      return P.logBankChange(s, req.params.supplierId, req.body);
    }),
    route(api.verifyBankChange, async (req) =>
      P.verifyBankChange(await g(req, "developer.suppliers.verify", SPEND), req.params.changeId, req.body.callbackNote),
    ),
    route(api.setBudget, async (req) =>
      P.setBudget(await g(req, "developer.budget", SPEND), req.params.projectId, req.body),
    ),
    route(api.costReport, async (req) => P.costReport(await g(req, "developer.reports"), req.params.projectId)),
    route(api.requestBudgetChange, async (req) =>
      P.requestChange(await g(req, "developer.budget", SPEND), req.params.projectId, req.body),
    ),
    route(api.listBudgetChanges, async (req) => P.listChanges(await g(req, "developer.read"), req.params.projectId)),
    route(api.decideBudgetChange, async (req) =>
      P.decideChange(await g(req, "developer.approve", SPEND), req.params.changeId, req.body.approve, req.body.reason),
    ),
    route(api.createRequisition, async (req) =>
      P.createRequisition(await g(req, "developer.procurement", SPEND), req.params.projectId, req.body),
    ),
    route(api.listRequisitions, async (req) => P.listRequisitions(await g(req, "developer.read"), req.query.projectId)),
    route(api.decideRequisition, async (req) =>
      P.decideRequisition(
        await g(req, "developer.approve", SPEND),
        req.params.requisitionId,
        req.body.approve,
        req.body.reason,
      ),
    ),
    route(api.createRfq, async (req) =>
      P.createRfq(await g(req, "developer.procurement", SPEND), req.params.requisitionId, req.body),
    ),
    route(api.getRfq, async (req) => P.getRfq(await g(req, "developer.read"), req.params.rfqId)),
    route(api.recordBid, async (req) =>
      P.recordBid(await g(req, "developer.procurement", SPEND), req.params.rfqId, req.body),
    ),
    route(api.awardRfq, async (req) =>
      P.award(await g(req, "developer.procurement", SPEND), req.params.rfqId, req.body),
    ),
    route(api.createPurchaseOrder, async (req) =>
      P.createPo(await g(req, "developer.procurement", SPEND), req.params.projectId, req.body),
    ),
    route(api.listPurchaseOrders, async (req) => P.listPos(await g(req, "developer.read"), req.query)),
    route(api.decidePurchaseOrder, async (req) =>
      P.decidePo(await g(req, "developer.approve", SPEND), req.params.poId, req.body.approve, req.body.reason),
    ),
    route(api.recordDelivery, async (req) =>
      P.recordDelivery(await g(req, "developer.procurement", SPEND), req.params.poId, req.body),
    ),
  ];
}
