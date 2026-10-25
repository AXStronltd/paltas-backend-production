import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import type { complaintsService } from "./complaints.service.js";
export function complaintRoutes(access: PmAccess, C: ReturnType<typeof complaintsService>) {
  const g = gate(access);
  return [
    route(api.complaintAssignees, async (req) =>
      C.assignees(await g.org(req, "property.maintenance.manage"), req.params.complaintId, req.query.search),
    ),
    route(api.listComplaints, async (req) => C.list(await g.org(req, "property.maintenance.manage"), req.query)),
    route(api.getComplaint, async (req) =>
      C.get(await g.org(req, "property.maintenance.manage"), req.params.complaintId),
    ),
    route(api.createComplaint, async (req) =>
      C.create(await g.org(req, "property.maintenance.manage", WRITE), req.body),
    ),
    route(api.complaintAction, async (req) =>
      C.action(await g.org(req, "property.maintenance.manage", WRITE), req.params.complaintId, req.body),
    ),
    route(api.tenantComplaints, async (req) => {
      const s = await g.tenant(req);
      return C.list(s, req.query, s.contact.id);
    }),
    route(api.tenantGetComplaint, async (req) => {
      const s = await g.tenant(req);
      return C.get(s, req.params.complaintId, s.contact.id);
    }),
    route(api.tenantCreateComplaint, async (req) => {
      const s = await g.tenant(req, WRITE);
      return C.create(s, req.body, s.contact.id);
    }),
    route(api.tenantComplaintAction, async (req) => {
      const s = await g.tenant(req, WRITE);
      return C.action(s, req.params.complaintId, req.body, s.contact.id);
    }),
  ];
}
