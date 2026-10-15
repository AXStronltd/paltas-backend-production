// HTTP only: stay bookings and blocks, guest payments, host payouts.
import { agency } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type AgencyGate } from "../shared/access.js";
import type { StaysService } from "./stays.service.js";

export function staysRoutes(g: AgencyGate, S: StaysService) {
  return [
    route(agency.listStays, async (req) => S.list(await g.agency(req, "agency.read"), req.query)),
    route(agency.createStay, async (req) => S.create(await g.agency(req, "agency.stays.manage", WRITE), req.body)),
    route(agency.stayAction, async (req) =>
      S.action(await g.agency(req, "agency.stays.manage", WRITE), req.params.stayId, req.body),
    ),
    route(agency.stayPayment, async (req) =>
      S.payment(await g.agency(req, "agency.payments.record", WRITE), req.params.stayId, req.body),
    ),
    route(agency.listPayouts, async (req) => S.payouts(await g.agency(req, "agency.payments.record"))),
    route(agency.preparePayout, async (req) =>
      S.prepare(await g.agency(req, "agency.payments.record", WRITE), req.body),
    ),
    route(agency.decidePayout, async (req) =>
      S.decide(await g.agency(req, "agency.finance.approve", WRITE), req.params.payoutId, req.body),
    ),
  ];
}
