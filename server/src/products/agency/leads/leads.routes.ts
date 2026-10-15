// HTTP only: the marketplace inbox, leads, viewings and offers.
import { agency } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import { WRITE, type AgencyGate } from "../shared/access.js";
import type { LeadsService } from "./leads.service.js";

export function leadsRoutes(g: AgencyGate, S: LeadsService) {
  return [
    route(agency.inbox, async (req) => S.inbox(await g.listings(req, "marketplace.inbox"), req.query.status)),
    route(agency.convertEnquiry, async (req) =>
      S.convert(await g.agency(req, "agency.leads.manage", WRITE), req.params.enquiryId, req.body.agentUserId),
    ),
    route(agency.closeEnquiry, async (req) =>
      S.closeEnquiry(await g.listings(req, "marketplace.inbox", WRITE), req.params.enquiryId, req.body.status),
    ),
    route(agency.listLeads, async (req) => S.list(await g.agency(req, "agency.leads.manage"), req.query.stage)),
    route(agency.createLead, async (req) => S.create(await g.agency(req, "agency.leads.manage", WRITE), req.body)),
    route(agency.getLead, async (req) => S.get(await g.agency(req, "agency.leads.manage"), req.params.leadId)),
    route(agency.moveLead, async (req) =>
      S.move(await g.agency(req, "agency.leads.manage", WRITE), req.params.leadId, req.body),
    ),
    route(agency.assignLead, async (req) =>
      S.assign(await g.agency(req, "agency.leads.assign", WRITE), req.params.leadId, req.body.agentUserId),
    ),
    route(agency.noteLead, async (req) =>
      S.note(await g.agency(req, "agency.leads.manage", WRITE), req.params.leadId, req.body),
    ),
    route(agency.bookViewing, async (req) =>
      S.bookViewing(await g.agency(req, "agency.leads.manage", WRITE), req.params.leadId, req.body),
    ),
    route(agency.listViewings, async (req) => S.viewings(await g.agency(req, "agency.leads.manage"), req.query)),
    route(agency.viewingAction, async (req) =>
      S.viewingAction(await g.agency(req, "agency.leads.manage", WRITE), req.params.viewingId, req.body),
    ),
    route(agency.listOffers, async (req) => S.offers(await g.agency(req, "agency.leads.manage"), req.query.status)),
    route(agency.respondOffer, async (req) =>
      S.respond(await g.agency(req, "agency.deals.manage", WRITE), req.params.offerId, req.body),
    ),
  ];
}
