// HTTP only: booking engine (promo codes, extras, room features), loyalty, feedback, templates, automation.
import { hotel } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { AutomationService } from "../automation/automation.service.js";
import type { BookingEngineService } from "../bookingengine/bookingengine.service.js";
import type { HotelAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import type { GuestsService } from "./guests.service.js";

export function guestsRoutes(
  access: HotelAccess,
  x: { guests: GuestsService; bookingEngine: BookingEngineService; automation: AutomationService },
) {
  const g = gate(access);
  const { guests: G, bookingEngine: E, automation: A } = x;
  return [
    // ---- settings and automation
    route(hotel.getExtensionSettings, async (req) => A.getSettings(await g.hotel(req, "hotel.read"))),
    route(hotel.updateExtensionSettings, async (req) =>
      A.updateSettings(await g.hotel(req, "hotel.setup", WRITE), req.body),
    ),
    route(hotel.runAutomation, async (req) => A.run(await g.hotel(req, "hotel.frontdesk", WRITE))),
    route(hotel.listMaintenancePlans, async (req) => A.listPlans(await g.hotel(req, "hotel.read"))),
    route(hotel.createMaintenancePlan, async (req) =>
      A.createPlan(await g.hotel(req, "hotel.maintenance", { write: true, module: "maint" }), req.body),
    ),

    // ---- booking engine
    route(hotel.listPromoCodes, async (req) => E.listPromoCodes(await g.hotel(req, "hotel.read"))),
    route(hotel.createPromoCode, async (req) =>
      E.createPromoCode(await g.hotel(req, "hotel.rates.manage", WRITE), req.body),
    ),
    route(hotel.updatePromoCode, async (req) =>
      E.updatePromoCode(await g.hotel(req, "hotel.rates.manage", WRITE), req.params.promoId, req.body),
    ),
    route(hotel.listUpsells, async (req) => E.listUpsells(await g.hotel(req, "hotel.read"))),
    route(hotel.saveUpsell, async (req) => E.saveUpsell(await g.hotel(req, "hotel.rates.manage", WRITE), req.body)),
    route(hotel.listAttributePrices, async (req) => E.listAttributePrices(await g.hotel(req, "hotel.read"))),
    route(hotel.setAttributePrices, async (req) =>
      E.setAttributePrices(await g.hotel(req, "hotel.rates.manage", WRITE), req.body.prices),
    ),
    route(hotel.bookingQuote, async (req) => E.quote(await g.hotel(req, "hotel.read"), req.body)),
    route(hotel.bookDirect, async (req) => E.book(await g.hotel(req, "hotel.reservations.manage", WRITE), req.body)),

    // ---- loyalty (organisation-wide programme)
    route(hotel.getLoyaltyProgramme, async (req) => G.getProgramme(await g.org(req, "hotel.read"))),
    route(hotel.setLoyaltyProgramme, async (req) => G.setProgramme(await g.org(req, "hotel.setup", WRITE), req.body)),
    route(hotel.listLoyaltyMembers, async (req) => G.listMembers(await g.org(req, "hotel.read"), req.query.q)),
    route(hotel.enrolLoyaltyMember, async (req) =>
      G.enrol(await g.org(req, "hotel.frontdesk", WRITE), req.body.guestId),
    ),
    route(hotel.getLoyaltyMember, async (req) => G.getMember(await g.org(req, "hotel.read"), req.params.memberId)),
    route(hotel.redeemPoints, async (req) =>
      G.redeem(await g.hotel(req, "hotel.frontdesk", WRITE), req.params.reservationId, req.body.points),
    ),
    route(hotel.adjustPoints, async (req) => {
      const s = await access.property(req.user, req.params.orgId, req.body.propertyId, "hotel.folio.approve", WRITE);
      return G.adjust(s, req.params.memberId, req.body.points, req.body.reason);
    }),

    // ---- feedback
    route(hotel.recordFeedback, async (req) =>
      G.recordFeedback(await g.hotel(req, "hotel.frontdesk", WRITE), req.body),
    ),
    route(hotel.listFeedback, async (req) => G.listFeedback(await g.hotel(req, "hotel.read"), req.query)),
    route(hotel.feedbackReport, async (req) =>
      G.feedbackReport(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),

    // ---- templates and personalisation
    route(hotel.listMessageTemplates, async (req) => G.listTemplates(await g.hotel(req, "hotel.read"))),
    route(hotel.setMessageTemplate, async (req) =>
      G.setTemplate(await g.hotel(req, "hotel.setup", WRITE), req.params.template, req.body),
    ),
    route(hotel.personalisation, async (req) => {
      const s = await g.hotel(req, "hotel.read");
      return G.personalisation(s, req.query.date ?? s.property.business_date);
    }),
  ];
}
