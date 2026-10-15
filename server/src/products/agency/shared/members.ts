// Who in the organisation may be given agency work (an agent on a listing, lead or viewing).
import { roleCan, type Capability, type Role } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

/** The person must be an active member of this organisation whose role grants the capability. */
export async function requireMember(db: Db, orgId: string, userId: string, capability: Capability): Promise<void> {
  const m = await db.row<{ role: Role }>(
    "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
    [orgId, userId],
  );
  if (!m) throw fail.invalid("That person is not an active member of this organisation");
  if (!roleCan(m.role, capability)) throw fail.invalid("That person's role cannot take this work");
}
