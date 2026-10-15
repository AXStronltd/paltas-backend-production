/*
 * The audit trail. Every change of consequence records who did it, in which organisation, what, and (where useful)
 * the record before and after. The table is append-only at the database level (migration 0001).
 */
import type { AuditEntry } from "@paltas/contracts";
import type { Db } from "../../db/database.js";

/** Who is acting: a person (with their role in this context) or the system/provider. */
export interface Actor {
  userId: string | null;
  role: string;
}

export const SYSTEM: Actor = { userId: null, role: "system" };

export interface AuditInput {
  actor: Actor | null;
  orgId: string | null;
  action: string;
  target?: string | null;
  detail?: string;
  before?: unknown;
  after?: unknown;
}

export async function recordAudit(db: Db, e: AuditInput): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (actor_user, actor_role, org_id, action, target, detail, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actor?.userId ?? null,
      e.actor?.role ?? null,
      e.orgId,
      e.action,
      e.target ?? null,
      e.detail ?? "",
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
    ],
  );
}

interface AuditRow {
  id: number;
  at: string;
  actor_user: string | null;
  actor_role: string | null;
  org_id: string | null;
  action: string;
  target: string | null;
  detail: string;
  before: unknown;
  after: unknown;
}

const toEntry = (r: AuditRow): AuditEntry & { orgId: string | null } => ({
  id: String(r.id),
  at: r.at,
  actorUserId: r.actor_user,
  actorRole: r.actor_role,
  action: r.action,
  target: r.target,
  detail: r.detail,
  before: r.before,
  after: r.after,
  orgId: r.org_id,
});

export async function listAudit(
  db: Db,
  filter: { orgId?: string | null; limit: number; beforeId?: string | null },
): Promise<(AuditEntry & { orgId: string | null })[]> {
  const rows = await db.rows<AuditRow>(
    `SELECT * FROM audit_log
     WHERE ($1::text IS NULL OR org_id = $1) AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT $3`,
    [filter.orgId ?? null, filter.beforeId && /^\d+$/.test(filter.beforeId) ? filter.beforeId : null, filter.limit],
  );
  return rows.map(toEntry);
}
