import { organisations } from "@paltas/contracts";
import { route } from "../../http/route.js";
import { listAudit } from "../audit/audit.service.js";
import type { CoreServices } from "../core-services.js";

export function organisationsRoutes(core: CoreServices) {
  const { access, organisations: O, db } = core;
  return [
    route(organisations.getOrganisation, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "org.read" });
      return O.get(req.params.orgId);
    }),
    route(organisations.listMembers, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "members.read" });
      return O.listMembers(req.params.orgId);
    }),
    route(organisations.addMember, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "members.manage",
        write: true,
        anyProduct: true,
      });
      // a self-service organisation invites its team once its administrator's e-mail address is verified
      await core.signup.requireVerified(s.orgId);
      return O.addMember(s, req.body);
    }),
    route(organisations.updateMember, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "members.manage" });
      return O.updateMember(s, req.params.userId, req.body);
    }),
    route(organisations.listAudit, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "audit.read" });
      return {
        entries: await listAudit(db, {
          orgId: req.params.orgId,
          limit: req.query.limit,
          beforeId: req.query.before ?? null,
        }),
      };
    }),
  ];
}
