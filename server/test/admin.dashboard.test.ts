import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refused, startServer, type TestServer } from "./support/test-server.js";

describe("staff cinematic dashboard data", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  let org: Awaited<ReturnType<TestServer["newOrg"]>>;
  beforeAll(async () => {
    S = await startServer();
    sa = await S.staff();
    org = await S.newOrg({ name: "Dashboard Synthetic Org" });
    await S.sql("INSERT INTO pm_properties(id,org_id,name) VALUES('dash-p',$1,'Synthetic Property')", [org.orgId]);
    await S.sql(
      "INSERT INTO pm_buildings(id,org_id,property_id,name,is_archived) VALUES('dash-b',$1,'dash-p','Archived',false)",
      [org.orgId],
    );
    await S.sql(
      "INSERT INTO pm_units(id,org_id,property_id,building_id,unit_no) VALUES('dash-u1',$1,'dash-p',NULL,'101'),('dash-u2',$1,'dash-p','dash-b','102')",
      [org.orgId],
    );
    await S.sql("UPDATE pm_buildings SET is_archived=true WHERE id='dash-b'");
    await S.sql("UPDATE organisations SET created_at=now()-interval '1 day' WHERE id=$1", [org.orgId]);
    await S.sql(
      "INSERT INTO pm_documents(id,org_id,name,filename) VALUES('dash-d',$1,'Historical statement','statement.xlsx')",
      [org.orgId],
    );
  });
  afterAll(() => S.close());
  it("rejects anonymous and customer access", async () => {
    expect((await S.raw("GET", "/api/v1/admin/dashboard-insights")).status).toBe(401);
    await refused(org.admin.api.admin.dashboardInsights(), 404);
    await refused(org.admin.api.admin.platformRecords(), 404);
  });
  it("counts current units without archived inventory and returns a complete bounded UTC series", async () => {
    const r = await sa.api.admin.dashboardInsights({ query: { days: 7 } });
    expect(r.totals.properties).toBe(1);
    expect(r.totals.units).toBe(1);
    expect(r.totals.documents).toBe(1);
    expect(r.timeline).toHaveLength(7);
    expect(
      r.timeline.find((x) => x.date === new Date(Date.parse(r.asOf) - 86400000).toISOString().slice(0, 10))
        ?.organisations,
    ).toBe(1);
    expect(r.timeline.every((x) => x.organisations >= 0 && x.users >= 0 && x.bookings >= 0)).toBe(true);
    expect(new Set(r.timeline.map((x) => x.date)).size).toBe(7);
  });
  it("returns filtered metadata and an authorised company reference, never file contents", async () => {
    const r = await sa.api.admin.platformRecords({ query: { kind: "documents", q: "Historical", orgId: org.orgId } });
    expect(r.total).toBe(1);
    expect(r.records[0]).toMatchObject({
      id: "dash-d",
      orgId: org.orgId,
      name: "Historical statement",
      product: "property",
    });
    expect(Object.keys(r.records[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "orgId",
      "orgName",
      "product",
      "status",
    ]);
  });
  it("supports pagination and product filters without wildcard or SQL interpretation", async () => {
    expect((await sa.api.admin.platformRecords({ query: { kind: "properties", product: "hotel" } })).total).toBe(0);
    const p = await sa.api.admin.platformRecords({ query: { kind: "properties", limit: 1, offset: 1 } });
    expect(p.total).toBe(1);
    expect(p.records).toEqual([]);
    expect((await sa.api.admin.platformRecords({ query: { q: "%' OR 1=1 --" } })).records).toEqual([]);
  });
  it("rejects unbounded ranges and pages", async () => {
    expect((await S.raw("GET", "/api/v1/admin/dashboard-insights?days=999", undefined, sa.token)).status).toBe(400);
    expect((await S.raw("GET", "/api/v1/admin/platform-records?limit=999", undefined, sa.token)).status).toBe(400);
  });
  it("read-only requests leave property and document rows unchanged", async () => {
    const before = await S.sql("SELECT row_to_json(p) AS row FROM pm_properties p");
    await sa.api.admin.dashboardInsights();
    await sa.api.admin.platformRecords({ query: { kind: "bookings" } });
    expect(await S.sql("SELECT row_to_json(p) AS row FROM pm_properties p")).toEqual(before);
    expect((await S.sql("SELECT count(*)::int AS n FROM pm_documents WHERE id='dash-d'"))[0].n).toBe(1);
  });
});
