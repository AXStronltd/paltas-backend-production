// HTTP only: invoicing — billing runs, invoices, charge invoices, late fees, credit notes.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate } from "../shared/gate.js";
import type { BillingService } from "./billing.service.js";

export function billingRoutes(access: PmAccess, B: BillingService) {
  const g = gate(access);
  return [
    route(api.runBilling, async (req) => B.runBilling(await g.org(req, "property.billing", FINANCE), req.body)),
    route(api.listInvoices, async (req) => B.list(await g.org(req, "property.read"), req.query)),
    route(api.getInvoice, async (req) => {
      const s = await g.org(req, "property.read");
      return B.view(s.orgId, req.params.invoiceId, s.today);
    }),
    route(api.createChargeInvoice, async (req) =>
      B.chargeInvoice(await g.org(req, "property.billing", FINANCE), req.body),
    ),
    route(api.runLateFees, async (req) => B.runLateFees(await g.org(req, "property.billing", FINANCE), req.body)),
    route(api.createCreditNote, async (req) =>
      B.creditNote(await g.org(req, "property.billing", FINANCE), req.params.invoiceId, req.body),
    ),
  ];
}
