import { entitlements as rules, subscriptions, type Product } from "@paltas/contracts";
import { fail } from "../../http/errors.js";
import { route } from "../../http/route.js";
import type { CoreServices } from "../core-services.js";

// Self-service changes (renew, upgrade, cancel, buy an add-on) deliberately also work on a lapsed subscription:
// that is how a customer comes back. Only buying more allowance needs an active subscription. Anything that leads to
// a payment waits for a self-service organisation's verified e-mail address (core/signup).
export function subscriptionsRoutes(core: CoreServices) {
  const { access, subscriptions: S } = core;
  return [
    route(subscriptions.getEntitlements, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "org.read", product: req.query.product });
      return S.entitlements(s);
    }),
    route(subscriptions.getSubscription, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "subscription.read",
        product: req.query.product,
      });
      return S.summary(s);
    }),
    route(subscriptions.listProducts, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "subscription.read" });
      return S.listProducts(req.params.orgId);
    }),
    route(subscriptions.addProduct, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "subscription.own" });
      await core.signup.requireVerified(s.orgId);
      return S.addProduct(s, req.body.product, req.body.plan);
    }),
    route(subscriptions.buyAddon, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "subscription.manage",
        product: req.body.product,
      });
      await core.signup.requireVerified(s.orgId);
      return S.buyAddon(s, req.body.module);
    }),
    route(subscriptions.cancelAddon, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "subscription.manage",
        product: req.query.product,
      });
      return S.cancelAddon(s, req.params.module);
    }),
    route(subscriptions.changePlan, async (req) => {
      // the plan decides the product: a plan for one product can never change another product's subscription
      const plan = (await core.catalogue()).plans.find((p) => p.id === req.body.plan);
      if (!plan) throw fail.invalid("Unknown plan");
      const product = (plan.products[0] === "agents" ? "agency" : plan.products[0]) as Product;
      const first = await access.scope(req.user, req.params.orgId, { capability: "subscription.manage" });
      if (!first.entitlement.products.includes(product)) {
        throw fail.invalid(
          `Your organisation has no ${rules.PRODUCT_NAME[product] ?? product} subscription — add the product first`,
          { addProduct: product },
        );
      }
      const s =
        product === first.product
          ? first
          : await access.scope(req.user, req.params.orgId, { capability: "subscription.manage", product });
      await core.signup.requireVerified(s.orgId);
      return S.changePlan(s, plan.id);
    }),
    route(subscriptions.buyAllowance, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "subscription.manage",
        product: req.body.product,
        write: true,
      });
      await core.signup.requireVerified(s.orgId);
      return S.buyAllowance(s);
    }),
    route(subscriptions.cancelSubscription, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "subscription.own",
        product: req.body.product,
      });
      return S.cancel(s, req.body.reason);
    }),
    route(subscriptions.withdrawPending, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "subscription.manage" });
      return S.withdrawPending(s, req.params.pendingId);
    }),
    route(subscriptions.sendEnterpriseEnquiry, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "subscription.manage" });
      return S.enterpriseEnquiry(s, req.body.note);
    }),
  ];
}
