// HTTP only: supplier invoices, credit notes, disputes, retention, payment runs and reconciliation.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { PAYMENTS, requireAny, SPEND, type DevGate } from "../shared/access.js";
import type { PayablesService } from "./payables.service.js";

export function payablesRoutes(g: DevGate, P: PayablesService) {
  return [
    route(api.captureInvoice, async (req) => P.capture(await g(req, "developer.payables", SPEND), req.body)),
    route(api.listInvoices, async (req) => P.list(await g(req, "developer.read"), req.query)),
    route(api.getInvoice, async (req) => P.get(await g(req, "developer.read"), req.params.invoiceId)),
    route(api.checkInvoice, async (req) => P.check(await g(req, "developer.payables", SPEND), req.params.invoiceId)),
    // approve, reject, duplicate and override each need their own capability (checked in the service)
    route(api.decideInvoice, async (req) =>
      P.decide(await g(req, "developer.read", SPEND), req.params.invoiceId, req.body.action, req.body.reason),
    ),
    route(api.disputeInvoice, async (req) =>
      P.dispute(await g(req, "developer.payables", SPEND), req.params.invoiceId, req.body.amountMinor, req.body.reason),
    ),
    route(api.settleInvoiceDispute, async (req) =>
      P.settleDispute(await g(req, "developer.approve", SPEND), req.params.invoiceId),
    ),
    route(api.applyCreditNote, async (req) =>
      P.creditNote(await g(req, "developer.payables", SPEND), req.params.invoiceId, req.body),
    ),
    route(api.releaseRetention, async (req) =>
      P.releaseRetention(await g(req, "developer.payables", SPEND), req.params.poId, req.body),
    ),
    route(api.preparePaymentRun, async (req) => P.prepareRun(await g(req, "developer.payables", PAYMENTS), req.body)),
    route(api.listPaymentRuns, async (req) => P.listRuns(await g(req, "developer.read"))),
    route(api.approvePaymentRun, async (req) =>
      P.approveRun(await g(req, "developer.approve", PAYMENTS), req.params.runId),
    ),
    route(api.executePaymentRun, async (req) =>
      P.executeRun(await g(req, "developer.treasury", PAYMENTS), req.params.runId),
    ),
    route(api.reconcilePayments, async (req) => {
      const s = await g(req, "developer.read", PAYMENTS);
      requireAny(s, ["developer.treasury", "developer.payables", "developer.collections"], "reconcile bank statements");
      return P.reconcile(s, req.body.lines);
    }),
    route(api.reverseSupplierPayment, async (req) => {
      const s = await g(req, "developer.approve", PAYMENTS);
      requireAny(s, ["developer.payables"], "reverse supplier payments");
      return P.reverse(s, req.params.paymentId, req.body.reason);
    }),
  ];
}
