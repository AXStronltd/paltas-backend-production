import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer, orgId: string, admin: Person, manager: Person, propertyId: string;
beforeAll(async () => {
  S = await startPropertyServer();
  ({ orgId, admin } = await pmOrg(S));
  ({ propertyId } = await setUpBuilding(orgId, admin));
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.maintenance.manage'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
});
afterAll(() => S.close());
const create = () =>
  admin.api.property.createWorkOrder({
    params: { orgId },
    body: { propertyId, scope: "Repair common area lighting", priority: "normal" },
  });
it("supports repeat edits, stable retrieval, stale-edit rejection, scoped history and unchanged accounting", async () => {
  let w = await create();
  for (const scope of ["Repair lobby lighting", "Repair lobby lighting and wiring"]) {
    w = await manager.api.property.updateWorkOrder({
      params: { orgId, workOrderId: w.id },
      body: {
        expectedVersion: w.version,
        scope,
        priority: "high",
        dueDate: "2026-11-15",
        reason: "Manager confirmed the scope and access schedule",
      },
    });
    expect((await admin.api.property.getWorkOrder({ params: { orgId, workOrderId: w.id } })).scope).toBe(scope);
  }
  expect(w.version).toBe(3);
  await refused(
    manager.api.property.updateWorkOrder({
      params: { orgId, workOrderId: w.id },
      body: {
        expectedVersion: 1,
        scope: w.scope,
        priority: "low",
        dueDate: w.dueDate,
        reason: "Stale browser must not overwrite",
      },
    }),
    409,
  );
  const page = await manager.api.property.workOrderHistory({
    params: { orgId, workOrderId: w.id },
    query: { limit: 1 },
  });
  expect(page.total).toBeGreaterThanOrEqual(2);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]?.before).toHaveProperty("scope");
  expect((await S.sql("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
it("serialises concurrent corrections and refuses completed-work mutation", async () => {
  const w = await create(),
    body = {
      expectedVersion: w.version,
      scope: w.scope,
      priority: "normal" as const,
      dueDate: "2026-11-16",
      reason: "Reschedule following access confirmation",
    };
  const results = await Promise.allSettled([
    admin.api.property.updateWorkOrder({ params: { orgId, workOrderId: w.id }, body }),
    admin.api.property.updateWorkOrder({ params: { orgId, workOrderId: w.id }, body }),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  await admin.api.property.cancelWorkOrder({
    params: { orgId, workOrderId: w.id },
    body: { reason: "No work now required" },
  });
  const latest = await admin.api.property.getWorkOrder({ params: { orgId, workOrderId: w.id } });
  expect(latest.version).toBe(3);
  await refused(
    admin.api.property.updateWorkOrder({
      params: { orgId, workOrderId: w.id },
      body: { ...body, expectedVersion: latest.version },
    }),
    409,
  );
});
it("freezes quoted scope while allowing a recorded schedule change", async () => {
  let w = await create();
  const supplier = (
    await admin.api.contacts.createContact({
      params: { orgId },
      body: { name: "Test electrician", types: ["supplier"] },
    })
  ).contact;
  w = await admin.api.property.addQuote({
    params: { orgId, workOrderId: w.id },
    body: { supplierId: supplier.id, amountMinor: 10000, fileName: "Synthetic quotation" },
  });
  const body = {
    expectedVersion: w.version,
    scope: "Different quoted scope",
    priority: w.priority,
    dueDate: w.dueDate,
    reason: "Must obtain fresh quotation for changed scope",
  };
  await refused(admin.api.property.updateWorkOrder({ params: { orgId, workOrderId: w.id }, body }), 409);
  w = await admin.api.property.updateWorkOrder({
    params: { orgId, workOrderId: w.id },
    body: { ...body, scope: w.scope, dueDate: "2026-12-01" },
  });
  expect(w.quotes[0]?.amountMinor).toBe(10000);
  expect(w.dueDate).toBe("2026-12-01");
});
it("preserves completion evidence in audit when quality review sends work back", async () => {
  const w = await create();
  await S.sql(
    "UPDATE pm_work_orders SET status='completed',completed_by=$2,completed_at=now(),completion_notes='Original repair',evidence='[\"Synthetic repair photo\"]' WHERE id=$1",
    [w.id, manager.userId],
  );
  await admin.api.property.verifyWorkOrder({
    params: { orgId, workOrderId: w.id },
    body: { accepted: false, note: "Needs additional inspection" },
  });
  const h = await admin.api.property.workOrderHistory({ params: { orgId, workOrderId: w.id } });
  expect(h.entries.find((x) => x.action === "Work sent back")?.before).toHaveProperty("evidence", [
    "Synthetic repair photo",
  ]);
});
it("enforces property, organisation and role access, including prompt revocation", async () => {
  const w = await create(),
    stranger = await pmOrg(S),
    viewer = await S.addMember(orgId, admin.api, "viewer");
  await refused(stranger.admin.api.property.getWorkOrder({ params: { orgId, workOrderId: w.id } }), 404);
  await refused(viewer.api.property.workOrderHistory({ params: { orgId, workOrderId: w.id } }), 403);
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
  ]);
  await refused(manager.api.property.getWorkOrder({ params: { orgId, workOrderId: w.id } }), 404);
  await refused(manager.api.property.workOrderHistory({ params: { orgId, workOrderId: w.id } }), 404);
});

it("retains quotation correction amounts and terms in scoped work history", async () => {
  const w = await create();
  const supplier = (
    await admin.api.contacts.createContact({
      params: { orgId },
      body: { name: "Quotation history supplier", types: ["supplier"] },
    })
  ).contact;
  const params = { orgId, workOrderId: w.id };
  await admin.api.property.addQuote({
    params,
    body: { supplierId: supplier.id, amountMinor: 120000, days: 3, fileName: "Original quotation.pdf" },
  });
  await admin.api.property.addQuote({
    params,
    body: { supplierId: supplier.id, amountMinor: 12000, days: 5, fileName: "Corrected quotation.pdf" },
  });
  const current = await admin.api.property.getWorkOrder({ params });
  expect(current.quotes).toHaveLength(1);
  expect(current.quotes[0]?.amountMinor).toBe(12000);
  const history = await admin.api.property.workOrderHistory({ params });
  const changes = history.entries.filter((x) => x.action === "Quotation recorded");
  expect(changes).toHaveLength(2);
  expect(changes[0]?.before).toMatchObject({
    supplierId: supplier.id,
    amountMinor: 120000,
    days: 3,
    fileName: "Original quotation.pdf",
  });
  expect(changes[0]?.after).toMatchObject({ amountMinor: 12000, days: 5, fileName: "Corrected quotation.pdf" });
  expect(changes[1]?.before).toBeNull();
  expect((await S.sql("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
