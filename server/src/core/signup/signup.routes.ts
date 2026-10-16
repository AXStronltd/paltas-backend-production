// HTTP only: self-service sign-up and verification (public), self-service upgrade and export (the organisation's
// administrator), and the trial policy and sign-up review (PALTAS staff — auth "staff": anyone else gets 404).
import { admin, signup, subscriptions, type Product } from "@paltas/contracts";
import { route, streamRoute } from "../../http/route.js";
import { recordAudit } from "../audit/audit.service.js";
import { staffActor } from "../admin/admin.service.js";
import type { CoreServices } from "../core-services.js";
import { loadPolicy, policyHistory, savePolicy } from "./policy.js";

export function signupRoutes(core: CoreServices) {
  const { access, signup: S, upgrades: U, db } = core;
  return [
    // the public view leaves out how repeats are detected (the response contract drops those fields)
    route(signup.getPolicy, async () => loadPolicy(db)),
    route(signup.getOptions, async () => S.options()),
    route(signup.create, async (req) => S.create(req.body, req.ip)),
    route(signup.verify, async (req) => S.verify(req.body.token)),
    route(signup.resend, async (req) => S.resend(req.user)),

    route(subscriptions.getUpgradeOptions, async (req) =>
      U.options(
        await access.scope(req.user, req.params.orgId, { capability: "subscription.read", product: req.query.product }),
      ),
    ),
    route(subscriptions.upgrade, async (req) => {
      // the plan decides the product, as for a plan change
      const plan = (await core.catalogue()).plans.find((p) => p.id === req.body.plan);
      const product = plan ? ((plan.products[0] === "agents" ? "agency" : plan.products[0]) as Product) : undefined;
      const s = await access.scope(req.user, req.params.orgId, { capability: "subscription.own", product });
      await S.requireVerified(s.orgId);
      return U.upgrade(s, req.body);
    }),
    streamRoute(subscriptions.exportData, async (req) =>
      U.exportData(
        await access.scope(req.user, req.params.orgId, { capability: "subscription.own" }),
        req.query.reason,
      ),
    ),

    route(admin.getTrialPolicy, async () => ({ policy: await loadPolicy(db), history: await policyHistory(db) })),
    route(admin.updateTrialPolicy, async (req) => {
      const actor = staffActor(req.user, "super_admin");
      const { reason, ...input } = req.body;
      return db.tx(async (t) => {
        const { before, after } = await savePolicy(t, input, reason, req.user.id);
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "Platform trial policy changed",
          target: `v${after.version}`,
          detail: reason,
          before,
          after,
        });
        return after;
      });
    }),
    route(admin.listSignups, async (req) => S.list(req.query)),
    route(admin.allowSignup, async (req) =>
      S.allow({ ...staffActor(req.user, "super_admin"), userId: req.user.id }, req.params.signupId, req.body.reason),
    ),
    route(admin.declineSignup, async (req) =>
      S.decline({ ...staffActor(req.user, "super_admin"), userId: req.user.id }, req.params.signupId, req.body.reason),
    ),
    route(admin.listUpgrades, async (req) => U.list(req.query.status)),
  ];
}
