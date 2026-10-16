import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signupServer } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("public registration options", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer({ termsUrl: "https://paltas.example/terms" });
  });
  afterAll(() => S.close());

  it("exposes server prices and terms without staff or customer data", async () => {
    const r = await S.raw("GET", "/api/v1/public/signup-options");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.termsUrl).toBe("https://paltas.example/terms");
    expect(r.body.plans.length).toBeGreaterThan(0);
    expect(Object.keys(r.body).sort()).toEqual(["enabled", "plans", "termsUrl", "termsVersion", "trialDays"]);
    for (const p of r.body.plans) {
      expect(Object.keys(p).sort()).toEqual(["id", "modules", "name", "price", "product", "tier"]);
      expect(p.price.amount).toBeGreaterThanOrEqual(0);
      expect(p.price.currency).toMatch(/^[A-Z]{3}$/);
      expect(p.name).not.toMatch(/Enterprise/);
      for (const m of p.modules) expect(m.name).not.toBe(m.key);
    }
  });

  it("keeps the public gate closed when signup is disabled", async () => {
    const closed = await signupServer({ enabled: false });
    try {
      const r = await closed.raw("GET", "/api/v1/public/signup-options");
      expect(r.body.enabled).toBe(false);
    } finally {
      await closed.close();
    }
  });
});
