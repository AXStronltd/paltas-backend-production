// HTTP only: supplier bills (entered, approved and paid by different people).
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate } from "../shared/gate.js";
import type { BillsService } from "./bills.service.js";

export function billsRoutes(access: PmAccess, B: BillsService) {
  const g = gate(access);
  return [
    route(api.submitBill, async (req) => B.submit(await g.org(req, "property.bills.submit", FINANCE), req.body)),
    route(api.listBills, async (req) => B.list(await g.org(req, "property.read"), req.query.status)),
    route(api.approveBill, async (req) =>
      B.approve(await g.org(req, "property.bills.approve", FINANCE), req.params.billId),
    ),
    route(api.clearBillHold, async (req) =>
      B.clearHold(await g.org(req, "property.bills.approve", FINANCE), req.params.billId, req.body.reason),
    ),
    route(api.rejectBill, async (req) =>
      B.reject(await g.org(req, "property.bills.approve", FINANCE), req.params.billId, req.body.reason),
    ),
    route(api.payBill, async (req) =>
      B.pay(await g.org(req, "property.bills.pay", FINANCE), req.params.billId, req.body),
    ),
  ];
}
