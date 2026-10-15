// HTTP only: statements of account, buyer payments, billing and handover.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { PAYMENTS, SALES, type DevGate } from "../shared/access.js";
import type { CollectionsService } from "./collections.service.js";

export function collectionsRoutes(g: DevGate, C: CollectionsService) {
  return [
    route(api.contractStatement, async (req) =>
      C.statement(await g(req, "developer.buyers.read"), req.params.contractId, req.query.asOf),
    ),
    // sales staff report, finance records: both are checked in the service
    route(api.reportPayment, async (req) =>
      C.report(await g(req, "developer.buyers.read", PAYMENTS), req.params.contractId, req.body),
    ),
    route(api.listPaymentReports, async (req) =>
      C.listReports(await g(req, "developer.buyers.read"), req.query.status),
    ),
    route(api.verifyPayment, async (req) =>
      C.verify(await g(req, "developer.collections", PAYMENTS), req.params.reportId, req.body.approve, req.body.reason),
    ),
    route(api.billInstalments, async (req) => C.bill(await g(req, "developer.collections", PAYMENTS), req.body.asOf)),
    route(api.recordHandover, async (req) =>
      C.handover(await g(req, "developer.sales.manage", SALES), req.params.contractId, req.body),
    ),
  ];
}
