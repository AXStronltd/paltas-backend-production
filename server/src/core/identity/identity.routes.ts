import { staffPasswordResetService } from "./staff-password-reset.js";
import { identity } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../http/errors.js";
import { route } from "../../http/route.js";
import type { IdentityService } from "./identity.service.js";
import { staffEnrollmentService } from "./staff-enrollment.js";
import type { PasswordResetService } from "./password-reset.js";

export function identityRoutes(ctx: AppContext, ids: IdentityService, reset: PasswordResetService) {
  const staffReset = staffPasswordResetService(ctx);
  const enrollment = staffEnrollmentService(ctx);
  function sameOrigin(origin: string | undefined) {
    if (origin && origin !== new URL(ctx.config.signup.appBaseUrl).origin)
      throw new ApiError(403, "FORBIDDEN", "Open setup from the PALTAS application origin");
  }
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
    route(identity.beginStaffEnrollment, async (req) => {
      sameOrigin(req.header("origin"));
      return enrollment.begin(req.body.token, req.body.emailCode);
    }),
    route(identity.completeStaffEnrollment, async (req) => {
      sameOrigin(req.header("origin"));
      return enrollment.complete(req.body.token, req.body.code, req.body.newPassword);
    }),
    route(identity.requestStaffPasswordReset, async (req) => {
      sameOrigin(req.header("origin"));
      return staffReset.request(req.body.email, req.ip);
    }),
    route(identity.completeStaffPasswordReset, async (req) => {
      sameOrigin(req.header("origin"));
      return staffReset.complete(req.body);
    }),
    route(identity.loginWithBackup, async (req) => ids.loginWithBackup(req.body, req.ip)),
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
    route(identity.requestPasswordReset, async (req) => reset.request(req.body.email, req.ip)),
    route(identity.completePasswordReset, async (req) => reset.complete(req.body.token, req.body.newPassword)),
    route(identity.startMfa, async (req) => ids.startMfa(req.user)),
    route(identity.confirmMfa, async (req) => {
      await ids.confirmMfa(req.user, req.body.code);
      return { ok: true as const };
    }),
  ];
}
