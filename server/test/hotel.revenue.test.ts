// Revenue management from the hotel's own bookings (rules, labelled; no external AI, no competitor feed): forecast
// with pace against last year, pickup, rate suggestions applied as a one-night BAR season, group displacement, and
// corporate RFPs accepted into a corporate rate plan with production per account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guest } from "./support/hotel-fixture.js";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel revenue management and corporate sales", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  const night = (arrival: string, rooms: ("STD" | "DLX" | "STE")[], departure?: string) =>
    api(X.st.receptionist).createReservation({
      params: X.P,
      body: {
        guest: guest(`Guest ${arrival} ${rooms.join("")}`),
        arrival,
        departure: departure ?? arrival.replace(/\d\d$/, (d) => String(Number(d) + 1).padStart(2, "0")),
        rooms: rooms.map((c) => ({ roomTypeId: X.H.types[c], ratePlanId: X.H.plans.BAR })),
      },
    });

  beforeAll(async () => {
    // ten rooms: 4 standard, 3 deluxe, 3 suites; business date 2026-10-11
    X = await extHotel("Revenue", { counts: { STD: 4, DLX: 3, STE: 3 } });
    // 2026-10-20: 9 of 10 rooms sold
    await night("2026-10-20", ["STD", "STD", "STD", "STD"]);
    await night("2026-10-20", ["DLX", "DLX", "DLX", "STE", "STE"]);
    // 2026-10-22: 5 of 10
    await night("2026-10-22", ["STD", "STD", "STD", "STD", "DLX"]);
    // last year, the same weekday as 2026-10-21 (364 days earlier) had all ten rooms on the books at this lead time:
    // a booking made then (written straight into the past here) and later cancelled
    const ly = await night("2026-11-15", ["STD", "STD", "STD", "STD", "DLX", "DLX", "DLX", "STE", "STE", "STE"]);
    await api(X.st.receptionist).cancelReservation({
      params: { ...X.P, reservationId: ly.id },
      body: { reason: "Moved" },
    });
    await X.S.sql("UPDATE hotel_stays SET arrival = '2025-10-22', departure = '2025-10-23' WHERE reservation_id = $1", [
      ly.id,
    ]);
    await X.S.sql("UPDATE hotel_reservations SET created_at = '2025-10-01T09:00:00Z' WHERE id = $1", [ly.id]);
  });
  afterAll(() => X.S.close());

  it("the forecast: on the books, pace against last year at the same lead time, and the rule behind each suggestion", async () => {
    const { st, P } = X;
    await refused(
      api(st.receptionist).revenueForecast({ params: P, query: { from: "2026-10-20", to: "2026-10-22" } }),
      403,
    );
    const f = await api(st.revenue_manager).revenueForecast({
      params: P,
      query: { from: "2026-10-20", to: "2026-10-22" },
    });
    expect(
      f.days.map((d) => [
        d.date,
        d.capacity,
        d.onTheBooks,
        d.lastYearSameLeadTime,
        d.paceDelta,
        d.forecastOccupancyPct,
        d.suggestedChangePct,
      ]),
    ).toEqual([
      ["2026-10-20", 10, 9, 0, 9, 90, 15],
      ["2026-10-21", 10, 0, 10, -10, 0, -15],
      ["2026-10-22", 10, 5, 0, 5, 50, 0],
    ]);
    expect(f.days[1]!.reason).toBe("forecast occupancy 0%, pace 10 room(s) behind last year");
    expect(f.days[2]!.reason).toBe("Hold — forecast occupancy 50%");
    expect(f.days.every((d) => d.expectedPickup === 0)).toBe(true); // no stay history yet
    expect(f.days[0]!.pickup7d).toBe(9);
    expect(f.segments).toEqual([
      {
        source: "direct",
        roomNights: 14,
        revenueMinor: 4 * 1_000_000 + 3 * 1_500_000 + 2 * 3_000_000 + 4 * 1_000_000 + 1_500_000,
      },
    ]);
    expect(f.competitorRates.connected).toBe(false);
    expect(f.method).toMatch(/No external AI or competitor data/);
    await refused(
      api(st.revenue_manager).revenueForecast({ params: P, query: { from: "2026-10-01", to: "2027-03-01" } }),
      400,
    );
  });

  it("pickup by booking date and stay date counts bookings and cancellations", async () => {
    const { st, P } = X;
    const p = await api(st.revenue_manager).pickupReport({
      params: P,
      query: { bookedFrom: "2026-01-01", bookedTo: "2026-12-31", stayFrom: "2026-10-01", stayTo: "2026-10-31" },
    });
    expect(p.days).toEqual([
      { date: "2026-10-20", booked: 9, cancelled: 0, net: 9 },
      { date: "2026-10-22", booked: 5, cancelled: 0, net: 5 },
    ]);
    expect(p.totals).toEqual({ booked: 14, cancelled: 0, net: 14 });
  });

  it("a suggestion applied becomes a one-night BAR season, once; a hold or a past night is not applied", async () => {
    const { st, P, H } = X;
    const s = await api(st.revenue_manager).rateSuggestions({
      params: P,
      query: { from: "2026-10-20", to: "2026-10-20" },
    });
    expect(s.suggestions.map((x) => [x.roomTypeId, x.currentMinor, x.suggestedMinor, x.changePct])).toEqual([
      [H.types.DLX, 1_500_000, 1_725_000, 15],
      [H.types.STD, 1_000_000, 1_150_000, 15],
      [H.types.STE, 3_000_000, 3_450_000, 15],
    ]);
    await refused(
      api(st.receptionist).applySuggestion({ params: P, body: { date: "2026-10-20", roomTypeId: H.types.STE } }),
      403,
    );
    const a = await api(st.revenue_manager).applySuggestion({
      params: P,
      body: { date: "2026-10-20", roomTypeId: H.types.STE },
    });
    expect([a.applied, a.suggestedMinor]).toEqual([true, 3_450_000]);
    await refused(
      api(st.revenue_manager).applySuggestion({ params: P, body: { date: "2026-10-20", roomTypeId: H.types.STE } }),
      409,
    );
    await expect(
      api(st.revenue_manager).applySuggestion({ params: P, body: { date: "2026-10-22", roomTypeId: H.types.STD } }),
    ).rejects.toThrow(/hold the rate/);
    await refused(
      api(st.revenue_manager).applySuggestion({ params: P, body: { date: "2026-10-01", roomTypeId: H.types.STD } }),
      400,
    );
    const after = await api(st.revenue_manager).rateSuggestions({
      params: P,
      query: { from: "2026-10-20", to: "2026-10-20" },
    });
    const ste = after.suggestions.find((x) => x.roomTypeId === H.types.STE)!;
    expect([ste.currentMinor, ste.applied, ste.reason]).toEqual([3_450_000, true, "Applied"]);
    // the new price is what a booking for that night now costs
    const r = await night("2026-10-20", ["STE"]);
    expect(r.stays[0]!.nights.map((n) => n.rateMinor)).toEqual([3_450_000]);
  });

  it("group displacement weighs the group's revenue against the transient rooms it would push out", async () => {
    const { st, P, H } = X;
    // suites: all 3 now sold on 2026-10-20, none on 2026-10-21; BAR 3,450,000 then 3,000,000
    const d = await api(st.revenue_manager).displacement({
      params: P,
      body: {
        roomTypeId: H.types.STE,
        arrival: "2026-10-20",
        departure: "2026-10-22",
        roomsPerNight: 2,
        groupRateMinor: 2_500_000,
      },
    });
    expect(d.nights.map((n) => [n.date, n.forecastTransient, n.displacedRooms, n.displacedRevenueMinor])).toEqual([
      ["2026-10-20", 3, 2, 6_900_000],
      ["2026-10-21", 0, 0, 0],
    ]);
    expect([d.groupRevenueMinor, d.displacedRevenueMinor, d.netGainMinor, d.recommendation]).toEqual([
      10_000_000,
      6_900_000,
      3_100_000,
      "accept",
    ]);
    await refused(
      api(st.revenue_manager).displacement({
        params: P,
        body: {
          roomTypeId: H.types.STE,
          arrival: "2026-10-20",
          departure: "2026-10-21",
          roomsPerNight: 4,
          groupRateMinor: 1,
        },
      }),
      409,
    );
  });

  it("an accepted RFP becomes the company's corporate rate plan for the season; production per account follows", async () => {
    const { st, P, H } = X;
    const body = {
      corporateAccountId: H.companyId,
      seasonFrom: "2026-10-01",
      seasonTo: "2026-12-31",
      rates: [{ roomTypeId: H.types.STD, amountMinor: 800_000 }],
      expectedRoomNights: 120,
    };
    await refused(api(st.receptionist).createRfp({ params: P, body }), 403);
    await refused(
      api(st.revenue_manager).createRfp({ params: P, body: { ...body, rates: [...body.rates, ...body.rates] } }),
      400,
    );
    const rfp = await api(st.revenue_manager).createRfp({ params: P, body });
    expect([rfp.number, rfp.status]).toEqual(["RFP-00001", "submitted"]);
    const ok = await api(st.general_manager).decideRfp({
      params: { ...P, rfpId: rfp.id },
      body: { decision: "accepted", reason: "Volume justifies 20 % off BAR" },
    });
    expect(ok.status).toBe("accepted");
    await refused(
      api(st.general_manager).decideRfp({
        params: { ...P, rfpId: rfp.id },
        body: { decision: "declined", reason: "Changed mind" },
      }),
      409,
    );
    const r = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Corporate Traveller"),
        arrival: "2026-10-11",
        departure: "2026-10-12",
        corporateAccountId: H.companyId,
        rooms: [{ roomTypeId: H.types.STD, ratePlanId: ok.ratePlanId! }],
      },
    });
    expect(r.stays[0]!.nights.map((n) => n.rateMinor)).toEqual([800_000]);
    await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["101"]!.id },
    });
    await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    const prod = await api(st.revenue_manager).corporateProduction({
      params: P,
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(prod.accounts).toEqual([
      {
        accountId: H.companyId,
        name: "Safari Logistics Ltd",
        kind: "company",
        reservations: 1,
        roomNights: 1,
        roomRevenueMinor: 800_000,
        adrMinor: 800_000,
      },
    ]);
  });

  it("another organisation cannot see this hotel's forecast or RFPs", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    await refused(
      other.admin.api.hotel.revenueForecast({ params: X.P, query: { from: "2026-10-20", to: "2026-10-22" } }),
      404,
    );
    await refused(other.admin.api.hotel.listRfps({ params: X.P }), 404);
  });
});
