// Security front-end gaps: the gate officer lists the sites to choose the desk; a guard reads only their own duty
// (shifts, post orders, patrols); a site's details can be changed after it is created.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOps,
  securityOrg,
  SITE_POS,
  startSecurityServer,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("security self-service reads and site changes", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let ops: TestOps;
  const day = "2026-10-20";
  const window = { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` };

  beforeAll(async () => {
    S = await startSecurityServer();
    const o = await securityOrg(S);
    orgId = o.orgId;
    st = o.staff;
    ops = await buildOps(orgId, st);
    const om = st.operations_manager.api.security;
    await om.updatePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { orderText: "Check every vehicle. Log every visitor." },
    });
    const created = await om.createShifts({
      params: { orgId },
      body: {
        postId: ops.gatePostId,
        shifts: [
          { startsAt: `${day}T06:00:00Z`, endsAt: `${day}T18:00:00Z` },
          { startsAt: `${day}T06:00:00Z`, endsAt: `${day}T18:00:00Z` },
        ],
      },
    });
    await om.assignShift({ params: { orgId, shiftId: created.shifts[0]!.id }, body: { guardId: ops.guards.A } });
    await om.assignShift({ params: { orgId, shiftId: created.shifts[1]!.id }, body: { guardId: ops.guards.B } });
  });
  afterAll(() => S.close());

  it("the gate officer lists the sites (and still cannot change them)", async () => {
    const sites = await st.gate_officer.api.security.listSites({ params: { orgId } });
    expect(sites.sites.map((s) => s.id)).toContain(ops.siteId);
    await refused(
      st.gate_officer.api.security.updateSite({ params: { orgId, siteId: ops.siteId }, body: { name: "X" } }),
      403,
    );
  });

  it("a guard reads their own shifts, post orders and patrols — never another guard's", async () => {
    const mine = await st.guardA.api.security.myDuty({ params: { orgId }, query: window });
    expect(mine.guard?.id).toBe(ops.guards.A);
    expect(mine.shifts.map((s) => s.guardId)).toEqual([ops.guards.A]);
    expect(mine.posts).toEqual([
      expect.objectContaining({ id: ops.gatePostId, siteId: ops.siteId, orderVersion: 2, acknowledged: false }),
    ]);
    await st.guardA.api.security.acknowledgePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { guardId: ops.guards.A, version: 2 },
    });
    expect((await st.guardA.api.security.myDuty({ params: { orgId }, query: window })).posts[0]!.acknowledged).toBe(
      true,
    );
    const theirs = await st.guardB.api.security.myDuty({ params: { orgId }, query: window });
    expect(theirs.shifts.map((s) => s.guardId)).toEqual([ops.guards.B]);
    // the broader roster stays closed to guards
    await refused(st.guardA.api.security.listShifts({ params: { orgId }, query: window }), 403);
    // a member who is no guard gets an empty duty, not someone else's
    expect(await st.supervisor.api.security.myDuty({ params: { orgId }, query: window })).toEqual({
      guard: null,
      shifts: [],
      posts: [],
      patrols: [],
    });
  });

  it("the operations manager changes a site's geofence and instructions; omitted fields stay", async () => {
    const before = await st.operations_manager.api.security.getSite({ params: { orgId, siteId: ops.siteId } });
    const after = await st.operations_manager.api.security.updateSite({
      params: { orgId, siteId: ops.siteId },
      body: { geofence: { ...SITE_POS, radiusM: 400 }, instructions: "Gate closes at 23:00." },
    });
    expect(after.instructions).toBe("Gate closes at 23:00.");
    expect(after.geofence?.radiusM).toBe(400);
    expect([after.name, after.clientId, after.kind]).toEqual([before.name, before.clientId, before.kind]);
    const audit = await S.sql("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'Security site changed'", [
      orgId,
    ]);
    expect(audit).toHaveLength(1);
  });
});
