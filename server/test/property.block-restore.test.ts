import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("client-controlled block restoration", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startPropertyServer();
  });
  afterAll(() => S.close());
  it("restores existing IDs and inventory once, without posting financial records", async () => {
    const { orgId, admin, staff } = await pmOrg(S);
    const b = await setUpBuilding(orgId, staff.property_manager, { units: ["101 W", "102 W"] });
    const first = await admin.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } });
    const block = first.property.buildings[0]!;
    const before = await S.sql("SELECT * FROM pm_units WHERE property_id=$1 ORDER BY id", [b.propertyId]);
    const journalCount = (await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n;
    await admin.api.property.deleteBuilding({ params: { orgId, buildingId: block.id } });
    expect(
      (await admin.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } })).property.unitCount,
    ).toBe(0);
    const body = { confirmName: block.name, reason: "Restore a mistakenly archived block" };
    const replies = await Promise.all([
      admin.api.property.restoreBuilding({ params: { orgId, buildingId: block.id }, body }),
      admin.api.property.restoreBuilding({ params: { orgId, buildingId: block.id }, body }),
    ]);
    expect(replies.every((x) => x.id === block.id && !x.isArchived)).toBe(true);
    expect(
      (await admin.api.property.getProperty({ params: { orgId, propertyId: b.propertyId } })).property.unitCount,
    ).toBe(2);
    expect(await S.sql("SELECT * FROM pm_units WHERE property_id=$1 ORDER BY id", [b.propertyId])).toEqual(before);
    expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n).toBe(
      journalCount,
    );
    expect(await S.sql("SELECT * FROM audit_log WHERE target=$1 AND action='Block restored'", [block.id])).toHaveLength(
      1,
    );
    await admin.api.property.deleteBuilding({ params: { orgId, buildingId: block.id } });
    expect(
      (await admin.api.property.restoreBuilding({ params: { orgId, buildingId: block.id }, body })).isArchived,
    ).toBe(false);
    expect(await S.sql("SELECT * FROM audit_log WHERE target=$1 AND action='Block restored'", [block.id])).toHaveLength(
      2,
    );
  });
  it("requires a reason, exact confirmation and server-side organisation/role/property authority", async () => {
    const { orgId, admin, staff } = await pmOrg(S),
      other = await pmOrg(S);
    const b = await setUpBuilding(orgId, admin, { name: "Assigned property" });
    const second = await setUpBuilding(orgId, admin, { name: "Other property" });
    const get = async (id: string) =>
      (await admin.api.property.getProperty({ params: { orgId, propertyId: id } })).property.buildings[0]!;
    const block = await get(b.propertyId),
      outside = await get(second.propertyId);
    await admin.api.property.deleteBuilding({ params: { orgId, buildingId: block.id } });
    await admin.api.property.deleteBuilding({ params: { orgId, buildingId: outside.id } });
    const url = `/api/v1/orgs/${orgId}/property/buildings/${block.id}/restore`,
      body = { confirmName: block.name, reason: "Reviewed inventory restoration" };
    expect((await S.raw("POST", url, { ...body, reason: "" }, admin.token)).status).toBe(400);
    expect((await S.raw("POST", url, { ...body, confirmName: "Wrong name" }, admin.token)).status).toBe(400);
    expect((await S.raw("POST", url, body, other.admin.token)).status).toBe(404);
    expect((await S.raw("POST", url, body, staff.viewer.token)).status).toBe(403);
    const manager = await S.addMember(orgId, admin.api, "main_manager");
    await admin.api.organisations.setManagerGrants({
      params: { orgId, userId: manager.userId },
      body: {
        grants: [
          {
            product: "property",
            capabilities: ["property.setup", "property.read"],
            propertyIds: [b.propertyId],
            enabled: true,
          },
        ],
        reason: "Delegate assigned inventory management",
        confirm: "SAVE_PERMISSIONS",
      },
    });
    expect(
      (
        await S.raw(
          "POST",
          `/api/v1/orgs/${orgId}/property/buildings/${outside.id}/restore`,
          { ...body, confirmName: outside.name },
          manager.token,
        )
      ).status,
    ).toBe(404);
    expect((await S.raw("POST", url, body, manager.token)).status).toBe(200);
    expect((await get(second.propertyId)).isArchived).toBe(true);
  });
});
