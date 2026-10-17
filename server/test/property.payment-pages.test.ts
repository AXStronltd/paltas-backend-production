import { afterAll, beforeAll, expect, it } from "vitest";
import { startPropertyServer, pmOrg, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
let S: TestServer, orgId: string, admin: Person, tenantId: string;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-17");
  const o = await pmOrg(S);
  orgId = o.orgId;
  admin = o.admin;
  tenantId = await newTenant(admin, orgId, "Payment Page Tenant");
  for (let n = 1; n <= 3; n++)
    await admin.api.property.recordPayment({
      params: { orgId },
      body: { tenantId, date: "2026-10-17", amountMinor: 10000, method: "cash", reference: "PAGE-" + n },
    });
});
afterAll(() => S.close());
it("pages deterministically with counts and no overlapping receipts", async () => {
  const first = await admin.api.property.listPayments({ params: { orgId }, query: { limit: 2, offset: 0 } });
  const second = await admin.api.property.listPayments({ params: { orgId }, query: { limit: 2, offset: 2 } });
  expect(first.total).toBe(3);
  expect(first.payments).toHaveLength(2);
  expect(second.payments).toHaveLength(1);
  expect(new Set([...first.payments, ...second.payments].map((x) => x.id)).size).toBe(3);
  const detail = await admin.api.property.getPayment({ params: { orgId, paymentId: first.payments[0]!.id } });
  expect(detail.receiptNumber).toBe(first.payments[0]!.receiptNumber);
});
it("retains legacy complete statements and isolates page totals", async () => {
  expect((await admin.api.property.listPayments({ params: { orgId } })).payments).toHaveLength(3);
  const other = await pmOrg(S);
  await refused(other.admin.api.property.listPayments({ params: { orgId }, query: { limit: 2 } }), 404);
  expect(
    (await other.admin.api.property.listPayments({ params: { orgId: other.orgId }, query: { limit: 2 } })).total,
  ).toBe(0);
});

it("bounds the returned page for a thousand-receipt synthetic portfolio", async () => {
  const tenant = await newTenant(admin, orgId, "Volume Test Tenant");
  await S.sql(
    "INSERT INTO pm_payments(id,org_id,number,receipt_number,tenant_id,date,amount_minor,method,reference,recorded_by) SELECT 'volume-'||$1||'-'||n,$1,'V-'||n,'VR-'||n,$2,'2026-10-17',100,'cash','volume-'||n,$3 FROM generate_series(1,1000) n",
    [
      orgId,
      tenant,
      (
        await S.sql(
          "SELECT id FROM users WHERE id IN (SELECT user_id FROM memberships WHERE org_id=$1 AND role='org_admin')",
          [orgId],
        )
      )[0]!.id,
    ],
  );
  const page = await admin.api.property.listPayments({
    params: { orgId },
    query: { tenantId: tenant, limit: 50, offset: 950 },
  });
  expect(page.total).toBe(1000);
  expect(page.payments).toHaveLength(50);
});
