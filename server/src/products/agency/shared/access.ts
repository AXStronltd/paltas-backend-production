/*
 * Every agency request passes the core gate (membership, role capability, product subscription, an active
 * subscription for changes). Listings and the marketplace inbox also serve Property Management organisations (their
 * listings reach the same marketplace); leads, deals, commissions and stays are Agent / Host only.
 */
import type { Capability } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { SessionUser } from "../../../core/identity/identity.service.js";

export const WRITE = { write: true } as const;

interface OrgRequest {
  user: SessionUser;
  params: { orgId: string };
}

export function agencyGate(core: CoreServices) {
  return {
    /** Agent / Host workspace records. */
    agency: (req: OrgRequest, capability: Capability, o: { write?: boolean } = {}): Promise<OrgScope> =>
      core.access.scope(req.user, req.params.orgId, { capability, products: ["agency"], ...o }),
    /** Listings and the marketplace inbox: Agent / Host or Property Management. */
    listings: (req: OrgRequest, capability: Capability, o: { write?: boolean } = {}): Promise<OrgScope> =>
      core.access.scope(req.user, req.params.orgId, { capability, products: ["agency", "property"], ...o }),
  };
}

export type AgencyGate = ReturnType<typeof agencyGate>;
