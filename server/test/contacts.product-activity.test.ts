import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { property } from "../dist/products/property/index.js";
import { agency } from "../dist/products/agency/index.js";
import { startServer, refused, type TestServer } from "./support/test-server.js";
import { pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
describe("shared product activity provenance, not autonomous access decisions", () => {
  let S: TestServer,
    X: Awaited<ReturnType<typeof pmOrg>>,
    B: Awaited<ReturnType<typeof setUpBuilding>>,
    tenantId: string,
    leaseId: string;
  const O = () => ({ orgId: X.orgId });
  beforeAll(async () => {
    S = await startServer({ products: [property, agency] });
    S.setToday("2026-10-25");
    X = await pmOrg(S);
    await X.admin.api.subscriptions.addProduct({
      params: O(),
      body: { product: "agency", plan: "AGENCY-PRO", confirm: "CONFIRM" },
    });
    B = await setUpBuilding(X.orgId, X.staff.property_manager);
    tenantId = await newTenant(X.staff.property_manager, X.orgId, "Activity Test Resident");
    const l = await X.staff.property_manager.api.property.createLease({
      params: O(),
      body: { unitId: B.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000, depositMinor: 0 },
    });
    leaseId = l.id;
    await X.staff.property_manager.api.property.activateLease({
      params: { ...O(), leaseId },
      body: { signedOn: "2026-10-01" },
    });
  });
  afterAll(async () => {
    if (S) await S.close();
  });
  const event = () => ({
    orgId: X.orgId,
    contactId: tenantId,
    eventType: "property.lease.activated" as const,
    recordId: leaseId,
    text: "Replay must preserve original summary",
    by: X.admin.userId,
  });
  it("writes one durable attributed entry and deduplicates concurrent deliveries", async () => {
    const details = await X.admin.api.contacts.getContact({ params: { ...O(), contactId: tenantId } });
    const original = details.activities.find((a) => a.eventType === "property.lease.activated")!;
    expect(original).toMatchObject({ sourceProduct: "property", refId: leaseId, kind: "lease" });
    const repeated = await Promise.all(
      Array.from({ length: 8 }, () => S.app.ctx.db.tx((t) => S.app.core.contacts.productActivity(t, event()))),
    );
    expect(repeated.every((a) => a.id === original.id && a.text === original.text && a.by === original.by)).toBe(true);
    expect(
      await S.sql("SELECT id FROM contact_activities WHERE org_id=$1 AND event_key=$2", [X.orgId, original.eventKey]),
    ).toHaveLength(1);
  });
  it("rejects cross-organisation and mismatched contact/source claims", async () => {
    const other = await pmOrg(S);
    await expect(
      S.app.ctx.db.tx((t) => S.app.core.contacts.productActivity(t, { ...event(), orgId: other.orgId })),
    ).rejects.toBeTruthy();
    const stranger = await newTenant(X.staff.property_manager, X.orgId, "Other Resident");
    await expect(
      S.app.ctx.db.tx((t) => S.app.core.contacts.productActivity(t, { ...event(), contactId: stranger })),
    ).rejects.toBeTruthy();
    await expect(
      S.app.ctx.db.tx((t) =>
        S.app.core.contacts.productActivity(t, { ...event(), eventType: "agency.stay.completed" }),
      ),
    ).rejects.toBeTruthy();
  });
  it("activation preview rolls back both the lease and its projected activity", async () => {
    const id = await newTenant(X.staff.property_manager, X.orgId, "Preview Resident");
    const draft = await X.staff.property_manager.api.property.createLease({
      params: O(),
      body: { unitId: B.units["A-102"]!, tenantId: id, startDate: "2026-10-01", rentMinor: 90000, depositMinor: 0 },
    });
    await X.staff.property_manager.api.property.previewLeaseActivation({
      params: { ...O(), leaseId: draft.id },
      body: { signedOn: "2026-10-01" },
    });
    expect(
      await S.sql("SELECT id FROM contact_activities WHERE org_id=$1 AND event_key=$2", [
        X.orgId,
        "property.lease.activated:" + draft.id,
      ]),
    ).toHaveLength(0);
    expect(
      (await X.staff.property_manager.api.property.getLease({ params: { ...O(), leaseId: draft.id } })).lease.status,
    ).toBe("draft");
  });
  it("records payment provenance without sending messages or altering access permissions", async () => {
    const before = await S.sql("SELECT id FROM contact_messages WHERE org_id=$1", [X.orgId]);
    const p = await X.staff.accountant.api.property.recordPayment({
      params: O(),
      body: { tenantId, date: "2026-10-25", amountMinor: 1000, method: "bank_transfer", reference: "ACTIVITY-TEST-01" },
    });
    const detail = await X.admin.api.contacts.getContact({ params: { ...O(), contactId: tenantId } });
    expect(detail.activities.find((a) => a.refId === p.id)).toMatchObject({
      sourceProduct: "property",
      eventType: "property.payment.recorded",
      kind: "payment",
    });
    expect(await S.sql("SELECT id FROM contact_messages WHERE org_id=$1", [X.orgId])).toHaveLength(before.length);
  });
  it("checks product access on each read, including existing sessions after revocation", async () => {
    const reader = await S.addMember(X.orgId, X.admin.api, "viewer");
    const update = (productRoles: { agency: "leasing_agent"; property?: "property_manager" }) =>
      X.admin.api.organisations.updateMember({ params: { ...O(), userId: reader.userId }, body: { productRoles } });
    await update({ agency: "leasing_agent" });
    const get = () => reader.api.contacts.getContact({ params: { ...O(), contactId: tenantId } });
    expect((await get()).activities.some((a) => a.sourceProduct === "property")).toBe(false);
    await update({ agency: "leasing_agent", property: "property_manager" });
    expect((await get()).activities.some((a) => a.sourceProduct === "property")).toBe(true);
    await update({ agency: "leasing_agent" });
    expect((await get()).activities.some((a) => a.sourceProduct === "property")).toBe(false);
  });
  it("keeps property-scoped managers on assigned lease activities; hides aggregate payment events", async () => {
    const manager = await S.addMember(X.orgId, X.admin.api, "main_manager");
    await S.sql(
      "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.read','contacts.read','property.tenants.view'],ARRAY[$3]::text[],$4)",
      [X.orgId, manager.userId, B.propertyId, X.admin.userId],
    );
    const r = await manager.api.contacts.getContact({ params: { ...O(), contactId: tenantId } });
    expect(r.activities.some((a) => a.eventType === "property.lease.activated")).toBe(true);
    expect(r.activities.some((a) => a.eventType === "property.payment.recorded")).toBe(false);
    const outsider = await pmOrg(S);
    await refused(
      outsider.admin.api.contacts.getContact({ params: { orgId: outsider.orgId, contactId: tenantId } }),
      404,
    );
  });
  it("does not allow a public note to forge verified product provenance", async () => {
    const path = `/api/v1/orgs/${X.orgId}/contacts/${tenantId}/activities`;
    const r = await S.raw(
      "POST",
      path,
      {
        kind: "note",
        text: "Operator note",
        sourceProduct: "security",
        eventType: "owner.biometric.bypass",
        eventKey: "forged",
      },
      X.admin.token,
    );
    expect(r.status).toBe(201);
    expect(r.body.sourceProduct ?? r.body.activity?.sourceProduct ?? null).toBe(null);
    const rows = await S.sql("SELECT source_product FROM contact_activities WHERE org_id=$1 AND text='Operator note'", [
      X.orgId,
    ]);
    expect(rows[0].source_product).toBe(null);
  });
});
