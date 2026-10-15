// Events and meetings: venues, a quoted event order, the contract that holds the venue (never double-booked, the
// database refuses it too), the function sheet whose version moves with each change after the contract, deposits
// recorded to the deposits account, and the final bill by department with deposits applied and the company's share
// on the city ledger — every figure equal to the ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel events and meetings", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let hall: string;
  let conf: string;
  let rival: string;

  const order = [
    {
      kind: "venue_hire" as const,
      description: "Baobab Hall hire, full day",
      department: "other" as const,
      quantity: 1,
      unitMinor: 500_000,
    },
    {
      kind: "fnb" as const,
      description: "Working lunch buffet",
      department: "fnb" as const,
      quantity: 40,
      unitMinor: 25_000,
      timeLabel: "12:30",
      notes: "4 vegetarian",
    },
    {
      kind: "av" as const,
      description: "Projector and screen",
      department: "other" as const,
      quantity: 2,
      unitMinor: 50_000,
      timeLabel: "08:30",
    },
  ];

  beforeAll(async () => {
    X = await extHotel("Events");
  });
  afterAll(() => X.S.close());

  it("a venue is set up by managers; an event is quoted within its capacity by sales, not by reception", async () => {
    const { st, P, H } = X;
    await refused(
      api(st.receptionist).createVenue({ params: P, body: { code: "HALL", name: "Baobab Hall", capacity: 120 } }),
      403,
    );
    hall = (
      await api(st.general_manager).createVenue({
        params: P,
        body: { code: "HALL", name: "Baobab Hall", capacity: 120 },
      })
    ).id;
    const body = {
      name: "Safari Logistics strategy day",
      corporateAccountId: H.companyId,
      contactName: "Jane Wambui",
      contactEmail: "jane@safari.test",
      venueId: hall,
      date: "2026-10-20",
      start: "08:00",
      end: "17:00",
      pax: 40,
      setup: "classroom" as const,
      items: order,
    };
    await refused(api(st.receptionist).createEvent({ params: P, body }), 403);
    await refused(api(st.front_office_manager).createEvent({ params: P, body: { ...body, pax: 150 } }), 400);
    await refused(api(st.front_office_manager).createEvent({ params: P, body: { ...body, date: "2026-01-01" } }), 400);
    const e = await api(st.front_office_manager).createEvent({ params: P, body });
    conf = e.id;
    expect([e.number, e.status, e.beoVersion, e.netMinor]).toEqual(["EVT-00001", "quote", 1, 1_600_000]);
    // other 600,000 + 16 % VAT; F&B 1,000,000 + 10 % service + 16 % VAT
    expect(e.estimatedTotalMinor).toBe(696_000 + 1_276_000);
    expect((await api(st.receptionist).listVenues({ params: P })).venues.map((v) => [v.code, v.capacity])).toEqual([
      ["HALL", 120],
    ]);
    rival = (
      await api(st.front_office_manager).createEvent({
        params: P,
        body: {
          ...body,
          name: "Wedding tasting",
          corporateAccountId: undefined,
          start: "15:00",
          end: "19:00",
          pax: 20,
          items: order.slice(0, 1),
        },
      })
    ).id;
  });

  it("the contract holds the venue: an overlapping event cannot be contracted (nor written past the database)", async () => {
    const { st, P } = X;
    const fom = api(st.front_office_manager);
    await refused(
      fom.eventDeposit({
        params: { ...P, eventId: conf },
        body: { amountMinor: 1, method: "card", reference: "DEP-0" },
      }),
      409,
    );
    const c = await fom.contractEvent({
      params: { ...P, eventId: conf },
      body: { contractRef: "Signed contract SL-2026-14" },
    });
    expect([c.status, c.contractRef]).toEqual(["contract", "Signed contract SL-2026-14"]);
    await expect(
      fom.contractEvent({ params: { ...P, eventId: rival }, body: { contractRef: "Contract W-1" } }),
    ).rejects.toThrow(/already contracted to another event/);
    await expect(X.S.sql("UPDATE hotel_events SET status = 'contract' WHERE id = $1", [rival])).rejects.toThrow(
      /hotel_venue_not_double_booked/,
    );
    const diary = await fom.functionDiary({ params: P, query: { from: "2026-10-20", to: "2026-10-20" } });
    expect(diary.days[0]!.events.map((e) => [e.name, e.start, e.status])).toEqual([
      ["Safari Logistics strategy day", "08:00", "contract"],
      ["Wedding tasting", "15:00", "quote"],
    ]);
    const listed = await fom.listEvents({ params: P, query: { from: "2026-10-20", to: "2026-10-20" } });
    expect(listed.events.map((e) => [e.number, e.status])).toEqual([
      ["EVT-00001", "contract"],
      ["EVT-00002", "quote"],
    ]);
    const cx = await fom.cancelEvent({ params: { ...P, eventId: rival }, body: { reason: "Moved to another date" } });
    expect(cx.status).toBe("cancelled");
    const after = await fom.functionDiary({ params: P, query: { from: "2026-10-20", to: "2026-10-20" } });
    expect(after.days[0]!.events).toHaveLength(1);
  });

  it("the function sheet lists the order by section and time; each change after the contract is a new version", async () => {
    const { st, P } = X;
    const fom = api(st.front_office_manager);
    const v1 = await api(st.housekeeping_supervisor).functionSheet({ params: { ...P, eventId: conf } });
    expect([v1.version, v1.client, v1.venue, v1.setup, v1.pax]).toEqual([
      1,
      "Safari Logistics Ltd",
      "Baobab Hall",
      "classroom",
      40,
    ]);
    expect(v1.sections.map((s) => [s.title, s.lines.map((l) => l.description)])).toEqual([
      ["Room and set-up", ["Baobab Hall hire, full day"]],
      ["Food and beverage", ["Working lunch buffet"]],
      ["Audio-visual", ["Projector and screen"]],
    ]);
    const more = [
      ...order,
      {
        kind: "fnb" as const,
        description: "Morning tea",
        department: "fnb" as const,
        quantity: 45,
        unitMinor: 4_000,
        timeLabel: "10:30",
      },
    ];
    await refused(fom.setEventItems({ params: { ...P, eventId: conf }, body: { items: more, pax: 200 } }), 400);
    const e = await fom.setEventItems({ params: { ...P, eventId: conf }, body: { items: more, pax: 45 } });
    expect([e.beoVersion, e.pax, e.netMinor]).toEqual([2, 45, 1_780_000]);
    const v2 = await fom.functionSheet({ params: { ...P, eventId: conf } });
    expect(v2.sections[1]!.lines.map((l) => [l.time, l.description, l.quantity])).toEqual([
      ["10:30", "Morning tea", 45],
      ["12:30", "Working lunch buffet", 40],
    ]);
  });

  it("deposits go to the deposits account; the final bill charges by department, applies them and sends the rest to the city ledger", async () => {
    const { st, P, H } = X;
    const fom = api(st.front_office_manager);
    const [dep0, bank0, cl0, fnb0, oth0] = (await Promise.all(
      ["2350", "1000", "1160", "4200", "4400"].map((c) => X.ledger(c)),
    )) as [number, number, number, number, number];
    const d = await fom.eventDeposit({
      params: { ...P, eventId: conf },
      body: { amountMinor: 500_000, method: "bank_transfer", reference: "SL-DEP-1" },
    });
    expect(d.deposits.map((x) => [x.amountMinor, x.applied])).toEqual([[500_000, false]]);
    expect([(await X.ledger("2350")) - dep0, (await X.ledger("1000")) - bank0]).toEqual([-500_000, 500_000]);
    await refused(fom.cancelEvent({ params: { ...P, eventId: conf }, body: { reason: "Changed mind" } }), 409);
    const billed = await fom.billEvent({ params: { ...P, eventId: conf } });
    expect(billed.event.status).toBe("billed");
    // F&B 1,180,000 → 1,505,680 with service and VAT; other 600,000 → 696,000
    const total = 1_505_680 + 696_000;
    expect(billed.folio.lines.map((l) => [l.kind, l.totalMinor])).toEqual([
      ["charge", 696_000],
      ["charge", 1_505_680],
      ["deposit", -500_000],
      ["city_ledger", -(total - 500_000)],
    ]);
    expect([billed.folio.balanceMinor, billed.folio.status]).toEqual([0, "closed"]);
    expect((await X.ledger("2350")) - dep0).toBe(0);
    expect((await X.ledger("1160")) - cl0).toBe(total - 500_000);
    expect((await X.ledger("4200")) - fnb0).toBe(-1_180_000);
    expect((await X.ledger("4400")) - oth0).toBe(-600_000);
    const ar = await api(st.financial_controller).cityLedgerStatement({
      params: { orgId: X.orgId, accountId: H.companyId },
    });
    expect(ar.entries.map((x) => [x.kind, x.amountMinor, x.folioId])).toEqual([
      ["invoice", total - 500_000, billed.folio.id],
    ]);
    await refused(fom.billEvent({ params: { ...P, eventId: conf } }), 409);
    await refused(fom.setEventItems({ params: { ...P, eventId: conf }, body: { items: order } }), 409);
  });

  it("another organisation cannot see this hotel's events", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    await refused(other.admin.api.hotel.getEvent({ params: { ...X.P, eventId: conf } }), 404);
    await refused(other.admin.api.hotel.functionSheet({ params: { ...X.P, eventId: conf } }), 404);
  });
});
