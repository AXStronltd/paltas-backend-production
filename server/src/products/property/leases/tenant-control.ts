import type { property as P } from "@paltas/contracts";
import type { PmDeps } from "../deps.js";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { addDays } from "../shared/util.js";
export function tenantControls(d: PmDeps) {
  const db = d.core.db;
  async function get(s: OrgScope, id: string): Promise<P.TenantControl> {
    const c = await d.core.contacts.get(s.orgId, id);
    if (!c.types.includes("tenant")) throw fail.invalid("This contact is not a tenant");
    const r = await db.row<{
      portal_suspended: boolean;
      archived: boolean;
      reason: string;
      review_on: string | null;
      updated_at: string;
    }>("SELECT * FROM pm_tenant_controls WHERE org_id=$1 AND tenant_id=$2", [s.orgId, id]);
    return {
      tenantId: id,
      portalSuspended: r?.portal_suspended ?? false,
      archived: r?.archived ?? false,
      reason: r?.reason ?? "",
      reviewOn: r?.review_on ?? null,
      updatedAt: r?.updated_at ?? null,
    };
  }
  return {
    get,
    async change(
      s: OrgScope,
      id: string,
      b: { action: "suspend" | "restore" | "archive" | "unarchive"; reason: string; reviewOn?: string },
    ) {
      const before = await get(s, id);
      if (b.action === "suspend" && (!b.reviewOn || b.reviewOn < s.today || b.reviewOn > addDays(s.today, 30)))
        throw fail.invalid(
          "Set a review date between today and 30 days from today. Portal suspension must not be used as eviction or debt collection.",
        );
      await financeTransaction(db, s.orgId, async (t) => {
        await t.run("SELECT 1 FROM contacts WHERE org_id=$1 AND id=$2 FOR UPDATE", [s.orgId, id]);
        if (
          b.action === "archive" &&
          (await t.row("SELECT 1 FROM pm_leases WHERE org_id=$1 AND tenant_id=$2 AND status IN ('draft','active')", [
            s.orgId,
            id,
          ]))
        )
          throw fail.conflict(
            "End or cancel the tenant’s leases through the authorised workflow before archiving. Archiving never ends a lease.",
          );
        const latest = await t.row<{ portal_suspended: boolean; archived: boolean; review_on: string | null }>(
          "SELECT * FROM pm_tenant_controls WHERE org_id=$1 AND tenant_id=$2",
          [s.orgId, id],
        );
        const suspended =
          b.action === "suspend" ? true : b.action === "restore" ? false : (latest?.portal_suspended ?? false);
        const archived = b.action === "archive" ? true : b.action === "unarchive" ? false : (latest?.archived ?? false);
        await t.run(
          `INSERT INTO pm_tenant_controls(org_id,tenant_id,portal_suspended,archived,reason,review_on,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,tenant_id) DO UPDATE SET portal_suspended=$3,archived=$4,reason=$5,review_on=$6,updated_by=$7,updated_at=now()`,
          [
            s.orgId,
            id,
            suspended,
            archived,
            b.reason,
            suspended ? (b.reviewOn ?? latest?.review_on ?? null) : null,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Tenant " + b.action,
          target: id,
          detail: b.reason,
          before,
          after: { portalSuspended: suspended, archived, reviewOn: b.reviewOn ?? null },
        });
      });
      return get(s, id);
    },
  };
}
