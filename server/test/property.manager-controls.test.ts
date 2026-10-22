import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, setUpBuilding, newTenant, startPropertyServer, type PmStaff } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { Capability } from "@paltas/contracts";

describe("Owner-delegated Main Manager and independent tenant lifecycle controls", () => {
  let S: TestServer,
    orgId: string,
    owner: Person,
    st: PmStaff,
    manager: Person,
    tenant: Person,
    contact: string,
    otherContact: string,
    lease: string,
    propertyId: string;
  const perms: Capability[] = [
    "property.tenants.view",
    "property.tenants.register",
    "property.tenants.documents",
    "property.tenants.edit",
    "property.tenants.history",
    "property.tenants.suspend",
    "property.tenants.restore",
    "property.tenants.archive",
    "property.tenants.leaseEnd",
    "property.read",
    "contacts.read",
  ];
  const grant = () => ({ product: "property" as const, capabilities: perms, propertyIds: [propertyId], enabled: true });
  beforeAll(async () => {
    S = await startPropertyServer();
    const o = await pmOrg(S);
    orgId = o.orgId;
    owner = o.admin;
    st = o.staff;
    manager = await S.addMember(orgId, owner.api, "main_manager");
    tenant = await S.addMember(orgId, owner.api, "tenant");
    const a = await setUpBuilding(orgId, st.property_manager, { name: "Assigned West" });
    propertyId = a.propertyId;
    const b = await setUpBuilding(orgId, st.property_manager, { name: "Unassigned East" });
    contact = await newTenant(st.property_manager, orgId, "Managed Resident");
    otherContact = await newTenant(st.property_manager, orgId, "Private Resident");
    await owner.api.contacts.updateContact({ params: { orgId, contactId: contact }, body: { userId: tenant.userId } });
    for (const [c, building] of [
      [contact, a],
      [otherContact, b],
    ] as const) {
      const l = await st.property_manager.api.property.createLease({
        params: { orgId },
        body: {
          tenantId: c,
          unitId: building.units["A-101"]!,
          startDate: "2026-10-01",
          rentMinor: 12000000,
          depositMinor: 0,
        },
      });
      await st.property_manager.api.property.activateLease({
        params: { orgId, leaseId: l.id },
        body: { signedOn: "2026-10-01", billFirstRent: false },
      });
      if (c === contact) lease = l.id;
    }
  });
  afterAll(() => S.close());
  it("new Main Managers have no operational access until the owner grants it", async () => {
    await refused(manager.api.property.listProperties({ params: { orgId } }), 403);
    await owner.api.organisations.setManagerGrants({
      params: { orgId, userId: manager.userId },
      body: { grants: [grant()], reason: "Appointed to manage West operational records", confirm: "SAVE_PERMISSIONS" },
    });
    await manager.api.subscriptions.entitlements({ params: { orgId }, query: { product: "property" } });
    expect((await manager.api.property.listProperties({ params: { orgId } })).properties.map((x) => x.id)).toEqual([
      propertyId,
    ]);
  });
  it("edits assigned tenants but rejects another property and linked direct URLs", async () => {
    await manager.api.contacts.updateContact({
      params: { orgId, contactId: contact },
      body: { notes: "Authorised update" },
    });
    expect((await owner.api.contacts.getContact({ params: { orgId, contactId: contact } })).contact.notes).toBe(
      "Authorised update",
    );
    await refused(manager.api.contacts.getContact({ params: { orgId, contactId: otherContact } }), 404);
    expect(
      (await manager.api.contacts.listContacts({ params: { orgId }, query: { type: "tenant" } })).contacts.map(
        (c) => c.id,
      ),
    ).toEqual([contact]);
  });
  it("cannot grant itself permissions or promote itself to organisation owner", async () => {
    await refused(
      manager.api.organisations.setManagerGrants({
        params: { orgId, userId: manager.userId },
        body: {
          grants: [{ ...grant(), propertyIds: null }],
          reason: "Attempt to expand own access",
          confirm: "SAVE_PERMISSIONS",
        },
      }),
      403,
    );
    await refused(
      manager.api.organisations.updateMember({
        params: { orgId, userId: manager.userId },
        body: { role: "org_admin" },
      }),
      403,
    );
  });
  it("suspends only portal access, preserving leases and financial history; restore works with the same session", async () => {
    await tenant.api.property.tenantPortal({ params: { orgId } });
    await manager.api.property.setTenantControl({
      params: { orgId, tenantId: contact },
      body: {
        action: "suspend",
        reason: "Security review requested by resident",
        reviewOn: "2026-10-20",
        confirm: "CONFIRM",
        acknowledgeNoEviction: true,
      },
    });
    await refused(tenant.api.property.tenantPortal({ params: { orgId } }), 403);
    expect((await owner.api.property.getLease({ params: { orgId, leaseId: lease } })).lease.status).toBe("active");
    await manager.api.property.setTenantControl({
      params: { orgId, tenantId: contact },
      body: {
        action: "restore",
        reason: "Identity review completed and access restored",
        confirm: "CONFIRM",
        acknowledgeNoEviction: true,
      },
    });
    await tenant.api.property.tenantPortal({ params: { orgId } });
  });
  it("requires review dates, protects active tenancies, and never deletes historical records on archive", async () => {
    await refused(
      manager.api.property.setTenantControl({
        params: { orgId, tenantId: contact },
        body: { action: "suspend", reason: "No review date supplied", confirm: "CONFIRM", acknowledgeNoEviction: true },
      }),
      400,
    );
    await refused(
      manager.api.property.setTenantControl({
        params: { orgId, tenantId: contact },
        body: {
          action: "archive",
          reason: "Attempt to hide an active lease",
          confirm: "CONFIRM",
          acknowledgeNoEviction: true,
        },
      }),
      409,
    );
    await manager.api.property.terminateLease({
      params: { orgId, leaseId: lease },
      body: { moveOutDate: "2026-10-11", reason: "Resident formally moved out" },
    });
    await manager.api.property.setTenantControl({
      params: { orgId, tenantId: contact },
      body: {
        action: "archive",
        reason: "Operational record archived after move-out",
        confirm: "CONFIRM",
        acknowledgeNoEviction: true,
      },
    });
    expect(
      (await owner.api.contacts.listContacts({ params: { orgId }, query: { type: "tenant" } })).contacts.some(
        (c) => c.id === contact,
      ),
    ).toBe(false);
    expect(
      (
        await owner.api.contacts.listContacts({ params: { orgId }, query: { type: "tenant", includeArchived: "true" } })
      ).contacts.some((c) => c.id === contact),
    ).toBe(true);
    expect((await owner.api.property.getLease({ params: { orgId, leaseId: lease } })).lease.status).toBe("ended");
    await refused(
      owner.api.property.createLease({
        params: { orgId },
        body: {
          tenantId: contact,
          unitId: (await owner.api.property.getLease({ params: { orgId, leaseId: lease } })).lease.unitId,
          startDate: "2026-11-01",
          rentMinor: 100000,
        },
      }),
      409,
    );
    await tenant.api.property.tenantPortal({ params: { orgId } }); // archive and portal suspension are distinct
  });
  it("handles newly registered contacts, and cannot use a selected property to bypass global or document restrictions", async () => {
    const fresh = await manager.api.contacts.createContact({
      params: { orgId },
      body: { name: "New assigned resident", types: ["tenant"] },
    });
    expect((await manager.api.contacts.getContact({ params: { orgId, contactId: fresh.contact.id } })).contact.id).toBe(
      fresh.contact.id,
    );
    const doc = await manager.api.property.addDocument({
      params: { orgId },
      body: {
        name: "Assigned tenant agreement",
        docType: "agreement",
        linkEntity: "contact",
        linkId: contact,
        filename: "agreement.txt",
        visibility: "tenant",
      },
    });
    await manager.api.property.uploadDocumentFile({
      params: { orgId, documentId: doc.id },
      body: {
        filename: "agreement.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("Synthetic test agreement").toString("base64"),
      },
    });
    expect((await manager.api.property.downloadDocumentFile({ params: { orgId, documentId: doc.id } })).filename).toBe(
      "agreement.txt",
    );
    await refused(
      manager.api.property.addDocument({
        params: { orgId },
        body: {
          name: "Not assigned",
          docType: "agreement",
          linkEntity: "contact",
          linkId: otherContact,
          filename: "secret.txt",
        },
      }),
      404,
    );
    const privateDoc = await owner.api.property.addDocument({
      params: { orgId },
      body: {
        name: "Other property private",
        docType: "agreement",
        linkEntity: "contact",
        linkId: otherContact,
        filename: "other.txt",
      },
    });
    await refused(manager.api.property.downloadDocumentFile({ params: { orgId, documentId: privateDoc.id } }), 404);
    await refused(manager.api.property.listDocuments({ params: { orgId } }), 400);
    await refused(manager.api.property.dashboard({ params: { orgId }, query: { propertyId } }), 403);
    const secondOrg = await pmOrg(S, { name: "Another isolated organisation" });
    await refused(manager.api.property.listProperties({ params: { orgId: secondOrg.orgId } }), 404);
  });
  it("scopes receipt counts before pagination and refuses cross-property contact reuse", async () => {
    for (const [tenantId, reference] of [
      [contact, "ASSIGNED-RECEIPT"],
      [otherContact, "UNASSIGNED-RECEIPT"],
    ] as const)
      await owner.api.property.recordPayment({
        params: { orgId },
        body: { tenantId, date: "2026-10-11", amountMinor: 100, method: "bank_transfer", reference },
      });
    const page = await manager.api.property.listPayments({ params: { orgId }, query: { limit: 1, offset: 0 } });
    expect(page.total).toBe(1);
    expect(page.payments).toHaveLength(1);
    expect(page.payments[0]?.tenantId).toBe(contact);
    const privateContact = (await owner.api.contacts.getContact({ params: { orgId, contactId: otherContact } }))
      .contact;
    await refused(
      manager.api.contacts.createContact({
        params: { orgId },
        body: {
          name: "Attempted reuse",
          email: privateContact.email ?? undefined,
          types: ["tenant"],
          reuseExisting: true,
        },
      }),
      409,
    );
  });
  it("delegates staff control only within the manager's own organisation-wide permissions", async () => {
    await refused(
      owner.api.organisations.setManagerGrants({
        params: { orgId, userId: manager.userId },
        body: {
          grants: [{ ...grant(), capabilities: [...perms, "members.manage"] }],
          reason: "Unsafe scoped staff delegation",
          confirm: "SAVE_PERMISSIONS",
        },
      }),
      400,
    );
    await owner.api.organisations.setManagerGrants({
      params: { orgId, userId: manager.userId },
      body: {
        grants: [{ ...grant(), propertyIds: null, capabilities: [...perms, "members.manage", "members.read"] }],
        reason: "Owner delegated limited operational staff control",
        confirm: "SAVE_PERMISSIONS",
      },
    });
    const member = await manager.api.organisations.addMember({
      params: { orgId },
      body: { email: "delegated-viewer@example.test", role: "viewer", productRoles: { property: "viewer" } },
    });
    expect(member.member.role).toBe("viewer");
    await refused(
      manager.api.organisations.addMember({
        params: { orgId },
        body: { email: "escalation@example.test", role: "org_admin", productRoles: { property: "org_admin" } },
      }),
      403,
    );
    await refused(
      manager.api.organisations.addMember({
        params: { orgId },
        body: {
          email: "excess@example.test",
          role: "property_manager",
          productRoles: { property: "property_manager" },
        },
      }),
      403,
    );
    await refused(
      manager.api.organisations.updateMember({
        params: { orgId, userId: owner.userId },
        body: { status: "suspended" },
      }),
      403,
    );
    await manager.api.organisations.updateMember({
      params: { orgId, userId: member.member.userId },
      body: { status: "suspended" },
    });
  });
  it("revocation takes effect on the next request, with auditable actor, reason and organisation", async () => {
    await owner.api.organisations.setManagerGrants({
      params: { orgId, userId: manager.userId },
      body: { grants: [], reason: "Owner revoked operational delegation", confirm: "SAVE_PERMISSIONS" },
    });
    await refused(manager.api.property.listProperties({ params: { orgId } }), 404);
    const audits = await S.sql("SELECT action,org_id,actor_user,detail FROM audit_log WHERE org_id=$1", [orgId]);
    expect(audits.some((a) => a.action === "Tenant suspend" && a.actor_user === manager.userId)).toBe(true);
    expect(audits.some((a) => a.action === "Tenant archive")).toBe(true);
    expect(audits.some((a) => a.action === "Main Manager permissions changed" && a.detail.includes("revoked"))).toBe(
      true,
    );
  });
});
