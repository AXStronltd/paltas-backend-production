import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { property } from "../dist/products/property/index.js";
import { agency } from "../dist/products/agency/index.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("product-scoped memberships and portal discovery", () => {
  let S: TestServer, org: string, admin: Person, member: Person;
  beforeAll(async () => {
    S = await startServer({ products: [property, agency] });
    const o = await S.newOrg({ plan: "PM-GROWTH", trial: false });
    org = o.orgId;
    admin = o.admin;
    await admin.api.subscriptions.addProduct({
      params: { orgId: org },
      body: { product: "agency", plan: "AGENCY-PRO", confirm: "CONFIRM" },
    });
    member = await S.addMember(org, admin.api, "viewer");
  });
  afterAll(() => S.close());
  const change = (body: NonNullable<Parameters<Person["api"]["organisations"]["updateMember"]>[0]>["body"]) =>
    admin.api.organisations.updateMember({ params: { orgId: org, userId: member.userId }, body });
  it("preserves legacy members and reports each product's availability", async () => {
    const o = (await admin.api.identity.me()).organisations.find((o) => o.id === org)!;
    expect(o.portals?.map((p) => [p.product, p.role, p.usable])).toEqual([
      ["property", "org_admin", true],
      ["agency", "org_admin", true],
    ]);
  });
  it("uses distinct roles on every product API, never the broad organisation fallback", async () => {
    await change({ productRoles: { property: "org_admin", agency: "leasing_agent" } });
    const o = (await member.api.identity.me()).organisations[0]!;
    expect(o.role).toBe("viewer");
    expect(o.portals?.map((p) => [p.product, p.role])).toEqual([
      ["property", "org_admin"],
      ["agency", "leasing_agent"],
    ]);
    expect((await S.raw("GET", `/api/v1/orgs/${org}/property/properties`, undefined, member.token)).status).toBe(200);
    expect(
      (
        await S.raw(
          "POST",
          `/api/v1/orgs/${org}/property/properties`,
          { name: "Scoped administrator property" },
          member.token,
        )
      ).status,
    ).toBe(201);
    // In an agency, this action requires agency.leads.assign, which a leasing agent does not have.
    const denied = await S.raw(
      "POST",
      `/api/v1/orgs/${org}/agency/leads/missing/assign`,
      { agentUserId: admin.userId },
      member.token,
    );
    expect(denied.status).toBe(403);
    await refused(
      member.api.organisations.updateMember({ params: { orgId: org, userId: admin.userId }, body: { role: "viewer" } }),
      403,
    );
  });
  it("revokes one product immediately, including existing sessions and direct URLs", async () => {
    await change({ productRoles: { agency: "leasing_agent" } });
    expect((await member.api.identity.me()).organisations[0]!.products).toEqual(["agency"]);
    expect((await S.raw("GET", `/api/v1/orgs/${org}/property/properties`, undefined, member.token)).status).toBe(404);
    await refused(
      member.api.subscriptions.entitlements({ params: { orgId: org }, query: { product: "property" } }),
      404,
    );
  });
  it("refuses incompatible roles, unowned products, unknown keys and self access changes", async () => {
    await refused(change({ productRoles: { agency: "general_manager" } }), 400);
    await refused(change({ productRoles: { hotel: "org_admin" } }), 400);
    expect(
      (
        await S.raw(
          "PUT",
          `/api/v1/orgs/${org}/members/${member.userId}`,
          { productRoles: { unknown: "org_admin" } },
          admin.token,
        )
      ).status,
    ).toBe(400);
    await refused(
      admin.api.organisations.updateMember({
        params: { orgId: org, userId: admin.userId },
        body: { productRoles: {} },
      }),
      403,
    );
  });
  it("cannot grant access across organisations or through another product", async () => {
    const other = await S.newOrg({ plan: "PM-GROWTH", trial: false });
    expect(
      (await S.raw("GET", `/api/v1/orgs/${other.orgId}/property/properties`, undefined, member.token)).status,
    ).toBe(404);
    await refused(
      other.admin.api.organisations.updateMember({
        params: { orgId: org, userId: member.userId },
        body: { productRoles: { property: "org_admin" } },
      }),
      404,
    );
  });
  it("marks expired subscriptions read-only rather than active", async () => {
    await S.sql("UPDATE subscriptions SET status='expired',trial_ends=NULL WHERE org_id=$1 AND product='agency'", [
      org,
    ]);
    const p = (await member.api.identity.me()).organisations[0]!.portals![0]!;
    expect(p.usable).toBe(false);
    expect(p.status).toBe("expired");
  });
  it("empty explicit assignments revoke all product access and suspension hides the workspace", async () => {
    await change({ productRoles: {} });
    expect((await member.api.identity.me()).organisations[0]!.products).toEqual([]);
    expect((await S.raw("GET", `/api/v1/orgs/${org}/property/properties`, undefined, member.token)).status).toBe(404);
    await change({ status: "suspended" });
    await refused(member.api.identity.me(), 401);
  });
});
