// HTTP only: the shared contact store. Contacts belong to the organisation, whichever product it holds, so access is
// checked against any usable subscription of the organisation (anyProduct). Another organisation's contact: 404.
import { contacts as api, type Capability } from "@paltas/contracts";
import { route } from "../../http/route.js";
import type { CoreServices } from "../core-services.js";
import type { SessionUser } from "../identity/identity.service.js";

export function contactsRoutes(core: CoreServices) {
  const { access, contacts: C, db } = core;
  const scope = (user: SessionUser, orgId: string, capability: Capability, write = false) =>
    access.scope(user, orgId, { capability, write, anyProduct: true });

  return [
    route(api.listContacts, async (req) => {
      const s = await scope(req.user, req.params.orgId, "contacts.read");
      return {
        contacts: await C.list(req.params.orgId, {
          q: req.query.q,
          type: req.query.type,
          includeMerged: req.query.includeMerged === "true",
          includeArchived: req.query.includeArchived === "true",
          propertyIds: s.propertyIds,
          userId: s.userId,
        }),
      };
    }),
    route(api.createContact, async (req) =>
      C.create(await scope(req.user, req.params.orgId, "contacts.manage", true), req.body),
    ),
    route(api.getContact, async (req) => {
      await scope(req.user, req.params.orgId, "contacts.read");
      return C.detail(req.params.orgId, req.params.contactId);
    }),
    route(api.updateContact, async (req) =>
      C.update(await scope(req.user, req.params.orgId, "contacts.manage", true), req.params.contactId, req.body),
    ),
    route(api.listDuplicates, async (req) => {
      await scope(req.user, req.params.orgId, "contacts.read");
      return { groups: await C.duplicates(req.params.orgId) };
    }),
    route(api.mergeContacts, async (req) =>
      C.merge(
        await scope(req.user, req.params.orgId, "contacts.merge", true),
        req.params.contactId,
        req.body.mergeId,
        req.body.reason,
      ),
    ),
    route(api.addActivity, async (req) => {
      const s = await scope(req.user, req.params.orgId, "contacts.manage", true);
      return db.tx(async (t) => {
        await C.live(t, s.orgId, req.params.contactId);
        return C.activity(t, {
          orgId: s.orgId,
          contactId: req.params.contactId,
          kind: req.body.kind,
          text: req.body.text,
          by: s.userId,
        });
      });
    }),
    route(api.recordMessage, async (req) => {
      const s = await scope(req.user, req.params.orgId, "contacts.manage", true);
      return db.tx((t) =>
        C.recordMessage(t, {
          orgId: s.orgId,
          contactId: req.params.contactId,
          channel: req.body.channel,
          direction: req.body.direction,
          subject: req.body.subject,
          body: req.body.body,
          marketing: req.body.marketing,
          idempotencyKey: req.body.idempotencyKey ?? null,
          by: s.userId,
        }),
      );
    }),
  ];
}
