// Hotel business rules not covered by the acceptance run: tax engine variants, credit limits, corporate rates,
// capacity, early departure, group master billing, manual no-show and cut-off release, the plan's hotel allowance,
// housekeeping timings, out-of-service rooms and the folio / ledger balance guard of the night audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BAR,
  buildHotel,
  guest,
  hotelOrg,
  startHotelServer,
  type Staff,
  type TestHotel,
} from "./support/hotel-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("hotel rules", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let H: TestHotel;
  let P: { orgId: string; propertyId: string };
  const D1 = "2026-10-11";
  const api = (p: Person) => p.api.hotel;
  const reserve = (body: Record<string, unknown>) =>
    api(st.receptionist).createReservation({ params: P, body: body as never });

  beforeAll(async () => {
    S = await startHotelServer();
    const o = await hotelOrg(S, "Ziwa Hotels");
    orgId = o.orgId;
    st = o.staff;
    H = await buildHotel(orgId, st.general_manager, {
      name: "Ziwa Naivasha",
      counts: { STD: 4, DLX: 2, STE: 1 },
      staff: st,
    });
    P = { orgId, propertyId: H.propertyId };
  });
  afterAll(() => S.close());

  it("tax engine: a per-night levy and no service charge, configured per hotel", async () => {
    await api(st.general_manager).updateProperty({
      params: P,
      body: {
        tax: {
          vatPct: 8,
          serviceChargePct: 0,
          serviceChargeDepartments: [],
          vatOnServiceCharge: false,
          levy: { kind: "per_night", name: "City tax", amountMinor: 15_000, pct: 0 },
        },
      },
    });
    const p = await api(st.receptionist).getProperty({ params: P });
    expect(p.tax.levy).toEqual({ kind: "per_night", name: "City tax", amountMinor: 15_000, pct: 0 });
    const r = await reserve({
      guest: guest("Tax Guest"),
      arrival: D1,
      departure: "2026-10-12",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["101"]!.id },
    });
    const f = await api(st.receptionist).postCharge({
      params: { ...P, folioId: ci.folio.id },
      body: { department: "rooms", description: "Day room", amountMinor: 100_000 },
    });
    expect(f.lines.at(-1)).toMatchObject({ vatMinor: 8_000, serviceChargeMinor: 0, levyMinor: 0 }); // a manual rooms charge is not a night
    const fnb = await api(st.receptionist).postCharge({
      params: { ...P, folioId: ci.folio.id },
      body: { department: "fnb", description: "Snack", amountMinor: 10_000 },
    });
    expect(fnb.lines.at(-1)).toMatchObject({ vatMinor: 800, serviceChargeMinor: 0, totalMinor: 10_800 });
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: ci.folio.id },
      body: { method: "card", amountMinor: 118_800, reference: "C-1" },
    });
    await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    const folio = await api(st.receptionist).getFolio({ params: { ...P, folioId: ci.folio.id } });
    expect(folio.lines.at(-1)).toMatchObject({
      netMinor: BAR.STD,
      vatMinor: 80_000,
      levyMinor: 15_000,
      totalMinor: BAR.STD + 95_000,
    });
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: ci.folio.id },
      body: { method: "card", amountMinor: BAR.STD + 95_000, reference: "C-2" },
    });
    await api(st.receptionist).checkOut({ params: { ...P, stayId: ci.stay.id } });
    S.setToday("2026-10-12");
  });

  it("capacity and corporate rates are enforced at booking", async () => {
    await refused(
      reserve({
        guest: guest("Big Family"),
        arrival: "2026-10-20",
        departure: "2026-10-21",
        rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR, adults: 3 }],
      }),
      400,
    );
    const corp = await api(st.revenue_manager).createRatePlan({
      params: P,
      body: {
        code: "CORP",
        name: "Safari Logistics negotiated",
        kind: "corporate",
        corporateAccountId: H.companyId,
        baseRates: [{ roomTypeId: H.types.STD, amountMinor: 850_000 }],
      },
    });
    await refused(
      reserve({
        guest: guest("Walk In"),
        arrival: "2026-10-20",
        departure: "2026-10-21",
        rooms: [{ roomTypeId: H.types.STD, ratePlanId: corp.id }],
      }),
      400,
    );
    const ok = await reserve({
      guest: guest("Corporate Guest"),
      arrival: "2026-10-20",
      departure: "2026-10-21",
      corporateAccountId: H.companyId,
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: corp.id }],
    });
    expect(ok.roomTotalMinor).toBe(850_000);
  });

  it("the city ledger refuses a check-out beyond the company's credit limit", async () => {
    const small = await api(st.credit_controller).createCorporateAccount({
      params: { orgId },
      body: { name: "Tiny Traders", creditLimitMinor: 500_000 },
    });
    const r = await reserve({
      guest: guest("Tiny Guest"),
      arrival: "2026-10-12",
      departure: "2026-10-13",
      corporateAccountId: small.id,
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["102"]!.id },
    });
    const company = (await api(st.receptionist).listFolios({ params: P, query: { stayId: ci.stay.id } })).folios.find(
      (f) => f.payer === "company",
    )!;
    await api(st.receptionist).postCharge({
      params: { ...P, folioId: company.id },
      body: { department: "rooms", description: "Meeting room", amountMinor: 600_000 },
    });
    const e = await refused(api(st.receptionist).checkOut({ params: { ...P, stayId: ci.stay.id } }), 409);
    expect(e.message).toMatch(/credit limit/);
    // the guest pays instead; the company folio then balances and nothing goes to the city ledger
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: company.id },
      body: { method: "card", amountMinor: 648_000, reference: "C-3" },
    });
    const out = await api(st.receptionist).checkOut({ params: { ...P, stayId: ci.stay.id } });
    expect(out.cityLedger).toEqual([]);
  });

  it("an early departure gives the unused nights back to sale", async () => {
    const r = await reserve({
      guest: guest("Leaves Early"),
      arrival: "2026-10-12",
      departure: "2026-10-15",
      rooms: [{ roomTypeId: H.types.STE, ratePlanId: H.plans.BAR }],
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["107"]!.id },
    });
    const a = async (d: string) =>
      (await api(st.receptionist).availability({ params: P, query: { from: d, to: d } })).roomTypes.find(
        (t) => t.roomTypeId === H.types.STE,
      )!.days[0]!.available;
    expect(await a("2026-10-13")).toBe(0);
    const out = await api(st.receptionist).checkOut({ params: { ...P, stayId: ci.stay.id } });
    expect(out.stay.nights).toEqual([]);
    expect([await a("2026-10-12"), await a("2026-10-13"), await a("2026-10-14")]).toEqual([1, 1, 1]);
  });

  it("group master billing routes room charges to the master folio; manual cut-off release", async () => {
    const g = await api(st.revenue_manager).createGroupBlock({
      params: P,
      body: {
        name: "Rotary conference",
        roomTypeId: H.types.STD,
        ratePlanId: H.plans.BAR,
        arrival: "2026-10-12",
        departure: "2026-10-13",
        roomsPerNight: 2,
        cutoffDate: "2026-10-12",
        billing: "master",
      },
    });
    const r = await reserve({
      guest: guest("Delegate"),
      arrival: "2026-10-12",
      departure: "2026-10-13",
      groupBlockId: g.id,
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    const ci = await api(st.receptionist).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms["103"]!.id },
    });
    await api(st.receptionist).postCharge({
      params: { ...P, folioId: ci.folio.id },
      body: { department: "fnb", description: "Coffee", amountMinor: 20_000 },
    });
    // the delegate's own folio keeps the extras; tonight's room goes to the master folio
    await api(st.receptionist).recordPayment({
      params: { ...P, folioId: ci.folio.id },
      body: { method: "card", amountMinor: 21_600, reference: "C-4" },
    });
    // blocks whose cut-off date has passed are released by hand too (here: none until the business date moves)
    expect((await api(st.revenue_manager).releaseGroupCutoffs({ params: P })).released).toEqual([]);
    const audit = await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    expect(audit.closedDate).toBe("2026-10-12");
    const master = await api(st.receptionist).getFolio({ params: { ...P, folioId: g.masterFolioId! } });
    expect(master.lines.map((l) => [l.department, l.netMinor])).toEqual([["rooms", BAR.STD]]);
    const released = (await api(st.receptionist).listGroupBlocks({ params: P })).groups.find((x) => x.id === g.id)!;
    expect([released.status, released.nights[0]!.held]).toEqual(["released", 1]);
  });

  it("a manual no-show on the arrival date charges the policy fee and releases the room", async () => {
    S.setToday("2026-10-13");
    const r = await reserve({
      guest: guest("Never Came"),
      arrival: "2026-10-13",
      departure: "2026-10-15",
      rooms: [{ roomTypeId: H.types.DLX, ratePlanId: H.plans.BAR }],
    });
    const ns = await api(st.front_office_manager).noShowReservation({ params: { ...P, reservationId: r.id } });
    expect([ns.reservation.status, ns.feeMinor]).toEqual(["no_show", BAR.DLX]); // BAR: one night
    await refused(api(st.front_office_manager).noShowReservation({ params: { ...P, reservationId: r.id } }), 409);
    const future = await reserve({
      guest: guest("Future"),
      arrival: "2026-10-20",
      departure: "2026-10-21",
      rooms: [{ roomTypeId: H.types.DLX, ratePlanId: H.plans.BAR }],
    });
    await refused(api(st.front_office_manager).noShowReservation({ params: { ...P, reservationId: future.id } }), 409);
  });

  it("housekeeping board figures: rooms to clean, minutes per clean, out of order / out of service rooms", async () => {
    const room = H.rooms["104"]!.id;
    await api(st.housekeeping_supervisor).setHousekeeping({
      params: { ...P, roomId: room },
      body: { status: "cleaning" },
    });
    await api(st.housekeeping_supervisor).setHousekeeping({
      params: { ...P, roomId: room },
      body: { status: "clean" },
    });
    const board = await api(st.housekeeping_supervisor).roomBoard({ params: P });
    expect(board.figures.averageCleanMinutes).toBe(0);
    expect(board.figures.toClean).toBe(
      board.rooms.filter((r) => ["dirty", "cleaning"].includes(r.housekeeping)).length,
    );
    const t = await api(st.housekeeping_supervisor).createMaintenance({
      params: P,
      body: { roomId: room, title: "Repaint", outOfService: true },
    });
    const r = await reserve({
      guest: guest("No Paint"),
      arrival: "2026-10-13",
      departure: "2026-10-14",
      rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR }],
    });
    expect(
      (
        await refused(
          api(st.receptionist).checkIn({ params: { ...P, stayId: r.stays[0]!.id }, body: { roomId: room } }),
          409,
        )
      ).message,
    ).toMatch(/out of service/);
    await api(st.housekeeping_supervisor).resolveMaintenance({
      params: { ...P, ticketId: t.id },
      body: { note: "Painted" },
    });
    expect((await api(st.receptionist).roomBoard({ params: P })).rooms.find((x) => x.id === room)).toMatchObject({
      service: "in_service",
      housekeeping: "dirty",
    });
    await api(st.receptionist).cancelReservation({
      params: { ...P, reservationId: r.id },
      body: { reason: "Room unavailable" },
    });
  });

  it("night audit refuses folio lines that do not match the guest ledger", async () => {
    const f = (await api(st.receptionist).listFolios({ params: P, query: { status: "open" } })).folios[0]!;
    // a line written around the service (no ledger posting) is caught
    await S.sql(
      `INSERT INTO hotel_folio_lines (id, org_id, property_id, folio_id, business_date, kind, department, description, net_minor, total_minor)
       VALUES ('hfl_tampered', $1, $2, $3, '2026-10-13', 'charge', 'other', 'Tampered', 1000, 1000)`,
      [orgId, H.propertyId, f.id],
    );
    const e = await refused(
      api(st.front_office_manager).runNightAudit({ params: P, body: { processNoShows: true } }),
      409,
    );
    expect(e.details.blocks.map((b: { code: string }) => b.code)).toContain("FOLIO_OUT_OF_BALANCE");
  });

  it("the plan's hotel allowance limits how many hotels an organisation runs", async () => {
    const o = await S.newOrg({ name: "Solo Inn", product: "hotel", plan: "HOTEL-STD", trial: false });
    await buildHotel(o.orgId, await S.addMember(o.orgId, o.admin.api, "general_manager"), {
      name: "Solo Inn",
      counts: { STD: 1, DLX: 1, STE: 1 },
    });
    const e = await refused(
      o.admin.api.hotel.createProperty({
        params: { orgId: o.orgId },
        body: { name: "Second Inn", country: "Kenya", city: "Nakuru", tax: { vatPct: 16 } },
      }),
      402,
      "ALLOWANCE_EXCEEDED",
    );
    expect(e.message).toMatch(/hotel allowance/);
  });
});
