// HTTP only: availability, reservations and group blocks.
import { hotel } from "@paltas/contracts";
import type { CoreServices } from "../../../core/core-services.js";
import { route } from "../../../http/route.js";
import type { HotelAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import { addDays } from "../shared/dates.js";
import { availabilityOf, sellableRates } from "../shared/inventory.js";
import { loadRateBook } from "../shared/rates.js";
import { roomTypes } from "../setup/setup.repo.js";
import type { ReservationsService } from "./reservations.service.js";

export function reservationsRoutes(core: CoreServices, access: HotelAccess, R: ReservationsService) {
  const g = gate(access);
  const { db } = core;
  return [
    route(hotel.availability, async (req) => {
      const s = await g.hotel(req, "hotel.read");
      const channelId = req.query.channelId ?? null;
      const book = await loadRateBook(db, s.property.id);
      const out = [];
      for (const rt of await roomTypes(db, s.property.id)) {
        const days = await availabilityOf(
          db,
          {
            orgId: s.orgId,
            propertyId: s.property.id,
            roomTypeId: rt.id,
            from: req.query.from,
            to: addDays(req.query.to, 1),
          },
          book,
          channelId,
        );
        out.push({
          roomTypeId: rt.id,
          code: rt.code,
          name: rt.name,
          days: days.map((d) => ({
            date: d.date,
            total: d.total,
            sold: d.sold,
            held: d.held,
            outOfOrder: d.ooo,
            available: d.available,
            closed: d.closed,
            rates: sellableRates(book, rt.id, d.date),
          })),
        });
      }
      return { channelId, roomTypes: out };
    }),
    route(hotel.createReservation, async (req) => {
      const s = await g.hotel(req, "hotel.reservations.manage", WRITE);
      return R.load(db, s.property.id, await R.create(s, req.body));
    }),
    route(hotel.listReservations, async (req) => R.list(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.getReservation, async (req) => {
      const s = await g.hotel(req, "hotel.read");
      return R.load(db, s.property.id, req.params.reservationId);
    }),
    route(hotel.cancelReservation, async (req) =>
      R.cancelOrNoShow(
        await g.hotel(req, "hotel.reservations.manage", WRITE),
        req.params.reservationId,
        "cancel",
        req.body.reason,
      ),
    ),
    route(hotel.noShowReservation, async (req) =>
      R.cancelOrNoShow(
        await g.hotel(req, "hotel.reservations.manage", WRITE),
        req.params.reservationId,
        "no_show",
        "No-show recorded by the front desk",
      ),
    ),
    route(hotel.confirmWaitlisted, async (req) =>
      R.confirmWaitlisted(await g.hotel(req, "hotel.reservations.manage", WRITE), req.params.reservationId),
    ),
    route(hotel.createGroupBlock, async (req) =>
      R.createBlock(await g.hotel(req, "hotel.reservations.manage", WRITE), req.body),
    ),
    route(hotel.listGroupBlocks, async (req) => R.listBlocks(await g.hotel(req, "hotel.read"))),
    route(hotel.releaseGroupCutoffs, async (req) => {
      const s = await g.hotel(req, "hotel.reservations.manage", WRITE);
      // blocks whose cut-off date is before today's business date
      return { released: await db.tx((t) => R.releaseCutoffs(t, s, addDays(s.property.business_date, -1))) };
    }),
  ];
}
