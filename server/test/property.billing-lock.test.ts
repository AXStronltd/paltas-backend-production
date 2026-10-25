import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Db } from "../dist/db/database.js";
import type { property as P } from "@paltas/contracts";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import type { TestServer, Person } from "./support/test-server.js";
let S: TestServer, admin: Person, orgId: string;
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-10-25");
  ({ admin, orgId } = await pmOrg(S));
});
afterAll(() => S.close());

let fixtureCount = 0;
async function fixture() {
  const b = await setUpBuilding(orgId, admin, { name: `Concurrent billing ${++fixtureCount}` });
  const tenantId = await newTenant(admin, orgId, "Concurrent billing tenant");
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000, dueDay: 5 },
  });
  await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: false },
  });
  return { propertyId: b.propertyId, leaseId: l.id };
}
async function waitingRun(propertyId: string, change: (t: Db) => Promise<unknown>) {
  let pending: Promise<P.BillingRunResult> | undefined;
  await S.app.ctx.db.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock(hashtextextended('paltas-pm-finance:' || $1,0))", [orgId]);
    pending = admin.api.property.runBilling({
      params: { orgId },
      body: { propertyId, period: "2026-10", kind: "rent" },
    });
    // Deterministically wait for the real HTTP run to block on the same organisation's financial lock.
    await vi.waitFor(
      async () => {
        const [waiting] = await S.sql<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'",
        );
        expect(waiting?.n).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 10 },
    );
    await change(t);
  });
  if (!pending) throw new Error("Billing request was not started");
  return pending;
}
it("does not bill a lease closed while a run waits for the financial lock", async () => {
  const f = await fixture();
  const r = await waitingRun(f.propertyId, (t) =>
    t.run("UPDATE pm_leases SET status='ended' WHERE org_id=$1 AND id=$2", [orgId, f.leaseId]),
  );
  expect(r.created).toHaveLength(0);
  expect(
    (await admin.api.property.listInvoices({ params: { orgId }, query: { leaseId: f.leaseId } })).invoices,
  ).toHaveLength(0);
});
it("uses the terms committed before the run acquires its lock", async () => {
  const f = await fixture();
  const r = await waitingRun(f.propertyId, async (t) => {
    await t.run("UPDATE pm_leases SET rent_minor=120000,due_day=7 WHERE org_id=$1 AND id=$2", [orgId, f.leaseId]);
    await t.run("UPDATE pm_rent_steps SET rent_minor=120000 WHERE org_id=$1 AND lease_id=$2 AND reason='start'", [
      orgId,
      f.leaseId,
    ]);
  });
  expect(r.created).toHaveLength(1);
  expect(r.created[0]?.amountMinor).toBe(120000);
  expect(r.created[0]?.dueDate).toBe("2026-10-07");
  const again = await admin.api.property.runBilling({
    params: { orgId },
    body: { propertyId: f.propertyId, period: "2026-10", kind: "rent" },
  });
  expect(again.created).toHaveLength(0);
});
