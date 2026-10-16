import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("custom blocks and safe archiving", () => {
  let S: TestServer, owner: Account, other: Account;
  let base: string, propertyId: string;
  beforeAll(async () => {
    S = await signupServer();
    owner = await signUpAndIn(S, "property");
    other = await signUpAndIn(S, "property");
    base = `/api/v1/orgs/${owner.orgId}/property`;
    const p = await S.raw("POST", base + "/properties", { name: "Almas Tower" }, owner.token);
    expect(p.status).toBe(201);
    propertyId = p.body.id;
  });
  afterAll(() => S.close());
  async function post(path: string, body: unknown) {
    const r = await S.raw("POST", base + path, body, owner.token);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  }
  const block = async (name: string) => post(`/properties/${propertyId}/buildings`, { name });

  it("renames custom blocks, validates names and enforces company isolation", async () => {
    const b = await block("West Wing");
    const url = base + "/buildings/" + b.id;
    expect((await S.raw("PUT", url, { name: "  " }, owner.token)).status).toBe(400);
    expect((await S.raw("PUT", url, { name: "Block A" }, other.token)).status).toBe(404);
    expect((await S.raw("DELETE", url, undefined, other.token)).status).toBe(404);
    const r = await S.raw("PUT", url, { name: " Block A " }, owner.token);
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Block A");
    const d = await S.raw("DELETE", url, undefined, owner.token);
    expect(d.body.action).toBe("deleted");
    expect(await S.sql("SELECT 1 FROM pm_buildings WHERE id=$1", [b.id])).toHaveLength(0);
  });

  it("refuses active leases, preserves overridden rent and payments after terminating and archiving", async () => {
    const b = await block("North Tower");
    const { units } = await post(`/properties/${propertyId}/units`, {
      units: [
        {
          unitNo: "N-101",
          buildingId: b.id,
          floor: "1",
          unitType: "Apartment",
          bedrooms: 2,
          toilets: 2,
          areaSqm: 85,
          marketRentMinor: 14000000,
        },
      ],
    });
    expect(units[0]).toMatchObject({ buildingId: b.id, floor: "1", toilets: 2, areaSqm: 85 });
    const contact = async (name: string, types: string[]) => {
      const r = await S.raw("POST", `/api/v1/orgs/${owner.orgId}/contacts`, { name, types }, owner.token);
      expect(r.status).toBe(201);
      return r.body.contact.id;
    };
    const tenantId = await contact("Almas tenant", ["tenant"]),
      ownerId = await contact("Almas owner", ["owner"]),
      today = S.app.clock.today();
    await post("/agreements", { propertyId, ownerId, feePct: 10, authorityMinor: 0, startDate: today });
    for (const location of [{ buildingId: "wrong-block" }, { floor: "99" }]) {
      const mismatch = await S.raw(
        "POST",
        base + "/leases",
        { unitId: units[0].id, tenantId, startDate: today, rentMinor: 1200000, ...location },
        owner.token,
      );
      expect(mismatch.status).toBe(400);
    }
    const lease = await post("/leases", {
      unitId: units[0].id,
      tenantId,
      startDate: today,
      rentMinor: 1200000,
      depositMinor: 0,
      depositMode: "none",
    });
    expect((await S.raw("POST", base + `/leases/${lease.id}/activate`, { signedOn: today }, owner.token)).status).toBe(
      200,
    );
    const denied = await S.raw("DELETE", base + "/buildings/" + b.id, undefined, owner.token);
    expect(denied.status).toBe(400);
    await expect(S.sql("UPDATE pm_buildings SET is_archived=true WHERE id=$1", [b.id])).rejects.toThrow(
      /active leases/,
    );
    expect(denied.body.error.message).toBe(
      "Cannot delete this block. It currently has 1 active leases. Please terminate all leases first.",
    );
    await post("/billing-runs", { propertyId, period: today.slice(0, 7), kind: "rent" });
    const payment = await post("/payments", {
      tenantId,
      date: today,
      amountMinor: 1200000,
      method: "bank_transfer",
      reference: "ALMAS-12000",
    });
    expect(
      (
        await S.raw(
          "POST",
          base + `/leases/${lease.id}/terminate`,
          { moveOutDate: today, reason: "Tenant moved out" },
          owner.token,
        )
      ).status,
    ).toBe(200);
    const archived = await S.raw("DELETE", base + "/buildings/" + b.id, undefined, owner.token);
    expect(archived.body.action).toBe("archived");
    const p = await S.raw("GET", base + "/properties/" + propertyId, undefined, owner.token);
    expect(p.body.property.buildings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: b.id, isArchived: true, unitCount: 1 })]),
    );
    expect(p.body.units.find((u: { id: string }) => u.id === units[0].id).marketRentMinor).toBe(14000000);
    const detail = await S.raw("GET", base + "/leases/" + lease.id, undefined, owner.token);
    expect(detail.body.lease.rentMinor).toBe(1200000);
    const payments = await S.raw("GET", base + "/payments", undefined, owner.token);
    expect(payments.body.payments.some((p: { id: string }) => p.id === payment.id)).toBe(true);
    expect(
      (
        await S.raw(
          "POST",
          base + `/properties/${propertyId}/units`,
          { units: [{ unitNo: "N-102", buildingId: b.id }] },
          owner.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await S.raw(
          "POST",
          base + "/leases",
          { unitId: units[0].id, tenantId, startDate: today, rentMinor: 1200000 },
          owner.token,
        )
      ).status,
    ).toBe(400);
  });

  it("archives blocks with units even if they have no leases", async () => {
    const b = await block("South Wing");
    await post(`/properties/${propertyId}/units`, {
      units: [{ unitNo: "S-1", buildingId: b.id, status: "off_market" }],
    });
    const [unit] = await S.sql("SELECT id FROM pm_units WHERE building_id=$1", [b.id]);
    const update = await S.raw("PUT", base + "/units/" + unit.id, { toilets: 1 }, owner.token);
    expect(update.status).toBe(200);
    expect(update.body.toilets).toBe(1);
    expect(update.body.status).toBe("off_market");
    const r = await S.raw("DELETE", base + "/buildings/" + b.id, undefined, owner.token);
    expect(r.body.action).toBe("archived");
    expect((await S.sql("SELECT is_archived FROM pm_buildings WHERE id=$1", [b.id]))[0].is_archived).toBe(true);
  });
  it("serializes archive against concurrent lease activation", async () => {
    const b = await block("Race test wing");
    const { units } = await post(`/properties/${propertyId}/units`, { units: [{ unitNo: "R-1", buildingId: b.id }] });
    const ct = await S.raw(
      "POST",
      `/api/v1/orgs/${owner.orgId}/contacts`,
      { name: "Race tenant", types: ["tenant"] },
      owner.token,
    );
    const today = S.app.clock.today();
    const lease = await post("/leases", {
      tenantId: ct.body.contact.id,
      unitId: units[0].id,
      startDate: today,
      rentMinor: 1200000,
      depositMinor: 0,
      depositMode: "none",
    });
    const c = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
    await c.connect();
    let request: ReturnType<typeof S.raw> | undefined;
    try {
      await c.query("BEGIN");
      await c.query("UPDATE pm_buildings SET is_archived=true WHERE id=$1", [b.id]);
      request = S.raw("POST", base + `/leases/${lease.id}/activate`, { signedOn: today }, owner.token);
      // The archive is not visible until commit. Activation must wait for the block's lock.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await c.query("COMMIT");
      const r = await request;
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/archived/);
      expect((await S.sql("SELECT status FROM pm_leases WHERE id=$1", [lease.id]))[0].status).toBe("draft");
    } finally {
      await c.query("ROLLBACK");
      await c.end();
      await request;
    }
  });
});
