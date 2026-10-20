import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startServer, refused, type TestServer } from "./support/test-server.js";
import { createUser } from "../dist/core/identity/identity.service.js";
import { newTotpSecret, totp } from "../dist/core/identity/totp.js";

describe("PALTAS staff campaign management", () => {
  let S: TestServer,
    author: Awaited<ReturnType<TestServer["staff"]>>,
    reviewer: Awaited<ReturnType<TestServer["staff"]>>;
  const body = {
    title: "PALTAS business launch",
    goal: "Explore our business workspaces",
    landingUrl: "https://paltas.io/business",
    posts: [
      { channel: "linkedin" as const, caption: "Explore PALTAS. Start a 30-day trial at https://paltas.io/business" },
    ],
  };
  beforeAll(async () => {
    S = await startServer();
    author = await S.staff();
    const secret = newTotpSecret(),
      password = "Review-Secure-2026!",
      email = "reviewer@paltas.test";
    const u = await createUser(S.app.ctx.db, {
      email,
      name: "Reviewer",
      password,
      staffRole: "super_admin",
      mfaSecretSealed: S.app.ctx.secrets.seal(secret),
    });
    reviewer = { ...(await S.login(email, password, totp(secret))), userId: u.id };
  });
  afterAll(() => S.close());
  it("persists drafts; clients cannot read or change marketing; providers remain disconnected", async () => {
    const org = await S.newOrg();
    await refused(org.admin.api.admin.marketingOverview(), 404);
    await refused(org.admin.api.admin.createCampaign({ body }), 404);
    const c = await author.api.admin.createCampaign({ body });
    const r = await reviewer.api.admin.marketingOverview();
    expect(r.publishingEnabled).toBe(false);
    expect(r.channels.every((x) => !x.connected)).toBe(true);
    expect(r.campaigns.find((x) => x.id === c.id)).toMatchObject({ ...body, status: "draft", version: 1 });
  });
  it("validates PALTAS links, unique channels and X character limits", async () => {
    await refused(author.api.admin.createCampaign({ body: { ...body, landingUrl: "https://appra.example/" } }), 400);
    await refused(author.api.admin.createCampaign({ body: { ...body, posts: [body.posts[0]!, body.posts[0]!] } }), 400);
    await refused(
      author.api.admin.createCampaign({ body: { ...body, posts: [{ channel: "x", caption: "a".repeat(281) }] } }),
      400,
    );
  });
  it("requires review, prevents self approval and rejects stale versions", async () => {
    let c = await author.api.admin.createCampaign({ body });
    await refused(
      author.api.admin.campaignAction({
        params: { campaignId: c.id },
        body: { version: c.version, action: "schedule", scheduledAt: new Date(Date.now() + 86400000).toISOString() },
      }),
      409,
    );
    c = await author.api.admin.campaignAction({
      params: { campaignId: c.id },
      body: { version: c.version, action: "submit" },
    });
    await refused(
      author.api.admin.campaignAction({
        params: { campaignId: c.id },
        body: { version: c.version, action: "approve" },
      }),
      409,
    );
    await refused(
      reviewer.api.admin.campaignAction({ params: { campaignId: c.id }, body: { version: 1, action: "approve" } }),
      409,
    );
    c = await reviewer.api.admin.campaignAction({
      params: { campaignId: c.id },
      body: { version: c.version, action: "approve" },
    });
    expect(c.approvedBy).toBe(reviewer.userId);
    await refused(
      author.api.admin.campaignAction({
        params: { campaignId: c.id },
        body: { version: c.version, action: "schedule", scheduledAt: "2020-01-01T00:00:00.000Z" },
      }),
      409,
    );
    c = await author.api.admin.campaignAction({
      params: { campaignId: c.id },
      body: { version: c.version, action: "schedule", scheduledAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(c.status).toBe("scheduled");
    c = await author.api.admin.updateCampaign({
      params: { campaignId: c.id },
      body: { ...body, title: "Revised launch", version: c.version },
    });
    expect(c).toMatchObject({ status: "draft", approvedBy: null, scheduledAt: null });
    const audit = await author.api.admin.audit();
    expect(audit.entries.filter((e) => e.target === c.id).map((e) => e.action)).toContain(
      "marketing.campaign.schedule",
    );
  });
  it("cancels without deleting history and support cannot write", async () => {
    let c = await author.api.admin.createCampaign({ body });
    c = await author.api.admin.campaignAction({
      params: { campaignId: c.id },
      body: { version: c.version, action: "cancel" },
    });
    await refused(
      author.api.admin.updateCampaign({ params: { campaignId: c.id }, body: { ...body, version: c.version } }),
      409,
    );
    await S.sql("UPDATE users SET staff_role='support' WHERE id=$1", [reviewer.userId]);
    await refused(reviewer.api.admin.createCampaign({ body }), 403);
    expect((await reviewer.api.admin.marketingOverview()).campaigns.some((x) => x.id === c.id)).toBe(true);
  });
});
