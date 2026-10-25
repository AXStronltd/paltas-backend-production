import { beforeAll, afterAll, it, expect } from "vitest";
import { startHotelServer, hotelOrg, buildHotel, type TestHotel } from "./support/hotel-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";
import type { hotel as H } from "@paltas/contracts";
let S: TestServer,
  orgId: string,
  admin: Person,
  tech: Person,
  front: Person,
  hotel: TestHotel,
  other: TestHotel,
  plan: H.MaintenancePlanOut;
const params = () => ({ orgId, propertyId: hotel.propertyId });
beforeAll(async () => {
  S = await startHotelServer();
  S.setToday("2026-10-25");
  const o = await hotelOrg(S);
  orgId = o.orgId;
  admin = o.staff.general_manager;
  tech = o.staff.technician;
  front = o.staff.receptionist;
  hotel = await buildHotel(orgId, admin, {
    counts: { STD: 1, DLX: 1, STE: 0 },
    staff: { technician: tech, receptionist: front },
  });
  other = await buildHotel(orgId, admin, { name: "Other Hotel", counts: { STD: 1, DLX: 0, STE: 0 }, staff: {} });
});
afterAll(() => S.close());
function body(extra: Partial<H.MaintenancePlanOut> = {}) {
  return {
    expectedVersion: plan.version,
    title: plan.title,
    assetLabel: plan.assetLabel,
    roomId: plan.roomId,
    everyDays: plan.everyDays,
    nextDue: plan.nextDue,
    active: plan.active,
    reason: "Reviewed maintenance schedule correction",
    ...extra,
  };
}
it("creates a plan and supports repeated edits without replacing its identity", async () => {
  plan = await tech.api.hotel.createMaintenancePlan({
    params: params(),
    body: {
      title: "Inspect air conditioning",
      assetLabel: "AC unit",
      roomId: hotel.rooms["101"]!.id,
      everyDays: 30,
      firstDue: "2026-10-25",
    },
  });
  expect(plan.version).toBe(1);
  for (const title of ["Inspect air conditioning filters", "Inspect AC filters and drain"]) {
    plan = await tech.api.hotel.updateMaintenancePlan({
      params: { ...params(), planId: plan.id },
      body: body({ title }),
    });
    expect(
      (await tech.api.hotel.listMaintenancePlans({ params: params() })).plans.find((x) => x.id === plan.id)?.title,
    ).toBe(title);
  }
  expect(plan.version).toBe(3);
});
it("pauses and resumes future generation without deleting any plan or ticket", async () => {
  plan = await tech.api.hotel.updateMaintenancePlan({
    params: { ...params(), planId: plan.id },
    body: body({ active: false }),
  });
  expect((await admin.api.hotel.runAutomation({ params: params() })).preventiveTickets).toBe(0);
  plan = await tech.api.hotel.updateMaintenancePlan({
    params: { ...params(), planId: plan.id },
    body: body({ active: true }),
  });
  expect((await admin.api.hotel.runAutomation({ params: params() })).preventiveTickets).toBe(1);
  const tickets = (await tech.api.hotel.listMaintenance({ params: params() })).tickets;
  expect(tickets).toHaveLength(1);
  await refused(
    tech.api.hotel.updateMaintenancePlan({ params: { ...params(), planId: plan.id }, body: body({ active: false }) }),
    409,
  );
  plan = (await tech.api.hotel.listMaintenancePlans({ params: params() })).plans.find((x) => x.id === plan.id)!;
  expect(plan.nextDue).toBe("2026-11-24");
  plan = await tech.api.hotel.updateMaintenancePlan({
    params: { ...params(), planId: plan.id },
    body: body({ active: false, title: "Future AC inspection" }),
  });
  expect((await tech.api.hotel.listMaintenance({ params: params() })).tickets[0]?.title).toContain(
    "Inspect AC filters and drain",
  );
  expect((await admin.api.hotel.runAutomation({ params: params() })).preventiveTickets).toBe(0);
});
it("enforces hotel, organisation, role and room boundaries", async () => {
  await refused(front.api.hotel.updateMaintenancePlan({ params: { ...params(), planId: plan.id }, body: body() }), 403);
  await refused(
    tech.api.hotel.updateMaintenancePlan({
      params: { orgId, propertyId: other.propertyId, planId: plan.id },
      body: body(),
    }),
    404,
  );
  await refused(
    admin.api.hotel.updateMaintenancePlan({
      params: { ...params(), planId: plan.id },
      body: body({ roomId: other.rooms["101"]!.id }),
    }),
    404,
  );
  const outsider = await hotelOrg(S);
  await refused(
    outsider.admin.api.hotel.updateMaintenancePlan({ params: { ...params(), planId: plan.id }, body: body() }),
    404,
  );
});
it("rejects stale simultaneous edits, keeps immutable audit, and does not post financial transactions", async () => {
  const b = body({ title: "Future reviewed servicing plan" });
  const results = await Promise.allSettled([
    tech.api.hotel.updateMaintenancePlan({ params: { ...params(), planId: plan.id }, body: b }),
    tech.api.hotel.updateMaintenancePlan({ params: { ...params(), planId: plan.id }, body: b }),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const events = await S.sql("SELECT action,before,after FROM audit_log WHERE org_id=$1 AND target=$2 ORDER BY id", [
    orgId,
    plan.id,
  ]);
  expect(events.some((e) => e.action === "Preventive maintenance plan paused")).toBe(true);
  expect(events.some((e) => e.action === "Preventive maintenance plan resumed")).toBe(true);
  expect(events.at(-1)?.before).toHaveProperty("version");
  expect((await S.sql("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1", [orgId]))[0]?.n).toBe(0);
});
it("can create a paused plan without a transient active schedule", async () => {
  const p = await tech.api.hotel.createMaintenancePlan({
    params: params(),
    body: {
      title: "Review pump service before activation",
      assetLabel: "Pump",
      everyDays: 7,
      firstDue: "2026-10-25",
      active: false,
    },
  });
  expect(p.active).toBe(false);
  expect(p.version).toBe(1);
  expect((await admin.api.hotel.runAutomation({ params: params() })).preventiveTickets).toBe(0);
});
it("advances long-overdue recurrence without generating a ticket for every missed interval", async () => {
  const p = await tech.api.hotel.createMaintenancePlan({
    params: params(),
    body: {
      title: "Legacy servicing plan review",
      assetLabel: "Legacy equipment",
      everyDays: 1,
      firstDue: "1900-01-01",
    },
  });
  expect((await admin.api.hotel.runAutomation({ params: params() })).preventiveTickets).toBe(1);
  const after = (await tech.api.hotel.listMaintenancePlans({ params: params() })).plans.find((x) => x.id === p.id)!;
  expect(after.nextDue).toBe("2026-10-26");
  expect((await admin.api.hotel.runAutomation({ params: params() })).preventiveTickets).toBe(0);
});
it("reopens the current plan and paginates only its own immutable audit history", async () => {
  const p = await tech.api.hotel.getMaintenancePlan({ params: { ...params(), planId: plan.id } });
  expect(p.version).toBeGreaterThan(plan.version);
  const h = await tech.api.hotel.maintenancePlanHistory({
    params: { ...params(), planId: plan.id },
    query: { limit: 2 },
  });
  expect(h.total).toBeGreaterThan(4);
  expect(h.entries).toHaveLength(2);
  expect(h.entries[0]?.before).toHaveProperty("version");
  await refused(
    tech.api.hotel.getMaintenancePlan({ params: { orgId, propertyId: other.propertyId, planId: plan.id } }),
    404,
  );
  await refused(
    tech.api.hotel.maintenancePlanHistory({ params: { orgId, propertyId: other.propertyId, planId: plan.id } }),
    404,
  );
});

it("retains scheduler date advances in plan audit history", async () => {
  const h = await tech.api.hotel.maintenancePlanHistory({ params: { ...params(), planId: plan.id } });
  expect(h.entries.some((e) => e.action === "Preventive maintenance plan advanced")).toBe(true);
});
