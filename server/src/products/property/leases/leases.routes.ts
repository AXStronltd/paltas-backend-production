// HTTP only: leases, their charges and meter readings.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { BillingService } from "../billing/billing.service.js";
import type { PaymentsService } from "../payments/payments.service.js";
import type { PmAccess } from "../shared/access.js";
import { FINANCE, gate, WRITE } from "../shared/gate.js";
import type { LeasesService } from "./leases.service.js";

export function leasesRoutes(access: PmAccess, L: LeasesService, B: BillingService, Pay: PaymentsService) {
  const g = gate(access);
  const manage = (req: Parameters<typeof g.org>[0]) => g.org(req, "property.leases.manage", WRITE);
  return [
    route(api.listLeases, async (req) => L.list(await g.org(req, "property.read"), req.query)),
    route(api.createLease, async (req) => L.create(await manage(req), req.body)),
    route(api.getLease, async (req) => {
      const s = await g.org(req, "property.read");
      const lease = await L.one(s, req.params.leaseId);
      const invoices = (await B.list(s, { leaseId: lease.id })).invoices;
      return { lease, invoices, depositRefunds: (await Pay.listRefunds(s, undefined, lease.id)).refunds };
    }),
    route(api.updateLease, async (req) => L.update(await manage(req), req.params.leaseId, req.body)),
    // activation issues the deposit invoice: money, so the finance module
    route(api.previewLeaseActivation, async (req) =>
      L.previewActivation(await g.org(req, "property.leases.manage", FINANCE), req.params.leaseId, req.body),
    ),
    route(api.activateLease, async (req) =>
      L.activate(await g.org(req, "property.leases.manage", FINANCE), req.params.leaseId, req.body),
    ),
    route(api.renewLease, async (req) => L.renew(await manage(req), req.params.leaseId, req.body)),
    route(api.reviewRent, async (req) => L.reviewRent(await manage(req), req.params.leaseId, req.body)),
    route(api.giveNotice, async (req) => L.notice(await manage(req), req.params.leaseId, req.body)),
    route(api.terminateLease, async (req) => L.terminate(await manage(req), req.params.leaseId, req.body)),
    route(api.cancelLease, async (req) => L.cancel(await manage(req), req.params.leaseId, req.body)),
    route(api.setLeaseCharges, async (req) => L.setCharges(await manage(req), req.params.leaseId, req.body.charges)),
    route(api.recordMeterReadings, async (req) => L.recordReadings(await manage(req), req.body)),
    route(api.listMeterReadings, async (req) => L.listReadings(await g.org(req, "property.read"), req.query)),
  ];
}
