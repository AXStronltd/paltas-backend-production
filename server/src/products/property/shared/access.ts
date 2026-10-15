/*
 * Every Property Management request passes the core gate (membership, the role's capability, the "property"
 * subscription, an active subscription for changes, the plan's module for changes). Some screens are shared by
 * several roles (a maintenance manager or technician sees work orders without seeing the rent ledger), so a route may
 * accept any of a few capabilities. Portal requests then find the contact linked to the signed-in person: a tenant or
 * owner only ever reaches their own records.
 */
import type { Capability } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { ContactRow } from "../../../core/contacts/contacts.repo.js";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import { ApiError, fail } from "../../../http/errors.js";

/** Plan modules (catalogue keys) each area needs for changes. Records stay readable without them. */
export const MODULE = {
  finance: "finance",
  maintenance: "maint",
  crm: "crm",
  documents: "docs",
} as const;

export interface GateOptions {
  write?: boolean;
  module?: string;
}

export interface PortalScope extends OrgScope {
  contact: ContactRow;
}

export function pmAccess(core: CoreServices) {
  const { access, contacts } = core;

  /** The organisation scope for one capability, or the first of several the person's role has. */
  async function org(
    user: SessionUser,
    orgId: string,
    capability: Capability | readonly Capability[],
    o: GateOptions = {},
  ): Promise<OrgScope> {
    const caps = typeof capability === "string" ? [capability] : capability;
    let refused: unknown = null;
    for (const c of caps) {
      try {
        return await access.scope(user, orgId, {
          capability: c,
          products: ["property"],
          ...(o.write ? { write: true } : {}),
          ...(o.module ? { module: o.module } : {}),
        });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "ROLE_NOT_ALLOWED") throw e;
        refused = e;
      }
    }
    throw refused ?? fail.roleNotAllowed("Your role cannot do this");
  }

  /** A tenant's or owner's portal: the contact linked to the signed-in person. */
  async function portal(
    user: SessionUser,
    orgId: string,
    capability: "property.portal.tenant" | "property.portal.owner",
    o: GateOptions = {},
  ): Promise<PortalScope> {
    const s = await org(user, orgId, capability, o);
    const contact = await contacts.ofUser(orgId, user.id);
    if (!contact) throw fail.notFound("No tenant or owner record is linked to your sign-in yet");
    return { ...s, contact };
  }

  return { org, portal };
}

export type PmAccess = ReturnType<typeof pmAccess>;
