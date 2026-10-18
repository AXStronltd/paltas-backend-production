import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProject, devOrg, startDevServer, type DevStaff } from "./support/development-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";
describe("Explicitly published developer pages and real enquiry pipeline", () => {
  let S: TestServer, orgId: string, staff: DevStaff, projectId: string, slug: string;
  beforeAll(async () => {
    S = await startDevServer();
    const a = await devOrg(S);
    orgId = a.orgId;
    staff = a.staff;
    projectId = (await buildProject(staff.ceo, orgId, { units: 1 })).projectId;
  });
  afterAll(() => S.close());
  it("keeps projects private by default and checks verification and write permissions", async () => {
    expect(await staff.ceo.api.development.getProjectPublication({ params: { orgId, projectId } })).toBeNull();
    await refused(
      staff.viewer.api.development.publishProject({ params: { orgId, projectId }, body: { published: true } }),
      403,
    );
    await S.sql("UPDATE users SET email_verified_at=NULL WHERE id=$1", [staff.ceo.userId]);
    await refused(
      staff.ceo.api.development.publishProject({ params: { orgId, projectId }, body: { published: true } }),
      403,
    );
    await S.sql("UPDATE users SET email_verified_at=now() WHERE id=$1", [staff.ceo.userId]);
    const p = await staff.ceo.api.development.publishProject({
      params: { orgId, projectId },
      body: { published: true },
    });
    slug = p.slug;
    const pub = await S.api.development.publicProject({ params: { slug } });
    expect(Object.keys(pub).sort()).toEqual(["constructionPct", "location", "name"]);
    expect(pub.name).toBe("Riverside Gardens");
  });
  it("creates and assigns a real new lead once, records consent and accepts no reservation or money", async () => {
    const body = {
      name: "Public Buyer",
      email: "public@example.test",
      message: "Please arrange a site visit.",
      contactConsent: true as const,
    };
    const responses = await Promise.all([1, 2].map(() => S.api.development.enquireProject({ params: { slug }, body })));
    expect(responses).toEqual([{ received: true }, { received: true }]);
    const rows = await S.sql(
      "SELECT id,agent_user_id,project_id FROM dev_contacts WHERE org_id=$1 AND email='public@example.test'",
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(projectId);
    expect(rows[0].agent_user_id).toBeTruthy();
    const listed = await staff.ceo.api.development.listBuyers({ params: { orgId }, query: {} });
    expect(listed.buyers.find((b) => b.id === rows[0].id)).toMatchObject({
      stage: "enquiry",
      source: "Public project page",
    });
    expect(
      await S.sql("SELECT id FROM dev_project_enquiries WHERE org_id=$1 AND contact_consent", [orgId]),
    ).toHaveLength(1);
    expect(await S.sql("SELECT id FROM dev_reservations WHERE org_id=$1", [orgId])).toHaveLength(0);
    const bad = await S.raw("POST", `/api/v1/public/development-projects/${slug}/enquiries`, {
      ...body,
      contactConsent: false,
    });
    expect(bad.status).toBe(400);
  });
  it("unpublishing or suspending stops public reads and new enquiries; other organisations cannot publish it", async () => {
    const other = await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false });
    await refused(
      other.admin.api.development.publishProject({
        params: { orgId: other.orgId, projectId },
        body: { published: true },
      }),
      404,
    );
    await staff.ceo.api.development.publishProject({ params: { orgId, projectId }, body: { published: false } });
    await refused(S.api.development.publicProject({ params: { slug } }), 404);
    await refused(
      S.api.development.enquireProject({
        params: { slug },
        body: { name: "Not accepted", email: "no@example.test", message: "", contactConsent: true },
      }),
      404,
    );
  });
});
