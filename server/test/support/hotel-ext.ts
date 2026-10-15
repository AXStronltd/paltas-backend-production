/*
 * Shared set-up for the hotel extension tests: a test hotel (hotel-fixture) with the finance roles the fixture does
 * not create (accountant, AP clerk, cost controller, payroll officer) also working at the hotel, and helpers for
 * ledger balances, an in-house guest and the night audit.
 */
import type { Role } from "@paltas/contracts";
import { buildHotel, guest, hotelOrg, startHotelServer, type Staff, type TestHotel } from "./hotel-fixture.js";
import type { Person, TestServer } from "./test-server.js";

export const EXTRA_ROLES = [
  "accountant",
  "ap_clerk",
  "cost_controller",
  "payroll_officer",
] as const satisfies readonly Role[];
export type Extra = Record<(typeof EXTRA_ROLES)[number], Person>;

export interface ExtHotel {
  S: TestServer;
  orgId: string;
  admin: Person;
  st: Staff & Extra;
  H: TestHotel;
  P: { orgId: string; propertyId: string };
  /** debit − credit of an account over business dates (the hotel's postings and every other one of the org). */
  ledger(code: string, from?: string, to?: string): Promise<number>;
  /** A guest booked, checked in to `room` and with an open guest folio. */
  inHouse(
    name: string,
    room: string,
    o?: { departure?: string; ratePlanId?: string; roomTypeId?: string; email?: string },
  ): Promise<{ reservationId: string; stayId: string; folioId: string }>;
  /** Close every open cashier shift at the hotel (counted = expected). */
  closeShifts(): Promise<void>;
}

export async function extHotel(name: string, o: { counts?: { STD: number; DLX: number; STE: number } } = {}) {
  const S = await startHotelServer();
  const org = await hotelOrg(S, name);
  const extra = {} as Extra;
  for (const r of EXTRA_ROLES) extra[r] = await S.addMember(org.orgId, org.admin.api, r);
  const st = { ...org.staff, ...extra };
  const H = await buildHotel(org.orgId, st.general_manager, {
    name: `${name} Hotel`,
    staff: st as unknown as Partial<Staff>,
    restaurantStaff: [st.outlet_staff.userId],
    ...(o.counts ? { counts: o.counts } : {}),
  });
  const P = { orgId: org.orgId, propertyId: H.propertyId };
  const x: ExtHotel = {
    S,
    orgId: org.orgId,
    admin: org.admin,
    st,
    H,
    P,
    async ledger(code, from = "2000-01-01", to = "2100-01-01") {
      const a = await st.financial_controller.api.ledger.accountActivity({
        params: { orgId: org.orgId, code },
        query: { from, to },
      });
      return a.lines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0);
    },
    async inHouse(guestName, room, g = {}) {
      const api = st.receptionist.api.hotel;
      const prop = await api.getProperty({ params: P });
      const r = await api.createReservation({
        params: P,
        body: {
          guest: guest(guestName, g.email ? { email: g.email } : {}),
          arrival: prop.businessDate,
          departure: g.departure ?? "2026-10-14",
          rooms: [{ roomTypeId: g.roomTypeId ?? H.types.STD, ratePlanId: g.ratePlanId ?? H.plans.BAR }],
        },
      });
      const ci = await api.checkIn({
        params: { ...P, stayId: r.stays[0]!.id },
        body: { roomId: H.rooms[room]!.id },
      });
      return { reservationId: r.id, stayId: r.stays[0]!.id, folioId: ci.folio.id };
    },
    async closeShifts() {
      const shifts = await st.general_manager.api.hotel.listShifts({ params: P, query: { status: "open" } });
      for (const sh of shifts.shifts)
        await st.general_manager.api.hotel.closeShift({
          params: { ...P, shiftId: sh.id },
          body: { countedCashMinor: sh.expectedCashMinor },
        });
    },
  };
  return x;
}
