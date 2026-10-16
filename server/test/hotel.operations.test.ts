// Front desk, folios, smart-room boundaries, income audit and the reports that must equal the ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BAR,
  buildHotel,
  channelBooking,
  guest,
  hotelOrg,
  NRF,
  startHotelServer,
  type Staff,
  type TestHotel,
} from "./support/hotel-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("hotel operations", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let H: TestHotel;
  let P: { orgId: string; propertyId: string };
  const D1 = "2026-10-11";
  const D2 = "2026-10-12";
  const api = (p: Person) => p.api.hotel;
  const ledgerSum = async (code: string, from = D1, to = from) => {
    const a = await st.financial_controller.api.ledger.accountActivity({
      params: { orgId, code },
      query: { from, to },
    });
    return a.lines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0);
  };
  const reserve = (p: Person, body: Record<string, unknown>) =>
    api(p).createReservation({ params: P, body: body as never });

  let kofi: { id: string; stayId: string; folioId: string; keyId: string };
  let lena: { stayId: string; folioId: string };
  let minibarLine: string;

  beforeAll(async () => {
    S = await startHotelServer();
    const o = await hotelOrg(S, "Savanna Hotels");
    orgId = o.orgId;
    st = o.staff;
    H = await buildHotel(orgId, st.general_manager, { name: "Savanna Lodge", staff: st });
    P = { orgId, propertyId: H.propertyId };
  });
  afterAll(() => S.close());

  it("names every external system honestly: test adapters, not connected", async () => {
    const r = await api(st.receptionist).integrations({ params: P });
    const by = Object.fromEntries(r.adapters.map((a) => [a.kind, a]));
    for (const k of ["channel_manager", "door_locks", "room_controls", "messaging", "payments"] as const)
      expect(by[k]!.connected).toBe(false);
    expect(by.door_locks!.status).toBe("Not connected — test adapter");
    expect(by.ai_concierge!.status).toMatch(/no external AI/);
  });

  it("recognises a returning guest and keeps preferences; allergies only with consent", async () => {
    const first = await reserve(st.receptionist, {
      guest: guest("Grace Mutua", { phone: "+254711000111" }),
      arrival: "2026-11-01",
      departure: "2026-11-02",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    expect(first.guest.returning).toBe(false);
    const again = await reserve(st.receptionist, {
      guest: { name: "G. Mutua", phone: "+254711000111" },
      arrival: "2026-12-01",
      departure: "2026-12-02",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    expect([again.guest.id, again.guest.returning]).toEqual([first.guest.id, true]);
    await refused(
      api(st.receptionist).updateGuest({ params: { orgId, guestId: first.guest.id }, body: { allergies: "Peanuts" } }),
      400,
    );
    const g = await api(st.receptionist).updateGuest({
      params: { orgId, guestId: first.guest.id },
      body: { allergies: "Peanuts", allergyConsent: true, vip: true, preferences: { pillow: "firm", floor: "high" } },
    });
    expect([g.allergies, g.vip, g.preferences.pillow]).toEqual(["Peanuts", true, "firm"]);
    const found = await api(st.receptionist).listGuests({ params: { orgId }, query: { q: "+254711000111" } });
    expect(found.guests.map((x) => x.id)).toEqual([first.guest.id]);
  });

  it("cancellations follow the rate plan: non-refundable keeps the deposit and charges the stay, refundable is free until the deadline", async () => {
    const nrf = await reserve(st.receptionist, {
      guest: guest("No Refund"),
      arrival: "2026-10-20",
      departure: "2026-10-22",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.NRF }],
    });
    await api(st.receptionist).preCheckIn({
      params: { ...P, reservationId: nrf.id },
      body: {
        idCaptured: true,
        idDocumentRef: "doc/id/1",
        signatureRef: "doc/sig/1",
        deposit: { amountMinor: 500_000, method: "mobile_money", reference: "MPESA-QX1" },
      },
    });
    const c1 = await api(st.receptionist).cancelReservation({
      params: { ...P, reservationId: nrf.id },
      body: { reason: "Guest cancelled" },
    });
    expect(c1.feeMinor).toBe(2 * NRF.STD);
    const f1 = await api(st.receptionist).getFolio({ params: { ...P, folioId: c1.folioId! } });
    expect(f1.lines.map((l) => [l.kind, l.department, l.totalMinor])).toEqual([
      ["charge", "noshow", 2 * NRF.STD + 288_000],
      ["deposit", null, -500_000],
    ]);
    const early = await reserve(st.receptionist, {
      guest: guest("Early Canceller"),
      arrival: "2026-10-20",
      departure: "2026-10-21",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    expect(
      (
        await api(st.receptionist).cancelReservation({
          params: { ...P, reservationId: early.id },
          body: { reason: "Changed dates" },
        })
      ).feeMinor,
    ).toBe(0);
    const late = await reserve(st.receptionist, {
      guest: guest("Late Canceller"),
      arrival: D2,
      departure: "2026-10-14",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    expect(
      (
        await api(st.receptionist).cancelReservation({
          params: { ...P, reservationId: late.id },
          body: { reason: "Too late" },
        })
      ).feeMinor,
    ).toBe(BAR.STD);
    expect(await ledgerSum("4500")).toBe(-(2 * NRF.STD + BAR.STD));
  });

  it("energy: eco mode for vacant unsold rooms, welcome temperature for a pre-assigned arrival (recorded, not sent)", async () => {
    const r = await reserve(st.receptionist, {
      guest: guest("Kofi Mensah"),
      arrival: D1,
      departure: "2026-10-13",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    await api(st.receptionist).assignRoom({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["103"]!.id },
    });
    const out = await api(st.technician).runEnergy({ params: P });
    const welcome = out.commands.find((c) => c.roomNumber === "103")!;
    expect([welcome.command, welcome.value]).toEqual(["set_temperature", 22]);
    expect(welcome.integration).toMatchObject({ connected: false, status: expect.stringMatching(/not sent/) });
    const eco = out.commands.filter((c) => c.command === "eco_on");
    expect(eco).toHaveLength(29);
    expect(
      (await api(st.technician).runEnergy({ params: P })).commands.filter((c) => c.command === "eco_on"),
    ).toHaveLength(0);
    const board = await api(st.receptionist).roomBoard({ params: P });
    expect(board.rooms.find((x) => x.number === "104")!.ecoMode).toBe(true);
    kofi = { id: r.id, stayId: r.stays[0]!.id, folioId: "", keyId: "" };
  });

  it("mobile key: opens its room during the stay, moves with the guest, stops at check-out", async () => {
    const ci = await api(st.receptionist).checkIn({ params: { ...P, stayId: kofi.stayId }, body: {} });
    expect(ci.stay.roomNumber).toBe("103"); // the pre-assigned room
    kofi.folioId = ci.folio.id;
    const check = (keyId: string, room: string, date: string) =>
      api(st.receptionist).checkKey({ params: { ...P, keyId }, body: { roomId: H.rooms[room]!.id, date } });
    expect((await check(ci.key.id, "103", D1)).opens).toBe(true);
    expect((await check(ci.key.id, "103", "2026-10-13")).opens).toBe(true);
    expect((await check(ci.key.id, "103", "2026-10-14")).reason).toBe("Outside the stay dates");
    expect((await check(ci.key.id, "104", D1)).reason).toBe("Key is for another room");
    // room 104 was put in eco mode; moving the guest there issues a new key and the old one stops working
    const moved = await api(st.receptionist).moveRoom({
      params: { ...P, stayId: kofi.stayId },
      body: { roomId: H.rooms["104"]!.id, reason: "Air conditioning noise" },
    });
    expect(moved.stay.roomNumber).toBe("104");
    expect((await check(ci.key.id, "103", D1)).reason).toBe("Key revoked");
    expect((await check(moved.key.id, "104", D1)).opens).toBe(true);
    const ext = await api(st.receptionist).extendStay({
      params: { ...P, stayId: kofi.stayId },
      body: { departure: "2026-10-14" },
    });
    expect(ext.nights.map((n) => n.date)).toEqual([D1, D2, "2026-10-13"]);
    expect((await check(moved.key.id, "104", "2026-10-14")).opens).toBe(true);
    const keys = await api(st.receptionist).listKeys({ params: { ...P, stayId: kofi.stayId } });
    expect(keys.keys.map((k) => k.status)).toEqual(["revoked", "active"]);
    kofi.keyId = moved.key.id;
    const board = await api(st.receptionist).roomBoard({ params: P });
    expect(board.rooms.find((x) => x.number === "103")!.housekeeping).toBe("dirty");
  });

  it("folios: taxes per department, split and transfer, routing, minibar, blocked folio refuses room charges", async () => {
    const laundry = await api(st.receptionist).postCharge({
      params: { ...P, folioId: kofi.folioId },
      body: { department: "other", description: "Laundry", amountMinor: 50_000 },
    });
    expect(laundry.lines.at(-1)).toMatchObject({
      serviceChargeMinor: 0,
      vatMinor: 8_000,
      levyMinor: 0,
      totalMinor: 58_000,
    });
    const second = await api(st.receptionist).createFolio({
      params: P,
      body: { stayId: kofi.stayId, name: "Spa account", payer: "guest" },
    });
    await api(st.receptionist).setRouting({
      params: { ...P, stayId: kofi.stayId },
      body: { rules: [{ department: "spa", folioId: second.id }] },
    });
    const spa = await api(st.receptionist).outletCharge({
      params: { ...P, outletId: H.outlets.spa },
      body: { roomNumber: "104", description: "Facial", amountMinor: 200_000 },
    });
    expect(spa.folioId).toBe(second.id);
    const moved = await api(st.receptionist).transferLines({
      params: { ...P, folioId: kofi.folioId },
      body: { lineIds: [laundry.lines.at(-1)!.id], toFolioId: second.id },
    });
    expect(moved.from.balanceMinor).toBe(0);
    expect(moved.to.balanceMinor).toBe(58_000 + 255_200);
    await refused(
      api(st.receptionist).transferLines({
        params: { ...P, folioId: kofi.folioId },
        body: { lineIds: [laundry.lines.at(-1)!.id], toFolioId: second.id },
      }),
      409,
    );
    const mini = await api(st.housekeeping_attendant).postMinibar({
      params: { ...P, roomId: H.rooms["104"]!.id },
      body: { items: [{ description: "Sparkling water", quantity: 2, unitMinor: 25_000 }] },
    });
    expect(mini.line).toMatchObject({
      department: "fnb",
      netMinor: 50_000,
      serviceChargeMinor: 5_000,
      vatMinor: 8_800,
    });
    minibarLine = mini.line.id;
    await api(st.front_office_manager).blockFolio({
      params: { ...P, folioId: kofi.folioId },
      body: { blocked: true, reason: "Card declined" },
    });
    const e = await refused(
      api(st.receptionist).outletCharge({
        params: { ...P, outletId: H.outlets.restaurant },
        body: { roomNumber: "104", description: "Lunch", amountMinor: 100_000 },
      }),
      409,
    );
    expect(e.message).toMatch(/blocked .*payment on the spot/);
    await api(st.front_office_manager).blockFolio({
      params: { ...P, folioId: kofi.folioId },
      body: { blocked: false, reason: "Card replaced" },
    });
  });

  it("refunds need a second person; voids are reversed in the ledger", async () => {
    const r = await reserve(st.receptionist, {
      guest: guest("Lena Fischer"),
      arrival: D1,
      departure: D2,
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR, rateOverrideMinor: 800_000 }],
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["105"]!.id },
    });
    lena = { stayId: ci.stay.id, folioId: ci.folio.id };
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: lena.folioId },
      body: { method: "card", amountMinor: 2_000_000, reference: "PSP-9" },
    });
    await refused(
      api(st.receptionist).requestRefund({
        params: { ...P, folioId: lena.folioId },
        body: { amountMinor: 2_000_001, method: "card", reason: "Overpaid" },
      }),
      400,
    );
    const r1 = await api(st.receptionist).requestRefund({
      params: { ...P, folioId: lena.folioId },
      body: { amountMinor: 500_000, method: "card", reason: "Overpaid at check-in" },
    });
    await refused(api(st.receptionist).approveRefund({ params: { ...P, refundId: r1.id } }), 403, "ROLE_NOT_ALLOWED");
    // the approver finds what waits for approval without knowing the id
    const waiting = await api(st.general_manager).listRefunds({ params: P, query: { status: "requested" } });
    expect(waiting.refunds.map((r) => [r.id, r.amountMinor, r.status])).toEqual([[r1.id, 500_000, "requested"]]);
    expect(waiting.refunds[0]!.folioId).toBe(lena.folioId);
    await refused(api(st.receptionist).listRefunds({ params: P, query: {} }), 403, "ROLE_NOT_ALLOWED");
    const bank = await ledgerSum("1000");
    expect((await api(st.general_manager).approveRefund({ params: { ...P, refundId: r1.id } })).status).toBe(
      "approved",
    );
    expect(await ledgerSum("1000")).toBe(bank - 500_000);
    expect((await api(st.general_manager).listRefunds({ params: P, query: { status: "requested" } })).refunds).toEqual(
      [],
    );
    const r2 = await api(st.front_office_manager).requestRefund({
      params: { ...P, folioId: lena.folioId },
      body: { amountMinor: 300_000, method: "card", reason: "Second overpayment" },
    });
    await refused(
      api(st.front_office_manager).approveRefund({ params: { ...P, refundId: r2.id } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await api(st.credit_controller).approveRefund({ params: { ...P, refundId: r2.id } });
    expect((await api(st.receptionist).getFolio({ params: { ...P, folioId: lena.folioId } })).balanceMinor).toBe(
      -1_200_000,
    );

    // voids: one by the receptionist (approved before the night audit), one by the front office manager (approved by the GM)
    const before = await ledgerSum("4200");
    await api(st.receptionist).voidLine({
      params: { ...P, folioId: kofi.folioId, lineId: minibarLine },
      body: { reason: "Guest did not take it" },
    });
    expect(await ledgerSum("4200")).toBe(before + 50_000);
    const extra = await api(st.receptionist).postCharge({
      params: { ...P, folioId: lena.folioId },
      body: { department: "other", description: "Parking", amountMinor: 10_000 },
    });
    const parking = extra.lines.at(-1)!.id;
    await api(st.front_office_manager).voidLine({
      params: { ...P, folioId: lena.folioId, lineId: parking },
      body: { reason: "Posted to the wrong guest" },
    });
    await refused(
      api(st.front_office_manager).approveVoid({ params: { ...P, folioId: lena.folioId, lineId: parking } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const approved = await api(st.general_manager).approveVoid({
      params: { ...P, folioId: lena.folioId, lineId: parking },
    });
    expect(approved.lines.find((l) => l.voidsLineId === parking)!.voidApprovedBy).toBe(st.general_manager.userId);
  });

  it("costs post to the ledger by department", async () => {
    await api(st.financial_controller).postCost({
      params: P,
      body: { account: "5100", amountMinor: 200_000, memo: "Room amenities", paidFrom: "bank" },
    });
    await api(st.financial_controller).postCost({
      params: P,
      body: { account: "5200", amountMinor: 50_000, memo: "Kitchen produce", paidFrom: "payable" },
    });
    await api(st.financial_controller).postCost({
      params: P,
      body: { account: "5000", amountMinor: 30_000, memo: "Admin office", paidFrom: "bank" },
    });
    await refused(
      api(st.receptionist).postCost({
        params: P,
        body: { account: "5100", amountMinor: 1, memo: "Nope", paidFrom: "bank" },
      }),
      403,
    );
    await refused(
      api(st.financial_controller).postCost({
        params: P,
        body: { account: "4100", amountMinor: 1, memo: "Not a cost", paidFrom: "bank" },
      }),
      400,
    );
  });

  it("a channel guest's room nights carry the channel commission", async () => {
    const r = await channelBooking(S, {
      orgId,
      propertyId: H.propertyId,
      channelCode: "BKG",
      externalRef: "OTA-4401",
      guest: guest("Olu Channel"),
      roomTypeId: H.types.STD,
      ratePlanId: H.plans.BAR,
      arrival: D1,
      departure: D2,
    });
    const res = await api(st.receptionist).getReservation({ params: { ...P, reservationId: r.body.reservationId } });
    await api(st.receptionist).checkIn({
      params: { ...P, stayId: res.stays[0]!.id },
      body: { roomId: H.rooms["106"]!.id },
    });
  });

  it("night audit waits for void approval; income audit catches the low rate; sign-off by the income auditor", async () => {
    const blocked = await refused(api(st.front_office_manager).runNightAudit({ params: P, body: {} }), 409);
    const voids = blocked.details.blocks.find((b: { code: string }) => b.code === "UNAPPROVED_VOIDS");
    expect(voids.message).toMatch(/Sparkling water/);
    await api(st.front_office_manager).approveVoid({
      params: { ...P, folioId: kofi.folioId, lineId: minibarLine },
    });
    const out = await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    expect(out.report.reconciled).toBe(true);
    const ia = await api(st.income_auditor).getIncomeAudit({ params: { ...P, date: D1 } });
    expect(ia.findings.map((f) => [f.code, f.amountMinor])).toEqual([["RATE_BELOW_PLAN", 200_000]]);
    expect(ia.final).toBe(false);
    await refused(
      api(st.front_office_manager).signOffIncomeAudit({ params: { ...P, date: D1 }, body: { note: "Looks fine" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const unack = await refused(
      api(st.income_auditor).signOffIncomeAudit({ params: { ...P, date: D1 }, body: { note: "Looks fine" } }),
      409,
    );
    expect(unack.details.findings).toHaveLength(1);
    const signed = await api(st.income_auditor).signOffIncomeAudit({
      params: { ...P, date: D1 },
      body: { note: "Corporate discount confirmed by GM", acknowledgeFindings: true },
    });
    expect([signed.final, signed.signedOffBy]).toEqual([true, st.income_auditor.userId]);
    await refused(
      api(st.income_auditor).signOffIncomeAudit({
        params: { ...P, date: D1 },
        body: { note: "Again please", acknowledgeFindings: true },
      }),
      409,
    );
  });

  it("flash report, departmental P&L, KPIs and channel profitability equal the Finance ledger to the minor unit", async () => {
    S.setToday(D2);
    const credit = async (code: string) => 0 - (await ledgerSum(code));
    const debit = (code: string) => ledgerSum(code);
    const flash = await api(st.general_manager).flashReport({ params: P, query: { date: D1 } });
    expect(flash.revenue.rooms).toBe(await credit("4100"));
    expect(flash.revenue.fnb).toBe(await credit("4200"));
    expect(flash.revenue.spa).toBe(await credit("4300"));
    expect(flash.revenue.other).toBe(await credit("4400"));
    expect(flash.revenue.noshow).toBe(await credit("4500"));
    expect(flash.payments.card).toBe(2_000_000);
    expect(flash.depositsReceivedMinor).toBe(500_000);
    // rooms: Kofi 10,000 + Lena 8,000 + channel guest 10,000
    expect(flash.revenue.rooms).toBe(BAR.STD + 800_000 + BAR.STD);

    const pnl = await api(st.financial_controller).departmentalPnl({ params: P, query: { from: D1, to: D1 } });
    const dept = (k: string) => pnl.departments.find((d) => d.key === k)!;
    expect(dept("rooms").revenueMinor).toBe((await credit("4100")) + (await credit("4500")));
    expect(dept("rooms").costsMinor).toBe((await debit("5100")) + (await debit("5600")));
    expect(dept("fnb")).toMatchObject({ revenueMinor: await credit("4200"), costsMinor: await debit("5200") });
    expect(pnl.undistributed.costsMinor).toBe((await debit("5000")) + (await debit("5300")));
    const revenue = (await Promise.all(["4100", "4200", "4300", "4400", "4500"].map(credit))).reduce(
      (a, b) => a + b,
      0,
    );
    const costs = (await Promise.all(["5100", "5200", "5600", "5000", "5300"].map(debit))).reduce((a, b) => a + b, 0);
    expect(pnl.totalRevenueMinor).toBe(revenue);
    expect(pnl.gopMinor).toBe(revenue - costs);
    expect(pnl.gopparMinor).toBe(Math.round((revenue - costs) / 30));
    expect(dept("rooms").accounts.map((a) => a.name)).toContain("Rooms revenue");

    const k = await api(st.general_manager).kpis({ params: P, query: { from: D1, to: D1 } });
    expect([k.roomsSold, k.gopMinor, k.costPerOccupiedRoomMinor]).toEqual([
      3,
      revenue - costs,
      Math.round(((await debit("5100")) + (await debit("5600"))) / 3),
    ]);

    const ch = await api(st.revenue_manager).channelReport({ params: P, query: { from: D1, to: D1 } });
    const ota = ch.channels.find((c) => c.channelId === H.channelId)!;
    expect(ota).toMatchObject({
      roomNights: 1,
      roomRevenueMinor: BAR.STD,
      commissionMinor: 150_000,
      netMinor: BAR.STD - 150_000,
    });
    expect(await debit("5600")).toBe(150_000);
    expect(ch.channels.find((c) => c.channelId === null)).toMatchObject({
      roomNights: 2,
      roomRevenueMinor: BAR.STD + 800_000,
    });
  });

  it("the next audit is blocked while guests due out have not checked out", async () => {
    const e = await refused(api(st.front_office_manager).runNightAudit({ params: P, body: {} }), 409);
    const due = e.details.blocks.find((b: { code: string }) => b.code === "DEPARTURE_NOT_CHECKED_OUT");
    expect(due.message).toMatch(/105/);
    // a guest with a credit must be refunded before leaving
    expect(
      (await refused(api(st.receptionist).checkOut({ params: { ...P, stayId: lena.stayId } }), 409)).message,
    ).toMatch(/refund it first/);
  });

  it("concierge answers from the hotel's FAQ and hands anything else to staff; messages are recorded, not sent", async () => {
    const a = await api(st.receptionist).askConcierge({
      params: P,
      body: { question: "Hi! What's the WiFi please?", reservationId: kofi.id },
    });
    expect([a.answered, a.answer]).toEqual([true, "Network KILIMA-GUEST, password beach2026."]);
    const b = await api(st.receptionist).askConcierge({
      params: P,
      body: { question: "Can you arrange a birthday cake for tonight?", reservationId: kofi.id },
    });
    expect(b.answered).toBe(false);
    const tasks = await api(st.receptionist).listRequests({ params: P, query: { status: "open" } });
    expect(tasks.requests.find((t) => t.id === b.handoffRequestId)).toMatchObject({
      kind: "handoff",
      source: "concierge",
    });
    await api(st.receptionist).completeRequest({ params: { ...P, requestId: b.handoffRequestId! } });
    const sent = await api(st.receptionist).sendMessage({
      params: P,
      body: { reservationId: kofi.id, channel: "whatsapp", body: "Your cake is ready." },
    });
    expect(sent.status).toBe("Recorded — not sent (no messaging provider connected)");
    const msgs = await api(st.receptionist).listMessages({ params: P, query: { reservationId: kofi.id } });
    // the booking confirmation was recorded automatically (outbox), then the concierge thread and the staff message
    expect(msgs.messages.map((m) => [m.direction, m.template])).toEqual([
      ["outbound", "confirmation"],
      ["inbound", null],
      ["outbound", null],
      ["inbound", null],
      ["outbound", null],
      ["outbound", null],
    ]);
    expect(msgs.messages[0]!.status).toMatch(/^Outbox: recorded/);
    const wake = await api(st.receptionist).createRequest({
      params: P,
      body: { stayId: kofi.stayId, kind: "wake_up", text: "Wake-up 06:00", dueAt: "2026-10-13T03:00:00Z" },
    });
    expect(wake.reservationId).toBe(kofi.id);
  });

  it("lost and found register", async () => {
    const item = await api(st.housekeeping_attendant).createLostFound({
      params: P,
      body: { roomId: H.rooms["103"]!.id, item: "Sunglasses", photoRef: "documents/lf/1.jpg" },
    });
    expect([item.status, item.foundOn]).toEqual(["held", D2]);
    const done = await api(st.housekeeping_supervisor).updateLostFound({
      params: { ...P, itemId: item.id },
      body: { guestContacted: true, status: "returned" },
    });
    expect([done.guestContacted, done.status]).toEqual([true, "returned"]);
    expect((await api(st.receptionist).listLostFound({ params: P })).items).toHaveLength(1);
  });
});
