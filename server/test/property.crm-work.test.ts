import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer,
  o: Awaited<ReturnType<typeof pmOrg>>,
  propertyId: string,
  manager: Person,
  tenant: Person,
  id: string;
const O = () => ({ orgId: o.orgId });
const input = () => ({
  propertyId,
  title: "Follow up lease offer",
  description: "Call after the viewing",
  kind: "call" as const,
  dueAt: "2026-11-05T10:00:00+03:00",
  priority: "high" as const,
  requestKey: "synthetic-crm-request-0001",
});
beforeAll(async () => {
  S = await startPropertyServer();
  o = await pmOrg(S);
  ({ propertyId } = await setUpBuilding(o.orgId, o.admin));
  manager = await S.addMember(o.orgId, o.admin.api, "main_manager");
  tenant = await S.addMember(o.orgId, o.admin.api, "tenant");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.crm','property.tenants.view','contacts.read'],ARRAY[$3]::text[],$4)",
    [o.orgId, manager.userId, propertyId, o.admin.userId],
  );
});
afterAll(() => S.close());
it("creates once, lists across UTC offsets, reopens, edits repeatedly and retains history", async () => {
  let task = await o.admin.api.property.createCrmWork({
    params: O(),
    body: { ...input(), assigneeId: manager.userId },
  });
  id = task.id;
  expect(
    (await o.admin.api.property.createCrmWork({ params: O(), body: { ...input(), assigneeId: manager.userId } })).id,
  ).toBe(id);
  expect(task.dueAt).toContain("07:00");
  for (const title of ["Call to discuss lease offer", "Discuss revised lease offer"]) {
    task = await manager.api.property.updateCrmWork({
      params: { ...O(), taskId: id },
      body: {
        ...input(),
        contactId: null,
        title,
        assigneeId: manager.userId,
        expectedVersion: task.version,
        status: "open",
        reason: "Client requested a revised follow-up",
      },
    });
  }
  expect(task.version).toBe(3);
  const list = await manager.api.property.listCrmWork({ params: O(), query: { q: "revised", limit: 1 } });
  expect(list.total).toBe(1);
  expect(list.items[0]?.id).toBe(id);
  expect(
    (await o.admin.api.property.crmWorkHistory({ params: { ...O(), taskId: id } })).events.map((x) => x.version),
  ).toEqual([3, 2, 1]);
  await refused(
    manager.api.property.updateCrmWork({
      params: { ...O(), taskId: id },
      body: { ...input(), expectedVersion: 1, status: "open", reason: "Stale edit must be rejected" },
    }),
    409,
  );
});
it("handles completion, archival and restoration without changing accounting", async () => {
  let task = (await o.admin.api.property.listCrmWork({ params: O(), query: {} })).items[0]!;
  for (const status of ["completed", "open", "archived", "open"] as const) {
    task = await o.admin.api.property.updateCrmWork({
      params: { ...O(), taskId: id },
      body: {
        ...input(),
        assigneeId: manager.userId,
        expectedVersion: task.version,
        status,
        reason: "Reviewed lifecycle transition",
      },
    });
  }
  expect(task.status).toBe("open");
  expect(await S.sql("SELECT id FROM pm_invoices WHERE org_id=$1", [o.orgId])).toHaveLength(0);
  await expect(S.sql("UPDATE pm_crm_work_history SET reason='tamper' WHERE task_id=$1", [id])).rejects.toThrow(
    /immutable/,
  );
});
it("rejects unauthorised assignments, tenant access, cross-organisation and revoked property access", async () => {
  expect(
    (await o.admin.api.property.crmAssignees({ params: O(), query: { propertyId } })).users.some(
      (u) => u.id === manager.userId,
    ),
  ).toBe(true);
  await refused(
    o.admin.api.property.createCrmWork({
      params: O(),
      body: { ...input(), requestKey: "invalid-assignee-request", assigneeId: tenant.userId },
    }),
    400,
  );
  const other = await pmOrg(S);
  await refused(other.admin.api.property.crmWorkHistory({ params: { ...O(), taskId: id } }), 404);
  await refused(tenant.api.property.listCrmWork({ params: O(), query: {} }), 403);
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[]::text[] WHERE org_id=$1 AND user_id=$2", [
    o.orgId,
    manager.userId,
  ]);
  expect((await manager.api.property.listCrmWork({ params: O(), query: {} })).items).toHaveLength(0);
  await refused(manager.api.property.crmWorkHistory({ params: { ...O(), taskId: id } }), 404);
});
it("lists recorded messages with actual consent status and no external delivery claim", async () => {
  const c = await o.admin.api.contacts.createContact({
    params: O(),
    body: { name: "Synthetic prospect", types: ["prospect"], email: "prospect@synthetic.test" },
  });
  await o.admin.api.contacts.recordMessage({
    params: { ...O(), contactId: c.contact.id },
    body: {
      channel: "email",
      direction: "out",
      subject: "Follow-up",
      body: "Please review your lease offer",
      marketing: false,
    },
  });
  const r = await o.admin.api.property.crmMessageLog({ params: O(), query: { q: "Synthetic prospect" } });
  expect(r.total).toBe(1);
  expect(r.items[0]?.status).toBe("blocked");
  expect((await manager.api.property.crmMessageLog({ params: O(), query: {} })).items).toHaveLength(0);
});
it("uses the workspace calendar month and serialises simultaneous edits", async () => {
  const b = {
    ...input(),
    requestKey: "month-boundary-task-key",
    title: "December local meeting",
    dueAt: "2026-11-30T23:30:00Z",
  };
  const x = await o.admin.api.property.createCrmWork({ params: O(), body: b });
  expect(
    (await o.admin.api.property.listCrmWork({ params: O(), query: { month: "2026-11" } })).items.some(
      (t) => t.id === x.id,
    ),
  ).toBe(false);
  expect(
    (await o.admin.api.property.listCrmWork({ params: O(), query: { month: "2026-12" } })).items.some(
      (t) => t.id === x.id,
    ),
  ).toBe(true);
  const changes = await Promise.allSettled(
    ["First correction", "Second correction"].map((title) =>
      o.admin.api.property.updateCrmWork({
        params: { ...O(), taskId: x.id },
        body: { ...b, title, status: "open", expectedVersion: 1, reason: "Concurrent reviewed edit" },
      }),
    ),
  );
  expect(changes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(changes.filter((r) => r.status === "rejected")).toHaveLength(1);
});
it("does not expose another property contact through a permitted property task", async () => {
  const b = await setUpBuilding(o.orgId, o.admin, { name: "Other private property" });
  const x = await o.admin.api.property.createCrmWork({
    params: O(),
    body: { ...input(), requestKey: "cross-contact-private-task", contactId: b.ownerId },
  });
  await S.sql("UPDATE main_manager_grants SET property_ids=ARRAY[$3]::text[] WHERE org_id=$1 AND user_id=$2", [
    o.orgId,
    manager.userId,
    propertyId,
  ]);
  expect((await manager.api.property.listCrmWork({ params: O(), query: {} })).items.some((t) => t.id === x.id)).toBe(
    false,
  );
  await refused(manager.api.property.crmWorkHistory({ params: { ...O(), taskId: x.id } }), 404);
});
it("separates the contact record from verified notification delivery state", async () => {
  const c = await o.admin.api.contacts.createContact({
    params: O(),
    body: {
      name: "Consenting synthetic prospect",
      types: ["prospect"],
      email: "consenting@synthetic.test",
      consent: { email: true },
    },
  });
  const m = await o.admin.api.contacts.recordMessage({
    params: { ...O(), contactId: c.contact.id },
    body: {
      channel: "email",
      direction: "out",
      subject: "Reviewed synthetic offer",
      body: "Synthetic transactional message",
      marketing: false,
    },
  });
  expect(m.outboxId).toBeTruthy();
  await S.sql(
    "UPDATE notifications SET status='queued',provider='test',status_note='Test queue only; no external delivery' WHERE id=$1",
    [m.outboxId],
  );
  const r = await o.admin.api.property.crmMessageLog({ params: O(), query: { contactId: c.contact.id } });
  expect(r.items[0]).toMatchObject({
    status: "recorded",
    deliveryStatus: "queued",
    deliveryNote: "Test queue only; no external delivery",
  });
});
it("lets scoped Main Managers run their pipeline while preserving property and contact isolation", async () => {
  const b = await setUpBuilding(o.orgId, o.admin, { name: "Private other pipeline" });
  const own = await manager.api.property.createEnquiry({
    params: O(),
    body: {
      name: "Manager prospect",
      email: "manager-prospect@synthetic.test",
      source: "Phone",
      idempotencyKey: "manager-enquiry-once",
    },
  });
  expect(
    (await manager.api.property.listLeads({ params: O(), query: {} })).leads.some((x) => x.id === own.lead.id),
  ).toBe(true);
  const other = await o.admin.api.property.createEnquiry({
    params: O(),
    body: {
      name: "Private pipeline prospect",
      email: "other-pipeline@synthetic.test",
      unitId: b.units["A-101"]!,
      source: "Private",
      idempotencyKey: "private-enquiry-once",
    },
  });
  expect(
    (await manager.api.property.listLeads({ params: O(), query: {} })).leads.some((x) => x.id === other.lead.id),
  ).toBe(false);
  await refused(
    manager.api.property.moveLead({ params: { ...O(), leadId: other.lead.id }, body: { stage: "contacted" } }),
    404,
  );
  await refused(
    manager.api.property.createEnquiry({
      params: O(),
      body: {
        name: "Private pipeline prospect",
        email: "other-pipeline@synthetic.test",
        idempotencyKey: "private-enquiry-once",
      },
    }),
    404,
  );
  await manager.api.property.moveLead({ params: { ...O(), leadId: own.lead.id }, body: { stage: "contacted" } });
  expect((await manager.api.property.listViewings({ params: O(), query: {} })).viewings).toEqual([]);
  expect((await manager.api.property.listApplications({ params: O() })).applications).toEqual([]);
});
