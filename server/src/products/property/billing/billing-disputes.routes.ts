import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, WRITE, gate } from "../shared/gate.js";
import type { billingDisputesService } from "./billing-disputes.service.js";
export function billingDisputeRoutes(access: PmAccess, D: ReturnType<typeof billingDisputesService>) {
  const g = gate(access);
  return [
    route(api.listBillingDisputes, async (req) => D.list(await g.org(req, "property.read"), req.query)),
    route(api.createBillingDispute, async (req) => D.create(await g.org(req, "property.billing", FINANCE), req.body)),
    route(api.billingDisputeAction, async (req) =>
      D.action(await g.org(req, "property.billing", FINANCE), req.params.disputeId, req.body),
    ),
    route(api.tenantBillingDisputes, async (req) => {
      const s = await g.tenant(req);
      return D.list(s, req.query, s.contact.id);
    }),
    route(api.tenantCreateBillingDispute, async (req) => {
      const s = await g.tenant(req, WRITE);
      return D.create(s, req.body, s.contact.id);
    }),
    route(api.tenantBillingDisputeAction, async (req) => {
      const s = await g.tenant(req, WRITE);
      return D.action(s, req.params.disputeId, req.body, s.contact.id);
    }),
  ];
}
