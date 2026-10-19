import { describe, expect, it } from "vitest";
import { loadConfig } from "../dist/config.js";
const env = { NODE_ENV: "test", DATABASE_URL: "postgres://unused", APP_BASE_URL: "https://paltas-staging.netlify.app" };
describe("Stripe environment safeguards", () => {
  it("defaults to disabled and accepts an unactivated stored key", () => {
    expect(loadConfig(env).stripe?.enabled).toBe(false);
    expect(loadConfig({ ...env, STRIPE_SECRET_KEY: "sk_test_fixture" }).stripe?.enabled).toBe(false);
  });
  it("refuses publishable keys and incomplete activation", () => {
    for (const key of ["pk_live_fixture", "sk_test_fixture", ""]) {
      expect(() => loadConfig({ ...env, STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: key })).toThrow();
    }
  });
  it("refuses enabled live billing on staging even with complete settings", () => {
    const complete = {
      ...env,
      STRIPE_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_live_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PRICE_MAP: JSON.stringify([{ planId: "PM-STARTER", currency: "KES", priceId: "price_fixture" }]),
    };
    expect(() => loadConfig(complete)).toThrow(/live keys are refused/);
    expect(loadConfig({ ...complete, APP_BASE_URL: "https://paltas.io" }).stripe?.enabled).toBe(true);
    expect(loadConfig({ ...complete, STRIPE_SECRET_KEY: "sk_test_fixture" }).stripe?.enabled).toBe(true);
  });
  it("accepts restricted server keys but preserves live environment isolation", () => {
    for (const prefix of ["sk", "rk"]) {
      const complete = {
        ...env,
        STRIPE_ENABLED: "true",
        STRIPE_SECRET_KEY: prefix + "_test_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_fixture",
        STRIPE_PRICE_MAP: JSON.stringify([{ planId: "PM-STARTER", currency: "KES", priceId: "price_fixture" }]),
      };
      expect(loadConfig(complete).stripe?.enabled).toBe(true);
      expect(() => loadConfig({ ...complete, STRIPE_SECRET_KEY: prefix + "_live_fixture" })).toThrow(
        /live keys are refused/,
      );
      expect(
        loadConfig({ ...complete, STRIPE_SECRET_KEY: prefix + "_live_fixture", APP_BASE_URL: "https://paltas.io" })
          .stripe?.enabled,
      ).toBe(true);
    }
  });
});
