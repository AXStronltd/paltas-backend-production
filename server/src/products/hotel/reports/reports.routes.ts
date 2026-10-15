// HTTP only: night audit, income audit, reports, costs, group views and integration boundaries.
import { hotel } from "@paltas/contracts";
import type { AppContext } from "../../../context.js";
import { resolveEntitlement } from "../../../core/subscriptions/entitlement.service.js";
import { fail } from "../../../http/errors.js";
import { route } from "../../../http/route.js";
import type { AuditService } from "../audit/audit.service.js";
import type { IntegrationsService } from "../integrations/integrations.service.js";
import type { HotelAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import type { ReportsService } from "./reports.service.js";

export function reportsRoutes(
  ctx: AppContext,
  access: HotelAccess,
  x: { audit: AuditService; reports: ReportsService; integrations: IntegrationsService },
) {
  const g = gate(access);
  const { audit: A, reports: R, integrations: I } = x;
  return [
    // ---- night audit and income audit
    route(hotel.nightAuditCheck, async (req) => A.check(await g.hotel(req, "hotel.nightaudit.run"))),
    route(hotel.runNightAudit, async (req) =>
      A.run(await g.hotel(req, "hotel.nightaudit.run", WRITE), req.body.processNoShows),
    ),
    route(hotel.getDailyReport, async (req) =>
      A.dailyReport(await g.hotel(req, "hotel.reports.read"), req.params.date),
    ),
    route(hotel.getIncomeAudit, async (req) =>
      A.getIncomeAudit(await g.hotel(req, "hotel.reports.read"), req.params.date),
    ),
    route(hotel.signOffIncomeAudit, async (req) =>
      A.signOff(
        await g.hotel(req, "hotel.incomeaudit.signoff", WRITE),
        req.params.date,
        req.body.note,
        req.body.acknowledgeFindings,
      ),
    ),

    // ---- reports (from the ledger)
    route(hotel.kpis, async (req) => R.getKpis(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to)),
    route(hotel.flashReport, async (req) => R.flash(await g.hotel(req, "hotel.reports.read"), req.query.date)),
    route(hotel.departmentalPnl, async (req) =>
      R.pnl(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.channelReport, async (req) =>
      R.channels(await g.hotel(req, "hotel.reports.read"), req.query.from, req.query.to),
    ),
    route(hotel.postCost, async (req) =>
      R.postCost(await g.hotel(req, "hotel.costs.post", { write: true, module: "finance" }), req.body),
    ),

    // ---- group (two or more hotels)
    route(hotel.groupAvailability, async (req) =>
      R.groupAvailability(await g.org(req, "hotel.group.read"), req.query.from, req.query.to),
    ),
    route(hotel.groupKpis, async (req) => R.groupKpis(await g.org(req, "hotel.group.read"), req.query)),

    // ---- integration boundaries
    route(hotel.integrations, async (req) => {
      await g.hotel(req, "hotel.read");
      return I.status();
    }),
    route(hotel.ariQueue, async (req) => I.ariQueue(await g.hotel(req, "hotel.read"), req.query.channelId)),
    route(hotel.channelBooking, async (req) => {
      // the signature proved the provider; the hotel subscription must still be usable
      const en = await resolveEntitlement(ctx.db, ctx.products, ctx.clock.today(), req.body.orgId, "hotel").catch(
        () => null,
      );
      if (!en) throw fail.notFound("Unknown hotel");
      if (!en.ent.usable) throw fail.subscriptionInactive("This hotel's subscription is not active");
      return I.channelBooking(req.params.provider, req.body);
    }),
    route(hotel.listKeys, async (req) => I.keys(await g.hotel(req, "hotel.read"), req.params.stayId)),
    route(hotel.checkKey, async (req) =>
      I.checkKey(await g.hotel(req, "hotel.frontdesk"), req.params.keyId, req.body.roomId, req.body.date),
    ),
    route(hotel.runEnergy, async (req) => I.runEnergy(await g.hotel(req, "hotel.maintenance", WRITE))),
    route(hotel.listRoomCommands, async (req) => I.commands(await g.hotel(req, "hotel.read"))),
    route(hotel.askConcierge, async (req) => I.ask(await g.hotel(req, "hotel.frontdesk", WRITE), req.body)),
    route(hotel.listMessages, async (req) => I.messages(await g.hotel(req, "hotel.read"), req.query.reservationId)),
    route(hotel.sendMessage, async (req) => I.send(await g.hotel(req, "hotel.frontdesk", WRITE), req.body)),
  ];
}
