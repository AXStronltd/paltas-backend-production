// HTTP only: listings, media, stay calendars and prices. Each route states the capability it needs.
import { agency } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type AgencyGate } from "../shared/access.js";
import type { ListingsService } from "./listings.service.js";

export function listingsRoutes(g: AgencyGate, S: ListingsService) {
  return [
    route(agency.listListings, async (req) => S.list(await g.listings(req, "agency.read"), req.query)),
    route(agency.createListing, async (req) =>
      S.create(await g.listings(req, "agency.listings.manage", WRITE), req.body),
    ),
    route(agency.getListing, async (req) => S.get(await g.listings(req, "agency.read"), req.params.listingId)),
    route(agency.updateListing, async (req) =>
      S.update(await g.listings(req, "agency.listings.manage", WRITE), req.params.listingId, req.body),
    ),
    route(agency.submitListing, async (req) =>
      S.submit(await g.listings(req, "marketplace.publish", WRITE), req.params.listingId),
    ),
    route(agency.unpublishListing, async (req) =>
      S.unpublish(await g.listings(req, "marketplace.publish", WRITE), req.params.listingId),
    ),
    route(agency.addMedia, async (req) =>
      S.addMedia(await g.listings(req, "agency.listings.manage", WRITE), req.params.listingId, req.body),
    ),
    route(agency.removeMedia, async (req) =>
      S.removeMedia(await g.listings(req, "agency.listings.manage", WRITE), req.params.listingId, req.params.mediaId),
    ),
    route(agency.listingCalendar, async (req) =>
      S.calendar(await g.agency(req, "agency.read"), req.params.listingId, req.query.from, req.query.to),
    ),
    route(agency.setRates, async (req) =>
      S.setRates(await g.agency(req, "agency.listings.manage", WRITE), req.params.listingId, req.body.rates),
    ),
  ];
}
