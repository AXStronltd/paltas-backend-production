// Outlets: menus with modifiers and recipes, orders to the kitchen screen, settlement to a room or paid now (split,
// with tips, cash inside a shift), stock deducted by recipe with cost of sales equal to the ledger, table bookings
// within the seats, and the income audit comparing outlet takings with cashier shifts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel outlets: point of sale, kitchen, stock, tables", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  const REST = () => X.H.outlets.restaurant;
  let kofi: { reservationId: string; stayId: string; folioId: string };
  let steak: string;
  let wine: string;
  let order1: string;

  beforeAll(async () => {
    X = await extHotel("Outlets");
    kofi = await X.inHouse("Kofi Mensah", "101");
  });
  afterAll(() => X.S.close());

  it("menus with modifiers; recipes from stock give the food cost of each dish", async () => {
    const { st, P } = X;
    steak = (
      await api(st.general_manager).saveMenuItem({
        params: { ...P, outletId: REST() },
        body: {
          code: "STEAK",
          name: "Sirloin steak",
          category: "Mains",
          priceMinor: 150_000,
          modifiers: [{ code: "PEPPER", name: "Pepper sauce", priceMinor: 20_000 }],
        },
      })
    ).id;
    wine = (
      await api(st.general_manager).saveMenuItem({
        params: { ...P, outletId: REST() },
        body: { code: "WINE", name: "House wine (glass)", category: "Drinks", priceMinor: 70_000 },
      })
    ).id;
    const beef = await api(st.cost_controller).createStockItem({
      params: P,
      body: { code: "BEEF", name: "Beef sirloin", category: "food", unit: "kg", parLevel: 5 },
    });
    const bottle = await api(st.cost_controller).createStockItem({
      params: P,
      body: { code: "WINEB", name: "House wine", category: "beverage", unit: "bottle", parLevel: 12 },
    });
    await api(st.cost_controller).receiveStock({
      params: { ...P, itemId: beef.id },
      body: { quantity: 10, totalCostMinor: 1_000_000, paidFrom: "payable", reference: "MKT-1" },
    });
    await api(st.cost_controller).receiveStock({
      params: { ...P, itemId: bottle.id },
      body: { quantity: 6, totalCostMinor: 540_000, paidFrom: "bank", reference: "MKT-2" },
    });
    await refused(
      api(st.receptionist).setRecipe({
        params: { ...P, itemId: steak },
        body: { lines: [{ stockItemId: beef.id, quantity: 0.25 }] },
      }),
      403,
    );
    const s = await api(st.cost_controller).setRecipe({
      params: { ...P, itemId: steak },
      body: { lines: [{ stockItemId: beef.id, quantity: 0.25 }] },
    });
    expect([s.recipeCostMinor, s.costPct]).toEqual([25_000, 16.67]);
    await api(st.cost_controller).setRecipe({
      params: { ...P, itemId: wine },
      body: { lines: [{ stockItemId: bottle.id, quantity: 0.2 }] },
    });
    const stock = await api(st.cost_controller).listStock({ params: P, query: {} });
    expect(stock.totalValueMinor).toBe(1_540_000);
    const menu = await api(st.outlet_staff).listMenu({ params: { ...P, outletId: REST() } });
    expect(menu.items.map((i) => [i.code, i.recipeCostMinor])).toEqual([
      ["WINE", 18_000],
      ["STEAK", 25_000],
    ]);
    expect(await X.ledger("1300")).toBe(1_540_000);
    expect(stock.items.find((i) => i.code === "WINEB")!.belowPar).toBe(true);
  });

  it("an order goes to the kitchen screen; outlet staff work only at their own outlet", async () => {
    const { st, P } = X;
    await refused(
      api(st.outlet_staff).createPosOrder({
        params: { ...P, outletId: X.H.outlets.spa },
        body: { lines: [{ menuItemId: steak, quantity: 1 }] },
      }),
      403,
    );
    const o = await api(st.outlet_staff).createPosOrder({
      params: { ...P, outletId: REST() },
      body: {
        tableNo: "5",
        covers: 2,
        lines: [
          { menuItemId: steak, quantity: 2, modifiers: ["PEPPER"], note: "Medium rare" },
          { menuItemId: wine, quantity: 2 },
        ],
      },
    });
    order1 = o.id;
    expect([o.netMinor, o.totalMinor]).toEqual([480_000, 612_480]);
    expect(o.lines.map((l) => [l.name, l.unitMinor, l.modifiers])).toEqual([
      ["Sirloin steak", 170_000, ["Pepper sauce"]],
      ["House wine (glass)", 70_000, []],
    ]);
    const k = await api(st.outlet_staff).kitchenScreen({
      params: { ...P, outletId: REST() },
      query: { status: "new" },
    });
    expect(k.tickets).toHaveLength(1);
    expect(k.tickets[0]!.items[0]).toEqual({
      name: "Sirloin steak",
      quantity: 2,
      modifiers: ["Pepper sauce"],
      note: "Medium rare",
    });
    expect(k.tickets[0]!.printer).toMatchObject({ connected: false });
    expect(k.tickets[0]!.printer.status).toMatch(/kitchen screen only/);
    const tid = k.tickets[0]!.id;
    await api(st.outlet_staff).updateKitchenTicket({ params: { ...P, ticketId: tid }, body: { status: "preparing" } });
    await api(st.outlet_staff).updateKitchenTicket({ params: { ...P, ticketId: tid }, body: { status: "served" } });
    await refused(
      api(st.outlet_staff).updateKitchenTicket({ params: { ...P, ticketId: tid }, body: { status: "ready" } }),
      409,
    );
  });

  it("charged to an in-house room (not when the folio is blocked); stock leaves at average cost with its cost of sales", async () => {
    const { st, P } = X;
    await api(st.receptionist).blockFolio({
      params: { ...P, folioId: kofi.folioId },
      body: { blocked: true, reason: "Card declined at check-in" },
    });
    await refused(
      api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: order1 }, body: { roomNumber: "101" } }),
      409,
    );
    await refused(
      api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: order1 }, body: { roomNumber: "102" } }),
      409,
    );
    await api(st.receptionist).blockFolio({
      params: { ...P, folioId: kofi.folioId },
      body: { blocked: false, reason: "Guest paid a deposit" },
    });
    const cos = await X.ledger("5200");
    const s = await api(st.outlet_staff).settlePosOrder({
      params: { ...P, orderId: order1 },
      body: { roomNumber: "101" },
    });
    expect([s.status, s.settledMode, s.folioId]).toEqual(["settled", "room", kofi.folioId]);
    const f = await api(st.receptionist).getFolio({ params: { ...P, folioId: kofi.folioId } });
    expect(f.lines.at(-1)).toMatchObject({ department: "fnb", netMinor: 480_000, totalMinor: 612_480 });
    // 0.5 kg beef at 100,000 and 0.4 bottle at 90,000
    expect((await X.ledger("5200")) - cos).toBe(50_000 + 36_000);
    const stock = await api(st.cost_controller).listStock({ params: P, query: {} });
    // listed by category: beverage, then food
    expect(stock.items.map((i) => [i.code, i.quantity, i.valueMinor])).toEqual([
      ["WINEB", 5.6, 504_000],
      ["BEEF", 9.5, 950_000],
    ]);
    expect(await X.ledger("1300")).toBe(stock.totalValueMinor);
    await refused(
      api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: order1 }, body: { roomNumber: "101" } }),
      409,
    );
  });

  it("paid now: split across payments that must equal the total; cash needs the shift; a tip goes to the staff pool", async () => {
    const { st, P } = X;
    const o = await api(st.outlet_staff).createPosOrder({
      params: { ...P, outletId: REST() },
      body: { tableNo: "7", lines: [{ menuItemId: steak, quantity: 1 }] },
    });
    expect(o.totalMinor).toBe(191_400);
    const pay = (cash: number) => ({
      payments: [
        { method: "card" as const, amountMinor: 100_000, reference: "CARD-9", tipMinor: 10_000 },
        { method: "cash" as const, amountMinor: cash, reference: "CASH-9" },
      ],
    });
    const wrong = await refused(
      api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: o.id }, body: pay(91_000) }),
      400,
    );
    expect(wrong.details.totalMinor).toBe(191_400);
    await refused(api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: o.id }, body: pay(91_400) }), 409);
    await api(st.outlet_staff).openShift({ params: P, body: { floatMinor: 0 } });
    const tips = await X.ledger("2130");
    const s = await api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: o.id }, body: pay(91_400) });
    expect([s.settledMode, s.tipsMinor]).toEqual(["paid", 10_000]);
    const f = await api(st.outlet_staff).getFolio({ params: { ...P, folioId: s.folioId! } });
    expect([f.status, f.balanceMinor]).toEqual(["closed", 0]);
    expect((await X.ledger("2130")) - tips).toBe(-10_000);
    const shift = (await api(st.outlet_staff).listShifts({ params: P, query: { status: "open" } })).shifts[0]!;
    expect([shift.takings.cash, shift.takings.card]).toEqual([91_400, 110_000]);
    // a card sale taken by someone with no open shift is paid outside any cashier shift
    const w = await api(st.receptionist).createPosOrder({
      params: { ...P, outletId: REST() },
      body: { lines: [{ menuItemId: wine, quantity: 1 }] },
    });
    await api(st.receptionist).settlePosOrder({
      params: { ...P, orderId: w.id },
      body: { payments: [{ method: "card", amountMinor: 89_320, reference: "CARD-10" }] },
    });
    // an order the kitchen cannot make from stock is refused; cancelling it cancels its tickets
    const big = await api(st.outlet_staff).createPosOrder({
      params: { ...P, outletId: REST() },
      body: { lines: [{ menuItemId: steak, quantity: 10 }] },
    });
    const more = await api(st.outlet_staff).addPosLines({
      params: { ...P, orderId: big.id },
      body: { lines: [{ menuItemId: steak, quantity: 40 }] },
    });
    expect([more.lines.length, more.netMinor]).toEqual([2, 50 * 150_000]);
    const open = await api(st.outlet_staff).listPosOrders({
      params: { ...P, outletId: REST() },
      query: { status: "open" },
    });
    expect(open.orders.map((x) => x.id)).toEqual([big.id]);
    const short = await refused(
      api(st.outlet_staff).settlePosOrder({ params: { ...P, orderId: big.id }, body: { roomNumber: "101" } }),
      409,
    );
    expect(short.message).toMatch(/Not enough in stock: Beef sirloin \(on hand 9.25 kg\)/);
    await api(st.outlet_staff).cancelPosOrder({
      params: { ...P, orderId: big.id },
      body: { reason: "Kitchen ran out" },
    });
    const k = await api(st.outlet_staff).kitchenScreen({
      params: { ...P, outletId: REST() },
      query: { status: "cancelled" },
    });
    expect(k.tickets.map((t) => t.orderId)).toEqual([big.id, big.id]);
    await refused(
      api(st.outlet_staff).addPosLines({
        params: { ...P, orderId: big.id },
        body: { lines: [{ menuItemId: wine, quantity: 1 }] },
      }),
      409,
    );
  });

  it("table bookings fit the restaurant's seats; in-house guests are booked by room", async () => {
    const { st, P } = X;
    const book = (b: Record<string, unknown>) =>
      api(st.receptionist).createTableBooking({
        params: P,
        body: { outletId: REST(), date: "2026-10-11", ...b } as never,
      });
    await refused(book({ name: "Early", time: "19:30", covers: 2 }), 409); // no seats set yet
    await api(st.general_manager).setOutletSeating({
      params: { ...P, outletId: REST() },
      body: { seats: 10, slotMinutes: 120 },
    });
    const a = await book({ name: "Wanjiku party", time: "19:30", covers: 6, source: "website" });
    expect([a.status, a.source]).toEqual(["booked", "website"]);
    const full = await refused(book({ name: "Too many", time: "20:00", covers: 5 }), 409);
    expect(full.message).toMatch(/4 seat\(s\) free/);
    await refused(book({ name: "Guest", time: "20:00", covers: 2, source: "in_house" }), 400);
    const h = await book({ name: "Kofi Mensah", time: "20:00", covers: 2, roomNumber: "101" });
    expect([h.source, h.roomNumber, h.stayId]).toEqual(["in_house", "101", kofi.stayId]);
    await book({ name: "Late table", time: "21:30", covers: 8 }); // the 19:30 table is gone by then
    await api(st.outlet_staff).updateTableBooking({ params: { ...P, bookingId: a.id }, body: { status: "seated" } });
    await api(st.outlet_staff).updateTableBooking({ params: { ...P, bookingId: a.id }, body: { status: "completed" } });
    await refused(
      api(st.outlet_staff).updateTableBooking({ params: { ...P, bookingId: a.id }, body: { status: "seated" } }),
      409,
    );
    await refused(
      api(st.housekeeping_attendant).createTableBooking({
        params: P,
        body: { outletId: REST(), name: "No", date: "2026-10-11", time: "12:00", covers: 1 },
      }),
      403,
    );
    const list = await api(st.receptionist).listTableBookings({ params: P, query: { date: "2026-10-11" } });
    expect(list.bookings.map((b) => b.time)).toEqual(["19:30", "20:00", "21:30"]);
  });

  it("the income audit compares outlet takings with cashier shifts; the outlet report gives F&B cost % from stock", async () => {
    const { st, P } = X;
    await X.closeShifts();
    await api(st.front_office_manager).runNightAudit({ params: P, body: {} });
    const ia = await api(st.income_auditor).getIncomeAudit({ params: { ...P, date: "2026-10-11" } });
    expect(ia.outletTakings.find((o) => o.outletId === REST())).toEqual({
      outletId: REST(),
      name: "Ocean Restaurant",
      paidMinor: 191_400 + 89_320,
      inShiftMinor: 191_400,
      outsideShiftMinor: 89_320,
      roomChargesMinor: 612_480,
    });
    expect(ia.findings.map((x) => [x.code, x.amountMinor])).toEqual([["OUTLET_TAKINGS_OUTSIDE_SHIFT", 89_320]]);
    const rep = await api(st.cost_controller).outletReport({
      params: P,
      query: { from: "2026-10-11", to: "2026-10-11" },
    });
    const r = rep.outlets.find((o) => o.outletId === REST())!;
    expect([r.revenueMinor, r.covers, r.costOfSalesMinor, r.costPct]).toEqual([700_000, 4, 129_000, 18.43]);
    expect([rep.fnbRevenueMinor, rep.fnbCostOfSalesMinor, rep.fnbCostPct]).toEqual([700_000, 129_000, 18.43]);
    expect(await X.ledger("1300")).toBe(
      (await api(st.cost_controller).listStock({ params: P, query: {} })).totalValueMinor,
    );
  });
});
