// HTTP only: front desk, folios, outlets, rooms, housekeeping, maintenance and cashier shifts.
import { hotel } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { CashierService } from "../cashier/cashier.service.js";
import type { FoliosService } from "../folios/folios.service.js";
import type { RoomsService } from "../rooms/rooms.service.js";
import type { HotelAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import type { FrontdeskService } from "./frontdesk.service.js";

export function frontdeskRoutes(
  access: HotelAccess,
  x: { frontdesk: FrontdeskService; folios: FoliosService; rooms: RoomsService; cashier: CashierService },
) {
  const g = gate(access);
  const { frontdesk: D, folios: F, rooms: R, cashier: C } = x;
  return [
    // ---- front desk
    route(hotel.preCheckIn, async (req) =>
      D.preCheckIn(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.reservationId, req.body),
    ),
    route(hotel.assignRoom, async (req) =>
      D.assignRoom(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.stayId, req.body.roomId),
    ),
    route(hotel.checkIn, async (req) =>
      D.checkIn(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.stayId, req.body.roomId),
    ),
    route(hotel.moveRoom, async (req) =>
      D.move(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.stayId, req.body.roomId, req.body.reason),
    ),
    route(hotel.extendStay, async (req) =>
      D.extend(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.stayId, req.body.departure),
    ),
    route(hotel.checkOut, async (req) => D.checkOut(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.stayId)),
    route(hotel.listRequests, async (req) => D.listRequests(await g.hotel(req, "hotel.read"), req.query.status)),
    route(hotel.createRequest, async (req) => D.createRequest(await g.hotel(req, "hotel.frontdesk", WRITE), req.body)),
    route(hotel.completeRequest, async (req) =>
      D.completeRequest(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.requestId),
    ),

    // ---- folios
    route(hotel.listFolios, async (req) => F.list(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.getFolio, async (req) => {
      const s = await g.hotel(req, "hotel.read");
      return F.get(s.property.id, req.params.folioId);
    }),
    route(hotel.createFolio, async (req) => F.create(await g.hotel(req, "hotel.folio.manage", WRITE), req.body)),
    route(hotel.setRouting, async (req) =>
      F.setRouting(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.stayId, req.body.rules),
    ),
    route(hotel.postCharge, async (req) =>
      F.postCharge(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.folioId, req.body),
    ),
    route(hotel.transferLines, async (req) =>
      F.transfer(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.folioId, req.body),
    ),
    route(hotel.recordPayment, async (req) =>
      F.recordPayment(await g.hotel(req, "hotel.cashier", WRITE), req.params.folioId, req.body),
    ),
    route(hotel.blockFolio, async (req) =>
      F.block(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.folioId, req.body),
    ),
    route(hotel.voidLine, async (req) =>
      F.voidLine(
        await g.hotel(req, "hotel.folio.manage", WRITE),
        req.params.folioId,
        req.params.lineId,
        req.body.reason,
      ),
    ),
    route(hotel.approveVoid, async (req) =>
      F.approveVoid(await g.hotel(req, "hotel.folio.approve", WRITE), req.params.folioId, req.params.lineId),
    ),
    route(hotel.requestRefund, async (req) =>
      F.requestRefund(await g.hotel(req, "hotel.folio.manage", WRITE), req.params.folioId, req.body),
    ),
    route(hotel.approveRefund, async (req) =>
      F.approveRefund(await g.hotel(req, "hotel.folio.approve", WRITE), req.params.refundId),
    ),
    route(hotel.outletCharge, async (req) =>
      R.outletCharge(await g.hotel(req, "hotel.outlet.post", WRITE), req.params.outletId, req.body),
    ),

    // ---- rooms, housekeeping, maintenance
    route(hotel.roomBoard, async (req) => R.board(await g.hotel(req, "hotel.read"))),
    route(hotel.setHousekeeping, async (req) =>
      R.setHousekeeping(await g.hotel(req, "hotel.housekeeping", WRITE), req.params.roomId, req.body.status),
    ),
    route(hotel.assignHousekeeping, async (req) =>
      R.assign(await g.hotel(req, "hotel.housekeeping.inspect", WRITE), req.body.attendantUserId, req.body.roomIds),
    ),
    route(hotel.postMinibar, async (req) =>
      R.minibar(await g.hotel(req, "hotel.housekeeping", WRITE), req.params.roomId, req.body.items),
    ),
    route(hotel.listMaintenance, async (req) => R.listTickets(await g.hotel(req, "hotel.read"), req.query.status)),
    route(hotel.createMaintenance, async (req) =>
      R.createTicket(await g.hotel(req, "hotel.maintenance", { write: true, module: "maint" }), req.body),
    ),
    route(hotel.resolveMaintenance, async (req) =>
      R.resolveTicket(
        await g.hotel(req, "hotel.maintenance", { write: true, module: "maint" }),
        req.params.ticketId,
        req.body.note,
      ),
    ),
    route(hotel.listLostFound, async (req) => R.listLost(await g.hotel(req, "hotel.read"))),
    route(hotel.createLostFound, async (req) =>
      R.createLost(await g.hotel(req, "hotel.housekeeping", WRITE), req.body),
    ),
    route(hotel.updateLostFound, async (req) =>
      R.updateLost(await g.hotel(req, "hotel.housekeeping", WRITE), req.params.itemId, req.body),
    ),

    // ---- cashier shifts
    route(hotel.listShifts, async (req) => C.list(await g.hotel(req, "hotel.read"), req.query.status)),
    route(hotel.openShift, async (req) => C.open(await g.hotel(req, "hotel.cashier", WRITE), req.body.floatMinor)),
    route(hotel.closeShift, async (req) =>
      C.close(await g.hotel(req, "hotel.cashier", WRITE), req.params.shiftId, req.body.countedCashMinor),
    ),
  ];
}
