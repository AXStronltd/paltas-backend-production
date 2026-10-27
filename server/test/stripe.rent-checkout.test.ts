import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer, tbBalance } from "./support/property-fixture.js";
import type { TestServer, Person } from "./support/test-server.js";
import { pmAccess, type PortalScope } from "../dist/products/property/shared/access.js";
import { rentCheckoutService } from "../dist/core/payments/rent/checkout.service.js";
import { PALTAS_STRIPE_ACCOUNT, RENT_APPLICATION } from "../dist/core/payments/rent/stripe-isolation.js";
import { rentCollectionEvents } from "../dist/core/payments/rent/events.service.js";
import { paymentsService } from "../dist/products/property/payments/payments.service.js";
import type { OrgScope } from "../dist/core/access/org-access.js";
import { ownersService } from "../dist/products/property/owners/owners.service.js";

describe("Tenant hosted rent checkout — mocked Stripe, real invoice, authority and persistence", () => {
  let S: TestServer, s: PortalScope, other: PortalScope, invoiceId: string, propertyId: string, journals: number;
  let service: ReturnType<typeof rentCheckoutService>, account: Stripe.Account;
  let manager: OrgScope;
  let admin: Person, ownerId: string;
  let providerIdentity = PALTAS_STRIPE_ACCOUNT,
    loseResponse = true,
    createCalls = 0,
    configCalls = 0;
  const sessions = new Map<string, Stripe.Checkout.Session>();
  let intent: Stripe.PaymentIntent,
    intentReads = 0;
  const readAccounts: string[] = [];
  const signer = new Stripe("sk_test_synthetic_only");
  const requests: { body: Stripe.Checkout.SessionCreateParams; options: Stripe.RequestOptions }[] = [];
  const fake = {
    webhooks: signer.webhooks,
    paymentIntents: {
      retrieve: async (_id: string, _params: unknown, options: Stripe.RequestOptions) => {
        intentReads++;
        readAccounts.push(options.stripeAccount!);
        return intent;
      },
    },
    accounts: { retrieve: async (id: string | null) => (id ? account : { id: providerIdentity }) },
    paymentMethodConfigurations: {
      list: async () => {
        configCalls++;
        return {
          data: [
            {
              id: "pmc_test_default",
              active: true,
              is_default: true,
              livemode: false,
              card: { available: true },
              us_bank_account: { available: true },
              bacs_debit: { available: true },
              sepa_debit: { available: true },
              acss_debit: { available: true },
            },
          ],
          has_more: false,
        };
      },
    },
    checkout: {
      sessions: {
        retrieve: async (id: string, _params: unknown, options: Stripe.RequestOptions) => {
          readAccounts.push(options.stripeAccount!);
          return [...sessions.values()].find((s) => s.id === id)!;
        },
        create: async (body: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions) => {
          createCalls++;
          requests.push({ body, options });
          const key = options.idempotencyKey!;
          if (!sessions.has(key))
            sessions.set(key, {
              id: "cs_test_" + sessions.size,
              mode: "payment",
              livemode: false,
              amount_total: 40000,
              currency: "usd",
              url: "https://checkout.stripe.com/c/pay/synthetic-only",
              metadata: body.metadata,
              payment_status: "unpaid",
              client_reference_id: body.client_reference_id,
              payment_intent: "pi_rentfixture",
            } as unknown as Stripe.Checkout.Session);
          intent = {
            id: "pi_rentfixture",
            amount: 40000,
            amount_received: 0,
            currency: "usd",
            livemode: false,
            status: "processing",
            metadata: body.payment_intent_data?.metadata ?? {},
          } as Stripe.PaymentIntent;
          if (loseResponse) {
            loseResponse = false;
            throw new Error("Synthetic lost response; provider retained the request");
          }
          return sessions.get(key)!;
        },
      },
    },
  } as unknown as Stripe;
  beforeAll(async () => {
    S = await startPropertyServer({
      stripe: {
        enabled: false,
        accountId: PALTAS_STRIPE_ACCOUNT,
        secretKey: "rk_test_fixture",
        webhookSecret: "whsec_saas",
        prices: [],
      },
      stripeRent: { enabled: true, onboardingEnabled: false, webhookSecret: "whsec_rent", liveApproved: false },
    });
    S.setToday("2026-10-26");
    const o = await pmOrg(S);
    admin = o.admin;
    await S.sql("UPDATE organisations SET currency='USD' WHERE id=$1", [o.orgId]);
    const b = await setUpBuilding(o.orgId, o.admin);
    propertyId = b.propertyId;
    ownerId = b.ownerId;
    const t = await S.addMember(o.orgId, o.admin.api, "tenant"),
      t2 = await S.addMember(o.orgId, o.admin.api, "tenant");
    const tid = await newTenant(o.admin, o.orgId, "Synthetic hosted payer"),
      tid2 = await newTenant(o.admin, o.orgId, "Other hosted payer");
    for (const [contactId, userId] of [
      [tid, t.userId],
      [tid2, t2.userId],
    ])
      await o.admin.api.contacts.updateContact({
        params: { orgId: o.orgId, contactId: contactId! },
        body: { userId: userId! },
      });
    const l = await o.admin.api.property.createLease({
      params: { orgId: o.orgId },
      body: { unitId: b.units["A-101"]!, tenantId: tid, startDate: "2026-10-01", rentMinor: 100000 },
    });
    const active = await o.admin.api.property.activateLease({
      params: { orgId: o.orgId, leaseId: l.id },
      body: { signedOn: "2026-10-01", billFirstRent: true },
    });
    invoiceId = active.firstRentInvoice!.id;
    const access = pmAccess(S.app.core);
    manager = await access.org(
      (await S.app.core.identity.authenticate(o.admin.token))!,
      o.orgId,
      "property.payments.record",
      { write: true, module: "finance" },
    );
    s = await access.portal((await S.app.core.identity.authenticate(t.token))!, o.orgId, "property.portal.tenant", {
      write: true,
    });
    other = await access.portal(
      (await S.app.core.identity.authenticate(t2.token))!,
      o.orgId,
      "property.portal.tenant",
      { write: true },
    );
    await S.sql(
      "INSERT INTO rent_stripe_merchants(org_id,id,account_id,platform_account_id,country,model,mode,status,charges_enabled,payouts_enabled,created_by) VALUES($1,'rma_checkout','acct_checkout',$2,'US','property_manager','test','verified',true,true,$3)",
      [s.orgId, PALTAS_STRIPE_ACCOUNT, o.admin.userId],
    );
    account = {
      id: "acct_checkout",
      country: "US",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
      capabilities: {
        card_payments: "active",
        us_bank_account_ach_payments: "active",
        bacs_debit_payments: "active",
        sepa_debit_payments: "active",
        acss_debit_payments: "active",
      },
      metadata: {
        paltasApplication: RENT_APPLICATION,
        paltasAccountId: PALTAS_STRIPE_ACCOUNT,
        paltasOrgId: s.orgId,
        paltasMerchantId: "rma_checkout",
        paltasMode: "test",
      },
    } as unknown as Stripe.Account;
    service = rentCheckoutService({ ...S.app.ctx, rentStripeClient: fake });
    journals = (await S.sql("SELECT count(*)::int n FROM journal_entries"))[0].n;
  });
  afterAll(() => S.close());
  const input = {
    invoiceId: "",
    amountMinor: 40000,
    method: "us_bank_account" as const,
    requestKey: "hosted-request-1",
  };
  it("refuses another tenant before any provider request", async () => {
    await expect(service.methods(other, invoiceId, 40000)).rejects.toThrow(/Invoice not found/);
    expect(configCalls).toBe(0);
  });
  it("requires explicit property-to-company authority rather than inferring it from registration", async () => {
    await expect(service.methods(s, invoiceId, 40000)).rejects.toThrow(/authorise this property/);
    expect(configCalls).toBe(0);
    await S.sql(
      "INSERT INTO rent_collection_property_routes(org_id,property_id,merchant_id,status,authority_reference,approved_by) VALUES($1,$2,'rma_checkout','active','Synthetic reviewed collection authority',$3)",
      [s.orgId, propertyId, s.userId],
    );
  });
  it("uses actual capability, amount, currency and connected-account configuration", async () => {
    expect(await service.methods(s, invoiceId, 40000)).toEqual({
      methods: ["card", "us_bank_account", "acss_debit"],
      currency: "USD",
      amountMinor: 40000,
      testMode: true,
    });
    await expect(service.start(s, { ...input, invoiceId, method: "bacs_debit" })).rejects.toThrow(/not enabled/);
    expect(createCalls).toBe(0);
  });
  it("refuses a foreign platform key before connected resource calls", async () => {
    providerIdentity = "acct_other_product";
    const before = configCalls;
    await expect(service.methods(s, invoiceId, 40000)).rejects.toThrow(/verification failed/);
    expect(configCalls).toBe(before);
    providerIdentity = PALTAS_STRIPE_ACCOUNT;
  });
  it("retains a lost provider response and retries the identical direct-charge request once", async () => {
    await expect(service.start(s, { ...input, invoiceId })).rejects.toThrow(/prevent duplicate/);
    const r = await service.start(s, { ...input, invoiceId });
    expect(r).toMatchObject({ status: "submitted", testMode: true });
    expect(sessions.size).toBe(1);
    expect(requests[0]!.options).toEqual(requests[1]!.options);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    expect(requests[0]!.options.stripeAccount).toBe("acct_checkout");
    expect(requests[0]!.body.mode).toBe("payment");
    expect(requests[0]!.body.allowed_payment_method_types).toEqual(["us_bank_account"]);
    expect(requests[0]!.body.payment_method_configuration).toBe("pmc_test_default");
    expect(requests[0]!.body.payment_intent_data?.metadata?.paltasApplication).toBe("paltas-rent");
    expect(new URL(requests[0]!.body.success_url!).hash).toBe("#mytenant");
    expect(requests[0]!.body).not.toHaveProperty("subscription_data");
  });
  it("blocks a second browser request while the bank payment is unresolved", async () => {
    const before = createCalls;
    await expect(service.start(s, { ...input, invoiceId, requestKey: "hosted-request-2" })).rejects.toThrow(
      /already pending/,
    );
    expect(createCalls).toBe(before);
  });
  it("honours revoked property routing before any new checkout call", async () => {
    await S.sql("UPDATE rent_collection_property_routes SET status='paused' WHERE property_id=$1", [propertyId]);
    const before = createCalls;
    await expect(service.start(s, { ...input, invoiceId })).rejects.toThrow(/authorise this property/);
    expect(createCalls).toBe(before);
  });
  const eventBody = (id: string, type = "payment_intent.processing", overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id,
      object: "event",
      account: "acct_checkout",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      type,
      data: { object: { ...intent } },
      ...overrides,
    });
  const signature = (raw: string, secret = "whsec_rent", timestamp = Math.floor(Date.now() / 1000)) =>
    signer.webhooks.generateTestHeaderString({ payload: raw, secret, timestamp });
  const events = () => rentCollectionEvents({ ...S.app.ctx, rentStripeClient: fake });
  it("rejects missing, expired and subscription-webhook signatures before provider reads", async () => {
    const raw = eventBody("evt_invalid");
    for (const sig of [
      undefined,
      signature(raw, "whsec_saas"),
      signature(raw, "whsec_rent", Math.floor(Date.now() / 1000) - 600),
    ])
      await expect(events().receive(Buffer.from(raw), sig)).rejects.toThrow(/signature/);
    expect(intentReads).toBe(0);
  });
  it("refuses foreign account, mode and metadata context; ignores unrelated subscription objects", async () => {
    for (const x of [
      { account: "acct_elsewhere" },
      { livemode: true },
      { data: { object: { ...intent, metadata: { ...intent.metadata, paltasOrgId: "org_elsewhere" } } } },
    ]) {
      const raw = eventBody("evt_bad_scope", "payment_intent.processing", x);
      await expect(events().receive(Buffer.from(raw), signature(raw))).rejects.toThrow();
    }
    const raw = eventBody("evt_saas", "payment_intent.succeeded", {
      data: { object: { ...intent, metadata: { paltasApplication: "paltas" } } },
    });
    expect((await events().receive(Buffer.from(raw), signature(raw))).result).toContain("unrelated");
    expect(intentReads).toBe(0);
  });
  it("independently retrieves the actual intent and retained checkout in the mapped connected account", async () => {
    const raw = eventBody("evt_processing");
    expect((await events().receive(Buffer.from(raw), signature(raw))).result).toContain("processing");
    expect((await S.sql("SELECT status FROM rent_collection_attempts"))[0].status).toBe("processing");
    expect(readAccounts.every((a) => a === "acct_checkout")).toBe(true);
  });
  it("does not trust a successful webhook when the actual received amount is wrong", async () => {
    intent = { ...intent, status: "succeeded", amount_received: 1 };
    const raw = eventBody("evt_wrong_amount", "payment_intent.succeeded");
    await expect(events().receive(Buffer.from(raw), signature(raw))).rejects.toThrow(/received amount/);
    expect(await S.sql("SELECT * FROM rent_collection_provider_events WHERE id='evt_wrong_amount'")).toHaveLength(0);
  });
  it("retains verified success for clearing review without inventing cash or a final receipt", async () => {
    intent = { ...intent, status: "succeeded", amount_received: 40000 };
    const raw = eventBody("evt_success", "payment_intent.succeeded");
    expect((await events().receive(Buffer.from(raw), signature(raw))).result).toContain(
      "accounting and settlement review",
    );
    const a = (await S.sql("SELECT * FROM rent_collection_attempts"))[0];
    expect(a.status).toBe("review");
    expect(a.verified_success_at).toBeTruthy();
    expect(a.payment_id).toBeNull();
    const before = intentReads;
    expect((await events().receive(Buffer.from(raw), signature(raw))).result).toContain("Duplicate");
    expect(intentReads).toBe(before);
    const changed = JSON.stringify({ ...JSON.parse(raw), created: Math.floor(Date.now() / 1000) + 1 });
    await expect(events().receive(Buffer.from(changed), signature(changed))).rejects.toThrow(/Conflicting/);
  });
  it("handles duplicate and out-of-order events without downgrading verified success", async () => {
    const raw = eventBody("evt_late_processing", "payment_intent.processing");
    const r = await Promise.all([
      events().receive(Buffer.from(raw), signature(raw)),
      events().receive(Buffer.from(raw), signature(raw)),
    ]);
    expect(r.some((v) => v.result.includes("Duplicate"))).toBe(true);
    expect(
      (await S.sql("SELECT count(*)::int n FROM rent_collection_provider_events WHERE id='evt_late_processing'"))[0].n,
    ).toBe(1);
    const a = (await S.sql("SELECT * FROM rent_collection_attempts"))[0];
    expect(a.status).toBe("review");
    expect(a.last_provider_state).toBe("succeeded");
  });
  it("keeps returned-bank-debit events in review and preserves the original confirmation", async () => {
    intent = { ...intent, status: "requires_payment_method", amount_received: 0 };
    const raw = eventBody("evt_returned", "payment_intent.payment_failed");
    expect((await events().receive(Buffer.from(raw), signature(raw))).result).toContain("no silent reversal");
    const a = (await S.sql("SELECT * FROM rent_collection_attempts"))[0];
    expect(a.status).toBe("review");
    expect(a.verified_success_at).toBeTruthy();
    await expect(S.sql("UPDATE rent_collection_attempts SET verified_success_at=NULL")).rejects.toThrow(
      /cannot be erased/,
    );
    await expect(S.sql("DELETE FROM rent_collection_provider_events")).rejects.toThrow(/immutable/);
  });
  it("does not mark an invoice paid or post a receipt merely because checkout exists", async () => {
    expect((await S.sql("SELECT count(*)::int n FROM pm_payments"))[0].n).toBe(0);
    expect((await S.sql("SELECT count(*)::int n FROM journal_entries"))[0].n).toBe(journals);
    expect(
      (await S.sql("SELECT count(*)::int n FROM pm_effective_allocations WHERE invoice_id=$1", [invoiceId]))[0].n,
    ).toBe(0);
  });
  it("continues verifying inbound confirmations when new collections are disabled", async () => {
    intent = { ...intent, status: "succeeded", amount_received: 40000 };
    const raw = eventBody("evt_recovered_success", "payment_intent.succeeded");
    const disabled = rentCollectionEvents({
      ...S.app.ctx,
      rentStripeClient: fake,
      config: { ...S.app.ctx.config, stripeRent: { ...S.app.ctx.config.stripeRent!, enabled: false } },
    });
    const calls = createCalls;
    await disabled.receive(Buffer.from(raw), signature(raw));
    expect(createCalls).toBe(calls);
    expect((await S.sql("SELECT last_provider_state FROM rent_collection_attempts"))[0].last_provider_state).toBe(
      "succeeded",
    );
  });
  it("rolls back receipt posting in a closed accounting period without losing provider evidence", async () => {
    const today = new Date().toISOString().slice(0, 10);
    S.setToday(today);
    manager = { ...manager, today };
    const month = today.slice(0, 7) + "-01";
    await S.sql(
      "INSERT INTO ledger_periods(org_id,month,status,reason) VALUES($1,$2,'closed','Synthetic posting rollback test')",
      [s.orgId, month],
    );
    const payments = paymentsService({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) });
    const a = (await S.sql("SELECT id FROM rent_collection_attempts"))[0];
    await expect(payments.recordProvider(manager, a.id)).rejects.toThrow(/closed/);
    expect((await S.sql("SELECT count(*)::int n FROM pm_payments"))[0].n).toBe(0);
    expect((await S.sql("SELECT verified_success_at,payment_id FROM rent_collection_attempts"))[0]).toMatchObject({
      payment_id: null,
    });
    expect(
      (await S.sql("SELECT verified_success_at FROM rent_collection_attempts"))[0].verified_success_at,
    ).toBeTruthy();
    await S.sql("UPDATE ledger_periods SET status='open' WHERE org_id=$1 AND month=$2", [s.orgId, month]);
  });
  it("posts one verified receipt to provider clearing under concurrent retries, without inventing bank cash", async () => {
    S.setToday(new Date().toISOString().slice(0, 10));
    manager = { ...manager, today: new Date().toISOString().slice(0, 10) };
    const payments = paymentsService({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) });
    const a = (await S.sql("SELECT id FROM rent_collection_attempts"))[0];
    const ids = await Promise.all([payments.recordProvider(manager, a.id), payments.recordProvider(manager, a.id)]);
    expect(ids[0]).toBe(ids[1]);
    expect((await S.sql("SELECT count(*)::int n FROM pm_payments"))[0].n).toBe(1);
    const posted = (await S.sql("SELECT status,payment_id,clearing_state FROM rent_collection_attempts"))[0];
    // The earlier returned-debit observation leaves a review hold even after a fresh verified success.
    // Posting the receipt must not silently certify that dispute or the bank settlement as resolved.
    expect(posted).toMatchObject({ status: "succeeded", payment_id: ids[0], clearing_state: "disputed" });
    expect(
      (await S.sql("SELECT sum(amount_minor)::int n FROM pm_effective_allocations WHERE invoice_id=$1", [invoiceId]))[0]
        .n,
    ).toBe(40000);
    await expect(payments.requestReversal(manager, ids[0]!, "Synthetic correction request")).rejects.toThrow(
      /provider refund/,
    );
    await expect(payments.applyCredit(manager, s.contact.id)).rejects.toThrow(/not bank-reconciled/);
    expect(await tbBalance(admin, s.orgId, "1040")).toBe(0);
    expect(await tbBalance(admin, s.orgId, "1045")).toBe(40000);
    expect(await tbBalance(admin, s.orgId, "1120")).toBe(60000);
    expect(await tbBalance(admin, s.orgId, "2250")).toBe(-36000);
    expect(await tbBalance(admin, s.orgId, "4650")).toBe(-4000);
    await S.sql("UPDATE pm_owner_profiles SET bank_verified_at=now() WHERE owner_id=$1", [ownerId]);
    const owners = ownersService({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) });
    await expect(owners.prepare(manager, ownerId)).rejects.toThrow(/not bank-reconciled/);
    expect((await S.sql("SELECT count(*)::int n FROM pm_payouts"))[0].n).toBe(0);
  });
  it("retains a returned partial payment even when a later collection is already pending", async () => {
    await S.sql(`INSERT INTO rent_collection_attempts(id,org_id,invoice_id,tenant_id,property_id,merchant_id,
      platform_account_id,connected_account_id,mode,method,currency,amount_minor,request_key,status,created_by)
      SELECT 'rta_later',org_id,invoice_id,tenant_id,property_id,merchant_id,platform_account_id,connected_account_id,
      mode,method,currency,10000,'later-synthetic-request','reserved',created_by FROM rent_collection_attempts LIMIT 1`);
    intent = { ...intent, status: "requires_payment_method", amount_received: 0 };
    const raw = eventBody("evt_return_after_posting", "payment_intent.payment_failed");
    await events().receive(Buffer.from(raw), signature(raw));
    const a = (
      await S.sql(
        "SELECT status,payment_id,clearing_state FROM rent_collection_attempts WHERE provider_intent_id='pi_rentfixture'",
      )
    )[0];
    expect(a.status).toBe("review");
    expect(a.payment_id).toBeTruthy();
    expect(a.clearing_state).toBe("disputed");
    expect((await S.sql("SELECT status FROM rent_collection_attempts WHERE id='rta_later'"))[0].status).toBe(
      "reserved",
    );
    expect(await tbBalance(admin, s.orgId, "1045")).toBe(40000);
    expect((await S.sql("SELECT count(*)::int n FROM pm_payments"))[0].n).toBe(1);
  });
});
