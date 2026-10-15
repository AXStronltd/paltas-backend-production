// HTTP only: owner statements and owner payouts.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate } from "../shared/gate.js";
import type { OwnersService } from "./owners.service.js";

export function ownersRoutes(access: PmAccess, O: OwnersService) {
  const g = gate(access);
  return [
    route(api.ownerStatement, async (req) =>
      O.statement(await g.org(req, "property.read"), req.params.ownerId, req.query.from, req.query.to),
    ),
    route(api.preparePayout, async (req) =>
      O.prepare(await g.org(req, "property.payouts.prepare", FINANCE), req.body.ownerId),
    ),
    route(api.listPayouts, async (req) => O.listPayouts(await g.org(req, "property.read"), req.query.ownerId)),
    route(api.approvePayout, async (req) =>
      O.approve(await g.org(req, "property.payouts.approve", FINANCE), req.params.payoutId),
    ),
    route(api.releasePayout, async (req) =>
      O.release(await g.org(req, "property.payouts.prepare", FINANCE), req.params.payoutId),
    ),
    route(api.cancelPayout, async (req) =>
      O.cancel(await g.org(req, "property.payouts.prepare", FINANCE), req.params.payoutId, req.body.reason),
    ),
  ];
}
