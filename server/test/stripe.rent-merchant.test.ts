import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { startServer, type TestServer } from "./support/test-server.js";
import { PALTAS_STRIPE_ACCOUNT } from "../dist/core/payments/rent/stripe-isolation.js";

const accounts = new Map<string, Stripe.Account>();
const idempotent = new Map<string, Stripe.Account>();
let accountCreates = 0,
  loseCreateResponse = false,
  failLink = false;
const fake = {
  accounts: {
    retrieve: async (id: string | null) => (id ? accounts.get(id) : { id: PALTAS_STRIPE_ACCOUNT }),
    create: async (b: Stripe.AccountCreateParams, o: { idempotencyKey: string }) => {
      let a = idempotent.get(o.idempotencyKey);
      if (!a) {
        a = {
          id: "acct_merchant" + ++accountCreates,
          country: b.country,
          metadata: b.metadata,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          requirements: { currently_due: ["company.tax_id"], past_due: [], disabled_reason: null },
        } as unknown as Stripe.Account;
        accounts.set(a.id, a);
        idempotent.set(o.idempotencyKey, a);
      }
      if (loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error("Synthetic lost network response");
      }
      return a;
    },
  },
  accountLinks: {
    create: async () => {
      if (failLink) throw new Error("Synthetic provider unavailable");
      return { url: "https://connect.stripe.com/setup/synthetic_only" };
    },
  },
} as unknown as Stripe;

describe("Company hosted onboarding in the existing PALTAS account — mocked provider, real persistence", () => {
  let S: TestServer;
  let orgId: string, token: string, otherToken: string, managerToken: string;
  beforeAll(async () => {
    S = await startServer({
      config: {
        stripe: {
          enabled: false,
          accountId: PALTAS_STRIPE_ACCOUNT,
          secretKey: "rk_test_fixture",
          webhookSecret: "whsec_saas_fixture",
          prices: [],
        },
        stripeRent: {
          onboardingEnabled: true,
          enabled: false,
          webhookSecret: "whsec_rent_fixture",
          liveApproved: false,
        },
      },
      rentStripeClient: fake,
    });
    const a = await S.newOrg({ product: "property", trial: false });
    orgId = a.orgId;
    token = a.admin.token;
    otherToken = (await S.newOrg({ product: "property", trial: false })).admin.token;
    managerToken = (await S.addMember(orgId, a.admin.api, "property_manager")).token;
  });
  afterAll(() => S.close());
  const url = () => "/api/v1/orgs/" + orgId + "/rent-collection/merchant";
  const body = { country: "GB", model: "property_manager", confirmLegalCountry: true };
  it("enforces company ownership and jurisdiction selection without advertising operational payments", async () => {
    const r = await S.raw("GET", url(), undefined, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, merchant: null, collectionOperational: false });
    expect(r.body.countries).toEqual(expect.arrayContaining(["US", "GB", "FR"]));
    expect(r.body.countries).not.toContain("KE");
    expect((await S.raw("GET", url(), undefined, otherToken)).status).toBe(404);
    expect((await S.raw("POST", url() + "/onboarding", body, managerToken)).status).toBe(403);
    expect((await S.raw("POST", url() + "/onboarding", { ...body, country: "KE" }, token)).status).toBe(400);
    expect((await S.raw("POST", url() + "/onboarding", { ...body, confirmLegalCountry: false }, token)).status).toBe(
      400,
    );
    expect(accountCreates).toBe(0);
  });
  it("recovers an uncertain creation with the same durable idempotency key and retains just one company account", async () => {
    loseCreateResponse = true;
    expect((await S.raw("POST", url() + "/onboarding", body, token)).status).toBe(409);
    expect(accountCreates).toBe(1);
    const r = await S.raw("POST", url() + "/onboarding", body, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ testMode: true, url: "https://connect.stripe.com/setup/synthetic_only" });
    await S.raw("POST", url() + "/onboarding", body, token);
    expect(accountCreates).toBe(1);
    expect((await S.sql("SELECT count(*)::int n FROM rent_stripe_merchants WHERE org_id=$1", [orgId]))[0].n).toBe(1);
    const status = await S.raw("GET", url(), undefined, token);
    expect(status.body.merchant).toMatchObject({ status: "onboarding", chargesEnabled: false, payoutsEnabled: false });
  });
  it("does not mark a browser return or payout-only capability as approved collection", async () => {
    const m = (await S.sql("SELECT account_id FROM rent_stripe_merchants WHERE org_id=$1", [orgId]))[0];
    const a = accounts.get(m.account_id)!;
    a.payouts_enabled = true;
    const pending = await S.raw("POST", url() + "/refresh", {}, token);
    expect(pending.body.merchant.status).toBe("onboarding");
    expect(pending.body.collectionOperational).toBe(false);
    a.charges_enabled = true;
    a.details_submitted = true;
    const actionRequired = await S.raw("POST", url() + "/refresh", {}, token);
    expect(actionRequired.body.merchant).toMatchObject({
      status: "onboarding",
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    a.requirements!.currently_due = [];
    const ready = await S.raw("POST", url() + "/refresh", {}, token);
    expect(ready.body.merchant).toMatchObject({ status: "verified", chargesEnabled: true, payoutsEnabled: true });
    expect(ready.body.collectionOperational).toBe(false);
    a.charges_enabled = false;
    a.requirements!.disabled_reason = "requirements.past_due";
    const restricted = await S.raw("POST", url() + "/refresh", {}, token);
    expect(restricted.body.merchant.status).toBe("restricted");
  });
  it("rejects cross-workspace provider identity and country changes; retries links without duplicate accounts", async () => {
    const m = (await S.sql("SELECT account_id FROM rent_stripe_merchants WHERE org_id=$1", [orgId]))[0];
    const a = accounts.get(m.account_id)!;
    const original = a.metadata!.paltasOrgId;
    a.metadata!.paltasOrgId = "different_company";
    expect((await S.raw("POST", url() + "/refresh", {}, token)).status).toBe(409);
    a.metadata!.paltasOrgId = original!;
    expect((await S.raw("POST", url() + "/onboarding", { ...body, country: "US" }, token)).status).toBe(409);
    failLink = true;
    expect((await S.raw("POST", url() + "/onboarding", body, token)).status).toBe(409);
    failLink = false;
    expect((await S.raw("POST", url() + "/onboarding", body, token)).status).toBe(200);
    expect(accountCreates).toBe(1);
    expect((await S.sql("SELECT count(*)::int n FROM pm_payments WHERE org_id=$1", [orgId]))[0].n).toBe(0);
    expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n).toBe(0);
    expect(
      (
        await S.sql(
          "SELECT count(*)::int n FROM audit_log WHERE org_id=$1 AND action='Company Stripe onboarding requested'",
          [orgId],
        )
      )[0].n,
    ).toBe(1);
  });
});
