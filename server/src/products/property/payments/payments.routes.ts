// HTTP only: recorded payments, tenant credit and statements, reported payments, deposit settlements.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate, WRITE } from "../shared/gate.js";
import type { PaymentsService } from "./payments.service.js";

export function paymentsRoutes(access: PmAccess, P: PaymentsService) {
  const g = gate(access);
  return [
    route(api.recordPayment, async (req) => P.record(await g.org(req, "property.payments.record", FINANCE), req.body)),
    route(api.listPayments, async (req) => P.list(await g.org(req, "property.read"), req.query)),
    route(api.getPayment, async (req) =>
      P.paymentView((await g.org(req, "property.read")).orgId, req.params.paymentId),
    ),
    route(api.applyCredit, async (req) =>
      P.applyCredit(await g.org(req, "property.payments.record", FINANCE), req.params.tenantId),
    ),
    route(api.tenantStatement, async (req) => P.statement(await g.org(req, "property.read"), req.params.tenantId)),
    route(api.listClaims, async (req) => P.listClaims(await g.org(req, "property.read"), req.query.status)),
    route(api.rejectClaim, async (req) =>
      P.rejectClaim(await g.org(req, "property.payments.record", WRITE), req.params.claimId, req.body.reason),
    ),
    // deposits
    route(api.requestDepositRefund, async (req) =>
      P.requestRefund(await g.org(req, "property.deposits.request", FINANCE), req.params.leaseId, req.body),
    ),
    route(api.listDepositRefunds, async (req) => P.listRefunds(await g.org(req, "property.read"), req.query.status)),
    route(api.approveDepositRefund, async (req) =>
      P.approveRefund(await g.org(req, "property.deposits.approve", FINANCE), req.params.refundId),
    ),
    route(api.rejectDepositRefund, async (req) =>
      P.rejectRefund(await g.org(req, "property.deposits.approve", FINANCE), req.params.refundId, req.body.reason),
    ),
  ];
}
