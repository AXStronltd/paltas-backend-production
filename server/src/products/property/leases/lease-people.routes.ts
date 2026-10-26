import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, WRITE } from "../shared/gate.js";
import type { leasePeopleService } from "./lease-people.service.js";
export function leasePeopleRoutes(access: PmAccess, M: ReturnType<typeof leasePeopleService>) {
  const g = gate(access),
    read = (r: Parameters<typeof g.org>[0]) => g.org(r, "property.tenants.view"),
    write = (r: Parameters<typeof g.org>[0]) => g.org(r, "property.leases.manage", WRITE);
  return [
    route(api.getLeasePerson, async (r) => M.get(await read(r), r.params.leaseId, r.params.leasePersonId)),
    route(api.listLeasePeople, async (r) => M.list(await read(r), r.params.leaseId, r.query)),
    route(api.createLeasePerson, async (r) => M.create(await write(r), r.params.leaseId, r.body)),
    route(api.updateLeasePerson, async (r) =>
      M.update(await write(r), r.params.leaseId, r.params.leasePersonId, r.body),
    ),
    route(api.leasePeopleHistory, async (r) => M.history(await read(r), r.params.leaseId, r.query)),
  ];
}
