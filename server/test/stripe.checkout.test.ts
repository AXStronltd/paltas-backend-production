import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { stripeService } from "../dist/core/subscriptions/stripe.service.js";
import { signUpAndIn, signupServer, verificationToken, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("Stripe subscription checkout safety", () => {
  let S: TestServer, a: Account, invoiceId: string, amount: number, currency: string;
  let priceAmount = 0,
    subStatus = "active",
    event: Record<string, unknown> = {},
    invoice: Record<string, unknown> = {},
    sessionCreates = 0;
  const secret = "whsec_fixture_only";
  let providerAccount = "acct_fixture";
  let providerApplication = "paltas";
  let portalCreates = 0;
  let portalUpdatesEnabled = false;
  let scheduledCancellation = false;
  let explicitCancellation = false;
  let portalRedirect = "https://billing.stripe.com/p/session_fixture";
  let lastPortalBody: Record<string, any> = {};
  const fake = {
    accounts: { retrieve: async () => ({ id: providerAccount }) },
    billingPortal: {
      configurations: {
        retrieve: async () => ({
          active: true,
          livemode: false,
          metadata: { paltasAccountId: "acct_fixture", paltasApplication: "paltas" },
          features: {
            subscription_update: { enabled: portalUpdatesEnabled },
            subscription_cancel: { enabled: true, mode: "at_period_end" },
          },
        }),
      },
      sessions: {
        create: async (body: Record<string, any>) => {
          portalCreates++;
          lastPortalBody = body;
          return { url: portalRedirect };
        },
      },
    },
    prices: {
      retrieve: async () => ({
        id: "price_fixture",
        active: true,
        livemode: false,
        currency: currency.toLowerCase(),
        unit_amount: priceAmount,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        billing_scheme: "per_unit",
      }),
    },
    checkout: {
      sessions: {
        create: async (body: any) => {
          sessionCreates++;
          expect(body.mode).toBe("subscription");
          expect(body.ui_mode).toBeUndefined(); // Stripe chooses its version-compatible hosted-page default.
          expect(body.metadata).toMatchObject({
            paltasApplication: "paltas",
            paltasAccountId: "acct_fixture",
            paltasMode: "test",
          });
          expect(body.subscription_data.metadata).toEqual(body.metadata);
          expect(body.subscription_data.trial_period_days).toBeUndefined();
          return { id: "cs_fixture", url: "https://checkout.stripe.com/c/pay/cs_fixture", livemode: false };
        },
        retrieve: async () => ({
          id: "cs_fixture",
          status: "open",
          mode: "subscription",
          client_reference_id: checkoutId,
          subscription: "sub_fixture",
          customer: "cus_fixture",
          metadata: {
            paltasCheckoutId: checkoutId,
            paltasApplication: "paltas",
            paltasAccountId: "acct_fixture",
            paltasMode: "test",
          },
          url: "https://checkout.stripe.com/c/pay/cs_fixture",
          livemode: false,
        }),
      },
    },
    invoices: { retrieve: async () => invoice },
    paymentIntents: {
      retrieve: async () => ({
        status: "succeeded",
        amount_received: amount,
        currency: currency.toLowerCase(),
        customer: "cus_fixture",
      }),
    },
    subscriptions: {
      retrieve: async () => ({
        id: "sub_fixture",
        livemode: false,
        cancel_at_period_end: scheduledCancellation,
        cancel_at: scheduledCancellation || explicitCancellation ? 1794355200 : null,
        items: { data: [{ current_period_end: 1794355200 }] },
        customer: "cus_fixture",
        status: subStatus,
        metadata: {
          paltasCheckoutId: checkoutId,
          paltasApplication: providerApplication,
          paltasAccountId: "acct_fixture",
          paltasMode: "test",
        },
      }),
    },
    webhooks: new Stripe("sk_test_fixture").webhooks,
  } as unknown as Stripe;
  let checkoutId: string, service: ReturnType<typeof stripeService>;
  const send = async (type: string, id: string) => {
    event = { id, type, livemode: false, data: { object: { id: invoice.id || "sub_fixture" } } };
    const payload = JSON.stringify(event),
      header = new Stripe("sk_test_fixture").webhooks.generateTestHeaderString({ payload, secret });
    return service.webhook(Buffer.from(payload), header);
  };
  beforeAll(async () => {
    S = await signupServer(
      {},
      {
        stripe: {
          enabled: true,
          accountId: "acct_fixture",
          portalConfigurationId: "bpc_fixture",
          secretKey: "rk_test_fixture",
          webhookSecret: secret,
          prices: [{ planId: "PM-STARTER", currency: "KES", priceId: "price_fixture" }],
        },
      },
    );
    a = await signUpAndIn(S, "property");
    await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
    const up = await a.api.subscriptions.upgrade({
      params: { orgId: a.orgId },
      body: { plan: "PM-STARTER", frequency: "monthly", payment: "provider", confirm: "CONFIRM" },
    });
    expect(up.payment.instructions).toMatch(/Stripe sandbox/);
    invoiceId = up.invoice!.id;
    amount = up.invoice!.netMinor;
    currency = up.invoice!.currency;
    priceAmount = amount;
    // The hosted path currently requires simple, unadjusted approved prices.
    await S.sql("UPDATE billing_invoices SET tax_minor=0,tax_pct=0,total_minor=net_minor WHERE id=$1", [invoiceId]);
    service = stripeService(S.app.ctx, S.app.core.payments, fake);
  });
  afterAll(async () => S?.close());
  it("refuses a wrong-account key before creating a session or records", async () => {
    providerAccount = "acct_unrelatedfixture";
    try {
      await expect(service.checkout(a.orgId, "property", invoiceId)).rejects.toMatchObject({ status: 409 });
      expect(sessionCreates).toBe(0);
      expect(await S.sql("SELECT 1 FROM stripe_checkouts")).toEqual([]);
    } finally {
      providerAccount = "acct_fixture";
    }
  });
  it("rejects connected-account events before recording them", async () => {
    const payload = JSON.stringify({
      id: "evt_foreign_account",
      type: "invoice.paid",
      account: "acct_unrelatedfixture",
      livemode: false,
      data: { object: { id: "in_foreign" } },
    });
    const header = new Stripe("sk_test_fixture").webhooks.generateTestHeaderString({ payload, secret });
    await expect(service.webhook(Buffer.from(payload), header)).rejects.toMatchObject({ status: 400 });
    expect(await S.sql("SELECT 1 FROM stripe_events WHERE id='evt_foreign_account'")).toEqual([]);
  });
  it("rejects foreign invoices and mismatched catalogue prices", async () => {
    await expect(service.checkout("another-org", "property", invoiceId)).rejects.toMatchObject({ status: 404 });
    priceAmount = amount + 1;
    await expect(service.checkout(a.orgId, "property", invoiceId)).rejects.toMatchObject({ status: 409 });
    priceAmount = amount;
    expect(await S.sql("SELECT 1 FROM stripe_checkouts")).toEqual([]);
  });
  it("creates hosted recurring checkout once, without resetting the 30-day trial", async () => {
    const before = await a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: {} });
    const first = await service.checkout(a.orgId, "property", invoiceId);
    const second = await service.checkout(a.orgId, "property", invoiceId);
    expect(first).toEqual(second);
    expect(sessionCreates).toBe(1);
    expect(first.testMode).toBe(true);
    checkoutId = (await S.sql("SELECT id FROM stripe_checkouts"))[0].id;
    expect((await a.api.subscriptions.entitlements({ params: { orgId: a.orgId }, query: {} })).trial).toEqual(
      before.trial,
    );
    expect((await S.sql("SELECT status FROM billing_invoices WHERE id=$1", [invoiceId]))[0].status).toBe("Open");
  });
  it("records matching checkout metadata without treating checkout as payment", async () => {
    expect((await send("checkout.session.completed", "evt_checkout")).result).toMatch(/awaiting verified invoice/);
    expect((await S.sql("SELECT status FROM billing_invoices WHERE id=$1", [invoiceId]))[0].status).toBe("Open");
    expect(await S.sql("SELECT 1 FROM billing_receipts WHERE invoice_id=$1", [invoiceId])).toEqual([]);
  });
  it("requires a fresh authentic raw-body signature", async () => {
    await expect(service.webhook(Buffer.from("{}"), "t=1,v1=00")).rejects.toMatchObject({ status: 400 });
  });
  it("applies verified exact payment once, persists receipt and ignores duplicate delivery", async () => {
    invoice = {
      id: "in_fixture",
      customer: "cus_fixture",
      parent: { subscription_details: { subscription: "sub_fixture" } },
      lines: {
        has_more: false,
        data: [
          {
            quantity: 1,
            pricing: { price_details: { price: "price_fixture" } },
            period: { start: 1791676800, end: 1794355200 },
          },
        ],
      },
      amount_due: amount,
      amount_paid: amount,
      total: amount,
      currency: currency.toLowerCase(),
      status: "paid",
      billing_reason: "subscription_create",
      payments: {
        has_more: false,
        data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_fixture" } }],
      },
    };
    expect((await send("invoice.paid", "evt_paid")).result).toMatch(/^Applied/);
    expect((await send("invoice.paid", "evt_paid")).result).toMatch(/^Duplicate/);
    expect((await S.sql("SELECT count(*)::int AS n FROM billing_receipts WHERE invoice_id=$1", [invoiceId]))[0].n).toBe(
      1,
    );
  });
  it("rejects a foreign application without recording its event or receipt", async () => {
    providerApplication = "unrelated-fixture";
    try {
      await expect(send("invoice.paid", "evt_foreign_application")).rejects.toMatchObject({ status: 400 });
      expect(await S.sql("SELECT 1 FROM stripe_events WHERE id='evt_foreign_application'")).toEqual([]);
    } finally {
      providerApplication = "paltas";
    }
  });
  it("does not change a Stripe-managed plan only in the local catalogue", async () => {
    await expect(
      a.api.subscriptions.changePlan({ params: { orgId: a.orgId }, body: { plan: "PM-GROWTH", confirm: "CONFIRM" } }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not pretend a local cancellation stops Stripe collection", async () => {
    await expect(
      a.api.subscriptions.cancel({
        params: { orgId: a.orgId },
        body: { product: "property", reason: "Customer requested cancellation" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await S.sql("SELECT 1 FROM subscription_pending WHERE org_id=$1 AND type='cancel'", [a.orgId])).toEqual([]);
  });
  it("requires authentication, product membership and verified email for billing management", async () => {
    const path = `/api/v1/orgs/${a.orgId}/subscription/stripe-portal`;
    expect((await S.raw("POST", path, { product: "property", action: "manage" })).status).toBe(401);
    const other = await signUpAndIn(S, "property");
    expect((await S.raw("POST", path, { product: "property", action: "manage" }, other.token)).status).toBe(404);
    expect(
      (
        await S.raw(
          "POST",
          `/api/v1/orgs/${other.orgId}/subscription/stripe-portal`,
          { product: "property", action: "manage" },
          other.token,
        )
      ).status,
    ).toBe(403);
    expect((await S.raw("POST", path, { product: "hotel", action: "manage" }, a.token)).status).toBe(404);
  });
  it("opens only the owning workspace's billing customer with fixed return URLs", async () => {
    expect(await service.portal(a.orgId, "property")).toEqual({ url: portalRedirect, testMode: true });
    expect(lastPortalBody.customer).toBe("cus_fixture");
    expect(lastPortalBody.configuration).toBe("bpc_fixture");
    expect(lastPortalBody.return_url).toContain(S.app.ctx.config.signup.appBaseUrl + "/account.html?org=" + a.orgId);
    const before = portalCreates;
    await expect(service.portal("other-org", "property")).rejects.toMatchObject({ status: 404 });
    expect(portalCreates).toBe(before);
  });
  it("refuses unsafe portal configuration and redirects", async () => {
    portalUpdatesEnabled = true;
    const before = portalCreates;
    await expect(service.portal(a.orgId, "property")).rejects.toMatchObject({ status: 409 });
    expect(portalCreates).toBe(before);
    portalUpdatesEnabled = false;
    portalRedirect = "https://unrelated.test/collect";
    await expect(service.portal(a.orgId, "property")).rejects.toMatchObject({ status: 409 });
    portalRedirect = "https://billing.stripe.com/p/session_fixture";
  });
  it("opens Stripe's cancellation confirmation without executing cancellation", async () => {
    await service.portal(a.orgId, "property", "cancel");
    expect(lastPortalBody.flow_data).toMatchObject({
      type: "subscription_cancel",
      subscription_cancel: { subscription: "sub_fixture" },
    });
    expect(await S.sql("SELECT 1 FROM subscription_pending WHERE org_id=$1 AND type='cancel'", [a.orgId])).toEqual([]);
  });
  it("reflects signed period-end cancellation once and cannot withdraw it only locally", async () => {
    scheduledCancellation = true;
    await send("customer.subscription.updated", "evt_schedule_cancel");
    await send("customer.subscription.updated", "evt_schedule_cancel_again");
    const rows = await S.sql("SELECT id FROM subscription_pending WHERE org_id=$1 AND type='cancel'", [a.orgId]);
    expect(rows).toHaveLength(1);
    await expect(
      a.api.subscriptions.withdrawPending({ params: { orgId: a.orgId, pendingId: rows[0].id } }),
    ).rejects.toMatchObject({ status: 409 });
    scheduledCancellation = false;
    await send("customer.subscription.updated", "evt_cancel_reversed");
    expect(await S.sql("SELECT 1 FROM subscription_pending WHERE org_id=$1 AND type='cancel'", [a.orgId])).toEqual([]);
  });
  it("reconciles an explicit cancellation timestamp and retains paid access on its calendar day", async () => {
    explicitCancellation = true;
    const previousDay = S.app.clock.today();
    try {
      await send("customer.subscription.updated", "evt_explicit_cancel");
      expect(
        await S.sql("SELECT 1 FROM subscription_pending WHERE org_id=$1 AND type='cancel'", [a.orgId]),
      ).toHaveLength(1);
      S.setToday(new Date(1794355200 * 1000).toISOString().slice(0, 10));
      const access = await a.api.subscriptions.entitlements({
        params: { orgId: a.orgId },
        query: { product: "property" },
      });
      expect(access).toMatchObject({ status: "active", usable: true });
    } finally {
      S.setToday(previousDay);
      explicitCancellation = false;
      await send("customer.subscription.updated", "evt_explicit_cancel_reversed");
    }
    expect(await S.sql("SELECT 1 FROM subscription_pending WHERE org_id=$1 AND type='cancel'", [a.orgId])).toEqual([]);
  });
  it("handles renewal failure, recovery and repeated invoice events without duplicate receipts", async () => {
    invoice = {
      ...invoice,
      id: "in_renewal",
      billing_reason: "subscription_cycle",
      status: "open",
      amount_paid: 0,
      lines: {
        has_more: false,
        data: [
          {
            quantity: 1,
            pricing: { price_details: { price: "price_fixture" } },
            period: { start: 1794355200, end: 1796947200 },
          },
        ],
      },
    };
    expect((await send("invoice.payment_failed", "evt_renew_fail")).result).toMatch(/^Payment failed/);
    expect(
      (
        await S.sql(
          "SELECT i.status FROM billing_invoices i JOIN stripe_invoice_links l ON l.invoice_id=i.id WHERE l.stripe_invoice_id='in_renewal'",
        )
      )[0].status,
    ).toBe("Payment failed");
    invoice = { ...invoice, status: "paid", amount_paid: amount };
    expect((await send("invoice.paid", "evt_renew_paid")).result).toMatch(/^Applied/);
    expect((await send("invoice.paid", "evt_renew_paid_again")).result).toMatch(/^Applied/);
    expect(
      (
        await S.sql(
          "SELECT count(*)::int AS n FROM billing_receipts r JOIN stripe_invoice_links l ON l.invoice_id=r.invoice_id WHERE l.stripe_invoice_id='in_renewal'",
        )
      )[0].n,
    ).toBe(1);
  });
  it("refuses altered recurring amounts and does not issue a local invoice", async () => {
    invoice = { ...invoice, id: "in_bad", billing_reason: "subscription_cycle", amount_due: amount + 1 };
    await expect(send("invoice.paid", "evt_bad")).rejects.toMatchObject({ status: 409 });
    expect(await S.sql("SELECT 1 FROM stripe_invoice_links WHERE stripe_invoice_id='in_bad'")).toEqual([]);
  });
  it("records cancellation without deleting business records or granting access", async () => {
    subStatus = "canceled";
    expect((await send("customer.subscription.deleted", "evt_cancel")).result).toMatch(/lifecycle/);
    expect(
      (await S.sql("SELECT status FROM subscriptions WHERE org_id=$1 AND product=$2", [a.orgId, "property"]))[0].status,
    ).toBe("expired");
    expect((await S.sql("SELECT count(*)::int AS n FROM billing_receipts WHERE invoice_id=$1", [invoiceId]))[0].n).toBe(
      1,
    );
  });
  it("holds late events from an old subscription without changing its replacement", async () => {
    const renewal = (await S.sql("SELECT invoice_id FROM stripe_invoice_links WHERE stripe_invoice_id='in_renewal'"))[0]
      .invoice_id;
    await S.sql(
      "INSERT INTO stripe_checkouts(id,org_id,product,plan_id,invoice_id,price_id,amount_minor,currency,frequency,status) SELECT 'sc_replacement',org_id,product,plan_id,$2,price_id,amount_minor,currency,frequency,'active' FROM stripe_checkouts WHERE id=$1",
      [checkoutId, renewal],
    );
    await S.sql("UPDATE subscriptions SET status='active' WHERE org_id=$1 AND product='property'", [a.orgId]);
    invoice = {
      ...invoice,
      id: "in_fixture",
      amount_due: amount,
      billing_reason: "subscription_create",
      status: "paid",
      amount_paid: amount,
    };
    await expect(send("invoice.paid", "evt_late_superseded")).rejects.toMatchObject({ status: 409 });
    expect(
      (await S.sql("SELECT status FROM subscriptions WHERE org_id=$1 AND product='property'", [a.orgId]))[0].status,
    ).toBe("active");
  });
});
