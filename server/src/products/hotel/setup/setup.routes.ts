// HTTP only: set-up, company accounts and guest profiles. Each route states the capability it needs.
import { hotel } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { HotelAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import { toProperty } from "../shared/property.js";
import type { SetupService } from "./setup.service.js";

export function setupRoutes(access: HotelAccess, S: SetupService) {
  const g = gate(access);
  return [
    route(hotel.listProperties, async (req) => S.listProperties(await g.org(req, "hotel.read"))),
    route(hotel.createProperty, async (req) => S.createProperty(await g.org(req, "hotel.setup", WRITE), req.body)),
    route(hotel.getProperty, async (req) => toProperty((await g.hotel(req, "hotel.read")).property)),
    route(hotel.updateProperty, async (req) => S.updateProperty(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.getPropertyStaff, async (req) => S.staff(await g.hotel(req, "hotel.read"))),
    route(hotel.setPropertyStaff, async (req) =>
      S.setStaff(await g.hotel(req, "hotel.setup", WRITE), req.body.userIds),
    ),
    route(hotel.getSetup, async (req) => S.setup(await g.hotel(req, "hotel.read"))),
    route(hotel.createRoomType, async (req) => S.createRoomType(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.createRooms, async (req) => S.createRooms(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.createRatePlan, async (req) =>
      S.createRatePlan(await g.hotel(req, "hotel.rates.manage", WRITE), req.body),
    ),
    route(hotel.updateRatePlan, async (req) =>
      S.updateRatePlan(await g.hotel(req, "hotel.rates.manage", WRITE), req.params.ratePlanId, req.body),
    ),
    route(hotel.setSeasons, async (req) =>
      S.setSeasons(await g.hotel(req, "hotel.rates.manage", WRITE), req.params.ratePlanId, req.body.seasons),
    ),
    route(hotel.setRestrictions, async (req) =>
      S.setRestrictions(await g.hotel(req, "hotel.rates.manage", WRITE), req.body.restrictions),
    ),
    route(hotel.createChannel, async (req) =>
      S.createChannel(await g.hotel(req, "hotel.rates.manage", WRITE), req.body),
    ),
    route(hotel.createOutlet, async (req) => S.createOutlet(await g.hotel(req, "hotel.setup", WRITE), req.body)),
    route(hotel.listCorporateAccounts, async (req) => S.listCorporateAccounts(await g.org(req, "hotel.read"))),
    route(hotel.createCorporateAccount, async (req) =>
      S.createCorporateAccount(await g.org(req, "hotel.cityledger", WRITE), req.body),
    ),
    route(hotel.cityLedgerStatement, async (req) =>
      S.statement(await g.org(req, "hotel.cityledger"), req.params.accountId),
    ),
    route(hotel.cityLedgerPayment, async (req) => {
      const s = await access.property(req.user, req.params.orgId, req.body.propertyId, "hotel.cityledger", WRITE);
      return S.cityLedgerPayment(s, req.params.accountId, req.body);
    }),
    route(hotel.listGuests, async (req) => S.listGuests(await g.org(req, "hotel.read"), req.query.q)),
    route(hotel.updateGuest, async (req) =>
      S.updateGuest(await g.org(req, "hotel.frontdesk", WRITE), req.params.guestId, req.body),
    ),
  ];
}
