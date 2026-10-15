// Booking engine: promo codes (validity, last use sold once), member rates, attribute-based selling (a room with the
// chosen features held for the stay, charged nightly), extras charged at check-in, the confirmation recorded, and the
// income audit seeing sanctioned discounts as DISCOUNT rather than a rate below plan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BAR } from "./support/hotel-fixture.js";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel booking engine", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let promoBooking: { id: string; stayId: string };
  let secondBooking: string;

  beforeAll(async () => {
    X = await extHotel("Engine");
    await api(X.st.general_manager).createRooms({
      params: X.P,
      body: {
        rooms: [
          { number: "201", roomTypeId: X.H.types.STD, floor: "2", attributes: ["sea_view", "high_floor"] },
          { number: "202", roomTypeId: X.H.types.STD, floor: "2", attributes: ["sea_view"] },
        ],
      },
    });
  });
  afterAll(() => X.S.close());

  it("promo codes, extras and room features are set by revenue roles, not by the front desk", async () => {
    const { st, P } = X;
    await refused(
      api(st.receptionist).createPromoCode({ params: P, body: { code: "FREE", discountPct: 50 } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const promo = await api(st.revenue_manager).createPromoCode({
      params: P,
      body: {
        code: "welcome10",
        discountPct: 10,
        stayFrom: "2026-10-11",
        stayTo: "2026-10-31",
        maxUses: 1,
        ratePlanIds: [X.H.plans.BAR],
      },
    });
    expect([promo.code, promo.discountPct, promo.uses]).toEqual(["WELCOME10", 10, 0]);
    await api(st.revenue_manager).saveUpsell({
      params: P,
      body: { code: "BRKF", name: "Breakfast", department: "fnb", pricing: "per_adult_night", amountMinor: 150_000 },
    });
    await api(st.revenue_manager).saveUpsell({
      params: P,
      body: { code: "XFER", name: "Airport transfer", department: "other", pricing: "per_stay", amountMinor: 350_000 },
    });
    const prices = await api(st.revenue_manager).setAttributePrices({
      params: P,
      body: {
        prices: [
          { attribute: "sea_view", name: "Sea view", amountMinor: 200_000 },
          { attribute: "high_floor", name: "High floor", amountMinor: 50_000 },
        ],
      },
    });
    expect(prices.prices.map((p) => [p.attribute, p.rooms])).toEqual([
      ["high_floor", 1],
      ["sea_view", 2],
    ]);
    expect((await api(st.receptionist).listAttributePrices({ params: P })).prices.map((p) => p.amountMinor)).toEqual([
      50_000, 200_000,
    ]);
    await refused(
      api(st.receptionist).updatePromoCode({ params: { ...P, promoId: promo.id }, body: { active: false } }),
      403,
    );
    const off = await api(st.revenue_manager).updatePromoCode({
      params: { ...P, promoId: promo.id },
      body: { active: false },
    });
    expect(off.active).toBe(false);
    const on = await api(st.revenue_manager).updatePromoCode({
      params: { ...P, promoId: promo.id },
      body: { active: true, description: "Welcome offer" },
    });
    expect([on.active, on.description, on.maxUses]).toEqual([true, "Welcome offer", 1]);
  });

  it("quotes and books direct with a promo code, features and extras; the last use of the code is sold once", async () => {
    const { st, P } = X;
    const ups = (await api(st.receptionist).listUpsells({ params: P })).upsells;
    const id = (code: string) => ups.find((u) => u.code === code)!.id;
    const body = {
      guest: { name: "Grace Wanjiru", email: "grace@guest.test" },
      arrival: "2026-10-11",
      departure: "2026-10-13",
      rooms: [
        { roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR, adults: 2, attributes: ["sea_view", "high_floor"] },
      ],
      promoCode: "Welcome10",
      upsells: [{ upsellId: id("BRKF") }, { upsellId: id("XFER") }],
    };
    const q = await api(st.receptionist).bookingQuote({ params: P, body });
    expect(q.discount).toEqual({ kind: "promo", pct: 10, label: "Promo code WELCOME10" });
    expect(q.rooms[0]!.nights.map((n) => [n.planRateMinor, n.rateMinor])).toEqual([
      [BAR.STD, 900_000],
      [BAR.STD, 900_000],
    ]);
    expect(q.rooms[0]!.attributesPerNightMinor).toBe(250_000);
    expect(q.upsells.map((u) => u.amountMinor)).toEqual([150_000 * 2 * 2, 350_000]);
    expect(q.totalBeforeTaxMinor).toBe(2 * 900_000 + 2 * 250_000 + 600_000 + 350_000);
    const b = await api(st.receptionist).bookDirect({
      params: P,
      body: { ...body, linenReuse: true, marketingConsent: true },
    });
    expect(b.reservation.source).toBe("booking_engine");
    expect(b.reservation.stays[0]!.roomNumber).toBe("201"); // the only room with both features, held at once
    expect(b.reservation.stays[0]!.nights.map((n) => n.rateMinor)).toEqual([900_000, 900_000]);
    promoBooking = { id: b.reservation.id, stayId: b.reservation.stays[0]!.id };
    expect((await api(st.revenue_manager).listPromoCodes({ params: P })).promoCodes[0]!.uses).toBe(1);
    // the code is used up; a feature nobody sells is refused
    const again = await refused(
      api(st.receptionist).bookDirect({
        params: P,
        body: { ...body, guest: { name: "Late Comer", email: "late@guest.test" } },
      }),
      400,
    );
    expect(again.message).toMatch(/fully used/);
    await refused(
      api(st.receptionist).bookingQuote({
        params: P,
        body: { ...body, promoCode: undefined, rooms: [{ ...body.rooms[0]!, attributes: ["jacuzzi"] }] },
      }),
      400,
    );
    // the second sea-view room goes to the next guest; a third finds none free for those dates
    const second = await api(st.receptionist).bookDirect({
      params: P,
      body: {
        guest: { name: "Second Seaview", email: "second@guest.test" },
        arrival: "2026-10-11",
        departure: "2026-10-12",
        rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR, attributes: ["sea_view"] }],
      },
    });
    expect(second.reservation.stays[0]!.roomNumber).toBe("202");
    secondBooking = second.reservation.id;
    const none = await refused(
      api(st.receptionist).bookDirect({
        params: P,
        body: {
          guest: { name: "Third Seaview", email: "third@guest.test" },
          arrival: "2026-10-12",
          departure: "2026-10-13",
          rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR, attributes: ["sea_view", "high_floor"] }],
        },
      }),
      409,
    );
    expect(none.message).toMatch(/No room with sea_view \+ high_floor is free/);
    // the booking confirmation is recorded once, in the outbox, to the guest's e-mail
    const msgs = await api(st.receptionist).listMessages({ params: P, query: { reservationId: promoBooking.id } });
    expect(msgs.messages.map((m) => [m.template, m.recipient])).toEqual([["confirmation", "grace@guest.test"]]);
    const g = await X.S.sql("SELECT marketing_consent FROM hotel_guests WHERE email = 'grace@guest.test'");
    expect(g[0].marketing_consent).toBe(true);
  });

  it("check-in takes only a room with the features booked, and charges the extras to the folio with their taxes", async () => {
    const { st, P } = X;
    await api(st.receptionist).cancelReservation({
      params: { ...P, reservationId: secondBooking },
      body: { reason: "Changed plans" },
    });
    const wrong = await refused(
      api(st.receptionist).checkIn({
        params: { ...P, stayId: promoBooking.stayId },
        body: { roomId: X.H.rooms["101"]!.id },
      }),
      409,
    );
    expect(wrong.message).toMatch(/Room 101 lacks what the guest booked: sea_view, high_floor/);
    const missing = await refused(
      api(st.receptionist).assignRoom({
        params: { ...P, stayId: promoBooking.stayId },
        body: { roomId: (await roomId("202"))! },
      }),
      409,
    );
    expect(missing.message).toMatch(/lacks what the guest booked: high_floor/);
    const ci = await api(st.receptionist).checkIn({ params: { ...P, stayId: promoBooking.stayId }, body: {} });
    expect(ci.stay.roomNumber).toBe("201");
    expect(ci.folio.lines.map((l) => [l.department, l.netMinor, l.totalMinor])).toEqual([
      ["fnb", 600_000, 600_000 + 60_000 + 105_600],
      ["other", 350_000, 350_000 + 56_000],
    ]);
  });

  it("the night charges the discounted rate and the features; the income audit lists the promo as a DISCOUNT", async () => {
    const { st, P } = X;
    const run = await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    expect(run.report.reconciled).toBe(true);
    const f = await api(st.receptionist).listFolios({ params: P, query: { stayId: promoBooking.stayId } });
    const lines = f.folios[0]!.lines.filter((l) => l.department === "rooms");
    expect(lines.map((l) => [l.netMinor, l.vatMinor, l.levyMinor])).toEqual([
      [900_000, 144_000, 18_000],
      [250_000, 40_000, 5_000],
    ]);
    expect(run.report.revenue.rooms).toBe(1_150_000);
    expect(run.report.roomsSold).toBe(1); // the feature charge is not a second room night
    const ia = await api(st.income_auditor).getIncomeAudit({ params: { ...P, date: "2026-10-11" } });
    expect(ia.findings.map((x) => [x.code, x.amountMinor])).toEqual([["DISCOUNT", 100_000]]);
    expect(ia.findings[0]!.message).toMatch(/promo code WELCOME10/);
  });

  it("a loyalty member gets the member rate — the better of it and a promo code, never both", async () => {
    const { st, P, orgId } = X;
    await api(st.general_manager).setLoyaltyProgramme({
      params: { orgId },
      body: {
        name: "Kilima Club",
        minorPerPoint: 10_000,
        pointValueMinor: 100,
        tiers: [
          { code: "BLUE", name: "Blue", minStays: 0, minPoints: 0, discountPct: 15, earnBonusPct: 0 },
          { code: "GOLD", name: "Gold", minStays: 5, minPoints: 5000, discountPct: 20, earnBonusPct: 25 },
        ],
      },
    });
    const g = (await api(st.receptionist).listGuests({ params: { orgId }, query: { q: "grace@guest.test" } }))
      .guests[0]!;
    await api(st.receptionist).enrolLoyaltyMember({ params: { orgId }, body: { guestId: g.id } });
    await api(st.revenue_manager).createPromoCode({ params: P, body: { code: "SMALL5", discountPct: 5 } });
    const body = {
      guest: { name: "Grace Wanjiru", email: "grace@guest.test" },
      arrival: "2026-10-20",
      departure: "2026-10-21",
      rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
      promoCode: "SMALL5",
    };
    const q = await api(st.receptionist).bookingQuote({ params: P, body });
    expect(q.discount).toEqual({ kind: "member", pct: 15, label: "Member rate (BLUE)" });
    expect(q.rooms[0]!.nights[0]!.rateMinor).toBe(850_000);
    const b = await api(st.receptionist).bookDirect({ params: P, body });
    expect(b.reservation.stays[0]!.nights[0]!.rateMinor).toBe(850_000);
    // the promo code was not used because the member rate was better
    const small = (await api(st.receptionist).listPromoCodes({ params: P })).promoCodes.find(
      (p) => p.code === "SMALL5",
    )!;
    expect(small.uses).toBe(0);
    const n = await X.S.sql("SELECT discount_kind, discount_ref FROM hotel_stay_nights WHERE stay_id = $1", [
      b.reservation.stays[0]!.id,
    ]);
    expect(n).toEqual([{ discount_kind: "member", discount_ref: "BLUE" }]);
  });

  async function roomId(number: string) {
    const setup = await api(X.st.receptionist).getSetup({ params: X.P });
    return setup.rooms.find((r) => r.number === number)?.id;
  }
});
