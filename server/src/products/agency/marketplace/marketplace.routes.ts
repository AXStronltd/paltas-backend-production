// HTTP only: the public marketplace (auth "public": no sign-in, limited per caller address) and PALTAS staff
// moderation (auth "staff").
import { marketplace as M } from "@paltas/contracts";
import { route, streamRoute } from "../../../http/route.js";
import type { ModerationService } from "./moderation.service.js";
import type { PublicService } from "./public.service.js";

export function marketplaceRoutes(P: PublicService, S: ModerationService) {
  return [
    streamRoute(M.mediaContent, async (req) => P.mediaContent(req.ip, req.params.listingId, req.params.mediaId)),
    route(M.searchListings, async (req) => P.search(req.ip, req.query)),
    route(M.getListing, async (req) => P.get(req.ip, req.params.listingId)),
    route(M.listingAvailability, async (req) =>
      P.availability(req.ip, req.params.listingId, req.query.from, req.query.to),
    ),
    route(M.quoteStay, async (req) => P.quote(req.ip, req.params.listingId, req.query)),
    route(M.sendEnquiry, async (req) => P.enquire(req.ip, req.params.listingId, req.body)),
    route(M.makeOffer, async (req) => P.offer(req.ip, req.params.listingId, req.body)),
    route(M.offerStatus, async (req) => P.offerStatus(req.ip, req.params.reference, req.body.token)),
    route(M.acceptCounter, async (req) => P.acceptCounter(req.ip, req.params.reference, req.body.token)),
    route(M.withdrawOffer, async (req) => P.withdrawOffer(req.ip, req.params.reference, req.body.token)),
    route(M.requestBooking, async (req) => P.book(req.ip, req.params.listingId, req.body)),
    route(M.bookingStatus, async (req) => P.bookingStatus(req.ip, req.params.reference, req.body.token)),
    route(M.cancelBooking, async (req) => P.cancelBooking(req.ip, req.params.reference, req.body.token)),
    route(M.reviewStay, async (req) => P.review(req.ip, req.params.reference, req.body)),
    route(M.requestBusiness, async (req) => S.submitRequest(req.ip, req.body)),
    // ---- PALTAS staff
    route(M.moderationQueue, async (req) => S.queue(req.user, req.query.status)),
    route(M.approveListing, async (req) => S.approve(req.user, req.params.listingId, req.body.note)),
    route(M.rejectListing, async (req) => S.reject(req.user, req.params.listingId, req.body.reason)),
    route(M.reviewQueue, async (req) => S.reviews(req.user, req.query.status)),
    route(M.moderateReview, async (req) => S.moderateReview(req.user, req.params.reviewId, req.body)),
    route(M.businessRequests, async (req) => S.requests(req.user, req.query.status)),
    route(M.approveBusinessRequest, async (req) => S.approveRequest(req.user, req.params.requestId, req.body)),
    route(M.rejectBusinessRequest, async (req) => S.rejectRequest(req.user, req.params.requestId, req.body.reason)),
  ];
}
