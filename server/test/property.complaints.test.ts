import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  resident: Person,
  unrelated: Person,
  manager: Person,
  leaseId: string,
  propertyId: string,
  caseRecord: P.Complaint;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  resident = await S.addMember(orgId, admin.api, "tenant");
  unrelated = await S.addMember(orgId, admin.api, "tenant");
  manager = await S.addMember(orgId, admin.api, "main_manager");
  const t = await newTenant(admin, orgId, "Complaint Resident");
  await admin.api.contacts.updateContact({ params: { orgId, contactId: t }, body: { userId: resident.userId } });
  const other = await newTenant(admin, orgId, "Other Resident");
  await admin.api.contacts.updateContact({ params: { orgId, contactId: other }, body: { userId: unrelated.userId } });
  leaseId = (
    await admin.api.property.createLease({
      params: { orgId },
      body: { unitId: b.units["A-101"]!, tenantId: t, startDate: "2026-10-01", rentMinor: 100000 },
    })
  ).id;
  await admin.api.property.activateLease({
    params: { orgId, leaseId },
    body: { signedOn: "2026-10-01", billFirstRent: false },
  });
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.maintenance.manage'],ARRAY[]::text[],$3)",
    [orgId, manager.userId, admin.userId],
  );
});
afterAll(() => S.close());
it("creates and reopens a persisted resident complaint without changing the lease or ledger", async () => {
  caseRecord = await resident.api.property.tenantCreateComplaint({
    params: { orgId },
    body: {
      leaseId,
      title: "Noise from the common area",
      category: "Neighbour complaint",
      description: "Repeated noise late in the evening; please review.",
    },
  });
  expect(caseRecord.status).toBe("open");
  expect(caseRecord.events).toHaveLength(1);
  expect(
    (await resident.api.property.tenantGetComplaint({ params: { orgId, complaintId: caseRecord.id } })).title,
  ).toContain("Noise");
  expect((await admin.api.property.getLease({ params: { orgId, leaseId } })).lease.status).toBe("active");
  expect((await admin.api.property.listInvoices({ params: { orgId } })).invoices).toHaveLength(0);
});
it("enforces tenant, organisation, property and role boundaries for details and writes", async () => {
  expect((await unrelated.api.property.tenantComplaints({ params: { orgId } })).total).toBe(0);
  await refused(unrelated.api.property.tenantGetComplaint({ params: { orgId, complaintId: caseRecord.id } }), 404);
  await refused(
    unrelated.api.property.tenantCreateComplaint({
      params: { orgId },
      body: { leaseId, title: "Wrong tenancy", category: "General", description: "This is another resident record" },
    }),
    404,
  );
  await refused(resident.api.property.listComplaints({ params: { orgId } }), 403);
  await refused(manager.api.property.getComplaint({ params: { orgId, complaintId: caseRecord.id } }), 404);
  expect((await manager.api.property.listComplaints({ params: { orgId } })).total).toBe(0);
  const org2 = await pmOrg(S);
  await refused(org2.admin.api.property.getComplaint({ params: { orgId, complaintId: caseRecord.id } }), 404);
  await refused(
    resident.api.property.tenantComplaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: { expectedVersion: caseRecord.version, action: "resolve", reason: "Cannot self resolve" },
    }),
    403,
  );
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[$3]::text[] WHERE org_id=$1 AND user_id=$2", [
    orgId,
    manager.userId,
    propertyId,
  ]);
  expect((await manager.api.property.listComplaints({ params: { orgId } })).total).toBe(1);
});
it("assigns only active authorised staff and preserves private notes", async () => {
  await refused(
    admin.api.property.complaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: {
        expectedVersion: caseRecord.version,
        action: "assign",
        assignedUserId: resident.userId,
        reason: "Reject tenant assignment",
      },
    }),
    400,
  );
  caseRecord = await admin.api.property.complaintAction({
    params: { orgId, complaintId: caseRecord.id },
    body: {
      expectedVersion: caseRecord.version,
      action: "assign",
      assignedUserId: manager.userId,
      reason: "Assigned responsible manager",
    },
  });
  expect(caseRecord.assignedUserId).toBe(manager.userId);
  caseRecord = await manager.api.property.complaintAction({
    params: { orgId, complaintId: caseRecord.id },
    body: {
      expectedVersion: caseRecord.version,
      action: "comment",
      internal: true,
      reason: "Private staff assessment only",
    },
  });
  expect(caseRecord.events.some((e) => e.internal)).toBe(true);
  const visible = await resident.api.property.tenantGetComplaint({ params: { orgId, complaintId: caseRecord.id } });
  expect(visible.events.some((e) => e.internal)).toBe(false);
  expect(JSON.stringify(visible)).not.toContain("Private staff");
  await refused(
    resident.api.property.tenantComplaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: {
        expectedVersion: caseRecord.version,
        action: "comment",
        internal: true,
        reason: "Cannot create internal note",
      },
    }),
    403,
  );
});
it("filters assignment choices and protects evidence across tenant, staff and tenancy boundaries", async () => {
  const choices = await manager.api.property.complaintAssignees({ params: { orgId, complaintId: caseRecord.id } });
  expect(choices.members.some((x) => x.userId === manager.userId)).toBe(true);
  expect(choices.members.some((x) => x.userId === resident.userId)).toBe(false);
  expect(
    (
      await admin.api.property.complaintAssignees({
        params: { orgId, complaintId: caseRecord.id },
        query: { search: "does not exist" },
      })
    ).members,
  ).toHaveLength(0);
  const shared = await admin.api.property.addDocument({
    params: { orgId },
    body: {
      name: "Shared case evidence",
      docType: "inspection",
      linkEntity: "lease",
      linkId: leaseId,
      filename: "evidence.txt",
      visibility: "tenant",
    },
  });
  await admin.api.property.uploadDocumentFile({
    params: { orgId, documentId: shared.id },
    body: {
      filename: "evidence.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("Photograph description recorded in synthetic evidence").toString("base64"),
    },
  });
  const privateDoc = await admin.api.property.addDocument({
    params: { orgId },
    body: {
      name: "Staff investigation",
      docType: "other",
      linkEntity: "lease",
      linkId: leaseId,
      filename: "internal.txt",
      visibility: "staff",
    },
  });
  const wrong = await admin.api.property.addDocument({
    params: { orgId },
    body: {
      name: "Unrelated property reference",
      docType: "other",
      linkEntity: "property",
      linkId: propertyId,
      filename: "other.txt",
      visibility: "staff",
    },
  });
  await refused(
    admin.api.property.complaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: {
        expectedVersion: caseRecord.version,
        action: "evidence",
        documentId: wrong.id,
        reason: "Wrong document context rejected",
      },
    }),
    404,
  );
  for (const documentId of [shared.id, privateDoc.id])
    caseRecord = await admin.api.property.complaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: {
        expectedVersion: caseRecord.version,
        action: "evidence",
        documentId,
        reason: "Evidence added for case review",
      },
    });
  expect(caseRecord.evidence).toHaveLength(2);
  const own = await resident.api.property.tenantGetComplaint({ params: { orgId, complaintId: caseRecord.id } });
  expect(own.evidence).toHaveLength(1);
  expect(own.evidence[0]?.fileStored).toBe(true);
  expect(JSON.stringify(own)).not.toContain("Staff investigation");
  expect(
    (await resident.api.property.downloadDocumentFile({ params: { orgId, documentId: shared.id } })).contentBase64,
  ).toBeTruthy();
  await refused(resident.api.property.downloadDocumentFile({ params: { orgId, documentId: privateDoc.id } }), 404);
});
it("supports review, custom categories, escalation, public conversation, resolution, closure and reopening", async () => {
  for (const [action, extra] of [
    ["categorise", { category: "Building community" }],
    ["review", {}],
    ["escalate", {}],
  ] as const) {
    caseRecord = await manager.api.property.complaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: { expectedVersion: caseRecord.version, action, reason: "Manager review with explanation", ...extra },
    });
  }
  expect(caseRecord.status).toBe("escalated");
  expect(caseRecord.category).toBe("Building community");
  caseRecord = await resident.api.property.tenantComplaintAction({
    params: { orgId, complaintId: caseRecord.id },
    body: { expectedVersion: caseRecord.version, action: "comment", reason: "Thank you, please arrange a meeting" },
  });
  await refused(
    manager.api.property.complaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: { expectedVersion: caseRecord.version, action: "close", reason: "Cannot close before resolving" },
    }),
    409,
  );
  caseRecord = await manager.api.property.complaintAction({
    params: { orgId, complaintId: caseRecord.id },
    body: { expectedVersion: caseRecord.version, action: "resolve", reason: "Meeting held and quiet hours agreed" },
  });
  expect(caseRecord.resolution).toContain("quiet hours");
  caseRecord = await manager.api.property.complaintAction({
    params: { orgId, complaintId: caseRecord.id },
    body: { expectedVersion: caseRecord.version, action: "close", reason: "Resolution confirmed with resident" },
  });
  await refused(
    resident.api.property.tenantComplaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: { expectedVersion: caseRecord.version, action: "comment", reason: "Closed cases require reopening" },
    }),
    409,
  );
  caseRecord = await resident.api.property.tenantComplaintAction({
    params: { orgId, complaintId: caseRecord.id },
    body: { expectedVersion: caseRecord.version, action: "reopen", reason: "Noise has started again this week" },
  });
  expect(caseRecord.status).toBe("open");
  expect(caseRecord.resolution).toBe("");
  expect(caseRecord.events.some((e) => e.action === "resolve")).toBe(true);
  const search = await admin.api.property.listComplaints({
    params: { orgId },
    query: { search: "Noise", status: "open", limit: 1 },
  });
  expect(search.total).toBe(1);
});
it("rejects stale decisions, records audit and preserves immutable history", async () => {
  const version = caseRecord.version;
  const b = {
    params: { orgId, complaintId: caseRecord.id },
    body: { expectedVersion: version, action: "comment" as const, reason: "Simultaneous review update" },
  };
  const results = await Promise.allSettled([
    admin.api.property.complaintAction(b),
    admin.api.property.complaintAction(b),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  caseRecord = await admin.api.property.getComplaint({ params: { orgId, complaintId: caseRecord.id } });
  expect(caseRecord.version).toBe(version + 1);
  await expect(S.sql("DELETE FROM pm_complaint_events WHERE complaint_id=$1", [caseRecord.id])).rejects.toThrow();
  const audit = await S.sql("SELECT * FROM audit_log WHERE org_id=$1 AND target=$2", [orgId, caseRecord.id]);
  expect(audit.length).toBeGreaterThan(6);
  const dash = await admin.api.property.dashboard({ params: { orgId } });
  expect(Object.values(dash.ledger).every((x) => x.agrees)).toBe(true);
});
it("takes permission revocation into account on the next request", async () => {
  await S.sql("UPDATE main_manager_grants SET enabled=false WHERE org_id=$1 AND user_id=$2", [orgId, manager.userId]);
  await refused(manager.api.property.getComplaint({ params: { orgId, complaintId: caseRecord.id } }), 403);
  await refused(
    admin.api.property.complaintAction({
      params: { orgId, complaintId: caseRecord.id },
      body: {
        expectedVersion: caseRecord.version,
        action: "assign",
        assignedUserId: manager.userId,
        reason: "Revoked manager cannot receive assignment",
      },
    }),
    400,
  );
});
