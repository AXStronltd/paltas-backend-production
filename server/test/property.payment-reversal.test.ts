import { beforeAll, afterAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer,
  orgId: string,
  admin: Person,
  approver: Person,
  tenantId: string,
  invoiceId: string,
  secondUnit: string;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-17");
  const o = await pmOrg(S);
  orgId = o.orgId;
  admin = o.admin;
  approver = o.staff.finance_director;
  const b = await setUpBuilding(orgId, admin);
  secondUnit = Object.values(b.units)[1]!;
  tenantId = await newTenant(admin, orgId, "Correction Tenant");
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: {
      unitId: Object.values(b.units)[0]!,
      tenantId,
      startDate: "2026-10-01",
      rentMinor: 12500000,
      depositMinor: 0,
      depositMode: "none",
      dueDay: 5,
    },
  });
  const a = await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-17", billFirstRent: true },
  });
  invoiceId = a.firstRentInvoice!.id;
});
afterAll(() => S.close());
it("requires two people; restores invoice balance, ledger and statement without deleting history", async () => {
  const p = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-17", amountMinor: 5000000, method: "bank_transfer", reference: "CORRECT-001" },
  });
  await admin.api.property.requestPaymentReversal({
    params: { orgId, paymentId: p.id },
    body: { reason: "Wrong receipt entered in staging test" },
  });
  await refused(admin.api.property.approvePaymentReversal({ params: { orgId, paymentId: p.id } }), 403);
  const r = await approver.api.property.approvePaymentReversal({ params: { orgId, paymentId: p.id } });
  expect(r.reversal?.approvedBy).toBeTruthy();
  const inv = await admin.api.property.getInvoice({ params: { orgId, invoiceId } });
  expect(inv.balanceMinor).toBe(12500000);
  const d = await admin.api.property.dashboard({ params: { orgId } });
  for (const v of Object.values(d.ledger)) expect(v.agrees).toBe(true);
  const statement = await admin.api.property.tenantStatement({ params: { orgId, tenantId } });
  expect(statement.lines.some((x) => x.kind === "receipt reversal")).toBe(true);
  expect(statement.lines.at(-1)?.balanceMinor).toBe(12500000);
  expect(await S.sql("SELECT id FROM pm_payments WHERE id=$1", [p.id])).toHaveLength(1);
  expect(await S.sql("SELECT id FROM pm_allocations WHERE payment_id=$1", [p.id])).toHaveLength(1);
  await refused(approver.api.property.approvePaymentReversal({ params: { orgId, paymentId: p.id } }), 409);
  // A fresh receipt can settle the reopened invoice; the original reference stays reserved.
  const replacement = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-17", amountMinor: 12500000, method: "bank_transfer", reference: "CORRECT-002" },
  });
  expect(replacement.allocatedMinor).toBe(12500000);
});
it("isolates companies and denies viewers", async () => {
  const p = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-17", amountMinor: 10000, method: "cash", reference: "CORRECT-003" },
  });
  const other = await pmOrg(S);
  await refused(
    other.admin.api.property.requestPaymentReversal({
      params: { orgId, paymentId: p.id },
      body: { reason: "Foreign receipt" },
    }),
    404,
  );
  const o = await S.addMember(orgId, admin.api, "viewer");
  await refused(
    o.api.property.requestPaymentReversal({
      params: { orgId, paymentId: p.id },
      body: { reason: "Unauthorised attempt" },
    }),
    403,
  );
});
it("refuses matched receipts and spent tenant credit", async () => {
  const p = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-17", amountMinor: 10000, method: "bank_transfer", reference: "MATCHED-RECEIPT" },
  });
  await approver.api.property.importBankLines({
    params: { orgId },
    body: {
      statement: "Synthetic test statement",
      lines: [
        { date: "2026-10-17", amountMinor: 10000, reference: "MATCHED-RECEIPT", description: "Synthetic bank line" },
      ],
    },
  });
  await refused(
    admin.api.property.requestPaymentReversal({
      params: { orgId, paymentId: p.id },
      body: { reason: "Cannot reverse confirmed funds" },
    }),
    409,
  );
  const t = await newTenant(admin, orgId, "Credit Use Tenant");
  const credit = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId: t, date: "2026-10-17", amountMinor: 10000, method: "cash", reference: "USED-CREDIT" },
  });
  const lease = await admin.api.property.createLease({
    params: { orgId },
    body: {
      unitId: secondUnit,
      tenantId: t,
      startDate: "2026-10-01",
      rentMinor: 10000,
      depositMinor: 0,
      depositMode: "none",
      dueDay: 5,
    },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: lease.id },
    body: { signedOn: "2026-10-17", billFirstRent: true },
  });
  await admin.api.property.applyCredit({ params: { orgId, tenantId: t } });
  await admin.api.property.requestPaymentReversal({
    params: { orgId, paymentId: credit.id },
    body: { reason: "Credit was already used" },
  });
  await refused(approver.api.property.approvePaymentReversal({ params: { orgId, paymentId: credit.id } }), 409);
  expect(
    (await admin.api.property.getPayment({ params: { orgId, paymentId: credit.id } })).reversal?.approvedBy,
  ).toBeNull();
});
it("rolls back a correction when its accounting period is closed", async () => {
  const p = await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-17", amountMinor: 10000, method: "cash", reference: "CORRECT-004" },
  });
  await admin.api.property.requestPaymentReversal({
    params: { orgId, paymentId: p.id },
    body: { reason: "Check closed period protection" },
  });
  await approver.api.ledger.closePeriod({
    params: { orgId, month: "2026-10" },
    body: { reason: "Synthetic test close" },
  });
  await refused(approver.api.property.approvePaymentReversal({ params: { orgId, paymentId: p.id } }), 409);
  expect((await admin.api.property.getPayment({ params: { orgId, paymentId: p.id } })).reversal?.approvedBy).toBeNull();
});

it("keeps historic collections in their original month and reports the correction in its approval month", async () => {
  const other = await pmOrg(S);
  const params = { orgId: other.orgId };
  const building = await setUpBuilding(other.orgId, other.admin);
  const tenant = await newTenant(other.admin, other.orgId, "Cross Month Tenant");
  const lease = await other.admin.api.property.createLease({
    params,
    body: {
      unitId: Object.values(building.units)[0]!,
      tenantId: tenant,
      startDate: "2026-10-01",
      rentMinor: 100000,
      depositMinor: 0,
      depositMode: "none",
      dueDay: 5,
    },
  });
  await other.admin.api.property.activateLease({
    params: { ...params, leaseId: lease.id },
    body: { signedOn: "2026-10-17", billFirstRent: true },
  });
  const pay = await other.admin.api.property.recordPayment({
    params,
    body: { tenantId: tenant, date: "2026-10-17", amountMinor: 50000, method: "cash", reference: "CROSS-MONTH" },
  });
  await other.admin.api.property.requestPaymentReversal({
    params: { ...params, paymentId: pay.id },
    body: { reason: "Incorrect receipt corrected next month" },
  });
  S.setToday("2026-11-01");
  try {
    await other.staff.finance_director.api.property.approvePaymentReversal({
      params: { ...params, paymentId: pay.id },
    });
    expect((await other.admin.api.property.dashboard({ params, query: { month: "2026-10" } })).collectedMinor).toBe(
      50000,
    );
    expect((await other.admin.api.property.dashboard({ params, query: { month: "2026-11" } })).collectedMinor).toBe(
      -50000,
    );
  } finally {
    S.setToday("2026-10-17");
  }
});

it("retains a rejection reason and allows a fresh audited review", async () => {
  const o = await pmOrg(S);
  const params = { orgId: o.orgId };
  const t = await newTenant(o.admin, o.orgId, "Rejected Correction Tenant");
  const pay = await o.admin.api.property.recordPayment({
    params,
    body: { tenantId: t, date: "2026-10-17", amountMinor: 10000, method: "cash", reference: "REJECT-REVIEW" },
  });
  const p = { ...params, paymentId: pay.id };
  await o.admin.api.property.requestPaymentReversal({ params: p, body: { reason: "First request" } });
  const rejected = await o.staff.finance_director.api.property.rejectPaymentReversal({
    params: p,
    body: { reason: "Receipt confirmed correct" },
  });
  expect(rejected.reversal?.rejectedReason).toBe("Receipt confirmed correct");
  await refused(o.staff.finance_director.api.property.approvePaymentReversal({ params: p }), 409);
  const pending = await o.admin.api.property.requestPaymentReversal({
    params: p,
    body: { reason: "New evidence requires review" },
  });
  expect(pending.reversal?.rejectedReason).toBeNull();
  const results = await Promise.allSettled([
    o.staff.finance_director.api.property.approvePaymentReversal({ params: p }),
    o.staff.accountant.api.property.approvePaymentReversal({ params: p }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await o.admin.api.property.getPayment({ params: p })).reversal?.approvedBy).toBeTruthy();
});
