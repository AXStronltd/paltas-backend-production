import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant, tbBalance } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  reviewer: Person,
  requester: Person,
  leaseId: string,
  tenantId: string,
  first: P.DepositRefund;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-01");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  reviewer = o.staff.accountant;
  requester = o.staff.finance_director;
  const b = await setUpBuilding(orgId, admin);
  tenantId = await newTenant(admin, orgId, "Partial deposit tenant");
  const lease = await admin.api.property.createLease({
    params: { orgId },
    body: {
      unitId: b.units["A-101"]!,
      tenantId,
      startDate: "2026-10-01",
      rentMinor: 50000,
      depositMinor: 100000,
      depositMode: "collect",
    },
  });
  leaseId = lease.id;
  const active = await admin.api.property.activateLease({
    params: { orgId, leaseId },
    body: { signedOn: "2026-10-01", billFirstRent: false },
  });
  await admin.api.property.recordPayment({
    params: { orgId },
    body: {
      tenantId,
      date: "2026-10-01",
      amountMinor: 100000,
      method: "bank_transfer",
      reference: "DEPOSIT-COLLECTED",
      allocations: [{ invoiceId: active.depositInvoice!.id, amountMinor: 100000 }],
    },
  });
  await admin.api.property.giveNotice({
    params: { orgId, leaseId },
    body: { noticeDate: "2026-10-01", moveOutDate: "2026-10-31" },
  });
  S.setToday("2026-10-31");
  await admin.api.property.terminateLease({
    params: { orgId, leaseId },
    body: { moveOutDate: "2026-10-31", reason: "Agreed move-out for synthetic test" },
  });
});
afterAll(() => S.close());
it("previews a partial release and retains the rest without posting until independent approval", async () => {
  await refused(
    requester.api.property.requestDepositRefund({
      params: { orgId, leaseId },
      body: { settlementMinor: 100001, applyToArrears: false, refundReference: "TOO-LARGE" },
    }),
    400,
  );
  first = await requester.api.property.requestDepositRefund({
    params: { orgId, leaseId },
    body: {
      settlementMinor: 40000,
      applyToArrears: false,
      deductions: [{ amountMinor: 5000, reason: "Approved cleaning deduction" }],
      refundReference: "PARTIAL-REFUND-1",
    },
  });
  expect(first).toMatchObject({
    availableHeldMinor: 100000,
    heldMinor: 40000,
    retainedMinor: 60000,
    refundMinor: 35000,
    status: "requested",
  });
  expect(await tbBalance(admin, orgId, "2300")).toBe(-100000);
  await refused(
    requester.api.property.requestDepositRefund({
      params: { orgId, leaseId },
      body: { settlementMinor: 10000, applyToArrears: false, refundReference: "DUPLICATE-PENDING" },
    }),
    409,
  );
  await refused(requester.api.property.approveDepositRefund({ params: { orgId, refundId: first.id } }), 403);
  first = await reviewer.api.property.approveDepositRefund({ params: { orgId, refundId: first.id } });
  expect(first.status).toBe("approved");
  expect(await tbBalance(admin, orgId, "2300")).toBe(-60000);
  expect((await admin.api.property.getLease({ params: { orgId, leaseId } })).lease.depositHeldMinor).toBe(60000);
  const statement = await admin.api.property.tenantStatement({ params: { orgId, tenantId } });
  expect(statement.depositHeldMinor).toBe(60000);
});
it("allows another request after partial approval but serialises simultaneous requests", async () => {
  const args = {
    params: { orgId, leaseId },
    body: { settlementMinor: 20000, applyToArrears: false, refundReference: "PARTIAL-REVIEW-2" },
  };
  const r = await Promise.allSettled([
    requester.api.property.requestDepositRefund(args),
    requester.api.property.requestDepositRefund(args),
  ]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
  const pending = r.find((x): x is PromiseFulfilledResult<P.DepositRefund> => x.status === "fulfilled")!.value;
  expect(pending.availableHeldMinor).toBe(60000);
  expect(pending.retainedMinor).toBe(40000);
  await reviewer.api.property.rejectDepositRefund({
    params: { orgId, refundId: pending.id },
    body: { reason: "Tenant requested the final release instead" },
  });
  expect((await admin.api.property.getLease({ params: { orgId, leaseId } })).lease.depositHeldMinor).toBe(60000);
});
it("settles the remainder using the existing full-balance contract and preserves both approved records", async () => {
  const final = await requester.api.property.requestDepositRefund({
    params: { orgId, leaseId },
    body: { applyToArrears: false, refundReference: "FINAL-REFUND-3" },
  });
  expect(final).toMatchObject({ availableHeldMinor: 60000, heldMinor: 60000, retainedMinor: 0, refundMinor: 60000 });
  await reviewer.api.property.approveDepositRefund({ params: { orgId, refundId: final.id } });
  expect(await tbBalance(admin, orgId, "2300")).toBe(0);
  const history = await admin.api.property.listDepositRefunds({ params: { orgId } });
  expect(history.refunds.filter((x) => x.status === "approved")).toHaveLength(2);
  expect(history.refunds.find((x) => x.id === first.id)?.retainedMinor).toBe(60000);
  const dashboard = await admin.api.property.dashboard({ params: { orgId } });
  expect(Object.values(dashboard.ledger).every((x) => x.agrees)).toBe(true);
  await refused(
    requester.api.property.requestDepositRefund({
      params: { orgId, leaseId },
      body: { applyToArrears: false, refundReference: "NO-DEPOSIT-LEFT" },
    }),
    409,
  );
  await refused(reviewer.api.property.approveDepositRefund({ params: { orgId, refundId: final.id } }), 409);
});
it("keeps legacy snapshot-free responses compatible and rejects cross-organisation access", async () => {
  const foreign = await pmOrg(S);
  await refused(foreign.admin.api.property.approveDepositRefund({ params: { orgId, refundId: first.id } }), 404);
  await S.sql("UPDATE pm_deposit_refunds SET available_held_minor=NULL WHERE id=$1", [first.id]);
  const h = await admin.api.property.listDepositRefunds({ params: { orgId } });
  expect(h.refunds.find((x) => x.id === first.id)).toMatchObject({
    availableHeldMinor: 40000,
    heldMinor: 40000,
    retainedMinor: 0,
  });
  expect((await admin.api.property.getLease({ params: { orgId, leaseId } })).lease.depositHeldMinor).toBe(0);
});
