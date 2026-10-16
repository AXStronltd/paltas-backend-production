import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../dist/config.js";
import { postSignup, signupBody, signupServer } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("self-service product release allowlist", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer({ allowedProducts: ["property"] });
  });
  afterAll(() => S.close());

  it("defaults to Property Management and rejects unknown product configuration", () => {
    const env = { NODE_ENV: "test", DATABASE_URL: "postgres://unused" };
    expect(loadConfig(env).signup.allowedProducts).toEqual(["property"]);
    expect(() => loadConfig({ ...env, SIGNUP_PRODUCTS: "property,unknown" })).toThrow();
    expect(loadConfig({ ...env, SIGNUP_PRODUCTS: "property, property" }).signup.allowedProducts).toEqual(["property"]);
  });

  it("lists only released product plans", async () => {
    const r = await S.raw("GET", "/api/v1/public/signup-options");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.plans.length).toBeGreaterThan(0);
    expect(r.body.plans.every((p: { product: string }) => p.product === "property")).toBe(true);
  });

  it("refuses direct requests for unreleased products without creating accounts", async () => {
    for (const product of ["security", "hotel", "developer", "agency"] as const) {
      const body = signupBody(product);
      expect((await postSignup(S, body)).status).toBe(403);
      expect(await S.sql("SELECT 1 FROM users WHERE email = lower($1)", [body.email])).toEqual([]);
    }
    expect((await postSignup(S, signupBody("property"))).status).toBe(201);
  });

  it("an empty allowlist closes both metadata and direct registration", async () => {
    const closed = await signupServer({ allowedProducts: [] });
    try {
      const r = await closed.raw("GET", "/api/v1/public/signup-options");
      expect(r.body.enabled).toBe(false);
      expect(r.body.plans).toEqual([]);
      expect((await postSignup(closed, signupBody("property"))).status).toBe(403);
    } finally {
      await closed.close();
    }
  });
});
