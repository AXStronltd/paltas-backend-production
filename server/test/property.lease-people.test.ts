import { afterAll, beforeAll, it, expect } from "vitest";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  manager: Person,
  leaseId: string,
  propertyId: string,
  tenantId: string,
  contactId: string,
  person: P.LeasePerson;
const fields = {
  kind: "occupant" as const,
  relationship: "Sibling",
  note: "Household record only",
  startDate: "2026-10-01",
  endDate: null,
};
beforeAll(async () => {
  S = await startPropertyServer();
  ({ orgId, admin } = await pmOrg(S));
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  tenantId = await newTenant(admin, orgId, "Primary Resident");
  leaseId = (
    await admin.api.property.createLease({
      params: { orgId },
      body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000 },
    })
  ).id;
  contactId = (
    await admin.api.contacts.createContact({
      params: { orgId },
      body: { name: "Additional Resident", types: ["other"], phone: "+254700123456" },
    })
  ).contact.id;
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.tenants.view','property.tenants.leaseEdit','property.tenants.register'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, propertyId, admin.userId],
  );
});
afterAll(() => S.close());
it("links existing people without changing contracts, portal access or finance", async () => {
  person = await admin.api.property.createLeasePerson({ params: { orgId, leaseId }, body: { ...fields, contactId } });
  expect(person.contactName).toBe("Additional Resident");
  expect(person.phone).toBe("+254700123456");
  expect((await admin.api.property.getLease({ params: { orgId, leaseId } })).lease.tenantId).toBe(tenantId);
  const c = await admin.api.contacts.getContact({ params: { orgId, contactId } });
  expect(c.contact.userId).toBeNull();
  expect(c.contact.types).toEqual(["other"]);
  expect((await S.sql("SELECT count(*)::int n FROM pm_invoices WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
  expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
it("rejects primary duplicates, invalid dates, company contacts and repeat links", async () => {
  await refused(
    admin.api.property.createLeasePerson({ params: { orgId, leaseId }, body: { ...fields, contactId: tenantId } }),
    400,
  );
  await refused(
    admin.api.property.createLeasePerson({ params: { orgId, leaseId }, body: { ...fields, contactId } }),
    409,
  );
  await refused(
    admin.api.property.createLeasePerson({
      params: { orgId, leaseId },
      body: { ...fields, contactId, startDate: "0000-01-01" },
    }),
    400,
  );
  await refused(
    admin.api.property.createLeasePerson({
      params: { orgId, leaseId },
      body: { ...fields, contactId, endDate: "2025-01-01" },
    }),
    400,
  );
  const company = (
    await admin.api.contacts.createContact({
      params: { orgId },
      body: { name: "Company Contact", partyType: "company", types: ["other"] },
    })
  ).contact;
  await refused(
    admin.api.property.createLeasePerson({ params: { orgId, leaseId }, body: { ...fields, contactId: company.id } }),
    400,
  );
});
it("allows repeated edits, archiving and restoration with history and version checks", async () => {
  for (const note of ["First household correction", "Second household correction"]) {
    person = await manager.api.property.updateLeasePerson({
      params: { orgId, leaseId, leasePersonId: person.id },
      body: {
        ...fields,
        note,
        expectedVersion: person.version,
        archived: false,
        reason: "Manager confirmed the household details",
      },
    });
    expect(person.note).toBe(note);
  }
  const old = person.version;
  person = await manager.api.property.updateLeasePerson({
    params: { orgId, leaseId, leasePersonId: person.id },
    body: {
      ...fields,
      expectedVersion: person.version,
      archived: true,
      reason: "Resident no longer occupies this apartment",
    },
  });
  expect((await admin.api.property.listLeasePeople({ params: { orgId, leaseId } })).total).toBe(0);
  expect(
    (await admin.api.property.listLeasePeople({ params: { orgId, leaseId }, query: { status: "archived" } })).people[0]
      ?.id,
  ).toBe(person.id);
  await refused(
    manager.api.property.updateLeasePerson({
      params: { orgId, leaseId, leasePersonId: person.id },
      body: {
        ...fields,
        expectedVersion: old,
        archived: false,
        reason: "Outdated tab must not overwrite newer changes",
      },
    }),
    409,
  );
  person = await manager.api.property.updateLeasePerson({
    params: { orgId, leaseId, leasePersonId: person.id },
    body: {
      ...fields,
      expectedVersion: person.version,
      archived: false,
      reason: "Resident has returned to the household",
    },
  });
  const h = await manager.api.property.leasePeopleHistory({
    params: { orgId, leaseId },
    query: { limit: 2, offset: 0 },
  });
  expect(h.total).toBe(5);
  expect(h.entries).toHaveLength(2);
  expect(h.entries[0]?.action).toBe("Lease person restored");
});
it("serialises concurrent corrections and supports emergency contacts", async () => {
  const body = {
    ...fields,
    expectedVersion: person.version,
    archived: false,
    reason: "Concurrent household correction request",
  };
  const result = await Promise.allSettled([
    admin.api.property.updateLeasePerson({ params: { orgId, leaseId, leasePersonId: person.id }, body }),
    admin.api.property.updateLeasePerson({ params: { orgId, leaseId, leasePersonId: person.id }, body }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const c = (
    await manager.api.contacts.createContact({
      params: { orgId },
      body: { name: "Emergency Contact", types: ["other"] },
    })
  ).contact;
  const e = await manager.api.property.createLeasePerson({
    params: { orgId, leaseId },
    body: { contactId: c.id, kind: "emergency_contact", relationship: "Parent" },
  });
  expect(e.kind).toBe("emergency_contact");
  const page = await manager.api.property.listLeasePeople({
    params: { orgId, leaseId },
    query: { limit: 1, offset: 1 },
  });
  expect(page.total).toBe(2);
  expect(page.people).toHaveLength(1);
});
it("keeps new composite contact references compatible with contact merging", async () => {
  const keep = (
    await admin.api.contacts.createContact({
      params: { orgId },
      body: { name: "Canonical Emergency Contact", types: ["other"] },
    })
  ).contact;
  const emergency = (await admin.api.property.listLeasePeople({ params: { orgId, leaseId } })).people.find(
    (p) => p.kind === "emergency_contact",
  )!;
  await admin.api.contacts.mergeContacts({
    params: { orgId, contactId: keep.id },
    body: {
      mergeId: emergency.contactId,
      reason: "Verified duplicate identity; preserve household history",
    },
  });
  const after = (await admin.api.property.listLeasePeople({ params: { orgId, leaseId } })).people.find(
    (p) => p.id === emergency.id,
  );
  expect(after?.contactId).toBe(keep.id);
  expect(after?.contactName).toBe(keep.name);
  expect(after?.version).toBe(emergency.version + 1);
  expect((await admin.api.property.leasePeopleHistory({ params: { orgId, leaseId } })).entries[0]?.action).toBe(
    "Lease person identity merged",
  );
  expect((await S.sql("SELECT org_id FROM pm_lease_people WHERE id=$1", [emergency.id]))[0]?.org_id).toBe(orgId);
  await refused(
    admin.api.contacts.mergeContacts({
      params: { orgId, contactId: tenantId },
      body: { mergeId: keep.id, reason: "Must not turn the primary tenant into their own emergency contact" },
    }),
    409,
  );
});
it("isolates companies, delegated properties and contact profile details", async () => {
  const other = await pmOrg(S),
    b = await setUpBuilding(orgId, admin, { name: "Unassigned household building" }),
    tenant = await newTenant(admin, orgId, "Other Resident");
  const outside = (
    await admin.api.property.createLease({
      params: { orgId },
      body: { unitId: b.units["A-101"]!, tenantId: tenant, startDate: "2026-10-01", rentMinor: 100000 },
    })
  ).id;
  await refused(other.admin.api.property.listLeasePeople({ params: { orgId, leaseId } }), 404);
  await refused(manager.api.property.listLeasePeople({ params: { orgId, leaseId: outside } }), 404);
  await refused(
    manager.api.property.updateLeasePerson({
      params: { orgId, leaseId: outside, leasePersonId: person.id },
      body: { ...fields, expectedVersion: person.version, archived: true, reason: "Cannot cross property boundaries" },
    }),
    404,
  );
  await admin.api.property.createLeasePerson({ params: { orgId, leaseId: outside }, body: { ...fields, contactId } });
  const masked = (await manager.api.property.listLeasePeople({ params: { orgId, leaseId } })).people.find(
    (p) => p.id === person.id,
  );
  expect(masked?.contactAccessible).toBe(false);
  expect(masked?.phone).toBeNull();
  expect(masked?.contactName).toBe("Contact access restricted");
  const viewer = await S.addMember(orgId, admin.api, "viewer");
  await refused(
    viewer.api.property.createLeasePerson({ params: { orgId, leaseId }, body: { ...fields, contactId } }),
    403,
  );
  await S.sql("UPDATE main_manager_grants SET capabilities=ARRAY[]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
  ]);
  await refused(manager.api.property.listLeasePeople({ params: { orgId, leaseId } }), 403);
});
it("rejects new people on closed leases and retains existing records", async () => {
  await admin.api.property.cancelLease({
    params: { orgId, leaseId },
    body: { reason: "Draft cancelled after operational review" },
  });
  const c = (
    await admin.api.contacts.createContact({
      params: { orgId },
      body: { name: "Late Additional Person", types: ["other"] },
    })
  ).contact;
  await refused(
    admin.api.property.createLeasePerson({ params: { orgId, leaseId }, body: { ...fields, contactId: c.id } }),
    409,
  );
  expect(
    (await admin.api.property.listLeasePeople({ params: { orgId, leaseId }, query: { status: "all" } })).total,
  ).toBe(2);
});
