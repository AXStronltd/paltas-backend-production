import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("manager unit inventory editing", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-22");
  });
  afterAll(() => S.close());
  it("keeps external apartments in the same block total and removes/restores without recreating IDs", async () => {
    const { orgId, staff } = await pmOrg(S);
    const pm = staff.property_manager;
    const b = await setUpBuilding(orgId, pm, { units: ["0804 W", "0805 W", "0806 W"] });
    let current = await pm.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } });
    const original = current.units.find((u) => u.id === b.units["0804 W"])!;
    await pm.api.property.updateUnit({
      params: { orgId, unitId: original.id },
      body: { unitNo: "804 W", floor: "External" },
    });
    current = await pm.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } });
    expect(current.property.unitCount).toBe(3);
    expect(current.units.find((u) => u.id === original.id)).toMatchObject({
      unitNo: "804 W",
      buildingId: original.buildingId,
      floor: "External",
    });
    await refused(
      staff.viewer.api.property.updateUnit({ params: { orgId, unitId: original.id }, body: { archive: true } }),
      403,
    );
    const other = await pmOrg(S);
    await refused(
      other.staff.property_manager.api.property.updateUnit({
        params: { orgId: other.orgId, unitId: original.id },
        body: { archive: true },
      }),
      404,
    );
    await pm.api.property.updateUnit({ params: { orgId, unitId: original.id }, body: { archive: true } });
    current = await pm.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } });
    expect(current.property.unitCount).toBe(2);
    expect(current.units).toHaveLength(3);
    const removed = current.units.find((u) => u.id === original.id)!;
    expect(current.property.buildings.find((x) => x.id === removed.buildingId)?.isArchived).toBe(true);
    const blocks = current.property.buildings.length;
    await pm.api.property.updateUnit({ params: { orgId, unitId: original.id }, body: { archive: true } });
    expect(
      (await pm.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } })).property.buildings,
    ).toHaveLength(blocks);
    await pm.api.property.updateUnit({
      params: { orgId, unitId: original.id },
      body: { buildingId: original.buildingId!, floor: "External" },
    });
    current = await pm.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } });
    expect(current.property.unitCount).toBe(3);
    expect(current.units.find((u) => u.id === original.id)?.unitNo).toBe("804 W");
    const tenantId = await newTenant(pm, orgId, "Synthetic resident");
    const lease = await pm.api.property.createLease({
      params: { orgId },
      body: {
        unitId: original.id,
        tenantId,
        startDate: "2026-10-01",
        rentMinor: 100000,
        depositMode: "none",
        depositMinor: 0,
        dueDay: 5,
      },
    });
    await refused(pm.api.property.updateUnit({ params: { orgId, unitId: original.id }, body: { archive: true } }), 409);
    const active = await pm.api.property.activateLease({
      params: { orgId, leaseId: lease.id },
      body: { signedOn: "2026-10-01", billFirstRent: true },
    });
    await refused(pm.api.property.updateUnit({ params: { orgId, unitId: original.id }, body: { archive: true } }), 409);
    await pm.api.property.terminateLease({
      params: { orgId, leaseId: lease.id },
      body: { moveOutDate: "2026-10-22", reason: "Synthetic move-out" },
    });
    await pm.api.property.updateUnit({ params: { orgId, unitId: original.id }, body: { archive: true } });
    const history = await pm.api.property.listInvoices({ params: { orgId }, query: { propertyId: b.propertyId } });
    expect(history.invoices.find((x) => x.id === active.firstRentInvoice!.id)?.unitId).toBe(original.id);
    current = await pm.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } });
    expect(current.property.unitCount).toBe(2);
    expect(current.units).toHaveLength(3);
  });
});
