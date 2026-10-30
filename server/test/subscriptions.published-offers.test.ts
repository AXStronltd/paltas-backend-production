import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signupServer } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";
import { approvedOffer } from "../dist/core/subscriptions/published-offers.js";
import { monthlyChargeMinor } from "../dist/core/subscriptions/billing.service.js";
import { resolveEntitlement } from "../dist/core/subscriptions/entitlement.service.js";
import { stripeService } from "../dist/core/subscriptions/stripe.service.js";
import type Stripe from "stripe";

describe("published subscription offers without financial relabelling", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer({}, { env: "production" });
  });
  afterAll(() => S.close());
  it("publishes all fifteen exact monthly USD offers including priced Enterprise", async () => {
    const options = await S.api.signup.options();
    expect(options.plans).toHaveLength(15);
    for (const product of ["property", "agency", "developer", "hotel", "security"]) {
      const plans = options.plans.filter((p) => p.product === product);
      expect(plans.map((p) => [p.tier, p.price.currency, p.price.amount]).sort()).toEqual([
        ["Enterprise", "USD", 99],
        ["Pro", "USD", 69],
        ["Standard", "USD", 49],
      ]);
      expect(plans.every((p) => p.price.frequency === "monthly" && p.modules.length > 0)).toBe(true);
    }
    expect(approvedOffer("PM-STARTER")).toBeNull();
    expect(
      (await S.sql("SELECT base_minor,currency,tax_note FROM catalogue_plans WHERE id='PM-STARTER'"))[0],
    ).toMatchObject({ base_minor: 2500000, currency: "KES" });
  });
  it("a KES business receives an exact USD invoice, retains KES operations, and activates only on confirmed payment", async () => {
    const a = await S.newOrg({ product: "property", plan: "PM-STARTER", currency: "KES", trial: true });
    const params = { orgId: a.orgId };
    const options = await a.admin.api.subscriptions.upgradeOptions({ params, query: {} });
    expect(options.plans).toHaveLength(3);
    expect(options.plans.every((p) => !p.contactSales && p.price?.currency === "USD")).toBe(true);
    const up = await a.admin.api.subscriptions.upgrade({
      params,
      body: {
        plan: "PALTAS-20261027-property-Enterprise",
        frequency: "monthly",
        payment: "bank_transfer",
        confirm: "CONFIRM",
      },
    });
    expect(up.invoice).toMatchObject({ currency: "USD", totalMinor: 9900, taxMinor: 0 });
    expect((await a.admin.api.subscriptions.entitlements({ params, query: {} })).status).toBe("trial");
    expect((await S.sql("SELECT currency FROM organisations WHERE id=$1", [a.orgId]))[0].currency).toBe("KES");
    const event = {
      id: "approved-payment",
      type: "subscription.payment",
      invoiceId: up.invoice!.id,
      status: "succeeded",
      amountMinor: 9900,
      currency: "USD",
      ref: "verified-test-reference",
    };
    expect((await S.webhook(event)).body.result).toMatch(/^Applied/);
    await S.webhook(event);
    expect(
      (await S.sql("SELECT count(*)::int AS n FROM billing_receipts WHERE invoice_id=$1", [up.invoice!.id]))[0].n,
    ).toBe(1);
    const en = await resolveEntitlement(S.app.ctx.db, S.app.ctx.products, "2026-10-11", a.orgId, "property");
    const monthly = monthlyChargeMinor(en!, "2026-10-11");
    expect(monthly.priced).toBe(true);
    expect(monthly.charge).toMatchObject({ currency: "USD", totalMinor: 9900 });
    expect(en!.org.currency).toBe("KES");
  });
  it("resolves the existing approved Stripe lookup only in the configured account and rejects conflicting metadata", async () => {
    const a = await S.newOrg({ product: "property", plan: "PM-STARTER", currency: "KES", trial: true });
    const plan = "PALTAS-20261027-property-Standard";
    const up = await a.admin.api.subscriptions.upgrade({
      params: { orgId: a.orgId },
      body: { plan, frequency: "monthly", payment: "bank_transfer", confirm: "CONFIRM" },
    });
    const original = S.app.ctx.config.stripe;
    S.app.ctx.config.stripe = {
      enabled: true,
      accountId: "acct_fixture",
      secretKey: "rk_test_fixture",
      webhookSecret: "whsec_fixture",
      prices: [],
    };
    let mismatch = true;
    const price = {
      id: "price_published",
      active: true,
      livemode: false,
      currency: "usd",
      unit_amount: 4900,
      tax_behavior: "inclusive",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      billing_scheme: "per_unit",
      metadata: { paltasAccountId: "acct_fixture", paltasProduct: "property", paltasTier: "Standard" },
    };
    const fake = {
      accounts: { retrieve: async () => ({ id: "acct_fixture" }) },
      prices: {
        list: async () => ({
          has_more: false,
          data: [{ ...price, metadata: { ...price.metadata, paltasProduct: mismatch ? "hotel" : "property" } }],
        }),
        retrieve: async () => price,
      },
      checkout: {
        sessions: {
          create: async () => ({
            id: "cs_published",
            url: "https://checkout.stripe.com/c/pay/cs_published",
            livemode: false,
          }),
        },
      },
    } as unknown as Stripe;
    try {
      const service = stripeService(S.app.ctx, S.app.core.payments, fake);
      await expect(service.checkout(a.orgId, "property", up.invoice!.id)).rejects.toMatchObject({ status: 409 });
      mismatch = false;
      const result = await service.checkout(a.orgId, "property", up.invoice!.id);
      expect(result.testMode).toBe(true);
      expect(result.url).toContain("checkout.stripe.com");
    } finally {
      S.app.ctx.config.stripe = original;
    }
  });
});
