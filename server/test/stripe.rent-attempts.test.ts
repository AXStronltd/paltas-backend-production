import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";
import { pmAccess, type PortalScope } from "../dist/products/property/shared/access.js";
import { rentAttemptService } from "../dist/core/payments/rent/attempts.service.js";
import { PALTAS_STRIPE_ACCOUNT } from "../dist/core/payments/rent/stripe-isolation.js";

describe("Durable rent collection preparation — real PostgreSQL, no provider execution", () => {
  let S: TestServer, s: PortalScope, other: PortalScope, invoiceId: string, attemptId: string, baselineJournals: number;
  let service: ReturnType<typeof rentAttemptService>;
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
    await S.sql("UPDATE organisations SET currency='USD' WHERE id=$1", [o.orgId]);
    const b = await setUpBuilding(o.orgId, o.admin);
    const t = await S.addMember(o.orgId, o.admin.api, "tenant");
    const t2 = await S.addMember(o.orgId, o.admin.api, "tenant");
    const tid = await newTenant(o.admin, o.orgId, "Synthetic collection payer");
    const tid2 = await newTenant(o.admin, o.orgId, "Synthetic other payer");
    await o.admin.api.contacts.updateContact({
      params: { orgId: o.orgId, contactId: tid },
      body: { userId: t.userId },
    });
    await o.admin.api.contacts.updateContact({
      params: { orgId: o.orgId, contactId: tid2 },
      body: { userId: t2.userId },
    });
    const l = await o.admin.api.property.createLease({
      params: { orgId: o.orgId },
      body: { unitId: b.units["A-101"]!, tenantId: tid, startDate: "2026-10-01", rentMinor: 100000 },
    });
    const a = await o.admin.api.property.activateLease({
      params: { orgId: o.orgId, leaseId: l.id },
      body: { signedOn: "2026-10-01", billFirstRent: true },
    });
    invoiceId = a.firstRentInvoice!.id;
    const access = pmAccess(S.app.core);
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
      "INSERT INTO rent_stripe_merchants(org_id,id,account_id,platform_account_id,country,model,mode,status,charges_enabled,payouts_enabled,created_by) VALUES($1,'rma_fixture','acct_fixture',$2,'US','property_manager','test','verified',true,true,$3)",
      [o.orgId, PALTAS_STRIPE_ACCOUNT, o.admin.userId],
    );
    await S.sql(
      "INSERT INTO rent_collection_property_routes(org_id,property_id,merchant_id,status,authority_reference,approved_by) VALUES($1,$2,'rma_fixture','active','Synthetic reviewed collection authority',$3)",
      [o.orgId, b.propertyId, o.admin.userId],
    );
    baselineJournals = (await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [s.orgId]))[0].n;
    service = rentAttemptService(S.app.ctx);
  });
  afterAll(() => S.close());
  const input = (key = "tenant-request-0001") => ({
    invoiceId,
    amountMinor: 40000,
    method: "us_bank_account" as const,
    requestKey: key,
  });
  it("refuses disabled collection even though company onboarding is live", async () => {
    const ctx = {
      ...S.app.ctx,
      config: {
        ...S.app.ctx.config,
        stripeRent: { ...S.app.ctx.config.stripeRent!, enabled: false, onboardingEnabled: true },
      },
    };
    await expect(rentAttemptService(ctx).reserve(s, input())).rejects.toThrow(/not activated/);
  });
  it("keeps tenant, property, amount and request boundaries", async () => {
    await expect(service.reserve(other, input())).rejects.toThrow(/Invoice not found/);
    await expect(service.reserve({ ...s, propertyIds: ["unassigned"] }, input())).rejects.toThrow(/Invoice not found/);
    for (const amountMinor of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
      await expect(service.reserve(s, { ...input(), amountMinor })).rejects.toThrow(/positive collection/);
    await expect(service.reserve(s, { ...input(), amountMinor: 100001 })).rejects.toThrow(/balance changed/);
    await expect(service.reserve(s, { ...input(), requestKey: "short" })).rejects.toThrow(/identifier/);
  });
  it("serialises double clicks with one retained attempt and one immutable reservation event", async () => {
    const [a, b] = await Promise.all([service.reserve(s, input()), service.reserve(s, input())]);
    expect(a.id).toBe(b.id);
    attemptId = a.id;
    expect(a).toMatchObject({
      status: "reserved",
      amount_minor: 40000,
      currency: "USD",
      provider_session_id: null,
      payment_id: null,
    });
    expect(await S.sql("SELECT * FROM rent_collection_attempts")).toHaveLength(1);
    expect(await S.sql("SELECT * FROM rent_collection_attempt_events")).toHaveLength(1);
  });
  it("blocks a second attempt, mutated idempotency request and another payer replay", async () => {
    await expect(service.reserve(s, input("different-request-2"))).rejects.toThrow(/already pending/);
    await expect(service.reserve(s, { ...input(), amountMinor: 50000 })).rejects.toThrow(/different collection/);
    await expect(service.reserve(other, input())).rejects.toThrow(/different collection/);
  });
  it("retains the same provider key across a lost-response retry; no new receipt exists", async () => {
    const first = await service.beginSubmission(s, attemptId),
      retry = await service.beginSubmission(s, attemptId);
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(first.attempt.status).toBe("submitted");
    expect(retry.submit).toBe(true);
    expect(await S.sql("SELECT * FROM rent_collection_attempt_events")).toHaveLength(2);
  });
  it("stops submission when merchant capability or property access is revoked", async () => {
    await expect(service.beginSubmission({ ...s, propertyIds: ["not-assigned"] }, attemptId)).rejects.toThrow(
      /not found/,
    );
    await S.sql("UPDATE rent_stripe_merchants SET charges_enabled=false WHERE org_id=$1", [s.orgId]);
    await expect(service.beginSubmission(s, attemptId)).rejects.toThrow(/capability changed/);
    await S.sql("UPDATE rent_stripe_merchants SET charges_enabled=true WHERE org_id=$1", [s.orgId]);
  });
  const session = () =>
    ({
      id: "cs_test_fixture",
      mode: "payment",
      livemode: false,
      amount_total: 40000,
      currency: "usd",
      url: "https://checkout.stripe.com/c/pay/synthetic-only",
      metadata: service.metadata({
        id: attemptId,
        org_id: s.orgId,
        invoice_id: invoiceId,
        connected_account_id: "acct_fixture",
        platform_account_id: PALTAS_STRIPE_ACCOUNT,
        mode: "test",
      } as Parameters<typeof service.metadata>[0]),
    }) as unknown as Stripe.Checkout.Session;
  it("rejects wrong amount, currency, environment, account metadata and redirect destination", async () => {
    for (const x of [
      { amount_total: 1 },
      { currency: "eur" },
      { livemode: true },
      { mode: "subscription" },
      { metadata: {} },
      { url: "https://evil.test/checkout" },
    ])
      await expect(
        service.attachHostedSession(s, attemptId, { ...session(), ...x } as Stripe.Checkout.Session),
      ).rejects.toThrow();
    const linked = await service.attachHostedSession(s, attemptId, session());
    expect(linked.status).toBe("submitted");
    await expect(service.attachHostedSession(s, attemptId, { ...session(), id: "cs_replaced" })).rejects.toThrow(
      /retained/,
    );
  });
  it("refuses uncertain retries after provider idempotency retention instead of charging again", async () => {
    const ctx = { ...S.app.ctx, clock: { ...S.app.ctx.clock, now: () => new Date(Date.now() + 25 * 60 * 60 * 1000) } };
    const expired = await rentAttemptService(ctx).beginSubmission(s, attemptId);
    expect(expired).toMatchObject({ submit: false, attempt: { status: "review" } });
    await expect(service.reserve(s, input("late-new-request-3"))).rejects.toThrow(/already pending/);
  });
  it("protects stored financial identity, provider references and append-only history at the database boundary", async () => {
    await expect(S.sql("UPDATE rent_collection_attempts SET amount_minor=1 WHERE id=$1", [attemptId])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      S.sql("UPDATE rent_collection_attempts SET provider_session_id='cs_wrong' WHERE id=$1", [attemptId]),
    ).rejects.toThrow(/cannot be replaced/);
    await expect(S.sql("DELETE FROM rent_collection_attempt_events WHERE attempt_id=$1", [attemptId])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      S.sql("UPDATE rent_collection_attempts SET status='succeeded' WHERE id=$1", [attemptId]),
    ).rejects.toThrow();
  });
  it("never marks rent paid, posts bank cash or generates a receipt from checkout preparation", async () => {
    expect((await S.sql("SELECT count(*)::int n FROM pm_payments WHERE org_id=$1", [s.orgId]))[0].n).toBe(0);
    expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [s.orgId]))[0].n).toBe(
      baselineJournals,
    );
    expect(
      (await S.sql("SELECT count(*)::int n FROM pm_effective_allocations WHERE invoice_id=$1", [invoiceId]))[0].n,
    ).toBe(0);
  });
});
