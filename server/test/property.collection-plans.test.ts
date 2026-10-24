import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
import { collectionPlanProgress } from "../dist/products/property/billing/collection-plans.service.js";
let S: TestServer,
  orgId: string,
  admin: Person,
  tenant: Person,
  other: Person,
  tenantId: string,
  invoiceId: string,
  plan: P.CollectionPlan,
  receiptId: string;
const schedule = [
  { dueDate: "2026-10-26", amountMinor: 40000 },
  { dueDate: "2026-11-05", amountMinor: 60000 },
];
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  const b = await setUpBuilding(orgId, admin);
  tenant = await S.addMember(orgId, admin.api, "tenant");
  other = await S.addMember(orgId, admin.api, "tenant");
  tenantId = await newTenant(admin, orgId, "Repayment tenant");
  const otherId = await newTenant(admin, orgId, "Other repayment tenant");
  await admin.api.contacts.updateContact({ params: { orgId, contactId: tenantId }, body: { userId: tenant.userId } });
  await admin.api.contacts.updateContact({ params: { orgId, contactId: otherId }, body: { userId: other.userId } });
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000 },
  });
  const active = await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: true },
  });
  invoiceId = active.firstRentInvoice!.id;
});
afterAll(() => S.close());
it("calculates instalment ageing and partial progress without rounding or new postings", () => {
  expect(collectionPlanProgress(schedule, 45000, "2026-11-06")).toMatchObject({
    overdueMinor: 55000,
    instalments: [
      { status: "settled", settledMinor: 40000, remainingMinor: 0 },
      { status: "partial", settledMinor: 5000, remainingMinor: 55000 },
    ],
  });
});
it("lets the tenant propose a balanced plan without creating another invoice", async () => {
  plan = await tenant.api.property.tenantCreateCollectionPlan({
    params: { orgId },
    body: {
      invoiceId,
      kind: "repayment",
      schedule,
      evidenceRef: "Tenant requested arrangement",
      note: "Review these dates",
    },
  });
  expect(plan.status).toBe("proposed");
  expect(plan.settledMinor).toBe(0);
  expect((await admin.api.property.listInvoices({ params: { orgId } })).invoices).toHaveLength(1);
  await refused(
    tenant.api.property.tenantCreateCollectionPlan({
      params: { orgId },
      body: { invoiceId, kind: "repayment", schedule, evidenceRef: "Duplicate request" },
    }),
    409,
  );
  expect((await other.api.property.tenantCollectionPlans({ params: { orgId } })).plans).toHaveLength(0);
  await refused(
    other.api.property.tenantCreateCollectionPlan({
      params: { orgId },
      body: { invoiceId, kind: "repayment", schedule, evidenceRef: "Not my invoice" },
    }),
    404,
  );
});
it("allows repeated tenant proposal edits but rejects another tenant and approved-plan control", async () => {
  await refused(
    other.api.property.tenantUpdateCollectionPlan({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, input: plan.input },
    }),
    404,
  );
  plan = await tenant.api.property.tenantUpdateCollectionPlan({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, input: { ...plan.input, note: "Tenant corrected the dates reference" } },
  });
  plan = await tenant.api.property.tenantUpdateCollectionPlan({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, input: { ...plan.input, note: "Tenant reviewed again" } },
  });
  await refused(
    tenant.api.property.tenantCollectionPlanAction({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, action: "approve", reason: "Cannot self approve as tenant" },
    }),
    403,
  );
  expect(plan.events.filter((x) => x.action === "edited")).toHaveLength(2);
});
it("rejects unbalanced proposals and stale edits; approves reviewed dates against the original balance", async () => {
  await refused(
    admin.api.property.updateCollectionPlan({
      params: { orgId, planId: plan.id },
      body: {
        expectedVersion: plan.version,
        input: { ...plan.input, schedule: [{ dueDate: "2026-11-01", amountMinor: 100 }] },
      },
    }),
    409,
  );
  plan = await admin.api.property.updateCollectionPlan({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, input: { ...plan.input, note: "Dates reviewed with tenant" } },
  });
  await refused(
    admin.api.property.collectionPlanAction({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: 1, action: "approve", reason: "Stale approval attempt" },
    }),
    409,
  );
  plan = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, action: "approve", reason: "Tenant agreement independently reviewed" },
  });
  expect(plan.status).toBe("active");
  await refused(
    tenant.api.property.tenantCollectionPlanAction({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, action: "cancel", reason: "Tenant cannot cancel approved terms" },
    }),
    403,
  );
  await refused(
    admin.api.property.updateCollectionPlan({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, input: plan.input },
    }),
    409,
  );
});
it("tracks partial payments, pauses and resumes without changing the original invoice or lease", async () => {
  const payment = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-25", amountMinor: 45000, method: "bank_transfer", reference: "PLAN-PARTIAL" },
  });
  receiptId = payment.id;
  plan = (await tenant.api.property.tenantCollectionPlans({ params: { orgId } })).plans[0]!;
  expect(plan.settledMinor).toBe(45000);
  expect(plan.instalments[1]?.remainingMinor).toBe(55000);
  expect(plan.invoiceBalanceMinor).toBe(55000);
  plan = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, action: "pause", reason: "Further contact requested" },
  });
  expect(plan.status).toBe("paused");
  plan = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, action: "resume", reason: "Tenant confirmed the dates" },
  });
  await refused(
    admin.api.property.collectionPlanAction({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, action: "complete", reason: "Cannot complete unpaid debt" },
    }),
    409,
  );
});
it("counts approved credits as settlement, completes only at zero balance and flags later reversals", async () => {
  await admin.api.property.createCreditNote({
    params: { orgId, invoiceId },
    body: { amountMinor: 55000, reason: "Approved concession on original rent invoice" },
  });
  plan = (await tenant.api.property.tenantCollectionPlans({ params: { orgId } })).plans[0]!;
  expect(plan.settledMinor).toBe(100000);
  expect(plan.instalments.every((x) => x.status === "settled")).toBe(true);
  plan = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: {
      expectedVersion: plan.version,
      action: "complete",
      reason: "Invoice fully settled with payment and credit",
    },
  });
  expect(plan.status).toBe("completed");
  await admin.api.property.requestPaymentReversal({
    params: { orgId, paymentId: receiptId },
    body: { reason: "Synthetic incorrect receipt" },
  });
  const reviewer = await S.addMember(orgId, admin.api, "finance_director");
  await reviewer.api.property.approvePaymentReversal({ params: { orgId, paymentId: receiptId } });
  plan = (await tenant.api.property.tenantCollectionPlans({ params: { orgId } })).plans[0]!;
  expect(plan.reviewRequired).toBe(true);
  expect(plan.invoiceBalanceMinor).toBe(45000);
  expect(plan.status).toBe("completed");
  const d = await admin.api.property.dashboard({ params: { orgId } });
  expect(Object.values(d.ledger).every((x) => x.agrees)).toBe(true);
});
it("preserves history when reopening a reversed balance and allows a single-date promise", async () => {
  plan = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: {
      expectedVersion: plan.version,
      action: "reopen",
      reason: "Reversed receipt requires a new reviewed schedule",
    },
  });
  expect(plan.status).toBe("proposed");
  plan = await admin.api.property.updateCollectionPlan({
    params: { orgId, planId: plan.id },
    body: {
      expectedVersion: plan.version,
      input: {
        ...plan.input,
        kind: "promise",
        schedule: [{ dueDate: "2026-11-15", amountMinor: 45000 }],
        evidenceRef: "Updated promise from tenant",
      },
    },
  });
  expect(plan.input.kind).toBe("promise");
  expect(plan.events.length).toBeGreaterThan(6);
  const approved = plan.events.find((x) => x.action === "approve");
  expect(approved?.snapshot.input.schedule).toEqual(schedule);
  expect(approved?.snapshot.targetMinor).toBe(100000);
  expect(plan.events.at(-1)?.snapshot.input.schedule).toEqual([{ dueDate: "2026-11-15", amountMinor: 45000 }]);
  await refused(admin.api.property.createCollectionPlan({ params: { orgId }, body: { ...plan.input, schedule } }), 400);
  const foreign = await pmOrg(S);
  await refused(foreign.admin.api.property.listCollectionPlans({ params: { orgId } }), 404);
});

it("permits tenant withdrawal of a proposal while retaining an immutable event history", async () => {
  plan = await tenant.api.property.tenantCollectionPlanAction({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, action: "cancel", reason: "Tenant withdraws unapproved promise" },
  });
  expect(plan.status).toBe("cancelled");
  expect(plan.events.at(-1)?.reason).toBe("Tenant withdraws unapproved promise");
  await refused(
    tenant.api.property.tenantUpdateCollectionPlan({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, input: plan.input },
    }),
    409,
  );
  expect((await admin.api.property.listInvoices({ params: { orgId } })).invoices).toHaveLength(1);
});
it("enforces assigned-property scope, paginated totals, independent manager review and revocation", async () => {
  const building = await setUpBuilding(orgId, admin, { name: "Unassigned plan building" });
  const secondTenant = await newTenant(admin, orgId, "Second property tenant");
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: building.units["A-101"]!, tenantId: secondTenant, startDate: "2026-10-01", rentMinor: 20000 },
  });
  const activated = await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: true },
  });
  const manager = await S.addMember(orgId, admin.api, "main_manager");
  const capabilities = ["property.read", "property.billing", "property.tenants.history"] as const;
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: {
      grants: [
        { product: "property", capabilities: [...capabilities], propertyIds: [building.propertyId], enabled: true },
      ],
      reason: "Assigned only the second building",
      confirm: "SAVE_PERMISSIONS",
    },
  });
  let own = await manager.api.property.createCollectionPlan({
    params: { orgId },
    body: {
      invoiceId: activated.firstRentInvoice!.id,
      kind: "promise",
      schedule: [{ dueDate: "2026-11-01", amountMinor: 20000 }],
      evidenceRef: "Second building repayment request",
    },
  });
  const page = await manager.api.property.listCollectionPlans({ params: { orgId }, query: { limit: 1, offset: 0 } });
  expect(page.total).toBe(1);
  expect(page.plans.map((x) => x.id)).toEqual([own.id]);
  const empty = await manager.api.property.listCollectionPlans({ params: { orgId }, query: { limit: 1, offset: 1 } });
  expect(empty.total).toBe(1);
  expect(empty.plans).toHaveLength(0);
  await refused(
    manager.api.property.collectionPlanAction({
      params: { orgId, planId: plan.id },
      body: { expectedVersion: plan.version, action: "reopen", reason: "Cannot review unassigned property" },
    }),
    404,
  );
  await refused(
    manager.api.property.collectionPlanAction({
      params: { orgId, planId: own.id },
      body: { expectedVersion: own.version, action: "approve", reason: "Cannot approve my own proposal" },
    }),
    403,
  );
  own = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: own.id },
    body: { expectedVersion: own.version, action: "approve", reason: "Company owner reviewed the proposal" },
  });
  expect(own.status).toBe("active");
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: { grants: [], reason: "Delegation revoked immediately", confirm: "SAVE_PERMISSIONS" },
  });
  await refused(manager.api.property.listCollectionPlans({ params: { orgId } }), 404);
});
it("rejects modification or deletion of recorded arrangement snapshots", async () => {
  const events = await S.sql<{ id: string }>(
    "SELECT id FROM pm_collection_plan_events WHERE org_id=$1 AND plan_id=$2 ORDER BY created_at,id",
    [orgId, plan.id],
  );
  expect(events.length).toBeGreaterThan(5);
  await expect(
    S.sql("UPDATE pm_collection_plan_events SET reason='tampered' WHERE id=$1", [events[0]!.id]),
  ).rejects.toThrow();
  await expect(S.sql("DELETE FROM pm_collection_plan_events WHERE id=$1", [events[0]!.id])).rejects.toThrow();
});
