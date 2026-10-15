// Operations from the hotel's own records: today's housekeeping order by rules (arrivals, check-outs, vacant dirty,
// stay-overs, with linen changes due — less often for guests who reuse), attendants finishing rooms with the
// checklist and damage opening a ticket, productivity per attendant, and sustainability per occupied room from the
// meter readings staff record (no sensors connected).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guest } from "./support/hotel-fixture.js";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel housekeeping plan, productivity and sustainability", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  const room = (n: string) => X.H.rooms[n]!.id;

  beforeAll(async () => {
    X = await extHotel("Insights", { counts: { STD: 4, DLX: 3, STE: 3 } });
    const { st, P } = X;
    const kofi = await X.inHouse("Kofi Mensah", "101");
    const bob = await X.inHouse("Bob Kariuki", "102", { departure: "2026-10-12" });
    const dan = await X.inHouse("Dan Reuse", "105", { roomTypeId: X.H.types.DLX });
    await X.S.sql("UPDATE hotel_reservations SET linen_reuse = true WHERE id = $1", [dan.reservationId]);
    const sara = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Sara Soon"),
        arrival: "2026-10-12",
        departure: "2026-10-13",
        rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
      },
    });
    await api(st.receptionist).assignRoom({
      params: { ...P, stayId: sara.stays[0]!.id },
      body: { roomId: room("103") },
    });
    await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    // business date 2026-10-12: Bob leaves
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: bob.folioId },
      body: { method: "card", amountMinor: 1_180_000, reference: "BOB-1" },
    });
    await api(st.receptionist).checkOut({ params: { ...P, stayId: bob.stayId } });
    // Sara's room and room 104 are dirty; Kofi and Dan have been in house three nights (written into the past here)
    await X.S.sql("UPDATE hotel_rooms SET hk_status = 'dirty' WHERE id = ANY($1::text[])", [
      [room("103"), room("104")],
    ]);
    await X.S.sql("UPDATE hotel_stays SET arrival = '2026-10-09' WHERE id = ANY($1::text[])", [
      [kofi.stayId, dan.stayId],
    ]);
  });
  afterAll(() => X.S.close());

  it("today's cleaning order: arrivals first, then check-outs, vacant dirty rooms, stay-overs, with linen due", async () => {
    const { st, P } = X;
    const plan = await api(st.housekeeping_supervisor).housekeepingPlan({ params: P });
    expect(plan.date).toBe("2026-10-12");
    expect(plan.rooms.map((r) => [r.number, r.task, r.linenChange])).toEqual([
      ["103", "arrival_prep", false],
      ["102", "checkout", true],
      ["104", "vacant_dirty", false],
      // three nights in: linen every 3 nights, every 6 for the guest who reuses
      ["101", "stayover", true],
      ["105", "stayover", false],
    ]);
    expect(plan.method).toMatch(/^Rules:/);
  });

  it("an attendant finishes an assigned room with the full checklist; damage opens a maintenance ticket", async () => {
    const { st, P } = X;
    await api(st.housekeeping_supervisor).assignHousekeeping({
      params: P,
      body: { attendantUserId: st.housekeeping_attendant.userId, roomIds: [room("102"), room("104")] },
    });
    const att = api(st.housekeeping_attendant);
    await att.setHousekeeping({ params: { ...P, roomId: room("102") }, body: { status: "cleaning" } });
    const all = { bed: true, bathroom: true, amenities: true, minibar: true, floor: true };
    await expect(
      att.reportHousekeeping({
        params: { ...P, roomId: room("102") },
        body: { checklist: { ...all, minibar: false } },
      }),
    ).rejects.toThrow(/Tick every checklist item: minibar/);
    await refused(att.reportHousekeeping({ params: { ...P, roomId: room("103") }, body: { checklist: all } }), 403);
    const done = await att.reportHousekeeping({
      params: { ...P, roomId: room("102") },
      body: { checklist: all, damage: { note: "Cracked bathroom mirror", photoRef: "IMG_2041.jpg" } },
    });
    expect([done.room.housekeeping, done.ticketId === null]).toEqual(["clean", false]);
    const tickets = await api(st.technician).listMaintenance({ params: P, query: { status: "open" } });
    expect(tickets.tickets.map((t) => [t.id, t.title])).toEqual([
      [done.ticketId, "Damage reported by housekeeping: Cracked bathroom mirror"],
    ]);
    const rep = await api(st.general_manager).housekeepingReport({
      params: P,
      query: { from: "2026-10-12", to: "2026-10-12" },
    });
    expect(rep.attendants.map((a) => [a.userId, a.roomsCleaned])).toEqual([[st.housekeeping_attendant.userId, 1]]);
    expect([rep.roomsCleaned, rep.outOfOrderRoomNights]).toEqual([1, 0]);
    await refused(
      api(st.housekeeping_attendant).housekeepingReport({ params: P, query: { from: "2026-10-12", to: "2026-10-12" } }),
      403,
    );
    // the finished room leaves the plan
    const plan = await api(st.housekeeping_supervisor).housekeepingPlan({ params: P });
    expect(plan.rooms.map((r) => r.number)).not.toContain("102");
  });

  it("sustainability per occupied room from the meter readings staff record and the hotel's carbon factor", async () => {
    const { st, P } = X;
    const readings = [
      { date: "2026-10-11", kind: "energy_kwh" as const, quantity: 120 },
      { date: "2026-10-11", kind: "water_m3" as const, quantity: 3.5 },
      { date: "2026-10-11", kind: "waste_kg" as const, quantity: 10.25 },
    ];
    await refused(api(st.receptionist).recordMeterReadings({ params: P, body: { readings } }), 403);
    expect(await api(st.technician).recordMeterReadings({ params: P, body: { readings } })).toEqual({ recorded: 3 });
    await api(st.general_manager).updateExtensionSettings({ params: P, body: { carbonGramsPerKwh: 500 } });
    const s = await api(st.general_manager).sustainabilityReport({
      params: P,
      query: { from: "2026-10-11", to: "2026-10-11" },
    });
    // three room nights charged on 2026-10-11
    expect([s.occupiedRooms, s.readingDays, s.linenReuseStays]).toEqual([3, 1, 1]);
    expect(s.totals).toEqual({ energyKwh: 120, waterM3: 3.5, wasteKg: 10.25, carbonKg: 60 });
    expect(s.perOccupiedRoom).toEqual({ energyKwh: 40, waterM3: 1.17, wasteKg: 3.42, carbonKg: 20 });
    expect(s.sensors.connected).toBe(false);
    // a correction replaces the day's reading
    await api(st.technician).recordMeterReadings({
      params: P,
      body: { readings: [{ date: "2026-10-11", kind: "energy_kwh", quantity: 90 }] },
    });
    const again = await api(st.general_manager).sustainabilityReport({
      params: P,
      query: { from: "2026-10-11", to: "2026-10-11" },
    });
    expect([again.totals.energyKwh, again.perOccupiedRoom.energyKwh]).toEqual([90, 30]);
  });

  it("another organisation cannot see this hotel's housekeeping plan or record its meters", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    await refused(other.admin.api.hotel.housekeepingPlan({ params: X.P }), 404);
    await refused(
      other.admin.api.hotel.recordMeterReadings({
        params: X.P,
        body: { readings: [{ date: "2026-10-11", kind: "water_m3", quantity: 1 }] },
      }),
      404,
    );
  });
});
