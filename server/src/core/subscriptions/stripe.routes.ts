import { subscriptions } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { CoreServices } from "../core-services.js";
import { route } from "../../http/route.js";
import { fail } from "../../http/errors.js";
import { stripeService } from "./stripe.service.js";
export function stripeRoutes(ctx: AppContext, core: CoreServices) {
  const stripe = stripeService(ctx, core.payments);
  return [
    route(subscriptions.stripeCheckout, async (req) => {
      await core.access.scope(req.user, req.params.orgId, { capability: "subscription.own" });
      await core.signup.requireVerified(req.params.orgId);
      const invoice = await ctx.db.row<{ product: "property" | "hotel" | "developer" | "agency" | "security" }>(
        "SELECT product FROM billing_invoices WHERE id=$1 AND org_id=$2",
        [req.body.invoiceId, req.params.orgId],
      );
      if (!invoice) throw fail.notFound("Invoice not found");
      await core.access.scope(req.user, req.params.orgId, { capability: "subscription.own", product: invoice.product });
      return stripe.checkout(req.params.orgId, invoice.product, req.body.invoiceId);
    }),
    route(subscriptions.stripePortal, async (req) => {
      await core.access.scope(req.user, req.params.orgId, {
        capability: "subscription.own",
        product: req.body.product,
      });
      await core.signup.requireVerified(req.params.orgId);
      return stripe.portal(req.params.orgId, req.body.product, req.body.action);
    }),
    route(subscriptions.stripeWebhook, async (req) =>
      stripe.webhook(req.rawBody ?? Buffer.alloc(0), req.header("stripe-signature")),
    ),
  ];
}
