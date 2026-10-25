import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer, orgId: string, admin: Person, manager: Person, propertyId: string;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  ({ orgId, admin } = await pmOrg(S));
  ({ propertyId } = await setUpBuilding(orgId, admin));
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.maintenance.manage'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
});
afterAll(() => S.close());
const input = {
  title: "Generator preventive service",
  assetLabel: "Common area generator",
  priority: "normal" as const,
  everyDays: 30,
  nextDue: "2026-10-25",
  active: true,
};
async function fire() {
  await S.sql("UPDATE sched_jobs SET status='paused',paused_reason='preventive test' WHERE org_id IS NULL");
  const [job] = await S.sql(
    "SELECT id,next_run_at FROM sched_jobs WHERE key='property.preventive_maintenance' AND target_id=$1",
    [propertyId],
  );
  let n = 0;
  const at = new Date(new Date(job.next_run_at).getTime() + 60000);
  while (await S.app.core.scheduler.runOnce("preventive-test", at)) n++;
  expect(n).toBeGreaterThan(0);
  const [run] = await S.sql("SELECT status,summary FROM sched_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1", [
    job.id,
  ]);
  expect(run.status).toBe("succeeded");
  return run;
}
it("creates a persisted plan, runs durable scheduling once and retains existing work orders on pause", async () => {
  let p = await manager.api.property.createPreventivePlan({ params: { orgId }, body: { ...input, propertyId } });
  expect((await fire()).summary).toContain("1 preventive work order(s)");
  let h = await admin.api.property.preventivePlanHistory({ params: { orgId, preventivePlanId: p.id } });
  expect(h.occurrences).toHaveLength(1);
  expect(h.occurrences[0]?.status).toBe("requesting_quotes");
  const current = await admin.api.property.getPreventivePlan({ params: { orgId, preventivePlanId: p.id } });
  expect(current.nextDue > input.nextDue).toBe(true);
  await refused(
    manager.api.property.updatePreventivePlan({
      params: { orgId, preventivePlanId: p.id },
      body: { ...input, expectedVersion: p.version, reason: "Stale scheduler state must not overwrite" },
    }),
    409,
  );
  p = await manager.api.property.updatePreventivePlan({
    params: { orgId, preventivePlanId: p.id },
    body: {
      ...input,
      nextDue: "2026-10-25",
      active: false,
      expectedVersion: current.version,
      reason: "Pause while the supplier completes servicing",
    },
  });
  await fire();
  h = await admin.api.property.preventivePlanHistory({ params: { orgId, preventivePlanId: p.id } });
  expect(h.occurrences).toHaveLength(1);
  expect(h.events.entries.some((x) => x.action === "Preventive plan changed")).toBe(true);
  await manager.api.property.updatePreventivePlan({
    params: { orgId, preventivePlanId: p.id },
    body: { ...input, expectedVersion: p.version, reason: "Resume after access is available" },
  });
  await fire();
  expect(
    (await admin.api.property.preventivePlanHistory({ params: { orgId, preventivePlanId: p.id } })).occurrences,
  ).toHaveLength(1);
  await admin.api.property.cancelWorkOrder({
    params: { orgId, workOrderId: h.occurrences[0]!.workOrderId },
    body: { reason: "Recorded servicing occurrence remains in history" },
  });
  await fire();
  expect(
    (await admin.api.property.preventivePlanHistory({ params: { orgId, preventivePlanId: p.id } })).occurrences,
  ).toHaveLength(1);
  expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
it("supports create-paused, multiple edits, pagination and scoped unit validation", async () => {
  let p = await admin.api.property.createPreventivePlan({
    params: { orgId },
    body: { ...input, propertyId, active: false },
  });
  for (const title of ["Lift quarterly inspection", "Lift servicing and inspection"]) {
    p = await admin.api.property.updatePreventivePlan({
      params: { orgId, preventivePlanId: p.id },
      body: {
        ...input,
        title,
        active: false,
        expectedVersion: p.version,
        reason: "Manager updated planned servicing requirements",
      },
    });
    expect((await admin.api.property.getPreventivePlan({ params: { orgId, preventivePlanId: p.id } })).title).toBe(
      title,
    );
  }
  const page = await admin.api.property.listPreventivePlans({ params: { orgId }, query: { propertyId, limit: 1 } });
  expect(page.plans).toHaveLength(1);
  expect(page.total).toBeGreaterThan(1);
  const other = await setUpBuilding(orgId, admin, { name: "Separate property", units: ["101"] });
  await refused(
    admin.api.property.createPreventivePlan({
      params: { orgId },
      body: { ...input, propertyId, unitId: other.units["101"]! },
    }),
    400,
  );
});
it("rejects wrong organisations, roles, unassigned properties and revoked scheduling authority", async () => {
  const p = await manager.api.property.createPreventivePlan({ params: { orgId }, body: { ...input, propertyId } }),
    other = await pmOrg(S),
    viewer = await S.addMember(orgId, admin.api, "viewer");
  await refused(other.admin.api.property.getPreventivePlan({ params: { orgId, preventivePlanId: p.id } }), 404);
  await refused(viewer.api.property.createPreventivePlan({ params: { orgId }, body: { ...input, propertyId } }), 403);
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
  ]);
  await refused(manager.api.property.getPreventivePlan({ params: { orgId, preventivePlanId: p.id } }), 404);
  await refused(manager.api.property.listPreventivePlans({ params: { orgId }, query: { propertyId } }), 404);
  await fire();
  expect(
    (await admin.api.property.preventivePlanHistory({ params: { orgId, preventivePlanId: p.id } })).occurrences,
  ).toHaveLength(0);
});
it("processes a bounded backlog without duplicates or starvation", async () => {
  const params = { orgId };
  await S.sql(
    "INSERT INTO pm_preventive_plans(id,org_id,property_id,title,asset_label,priority,every_days,next_due,active,updated_by) SELECT 'load-plan-'||i,$1,$2,'Synthetic servicing '||i,'Test asset','normal',30,'1900-01-01',true,$3 FROM generate_series(1,105) i",
    [orgId, propertyId, admin.userId],
  );
  await fire();
  expect(
    (
      await S.sql(
        "SELECT count(*)::int n FROM pm_preventive_occurrences WHERE org_id=$1 AND plan_id LIKE 'load-plan-%'",
        [orgId],
      )
    )[0]?.n,
  ).toBe(100);
  await fire();
  expect(
    (
      await S.sql(
        "SELECT count(*)::int n FROM pm_preventive_occurrences WHERE org_id=$1 AND plan_id LIKE 'load-plan-%'",
        [orgId],
      )
    )[0]?.n,
  ).toBe(105);
  await fire();
  expect(
    (
      await S.sql(
        "SELECT count(*)::int n FROM pm_preventive_occurrences WHERE org_id=$1 AND plan_id LIKE 'load-plan-%'",
        [orgId],
      )
    )[0]?.n,
  ).toBe(105);
  expect(
    (await admin.api.property.listPreventivePlans({ params, query: { propertyId, limit: 100 } })).total,
  ).toBeGreaterThanOrEqual(105);
  expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
