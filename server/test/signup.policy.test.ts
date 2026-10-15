// The ONE platform trial policy: the database row equals the shared rules' default (so the browser shows the same
// numbers), only a Super Admin changes it (audited, every version kept), and a change reaches new trials of EVERY
// product through EVERY path — self-service sign-up, staff onboarding, staff and self-service further products, the
// agency "For Business" approval — while per-plan trial days no longer matter. The second-product rule is applied
// identically to every product, and the server and the rules (TypeScript and the generated browser file) agree.
import { createRequire } from "node:module";
import { entitlements, type Product } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staffMember } from "./support/platform-fixtures.js";
import {
  ALL_PRODUCTS,
  dailyJobs,
  signUpAndIn,
  signupServer,
  STANDARD,
  verificationToken,
} from "./support/signup-fixture.js";
import { refused, TODAY, type TestServer } from "./support/test-server.js";

const browserRules: typeof entitlements = createRequire(import.meta.url)("../../browser/entitlements.js");

const plus = (d: string, n: number) => entitlements.addDays(d, n);

describe("the platform trial policy", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  const policyBody = (o: Record<string, unknown> = {}) => ({
    trialDays: 30,
    graceDays: 7,
    reminderDays: [7, 3, 1],
    verifyWithinDays: 7,
    verifyLinkHours: 48,
    repeatWindowDays: 365,
    repeatMatch: ["email", "phone", "company"] as ("email" | "phone" | "company")[],
    secondProduct: "own_trial" as "own_trial" | "no_trial",
    exportAllowed: true,
    reason: "Test policy change",
    ...o,
  });
  const trialOf = async (orgId: string, product: Product) =>
    (
      await S.sql<{ status: string; trial_ends: string | null; grace_days: number; trial_policy_version: number }>(
        "SELECT status, trial_ends, grace_days, trial_policy_version FROM subscriptions WHERE org_id = $1 AND product = $2",
        [orgId, product],
      )
    )[0]!;

  beforeAll(async () => {
    S = await signupServer();
    sa = await S.staff();
  });
  afterAll(() => S.close());

  it("starts as the rules' DEFAULT_TRIAL_POLICY — the number the browser files show", async () => {
    const D = entitlements.DEFAULT_TRIAL_POLICY;
    const pub = await S.api.signup.policy();
    // the public view leaves out how repeats are detected
    expect({ ...pub, repeatWindowDays: D.repeatWindowDays, repeatMatch: D.repeatMatch }).toEqual({ ...D, version: 1 });
    expect(pub).not.toHaveProperty("repeatMatch");
    const { policy, history } = await sa.api.admin.trialPolicy();
    expect(policy).toEqual({ ...D, version: 1, updatedAt: expect.any(String) });
    expect(browserRules.DEFAULT_TRIAL_POLICY).toEqual(entitlements.DEFAULT_TRIAL_POLICY);
    expect(history.map((h) => [h.version, h.changedBy])).toEqual([[1, null]]);
    // every plan in the catalogue shows the policy's trial length, whatever its own (unused) column says
    await S.sql("UPDATE catalogue_plans SET trial_days = 5 WHERE id = 'HOTEL-STD'");
    const cat = await sa.api.admin.catalogue();
    expect(new Set(cat.plans.map((p) => p.trialDays))).toEqual(new Set([30]));
  });

  it("only a Super Admin changes it: audited, versioned, validated", async () => {
    const support = await staffMember(S, "support");
    await refused(support.api.admin.updateTrialPolicy({ body: policyBody() }), 403, "STAFF_ROLE_NOT_ALLOWED");
    const client = await signUpAndIn(S, "property");
    const r = await S.raw("PUT", "/api/v1/admin/trial-policy", policyBody(), client.token);
    expect(r.status).toBe(404); // staff endpoints do not exist for clients
    await refused(sa.api.admin.updateTrialPolicy({ body: policyBody({ trialDays: 5, reminderDays: [7] }) }), 400);
    await refused(sa.api.admin.updateTrialPolicy({ body: policyBody({ trialDays: 0 }) }), 400);
    await refused(sa.api.admin.updateTrialPolicy({ body: policyBody({ reason: "x" }) }), 400);
    expect((await S.api.signup.policy()).version).toBe(1);
  });

  it("a change reaches new trials of every product through every path, identically", async () => {
    const before = await signUpAndIn(S, "hotel"); // started under version 1: keeps 30 + 7
    const changed = await sa.api.admin.updateTrialPolicy({
      body: policyBody({ trialDays: 14, graceDays: 2, reminderDays: [5, 1], reason: "Shorter trial for Q4" }),
    });
    expect([changed.version, changed.trialDays, changed.graceDays, changed.reminderDays]).toEqual([2, 14, 2, [5, 1]]);
    const audit = await sa.api.admin.audit({ query: { limit: 20 } });
    const entry = audit.entries.find((e) => e.action === "Platform trial policy changed")!;
    expect([entry.target, entry.detail]).toEqual(["v2", "Shorter trial for Q4"]);
    const hist = (await sa.api.admin.trialPolicy()).history;
    expect(hist.map((h) => [h.version, h.reason, (h.policy as { trialDays: number }).trialDays])).toEqual([
      [2, "Shorter trial for Q4", 14],
      [1, "Initial platform trial policy (migration 0013)", 30],
    ]);
    await expect(S.sql("UPDATE trial_policy_history SET reason = 'rewritten' WHERE version = 1")).rejects.toThrow(
      /cannot be changed/,
    );

    const want = { status: "trial", trial_ends: plus(TODAY, 14), grace_days: 2, trial_policy_version: 2 };
    expect(await trialOf(before.orgId, "hotel")).toEqual({
      ...want,
      trial_ends: plus(TODAY, 30),
      grace_days: 7,
      trial_policy_version: 1,
    });
    for (const p of ALL_PRODUCTS) {
      // 1. self-service sign-up
      const a = await signUpAndIn(S, p);
      expect(await trialOf(a.orgId, p)).toEqual(want);
      // 2. staff onboarding
      const staffOrg = await sa.api.admin.createOrganisation({
        body: {
          name: `Staff onboarded ${p} business`,
          product: p,
          plan: STANDARD[p],
          country: "Kenya",
          currency: "KES",
          timezone: "Africa/Nairobi",
          trial: true,
          admin: { email: `staff-onboarded+${p}@business.test` },
        },
      });
      expect(await trialOf(staffOrg.id, p)).toEqual(want);
      // 3. a further product added by staff, and 4. by the (verified) customer
      const other = ALL_PRODUCTS.find((x) => x !== p)!;
      await sa.api.admin.addProduct({
        params: { orgId: staffOrg.id },
        body: { product: other, plan: STANDARD[other], trial: true },
      });
      expect(await trialOf(staffOrg.id, other)).toEqual(want);
      await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
      const added = await a.api.subscriptions.addProduct({
        params: { orgId: a.orgId },
        body: { product: other, plan: STANDARD[other], confirm: "CONFIRM" },
      });
      expect([added.status, added.trialEnds]).toEqual(["trial", plus(TODAY, 14)]);
      expect(await trialOf(a.orgId, other)).toEqual(want);
      // 5. the agency "For Business" request approved by PALTAS staff (core onboarding)
      const req = await S.api.marketplace.requestBusiness({
        body: {
          product: p,
          orgName: `For Business ${p} applicant`,
          country: "Kenya",
          currency: "KES",
          timezone: "Africa/Nairobi",
          contactName: "Grace Wanjiru",
          contactEmail: `for-business+${p}@business.test`,
          authorityConfirmed: true,
        },
      });
      const pending = (await sa.api.marketplace.businessRequests({ query: { status: "pending" } })).requests;
      const id = pending.find((x) => x.reference === req.reference)!.id;
      const ok = await sa.api.marketplace.approveBusinessRequest({
        params: { requestId: id },
        body: { plan: STANDARD[p], trial: true },
      });
      expect(await trialOf(ok.request.orgId!, p)).toEqual(want);
    }
    // the offers and the catalogue show the same number for every plan
    const offer = await before.api.subscriptions.listProducts({ params: { orgId: before.orgId } });
    expect(new Set(offer.products.flatMap((x) => (x.offer ?? []).map((o) => o.trialDays)))).toEqual(new Set([14]));
    expect(new Set((await sa.api.admin.catalogue()).plans.map((x) => x.trialDays))).toEqual(new Set([14]));
  });

  it("second product, one rule for all: own trial (once per product) or, when switched off, paid from day one", async () => {
    await sa.api.admin.updateTrialPolicy({
      body: policyBody({ secondProduct: "no_trial", reason: "Second products are paid" }),
    });
    for (const p of ALL_PRODUCTS) {
      const a = await signUpAndIn(S, p);
      await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
      const other = ALL_PRODUCTS.find((x) => x !== p)!;
      const r = await a.api.subscriptions.addProduct({
        params: { orgId: a.orgId },
        body: { product: other, plan: STANDARD[other], confirm: "CONFIRM" },
      });
      expect([r.status, r.trialEnds, r.invoice?.status]).toEqual(["awaiting payment", null, "Open"]);
      expect((await trialOf(a.orgId, other)).status).toBe("expired"); // read-only until its invoice is paid
      const third = ALL_PRODUCTS.find((x) => x !== p && x !== other)!;
      await refused(
        sa.api.admin.addProduct({
          params: { orgId: a.orgId },
          body: { product: third, plan: STANDARD[third], trial: true },
        }),
        409,
      );
    }
    await sa.api.admin.updateTrialPolicy({ body: policyBody({ reason: "Back to the default policy" }) });
  });

  it("the entitlement rules (TypeScript and the browser file) agree with the server, day by day", async () => {
    const a = await signUpAndIn(S, "security");
    await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
    for (const day of [TODAY, plus(TODAY, 23), plus(TODAY, 30), plus(TODAY, 31), plus(TODAY, 37), plus(TODAY, 38)]) {
      await dailyJobs(S, day);
      const server = await a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: {} });
      const [row] = await S.sql<{
        status: "trial" | "expired";
        trial_ends: string;
        grace_days: number;
        anchor: string | null;
      }>("SELECT status, trial_ends, grace_days, anchor FROM subscriptions WHERE org_id = $1", [a.orgId]);
      const sub = {
        plan: "SEC-STD",
        status: row!.status,
        trialEnds: row!.trial_ends,
        graceDays: row!.grace_days,
        anchor: row!.anchor,
      };
      expect(server.trial).toEqual(entitlements.trialState(sub, day));
      expect(server.trial).toEqual(browserRules.trialState(sub, day));
      const org = { id: a.orgId, name: "x", type: "security" as const, currency: "KES", ent: sub };
      const cat = { modules: [], plans: [] };
      expect(server.usable).toBe(browserRules.resolve(cat, org, day)!.usable);
      expect((await a.api.identity.me()).organisations[0]!.trials[0]).toEqual({ product: "security", ...server.trial });
    }
    S.setToday(TODAY);
  });
});
