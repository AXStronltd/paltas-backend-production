// HTTP only: bank reconciliation of the client account against recorded money.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate } from "../shared/gate.js";
import type { BankService } from "./bank.service.js";

export function bankRoutes(access: PmAccess, K: BankService) {
  const g = gate(access);
  const work = (req: Parameters<typeof g.org>[0]) => g.org(req, "property.bank.reconcile", FINANCE);
  const read = (req: Parameters<typeof g.org>[0]) => g.org(req, ["property.bank.reconcile", "property.reports.read"]);
  return [
    route(api.importBankLines, async (req) => K.importLines(await work(req), req.body)),
    route(api.listBankLines, async (req) => K.list(await read(req), req.query.status)),
    route(api.matchBankLine, async (req) => K.match(await work(req), req.params.lineId, req.body)),
    route(api.ignoreBankLine, async (req) => K.ignore(await work(req), req.params.lineId, req.body.reason)),
    route(api.prepareReconciliation, async (req) => K.prepare(await work(req), req.body)),
    route(api.listReconciliations, async (req) => K.listReconciliations(await read(req))),
    route(api.approveReconciliation, async (req) => K.approve(await work(req), req.params.reconciliationId)),
  ];
}
