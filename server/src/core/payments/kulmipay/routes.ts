import { receivingAccounts } from "./receiving-accounts.js";
import { kulmiSettlements } from "./settlements.js";
import { kulmiPay as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmDeps } from "../../../products/property/deps.js";
import { kulmiPayService } from "./service.js";
export function kulmiPayRoutes(d: PmDeps) {
  const receiving = receivingAccounts(d);
  const p = kulmiPayService(d),
    settlements = kulmiSettlements(d);
  const owner = (u: Parameters<typeof d.access.org>[0], id: string, write = false) =>
    d.access.org(u, id, "subscription.own", { write });
  const finance = (u: Parameters<typeof d.access.org>[0], id: string, write = false) =>
    d.access.org(u, id, write ? "property.payments.record" : "property.reports.read", { write, module: "finance" });
  const bank = (u: Parameters<typeof d.access.org>[0], id: string, write = false) =>
    d.access.org(u, id, "property.bank.reconcile", { write, module: "finance" });
  return [
    route(api.receivingAccount, async (r) => receiving.get(await owner(r.user, r.params.orgId))),
    route(api.saveReceivingAccount, async (r) => receiving.save(await owner(r.user, r.params.orgId, true), r.body)),
    route(api.pauseReceivingAccount, async (r) => receiving.pause(await owner(r.user, r.params.orgId, true), r.body)),
    route(api.listSettlements, async (r) => settlements.list(await bank(r.user, r.params.orgId))),
    route(api.prepareSettlement, async (r) => settlements.prepare(await bank(r.user, r.params.orgId, true), r.body)),
    route(api.approveSettlement, async (r) =>
      settlements.approve(await bank(r.user, r.params.orgId, true), r.params.settlementId),
    ),
    route(api.rejectSettlement, async (r) =>
      settlements.reject(await bank(r.user, r.params.orgId, true), r.params.settlementId, r.body.reason),
    ),
    route(api.connection, async (r) =>
      p.status(
        await d.access.org(r.user, r.params.orgId, [
          "subscription.own",
          "property.payments.record",
          "property.reports.read",
        ]),
      ),
    ),
    route(api.connect, async (r) => p.connect(await owner(r.user, r.params.orgId, true), r.body)),
    route(api.pause, async (r) => p.pause(await owner(r.user, r.params.orgId, true), r.body.reason)),
    route(api.list, async (r) => p.list(await finance(r.user, r.params.orgId), r.query)),
    route(api.request, async (r) => p.request(await finance(r.user, r.params.orgId, true), r.body)),
    route(api.refresh, async (r) =>
      p.refresh(await finance(r.user, r.params.orgId), r.params.requestId, r.body.providerInvoiceId),
    ),
    route(api.webhook, async (r) => p.webhook(r.params.orgId, r.body)),
  ];
}
