// Small helpers so each hotel route states its capability in one line.
import type { Capability } from "@paltas/contracts";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import type { AccessOptions, HotelAccess, HotelScope } from "./access.js";

export const WRITE = { write: true } as const;

interface PropertyRequest {
  user: SessionUser;
  params: { orgId: string; propertyId: string };
}

interface OrgRequest {
  user: SessionUser;
  params: { orgId: string };
}

export function gate(access: HotelAccess) {
  return {
    /** A hotel-level request: membership, capability, subscription, then the hotel itself. */
    hotel: (req: PropertyRequest, capability: Capability, o: AccessOptions = {}): Promise<HotelScope> =>
      access.property(req.user, req.params.orgId, req.params.propertyId, capability, o),
    /** An organisation-level hotel request (company accounts, guests, group views). */
    org: (req: OrgRequest, capability: Capability, o: AccessOptions = {}) =>
      access.org(req.user, req.params.orgId, capability, o),
  };
}
