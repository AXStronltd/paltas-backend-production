// Small helpers so each Property Management route states its capability (and, for changes, its plan module) in one line.
import type { Capability } from "@paltas/contracts";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import { MODULE, type PmAccess } from "./access.js";

interface OrgRequest {
  user: SessionUser;
  params: { orgId: string };
}

/** Changes that need an active subscription, by plan module. */
export const WRITE = { write: true } as const;
export const FINANCE = { write: true, module: MODULE.finance } as const;
export const MAINT = { write: true, module: MODULE.maintenance } as const;
export const CRM = { write: true, module: MODULE.crm } as const;
export const DOCS = { write: true, module: MODULE.documents } as const;

/** Screens several roles share: maintenance staff see properties and work orders without the rent ledger. */
export const ANY_PM_READ: readonly Capability[] = [
  "property.read",
  "property.maintenance.manage",
  "property.maintenance.request",
  "property.maintenance.work",
];

export function gate(access: PmAccess) {
  return {
    org: (
      req: OrgRequest,
      capability: Capability | readonly Capability[],
      o: { write?: boolean; module?: string } = {},
    ) => access.org(req.user, req.params.orgId, capability, o),
    tenant: (req: OrgRequest, o: { write?: boolean; module?: string } = {}) =>
      access.portal(req.user, req.params.orgId, "property.portal.tenant", o),
    owner: (req: OrgRequest, o: { write?: boolean; module?: string } = {}) =>
      access.portal(req.user, req.params.orgId, "property.portal.owner", o),
  };
}
