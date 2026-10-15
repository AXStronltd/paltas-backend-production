// Hotel spec section 13: the 13 acceptance steps, run as one test hotel over three business days (2026-10-11 → 13),
// from bookings on several channels to night audit, with the figures checked against the Finance ledger.
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

describe("hotel acceptance (spec section 13)", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let st: Staff;
  let H: TestHotel;
  let P: { orgId: string; propertyId: string };
  const D1 = "2026-10-11";
  const D2 = "2026-10-12";
  const D3 = "2026-10-13";
  const api = (p: Person) => p.api.hotel;
  const avail = async (p: Person, roomTypeId: string, date: string, channelId?: string) => {
    const a = await api(p).availability({
      params: P,
      query: { from: date, to: date, ...(channelId ? { channelId } : {}) },
    });
    return a.roomTypes.find((r) => r.roomTypeId === roomTypeId)!.days[0]!;
  };
  /** Credit − debit on an account for posted journals of one day (single-hotel organisation). */
  const ledgerCredit = async (code: string, from: string, to = from) => {
    const a = await st.financial_controller.api.ledger.accountActivity({
      params: { orgId, code },
      query: { from, to },
    });
    return a.lines.reduce((n, l) => n + l.creditMinor - l.debitMinor, 0);
  };
  const ledgerBalance = async (code: string) =>
    (await st.financial_controller.api.ledger.listAccounts({ params: { orgId } })).accounts.find(
      (a) => a.code === code,
    )!.balanceMinor;

  // shared through the scenario
  let amina: { reservationId: string; stayId: string; folioId: string; keyId: string };
  let brian: { reservationId: string; stayId: string; guestFolio: string; companyFolio: string };
  let chen: string;
  let groupId: string;
  let shiftId: string;

  beforeAll(async () => {
    S = await startHotelServer();
    const o = await hotelOrg(S, "Kilima Hotels");
    orgId = o.orgId;
    admin = o.admin;
    st = o.staff;
    H = await buildHotel(orgId, st.general_manager, { restaurantStaff: [st.outlet_staff.userId], staff: st });
    P = { orgId, propertyId: H.propertyId };
  });
  afterAll(() => S.close());

  it("1. 30 rooms in 3 types, 2 rate plans and 1 channel: availability and rates on the booking engine and the channel", async () => {
    const setup = await api(st.receptionist).getSetup({ params: P });
    expect(setup.property.businessDate).toBe(D1);
    expect(setup.roomTypes.map((t) => [t.code, t.roomCount])).toEqual([
      ["DLX", 10],
      ["STD", 15],
      ["STE", 5],
    ]);
    expect(setup.rooms).toHaveLength(30);
    expect(setup.ratePlans.map((r) => r.code)).toEqual(["BAR", "NRF"]);
    expect(setup.channels).toHaveLength(1);
    expect(setup.channels[0]!.integration).toEqual({
      adapter: "sandbox",
      connected: false,
      status: "Not connected — test adapter",
    });
    // booking engine (direct) and channel see the same availability and both rates
    for (const ch of [undefined, H.channelId]) {
      const d = await avail(st.receptionist, H.types.STD, "2026-10-20", ch);
      expect([d.total, d.available]).toEqual([15, 15]);
      expect(d.rates.map((r) => [r.code, r.amountMinor])).toEqual([
        ["BAR", BAR.STD],
        ["NRF", NRF.STD],
      ]);
    }
    // the channel manager queue holds availability AND rates for the channel (not transmitted: test adapter)
    const q = await api(st.revenue_manager).ariQueue({ params: P, query: { channelId: H.channelId } });
    const ste = q.messages.find((m) => m.roomTypeId === H.types.STE)!;
    expect(ste.status).toMatch(/not transmitted/);
    expect(ste.days[0]).toMatchObject({ available: 5, closed: false });
    expect(ste.days[0]!.rates).toContainEqual({ ratePlanId: H.plans.BAR, amountMinor: BAR.STE });
  });

  it("2. the last room of a type sold on the channel shows sold out on the booking engine at once", async () => {
    const res = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Tour Operator"),
        arrival: "2026-10-20",
        departure: "2026-10-21",
        rooms: Array.from({ length: 4 }, () => ({ roomTypeId: H.types.STE, ratePlanId: H.plans.BAR, adults: 2 })),
      },
    });
    expect(res.stays).toHaveLength(4);
    expect((await avail(st.receptionist, H.types.STE, "2026-10-20")).available).toBe(1);
    const body = {
      orgId,
      propertyId: H.propertyId,
      channelCode: "BKG",
      externalRef: "BKG-778812",
      guest: guest("Dana OTA"),
      roomTypeId: H.types.STE,
      ratePlanId: H.plans.BAR,
      arrival: "2026-10-20",
      departure: "2026-10-21",
      adults: 2,
    };
    const r = await channelBooking(S, body);
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    // sold out everywhere at once
    expect((await avail(st.receptionist, H.types.STE, "2026-10-20")).available).toBe(0);
    expect((await avail(st.receptionist, H.types.STE, "2026-10-20", H.channelId)).available).toBe(0);
    const q = await api(st.revenue_manager).ariQueue({ params: P, query: { channelId: H.channelId } });
    const latest = q.messages.find((m) => m.roomTypeId === H.types.STE)!;
    expect(latest.days.find((d) => d.date === "2026-10-20")!.available).toBe(0);
    await refused(
      api(st.receptionist).createReservation({
        params: P,
        body: {
          guest: guest("Too Late"),
          arrival: "2026-10-20",
          departure: "2026-10-21",
          rooms: [{ roomTypeId: H.types.STE, ratePlanId: H.plans.BAR }],
        },
      }),
      409,
    );
    expect((await channelBooking(S, { ...body, externalRef: "BKG-778813" })).status).toBe(409);
    // the channel delivers the same booking again: taken once
    const again = await channelBooking(S, body);
    expect([again.status, again.body.duplicate, again.body.reservationId]).toEqual([200, true, r.body.reservationId]);
    // a bad signature is refused
    expect((await channelBooking(S, body, { secret: "wrong" })).status).toBe(401);
    const chRes = await api(st.receptionist).getReservation({ params: { ...P, reservationId: r.body.reservationId } });
    expect([chRes.source, chRes.channelId, chRes.externalRef]).toEqual(["channel", H.channelId, "BKG-778812"]);
  });

  it("3. a guest books direct and completes digital check-in: ID, signature and deposit before arrival", async () => {
    const res = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Amina Yusuf", { phone: "+254700111222" }),
        arrival: D1,
        departure: D3,
        source: "booking_engine",
        rooms: [{ roomTypeId: H.types.DLX, ratePlanId: H.plans.BAR, adults: 2 }],
      },
    });
    expect([res.status, res.nights, res.roomTotalMinor]).toEqual(["confirmed", 2, 2 * BAR.DLX]);
    const pre = await api(st.receptionist).preCheckIn({
      params: { ...P, reservationId: res.id },
      body: {
        idCaptured: true,
        idDocumentRef: "documents/id/amina-passport.pdf",
        nationality: "Kenyan",
        signatureRef: "documents/signatures/amina-regcard.png",
        arrivalTime: "15:30",
        deposit: { amountMinor: 500_000, method: "card", reference: "PSP-AUTH-55120" },
      },
    });
    expect(pre.preCheckIn).toMatchObject({ idCaptured: true, idDocumentRef: "documents/id/amina-passport.pdf" });
    expect(pre.deposits).toEqual([
      expect.objectContaining({ amountMinor: 500_000, method: "card", appliedToFolioId: null }),
    ]);
    // the deposit is a liability until the stay: bank 1000 debit, deposits 2350 credit
    expect(await ledgerBalance("2350")).toBe(-500_000);
    expect(await ledgerBalance("1000")).toBe(500_000);
    amina = { reservationId: res.id, stayId: res.stays[0]!.id, folioId: "", keyId: "" };
  });

  it("4. check-in with room assignment: room occupied, key issued, folio opened (deposit applied)", async () => {
    // not a ready room: out of order rooms and dirty rooms are refused
    await api(st.housekeeping_supervisor).setHousekeeping({
      params: { ...P, roomId: H.rooms["117"]!.id },
      body: { status: "dirty" },
    });
    await refused(
      api(st.receptionist).checkIn({ params: { ...P, stayId: amina.stayId }, body: { roomId: H.rooms["117"]!.id } }),
      409,
    );
    await refused(
      api(st.receptionist).checkIn({ params: { ...P, stayId: amina.stayId }, body: { roomId: H.rooms["101"]!.id } }),
      400,
    ); // wrong type
    const r = await api(st.receptionist).checkIn({
      params: { ...P, stayId: amina.stayId },
      body: { roomId: H.rooms["116"]!.id },
    });
    expect([r.stay.status, r.stay.roomNumber]).toEqual(["in_house", "116"]);
    expect(r.key).toMatchObject({ status: "active", roomId: H.rooms["116"]!.id, validFrom: D1, validTo: D3 });
    expect(r.key.integration.connected).toBe(false);
    expect(r.folio.lines.map((l) => [l.kind, l.totalMinor])).toEqual([["deposit", -500_000]]);
    const board = await api(st.housekeeping_attendant).roomBoard({ params: P });
    expect(board.rooms.find((x) => x.number === "116")).toMatchObject({ occupancy: "occupied", ready: false });
    expect(await ledgerBalance("2350")).toBe(0);
    amina.folioId = r.folio.id;
    amina.keyId = r.key.id;
  });

  it("5. dinner and a spa treatment charged to the room appear on the folio with the right taxes", async () => {
    const dinner = await api(st.outlet_staff).outletCharge({
      params: { ...P, outletId: H.outlets.restaurant },
      body: { roomNumber: "116", description: "Dinner for two", amountMinor: 300_000 },
    });
    // service charge 10 %, VAT 16 % on net + service charge, no levy outside rooms
    expect(dinner.line).toMatchObject({
      department: "fnb",
      netMinor: 300_000,
      serviceChargeMinor: 30_000,
      vatMinor: 52_800,
      levyMinor: 0,
      totalMinor: 382_800,
    });
    // outlet staff post only for their own outlet
    await refused(
      api(st.outlet_staff).outletCharge({
        params: { ...P, outletId: H.outlets.spa },
        body: { roomNumber: "116", description: "Massage", amountMinor: 500_000 },
      }),
      403,
    );
    const spa = await api(st.receptionist).outletCharge({
      params: { ...P, outletId: H.outlets.spa },
      body: { roomNumber: "116", description: "Hot stone massage", amountMinor: 500_000 },
    });
    expect(spa.line).toMatchObject({
      department: "spa",
      serviceChargeMinor: 50_000,
      vatMinor: 88_000,
      totalMinor: 638_000,
    });
    // a room with nobody in house cannot be charged
    await refused(
      api(st.outlet_staff).outletCharge({
        params: { ...P, outletId: H.outlets.restaurant },
        body: { roomNumber: "130", description: "Lunch", amountMinor: 10_000 },
      }),
      409,
    );
    const f = await api(st.receptionist).getFolio({ params: { ...P, folioId: amina.folioId } });
    expect(f.balanceMinor).toBe(-500_000 + 382_800 + 638_000);
  });

  it("6. housekeeping marks rooms clean and inspected on the phone; the front desk sees them ready at once", async () => {
    const room = H.rooms["102"]!;
    await api(st.housekeeping_supervisor).setHousekeeping({
      params: { ...P, roomId: room.id },
      body: { status: "dirty" },
    });
    await api(st.housekeeping_supervisor).assignHousekeeping({
      params: P,
      body: { attendantUserId: st.housekeeping_attendant.userId, roomIds: [room.id] },
    });
    let board = await api(st.receptionist).roomBoard({ params: P });
    expect(board.rooms.find((r) => r.number === "102")).toMatchObject({
      housekeeping: "dirty",
      ready: false,
      assignedTo: st.housekeeping_attendant.userId,
    });
    // the attendant works only on their own rooms and cannot inspect
    await refused(
      api(st.housekeeping_attendant).setHousekeeping({
        params: { ...P, roomId: H.rooms["103"]!.id },
        body: { status: "clean" },
      }),
      403,
    );
    await api(st.housekeeping_attendant).setHousekeeping({
      params: { ...P, roomId: room.id },
      body: { status: "cleaning" },
    });
    await api(st.housekeeping_attendant).setHousekeeping({
      params: { ...P, roomId: room.id },
      body: { status: "clean" },
    });
    await refused(
      api(st.housekeeping_attendant).setHousekeeping({
        params: { ...P, roomId: room.id },
        body: { status: "inspected" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const inspected = await api(st.housekeeping_supervisor).setHousekeeping({
      params: { ...P, roomId: room.id },
      body: { status: "inspected" },
    });
    expect(inspected.housekeeping).toBe("inspected");
    // a hotel that requires inspection gives only inspected rooms
    await api(st.general_manager).updateProperty({ params: P, body: { requireInspection: true } });
    board = await api(st.receptionist).roomBoard({ params: P });
    expect(board.rooms.find((r) => r.number === "102")!.ready).toBe(true);
    expect(board.rooms.find((r) => r.number === "103")!.ready).toBe(false); // clean but not inspected
    await api(st.general_manager).updateProperty({ params: P, body: { requireInspection: false } });
    expect(board.figures.readyForArrivals).toBeGreaterThan(0);
  });

  it("7a. a corporate guest stays with company billing (room to the company, extras to the guest)", async () => {
    const res = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Brian Otieno"),
        arrival: D1,
        departure: D2,
        source: "corporate",
        corporateAccountId: H.companyId,
        rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
      },
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: res.stays[0]!.id },
      body: { roomId: H.rooms["101"]!.id },
    });
    const folios = (await api(st.receptionist).listFolios({ params: P, query: { stayId: ci.stay.id } })).folios;
    const company = folios.find((f) => f.payer === "company")!;
    expect(company.corporateAccountId).toBe(H.companyId);
    const bar = await api(st.receptionist).postCharge({
      params: { ...P, folioId: ci.folio.id },
      body: { department: "fnb", description: "Bar", amountMinor: 100_000 },
    });
    expect(bar.balanceMinor).toBe(127_600);
    brian = { reservationId: res.id, stayId: ci.stay.id, guestFolio: ci.folio.id, companyFolio: company.id };
  });

  it("8–10. a no-show on a non-refundable rate is pending; night audit with an open cashier shift is blocked with the reasons", async () => {
    const res = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Chen Wei"),
        arrival: D1,
        departure: D3,
        rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.NRF }],
      },
    });
    chen = res.id;
    // cash needs an open cashier shift
    await refused(
      api(st.receptionist).recordPayment({
        params: { ...P, folioId: brian.guestFolio },
        body: { method: "cash", amountMinor: 127_600, reference: "TILL-1" },
      }),
      409,
    );
    const shift = await api(st.receptionist).openShift({ params: P, body: { floatMinor: 1_000_000 } });
    shiftId = shift.id;
    await refused(api(st.receptionist).openShift({ params: P, body: { floatMinor: 0 } }), 409); // one open shift per person
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: brian.guestFolio },
      body: { method: "cash", amountMinor: 127_600, reference: "TILL-1" },
    });

    const check = await api(st.front_office_manager).nightAuditCheck({ params: P });
    expect(check.pendingArrivals).toEqual([res.number]);
    const blocked = await refused(api(st.front_office_manager).runNightAudit({ params: P, body: {} }), 409, "CONFLICT");
    expect(blocked.details.blocks.map((b: { code: string }) => b.code)).toEqual([
      "OPEN_CASHIER_SHIFT",
      "PENDING_NO_SHOWS",
    ]);
    expect(blocked.message).toMatch(/cashier shift of receptionist/);
    expect((await api(st.front_office_manager).getProperty({ params: P })).businessDate).toBe(D1);
  });

  it("9a. a group block of 10 rooms holds inventory until its cut-off", async () => {
    const before = (await avail(st.receptionist, H.types.STD, "2026-10-14")).available;
    const g = await api(st.revenue_manager).createGroupBlock({
      params: P,
      body: {
        name: "Mwangi wedding",
        roomTypeId: H.types.STD,
        ratePlanId: H.plans.BAR,
        arrival: "2026-10-14",
        departure: "2026-10-16",
        roomsPerNight: 10,
        cutoffDate: D2,
        billing: "master",
        corporateAccountId: H.companyId,
      },
    });
    groupId = g.id;
    expect(g.masterFolioId).not.toBeNull();
    expect((await avail(st.receptionist, H.types.STD, "2026-10-14")).available).toBe(before - 10);
    const pick = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: guest("Wedding Guests"),
        arrival: "2026-10-14",
        departure: "2026-10-16",
        groupBlockId: g.id,
        rooms: Array.from({ length: 3 }, () => ({ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR })),
      },
    });
    expect(pick.source).toBe("group");
    // picking up from the block does not change general availability
    expect((await avail(st.receptionist, H.types.STD, "2026-10-14")).available).toBe(before - 10);
    const blocks = await api(st.receptionist).listGroupBlocks({ params: P });
    expect(blocks.groups[0]!.nights.map((n) => [n.held, n.picked])).toEqual([
      [10, 3],
      [10, 3],
    ]);
  });

  it("11–12. close the shift; the audit rolls the date, charges the no-show by policy, and the daily report matches the ledger exactly", async () => {
    const stdBefore = (await avail(st.receptionist, H.types.STD, D2)).available;
    const closed = await api(st.receptionist).closeShift({
      params: { ...P, shiftId },
      body: { countedCashMinor: 1_127_600 },
    });
    expect([closed.takings.cash, closed.expectedCashMinor, closed.overShortMinor]).toEqual([127_600, 1_127_600, 0]);
    const out = await api(st.front_office_manager).runNightAudit({ params: P, body: { processNoShows: true } });
    expect([out.closedDate, out.businessDate]).toEqual([D1, D2]);
    const r = out.report;
    expect(r.distribution).toMatch(/not e-mailed/);
    // step 8: non-refundable no-show = the whole stay, to 4500, and the room is released
    const noShow = await api(st.receptionist).getReservation({ params: { ...P, reservationId: chen } });
    expect(noShow.status).toBe("no_show");
    expect(r.revenue.noshow).toBe(2 * NRF.STD);
    expect((await avail(st.receptionist, H.types.STD, D2)).available).toBe(stdBefore + 1);
    // room revenue: Amina (DLX) + Brian (STD); outlets: dinner + bar, spa
    expect(r.revenue).toEqual({
      rooms: BAR.DLX + BAR.STD,
      fnb: 400_000,
      spa: 500_000,
      other: 0,
      noshow: 2 * NRF.STD,
      total: BAR.DLX + BAR.STD + 400_000 + 500_000 + 2 * NRF.STD,
    });
    expect(r.folioRevenue).toEqual(r.revenue);
    expect(r.reconciled).toBe(true);
    // step 12: the same figures straight from the Finance ledger, to the minor unit
    expect(await ledgerCredit("4100", D1)).toBe(r.revenue.rooms);
    expect(await ledgerCredit("4200", D1)).toBe(r.revenue.fnb);
    expect(await ledgerCredit("4300", D1)).toBe(r.revenue.spa);
    expect(await ledgerCredit("4500", D1)).toBe(r.revenue.noshow);
    expect(await ledgerCredit("2100", D1)).toBe(r.taxes.vat);
    expect(r.taxes).toEqual({
      vat: 400_000 + 288_000 + 52_800 + 88_000 + 17_600,
      serviceCharge: 30_000 + 50_000 + 10_000,
      levy: 50_000,
    });
    // occupancy, ADR and RevPAR match a manual calculation
    expect([r.roomsSold, r.roomsAvailable]).toEqual([2, 30]);
    expect(r.occupancyPct).toBe(6.67);
    expect(r.adrMinor).toBe((BAR.DLX + BAR.STD) / 2);
    expect(r.revparMinor).toBe(Math.round((BAR.DLX + BAR.STD) / 30));
    expect(r.trevparMinor).toBe(Math.round(r.revenue.total / 30));
    expect(r.payments).toMatchObject({ cash: 127_600, total: 127_600 });
    expect(r.depositsReceivedMinor).toBe(500_000);
    const stored = await api(st.general_manager).getDailyReport({ params: { ...P, date: D1 } });
    expect(stored).toEqual(r);
    const tb = await st.financial_controller.api.ledger.trialBalance({ params: { orgId } });
    expect(tb.balanced).toBe(true);
  });

  it("7b. day 2: the corporate guest checks out — room to the company city ledger, extras paid by the guest", async () => {
    S.setToday(D2); // the calendar moves on with the hotel's business date
    const out = await api(st.receptionist).checkOut({ params: { ...P, stayId: brian.stayId } });
    const room = BAR.STD + 160_000 + 20_000; // room + VAT 16 % + levy 2 %
    expect(out.cityLedger).toEqual([
      { folioId: brian.companyFolio, corporateAccountId: H.companyId, amountMinor: room },
    ]);
    expect(out.folios.every((f) => f.status === "closed" && f.balanceMinor === 0)).toBe(true);
    expect(out.folios.find((f) => f.id === brian.guestFolio)!.lines.map((l) => l.kind)).toEqual(["charge", "payment"]);
    const acct = (await api(st.credit_controller).listCorporateAccounts({ params: { orgId } })).accounts.find(
      (a) => a.id === H.companyId,
    )!;
    expect([acct.balanceMinor, acct.ageing.current]).toEqual([room, room]);
    expect(await ledgerBalance("1160")).toBe(room);
    const statement = await api(st.credit_controller).cityLedgerStatement({
      params: { orgId, accountId: H.companyId },
    });
    expect(statement.entries.map((e) => [e.kind, e.amountMinor])).toEqual([["invoice", room]]);
    const board = await api(st.housekeeping_supervisor).roomBoard({ params: P });
    expect(board.rooms.find((r) => r.number === "101")).toMatchObject({ housekeeping: "dirty", occupancy: "vacant" });
    // the company pays later: recorded against the city ledger
    await api(st.credit_controller).cityLedgerPayment({
      params: { orgId, accountId: H.companyId },
      body: { propertyId: H.propertyId, amountMinor: room, method: "bank_transfer", reference: "EFT-99812" },
    });
    expect(await ledgerBalance("1160")).toBe(0);
  });

  it("13. a receptionist cannot change a rate plan", async () => {
    const e = await refused(
      api(st.receptionist).updateRatePlan({
        params: { ...P, ratePlanId: H.plans.BAR },
        body: { baseRates: [{ roomTypeId: H.types.STD, amountMinor: 1 }] },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    expect(e.message).toMatch(/Receptionist/);
    await refused(
      api(st.receptionist).setSeasons({ params: { ...P, ratePlanId: H.plans.BAR }, body: { seasons: [] } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      api(st.receptionist).setRestrictions({ params: P, body: { restrictions: [] } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const plan = (await api(st.receptionist).getSetup({ params: P })).ratePlans.find((p) => p.id === H.plans.BAR)!;
    expect(plan.baseRates.find((r) => r.roomTypeId === H.types.STD)!.amountMinor).toBe(BAR.STD);
    // the revenue manager can
    const changed = await api(st.revenue_manager).updateRatePlan({
      params: { ...P, ratePlanId: H.plans.BAR },
      body: { baseRates: [{ roomTypeId: H.types.STD, amountMinor: BAR.STD }] },
    });
    expect(changed.code).toBe("BAR");
  });

  it("9b. day 2 audit passes the group cut-off: unsold rooms return to general sale", async () => {
    const before = (await avail(st.receptionist, H.types.STD, "2026-10-14")).available;
    const out = await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    expect([out.closedDate, out.businessDate]).toEqual([D2, D3]);
    expect(out.report.revenue.rooms).toBe(BAR.DLX);
    const g = (await api(st.receptionist).listGroupBlocks({ params: P })).groups.find((x) => x.id === groupId)!;
    expect(g.status).toBe("released");
    expect(g.nights.map((n) => [n.held, n.picked])).toEqual([
      [3, 3],
      [3, 3],
    ]);
    expect((await avail(st.receptionist, H.types.STD, "2026-10-14")).available).toBe(before + 7);
  });

  it("day 3: the guest pays and checks out; the key stops working; three days reconcile to the ledger", async () => {
    S.setToday(D3);
    const folio = await api(st.receptionist).getFolio({ params: { ...P, folioId: amina.folioId } });
    const nights = 2 * (BAR.DLX + 240_000 + 30_000);
    expect(folio.balanceMinor).toBe(-500_000 + 382_800 + 638_000 + nights);
    await refused(api(st.receptionist).checkOut({ params: { ...P, stayId: amina.stayId } }), 409);
    const k1 = await api(st.receptionist).checkKey({
      params: { ...P, keyId: amina.keyId },
      body: { roomId: H.rooms["116"]!.id, date: D3 },
    });
    expect(k1.opens).toBe(true);
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: amina.folioId },
      body: { method: "card", amountMinor: folio.balanceMinor, reference: "PSP-CAPTURE-55120" },
    });
    const out = await api(st.receptionist).checkOut({ params: { ...P, stayId: amina.stayId } });
    expect(out.folios[0]).toMatchObject({ status: "closed", balanceMinor: 0 });
    const k2 = await api(st.receptionist).checkKey({
      params: { ...P, keyId: amina.keyId },
      body: { roomId: H.rooms["116"]!.id, date: D3 },
    });
    expect([k2.opens, k2.reason]).toEqual([false, "Key revoked"]);
    const day3 = await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    expect([day3.closedDate, day3.report.roomsSold, day3.report.payments.card]).toEqual([D3, 0, folio.balanceMinor]);

    const k = await api(st.general_manager).kpis({ params: P, query: { from: D1, to: D3 } });
    expect([k.roomsSold, k.roomsAvailable]).toEqual([3, 90]);
    expect(k.revenue.rooms).toBe(await ledgerCredit("4100", D1, D3));
    expect(k.revenue.total).toBe(
      (await ledgerCredit("4100", D1, D3)) +
        (await ledgerCredit("4200", D1, D3)) +
        (await ledgerCredit("4300", D1, D3)) +
        (await ledgerCredit("4500", D1, D3)),
    );
    expect(k.occupancyPct).toBe(3.33);
    expect(k.adrMinor).toBe(Math.round((BAR.DLX * 2 + BAR.STD) / 3));
    expect(k.revparMinor).toBe(Math.round((BAR.DLX * 2 + BAR.STD) / 90));
    // the guest ledger is clear after every guest left (only the no-show fee is still owed)
    expect(await ledgerBalance("1150")).toBe(2 * NRF.STD + 288_000);
    // no double booking over the test days, across every channel
    const over = await S.sql("SELECT count(*)::int AS n FROM hotel_inventory WHERE sold + held + ooo > total");
    expect(over[0].n).toBe(0);
    const ste = await S.sql("SELECT sold, total FROM hotel_inventory WHERE room_type_id = $1 AND date = '2026-10-20'", [
      H.types.STE,
    ]);
    expect(ste[0]).toEqual({ sold: 5, total: 5 });
    // every change is in the organisation's audit trail
    const audit = await admin.api.organisations.listAudit({ params: { orgId }, query: { limit: 200 } });
    const actions = new Set(audit.entries.map((e) => e.action));
    for (const a of [
      "Guest checked in",
      "Guest checked out",
      "Night audit completed",
      "Night audit blocked",
      "No-show recorded",
      "Group block released at cut-off",
    ])
      expect(actions).toContain(a);
  });
});
