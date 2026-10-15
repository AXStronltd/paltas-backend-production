// Guests: the loyalty programme (earn at check-out, redeem at booking, credited at check-in, returned on cancel,
// adjustments by approvers) with its liability equal to the ledger; post-stay feedback with low-score alerts and
// trends; the hotel's own message wording; and the personalisation view of arrivals.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel guests: loyalty, feedback, personalisation", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let amina: { reservationId: string; stayId: string; guestId: string; memberId: string };
  let bob: { reservationId: string; stayId: string; folioId: string };

  beforeAll(async () => {
    X = await extHotel("Guests");
  });
  afterAll(() => X.S.close());

  it("the programme is set by the hotel's managers; points are adjusted only by approvers, with the liability posted", async () => {
    const { st, P, orgId } = X;
    const programme = {
      name: "Kilima Club",
      minorPerPoint: 10_000,
      pointValueMinor: 100,
      tiers: [
        { code: "BLUE", name: "Blue", minStays: 0, minPoints: 0, discountPct: 0, earnBonusPct: 0 },
        { code: "GOLD", name: "Gold", minStays: 2, minPoints: 500, discountPct: 10, earnBonusPct: 50 },
      ],
    };
    await refused(api(st.receptionist).setLoyaltyProgramme({ params: { orgId }, body: programme }), 403);
    const p = await api(st.general_manager).setLoyaltyProgramme({ params: { orgId }, body: programme });
    expect(p.programme!.tiers.map((t) => t.code)).toEqual(["BLUE", "GOLD"]);
    expect(p.chainConnection.connected).toBe(false);
    const r = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: { name: "Amina Yusuf", email: "amina@guest.test" },
        arrival: "2026-10-11",
        departure: "2026-10-13",
        rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
      },
    });
    const m = await api(st.receptionist).enrolLoyaltyMember({ params: { orgId }, body: { guestId: r.guest.id } });
    expect([m.tier, m.points, m.number]).toEqual(["BLUE", 0, "LOY-000001"]);
    await refused(api(st.receptionist).enrolLoyaltyMember({ params: { orgId }, body: { guestId: r.guest.id } }), 409);
    const found = await api(st.receptionist).listLoyaltyMembers({ params: { orgId }, query: { q: "amina" } });
    expect(found.members.map((x) => [x.number, x.guestName])).toEqual([["LOY-000001", "Amina Yusuf"]]);
    amina = { reservationId: r.id, stayId: r.stays[0]!.id, guestId: r.guest.id, memberId: m.id };
    await refused(
      api(st.receptionist).adjustPoints({
        params: { orgId, memberId: m.id },
        body: { propertyId: P.propertyId, points: 200, reason: "Welcome gift" },
      }),
      403,
    );
    const adj = await api(st.general_manager).adjustPoints({
      params: { orgId, memberId: m.id },
      body: { propertyId: P.propertyId, points: 200, reason: "Welcome gift" },
    });
    expect([adj.member.points, adj.entry.valueMinor]).toEqual([200, 20_000]);
    expect([await X.ledger("5700"), await X.ledger("2400")]).toEqual([20_000, -20_000]);
  });

  it("points redeemed at booking are held, credited on the folio at check-in (liability → guest ledger)", async () => {
    const { st, P, orgId } = X;
    await refused(
      api(st.receptionist).redeemPoints({
        params: { ...P, reservationId: amina.reservationId },
        body: { points: 300 },
      }),
      409,
    );
    const red = await api(st.receptionist).redeemPoints({
      params: { ...P, reservationId: amina.reservationId },
      body: { points: 150 },
    });
    expect([red.entry.status, red.member.points, red.member.pendingPoints]).toEqual(["pending", 50, 150]);
    await api(st.general_manager).updateGuest({
      params: { orgId, guestId: amina.guestId },
      body: { preferences: { pillow: "firm", temperature: "21" }, vip: true },
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: amina.stayId },
      body: { roomId: X.H.rooms["101"]!.id },
    });
    expect(ci.folio.lines.map((l) => [l.kind, l.totalMinor])).toEqual([["loyalty", -15_000]]);
    expect(await X.ledger("2400")).toBe(-20_000 + 15_000);
    const member = await api(st.receptionist).getLoyaltyMember({ params: { orgId, memberId: amina.memberId } });
    expect(member.member.pendingPoints).toBe(0);
    expect(member.entries.map((e) => [e.kind, e.points, e.status])).toEqual([
      ["adjust", 200, "done"],
      ["redeem", -150, "done"],
    ]);
    // the guest's preferences become a task for housekeeping
    const tasks = await api(st.housekeeping_supervisor).listRequests({ params: P, query: { status: "open" } });
    expect(tasks.requests.map((t) => t.text)).toContain(
      "Prepare room 101 for Amina Yusuf (VIP): pillow: firm, temperature: 21",
    );
    await api(st.receptionist).outletCharge({
      params: { ...P, outletId: X.H.outlets.spa },
      body: { roomNumber: "101", description: "Massage", amountMinor: 200_000 },
    });
    bob = await X.inHouse("Bob Kariuki", "102", { departure: "2026-10-12", email: "bob@guest.test" });
  });

  it("check-out earns points for the room revenue (accrued as a liability) and records the post-stay survey", async () => {
    const { st, P, orgId } = X;
    await api(st.general_manager).setMessageTemplate({
      params: { ...P, template: "post_stay_survey" },
      body: { subject: "Asante, {guest}", body: "Asante {guest} for staying at {hotel} ({number}). Rate us 1–5." },
    });
    await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    await refused(
      api(st.receptionist).recordFeedback({ params: P, body: { reservationId: amina.reservationId, score: 2 } }),
      409,
    );
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: bob.folioId },
      body: { method: "card", amountMinor: 1_180_000, reference: "BOB-1" },
    });
    await api(st.receptionist).checkOut({ params: { ...P, stayId: bob.stayId } });
    await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    const f = (await api(st.receptionist).listFolios({ params: P, query: { stayId: amina.stayId } })).folios[0]!;
    expect(f.balanceMinor).toBe(2 * 1_180_000 + 255_200 - 15_000);
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: f.id },
      body: { method: "card", amountMinor: f.balanceMinor, reference: "AMINA-1" },
    });
    const before = await X.ledger("5700");
    await api(st.receptionist).checkOut({ params: { ...P, stayId: amina.stayId } });
    const m = await api(st.receptionist).getLoyaltyMember({ params: { orgId, memberId: amina.memberId } });
    // 2 room nights of 1,000,000 before tax → 200 points
    expect([m.member.points, m.member.lifetimePoints, m.member.stays, m.member.tier]).toEqual([250, 400, 1, "BLUE"]);
    expect((await X.ledger("5700")) - before).toBe(20_000);
    // the liability equals the points held × their value
    expect(-(await X.ledger("2400"))).toBe((m.member.points + m.member.pendingPoints) * 100);
    const survey = await api(st.receptionist).listMessages({
      params: P,
      query: { reservationId: amina.reservationId },
    });
    expect(survey.messages.map((x) => x.template)).toEqual(["confirmation", "post_stay_survey"]);
    expect(survey.messages[1]!.body).toBe("Asante Amina Yusuf for staying at Guests Hotel (RES-000001). Rate us 1–5.");
    const tpl = (await api(st.receptionist).listMessageTemplates({ params: P })).templates;
    expect(tpl.find((x) => x.template === "post_stay_survey")).toMatchObject({
      custom: true,
      subject: "Asante, {guest}",
    });
    expect(tpl.find((x) => x.template === "confirmation")).toMatchObject({ custom: false, language: "en" });
    // the point value cannot change while points are outstanding
    const p = (await api(st.general_manager).getLoyaltyProgramme({ params: { orgId } })).programme!;
    await refused(
      api(st.general_manager).setLoyaltyProgramme({ params: { orgId }, body: { ...p, pointValueMinor: 200 } }),
      409,
    );
  });

  it("feedback: one survey per stay; a low score alerts the managers; trends and themes come from the hotel's own surveys", async () => {
    const { st, P } = X;
    const low = await api(st.receptionist).recordFeedback({
      params: P,
      body: {
        reservationId: amina.reservationId,
        score: 2,
        categories: { service: 2, cleanliness: 3 },
        comment: "Slow breakfast service and a noisy corridor",
      },
    });
    expect(low.alertRequestId).not.toBeNull();
    const alert = (await api(st.general_manager).listRequests({ params: P, query: { status: "open" } })).requests.find(
      (r) => r.id === low.alertRequestId,
    )!;
    expect([alert.kind, alert.source]).toEqual(["handoff", "guest"]);
    const mails = await X.S.sql(
      "SELECT recipient FROM hotel_messages WHERE template = 'low_score_alert' AND property_id = $1 ORDER BY recipient",
      [P.propertyId],
    );
    expect(mails.map((m) => m.recipient).sort()).toEqual(
      [st.general_manager.email, st.front_office_manager.email, st.financial_controller.email].sort(),
    );
    await refused(
      api(st.receptionist).recordFeedback({ params: P, body: { reservationId: amina.reservationId, score: 5 } }),
      409,
    );
    const good = await api(st.receptionist).recordFeedback({
      params: P,
      body: {
        reservationId: bob.reservationId,
        score: 5,
        categories: { service: 5 },
        comment: "Lovely breakfast, friendly staff",
      },
    });
    expect(good.alertRequestId).toBeNull();
    const list = await api(st.general_manager).listFeedback({
      params: P,
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(list.feedback.map((f) => [f.guestName, f.score]).sort()).toEqual([
      ["Amina Yusuf", 2],
      ["Bob Kariuki", 5],
    ]);
    const rep = await api(st.general_manager).feedbackReport({
      params: P,
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect([rep.responses, rep.averageScore, rep.lowScores]).toEqual([2, 3.5, 1]);
    expect(rep.categories).toEqual([
      { category: "cleanliness", averageScore: 3, responses: 1 },
      { category: "service", averageScore: 3.5, responses: 2 },
    ]);
    expect(rep.themes).toEqual([{ word: "breakfast", mentions: 2, averageScore: 3.5 }]);
    expect(rep.method).toMatch(/no external AI/);
    expect(rep.reviewInvitations.connected).toBe(false);
    await refused(
      api(st.receptionist).feedbackReport({ params: P, query: { from: "2026-10-01", to: "2026-10-31" } }),
      403,
    );
  });

  it("points redeemed on a booking that is cancelled go back to the member; personalisation shows what the hotel knows", async () => {
    const { st, P, orgId } = X;
    const book = () =>
      api(st.receptionist).createReservation({
        params: P,
        body: {
          guest: { name: "Amina Yusuf", email: "amina@guest.test" },
          arrival: "2026-10-20",
          departure: "2026-10-22",
          rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
        },
      });
    const r = await book();
    await api(st.receptionist).redeemPoints({ params: { ...P, reservationId: r.id }, body: { points: 100 } });
    await api(st.receptionist).cancelReservation({
      params: { ...P, reservationId: r.id },
      body: { reason: "Plans changed" },
    });
    const m = await api(st.receptionist).getLoyaltyMember({ params: { orgId, memberId: amina.memberId } });
    expect([m.member.points, m.member.pendingPoints]).toEqual([250, 0]);
    expect(m.entries.slice(-2).map((e) => [e.kind, e.points, e.status])).toEqual([
      ["redeem", -100, "reversed"],
      ["reverse", 100, "done"],
    ]);
    expect(-(await X.ledger("2400"))).toBe(250 * 100);
    await book();
    const view = await api(st.housekeeping_supervisor).personalisation({ params: P, query: { date: "2026-10-20" } });
    expect(view.arrivals).toHaveLength(1);
    const a = view.arrivals[0]!;
    expect([a.guestName, a.vip, a.returning, a.previousStays, a.loyaltyTier, a.lastScore]).toEqual([
      "Amina Yusuf",
      true,
      true,
      1,
      "BLUE",
      2,
    ]);
    expect(a.previousSpendMinor).toBe(2_000_000 + 200_000);
    expect(a.roomSetup).toEqual({ temperatureC: 21, notes: ["pillow: firm"] });
    expect(a.offers).toEqual(["Spa treatment (booked spa before)", "VIP welcome amenity"]);
    expect(view.method).toMatch(/no external AI/);
    // the guest is the organisation's one contact (core/contacts), not a second guest list
    const links = await X.S.sql(
      `SELECT c.email, c.types, c.tags, c.consent_email FROM hotel_guests g JOIN contacts c ON c.id = g.contact_id
       WHERE g.id = $1`,
      [amina.guestId],
    );
    expect(links).toEqual([
      { email: "amina@guest.test", types: ["prospect"], tags: ["hotel_guest"], consent_email: true },
    ]);
    const all = await X.S.sql(
      "SELECT count(*)::int AS n FROM contacts WHERE org_id = $1 AND lower(email) = 'amina@guest.test'",
      [orgId],
    );
    expect(all).toEqual([{ n: 1 }]);
  });
});
