import { notifications } from "@paltas/contracts";
import type { Config } from "../../config.js";
import { route } from "../../http/route.js";
import type { CoreServices } from "../core-services.js";
import { parseEmailEvents, verifyEmailWebhook } from "./email-providers.js";

// Organisation routes: notifications.read to look, notifications.manage (active subscription) to change.
// The delivery webhook is verified by the route layer (auth "signed-webhook", WEBHOOK_SECRET_<PROVIDER>).
export function notificationsRoutes(core: CoreServices, config: Config) {
  const { access, notifications: N } = core;
  const read = (user: Parameters<typeof access.scope>[0], orgId: string) =>
    access.scope(user, orgId, { capability: "notifications.read", anyProduct: true });
  const manage = (user: Parameters<typeof access.scope>[0], orgId: string) =>
    access.scope(user, orgId, { capability: "notifications.manage", write: true, anyProduct: true });

  return [
    route(notifications.listProviders, async (req) => {
      await read(req.user, req.params.orgId);
      return { providers: N.providers() };
    }),
    route(notifications.listSenders, async (req) => {
      await read(req.user, req.params.orgId);
      return { senders: await N.senders(req.params.orgId) };
    }),
    route(notifications.saveSender, async (req) =>
      N.saveSender(await manage(req.user, req.params.orgId), req.params.channel, req.body),
    ),
    route(notifications.listTemplates, async (req) => {
      await read(req.user, req.params.orgId);
      return { templates: await N.templates(req.params.orgId) };
    }),
    route(notifications.saveTemplate, async (req) =>
      N.saveTemplate(await manage(req.user, req.params.orgId), req.params.key, req.params.channel, req.body),
    ),
    route(notifications.listConsents, async (req) => {
      await read(req.user, req.params.orgId);
      return { consents: await N.consents(req.params.orgId, req.query.address) };
    }),
    route(notifications.recordConsent, async (req) =>
      N.recordConsent(await manage(req.user, req.params.orgId), req.body),
    ),
    route(notifications.listMessages, async (req) => {
      await read(req.user, req.params.orgId);
      return { messages: await N.messages(req.params.orgId, req.query) };
    }),
    route(notifications.getMessage, async (req) => {
      await read(req.user, req.params.orgId);
      return N.message(req.params.orgId, req.params.messageId);
    }),
    route(notifications.recordMessage, async (req) =>
      N.recordByHand(await manage(req.user, req.params.orgId), req.body),
    ),
    route(notifications.deliveryWebhook, async (req) => N.receiveReport(req.params.provider, req.body)),
    // verified here, on the exact bytes received, with the provider's own scheme (not the PALTAS HMAC header)
    route(notifications.emailWebhook, async (req) => {
      const p = req.params.provider;
      verifyEmailWebhook(config.email, p, req.header, req.rawBody ?? Buffer.alloc(0));
      return N.receiveEmailEvents(p, parseEmailEvents(p, req.body, req.header));
    }),
  ];
}
