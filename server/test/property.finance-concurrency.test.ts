import { afterAll, beforeAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import type { TestServer } from "./support/test-server.js";
let S: TestServer;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-17");
});
afterAll(() => S.close());
it("records twenty simultaneous receipts without over-allocation or ledger drift", async () => {
  const o = await pmOrg(S),
    params = { orgId: o.orgId },
    b = await setUpBuilding(o.orgId, o.admin),
    tenantId = await newTenant(o.admin, o.orgId, "Concurrent Finance Tenant");
  const lease = await o.admin.api.property.createLease({
    params,
    body: {
      unitId: Object.values(b.units)[0]!,
      tenantId,
      startDate: "2026-10-01",
      rentMinor: 125000,
      depositMinor: 0,
      depositMode: "none",
      dueDay: 5,
    },
  });
  const activated = await o.admin.api.property.activateLease({
    params: { ...params, leaseId: lease.id },
    body: { signedOn: "2026-10-17", billFirstRent: true },
  });
  const start = Date.now();
  const receipts = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      o.admin.api.property.recordPayment({
        params,
        body: {
          tenantId,
          date: "2026-10-17",
          amountMinor: 10000,
          method: "bank_transfer",
          reference: "CONCURRENT-" + n,
        },
      }),
    ),
  );
  expect(new Set(receipts.map((r) => r.receiptNumber)).size).toBe(20);
  expect(receipts.reduce((n, r) => n + r.allocatedMinor, 0)).toBe(125000);
  const invoice = await o.admin.api.property.getInvoice({
    params: { ...params, invoiceId: activated.firstRentInvoice!.id },
  });
  expect(invoice.balanceMinor).toBe(0);
  const statement = await o.admin.api.property.tenantStatement({ params: { ...params, tenantId } });
  expect(statement.creditMinor).toBe(75000);
  const dashboard = await o.admin.api.property.dashboard({ params });
  for (const check of Object.values(dashboard.ledger)) expect(check.agrees).toBe(true);
  console.log(
    "Twenty concurrent receipt requests completed in " +
      (Date.now() - start) +
      " ms on disposable local PostgreSQL; not a production throughput benchmark",
  );
});
