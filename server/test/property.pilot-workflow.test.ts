import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("property setup client workflow against PostgreSQL", () => {
  let S: TestServer;
  let owner: Account;
  let other: Account;
  beforeAll(async () => {
    S = await signupServer();
    owner = await signUpAndIn(S, "property");
    other = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  it("saves a property and unit, reloads after a fresh login, and isolates company records", async () => {
    const base = "/api/v1/orgs/" + owner.orgId + "/property/properties";
    const created = await S.raw(
      "POST",
      base,
      { name: "Client building", address: "Nairobi", kind: "residential" },
      owner.token,
    );
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const detail = base + "/" + id;
    expect(
      (
        await S.raw(
          "POST",
          detail + "/units",
          { units: [{ unitNo: "A-101", unitType: "Apartment", floor: "1", status: "available" }] },
          owner.token,
        )
      ).status,
    ).toBe(201);
    await owner.api.identity.logout();
    const fresh = await S.login(owner.email, owner.password);
    const list = await S.raw("GET", base, undefined, fresh.token);
    expect(list.status).toBe(200);
    expect(list.body.properties).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, name: "Client building", unitCount: 1 })]),
    );
    const records = await S.raw("GET", detail, undefined, fresh.token);
    expect(records.status).toBe(200);
    expect(records.body.units).toEqual(
      expect.arrayContaining([expect.objectContaining({ unitNo: "A-101", occupancy: "vacant" })]),
    );
    expect((await S.raw("GET", detail, undefined, other.token)).status).toBe(404);
    const ownList = await S.raw("GET", "/api/v1/orgs/" + other.orgId + "/property/properties", undefined, other.token);
    expect(ownList.body.properties).toEqual([]);
    expect((await S.raw("GET", detail)).status).toBe(401);
  });
});
