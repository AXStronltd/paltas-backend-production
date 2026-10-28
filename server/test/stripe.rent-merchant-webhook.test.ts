import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { startServer, type TestServer } from "./support/test-server.js";
import { rateLimitFor } from "../dist/http/rate-limits.js";
import { rentCollection, subscriptions } from "@paltas/contracts";
import { PALTAS_STRIPE_SANDBOX } from "../dist/core/payments/rent/stripe-isolation.js";

const secret = "whsec_rent_lifecycle_fixture";
const signing = new Stripe("sk_test_signature_fixture");
const path = "/api/v1/rent-collection/merchant/webhook";

describe("Rent merchant lifecycle — signed simulated Stripe events, real database", () => {
  let S: TestServer, orgId: string, token: string, otherOrg: string;
  let providerUnavailable = false;
  let account: Stripe.Account;
  const setup = { country: "GB", model: "property_manager", confirmLegalCountry: true };
  const fake = {
    accounts: {
      retrieve: async (id: string | null) => {
        if (!id) return { id: PALTAS_STRIPE_SANDBOX };
        if (providerUnavailable) throw new Error("Simulated network failure");
        return account;
      },
      create: async (b: Stripe.AccountCreateParams) => {
        account = {
          id: "acct_lifecycleMerchant",
          country: b.country,
          metadata: b.metadata,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], past_due: [], disabled_reason: null },
        } as unknown as Stripe.Account;
        return account;
      },
    },
    accountLinks: { create: async () => ({ url: "https://connect.stripe.com/setup/synthetic" }) },
  } as unknown as Stripe;
  beforeAll(async () => {
    S = await startServer({
      config: {
        stripe: {
          enabled: false,
          accountId: PALTAS_STRIPE_SANDBOX,
          secretKey: "rk_test_fixture",
          webhookSecret: "whsec_saas_fixture",
          prices: [],
        },
        stripeRent: { enabled: false, onboardingEnabled: true, webhookSecret: secret, liveApproved: false },
      },
      rentStripeClient: fake,
    });
    const a = await S.newOrg({ product: "property", trial: false });
    orgId = a.orgId;
    token = a.admin.token;
    otherOrg = (await S.newOrg({ product: "property", trial: false })).orgId;
    expect(
      (await S.raw("POST", `/api/v1/orgs/${orgId}/rent-collection/merchant/onboarding`, setup, token)).status,
    ).toBe(200);
  });
  afterAll(() => S.close());
  const event = (id: string, type = "account.updated", extra = {}) => ({
    id,
    object: "event",
    type,
    account: "acct_lifecycleMerchant",
    livemode: false,
    data: { object: { id: type === "account.updated" ? "acct_lifecycleMerchant" : "ca_application" } },
    ...extra,
  });
  const send = (e: object, timestamp?: number) => {
    const payload = JSON.stringify(e);
    return S.raw("POST", path, payload, undefined, {
      "stripe-signature": signing.webhooks.generateTestHeaderString({
        payload,
        secret,
        ...(timestamp ? { timestamp } : {}),
      }),
    });
  };
  const row = async () => (await S.sql("SELECT * FROM rent_stripe_merchants WHERE org_id=$1", [orgId]))[0];
  it("rate limits both dedicated Connect and existing subscription callbacks", () => {
    const limits = { login: 3, sensitive: 5, webhook: 11, publicRead: 17 };
    for (const api of [rentCollection.onboardMerchant, rentCollection.refreshMerchant])
      expect(rateLimitFor(api, limits)).toMatchObject({ max: 5, timeWindow: "1 minute" });
    for (const api of [rentCollection.merchantWebhook, subscriptions.stripeWebhook])
      expect(rateLimitFor(api, limits)).toEqual({ max: 11, timeWindow: "1 minute" });
  });
  it("rejects unsigned, tampered, expired, wrong-mode and wrong-account callbacks", async () => {
    expect((await S.raw("POST", path, event("evt_unsigned"))).status).toBe(400);
    expect((await S.raw("POST", path, event("evt_bad"), undefined, { "stripe-signature": "invalid" })).status).toBe(
      400,
    );
    expect((await send(event("evt_expired"), Math.floor(Date.now() / 1000) - 600)).status).toBe(400);
    expect((await send(event("evt_live", "account.updated", { livemode: true }))).status).toBe(400);
    expect(
      (await send(event("evt_identity", "account.updated", { data: { object: { id: "acct_other" } } }))).status,
    ).toBe(400);
    expect(await S.sql("SELECT * FROM rent_stripe_merchant_events")).toHaveLength(0);
  });
  it("ignores unrelated accounts and payment/subscription events without financial posting", async () => {
    expect(
      (
        await send(
          event("evt_unmapped", "account.updated", {
            account: "acct_unmapped",
            data: { object: { id: "acct_unmapped" } },
          }),
        )
      ).body.ignored,
    ).toBe(true);
    expect((await send(event("evt_payment", "payment_intent.succeeded"))).body.ignored).toBe(true);
    expect((await send(event("evt_platform", "account.updated", { account: undefined }))).body.ignored).toBe(true);
    expect(await S.sql("SELECT * FROM rent_stripe_merchants WHERE org_id=$1", [otherOrg])).toHaveLength(0);
    expect(await S.sql("SELECT * FROM rent_stripe_merchant_events")).toHaveLength(0);
    expect(await S.sql("SELECT * FROM pm_payments WHERE org_id=$1", [orgId])).toHaveLength(0);
    expect(await S.sql("SELECT * FROM stripe_events")).toHaveLength(0);
  });
  it("uses current provider capabilities, not the event snapshot; concurrent replay is idempotent", async () => {
    account.charges_enabled = false;
    const replies = await Promise.all([send(event("evt_restricted")), send(event("evt_restricted"))]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(replies.filter((r) => r.body.duplicate)).toHaveLength(1);
    expect(await row()).toMatchObject({ charges_enabled: false, status: "onboarding" });
    expect(await S.sql("SELECT * FROM rent_stripe_merchant_events WHERE event_id='evt_restricted'")).toHaveLength(1);
    account.charges_enabled = true;
    expect((await send(event("evt_current"))).status).toBe(200);
    expect((await row()).status).toBe("verified");
  });
  it("rolls back a failed provider verification and safely accepts its retry", async () => {
    providerUnavailable = true;
    expect((await send(event("evt_retry"))).status).toBe(409);
    expect(await S.sql("SELECT * FROM rent_stripe_merchant_events WHERE event_id='evt_retry'")).toHaveLength(0);
    providerUnavailable = false;
    expect((await send(event("evt_retry"))).status).toBe(200);
  });
  it("rejects mismatched workspace provenance and does not consume the event", async () => {
    const previous = account.metadata!.paltasOrgId;
    account.metadata!.paltasOrgId = otherOrg;
    expect((await send(event("evt_wrong_org"))).status).toBe(409);
    expect(await S.sql("SELECT * FROM rent_stripe_merchant_events WHERE event_id='evt_wrong_org'")).toHaveLength(0);
    account.metadata!.paltasOrgId = previous!;
  });
  it("persists disconnection, prevents stale reactivation and requires reviewed reconnection", async () => {
    const e = event("evt_disconnect", "account.application.deauthorized");
    const concurrent = await Promise.all([
      send(e),
      send(event("evt_concurrent_update")),
      S.raw("POST", `/api/v1/orgs/${orgId}/rent-collection/merchant/refresh`, {}, token),
    ]);
    expect(concurrent[0]!.status).toBe(200);
    expect(concurrent[1]!.status).toBe(200);
    expect([200, 409]).toContain(concurrent[2]!.status);
    expect((await send(e)).body.duplicate).toBe(true);
    expect(await row()).toMatchObject({ status: "restricted", charges_enabled: false, payouts_enabled: false });
    expect((await row()).deauthorized_at).not.toBeNull();
    expect((await send(event("evt_stale"))).status).toBe(200);
    expect((await row()).status).toBe("restricted");
    expect((await S.raw("POST", `/api/v1/orgs/${orgId}/rent-collection/merchant/refresh`, {}, token)).status).toBe(409);
    expect(
      (await S.raw("POST", `/api/v1/orgs/${orgId}/rent-collection/merchant/onboarding`, setup, token)).status,
    ).toBe(409);
    expect(
      await S.sql("SELECT * FROM audit_log WHERE org_id=$1 AND action='Company Stripe access disconnected'", [orgId]),
    ).toHaveLength(1);
    const r = await S.raw("GET", `/api/v1/orgs/${orgId}/rent-collection/merchant`, undefined, token);
    expect(r.body).toMatchObject({ merchant: { status: "restricted" }, collectionOperational: false });
  });
});
