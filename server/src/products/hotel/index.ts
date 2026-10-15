/*
 * The Smart Hotel product ("hotel"): one ProductModule. Its services are built once per server from the core
 * services, the hotel access gate and the integration adapters (test adapters until certified ones exist).
 *
 *   setup/          properties, room types, rooms, rate plans, restrictions, channels, outlets, company accounts, guests
 *   reservations/   bookings, waitlist, group blocks, cancellations and no-shows
 *   frontdesk/      pre-check-in, check-in, moves, extensions, check-out, requests (+ folio/rooms/cashier routes)
 *   folios/         folio lines and their ledger postings
 *   rooms/          room status, housekeeping, maintenance, lost and found, minibar, outlet charges
 *   cashier/        cashier shifts
 *   audit/          night audit and income audit
 *   reports/        KPIs, flash, departmental P&L, channels, group views (all from the ledger)
 *   integrations/   adapters (channel manager, locks, room controls, messaging), keys, energy, concierge
 *   shared/         access gate, inventory (the one availability record), rates, tax engine, ledger posting
 */
import type { ProductModule } from "../registry.js";
import { HOTEL_ACCOUNTS } from "./accounts.js";
import { auditService } from "./audit/audit.service.js";
import { cashierService } from "./cashier/cashier.service.js";
import type { HotelDeps } from "./deps.js";
import { foliosService } from "./folios/folios.service.js";
import { frontdeskRoutes } from "./frontdesk/frontdesk.routes.js";
import { frontdeskService } from "./frontdesk/frontdesk.service.js";
import { sandboxAdapters, type HotelAdapters } from "./integrations/adapters.js";
import { integrationsService } from "./integrations/integrations.service.js";
import { smartRooms } from "./integrations/smart.js";
import { reportsRoutes } from "./reports/reports.routes.js";
import { reportsService } from "./reports/reports.service.js";
import { reservationsRoutes } from "./reservations/reservations.routes.js";
import { reservationsService } from "./reservations/reservations.service.js";
import { roomsService } from "./rooms/rooms.service.js";
import { setupRoutes } from "./setup/setup.routes.js";
import { setupService } from "./setup/setup.service.js";
import { hotelAccess } from "./shared/access.js";

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
      const access = hotelAccess(core);
      const d: HotelDeps = { ctx, core, access, adapters };
      const smart = smartRooms(adapters);
      const folios = foliosService(d);
      const reservations = reservationsService(d, folios);
      const reports = reportsService(d);
      const services = {
        setup: setupService(d),
        reservations,
        folios,
        frontdesk: frontdeskService(d, { folios, reservations, smart }),
        rooms: roomsService(d, folios),
        cashier: cashierService(d),
        audit: auditService(d, { folios, reservations, reports }),
        reports,
        integrations: integrationsService(d, { reservations, smart }),
      };
      return [
        ...setupRoutes(access, services.setup),
        ...reservationsRoutes(core, access, services.reservations),
        ...frontdeskRoutes(access, services),
        ...reportsRoutes(ctx, access, services),
      ];
    },
  };
}

export const hotel = hotelProduct();
