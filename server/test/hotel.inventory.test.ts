// The one availability record: the last room can never be sold twice (concurrent bookings, channels, the database
// itself), two hotels of a group share a central view without double booking, and hotel-only isolation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildHotel,
  channelBooking,
  guest,
  hotelOrg,
  startHotelServer,
  type Staff,
  type TestHotel,
} from "./support/hotel-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("hotel inventory and group", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let st: Staff;
  let A: TestHotel;
  const PA = () => ({ orgId, propertyId: A.propertyId });
  const book = (p: Person, H: TestHotel, roomTypeId: string, arrival: string, departure: string, name = "Guest") =>
    p.api.hotel.createReservation({
      params: { orgId, propertyId: H.propertyId },
      body: { guest: guest(name), arrival, departure, rooms: [{ roomTypeId, ratePlanId: H.plans.BAR }] },
    });

  beforeAll(async () => {
    S = await startHotelServer();
    const o = await hotelOrg(S, "Pwani Hotels");
    orgId = o.orgId;
    admin = o.admin;
    st = o.staff;
    A = await buildHotel(orgId, st.general_manager, {
      name: "Pwani Diani",
      counts: { STD: 3, DLX: 2, STE: 1 },
      staff: st,
    });
  });
  afterAll(() => S.close());

  it("concurrent bookings for the last room: exactly one wins, every other is refused", async () => {
    const tries = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        book(st.receptionist, A, A.types.STE, "2026-10-15", "2026-10-17", `Racer ${i}`),
      ),
    );
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    const lost = tries.filter((t) => t.status === "rejected") as PromiseRejectedResult[];
    expect(lost.map((t) => t.reason.status)).toEqual([409, 409, 409, 409, 409]);
    const rows = await S.sql(
      "SELECT date, sold, total FROM hotel_inventory WHERE room_type_id = $1 AND date BETWEEN '2026-10-14' AND '2026-10-17' ORDER BY date",
      [A.types.STE],
    );
    expect(rows.map((r) => [r.date, r.sold, r.total])).toEqual([
      ["2026-10-14", 0, 1],
      ["2026-10-15", 1, 1],
      ["2026-10-16", 1, 1],
      ["2026-10-17", 0, 1],
    ]);
  });

  it("a channel booking racing a direct booking for the last room: one wins", async () => {
    await book(st.receptionist, A, A.types.DLX, "2026-10-20", "2026-10-21", "Early bird"); // 1 of 2 deluxe rooms
    const results = await Promise.all([
      book(st.receptionist, A, A.types.DLX, "2026-10-20", "2026-10-21", "Direct").then(
        () => 201,
        (e) => e.status,
      ),
      channelBooking(S, {
        orgId,
        propertyId: A.propertyId,
        channelCode: "BKG",
        externalRef: "RACE-1",
        guest: guest("Channel"),
        roomTypeId: A.types.DLX,
        ratePlanId: A.plans.BAR,
        arrival: "2026-10-20",
        departure: "2026-10-21",
      }).then((r) => (r.status === 200 ? 201 : r.status)),
    ]);
    expect(results.sort()).toEqual([201, 409]);
    const row = await S.sql("SELECT sold, total FROM hotel_inventory WHERE room_type_id = $1 AND date = '2026-10-20'", [
      A.types.DLX,
    ]);
    expect(row[0]).toEqual({ sold: 2, total: 2 });
  });

  it("the database itself refuses overselling and a room given twice", async () => {
    await expect(
      S.sql("UPDATE hotel_inventory SET sold = sold + 1 WHERE room_type_id = $1 AND date = '2026-10-15'", [
        A.types.STE,
      ]),
    ).rejects.toThrow(/hotel_no_overbooking/);
    const r1 = await book(st.receptionist, A, A.types.STD, "2026-10-22", "2026-10-24", "First");
    const r2 = await book(st.receptionist, A, A.types.STD, "2026-10-23", "2026-10-25", "Second");
    const room = A.rooms["101"]!.id;
    await st.receptionist.api.hotel.assignRoom({
      params: { ...PA(), stayId: r1.stays[0]!.id },
      body: { roomId: room },
    });
    const e = await refused(
      st.receptionist.api.hotel.assignRoom({ params: { ...PA(), stayId: r2.stays[0]!.id }, body: { roomId: room } }),
      409,
    );
    expect(e.message).toMatch(/already given to another stay/);
    await expect(S.sql("UPDATE hotel_stays SET room_id = $1 WHERE id = $2", [room, r2.stays[0]!.id])).rejects.toThrow(
      /hotel_room_not_double_booked/,
    );
  });

  it("waitlist: a sold-out booking can wait, then be confirmed when a room frees up", async () => {
    const w = await st.receptionist.api.hotel.createReservation({
      params: PA(),
      body: {
        guest: guest("Patient Guest"),
        arrival: "2026-10-15",
        departure: "2026-10-16",
        waitlist: true,
        rooms: [{ roomTypeId: A.types.STE, ratePlanId: A.plans.BAR }],
      },
    });
    expect(w.status).toBe("waitlisted");
    await refused(st.receptionist.api.hotel.confirmWaitlisted({ params: { ...PA(), reservationId: w.id } }), 409);
    const winner = (
      await st.receptionist.api.hotel.listReservations({
        params: PA(),
        query: { from: "2026-10-15", to: "2026-10-15" },
      })
    ).reservations.find((r) => r.status === "confirmed" && r.stays[0]!.roomTypeId === A.types.STE)!;
    // refundable rate, cancelled 4 days ahead (free cancellation until 2 days before): no fee
    const c = await st.receptionist.api.hotel.cancelReservation({
      params: { ...PA(), reservationId: winner.id },
      body: { reason: "Plans changed" },
    });
    expect([c.reservation.status, c.feeMinor, c.folioId]).toEqual(["cancelled", 0, null]);
    const ok = await st.receptionist.api.hotel.confirmWaitlisted({ params: { ...PA(), reservationId: w.id } });
    expect(ok.status).toBe("confirmed");
  });

  it("restrictions: stop-sell on one channel, minimum stay and closed-to-arrival", async () => {
    await st.revenue_manager.api.hotel.setRestrictions({
      params: PA(),
      body: {
        restrictions: [
          { channelId: A.channelId, from: "2026-11-01", to: "2026-11-03", stopSell: true },
          { roomTypeId: A.types.STD, from: "2026-11-10", to: "2026-11-10", minStay: 3 },
          { from: "2026-11-20", to: "2026-11-20", closedToArrival: true },
        ],
      },
    });
    const view = await st.receptionist.api.hotel.availability({
      params: PA(),
      query: { from: "2026-11-01", to: "2026-11-01", channelId: A.channelId },
    });
    expect(view.roomTypes.every((t) => t.days[0]!.closed && t.days[0]!.available === 0)).toBe(true);
    const direct = await st.receptionist.api.hotel.availability({
      params: PA(),
      query: { from: "2026-11-01", to: "2026-11-01" },
    });
    expect(direct.roomTypes.find((t) => t.roomTypeId === A.types.STD)!.days[0]!.available).toBe(3);
    const r = await channelBooking(S, {
      orgId,
      propertyId: A.propertyId,
      channelCode: "BKG",
      externalRef: "STOP-1",
      guest: guest("Blocked"),
      roomTypeId: A.types.STD,
      ratePlanId: A.plans.BAR,
      arrival: "2026-11-01",
      departure: "2026-11-02",
    });
    expect(r.status).toBe(409);
    await book(st.receptionist, A, A.types.STD, "2026-11-01", "2026-11-02", "Direct is open");
    expect((await refused(book(st.receptionist, A, A.types.STD, "2026-11-10", "2026-11-11"), 409)).message).toMatch(
      /Minimum stay is 3/,
    );
    await book(st.receptionist, A, A.types.STD, "2026-11-10", "2026-11-13", "Long enough");
    expect((await refused(book(st.receptionist, A, A.types.DLX, "2026-11-20", "2026-11-21"), 409)).message).toMatch(
      /Closed to arrival/,
    );
  });

  it("derived rates and seasons: BAR − 10 % follows BAR, weekend prices by day of week", async () => {
    const derived = await st.revenue_manager.api.hotel.createRatePlan({
      params: PA(),
      body: { code: "ADV", name: "Advance purchase", kind: "derived", parentId: A.plans.BAR, derivedPct: -10 },
    });
    await st.revenue_manager.api.hotel.setSeasons({
      params: { ...PA(), ratePlanId: A.plans.BAR },
      body: {
        seasons: [
          {
            name: "High season",
            roomTypeId: A.types.STD,
            from: "2026-12-01",
            to: "2026-12-31",
            amountMinor: 1_400_000,
            // Saturday and Sunday higher (Monday first)
            weekdayAmountsMinor: [null, null, null, null, null, 1_600_000, 1_600_000],
          },
        ],
      },
    });
    const a = await st.receptionist.api.hotel.availability({
      params: PA(),
      query: { from: "2026-11-30", to: "2026-12-05" },
    });
    const std = a.roomTypes.find((t) => t.roomTypeId === A.types.STD)!.days;
    const rate = (date: string, plan: string) =>
      std.find((d) => d.date === date)!.rates.find((r) => r.ratePlanId === plan)!.amountMinor;
    expect(rate("2026-11-30", A.plans.BAR)).toBe(1_000_000);
    expect(rate("2026-12-01", A.plans.BAR)).toBe(1_400_000); // Tuesday
    expect(rate("2026-12-05", A.plans.BAR)).toBe(1_600_000); // Saturday
    expect(rate("2026-12-05", derived.id)).toBe(1_440_000);
    expect(rate("2026-11-30", derived.id)).toBe(900_000);
  });

  it("a room out of order leaves inventory; refused when it would oversell", async () => {
    const before = await st.receptionist.api.hotel.availability({
      params: PA(),
      query: { from: "2026-10-28", to: "2026-10-28" },
    });
    const std = () => before.roomTypes.find((t) => t.roomTypeId === A.types.STD)!.days[0]!.available;
    const t = await st.technician.api.hotel.createMaintenance({
      params: PA(),
      body: {
        roomId: A.rooms["102"]!.id,
        title: "AC compressor failed",
        priority: "urgent",
        outOfOrder: { from: "2026-10-27", to: "2026-10-28" },
      },
    });
    expect(t.status).toBe("open");
    const after = await st.receptionist.api.hotel.availability({
      params: PA(),
      query: { from: "2026-10-28", to: "2026-10-28" },
    });
    expect(after.roomTypes.find((x) => x.roomTypeId === A.types.STD)!.days[0]).toMatchObject({
      outOfOrder: 1,
      available: std() - 1,
    });
    // the only suite is sold on 2026-10-15: it cannot go out of order then
    await refused(
      st.technician.api.hotel.createMaintenance({
        params: PA(),
        body: { roomId: A.rooms["106"]!.id, title: "Leak", outOfOrder: { from: "2026-10-15", to: "2026-10-15" } },
      }),
      409,
    );
    // a receptionist has no maintenance capability
    await refused(
      st.receptionist.api.hotel.createMaintenance({ params: PA(), body: { title: "Squeaky door" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const done = await st.technician.api.hotel.resolveMaintenance({
      params: { ...PA(), ticketId: t.id },
      body: { note: "Compressor replaced" },
    });
    expect(done.status).toBe("resolved");
    const back = await st.receptionist.api.hotel.availability({
      params: PA(),
      query: { from: "2026-10-28", to: "2026-10-28" },
    });
    expect(back.roomTypes.find((x) => x.roomTypeId === A.types.STD)!.days[0]!.outOfOrder).toBe(0);
    const board = await st.receptionist.api.hotel.roomBoard({ params: PA() });
    expect(board.rooms.find((r) => r.number === "102")).toMatchObject({ service: "in_service", housekeeping: "dirty" });
  });

  it("group views refuse a single-hotel organisation", async () => {
    const e = await refused(
      st.general_manager.api.hotel.groupAvailability({
        params: { orgId },
        query: { from: "2026-10-15", to: "2026-10-16" },
      }),
      404,
    );
    expect(e.message).toMatch(/two or more hotels/);
    expect((await st.general_manager.api.hotel.listProperties({ params: { orgId } })).groupViews).toBe(false);
  });

  let B: TestHotel;
  it("two hotels: central availability across both, the last room sold once, owner fee report", async () => {
    B = await buildHotel(orgId, st.general_manager, {
      name: "Pwani Lamu",
      counts: { STD: 1, DLX: 1, STE: 1 },
      staff: st,
    });
    const props = await st.group_owner.api.hotel.listProperties({ params: { orgId } });
    expect([props.properties.length, props.groupViews]).toEqual([2, true]);
    // receptionists have no group views
    await refused(
      st.receptionist.api.hotel.groupAvailability({
        params: { orgId },
        query: { from: "2026-10-18", to: "2026-10-19" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const crs = await st.group_owner.api.hotel.groupAvailability({
      params: { orgId },
      query: { from: "2026-10-18", to: "2026-10-19" },
    });
    const lamu = () => crs.properties.find((p) => p.propertyId === B.propertyId)!;
    expect(lamu().roomTypes.find((t) => t.code === "STE")!.available).toBe(1);
    // call-centre bookings for the last Lamu suite at the same moment: one wins
    const tries = await Promise.allSettled([
      book(st.receptionist, B, B.types.STE, "2026-10-18", "2026-10-19", "Caller A"),
      book(st.front_office_manager, B, B.types.STE, "2026-10-18", "2026-10-19", "Caller B"),
    ]);
    expect(tries.map((t) => t.status).sort()).toEqual(["fulfilled", "rejected"]);
    const after = await st.group_owner.api.hotel.groupAvailability({
      params: { orgId },
      query: { from: "2026-10-18", to: "2026-10-19" },
    });
    expect(
      after.properties.find((p) => p.propertyId === B.propertyId)!.roomTypes.find((t) => t.code === "STE")!.available,
    ).toBe(0);
    expect(
      after.properties.find((p) => p.propertyId === A.propertyId)!.roomTypes.find((t) => t.code === "STE")!.available,
    ).toBe(1);
    const k = await st.group_owner.api.hotel.groupKpis({
      params: { orgId },
      query: { from: "2026-10-11", to: "2026-10-11", baseFeePct: 3, incentiveFeePct: 10 },
    });
    expect(k.properties).toHaveLength(2);
    expect(k.consolidated.roomsAvailable).toBe(6 + 3);
  });

  it("staff assigned to one hotel reach only that hotel", async () => {
    // the receptionist works at B only; a manager cannot take themselves off a hotel's staff
    await refused(
      st.general_manager.api.hotel.setPropertyStaff({
        params: PA(),
        body: { userIds: [st.front_office_manager.userId] },
      }),
      400,
    );
    await st.general_manager.api.hotel.setPropertyStaff({
      params: PA(),
      body: { userIds: [st.general_manager.userId, st.front_office_manager.userId] },
    });
    const mine = await st.receptionist.api.hotel.listProperties({ params: { orgId } });
    expect(mine.properties.map((p) => p.id)).toEqual([B.propertyId]);
    await refused(st.receptionist.api.hotel.getSetup({ params: PA() }), 404);
    expect((await st.group_owner.api.hotel.listProperties({ params: { orgId } })).properties).toHaveLength(2);
  });

  it("a hotel-only client sees no other product, and other products see no hotel", async () => {
    const ent = await admin.api.subscriptions.entitlements({ params: { orgId }, query: {} });
    expect(ent.products).toEqual(["hotel"]);
    await refused(
      admin.api.organisations.addMember({
        params: { orgId },
        body: { email: "pm@x.test", name: "PM", role: "property_manager" },
      }),
      400,
    );
    const pm = await S.newOrg({ name: "Only Property Co", trial: false });
    await refused(pm.admin.api.hotel.listProperties({ params: { orgId: pm.orgId } }), 404);
    // another organisation's hotel looks like it does not exist
    await refused(pm.admin.api.hotel.getSetup({ params: PA() }), 404);
    const chart = await st.financial_controller.api.ledger.listAccounts({ params: { orgId } });
    expect(chart.accounts.map((a) => a.code)).toEqual(
      expect.arrayContaining([
        "1150",
        "1160",
        "2110",
        "2120",
        "2350",
        "4100",
        "4200",
        "4300",
        "4400",
        "4500",
        "5100",
        "5200",
        "5600",
      ]),
    );
    const pmChart = await pm.admin.api.ledger.listAccounts({ params: { orgId: pm.orgId } });
    expect(pmChart.accounts.map((a) => a.code)).not.toContain("1150");
  });
});
