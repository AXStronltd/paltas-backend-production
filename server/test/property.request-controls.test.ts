import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  manager: Person,
  propertyId: string,
  unitId: string,
  otherUnit: string,
  request: P.MaintenanceRequest;
beforeAll(async () => {
  S = await startPropertyServer();
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  unitId = b.units["A-101"]!;
  otherUnit = b.units["A-102"]!;
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.maintenance.manage','property.maintenance.request'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
});
afterAll(() => S.close());
it("allows repeated persisted corrections, cancellation through closure, and reopening without record replacement", async () => {
  request = await admin.api.property.createRequest({
    params: { orgId },
    body: { propertyId, unitId, title: "Water tap leaking", category: "plumbing", priority: "normal" },
  });
  for (const title of ["Water tap leaking in kitchen", "Kitchen tap and connection leaking"]) {
    request = await manager.api.property.updateMaintenanceRequest({
      params: { orgId, requestId: request.id },
      body: {
        expectedVersion: request.version,
        title,
        category: "Plumbing repair",
        priority: "high",
        reason: "Resident clarified the repair request",
      },
    });
    expect((await admin.api.property.getMaintenanceRequest({ params: { orgId, requestId: request.id } })).title).toBe(
      title,
    );
  }
  expect(request.version).toBe(3);
  await refused(
    admin.api.property.updateMaintenanceRequest({
      params: { orgId, requestId: request.id },
      body: {
        expectedVersion: 1,
        title: "Stale edit",
        category: "plumbing",
        priority: "normal",
        reason: "Stale correction must not overwrite",
      },
    }),
    409,
  );
  request = await manager.api.property.closeRequest({
    params: { orgId, requestId: request.id },
    body: { note: "Issue resolved without purchasing parts" },
  });
  const closedVersion = request.version;
  request = await manager.api.property.updateMaintenanceRequest({
    params: { orgId, requestId: request.id },
    body: {
      expectedVersion: request.version,
      title: "Kitchen tap repair completed",
      category: "Plumbing repair",
      priority: request.priority,
      reason: "Correct the historical request title",
    },
  });
  expect(request.status).toBe("closed");
  await refused(
    manager.api.property.reopenMaintenanceRequest({
      params: { orgId, requestId: request.id },
      body: { expectedVersion: closedVersion, reason: "Do not overwrite a later correction" },
    }),
    409,
  );
  request = await manager.api.property.reopenMaintenanceRequest({
    params: { orgId, requestId: request.id },
    body: { expectedVersion: request.version, reason: "The leak returned and needs follow-up" },
  });
  expect(request.status).toBe("open");
  expect(request.resolvedAt).toBeNull();
  const audit = await S.sql(
    "SELECT detail,before FROM audit_log WHERE org_id=$1 AND target=$2 AND action='Maintenance request reopened'",
    [orgId, request.id],
  );
  expect(audit[0]?.before).toHaveProperty("resolvedAt");
});
it("serialises repeated work-order submissions and reuses the same active order", async () => {
  const body = {
    propertyId,
    unitId,
    requestId: request.id,
    scope: "Repair leaking kitchen tap",
    priority: "high" as const,
  };
  const [a, b] = await Promise.all([
    manager.api.property.createWorkOrder({ params: { orgId }, body }),
    manager.api.property.createWorkOrder({ params: { orgId }, body }),
  ]);
  expect(a.id).toBe(b.id);
  expect(
    (await S.sql("SELECT id FROM pm_work_orders WHERE org_id=$1 AND request_id=$2", [orgId, request.id])).length,
  ).toBe(1);
  request = await admin.api.property.getMaintenanceRequest({ params: { orgId, requestId: request.id } });
  expect(request.status).toBe("assigned");
  await refused(
    manager.api.property.createWorkOrder({
      params: { orgId },
      body: { ...body, scope: "Different work needs explicit review" },
    }),
    409,
  );
  await refused(manager.api.property.createWorkOrder({ params: { orgId }, body: { ...body, unitId: otherUnit } }), 400);
  await refused(
    manager.api.property.updateMaintenanceRequest({
      params: { orgId, requestId: request.id },
      body: {
        expectedVersion: request.version,
        title: request.title,
        category: request.category,
        priority: "urgent",
        reason: "An agreed work order schedule must be reviewed",
      },
    }),
    409,
  );
});
it("does not close an active work order through its request or reopen an already assigned request", async () => {
  await refused(
    manager.api.property.closeRequest({
      params: { orgId, requestId: request.id },
      body: { note: "Cannot close unfinished work" },
    }),
    409,
  );
  await refused(
    manager.api.property.reopenMaintenanceRequest({
      params: { orgId, requestId: request.id },
      body: { expectedVersion: request.version, reason: "Cannot reopen an active assigned case" },
    }),
    409,
  );
  const w = (await admin.api.property.listWorkOrders({ params: { orgId } })).workOrders.find(
    (x) => x.requestId === request.id,
  )!;
  await manager.api.property.cancelWorkOrder({
    params: { orgId, workOrderId: w.id },
    body: { reason: "Supplier visit is no longer needed" },
  });
  expect((await admin.api.property.getMaintenanceRequest({ params: { orgId, requestId: request.id } })).status).toBe(
    "open",
  );
});
it("enforces organisation/property/role isolation and permission revocation", async () => {
  const stranger = await pmOrg(S);
  await refused(stranger.admin.api.property.getMaintenanceRequest({ params: { orgId, requestId: request.id } }), 404);
  const viewer = await S.addMember(orgId, admin.api, "viewer");
  await refused(
    viewer.api.property.updateMaintenanceRequest({
      params: { orgId, requestId: request.id },
      body: {
        expectedVersion: request.version,
        title: request.title,
        category: request.category,
        priority: request.priority,
        reason: "Read-only user cannot edit",
      },
    }),
    403,
  );
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
  ]);
  await refused(manager.api.property.getMaintenanceRequest({ params: { orgId, requestId: request.id } }), 404);
});
it("exposes only this request's immutable correction history", async () => {
  const page = await admin.api.property.maintenanceRequestHistory({
    params: { orgId, requestId: request.id },
    query: { limit: 2 },
  });
  expect(page.total).toBeGreaterThanOrEqual(5);
  expect(page.entries).toHaveLength(2);
  const more = await admin.api.property.maintenanceRequestHistory({
    params: { orgId, requestId: request.id },
    query: { offset: 2 },
  });
  expect(more.entries.some((e) => e.action === "Maintenance request corrected")).toBe(true);
  const changed = more.entries.find((e) => e.action === "Maintenance request corrected");
  expect(changed?.before).toHaveProperty("title");
  expect(changed?.after).toHaveProperty("title");
  await refused(manager.api.property.maintenanceRequestHistory({ params: { orgId, requestId: request.id } }), 404);
});
it("keeps financial data unchanged by operational corrections", async () => {
  const journal = await S.sql("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1", [orgId]);
  expect(journal[0]?.n).toBe(0);
  expect((await admin.api.property.listBills({ params: { orgId } })).bills).toHaveLength(0);
  expect((await admin.api.property.getMaintenanceRequest({ params: { orgId, requestId: request.id } })).id).toBe(
    request.id,
  );
});
