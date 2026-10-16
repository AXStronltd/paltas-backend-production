import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_PRODUCTS, postSignup, signupBody, signupServer } from "./support/signup-fixture.js";
import { refused } from "./support/test-server.js";
import type { TestServer } from "./support/test-server.js";

describe("business-first company registration", () => {
  let S: TestServer;
  const profile = {
    version: "2026-10",
    companyType: "limited_company",
    addressLine1: "128 City Road",
    city: "London",
    authorityAccepted: true,
    requestedTier: "Standard",
    administratorTitle: "Director",
    registrationNumber: "TEST-ONLY",
  };
  beforeAll(async () => {
    S = await signupServer({ requireProfile: true });
  });
  afterAll(() => S.close());

  it("requires a complete authorised profile when enabled", async () => {
    const b = signupBody("property");
    expect((await postSignup(S, b)).status).toBe(400);
    expect((await postSignup(S, { ...b, companyProfile: { ...profile, authorityAccepted: false } })).status).toBe(400);
    expect((await postSignup(S, { ...b, companyProfile: { ...profile, addressLine1: "" } })).status).toBe(400);
    expect(
      (await postSignup(S, { ...b, companyProfile: { ...profile, website: "https://user:secret@example.com" } }))
        .status,
    ).toBe(400);
  });

  it("saves company and administrator details for every configured business", async () => {
    for (const product of ALL_PRODUCTS) {
      const b = signupBody(product);
      expect((await postSignup(S, { ...b, companyProfile: profile })).status).toBe(201);
      const first = await S.login(b.email, b.password);
      const me = await first.api.identity.me();
      expect(me.organisations[0]?.products).toContain(product);
      const orgId = me.organisations[0]!.id;
      const saved = await S.sql<{ registration_profile: typeof profile }>(
        "SELECT registration_profile FROM organisations WHERE id=$1",
        [orgId],
      );
      expect(saved[0]?.registration_profile).toEqual(profile);
      expect((await first.api.organisations.get({ params: { orgId } })).registrationProfile).toEqual(profile);
      const again = await S.login(b.email, b.password);
      expect((await again.api.identity.me()).organisations[0]?.id).toBe(orgId);
    }
  });

  it("does not disclose another company's registration details", async () => {
    const one = signupBody("property"),
      two = signupBody("property");
    await postSignup(S, { ...one, companyProfile: profile });
    await postSignup(S, { ...two, companyProfile: profile });
    const a = await S.login(one.email, one.password),
      b = await S.login(two.email, two.password);
    const orgId = (await a.api.identity.me()).organisations[0]!.id;
    await refused(b.api.organisations.get({ params: { orgId } }), 404);
  });

  it("records an Enterprise quote request without activating Enterprise", async () => {
    const b = signupBody("property");
    expect(
      (
        await postSignup(S, {
          ...b,
          companyProfile: { ...profile, requestedTier: "Enterprise", enterpriseRequirements: "Multiple portfolios" },
        })
      ).status,
    ).toBe(201);
    const account = await S.login(b.email, b.password);
    const orgId = (await account.api.identity.me()).organisations[0]!.id;
    const enquiries = await S.sql<{ note: string }>("SELECT note FROM enterprise_enquiries WHERE org_id=$1", [orgId]);
    expect(enquiries).toHaveLength(1);
    expect(enquiries[0]?.note).toContain("PM-STARTER trial");
    expect(enquiries[0]?.note).toContain("Multiple portfolios");
  });

  it("rejects claiming a Pro tier with a Standard plan", async () => {
    expect(
      (await postSignup(S, { ...signupBody("property"), companyProfile: { ...profile, requestedTier: "Pro" } })).status,
    ).toBe(400);
  });
});
