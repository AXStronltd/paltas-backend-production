import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer, orgId: string, admin: Person, manager: Person, propertyId: string, unitId: string;
let template: P.InspectionTemplate, inspection: P.Inspection;
beforeAll(async () => {
  S = await startPropertyServer();
  ({ orgId, admin } = await pmOrg(S));
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  unitId = b.units["A-101"]!;
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.maintenance.manage'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
});
afterAll(() => S.close());
it("creates a reusable checklist and snapshots it when scheduling", async () => {
  await refused(
    manager.api.property.createInspectionTemplate({
      params: { orgId },
      body: { propertyId, name: "Duplicates", areas: ["Kitchen", "kitchen"] },
    }),
    400,
  );
  template = await manager.api.property.createInspectionTemplate({
    params: { orgId },
    body: { propertyId, name: "Apartment handover", areas: ["Kitchen", "Bathroom"] },
  });
  inspection = await manager.api.property.scheduleInspection({
    params: { orgId },
    body: { propertyId, unitId, kind: "move_in", scheduledDate: "2026-11-01", templateId: template.id },
  });
  expect(inspection.checklist).toEqual(["Kitchen", "Bathroom"]);
  expect(inspection.version).toBe(1);
  template = await manager.api.property.updateInspectionTemplate({
    params: { orgId, inspectionTemplateId: template.id },
    body: {
      expectedVersion: template.version,
      name: template.name,
      areas: ["Kitchen", "Bathroom", "Balcony"],
      active: false,
      reason: "Archive this checklist after process review",
    },
  });
  expect(
    (await manager.api.property.getInspection({ params: { orgId, inspectionId: inspection.id } })).checklist,
  ).toEqual(["Kitchen", "Bathroom"]);
  await refused(
    manager.api.property.scheduleInspection({
      params: { orgId },
      body: { propertyId, kind: "routine", scheduledDate: "2026-11-01", templateId: template.id },
    }),
    409,
  );
});
it("supports repeat rescheduling, cancellation and restoration with version protection", async () => {
  for (const scheduledDate of ["2026-11-02", "2026-11-03"]) {
    inspection = await manager.api.property.changeInspectionSchedule({
      params: { orgId, inspectionId: inspection.id },
      body: {
        expectedVersion: inspection.version,
        action: "reschedule",
        scheduledDate,
        reason: "Resident confirmed a different access date",
      },
    });
    expect(inspection.scheduledDate).toBe(scheduledDate);
  }
  await refused(
    manager.api.property.completeInspection({
      params: { orgId, inspectionId: inspection.id },
      body: {
        expectedVersion: 1,
        items: [
          { area: "Kitchen", condition: "good" },
          { area: "Bathroom", condition: "good" },
        ],
      },
    }),
    409,
  );
  inspection = await manager.api.property.changeInspectionSchedule({
    params: { orgId, inspectionId: inspection.id },
    body: {
      expectedVersion: inspection.version,
      action: "cancel",
      reason: "Resident requested cancellation of this visit",
    },
  });
  expect(inspection.status).toBe("cancelled");
  await refused(
    manager.api.property.completeInspection({
      params: { orgId, inspectionId: inspection.id },
      body: {
        items: [
          { area: "Kitchen", condition: "good" },
          { area: "Bathroom", condition: "good" },
        ],
      },
    }),
    409,
  );
  inspection = await manager.api.property.changeInspectionSchedule({
    params: { orgId, inspectionId: inspection.id },
    body: {
      expectedVersion: inspection.version,
      action: "restore",
      reason: "Resident confirmed the inspection can proceed",
    },
  });
  expect(inspection.status).toBe("scheduled");
});
it("requires each saved area, preserves completed findings and creates corrective work once", async () => {
  await refused(
    manager.api.property.completeInspection({
      params: { orgId, inspectionId: inspection.id },
      body: { expectedVersion: inspection.version, items: [{ area: "Kitchen", condition: "good" }] },
    }),
    400,
  );
  await refused(
    manager.api.property.completeInspection({
      params: { orgId, inspectionId: inspection.id },
      body: {
        expectedVersion: inspection.version,
        items: [
          { area: "Kitchen", condition: "good" },
          { area: "Kitchen", condition: "damaged" },
          { area: "Bathroom", condition: "good" },
        ],
      },
    }),
    400,
  );
  inspection = await manager.api.property.completeInspection({
    params: { orgId, inspectionId: inspection.id },
    body: {
      expectedVersion: inspection.version,
      items: [
        { area: "Kitchen", condition: "good" },
        { area: "Bathroom", condition: "needs_repair", note: "Tap leaking" },
      ],
    },
  });
  expect(inspection.status).toBe("completed");
  expect(inspection.requestIds).toHaveLength(1);
  await refused(
    manager.api.property.changeInspectionSchedule({
      params: { orgId, inspectionId: inspection.id },
      body: { expectedVersion: inspection.version, action: "cancel", reason: "Completed findings must not be erased" },
    }),
    409,
  );
  const history = await manager.api.property.inspectionHistory({
    params: { orgId, inspectionId: inspection.id },
    query: { limit: 2 },
  });
  expect(history.entries).toHaveLength(2);
  expect(history.total).toBeGreaterThanOrEqual(6);
  expect(history.entries[0]?.after).toHaveProperty("items");
  expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
it("restores archived templates, rejects stale changes and returns searchable pages", async () => {
  template = await admin.api.property.updateInspectionTemplate({
    params: { orgId, inspectionTemplateId: template.id },
    body: {
      expectedVersion: template.version,
      name: template.name,
      areas: template.areas,
      active: true,
      reason: "Restore approved checklist for future visits",
    },
  });
  await refused(
    admin.api.property.updateInspectionTemplate({
      params: { orgId, inspectionTemplateId: template.id },
      body: {
        expectedVersion: 1,
        name: "Stale overwrite",
        areas: ["Hallway"],
        active: true,
        reason: "Do not overwrite later template changes",
      },
    }),
    409,
  );
  const p = await admin.api.property.listInspectionTemplates({
    params: { orgId },
    query: { propertyId, q: "handover", limit: 1 },
  });
  expect(p.templates).toHaveLength(1);
  expect(p.total).toBe(1);
  expect(
    (await admin.api.property.listInspectionTemplates({ params: { orgId }, query: { propertyId, q: "%" } })).total,
  ).toBe(0);
});
it("serialises concurrent schedule changes", async () => {
  const x = await admin.api.property.scheduleInspection({
      params: { orgId },
      body: { propertyId, kind: "routine", scheduledDate: "2026-11-01" },
    }),
    body = {
      expectedVersion: x.version,
      action: "reschedule" as const,
      scheduledDate: "2026-11-10",
      reason: "Confirmed appointment must not lose updates",
    };
  const results = await Promise.allSettled([
    admin.api.property.changeInspectionSchedule({ params: { orgId, inspectionId: x.id }, body }),
    admin.api.property.changeInspectionSchedule({ params: { orgId, inspectionId: x.id }, body }),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
});
it("retains paginated checklist history", async () => {
  const page = await admin.api.property.inspectionTemplateHistory({
    params: { orgId, inspectionTemplateId: template.id },
    query: { limit: 1 },
  });
  expect(page.total).toBe(3);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]?.after).toHaveProperty("active", true);
});
it("links a follow-up without rewriting completed findings or recreating corrective work", async () => {
  const next = await admin.api.property.scheduleInspection({
    params: { orgId },
    body: {
      propertyId,
      kind: "move_in",
      scheduledDate: "2026-11-05",
      followUpOf: inspection.id,
      followUpReason: "Reinspect the repaired bathroom tap",
    },
  });
  expect(next.followUpOf).toBe(inspection.id);
  expect(next.unitId).toBe(inspection.unitId);
  expect(next.checklist).toEqual(inspection.checklist);
  expect(next.requestIds).toHaveLength(0);
  expect((await admin.api.property.getInspection({ params: { orgId, inspectionId: inspection.id } })).status).toBe(
    "completed",
  );
  await refused(
    admin.api.property.scheduleInspection({
      params: { orgId },
      body: {
        propertyId,
        kind: "routine",
        scheduledDate: "2026-11-06",
        followUpOf: next.id,
        followUpReason: "Cannot follow up an unfinished visit",
      },
    }),
    409,
  );
});
it("rejects unsupported dates and keeps full long findings while repair titles remain editable", async () => {
  await refused(
    admin.api.property.scheduleInspection({
      params: { orgId },
      body: { propertyId, kind: "routine", scheduledDate: "0000-01-01" },
    }),
    400,
  );
  const x = await admin.api.property.scheduleInspection({
      params: { orgId },
      body: { propertyId, kind: "routine", scheduledDate: "2026-11-01" },
    }),
    note = "Detailed finding ".repeat(30).slice(0, 500);
  const done = await admin.api.property.completeInspection({
    params: { orgId, inspectionId: x.id },
    body: { items: [{ area: "Equipment room", condition: "damaged", note }] },
  });
  expect(done.items[0]?.note).toBe(note);
  const request = await admin.api.property.getMaintenanceRequest({
    params: { orgId, requestId: done.requestIds[0] ?? "missing" },
  });
  expect(request.title.length).toBeLessThanOrEqual(200);
});
it("isolates organisations, properties and roles, including revoked access", async () => {
  const other = await pmOrg(S),
    viewer = await S.addMember(orgId, admin.api, "viewer"),
    b = await setUpBuilding(orgId, admin, { name: "Different building" });
  await refused(other.admin.api.property.getInspection({ params: { orgId, inspectionId: inspection.id } }), 404);
  await refused(
    viewer.api.property.createInspectionTemplate({
      params: { orgId },
      body: { propertyId, name: "Forbidden", areas: ["Hall"] },
    }),
    403,
  );
  await refused(
    manager.api.property.listInspectionTemplates({ params: { orgId }, query: { propertyId: b.propertyId } }),
    404,
  );
  await refused(
    admin.api.property.scheduleInspection({
      params: { orgId },
      body: { propertyId: b.propertyId, kind: "routine", scheduledDate: "2026-11-01", templateId: template.id },
    }),
    400,
  );
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
  ]);
  await refused(
    manager.api.property.getInspectionTemplate({ params: { orgId, inspectionTemplateId: template.id } }),
    404,
  );
  await refused(manager.api.property.inspectionHistory({ params: { orgId, inspectionId: inspection.id } }), 404);
});
