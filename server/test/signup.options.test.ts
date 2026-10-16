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
      expect(Object.keys(p).sort()).toEqual(["contactSales", "id", "modules", "name", "price", "product", "tier"]);
      if (p.contactSales) {
        // a plan PALTAS prices on request is listed only when it is open for a trial, with no invented price
        expect(p.price).toBeNull();
        expect(p.id).toBe("PM-ENTERPRISE");
      } else {
        expect(p.price.amount).toBeGreaterThanOrEqual(0);
        expect(p.price.currency).toMatch(/^[A-Z]{3}$/);
        expect(p.name).not.toMatch(/Enterprise/);
      }
      for (const m of p.modules) expect(m.name).not.toBe(m.key);
    }
    const ent = r.body.plans.find((p: { id: string }) => p.id === "PM-ENTERPRISE");
    expect(ent.modules.map((m: { key: string }) => m.key).sort()).toEqual(
      ["automation", "crm", "docs", "finance", "intelligence", "maint", "migration", "payments", "procurement"].sort(),
    );
  });

  it("compares the Property Management plans by area, from the catalogue", async () => {
    const r = await S.raw("GET", "/api/v1/public/plan-comparison?product=property");
    expect(r.status).toBe(200);
    expect(r.body.plans.map((p: { id: string }) => p.id)).toEqual(["PM-STARTER", "PM-GROWTH", "PM-ENTERPRISE"]);
    const ent = r.body.plans[2];
    expect(ent.price).toBeNull();
    expect(ent.contactSales).toBe(true);
    expect(ent.trial).toBe(true);
    expect(r.body.areas.map((a: { area: string }) => a.area)).toEqual([
      "Properties & tenants",
      "CRM",
      "Payments",
      "Accounting",
      "Maintenance",
      "Reports",
      "Data migration",
      "Portals",
    ]);
    const feature = (id: string) =>
      r.body.areas
        .flatMap((a: { features: { id: string; plans: string[] }[] }) => a.features)
        .find((f: { id: string }) => f.id === id);
    expect(feature("pm-tenants").plans).toEqual(["PM-STARTER", "PM-GROWTH", "PM-ENTERPRISE"]);
    expect(feature("pm-crm-pipeline").plans).toEqual(["PM-GROWTH", "PM-ENTERPRISE"]);
    expect(feature("pm-migration").plans).toEqual(["PM-ENTERPRISE"]);
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
