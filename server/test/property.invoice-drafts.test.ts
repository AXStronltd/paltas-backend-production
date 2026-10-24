import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  reviewer: Person,
  input: P.InvoiceDraftInput,
  draft: P.InvoiceDraft,
  chargeId: string;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  reviewer = o.staff.property_manager;
  const b = await setUpBuilding(orgId, admin);
  const tenantId = await newTenant(admin, orgId, "Draft Workflow Tenant");
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000 },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: false },
  });
  const charge = await admin.api.property.createChargeType({
    params: { orgId },
    body: { code: "CLEAN", name: "Cleaning", payee: "owner", rateMinor: 1000 },
  });
  chargeId = charge.id;
  input = {
    leaseId: l.id,
    dueDate: "2026-11-01",
    note: "Reviewed services",
    lines: [
      { chargeTypeId: chargeId, description: "Cleaning", quantity: 2.5, rateMinor: 1000 },
      { chargeTypeId: chargeId, description: "Extra cleaning", quantity: 1, rateMinor: 2000 },
    ],
  };
});
afterAll(() => S.close());
it("saves and repeatedly edits drafts without creating invoices or accounting entries", async () => {
  draft = await admin.api.property.createInvoiceDraft({ params: { orgId }, body: input });
  expect(draft.status).toBe("draft");
  const before = await admin.api.property.listInvoices({ params: { orgId } });
  expect(before.invoices).toHaveLength(0);
  for (const note of ["First correction", "Second correction"]) {
    draft = await admin.api.property.updateInvoiceDraft({
      params: { orgId, draftId: draft.id },
      body: { expectedVersion: draft.version, input: { ...input, note } },
    });
    expect(draft.input.note).toBe(note);
  }
  await refused(
    admin.api.property.updateInvoiceDraft({
      params: { orgId, draftId: draft.id },
      body: { expectedVersion: 1, input },
    }),
    409,
  );
  expect((await admin.api.property.listInvoiceDrafts({ params: { orgId } })).drafts[0]?.version).toBe(3);
});
it("requires independent approval and explicit issuance; concurrent retries issue once", async () => {
  await refused(
    admin.api.property.invoiceDraftAction({
      params: { orgId, draftId: draft.id },
      body: { action: "approve", expectedVersion: draft.version, reason: "Review" },
    }),
    403,
  );
  draft = await reviewer.api.property.invoiceDraftAction({
    params: { orgId, draftId: draft.id },
    body: { action: "approve", expectedVersion: draft.version, reason: "Verified services" },
  });
  await refused(
    admin.api.property.invoiceDraftAction({
      params: { orgId, draftId: draft.id },
      body: { action: "issue", expectedVersion: draft.version, reason: "Issue invoice" },
    }),
    400,
  );
  const request = {
    params: { orgId, draftId: draft.id },
    body: { action: "issue" as const, expectedVersion: draft.version, reason: "Approved for issue", confirm: "ISSUE" },
  };
  const [a, b] = await Promise.all([
    admin.api.property.invoiceDraftAction(request),
    admin.api.property.invoiceDraftAction(request),
  ]);
  expect(a.invoiceId).toBe(b.invoiceId);
  draft = a;
  const inv = await admin.api.property.getInvoice({ params: { orgId, invoiceId: a.invoiceId! } });
  expect(inv.amountMinor).toBe(4500);
  expect(inv.lines).toHaveLength(2);
  expect((await admin.api.property.listInvoices({ params: { orgId } })).invoices).toHaveLength(1);
  const dash = await admin.api.property.dashboard({ params: { orgId } });
  expect(Object.values(dash.ledger).every((x) => x.agrees)).toBe(true);
  await refused(
    admin.api.property.deleteInvoiceDraft({
      params: { orgId, draftId: draft.id },
      body: { expectedVersion: draft.version, reason: "Cannot delete issued records" },
    }),
    409,
  );
  await refused(
    admin.api.property.updateInvoiceDraft({
      params: { orgId, draftId: draft.id },
      body: { expectedVersion: draft.version, input },
    }),
    409,
  );
});
it("archives and restores unissued drafts, deletes eligible drafts with an audit trail", async () => {
  let r = await admin.api.property.createInvoiceDraft({ params: { orgId }, body: input });
  r = await admin.api.property.invoiceDraftAction({
    params: { orgId, draftId: r.id },
    body: { expectedVersion: r.version, action: "archive", reason: "Not needed yet" },
  });
  expect(r.status).toBe("archived");
  r = await admin.api.property.invoiceDraftAction({
    params: { orgId, draftId: r.id },
    body: { expectedVersion: r.version, action: "restore", reason: "Services now required" },
  });
  expect(r.status).toBe("draft");
  await admin.api.property.deleteInvoiceDraft({
    params: { orgId, draftId: r.id },
    body: { expectedVersion: r.version, reason: "Duplicate draft removed" },
  });
  expect((await admin.api.property.listInvoiceDrafts({ params: { orgId } })).drafts.some((x) => x.id === r.id)).toBe(
    false,
  );
  expect(
    (
      await S.sql("SELECT id FROM audit_log WHERE org_id=$1 AND target=$2 AND action='Invoice draft deleted'", [
        orgId,
        r.id,
      ])
    ).length,
  ).toBe(1);
});
it("rechecks changed category terms and preserves approval on failed issue without posting", async () => {
  let r = await admin.api.property.createInvoiceDraft({ params: { orgId }, body: input });
  r = await reviewer.api.property.invoiceDraftAction({
    params: { orgId, draftId: r.id },
    body: { expectedVersion: r.version, action: "approve", reason: "Reviewed" },
  });
  await admin.api.property.updateChargeType({
    params: { orgId, chargeTypeId: chargeId },
    body: { name: "Updated cleaning name" },
  });
  await refused(
    admin.api.property.invoiceDraftAction({
      params: { orgId, draftId: r.id },
      body: { expectedVersion: r.version, action: "issue", reason: "Attempt issue", confirm: "ISSUE" },
    }),
    409,
  );
  const saved = (await admin.api.property.listInvoiceDrafts({ params: { orgId } })).drafts.find((x) => x.id === r.id);
  expect(saved?.status).toBe("approved");
  expect(saved?.invoiceId).toBeNull();
  expect((await admin.api.property.listInvoices({ params: { orgId } })).invoices).toHaveLength(1);
});
it("isolates other organisations and refuses unauthorised operators", async () => {
  const other = await pmOrg(S);
  await refused(other.admin.api.property.listInvoiceDrafts({ params: { orgId } }), 404);
  await refused(
    other.admin.api.property.updateInvoiceDraft({
      params: { orgId: other.orgId, draftId: draft.id },
      body: { expectedVersion: draft.version, input },
    }),
    404,
  );
  const tech = await S.addMember(orgId, admin.api, "technician");
  await refused(tech.api.property.createInvoiceDraft({ params: { orgId }, body: input }), 403);
});

it("limits delegated draft lists and direct edits to assigned properties", async () => {
  const lease = await admin.api.property.getLease({ params: { orgId, leaseId: input.leaseId } });
  const manager = await S.addMember(orgId, admin.api, "main_manager");
  await S.sql(
    "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.billing','property.read','property.tenants.history'],ARRAY[$3]::text[],$4)",
    [orgId, manager.userId, lease.lease.propertyId, admin.userId],
  );
  const allowed = await manager.api.property.listInvoiceDrafts({ params: { orgId }, query: { limit: 1, offset: 0 } });
  expect(allowed.drafts).toHaveLength(1);
  expect(allowed.total).toBeGreaterThan(1);
  const other = await setUpBuilding(orgId, admin, { name: "Unassigned drafts property" });
  const t = await newTenant(admin, orgId, "Other draft tenant");
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: other.units["A-101"]!, tenantId: t, startDate: "2026-10-01", rentMinor: 100000 },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: false },
  });
  const d = await admin.api.property.createInvoiceDraft({ params: { orgId }, body: { ...input, leaseId: l.id } });
  await refused(
    manager.api.property.updateInvoiceDraft({
      params: { orgId, draftId: d.id },
      body: { expectedVersion: d.version, input: { ...input, leaseId: l.id } },
    }),
    404,
  );
  expect((await manager.api.property.listInvoiceDrafts({ params: { orgId } })).drafts.some((x) => x.id === d.id)).toBe(
    false,
  );
});

it("rounds fractional quantities exactly and rejects silently truncated quantities or zero-value lines", async () => {
  const exact = {
    ...input,
    lines: [{ chargeTypeId: chargeId, description: "Fractional charge", quantity: 1.005, rateMinor: 100 }],
  };
  const saved = await admin.api.property.createInvoiceDraft({ params: { orgId }, body: exact });
  expect(saved.totalMinor).toBe(101);
  expect(saved.lineAmountsMinor).toEqual([101]);
  await refused(
    admin.api.property.createInvoiceDraft({
      params: { orgId },
      body: { ...exact, lines: [{ ...exact.lines[0]!, quantity: 1.0001 }] },
    }),
    400,
  );
  await refused(
    admin.api.property.createInvoiceDraft({
      params: { orgId },
      body: { ...exact, lines: [{ ...exact.lines[0]!, quantity: 0.001, rateMinor: 1 }] },
    }),
    400,
  );
});
