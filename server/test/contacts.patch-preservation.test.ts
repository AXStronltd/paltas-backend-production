import { API } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("contact partial updates preserve omitted classifications", () => {
  let S: TestServer;
  let owner: Account;
  let other: Account;
  beforeAll(async () => {
    S = await signupServer();
    owner = await signUpAndIn(S, "property");
    other = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  it("does not inject create defaults into an empty or portal-link patch", () => {
    expect(API.contacts.updateContact.body.parse({})).toEqual({});
    expect(API.contacts.updateContact.body.parse({ userId: null })).toEqual({ userId: null });
  });

  it("keeps company type, contact roles and tags when only notes or portal linking change", async () => {
    const base = "/api/v1/orgs/" + owner.orgId + "/contacts";
    const created = await S.raw(
      "POST",
      base,
      {
        name: "Managed owner company",
        email: "owner@patch.test",
        partyType: "company",
        types: ["owner", "tenant"],
        tags: ["managed", "priority"],
      },
      owner.token,
    );
    expect(created.status).toBe(201);
    const path = base + "/" + created.body.contact.id;
    const updated = await S.raw("PUT", path, { notes: "Updated note", userId: null }, owner.token);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      partyType: "company",
      notes: "Updated note",
      types: ["owner", "tenant"],
      tags: ["managed", "priority"],
    });
    expect((await S.raw("PUT", path, { notes: "Other company write" }, other.token)).status).toBe(404);
    const cleared = await S.raw("PUT", path, { types: [], tags: [] }, owner.token);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ partyType: "company", types: [], tags: [], notes: "Updated note" });
  });
  it("clears explicitly removed optional details while retaining identity, roles and history", async () => {
    const base = "/api/v1/orgs/" + owner.orgId + "/contacts";
    const created = await S.raw(
      "POST",
      base,
      {
        name: "Correctable tenant",
        email: "correctable@patch.test",
        phone: "+254700123987",
        address: "Old address",
        taxId: "Old reference",
        types: ["tenant"],
        tags: ["retained"],
      },
      owner.token,
    );
    expect(created.status).toBe(201);
    const path = base + "/" + created.body.contact.id;
    expect(
      (await S.raw("POST", path + "/activities", { kind: "note", text: "Retained contact history" }, owner.token))
        .status,
    ).toBe(201);
    const cleared = await S.raw("PUT", path, { email: null, phone: null, address: null, taxId: null }, owner.token);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      name: "Correctable tenant",
      email: null,
      phone: null,
      address: null,
      taxId: null,
      types: ["tenant"],
      tags: ["retained"],
    });
    const reopened = await S.raw("GET", path, undefined, owner.token);
    expect(reopened.body.contact).toMatchObject({ email: null, phone: null, address: null, taxId: null });
    expect(reopened.body.activities).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Retained contact history" })]),
    );
    const updated = await S.raw(
      "PUT",
      path,
      { email: "corrected@patch.test", phone: "+254700123986", address: "New address", taxId: "New reference" },
      owner.token,
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      email: "corrected@patch.test",
      address: "New address",
      taxId: "New reference",
    });
    expect((await S.raw("PUT", path, { email: "invalid" }, owner.token)).status).toBe(400);
    expect((await S.raw("PUT", path, { phone: null }, other.token)).status).toBe(404);
  });
});
