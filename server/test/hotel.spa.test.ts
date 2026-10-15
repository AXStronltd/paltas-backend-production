// Spa and activities: treatments and group activities with their therapist / guide and room; a therapist or room is
// never double-booked (the database refuses it), an activity session holds up to its capacity; a booking is charged
// to the guest's room or paid now, with the department's taxes and the revenue in the ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel spa and activities", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let day: string;
  const ids = {} as Record<"massage" | "yoga" | "grace" | "hana" | "tom" | "roomA" | "studio", string>;
  let kofi: { folioId: string };
  let massage: string;
  let late: string;
  let yoga: string[];

  beforeAll(async () => {
    X = await extHotel("Spa");
    day = (await api(X.st.receptionist).getProperty({ params: X.P })).businessDate;
    kofi = await X.inHouse("Kofi Mensah", "101");
  });
  afterAll(() => X.S.close());

  it("managers set up treatments, activities, therapists and rooms; reception cannot", async () => {
    const { st, P } = X;
    await refused(
      api(st.receptionist).createSpaService({
        params: P,
        body: { code: "MAS", name: "Massage", kind: "treatment", durationMinutes: 60, priceMinor: 200_000 },
      }),
      403,
    );
    await refused(
      api(st.general_manager).createSpaService({
        params: P,
        body: { code: "BAD", name: "Pair massage", kind: "treatment", durationMinutes: 60, priceMinor: 1, capacity: 2 },
      }),
      400,
    );
    const gm = api(st.general_manager);
    ids.massage = (
      await gm.createSpaService({
        params: P,
        body: { code: "MAS", name: "Massage", kind: "treatment", durationMinutes: 60, priceMinor: 200_000 },
      })
    ).id;
    ids.yoga = (
      await gm.createSpaService({
        params: P,
        body: {
          code: "YOGA",
          name: "Beach yoga",
          kind: "activity",
          department: "other",
          durationMinutes: 60,
          priceMinor: 50_000,
          capacity: 3,
        },
      })
    ).id;
    ids.grace = (await gm.createSpaProvider({ params: P, body: { name: "Grace", kind: "therapist" } })).id;
    ids.hana = (await gm.createSpaProvider({ params: P, body: { name: "Hana", kind: "therapist" } })).id;
    ids.tom = (await gm.createSpaProvider({ params: P, body: { name: "Tom", kind: "guide" } })).id;
    ids.roomA = (await gm.createSpaResource({ params: P, body: { name: "Room A", kind: "treatment_room" } })).id;
    ids.studio = (await gm.createSpaResource({ params: P, body: { name: "Beach deck", kind: "studio" } })).id;
    const setup = await api(st.receptionist).getSpaSetup({ params: P });
    expect(setup.services.map((s) => [s.code, s.kind, s.capacity])).toEqual([
      ["MAS", "treatment", 1],
      ["YOGA", "activity", 3],
    ]);
    expect(setup.providers.map((p) => p.name)).toEqual(["Grace", "Hana", "Tom"]);
  });

  it("a therapist and a treatment room are never booked twice for overlapping times", async () => {
    const { st, P } = X;
    const r = api(st.receptionist);
    await refused(
      api(st.housekeeping_attendant).bookService({
        params: P,
        body: { serviceId: ids.massage, providerId: ids.grace, date: day, start: "10:00", guestName: "Someone" },
      }),
      403,
    );
    const b = await r.bookService({
      params: P,
      body: {
        serviceId: ids.massage,
        providerId: ids.grace,
        resourceId: ids.roomA,
        date: day,
        start: "10:00",
        roomNumber: "101",
      },
    });
    massage = b.id;
    expect([b.guestName, b.source, b.start, b.end, b.priceMinor]).toEqual([
      "Kofi Mensah",
      "in_house",
      "10:00",
      "11:00",
      200_000,
    ]);
    await refused(
      r.bookService({
        params: P,
        body: { serviceId: ids.massage, providerId: ids.grace, date: day, start: "10:30", guestName: "Ann" },
      }),
      409,
    );
    await expect(
      r.bookService({
        params: P,
        body: {
          serviceId: ids.massage,
          providerId: ids.hana,
          resourceId: ids.roomA,
          date: day,
          start: "10:30",
          guestName: "Ann",
        },
      }),
    ).rejects.toThrow(/room is already booked/);
    // back to back is fine
    late = (
      await r.bookService({
        params: P,
        body: {
          serviceId: ids.massage,
          providerId: ids.grace,
          resourceId: ids.roomA,
          date: day,
          start: "11:00",
          guestName: "Ann",
        },
      })
    ).id;
    await refused(
      r.bookService({
        params: P,
        body: {
          serviceId: ids.massage,
          providerId: ids.hana,
          date: day,
          start: "12:00",
          guestName: "Two",
          participants: 2,
        },
      }),
      400,
    );
    await refused(
      r.bookService({
        params: P,
        body: { serviceId: ids.massage, providerId: ids.hana, date: "2026-01-01", start: "12:00", guestName: "Past" },
      }),
      400,
    );
    await refused(
      r.bookService({
        params: P,
        body: { serviceId: ids.massage, providerId: ids.hana, date: day, start: "12:00", roomNumber: "305" },
      }),
      409,
    );
    // the database refuses an overlapping therapist booking even written directly
    await expect(
      X.S.sql("UPDATE hotel_service_bookings SET starts_at = starts_at - interval '30 minutes' WHERE id = $1", [late]),
    ).rejects.toThrow(/hotel_provider_not_double_booked/);
    // and an overlapping booking of the same room with another therapist
    await expect(
      X.S.sql(
        `INSERT INTO hotel_service_bookings (id, org_id, property_id, service_id, provider_id, resource_id, guest_name,
           starts_at, ends_at, session_key, source)
         SELECT 'hsk_direct', org_id, property_id, service_id, $2, resource_id, 'Direct', starts_at, ends_at, 'direct', 'phone'
         FROM hotel_service_bookings WHERE id = $1`,
        [massage, ids.hana],
      ),
    ).rejects.toThrow(/hotel_resource_not_double_booked/);
    // a no-show frees the therapist and the room
    const ns = await r.cancelService({
      params: { ...P, bookingId: late },
      body: { reason: "Did not come", noShow: true },
    });
    expect(ns.status).toBe("no_show");
    await r.bookService({
      params: P,
      body: {
        serviceId: ids.massage,
        providerId: ids.grace,
        resourceId: ids.roomA,
        date: day,
        start: "11:00",
        guestName: "Ben",
      },
    });
  });

  it("an activity session holds up to its capacity and shares one guide and place", async () => {
    const { st, P } = X;
    const r = api(st.receptionist);
    const base = { serviceId: ids.yoga, providerId: ids.tom, resourceId: ids.studio, date: day, start: "07:00" };
    const a = await r.bookService({
      params: P,
      body: { ...base, guestName: "Pair", participants: 2, source: "phone" },
    });
    const b = await r.bookService({ params: P, body: { ...base, guestName: "Solo" } });
    yoga = [a.id, b.id];
    expect(a.priceMinor).toBe(100_000);
    await expect(r.bookService({ params: P, body: { ...base, guestName: "Late" } })).rejects.toThrow(
      /0 place\(s\) left/,
    );
    await expect(
      r.bookService({ params: P, body: { ...base, providerId: ids.hana, guestName: "Other guide" } }),
    ).rejects.toThrow(/already has its guide/);
    const list = await r.listServiceBookings({ params: P, query: { date: day } });
    expect(list.bookings.map((x) => [x.start, x.serviceName, x.guestName, x.status])).toEqual([
      ["07:00", "Beach yoga", "Pair", "booked"],
      ["07:00", "Beach yoga", "Solo", "booked"],
      ["10:00", "Massage", "Kofi Mensah", "booked"],
      ["11:00", "Massage", "Ann", "no_show"],
      ["11:00", "Massage", "Ben", "booked"],
    ]);
  });

  it("completed treatments go to the room folio or are paid now, with taxes, and revenue reaches the ledger", async () => {
    const { st, P } = X;
    const r = api(st.receptionist);
    const spaRev = await X.ledger("4300");
    const otherRev = await X.ledger("4400");
    const done = await r.completeService({ params: { ...P, bookingId: massage }, body: { roomNumber: "101" } });
    expect([done.status, done.folioId]).toEqual(["completed", kofi.folioId]);
    const folio = await r.getFolio({ params: { ...P, folioId: kofi.folioId } });
    // 200,000 + 10 % service + 16 % VAT
    expect(folio.lines.filter((l) => l.department === "spa").map((l) => l.totalMinor)).toEqual([255_200]);
    expect((await X.ledger("4300")) - spaRev).toBe(-200_000);
    await refused(r.completeService({ params: { ...P, bookingId: massage }, body: { roomNumber: "101" } }), 409);
    await refused(r.cancelService({ params: { ...P, bookingId: massage }, body: { reason: "Too late" } }), 409);
    // the group activity paid by card now: 100,000 + 16 % VAT (no service charge on "other")
    await refused(
      r.completeService({
        params: { ...P, bookingId: yoga[0]! },
        body: { payments: [{ method: "card", amountMinor: 100_000, reference: "YOGA-1" }] },
      }),
      400,
    );
    const paid = await r.completeService({
      params: { ...P, bookingId: yoga[0]! },
      body: { payments: [{ method: "card", amountMinor: 116_000, reference: "YOGA-1" }] },
    });
    expect(paid.status).toBe("completed");
    expect((await X.ledger("4400")) - otherRev).toBe(-100_000);
    await r.cancelService({ params: { ...P, bookingId: yoga[1]! }, body: { reason: "Felt unwell" } });
  });

  it("another organisation cannot see or book this hotel's spa", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    await refused(other.admin.api.hotel.getSpaSetup({ params: X.P }), 404);
    await refused(
      other.admin.api.hotel.completeService({ params: { ...X.P, bookingId: massage }, body: { roomNumber: "101" } }),
      404,
    );
  });
});
