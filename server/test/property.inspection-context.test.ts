import { beforeAll, afterAll, it, expect } from "vitest";
import { pmOrg, setUpBuilding, startPropertyServer, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer, orgId: string, admin: Person, propertyId: string, unitId: string, otherUnit: string, leaseId: string;
beforeAll(async () => {
  S = await startPropertyServer();
  ({ orgId, admin } = await pmOrg(S));
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  unitId = b.units["A-101"]!;
  otherUnit = b.units["A-102"]!;
  const tenantId = await newTenant(admin, orgId, "Inspection Resident");
  leaseId = (
    await admin.api.property.createLease({
      params: { orgId },
      body: { unitId, tenantId, startDate: "2026-10-01", rentMinor: 100000 },
    })
  ).id;
});
afterAll(() => S.close());
it("rejects a lease paired with another unit and preserves the supplied lease unit", async () => {
  const body = { propertyId, leaseId, kind: "move_in" as const, scheduledDate: "2026-10-26" };
  await refused(
    admin.api.property.scheduleInspection({ params: { orgId }, body: { ...body, unitId: otherUnit } }),
    400,
  );
  const i = await admin.api.property.scheduleInspection({ params: { orgId }, body });
  expect(i.unitId).toBe(unitId);
  expect(i.leaseId).toBe(leaseId);
});
it("retains completion findings and creates each corrective request only once", async () => {
  const i = await admin.api.property.scheduleInspection({
      params: { orgId },
      body: { propertyId, unitId, kind: "move_out", scheduledDate: "2026-10-26" },
    }),
    items = [{ area: "Kitchen", condition: "needs_repair" as const, note: "Tap leaking" }];
  const outcomes = await Promise.allSettled([
    admin.api.property.completeInspection({ params: { orgId, inspectionId: i.id }, body: { items } }),
    admin.api.property.completeInspection({ params: { orgId, inspectionId: i.id }, body: { items } }),
  ]);
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(await S.sql("SELECT id FROM pm_maintenance_requests WHERE inspection_id=$1", [i.id])).toHaveLength(1);
  expect(
    (
      await S.sql("SELECT after FROM audit_log WHERE org_id=$1 AND target=$2 AND action='Inspection completed'", [
        orgId,
        i.number,
      ])
    )[0]?.after,
  ).toHaveProperty("items", items);
});
