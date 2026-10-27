import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { loadConfig } from "../dist/config.js";
import {
  PALTAS_STRIPE_ACCOUNT,
  PALTAS_STRIPE_SANDBOX,
  rentEventContext,
  rentMetadata,
  validateRentStripeConfig,
  verifiedRentStripe,
} from "../dist/core/payments/rent/stripe-isolation.js";

const key = "rk_test_rent_fixture";
const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused",
  APP_BASE_URL: "https://paltas-staging.netlify.app",
};
const stripe = {
  enabled: false,
  accountId: PALTAS_STRIPE_ACCOUNT,
  secretKey: key,
  webhookSecret: "whsec_saas_fixture",
  prices: [],
};
const rent = { enabled: true, webhookSecret: "whsec_rent_fixture", liveApproved: false };

describe("Existing PALTAS Stripe rent isolation", () => {
  it("permits independently enabled onboarding without enabling tenant collection", async () => {
    const onboarding = { enabled: false, onboardingEnabled: true, webhookSecret: "", liveApproved: false };
    expect(validateRentStripeConfig(stripe, onboarding, base.APP_BASE_URL)).toBe("test");
    const fake = { accounts: { retrieve: async () => ({ id: PALTAS_STRIPE_ACCOUNT }) } } as unknown as Stripe;
    expect((await verifiedRentStripe(stripe, onboarding, base.APP_BASE_URL, fake, "onboarding")).mode).toBe("test");
    await expect(verifiedRentStripe(stripe, onboarding, base.APP_BASE_URL, fake)).rejects.toThrow(/not enabled/);
  });
  it("accepts only the independently verified PALTAS sandbox in test mode", async () => {
    const sandbox = { ...stripe, accountId: PALTAS_STRIPE_SANDBOX };
    const fake = { accounts: { retrieve: vi.fn(async () => ({ id: PALTAS_STRIPE_SANDBOX })) } } as unknown as Stripe;
    expect((await verifiedRentStripe(sandbox, rent, base.APP_BASE_URL, fake)).platformAccountId).toBe(
      PALTAS_STRIPE_SANDBOX,
    );
    expect(() =>
      validateRentStripeConfig(
        { ...sandbox, secretKey: "rk_live_fixture" },
        { ...rent, liveApproved: true },
        "https://paltas.io",
      ),
    ).toThrow(/sandbox cannot use live/);
    await expect(verifiedRentStripe(stripe, rent, base.APP_BASE_URL, fake)).rejects.toThrow(/verification failed/);
    expect(
      rentMetadata({
        orgId: "org_test",
        obligationId: "ob_test",
        invoiceId: "inv_test",
        merchantAccountId: "acct_merchant",
        mode: "test",
        platformAccountId: PALTAS_STRIPE_SANDBOX,
      }).paltasAccountId,
    ).toBe(PALTAS_STRIPE_SANDBOX);
  });
  it("keeps both switches off without changing stored subscription configuration", () => {
    const c = loadConfig({ ...base, STRIPE_SECRET_KEY: key, STRIPE_ACCOUNT_ID: PALTAS_STRIPE_ACCOUNT });
    expect(c.stripe?.enabled).toBe(false);
    expect(c.stripeRent?.enabled).toBe(false);
    expect(validateRentStripeConfig(undefined, { ...rent, enabled: false }, base.APP_BASE_URL)).toBe("disabled");
  });
  it("can validate rent test configuration without subscription prices or enabling SaaS collection", () => {
    const c = loadConfig({
      ...base,
      STRIPE_ACCOUNT_ID: PALTAS_STRIPE_ACCOUNT,
      STRIPE_SECRET_KEY: key,
      STRIPE_RENT_ENABLED: "true",
      STRIPE_RENT_WEBHOOK_SECRET: rent.webhookSecret,
    });
    expect(c.stripe?.enabled).toBe(false);
    expect(c.stripe?.prices).toEqual([]);
    expect(c.stripeRent?.enabled).toBe(true);
  });
  it("refuses another platform account before creating a client", async () => {
    const retrieve = vi.fn();
    const fake = { accounts: { retrieve } } as unknown as Stripe;
    await expect(
      verifiedRentStripe({ ...stripe, accountId: "acct_unapproved" }, rent, base.APP_BASE_URL, fake),
    ).rejects.toThrow(/existing PALTAS/);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("refuses disabled, missing credentials and shared subscription webhook secrets", async () => {
    await expect(verifiedRentStripe(stripe, { ...rent, enabled: false }, base.APP_BASE_URL)).rejects.toThrow(
      /not enabled/,
    );
    for (const secretKey of ["", "pk_test_not_server"]) {
      expect(() => validateRentStripeConfig({ ...stripe, secretKey }, rent, base.APP_BASE_URL)).toThrow(
        /server Stripe key/,
      );
    }
    expect(() =>
      validateRentStripeConfig(stripe, { ...rent, webhookSecret: stripe.webhookSecret }, base.APP_BASE_URL),
    ).toThrow(/separate Connect webhook/);
  });
  it("refuses accidental live activation and test payments on production", () => {
    const live = { ...stripe, secretKey: "rk_live_fixture" };
    expect(() => validateRentStripeConfig(live, rent, "https://paltas.io")).toThrow(/approved production/);
    expect(() => validateRentStripeConfig(live, { ...rent, liveApproved: true }, base.APP_BASE_URL)).toThrow(
      /approved production/,
    );
    expect(() => validateRentStripeConfig(stripe, rent, "https://paltas.io")).toThrow(/Test rent collection/);
    expect(validateRentStripeConfig(live, { ...rent, liveApproved: true }, "https://paltas.io")).toBe("live");
  });
  it("verifies the authenticated key account before returning a client", async () => {
    const retrieve = vi.fn(async () => ({ id: "acct_unapproved" }));
    const fake = { accounts: { retrieve } } as unknown as Stripe;
    await expect(verifiedRentStripe(stripe, rent, base.APP_BASE_URL, fake)).rejects.toThrow(/verification failed/);
    expect(retrieve).toHaveBeenCalledWith(null);
    retrieve.mockResolvedValue({ id: PALTAS_STRIPE_ACCOUNT });
    const r = await verifiedRentStripe(stripe, rent, base.APP_BASE_URL, fake);
    expect(r.stripe).toBe(fake);
    expect(r.mode).toBe("test");
  });
  it("namespaces rental objects without exposing server secrets", () => {
    const m = rentMetadata({
      orgId: "org_fixture",
      obligationId: "obligation_fixture",
      invoiceId: "invoice_fixture",
      merchantAccountId: "acct_merchant",
      mode: "test",
    });
    expect(m.paltasApplication).toBe("paltas-rent");
    expect(m.paltasAccountId).toBe(PALTAS_STRIPE_ACCOUNT);
    expect(m.paltasMode).toBe("test");
    expect(JSON.stringify(m)).not.toContain(key);
  });
  it("rejects unscoped, foreign and wrong-mode Connect event contexts", () => {
    const e = { account: "acct_merchant", livemode: false } as Stripe.Event;
    expect(rentEventContext(e, { accountId: "acct_merchant", mode: "test" })).toBe(true);
    expect(rentEventContext(e, { accountId: "acct_other", mode: "test" })).toBe(false);
    expect(rentEventContext(e, { accountId: "acct_merchant", mode: "live" })).toBe(false);
    expect(rentEventContext({ livemode: false } as Stripe.Event, { accountId: "acct_merchant", mode: "test" })).toBe(
      false,
    );
  });
});
