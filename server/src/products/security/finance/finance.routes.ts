// HTTP only: client billing, receivables, bank lines, payroll, costs and remittances. Writes need the finance module.
import { security } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { FINANCE_WRITE, type SecurityAccess } from "../shared/access.js";
import type { BillingService } from "./billing.service.js";
import type { PayrollService } from "./payroll.service.js";

export function financeRoutes(a: SecurityAccess, B: BillingService, P: PayrollService) {
  type Req = Parameters<SecurityAccess["scope"]>[0];
  const billing = (req: Req) => a.scope(req, "security.billing");
  const bill = (req: Req) => a.scope(req, "security.billing", FINANCE_WRITE);
  const prepare = (req: Req) => a.scope(req, "security.payroll.prepare", FINANCE_WRITE);
  return [
    route(security.runBilling, async (req) => B.runBilling(await bill(req), req.body.period)),
    route(security.createInvoice, async (req) => B.createInvoice(await bill(req), req.body)),
    route(security.listInvoices, async (req) => B.listInvoices(await billing(req), req.query.clientId, req.query.open)),
    route(security.recordReceipt, async (req) => B.recordReceipt(await bill(req), req.body)),
    route(security.listReceipts, async (req) => B.listReceipts(await billing(req), req.query.clientId)),
    route(security.recordCertificate, async (req) =>
      B.recordCertificate(await bill(req), req.params.invoiceId, req.body),
    ),
    route(security.billLateFee, async (req) => B.billLateFee(await bill(req), req.params.clientId, req.body.vatPct)),
    route(security.clientStatement, async (req) => B.statement(await billing(req), req.params.clientId)),
    route(security.ageing, async (req) => B.ageing(await billing(req))),
    route(security.listClientNotes, async (req) => B.listNotes(await billing(req), req.params.clientId)),
    route(security.addClientNote, async (req) => B.addNote(await bill(req), req.params.clientId, req.body)),
    route(security.importBankLines, async (req) => B.importBankLines(await bill(req), req.body)),
    route(security.listBankLines, async (req) => B.listBankLines(await billing(req))),
    route(security.matchBankLine, async (req) =>
      B.matchBankLine(await bill(req), req.params.lineId, req.body.invoiceId, req.body.method),
    ),
    route(security.preparePayroll, async (req) => P.prepare(await prepare(req), req.body.period)),
    route(security.getPayroll, async (req) =>
      P.get(await a.scopeAny(req, ["security.payroll.prepare", "security.payroll.approve"]), req.params.period),
    ),
    route(security.approvePayroll, async (req) =>
      P.approve(await a.scope(req, "security.payroll.approve", FINANCE_WRITE), req.params.period),
    ),
    route(security.recordPayrollPayment, async (req) =>
      P.recordPayment(await prepare(req), req.params.period, req.body.date, req.body.reference),
    ),
    route(security.postCost, async (req) => P.postCost(await bill(req), req.body)),
    route(security.recordRemittance, async (req) => P.recordRemittance(await prepare(req), req.body)),
  ];
}
