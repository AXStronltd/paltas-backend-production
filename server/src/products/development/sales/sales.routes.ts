// HTTP only: buyers, correspondence, disputes, offers, reservations and contracts.
import { development as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { SALES, WRITE, type DevGate } from "../shared/access.js";
import type { SalesService } from "./sales.service.js";

export function salesRoutes(g: DevGate, S: SalesService) {
  return [
    route(api.moveBuyerStage, async (req) =>
      S.moveBuyerStage(await g(req, "developer.sales", SALES), req.params.buyerId, req.body),
    ),
    route(api.listBuyers, async (req) => S.listBuyers(await g(req, "developer.buyers.read"), req.query.q)),
    route(api.createBuyer, async (req) => S.createBuyer(await g(req, "developer.sales", SALES), req.body)),
    route(api.getBuyer, async (req) => S.getBuyer(await g(req, "developer.buyers.read"), req.params.buyerId)),
    route(api.updateBuyer, async (req) =>
      S.updateBuyer(await g(req, "developer.sales", SALES), req.params.buyerId, req.body),
    ),
    route(api.assignBuyer, async (req) =>
      S.assignBuyer(await g(req, "developer.sales.manage", SALES), req.params.buyerId, req.body.agentUserId),
    ),
    route(api.mergeBuyers, async (req) =>
      S.mergeBuyers(
        await g(req, "developer.sales.manage", SALES),
        req.params.buyerId,
        req.body.duplicateId,
        req.body.reason,
      ),
    ),
    route(api.recordCorrespondence, async (req) =>
      S.recordCorrespondence(await g(req, "developer.sales", SALES), req.params.buyerId, req.body),
    ),
    route(api.openDispute, async (req) =>
      S.openDispute(await g(req, "developer.sales", SALES), req.params.buyerId, req.body),
    ),
    route(api.resolveDispute, async (req) =>
      S.resolveDispute(await g(req, "developer.sales.manage", SALES), req.params.disputeId, req.body.resolution),
    ),
    route(api.listOffers, async (req) => S.listOffers(await g(req, "developer.buyers.read"), req.query)),
    route(api.createOffer, async (req) => S.createOffer(await g(req, "developer.sales", SALES), req.body)),
    route(api.reviseOffer, async (req) =>
      S.reviseOffer(await g(req, "developer.sales", SALES), req.params.offerId, req.body),
    ),
    route(api.submitOffer, async (req) => S.submitOffer(await g(req, "developer.sales", SALES), req.params.offerId)),
    route(api.decideOffer, async (req) =>
      S.decideOffer(
        await g(req, "developer.sales.manage", SALES),
        req.params.offerId,
        req.body.approve,
        req.body.reason,
      ),
    ),
    route(api.respondToOffer, async (req) =>
      S.respond(await g(req, "developer.sales", SALES), req.params.offerId, req.body),
    ),
    route(api.acceptCounter, async (req) =>
      S.acceptCounter(await g(req, "developer.sales", SALES), req.params.offerId),
    ),
    route(api.withdrawOffer, async (req) =>
      S.withdrawOffer(await g(req, "developer.sales", SALES), req.params.offerId, req.body.reason),
    ),
    route(api.listReservations, async (req) =>
      S.listReservations(await g(req, "developer.buyers.read"), req.query.status),
    ),
    route(api.approveReservation, async (req) =>
      S.approveReservation(await g(req, "developer.sales.manage", SALES), req.params.reservationId),
    ),
    route(api.cancelReservation, async (req) =>
      S.cancelReservation(await g(req, "developer.sales.manage", SALES), req.params.reservationId, req.body.reason),
    ),
    route(api.expireSales, async (req) => S.expire(await g(req, "developer.buyers.read", WRITE))),
    route(api.signContract, async (req) =>
      S.signContract(await g(req, "developer.sales.manage", SALES), req.params.reservationId, req.body),
    ),
    route(api.listContracts, async (req) => S.listContracts(await g(req, "developer.buyers.read"), req.query)),
  ];
}
