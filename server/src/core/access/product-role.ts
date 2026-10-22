import type { Db } from "../../db/database.js";
import { ROLE_DEFINITIONS, type Product, type ProductRoles, type Role } from "@paltas/contracts";

/** Membership is always checked by the caller; explicit assignments never fall back to the legacy role. */
export function productRole(legacy: Role, assignments: ProductRoles | null, product: Product): Role | null {
  const role = assignments === null ? legacy : assignments[product];
  return role && ROLE_DEFINITIONS[role]?.products.includes(product) ? role : null;
}

/** Assignment pickers and background audiences use the same effective role as request authorisation. */
export async function memberProductRole(db: Db, orgId: string, userId: string, product: Product): Promise<Role | null> {
  const m = await db.row<{ role: Role; product_roles: ProductRoles | null }>(
    "SELECT role,product_roles FROM memberships WHERE org_id=$1 AND user_id=$2 AND status='active'",
    [orgId, userId],
  );
  return m ? productRole(m.role, m.product_roles, product) : null;
}
