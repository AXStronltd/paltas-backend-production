// HTTP only: commission agreements, deals and commissions.
import { agency } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type AgencyGate } from "../shared/access.js";
import type { DealsService } from "./deals.service.js";

export function dealsRoutes(g: AgencyGate, S: DealsService) {
  return [
    route(agency.listAgreements, async (req) => S.agreements(await g.agency(req, "agency.read"))),
    route(agency.createAgreement, async (req) =>
      S.createAgreement(await g.agency(req, "agency.deals.manage", WRITE), req.body),
    ),
    route(agency.listDeals, async (req) => S.deals(await g.agency(req, "agency.read"))),
    route(agency.closeDeal, async (req) => S.close(await g.agency(req, "agency.deals.manage", WRITE), req.body)),
    route(agency.listCommissions, async (req) => S.commissions(await g.agency(req, "agency.read"), req.query.status)),
    route(agency.decideCommission, async (req) =>
      S.decide(await g.agency(req, "agency.finance.approve", WRITE), req.params.commissionId, req.body),
    ),
    route(agency.commissionReceipt, async (req) =>
      S.receipt(await g.agency(req, "agency.payments.record", WRITE), req.params.commissionId, req.body),
    ),
  ];
}
