// Hotel finance: monthly budgets by department and the daily manager's report (actual from the ledger against the
// budget pro rata and last year, with the month's forecast from the books); fixed assets with straight-line
// depreciation once a month and disposal gain / loss; the FF&E reserve funded from revenue and spent on assets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel finance: budgets, manager's report, fixed assets, FF&E", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let laundry: string;

  beforeAll(async () => {
    X = await extHotel("Finance");
    await X.inHouse("Kofi Mensah", "101");
    await api(X.st.receptionist).outletCharge({
      params: { ...X.P, outletId: X.H.outlets.spa },
      body: { roomNumber: "101", description: "Massage", amountMinor: 200_000 },
    });
    // the night audit posts the night of 2026-10-11 and moves the business date to 2026-10-12
    await api(X.st.front_office_manager).runNightAudit({ params: X.P, body: {} });
  });
  afterAll(() => X.S.close());

  const budget = {
    roomsSold: 310,
    revenue: { rooms: 310_000_000, fnb: 31_000_000, spa: 3_100_000, other: 0 },
    costsMinor: 200_000_000,
  };

  it("the budget is set by the general manager or financial controller, by month and department", async () => {
    const { st, P } = X;
    for (const who of [st.receptionist, st.front_office_manager])
      await refused(api(who).setBudget({ params: { ...P, month: "2026-10" }, body: budget }), 403);
    const b = await api(st.general_manager).setBudget({ params: { ...P, month: "2026-10" }, body: budget });
    expect([b.kind, b.revenue.total, b.gopMinor]).toEqual(["budget", 344_100_000, 144_100_000]);
    await api(st.financial_controller).setBudget({
      params: { ...P, month: "2026-10" },
      body: { ...budget, kind: "forecast", roomsSold: 250, revenue: { ...budget.revenue, rooms: 250_000_000 } },
    });
    const list = await api(st.general_manager).listBudgets({ params: P, query: { year: 2026 } });
    expect(list.budgets.map((x) => [x.month, x.kind, x.revenue.rooms])).toEqual([
      ["2026-10", "budget", 310_000_000],
      ["2026-10", "forecast", 250_000_000],
    ]);
  });

  it("the manager's report: day, month and year to date from the ledger against the budget pro rata, and the month forecast", async () => {
    const { st, P } = X;
    const r = await api(st.general_manager).managersReport({ params: P, query: { date: "2026-10-11" } });
    const [day, mtd, ytd] = r.periods;
    expect([
      day!.actual.roomsSold,
      day!.actual.revenue.rooms,
      day!.actual.revenue.spa,
      day!.actual.revenue.total,
    ]).toEqual([1, 1_000_000, 200_000, 1_200_000]);
    // one day of 31: rooms 10,000,000, F&B 1,000,000, spa 100,000
    expect(day!.budget!.revenue).toEqual({
      rooms: 10_000_000,
      fnb: 1_000_000,
      spa: 100_000,
      other: 0,
      total: 11_100_000,
    });
    expect(day!.varianceToBudgetMinor).toBe(1_200_000 - 11_100_000);
    // eleven days of 31 for the month and (with only October budgeted) the year to date
    expect([mtd!.from, mtd!.budget!.revenue.total, ytd!.from, ytd!.budget!.revenue.total]).toEqual([
      "2026-10-01",
      122_100_000,
      "2026-01-01",
      122_100_000,
    ]);
    expect(mtd!.lastYear.revenue.total).toBe(0);
    // the guest stays two more nights this month at 1,000,000
    expect(r.monthForecast).toEqual({
      month: "2026-10",
      actualRoomRevenueToDateMinor: 1_000_000,
      onTheBooksRoomRevenueMinor: 2_000_000,
      forecastRoomRevenueMinor: 3_000_000,
      budgetRoomRevenueMinor: 310_000_000,
      forecastRoomsSold: 3,
    });
    await refused(api(st.receptionist).managersReport({ params: P, query: { date: "2026-10-11" } }), 403);
  });

  it("a fixed asset is depreciated straight line once a month and disposed of with its loss in the ledger", async () => {
    const { st, P } = X;
    const body = {
      name: "Laundry machine",
      category: "equipment" as const,
      costMinor: 1_200_000,
      lifeMonths: 12,
      fundedFrom: "bank" as const,
    };
    await refused(api(st.general_manager).createAsset({ params: P, body }), 403);
    const a = await api(st.accountant).createAsset({ params: P, body });
    laundry = a.id;
    expect([a.number, a.acquiredOn, a.netBookValueMinor]).toEqual(["FA-00001", "2026-10-12", 1_200_000]);
    expect(await X.ledger("1500")).toBe(1_200_000);
    await refused(api(st.accountant).runDepreciation({ params: P, body: { month: "2026-11" } }), 400);
    const dep = await api(st.accountant).runDepreciation({ params: P, body: { month: "2026-10" } });
    expect([dep.totalMinor, dep.assets]).toEqual([100_000, [{ assetId: laundry, amountMinor: 100_000 }]]);
    expect((await api(st.accountant).runDepreciation({ params: P, body: { month: "2026-10" } })).totalMinor).toBe(0);
    expect([await X.ledger("6100"), await X.ledger("1590")]).toEqual([100_000, -100_000]);
    const sold = await api(st.financial_controller).disposeAsset({
      params: { ...P, assetId: laundry },
      body: { proceedsMinor: 1_000_000, reason: "Replaced by a larger machine" },
    });
    expect([sold.status, sold.netBookValueMinor, sold.proceedsMinor]).toEqual(["disposed", 1_100_000, 1_000_000]);
    expect(await Promise.all(["1500", "1590", "6150"].map((c) => X.ledger(c)))).toEqual([0, 0, 100_000]);
    await refused(
      api(st.financial_controller).disposeAsset({
        params: { ...P, assetId: laundry },
        body: { proceedsMinor: 0, reason: "Again" },
      }),
      409,
    );
  });

  it("the FF&E reserve takes its share of the month's revenue once, and assets can be bought from it", async () => {
    const { st, P } = X;
    await api(st.general_manager).updateExtensionSettings({ params: P, body: { ffeReservePct: 4 } });
    await refused(api(st.accountant).contributeFfe({ params: P, body: { month: "2026-10" } }), 403);
    const c = await api(st.financial_controller).contributeFfe({ params: P, body: { month: "2026-10" } });
    expect(c).toEqual({ month: "2026-10", revenueMinor: 1_200_000, ratePct: 4, amountMinor: 48_000 });
    await refused(api(st.financial_controller).contributeFfe({ params: P, body: { month: "2026-10" } }), 409);
    const fund = {
      name: "Lobby armchairs",
      category: "ffe" as const,
      lifeMonths: 60,
      fundedFrom: "ffe_reserve" as const,
    };
    await expect(api(st.accountant).createAsset({ params: P, body: { ...fund, costMinor: 100_000 } })).rejects.toThrow(
      /FF&E reserve holds 48000/,
    );
    await api(st.accountant).createAsset({ params: P, body: { ...fund, costMinor: 40_000 } });
    const v = await api(st.general_manager).ffeReserve({ params: P });
    expect([v.ratePct, v.contributedMinor, v.spentMinor, v.balanceMinor]).toEqual([4, 48_000, 40_000, 8_000]);
    expect(await X.ledger("1020")).toBe(8_000);
  });

  it("another organisation cannot see this hotel's assets or budgets", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    await refused(other.admin.api.hotel.listAssets({ params: X.P }), 404);
    await refused(other.admin.api.hotel.listBudgets({ params: X.P, query: { year: 2026 } }), 404);
  });
});
