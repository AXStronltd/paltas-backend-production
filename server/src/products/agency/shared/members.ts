// Who in the organisation may be given agency work (an agent on a listing, lead or viewing).
import { roleCan, type Capability } from "@paltas/contracts";
import { memberProductRole } from "../../../core/access/product-role.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

/** The person must be an active member of this organisation whose role grants the capability. */
export async function requireMember(db: Db, orgId: string, userId: string, capability: Capability): Promise<void> {
  const role = await memberProductRole(db, orgId, userId, "agency");
  if (!role || !roleCan(role, capability))
    throw fail.invalid("That person has no active Agent / Host role for this work");
}
