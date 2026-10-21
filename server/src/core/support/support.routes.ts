import { admin, support } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { route } from "../../http/route.js";
import type { CoreServices } from "../core-services.js";
import { supportService } from "./support.service.js";

// PALTAS Support chat: clients ("user") and the PALTAS team ("staff", the Super Admin portal).
export function supportRoutes(ctx: AppContext, core: CoreServices) {
  const S = supportService(ctx, { notifications: core.notifications });
  return [
    route(support.listConversations, async (req) => S.list(req.user)),
    route(support.startConversation, async (req) => S.start(req.user, req.body)),
    route(support.getConversation, async (req) => S.get(req.user, req.params.conversationId)),
    route(support.sendMessage, async (req) => S.send(req.user, req.params.conversationId, req.body)),
    route(admin.supportInbox, async (req) => S.inbox(req.user, req.query)),
    route(admin.supportThread, async (req) => S.staffThread(req.user, req.params.conversationId)),
    route(admin.supportReply, async (req) => S.reply(req.user, req.params.conversationId, req.body)),
    route(admin.supportUpdate, async (req) => S.update(req.user, req.params.conversationId, req.body)),
  ];
}
