// A contact's other phone numbers and e-mail addresses are their own fields (migration 0018), not tags: kept once
// each, never repeating the main one, replaced as a whole list, kept when a patch leaves them out, joined on merge,
// checked like the main ones, and another organisation cannot touch them.
import { API } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("contacts: other phone numbers and e-mail addresses", () => {
  let S: TestServer;
  let a: Account;
  let other: Account;
  beforeAll(async () => {
    S = await signupServer();
    a = await signUpAndIn(S, "property");
    other = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  it("a patch without them does not clear them", () => {
    expect(API.contacts.updateContact.body.parse({ notes: "x" })).toEqual({ notes: "x" });
  });

  it("keeps them as fields: each once, never the main one again, and no tags are used", async () => {
    const { contact } = await a.api.contacts.createContact({
      params: { orgId: a.orgId },
      body: {
        name: "Juma Baraka",
        email: "juma@baobab.test",
        phone: "+254 722 410 001",
        otherPhones: ["+254 733 410 002", "0722 410 001", "+254 744 410 003", "0733 410 002"],
        otherEmails: ["Juma.Work@Baobab.test", "juma@baobab.test"],
        tags: ["vip"],
        types: ["tenant"],
      },
    });
    expect(contact.otherPhones).toEqual(["+254 733 410 002", "+254 744 410 003"]);
    expect(contact.otherEmails).toEqual(["juma.work@baobab.test"]);
    expect(contact.tags).toEqual(["vip"]);
    const row = (await S.sql("SELECT other_phones, other_emails, tags FROM contacts WHERE id = $1", [contact.id]))[0];
    expect(row).toEqual({
      other_phones: ["+254 733 410 002", "+254 744 410 003"],
      other_emails: ["juma.work@baobab.test"],
      tags: ["vip"],
    });

    const P = { orgId: a.orgId, contactId: contact.id };
    // a patch that leaves them out keeps them
    expect(await a.api.contacts.updateContact({ params: P, body: { notes: "Prefers calls" } })).toMatchObject({
      otherPhones: ["+254 733 410 002", "+254 744 410 003"],
      otherEmails: ["juma.work@baobab.test"],
    });
    // the list given replaces the list kept; the new main number leaves the others
    const changed = await a.api.contacts.updateContact({
      params: P,
      body: { phone: "+254 744 410 003", otherPhones: ["+254 744 410 003", "+254 755 410 004"], otherEmails: [] },
    });
    expect(changed).toMatchObject({ phone: "+254 744 410 003", otherPhones: ["+254 755 410 004"], otherEmails: [] });
    // they are checked like the main ones
    await refused(a.api.contacts.updateContact({ params: P, body: { otherPhones: ["call me"] } }), 400);
    await refused(a.api.contacts.updateContact({ params: P, body: { otherEmails: ["not-an-email"] } }), 400);
    // another organisation can neither read nor change them
    await refused(other.api.contacts.updateContact({ params: P, body: { otherPhones: [] } }), 404);
    await refused(other.api.contacts.getContact({ params: P }), 404);
    expect((await a.api.contacts.getContact({ params: P })).contact.otherPhones).toEqual(["+254 755 410 004"]);
  });

  it("merging keeps every number and address of both contacts", async () => {
    const O = { orgId: a.orgId };
    const keep = await a.api.contacts.createContact({
      params: O,
      body: { name: "Neema Otieno", email: "neema@kilele.test", otherPhones: ["+254 711 500 001"] },
    });
    const drop = await a.api.contacts.createContact({
      params: O,
      body: {
        name: "N. Otieno",
        email: "n.otieno@kilele.test",
        phone: "+254 711 500 002",
        otherEmails: ["neema.home@kilele.test"],
      },
    });
    const merged = await a.api.contacts.mergeContacts({
      params: { ...O, contactId: keep.contact.id },
      body: { mergeId: drop.contact.id, reason: "Same person, two records" },
    });
    expect(merged.contact).toMatchObject({
      email: "neema@kilele.test",
      phone: "+254 711 500 002",
      otherPhones: ["+254 711 500 001"],
      otherEmails: ["n.otieno@kilele.test", "neema.home@kilele.test"],
    });
  });
});
