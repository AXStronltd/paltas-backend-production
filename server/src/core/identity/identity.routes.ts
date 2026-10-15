import { identity } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../http/errors.js";
import { route } from "../../http/route.js";
import type { IdentityService } from "./identity.service.js";

export function identityRoutes(ctx: AppContext, ids: IdentityService) {
  return [
    // "ok" means the database answers too, so the host's health check notices when it cannot be reached
    route(identity.health, async () => {
      try {
        await ctx.db.row("SELECT 1");
      } catch {
        throw new ApiError(503, "SERVER_ERROR", "The database is not reachable");
      }
      return {
        ok: true as const,
        database: "postgres" as const,
        billingMode: ctx.config.billingMode,
        today: ctx.clock.today(),
      };
    }),
    route(identity.login, async (req) => ids.login(req.body, req.ip)),
    route(identity.logout, async (req) => {
      await ids.logout(req.user);
      return { ok: true as const };
    }),
    route(identity.me, async (req) => ids.me(req.user)),
    route(identity.acceptInvitation, async (req) => {
      await ids.answerInvitation(req.user, req.params.orgId, true);
      return { ok: true as const };
    }),
    route(identity.declineInvitation, async (req) => {
      await ids.answerInvitation(req.user, req.params.orgId, false);
      return { ok: true as const };
    }),
    route(identity.changePassword, async (req) => {
      await ids.changePassword(req.user, req.body.currentPassword, req.body.newPassword);
      return { ok: true as const };
    }),
    route(identity.startMfa, async (req) => ids.startMfa(req.user)),
    route(identity.confirmMfa, async (req) => {
      await ids.confirmMfa(req.user, req.body.code);
      return { ok: true as const };
    }),
  ];
}
