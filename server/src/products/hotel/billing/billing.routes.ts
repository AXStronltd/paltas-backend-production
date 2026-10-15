// HTTP only: multi-currency, comps and discounts, invoices, collections and bank reconciliation.
import { hotel } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { SetupService } from "../setup/setup.service.js";
import type { HotelAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import type { BillingService } from "./billing.service.js";

export function billingRoutes(access: HotelAccess, x: { billing: BillingService; setup: SetupService }) {
  const g = gate(access);
  const { billing: B, setup } = x;
  return [
    // ---- multi-currency
    route(hotel.listFxRates, async (req) => B.listFxRates(await g.hotel(req, "hotel.read"), req.query.date)),
    route(hotel.setFxRates, async (req) =>
      B.setFxRates(await g.hotel(req, "hotel.fx.manage", WRITE), req.params.date, req.body.rates),
    ),
    route(hotel.folioInCurrency, async (req) =>
      B.folioInCurrency(await g.hotel(req, "hotel.read"), req.params.folioId, req.query.currency),
    ),
    route(hotel.recordFxPayment, async (req) =>
      B.recordFxPayment(await g.hotel(req, "hotel.cashier", WRITE), req.params.folioId, req.body),
    ),

    // ---- comps and discounts
    route(hotel.postAllowance, async (req) =>
      B.postAllowance(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.folioId, req.params.lineId, req.body),
    ),
    route(hotel.approveAllowance, async (req) =>
      B.approveAllowance(await g.hotel(req, "hotel.folio.approve", WRITE), req.params.folioId, req.params.allowanceId),
    ),

    // ---- invoices
    route(hotel.issueInvoice, async (req) =>
      B.issueInvoice(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.folioId, req.body),
    ),
    route(hotel.listInvoices, async (req) => B.listInvoices(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.getInvoice, async (req) => B.getInvoice(await g.hotel(req, "hotel.read"), req.params.invoiceId)),
    route(hotel.creditNote, async (req) =>
      B.creditNote(await g.hotel(req, "hotel.folio.approve", WRITE), req.params.invoiceId, req.body.reason),
    ),
    route(hotel.emailInvoice, async (req) =>
      B.emailInvoice(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.invoiceId, req.body.recipient),
    ),
    route(hotel.submitEInvoice, async (req) =>
      B.submitEInvoice(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.invoiceId),
    ),

    // ---- collections (company accounts belong to the organisation)
    route(hotel.listCollections, async (req) =>
      B.listCollections(await g.org(req, "hotel.cityledger"), req.params.accountId),
    ),
    route(hotel.recordCollection, async (req) => {
      const s = await g.org(req, "hotel.cityledger", WRITE);
      return B.recordCollection(
        s,
        req.params.accountId,
        req.body,
        async (t) => (await setup.corporateAccount(t, s.orgId, req.params.accountId, s.today)).balanceMinor,
        async (propertyId) => {
          await access.property(req.user, req.params.orgId, propertyId, "hotel.cityledger", WRITE);
        },
      );
    }),
    route(hotel.collectionsDue, async (req) => B.collectionsDue(await g.org(req, "hotel.cityledger"))),

    // ---- bank reconciliation
    route(hotel.importBankLines, async (req) =>
      B.importBankLines(await g.hotel(req, "hotel.reconcile", WRITE), req.body),
    ),
    route(hotel.listBankLines, async (req) => B.listBankLines(await g.hotel(req, "hotel.reconcile"), req.query.status)),
    route(hotel.recordedPayments, async (req) => B.recordedPayments(await g.hotel(req, "hotel.reconcile"), req.query)),
    route(hotel.matchBankLine, async (req) =>
      B.matchBankLine(await g.hotel(req, "hotel.reconcile", WRITE), req.params.bankLineId, req.body),
    ),
    route(hotel.recordChargeback, async (req) =>
      B.chargeback(await g.hotel(req, "hotel.reconcile", WRITE), req.params.bankLineId, req.body),
    ),
    route(hotel.reconciliationSummary, async (req) =>
      B.summary(await g.hotel(req, "hotel.reconcile"), req.query.from, req.query.to),
    ),
  ];
}
