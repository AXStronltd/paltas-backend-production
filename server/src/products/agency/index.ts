/*
 * Agent / Host ("agency"): one ProductModule, and the public PALTAS marketplace behind the public site.
 *
 *   listings/      listings (sale, rent, stay), media metadata, stay calendars and nightly prices
 *   leads/         contacts, the marketplace inbox, leads, viewings, offers
 *   deals/         commission agreements, deals, commissions (approved by a second person, posted to the ledger)
 *   stays/         stay bookings and blocks (never two overlapping), guest payments, check-in / out, host payouts
 *   reports/       the agency summary (money read from the ledger)
 *   marketplace/   the public endpoints (no sign-in, rate-limited) and PALTAS staff moderation / onboarding requests
 *   integrations/  the media storage adapter (a labelled test adapter until a provider is connected)
 *   shared/        access gate, contacts, stay pricing, limiter, helpers
 */
import type { ProductModule } from "../registry.js";
import { AGENCY_ACCOUNTS } from "./accounts.js";
import { dealsRoutes } from "./deals/deals.routes.js";
import { dealsService } from "./deals/deals.service.js";
import type { AgencyDeps } from "./deps.js";
import { sandboxStorage, type MediaStorage } from "./integrations/storage.js";
import { leadsRoutes } from "./leads/leads.routes.js";
import { leadsService } from "./leads/leads.service.js";
import { listingsRoutes } from "./listings/listings.routes.js";
import { listingsService } from "./listings/listings.service.js";
import { marketplaceRoutes } from "./marketplace/marketplace.routes.js";
import { moderationService } from "./marketplace/moderation.service.js";
import { publicService } from "./marketplace/public.service.js";
import { reportsRoutes } from "./reports/reports.routes.js";
import { reportsService } from "./reports/reports.service.js";
import { agencyGate } from "./shared/access.js";
import { publicLimiter } from "./shared/limiter.js";
import { staysRoutes } from "./stays/stays.routes.js";
import { staysService } from "./stays/stays.service.js";

/** Build the agency product with the given media storage (default: the labelled test adapter). */
export function agencyProduct(storage: MediaStorage = sandboxStorage): ProductModule {
  return {
    product: "agency",
    accounts: AGENCY_ACCOUNTS,
    routes(ctx, core) {
      const d: AgencyDeps = { ctx, core, storage, limiter: publicLimiter(ctx.config.marketplace) };
      const g = agencyGate(core);
      return [
        ...listingsRoutes(g, listingsService(d)),
        ...leadsRoutes(g, leadsService(d)),
        ...dealsRoutes(g, dealsService(d)),
        ...staysRoutes(g, staysService(d)),
        ...reportsRoutes(g, reportsService(d)),
        ...marketplaceRoutes(publicService(d), moderationService(d)),
      ];
    },
  };
}

export const agency = agencyProduct();
