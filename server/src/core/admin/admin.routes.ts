import { admin } from "@paltas/contracts";
import { route } from "../../http/route.js";
import { listAudit } from "../audit/audit.service.js";
import type { CoreServices } from "../core-services.js";

// Every route here is auth "staff": anyone else gets 404, as if it did not exist.
export function adminRoutes(core: CoreServices) {
  const { admin: A, db } = core;
  return [
    route(admin.getCatalogue, async () => core.catalogue()),
    route(admin.savePlan, async (req) => A.savePlan(req.user, req.params.planId, req.body)),
    route(admin.saveModule, async (req) => A.saveModule(req.user, req.params.moduleKey, req.body)),
    route(admin.listOrganisations, async () => A.listOrganisations()),
    route(admin.createOrganisation, async (req) => A.createOrganisation(req.user, req.body)),
    route(admin.setSubscriptionStatus, async (req) => A.setStatus(req.user, req.params.orgId, req.body)),
    route(admin.addOrgProduct, async (req) => A.addProduct(req.user, req.params.orgId, req.body)),
    route(admin.issueInvoice, async (req) => A.issueInvoice(req.user, req.params.orgId, req.body.product)),
    route(admin.recordReceipt, async (req) => A.recordReceipt(req.user, req.params.invoiceId, req.body)),
    route(admin.adminAudit, async (req) => ({
      entries: await listAudit(db, { orgId: req.query.orgId ?? null, limit: req.query.limit }),
    })),
  ];
}
