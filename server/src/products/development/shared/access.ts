/*
 * Every Development request passes the core gate (membership, the role's capability, the Development subscription,
 * an active subscription for changes, the module for changes). Records of another organisation answer "not found".
 */
import { roleCan, type Capability } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import { fail } from "../../../http/errors.js";

export interface DevRequest {
  user: SessionUser;
  params: { orgId: string };
}

export interface GateOptions {
  write?: boolean;
  /** The plan module the change needs (crm, payments, procurement …). */
  module?: string;
}

export const WRITE = { write: true } as const;
export const SALES = { write: true, module: "crm" } as const;
export const PAYMENTS = { write: true, module: "payments" } as const;
export const SPEND = { write: true, module: "procurement" } as const;

export function devGate(core: CoreServices) {
  return (req: DevRequest, capability: Capability, o: GateOptions = {}): Promise<OrgScope> =>
    core.access.scope(req.user, req.params.orgId, { capability, products: ["developer"], ...o });
}
export type DevGate = ReturnType<typeof devGate>;

export const can = (s: OrgScope, c: Capability): boolean => roleCan(s.role, c);

/** At least one of these capabilities, or ROLE_NOT_ALLOWED. */
export function requireAny(s: OrgScope, caps: Capability[], what: string): void {
  if (!caps.some((c) => can(s, c))) throw fail.roleNotAllowed(`Your role cannot ${what}`);
}
