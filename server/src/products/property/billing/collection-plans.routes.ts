import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, FINANCE, WRITE } from "../shared/gate.js";
import type { collectionPlansService } from "./collection-plans.service.js";
export function collectionPlanRoutes(access: PmAccess, P: ReturnType<typeof collectionPlansService>) {
  const g = gate(access);
  return [
    route(api.tenantUpdateCollectionPlan, async (req) => {
      const s = await g.tenant(req, WRITE);
      return P.update(s, req.params.planId, req.body.expectedVersion, req.body.input, s.contact.id);
    }),
    route(api.tenantCollectionPlanAction, async (req) => {
      const s = await g.tenant(req, WRITE);
      return P.action(s, req.params.planId, req.body, s.contact.id);
    }),
    route(api.listCollectionPlans, async (req) => P.list(await g.org(req, "property.read"), req.query)),
    route(api.createCollectionPlan, async (req) => P.create(await g.org(req, "property.billing", FINANCE), req.body)),
    route(api.updateCollectionPlan, async (req) =>
      P.update(
        await g.org(req, "property.billing", FINANCE),
        req.params.planId,
        req.body.expectedVersion,
        req.body.input,
      ),
    ),
    route(api.collectionPlanAction, async (req) =>
      P.action(await g.org(req, "property.billing", FINANCE), req.params.planId, req.body),
    ),
    route(api.tenantCollectionPlans, async (req) => {
      const s = await g.tenant(req);
      return P.list(s, req.query, s.contact.id);
    }),
    route(api.tenantCreateCollectionPlan, async (req) => {
      const s = await g.tenant(req, WRITE);
      return P.create(s, req.body, s.contact.id);
    }),
  ];
}
