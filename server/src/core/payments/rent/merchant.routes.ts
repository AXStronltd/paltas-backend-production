import { rentCollection as api } from "@paltas/contracts";
import type { AppContext } from "../../../context.js";
import type { CoreServices } from "../../core-services.js";
import { route } from "../../../http/route.js";
import { rentMerchantService } from "./merchant.service.js";
export function rentMerchantRoutes(ctx: AppContext, core: CoreServices) {
  const service = rentMerchantService(ctx, ctx.rentStripeClient);
  const scope = (user: Parameters<typeof core.access.scope>[0], orgId: string) =>
    core.access.scope(user, orgId, { capability: "subscription.own" });
  return [
    route(api.merchantWebhook, async (r) =>
      service.webhook(r.rawBody ?? Buffer.alloc(0), r.header("stripe-signature")),
    ),
    route(api.merchantStatus, async (r) => service.status(await scope(r.user, r.params.orgId))),
    route(api.onboardMerchant, async (r) => {
      const s = await core.access.scope(r.user, r.params.orgId, { capability: "subscription.own", write: true });
      await core.signup.requireVerified(s.orgId);
      return service.onboard(s, r.body);
    }),
    route(api.refreshMerchant, async (r) => service.refresh(await scope(r.user, r.params.orgId))),
  ];
}
