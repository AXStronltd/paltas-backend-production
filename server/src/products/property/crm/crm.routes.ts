// HTTP only: enquiries, leads, viewings and applications.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { CRM, gate } from "../shared/gate.js";
import type { crmWorkService } from "./work.service.js";
import type { CrmService } from "./crm.service.js";

export function crmRoutes(access: PmAccess, C: CrmService, W: ReturnType<typeof crmWorkService>) {
  const g = gate(access);
  const work = (req: Parameters<typeof g.org>[0]) => g.org(req, "property.crm", CRM);
  const read = (req: Parameters<typeof g.org>[0]) => g.org(req, ["property.crm", "property.read"]);
  return [
    route(api.listCrmWork, async (r) => W.list(await g.org(r, "property.crm"), r.query)),
    route(api.createCrmWork, async (r) => W.create(await work(r), r.body)),
    route(api.updateCrmWork, async (r) => W.update(await work(r), r.params.taskId, r.body)),
    route(api.crmWorkHistory, async (r) => W.history(await g.org(r, "property.crm"), r.params.taskId)),
    route(api.crmAssignees, async (r) => W.assignees(await g.org(r, "property.crm"), r.query.propertyId)),
    route(api.crmMessageLog, async (r) => W.messages(await g.org(r, "property.crm"), r.query)),
    route(api.createEnquiry, async (req) => C.enquiry(await work(req), req.body)),
    route(api.listLeads, async (req) => C.listLeads(await read(req), req.query.stage)),
    route(api.moveLead, async (req) => C.move(await work(req), req.params.leadId, req.body)),
    route(api.loseLead, async (req) => C.lose(await work(req), req.params.leadId, req.body)),
    route(api.scheduleViewing, async (req) => C.scheduleViewing(await work(req), req.body)),
    route(api.viewingOutcome, async (req) => C.viewingOutcome(await work(req), req.params.viewingId, req.body)),
    route(api.listViewings, async (req) => C.listViewings(await read(req), req.query.date)),
    route(api.startApplication, async (req) => C.startApplication(await work(req), req.body)),
    route(api.listApplications, async (req) => C.listApplications(await read(req))),
    route(api.screenApplication, async (req) => C.screen(await work(req), req.params.applicationId, req.body)),
    route(api.decideApplication, async (req) =>
      C.decide(await g.org(req, "property.crm.approve", CRM), req.params.applicationId, req.body),
    ),
    route(api.convertApplication, async (req) =>
      C.convert(await g.org(req, ["property.leases.manage"], CRM), req.params.applicationId),
    ),
  ];
}
