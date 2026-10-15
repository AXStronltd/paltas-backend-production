/*
 * The Smart Hotel product ("hotel"): one ProductModule. Its services are built once per server from the core
 * services, the hotel access gate and the integration adapters (test adapters until certified ones exist).
 *
 *   setup/          properties, room types, rooms, rate plans, restrictions, channels, outlets, company accounts, guests
 *   reservations/   bookings, waitlist, group blocks, cancellations and no-shows
 *   frontdesk/      pre-check-in, check-in, moves, extensions, check-out, requests (+ folio/rooms/cashier routes)
 *   folios/         folio lines and their ledger postings (charges, payments, voids, allowances, refunds)
 *   rooms/          room status, housekeeping, maintenance, lost and found, minibar, outlet charges
 *   cashier/        cashier shifts
 *   audit/          night audit (also scheduled) and income audit
 *   reports/        KPIs, flash, departmental P&L, channels, group views (all from the ledger)
 *   integrations/   adapters (channel manager, locks, room controls, messaging, e-invoicing …), keys, energy, concierge
 *   billing/        multi-currency, tax invoices and credit notes, collections, bank reconciliation
 *   bookingengine/  promo codes, extras (upsells), room features (attribute-based selling), direct booking
 *   guests/         loyalty, feedback, templates, personalisation, the guest lifecycle hooks
 *   automation/     automatic night audit schedule, pre-arrival messages, preventive maintenance plans
 *   outlets/        menus, recipes, point-of-sale orders, the kitchen screen, table bookings
 *   stock/          stock with par levels, counts, purchase orders, receipts, supplier bills (three-way match)
 *   spa/            treatments and activities with therapists / guides and rooms
 *   events/         venues, quotes, function sheets, contracts, deposits, final billing, function diary
 *   finance/        payroll inputs, tips and service charge, labour planning, budgets, fixed assets, FF&E reserve
 *   revenue/        forecast, pace, pickup, rate suggestions, displacement, corporate RFPs and production
 *   insights/       outlet, housekeeping and sustainability reports; the housekeeping plan
 *   shared/         access gate, inventory (the one availability record), rates, tax engine, ledger posting,
 *                   message outbox, sale settlement
 */
import { resolveEntitlement } from "../../core/subscriptions/entitlement.service.js";
import type { AppContext } from "../../context.js";
import type { CoreServices } from "../../core/core-services.js";
import type { ProductModule } from "../registry.js";
import { HOTEL_ACCOUNTS } from "./accounts.js";
import { auditService } from "./audit/audit.service.js";
import { automationService, NIGHT_AUDIT_JOB } from "./automation/automation.service.js";
import { billingRoutes } from "./billing/billing.routes.js";
import { billingService } from "./billing/billing.service.js";
import { bookingEngineService } from "./bookingengine/bookingengine.service.js";
import { cashierService } from "./cashier/cashier.service.js";
import { eventsService } from "./events/events.service.js";
import { financeService } from "./finance/finance.service.js";
import { labourService } from "./finance/labour.service.js";
import { payrollService } from "./finance/payroll.service.js";
import type { HotelDeps } from "./deps.js";
import { foliosService } from "./folios/folios.service.js";
import { frontdeskRoutes } from "./frontdesk/frontdesk.routes.js";
import { frontdeskService } from "./frontdesk/frontdesk.service.js";
import { guestsRoutes } from "./guests/guests.routes.js";
import { guestsService } from "./guests/guests.service.js";
import { insightsService } from "./insights/insights.service.js";
import { lifecycle } from "./guests/lifecycle.js";
import { loyalty as loyaltyOf } from "./guests/loyalty.js";
import { sandboxAdapters, type HotelAdapters } from "./integrations/adapters.js";
import { integrationsService } from "./integrations/integrations.service.js";
import { smartRooms } from "./integrations/smart.js";
import { operationsRoutes } from "./operations.routes.js";
import { outletsService } from "./outlets/outlets.service.js";
import { reportsRoutes } from "./reports/reports.routes.js";
import { reportsService } from "./reports/reports.service.js";
import { reservationsRoutes } from "./reservations/reservations.routes.js";
import { reservationsService } from "./reservations/reservations.service.js";
import { revenueService } from "./revenue/revenue.service.js";
import { roomsService } from "./rooms/rooms.service.js";
import { setupRoutes } from "./setup/setup.routes.js";
import { setupService } from "./setup/setup.service.js";
import { hotelAccess } from "./shared/access.js";
import { findProperty } from "./shared/property.js";
import { settler } from "./shared/settle.js";
import { spaService } from "./spa/spa.service.js";
import { stockService } from "./stock/stock.service.js";

/** Every hotel service, wired once per server. */
function build(ctx: AppContext, core: CoreServices, adapters: HotelAdapters) {
  const access = hotelAccess(core);
  const d: HotelDeps = { ctx, core, access, adapters };
  const smart = smartRooms(adapters);
  const folios = foliosService(d);
  const loyalty = loyaltyOf(d, folios);
  const life = lifecycle(d, { folios, loyalty });
  const reservations = reservationsService(d, folios, life);
  const reports = reportsService(d);
  const settle = settler(d, folios);
  const stock = stockService(d);
  const rooms = roomsService(d, folios);
  return {
    access,
    d,
    services: {
      setup: setupService(d),
      reservations,
      folios,
      frontdesk: frontdeskService(d, { folios, reservations, smart, lifecycle: life }),
      rooms,
      cashier: cashierService(d),
      audit: auditService(d, { folios, reservations, reports }),
      reports,
      integrations: integrationsService(d, { reservations, smart }),
      billing: billingService(d, { folios }),
      bookingEngine: bookingEngineService(d, { reservations }),
      guests: guestsService(d, { loyalty }),
      automation: automationService(d),
      stock,
      outlets: outletsService(d, { settle, stock }),
      spa: spaService(d, { settle }),
      events: eventsService(d, { folios }),
      payroll: payrollService(d),
      labour: labourService(d),
      finance: financeService(d, { reports }),
      revenue: revenueService(d),
      insights: insightsService(d, { rooms }),
    },
  };
}

/** Build the hotel product with the given adapters (default: the labelled test adapters). */
export function hotelProduct(adapters: HotelAdapters = sandboxAdapters): ProductModule {
  return {
    product: "hotel",
    accounts: HOTEL_ACCOUNTS,
    // the plan allowance counts hotels (properties)
    usage: async (db, orgId) =>
      (await db.row<{ n: number }>("SELECT count(*)::int AS n FROM hotel_properties WHERE org_id = $1", [orgId]))?.n ??
      0,
    routes(ctx, core) {
      const { access, services } = build(ctx, core, adapters);
      return [
        ...setupRoutes(access, services.setup),
        ...reservationsRoutes(core, access, services.reservations),
        ...frontdeskRoutes(access, services),
        ...reportsRoutes(ctx, access, services),
        ...billingRoutes(access, services),
        ...guestsRoutes(access, services),
        ...operationsRoutes(access, services),
      ];
    },
    // the automatic night audit: the scheduler calls it at each hotel's audit time (schedules are registered when a
    // hotel turns it on — automation.updateSettings → core.scheduler.ensureJob)
    scheduledJobs(ctx, core) {
      const { services } = build(ctx, core, adapters);
      return [
        {
          key: NIGHT_AUDIT_JOB,
          label: "Hotel night audit at the hotel's set time",
          scope: "org",
          async run(job) {
            if (!job.orgId || !job.targetId) return { summary: "No hotel named — nothing done" };
            const en = await resolveEntitlement(ctx.db, ctx.products, ctx.clock.today(), job.orgId, "hotel").catch(
              () => null,
            );
            if (!en?.ent.usable) return { summary: "The hotel subscription is not active — nothing done" };
            const summary = await services.audit.runScheduled({
              orgId: job.orgId,
              propertyId: job.targetId,
              localDate: job.localDate,
            });
            const property = await findProperty(ctx.db, job.orgId, job.targetId);
            const daily = await ctx.db.tx((t) =>
              services.automation.daily(t, {
                orgId: job.orgId as string,
                userId: null,
                actor: { userId: null, role: "system:scheduler" },
                property,
              }),
            );
            return {
              summary: `${summary} · ${daily.preArrival} pre-arrival message(s), ${daily.preventiveTickets} preventive ticket(s)`,
            };
          },
        },
      ];
    },
  };
}

export const hotel = hotelProduct();
