// HTTP only: notices to tenants and document records.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { ANY_PM_READ, DOCS, gate, WRITE } from "../shared/gate.js";
import type { CommsService } from "./comms.service.js";

export function commsRoutes(access: PmAccess, N: CommsService) {
  const g = gate(access);
  return [
    route(api.publishNotice, async (req) => N.publishNotice(await g.org(req, "property.notices", WRITE), req.body)),
    route(api.listNotices, async (req) => N.listNotices(await g.org(req, "property.read"), req.query.propertyId)),
    route(api.addDocument, async (req) =>
      N.addDocument(await g.org(req, ["property.notices", "property.maintenance.manage"], DOCS), req.body),
    ),
    route(api.listDocuments, async (req) => N.listDocuments(await g.org(req, ANY_PM_READ), req.query)),
  ];
}
