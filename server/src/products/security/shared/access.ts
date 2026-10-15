/*
 * Every security request passes the core gate (membership, role capability, the security subscription, an active
 * subscription for changes, the module) and then, where it matters, a record-level rule:
 *   - a guard acts only for their own guard record (members whose role can manage the roster act for anyone);
 *   - a client-portal member sees only the clients they are linked to (sec_client_users).
 * Records of another organisation answer "not found".
 */
import { roleCan, type Capability } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

export interface AccessOptions {
  write?: boolean;
  /** Finance writes need the plan's finance module. */
  module?: string;
}

export const WRITE = { write: true } as const;
export const FINANCE_WRITE = { write: true, module: "finance" } as const;

interface OrgRequest {
  user: SessionUser;
  params: { orgId: string };
}

export function securityAccess(core: CoreServices) {
  return {
    /** Organisation-level security request. */
    scope: (req: OrgRequest, capability: Capability, o: AccessOptions = {}): Promise<OrgScope> =>
      core.access.scope(req.user, req.params.orgId, { capability, products: ["security"], ...o }),
    /** The first capability of the list this member's role holds (e.g. reports for staff, portal for clients). */
    scopeAny: async (
      req: OrgRequest,
      capabilities: [Capability, ...Capability[]],
      o: AccessOptions = {},
    ): Promise<OrgScope> => {
      const m = await core.db.row<{ role: Parameters<typeof roleCan>[0] }>(
        "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
        [req.params.orgId, req.user.id],
      );
      const capability = (m && capabilities.find((c) => roleCan(m.role, c))) ?? capabilities[0];
      return core.access.scope(req.user, req.params.orgId, { capability, products: ["security"], ...o });
    },
  };
}

export type SecurityAccess = ReturnType<typeof securityAccess>;

/** May this member act for any guard (supervisors, operations managers), or only for their own guard record? */
export const actsForAnyGuard = (s: OrgScope): boolean => roleCan(s.role, "security.roster.manage");

export interface GuardRow {
  id: string;
  org_id: string;
  number: string;
  name: string;
  grade: string;
  user_id: string | null;
  phone: string | null;
  status: "active" | "leave" | "suspended" | "left";
  licence_no: string;
  licence_expiry: string;
  vetting: "cleared" | "due" | "pending" | "failed";
  home_site_id: string | null;
}

export async function findGuard(db: Db, orgId: string, guardId: string, lock = false): Promise<GuardRow> {
  const g = await db.row<GuardRow>(
    `SELECT * FROM sec_guards WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [orgId, guardId],
  );
  if (!g) throw fail.notFound("Guard not found");
  return g;
}

/** The guard this member acts for: their own record, unless their role may act for any guard. */
export async function actingGuard(db: Db, s: OrgScope, guardId: string): Promise<GuardRow> {
  const g = await findGuard(db, s.orgId, guardId);
  if (!actsForAnyGuard(s) && g.user_id !== s.userId)
    throw fail.forbidden("Guards record field actions for themselves only");
  return g;
}

/** Client ids a portal member may see; null when the member is staff with the reports capability. */
export async function visibleClients(db: Db, s: OrgScope): Promise<string[] | null> {
  if (roleCan(s.role, "security.reports.read")) return null;
  const rows = await db.rows<{ client_id: string }>(
    "SELECT client_id FROM sec_client_users WHERE org_id = $1 AND user_id = $2",
    [s.orgId, s.userId],
  );
  return rows.map((r) => r.client_id);
}
