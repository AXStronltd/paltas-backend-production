// The ONE contact store: dedupe by email and phone, consent per channel, messages recorded (never sent) and handed to
// the notifications outbox, merging that moves every product's records, portal sign-ins, isolation and roles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, setUpBuilding, startPropertyServer, type PmStaff } from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("contacts: one shared store for every product", () => {
  let S: TestServer;
  let orgId: string;
  let otherOrg: string;
  let st: PmStaff;
  let pm: Person;
  let admin: Person;
  const O = () => ({ orgId });

  beforeAll(async () => {
    S = await startPropertyServer();
    const o = await pmOrg(S);
    orgId = o.orgId;
    st = o.staff;
    pm = st.property_manager;
    admin = o.admin;
    otherOrg = (await S.newOrg({ product: "property", plan: "PM-GROWTH", trial: false })).orgId;
  });
  afterAll(() => S.close());

  it("finds duplicates by email (any case) and by phone (last 9 digits), and refuses them unless reused", async () => {
    const a = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Mary Atieno", email: "Mary.Atieno@example.com", phone: "0712 401 101", types: ["prospect"] },
    });
    expect(a.reused).toBe(false);
    const byEmail = await refused(
      pm.api.contacts.createContact({ params: O(), body: { name: "M Atieno", email: "mary.atieno@EXAMPLE.com" } }),
      409,
      "CONFLICT",
    );
    expect(byEmail.details.duplicates[0].id).toBe(a.contact.id);
    await refused(
      pm.api.contacts.createContact({ params: O(), body: { name: "Mary A", phone: "+254 712 401 101" } }),
      409,
    );
    const reused = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Mary A", phone: "+254712401101", types: ["tenant"], reuseExisting: true },
    });
    expect(reused.reused).toBe(true);
    expect(reused.contact.id).toBe(a.contact.id);
    expect(reused.contact.types.sort()).toEqual(["prospect", "tenant"]);
    // changing a contact onto someone else's email is refused too
    const b = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Samuel Kiptoo", email: "samuel@example.com" },
    });
    await refused(
      pm.api.contacts.updateContact({
        params: { orgId, contactId: b.contact.id },
        body: { email: "mary.atieno@example.com" },
      }),
      409,
    );
    const listed = await pm.api.contacts.listContacts({ params: O(), query: { type: "tenant" } });
    expect(listed.contacts.map((c) => c.id)).toEqual([a.contact.id]);
  });

  it("records messages: blocked without consent, recorded and handed to the outbox with consent — never sent", async () => {
    const c = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Grace Njoki", email: "grace.njoki@example.com", phone: "0712 401 107" },
    });
    const id = c.contact.id;
    const blocked = await pm.api.contacts.recordMessage({
      params: { orgId, contactId: id },
      body: { channel: "email", subject: "Rent", body: "Your invoice is ready" },
    });
    expect(blocked).toMatchObject({ status: "blocked", reason: "No consent to contact by email", outboxId: null });
    await pm.api.contacts.updateContact({
      params: { orgId, contactId: id },
      body: { consent: { email: true, source: "Signed lease, clause 14" } },
    });
    const ok = await pm.api.contacts.recordMessage({
      params: { orgId, contactId: id },
      body: { channel: "email", subject: "Rent", body: "Your invoice is ready", idempotencyKey: "inv-ready-1" },
    });
    expect(ok.status).toBe("recorded");
    expect(ok.status).not.toBe("sent");
    expect(ok.reason).toMatch(/not sent/);
    const again = await pm.api.contacts.recordMessage({
      params: { orgId, contactId: id },
      body: { channel: "email", subject: "Rent", body: "Your invoice is ready", idempotencyKey: "inv-ready-1" },
    });
    expect(again.id).toBe(ok.id);
    // handed to the one notifications outbox (which alone talks to providers), not sent
    expect(ok.outboxId).toBeTruthy();
    const [n] = await S.sql<{ status: string; source: string; source_ref: string }>(
      "SELECT status, source, source_ref FROM notifications WHERE id = $1",
      [ok.outboxId],
    );
    expect(n).toMatchObject({ source: "contacts", source_ref: ok.id });
    expect(n!.status).not.toBe("sent");
    const marketing = await pm.api.contacts.recordMessage({
      params: { orgId, contactId: id },
      body: { channel: "email", body: "New units available", marketing: true },
    });
    expect(marketing).toMatchObject({ status: "blocked", reason: "No marketing consent" });
    const sms = await pm.api.contacts.recordMessage({
      params: { orgId, contactId: id },
      body: { channel: "sms", body: "Hi" },
    });
    expect(sms.status).toBe("blocked");
    const detail = await pm.api.contacts.getContact({ params: { orgId, contactId: id } });
    expect(detail.messages.map((m) => m.status).sort()).toEqual(["blocked", "blocked", "blocked", "recorded"]);
    expect(detail.contact.consent).toMatchObject({ email: true, source: "Signed lease, clause 14" });
  });

  it("merges two contacts: every record pointing at the merged one moves (PM leases, requests), nothing is deleted", async () => {
    const B = await setUpBuilding(orgId, pm, { units: ["M-1"] });
    const keep = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Halima Abdi", email: "halima@example.com", consent: { email: true, sms: true, source: "Form" } },
    });
    const dup = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "H. Abdi", phone: "0712 401 105", consent: { email: true, sms: false, source: "Call" } },
    });
    const lease = await pm.api.property.createLease({
      params: O(),
      body: { unitId: B.units["M-1"]!, tenantId: dup.contact.id, startDate: "2026-10-01", rentMinor: 6_000_000 },
    });
    await pm.api.property.createRequest({
      params: O(),
      body: { propertyId: B.propertyId, unitId: B.units["M-1"]!, reporterId: dup.contact.id, title: "Leaking tap" },
    });
    await refused(
      st.leasing_agent.api.contacts.mergeContacts({
        params: { orgId, contactId: keep.contact.id },
        body: { mergeId: dup.contact.id, reason: "Same person, two records" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const merged = await pm.api.contacts.mergeContacts({
      params: { orgId, contactId: keep.contact.id },
      body: { mergeId: dup.contact.id, reason: "Same person, two records" },
    });
    expect(merged.moved).toBeGreaterThanOrEqual(2);
    expect(merged.contact).toMatchObject({ phone: "0712 401 105", email: "halima@example.com" });
    // consent: the stricter of the two
    expect(merged.contact.consent).toMatchObject({ email: true, sms: false });
    expect(merged.contact.types).toContain("tenant");
    const l = await pm.api.property.getLease({ params: { orgId, leaseId: lease.id } });
    expect(l.lease.tenantId).toBe(keep.contact.id);
    const old = await pm.api.contacts.getContact({ params: { orgId, contactId: dup.contact.id } });
    expect(old.contact.mergedInto).toBe(keep.contact.id);
    // the merged record can no longer be used
    await refused(
      pm.api.contacts.updateContact({ params: { orgId, contactId: dup.contact.id }, body: { notes: "x" } }),
      409,
    );
    const hidden = await pm.api.contacts.listContacts({ params: O(), query: { q: "Abdi" } });
    expect(hidden.contacts.map((c) => c.id)).toEqual([keep.contact.id]);
    const keptActivity = await pm.api.contacts.getContact({ params: { orgId, contactId: keep.contact.id } });
    expect(keptActivity.activities.some((a) => a.kind === "system" && /Merged/.test(a.text))).toBe(true);
    expect(keptActivity.activities.some((a) => a.kind === "lease")).toBe(true);
  });

  it("lists duplicate groups for review", async () => {
    await pm.api.contacts.createContact({ params: O(), body: { name: "Otieno Omondi", email: "otieno@example.com" } });
    await S.sql(
      "INSERT INTO contacts (id, org_id, name, email) VALUES ('con_dup_test', $1, 'O. Omondi', 'OTIENO@example.com')",
      [orgId],
    );
    const { groups } = await pm.api.contacts.listDuplicates({ params: O() });
    expect(
      groups.some(
        (g) =>
          g
            .map((c) => c.name)
            .sort()
            .join("|") === "O. Omondi|Otieno Omondi",
      ),
    ).toBe(true);
  });

  it("links a portal sign-in only to a member with the tenant or owner role", async () => {
    const tenantUser = await S.addMember(orgId, admin.api, "tenant");
    const c = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Lucy Wambui", email: "lucy@example.com" },
    });
    await refused(
      pm.api.contacts.updateContact({ params: { orgId, contactId: c.contact.id }, body: { userId: pm.userId } }),
      400,
    );
    const linked = await pm.api.contacts.updateContact({
      params: { orgId, contactId: c.contact.id },
      body: { userId: tenantUser.userId },
    });
    expect(linked.userId).toBe(tenantUser.userId);
    // the tenant role sees nothing of the contact list
    await refused(tenantUser.api.contacts.listContacts({ params: O(), query: {} }), 403, "ROLE_NOT_ALLOWED");
  });

  it("isolates organisations and enforces roles", async () => {
    const c = await pm.api.contacts.createContact({
      params: O(),
      body: { name: "Daniel Kariuki", email: "dk@example.com" },
    });
    const outsider = await S.newOrg({ product: "property", plan: "PM-GROWTH", trial: false });
    // another organisation's contact is "not found", whoever asks
    await refused(
      outsider.admin.api.contacts.getContact({ params: { orgId: outsider.orgId, contactId: c.contact.id } }),
      404,
    );
    await refused(pm.api.contacts.getContact({ params: { orgId: otherOrg, contactId: c.contact.id } }), 404);
    const mine = await outsider.admin.api.contacts.createContact({
      params: { orgId: outsider.orgId },
      body: { name: "Their own", email: "own@example.com" },
    });
    await refused(
      outsider.admin.api.contacts.mergeContacts({
        params: { orgId: outsider.orgId, contactId: mine.contact.id },
        body: { mergeId: c.contact.id, reason: "Trying to reach across" },
      }),
      404,
    );
    await refused(st.viewer.api.contacts.listContacts({ params: O(), query: {} }), 403, "ROLE_NOT_ALLOWED");
    await st.front_desk.api.contacts.listContacts({ params: O(), query: {} });
    await refused(
      st.front_desk.api.contacts.createContact({ params: O(), body: { name: "Walk In", email: "walkin@example.com" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      st.auditor.api.contacts.addActivity({
        params: { orgId, contactId: c.contact.id },
        body: { kind: "note", text: "Hello" },
      }),
      403,
    );
    const note = await pm.api.contacts.addActivity({
      params: { orgId, contactId: c.contact.id },
      body: { kind: "call", text: "Called about the viewing" },
    });
    expect(note.kind).toBe("call");
  });
});
