// HTTP only: outlets and kitchen, table bookings, stock and purchasing, spa and activities, events, payroll, labour,
// budgets, assets, FF&E, revenue management, corporate sales and the dashboards from the hotel's own data.
import { hotel, type Capability } from "@paltas/contracts";
import { ApiError } from "../../http/errors.js";
import { route } from "../../http/route.js";
import type { SessionUser } from "../../core/identity/identity.service.js";
import type { EventsService } from "./events/events.service.js";
import type { FinanceService } from "./finance/finance.service.js";
import type { LabourService } from "./finance/labour.service.js";
import type { PayrollService } from "./finance/payroll.service.js";
import type { InsightsService } from "./insights/insights.service.js";
import type { OutletsService } from "./outlets/outlets.service.js";
import type { RevenueService } from "./revenue/revenue.service.js";
import type { HotelAccess } from "./shared/access.js";
import { gate, WRITE } from "./shared/gate.js";
import type { SpaService } from "./spa/spa.service.js";
import type { StockService } from "./stock/stock.service.js";

const FINANCE = { write: true, module: "finance" } as const;
const PROCUREMENT = { write: true, module: "procurement" } as const;

export function operationsRoutes(
  access: HotelAccess,
  x: {
    outlets: OutletsService;
    stock: StockService;
    spa: SpaService;
    events: EventsService;
    payroll: PayrollService;
    labour: LabourService;
    finance: FinanceService;
    revenue: RevenueService;
    insights: InsightsService;
  },
) {
  const g = gate(access);
  const { outlets: O, stock: K, spa: S, events: E, payroll: PY, labour: L, finance: FN, revenue: RV, insights: I } = x;

  /** The first of these capabilities the member's role has (e.g. the payroll officer or the pay-run approver). */
  async function either(req: { user: SessionUser; params: { orgId: string; propertyId: string } }, caps: Capability[]) {
    for (const [i, c] of caps.entries()) {
      try {
        return await g.hotel(req, c);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "ROLE_NOT_ALLOWED") || i === caps.length - 1) throw e;
      }
    }
    throw new Error("No capability given");
  }

  return [
    // ---- outlets: menus, recipes, seating
    route(hotel.listMenu, async (req) => O.listMenu(await g.hotel(req, "hotel.read"), req.params.outletId)),
    route(hotel.saveMenuItem, async (req) =>
      O.saveMenuItem(await g.hotel(req, "hotel.setup", WRITE), req.params.outletId, req.body),
    ),
    route(hotel.setRecipe, async (req) =>
      O.setRecipe(await g.hotel(req, "hotel.stock.manage", WRITE), req.params.itemId, req.body.lines),
    ),
    route(hotel.setOutletSeating, async (req) =>
      O.setSeating(await g.hotel(req, "hotel.setup", WRITE), req.params.outletId, req.body),
    ),

    // ---- point of sale and the kitchen screen
    route(hotel.createPosOrder, async (req) =>
      O.createOrder(await g.hotel(req, "hotel.outlet.post", WRITE), req.params.outletId, req.body),
    ),
    route(hotel.addPosLines, async (req) =>
      O.addOrderLines(await g.hotel(req, "hotel.outlet.post", WRITE), req.params.orderId, req.body.lines),
    ),
    route(hotel.listPosOrders, async (req) =>
      O.listOrders(await g.hotel(req, "hotel.read"), req.params.outletId, req.query.status),
    ),
    route(hotel.settlePosOrder, async (req) =>
      O.settleOrder(await g.hotel(req, "hotel.outlet.post", WRITE), req.params.orderId, req.body),
    ),
    route(hotel.cancelPosOrder, async (req) =>
      O.cancelOrder(await g.hotel(req, "hotel.outlet.post", WRITE), req.params.orderId, req.body.reason),
    ),
    route(hotel.kitchenScreen, async (req) =>
      O.kitchen(await g.hotel(req, "hotel.read"), req.params.outletId, req.query.status),
    ),
    route(hotel.updateKitchenTicket, async (req) =>
      O.updateTicket(await g.hotel(req, "hotel.outlet.post", WRITE), req.params.ticketId, req.body.status),
    ),

    // ---- table bookings
    route(hotel.listTableBookings, async (req) => O.listTables(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.createTableBooking, async (req) =>
      O.bookTable(await g.hotel(req, "hotel.bookings.manage", WRITE), req.body),
    ),
    route(hotel.updateTableBooking, async (req) =>
      O.updateTable(await g.hotel(req, "hotel.bookings.manage", WRITE), req.params.bookingId, req.body.status),
    ),

    // ---- stock
    route(hotel.listStock, async (req) => K.list(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.createStockItem, async (req) => K.create(await g.hotel(req, "hotel.stock.manage", WRITE), req.body)),
    route(hotel.receiveStock, async (req) =>
      K.receive(await g.hotel(req, "hotel.stock.manage", WRITE), req.params.itemId, req.body),
    ),
    route(hotel.issueStock, async (req) =>
      K.issue(await g.hotel(req, "hotel.stock.manage", WRITE), req.params.itemId, req.body),
    ),
    route(hotel.countStock, async (req) => K.count(await g.hotel(req, "hotel.stock.manage", WRITE), req.body.counts)),
    route(hotel.stockMoves, async (req) => K.moves(await g.hotel(req, "hotel.read"), req.params.itemId)),

    // ---- purchasing and three-way match
    route(hotel.listPurchaseOrders, async (req) => K.listPos(await g.hotel(req, "hotel.read"), req.query.status)),
    route(hotel.createPurchaseOrder, async (req) =>
      K.createPo(await g.hotel(req, "hotel.stock.manage", PROCUREMENT), req.body),
    ),
    route(hotel.approvePurchaseOrder, async (req) =>
      K.approvePo(await g.hotel(req, "hotel.purchasing.approve", PROCUREMENT), req.params.poId),
    ),
    route(hotel.receivePurchaseOrder, async (req) =>
      K.receivePo(await g.hotel(req, "hotel.stock.manage", PROCUREMENT), req.params.poId, req.body.lines),
    ),
    route(hotel.enterSupplierBill, async (req) =>
      K.enterBill(await g.hotel(req, "hotel.payables", PROCUREMENT), req.params.poId, req.body),
    ),
    route(hotel.approveSupplierBill, async (req) =>
      K.approveBill(await g.hotel(req, "hotel.purchasing.approve", PROCUREMENT), req.params.billId, req.body.reason),
    ),

    // ---- spa and activities
    route(hotel.getSpaSetup, async (req) => S.setup(await g.hotel(req, "hotel.read"))),
    route(hotel.createSpaService, async (req) => S.createService(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.createSpaProvider, async (req) => S.createProvider(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.createSpaResource, async (req) => S.createResource(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.listServiceBookings, async (req) => S.list(await g.hotel(req, "hotel.read"), req.query.date)),
    route(hotel.bookService, async (req) => S.book(await g.hotel(req, "hotel.bookings.manage", WRITE), req.body)),
    route(hotel.completeService, async (req) =>
      S.complete(await g.hotel(req, "hotel.bookings.manage", WRITE), req.params.bookingId, req.body),
    ),
    route(hotel.cancelService, async (req) =>
      S.cancel(await g.hotel(req, "hotel.bookings.manage", WRITE), req.params.bookingId, req.body),
    ),

    // ---- events and meetings
    route(hotel.listVenues, async (req) => E.listVenues(await g.hotel(req, "hotel.read"))),
    route(hotel.createVenue, async (req) => E.createVenue(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.createEvent, async (req) => E.create(await g.hotel(req, "hotel.events.manage", WRITE), req.body)),
    route(hotel.listEvents, async (req) => E.list(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.getEvent, async (req) => E.get(await g.hotel(req, "hotel.read"), req.params.eventId)),
    route(hotel.setEventItems, async (req) =>
      E.setItems(await g.hotel(req, "hotel.events.manage", WRITE), req.params.eventId, req.body),
    ),
    route(hotel.contractEvent, async (req) =>
      E.contract(await g.hotel(req, "hotel.events.manage", WRITE), req.params.eventId, req.body.contractRef),
    ),
    route(hotel.eventDeposit, async (req) =>
      E.deposit(await g.hotel(req, "hotel.events.manage", WRITE), req.params.eventId, req.body),
    ),
    route(hotel.billEvent, async (req) => E.bill(await g.hotel(req, "hotel.events.manage", WRITE), req.params.eventId)),
    route(hotel.cancelEvent, async (req) =>
      E.cancel(await g.hotel(req, "hotel.events.manage", WRITE), req.params.eventId, req.body.reason),
    ),
    route(hotel.functionSheet, async (req) => E.functionSheet(await g.hotel(req, "hotel.read"), req.params.eventId)),
    route(hotel.functionDiary, async (req) => E.diary(await g.hotel(req, "hotel.read"), req.query.from, req.query.to)),

    // ---- payroll (salaries: the payroll officer only)
    route(hotel.listStaffPay, async (req) => PY.listStaff(await g.hotel(req, "hotel.payroll"))),
    route(hotel.saveStaffPay, async (req) => PY.saveStaff(await g.hotel(req, "hotel.payroll", FINANCE), req.body)),
    route(hotel.listPayRuns, async (req) => PY.listRuns(await either(req, ["hotel.payroll", "hotel.payroll.approve"]))),
    route(hotel.preparePayRun, async (req) => PY.prepare(await g.hotel(req, "hotel.payroll", FINANCE), req.body)),
    route(hotel.approvePayRun, async (req) =>
      PY.approve(await g.hotel(req, "hotel.payroll.approve", FINANCE), req.params.runId),
    ),
    route(hotel.distribute, async (req) => PY.distribute(await g.hotel(req, "hotel.payroll", FINANCE), req.body)),
    route(hotel.listDistributions, async (req) =>
      PY.listDistributions(await either(req, ["hotel.payroll", "hotel.payroll.approve"])),
    ),

    // ---- labour planning
    route(hotel.setLabourStandards, async (req) =>
      L.setStandards(await g.hotel(req, "hotel.labour.manage", WRITE), req.body.standards),
    ),
    route(hotel.labourStaff, async (req) => L.staff(await g.hotel(req, "hotel.labour.manage"))),
    route(hotel.scheduleShifts, async (req) =>
      L.schedule(await g.hotel(req, "hotel.labour.manage", WRITE), req.body.shifts),
    ),
    route(hotel.listStaffShifts, async (req) => L.list(await g.hotel(req, "hotel.read"), req.query.from, req.query.to)),
    route(hotel.labourPlan, async (req) =>
      L.plan(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),

    // ---- budgets, manager's report, fixed assets, FF&E
    route(hotel.setBudget, async (req) =>
      FN.setBudget(await g.hotel(req, "hotel.budget.manage", FINANCE), req.params.month, req.body),
    ),
    route(hotel.listBudgets, async (req) => FN.listBudgets(await g.hotel(req, "hotel.reports.read"), req.query.year)),
    route(hotel.managersReport, async (req) =>
      FN.managersReport(await g.hotel(req, "hotel.reports.read"), req.query.date),
    ),
    route(hotel.listAssets, async (req) => FN.listAssets(await g.hotel(req, "hotel.reports.read"))),
    route(hotel.createAsset, async (req) =>
      FN.createAsset(await g.hotel(req, "hotel.assets.manage", FINANCE), req.body),
    ),
    route(hotel.runDepreciation, async (req) =>
      FN.depreciate(await g.hotel(req, "hotel.assets.manage", FINANCE), req.body.month),
    ),
    route(hotel.disposeAsset, async (req) =>
      FN.dispose(await g.hotel(req, "hotel.assets.manage", FINANCE), req.params.assetId, req.body),
    ),
    route(hotel.ffeReserve, async (req) => FN.ffe(await g.hotel(req, "hotel.reports.read"))),
    route(hotel.contributeFfe, async (req) =>
      FN.contributeFfe(await g.hotel(req, "hotel.budget.manage", FINANCE), req.body.month),
    ),

    // ---- revenue management and corporate sales
    route(hotel.revenueForecast, async (req) =>
      RV.forecast(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.pickupReport, async (req) => RV.pickup(await g.hotel(req, "hotel.reports.read"), req.query)),
    route(hotel.rateSuggestions, async (req) =>
      RV.suggestions(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.applySuggestion, async (req) =>
      RV.apply(await g.hotel(req, "hotel.rates.manage", WRITE), req.body.date, req.body.roomTypeId),
    ),
    route(hotel.displacement, async (req) => RV.displacement(await g.hotel(req, "hotel.reports.read"), req.body)),
    route(hotel.listRfps, async (req) => RV.listRfps(await g.hotel(req, "hotel.read"))),
    route(hotel.createRfp, async (req) => RV.createRfp(await g.hotel(req, "hotel.rates.manage", WRITE), req.body)),
    route(hotel.decideRfp, async (req) =>
      RV.decideRfp(await g.hotel(req, "hotel.rates.manage", WRITE), req.params.rfpId, req.body),
    ),
    route(hotel.corporateProduction, async (req) =>
      RV.production(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),

    // ---- dashboards and operations from own data
    route(hotel.outletReport, async (req) =>
      I.outlets(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.housekeepingReport, async (req) =>
      I.housekeeping(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.sustainabilityReport, async (req) =>
      I.sustainability(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.recordMeterReadings, async (req) =>
      I.recordMeters(await g.hotel(req, "hotel.maintenance", { write: true, module: "maint" }), req.body.readings),
    ),
    route(hotel.housekeepingPlan, async (req) => I.plan(await g.hotel(req, "hotel.read"))),
    route(hotel.reportHousekeeping, async (req) =>
      I.reportClean(await g.hotel(req, "hotel.housekeeping", WRITE), req.params.roomId, req.body),
    ),
  ];
}
