/*
 * Every hotel request passes the core gate (membership, role capability, the hotel subscription, an active
 * subscription for changes, the module) and then the hotel gate: the property exists in this organisation and the
 * member works there. Organisation administrators and group owners reach every hotel; everyone else reaches only the
 * hotels they are assigned to (hotel_property_staff) — a member with no assignment reaches none (fail closed).
 */
import type { Capability } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { findProperty, type PropertyRow } from "./property.js";

export interface HotelScope extends OrgScope {
  property: PropertyRow;
}

export interface AccessOptions {
  write?: boolean;
  module?: string;
  moduleOnRead?: boolean;
}

const ALL_HOTELS_ROLES = new Set(["org_admin", "group_owner"]);

export const reachesAllHotels = (role: string): boolean => ALL_HOTELS_ROLES.has(role);

/** Assign members to a hotel (idempotent): the set-up flows that add someone to a hotel's work call this. */
export async function assignToProperty(t: Db, orgId: string, propertyId: string, userIds: string[]): Promise<void> {
  for (const u of userIds)
    await t.run(
      "INSERT INTO hotel_property_staff (property_id, org_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [propertyId, orgId, u],
    );
}

/** The properties this member may reach, or null when they may reach every hotel of the organisation. */
export async function assignedProperties(db: Db, s: OrgScope): Promise<string[] | null> {
  if (reachesAllHotels(s.role)) return null;
  const rows = await db.rows<{ property_id: string }>(
    "SELECT property_id FROM hotel_property_staff WHERE org_id = $1 AND user_id = $2",
    [s.orgId, s.userId],
  );
  return rows.map((r) => r.property_id);
}

export function hotelAccess(core: CoreServices) {
  const { access, db } = core;

  async function org(user: SessionUser, orgId: string, capability: Capability, o: AccessOptions = {}) {
    return access.scope(user, orgId, { capability, products: ["hotel"], ...o });
  }

  async function property(
    user: SessionUser,
    orgId: string,
    propertyId: string,
    capability: Capability,
    o: AccessOptions = {},
  ): Promise<HotelScope> {
    const s = await org(user, orgId, capability, o);
    const allowed = await assignedProperties(db, s);
    if (allowed !== null && !allowed.includes(propertyId)) throw fail.notFound("Hotel not found");
    return { ...s, property: await findProperty(db, s.orgId, propertyId) };
  }

  return { org, property };
}

export type HotelAccess = ReturnType<typeof hotelAccess>;
