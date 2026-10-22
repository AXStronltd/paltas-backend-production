import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import * as R from "../shared/records.js";
interface OwnershipRow {
  id: string;
  org_id: string;
  property_id: string;
  unit_id: string | null;
  owner_id: string;
  owner_name: string;
  owner_type: "individual" | "company";
  evidence_ref: string;
  note: string;
  status: "pending" | "verified" | "revoked";
}
const view = (r: OwnershipRow) => ({
  id: r.id,
  propertyId: r.property_id,
  unitId: r.unit_id,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  ownerType: r.owner_type,
  evidenceRef: r.evidence_ref,
  note: r.note,
  status: r.status,
});
const sql =
  "SELECT o.*,c.name AS owner_name FROM pm_ownerships o JOIN contacts c ON c.id=o.owner_id AND c.org_id=o.org_id";
export function requireAuthorityReviewer(s: OrgScope) {
  if (!["org_admin", "finance_director"].includes(s.role))
    throw fail.roleNotAllowed(
      "Your organisation administrator or finance director must verify ownership and management authority",
    );
}
export function ownershipService(d: PmDeps) {
  const { db } = d.core;
  const one = async (orgId: string, id: string) => {
    const r = await db.row<OwnershipRow>(`${sql} WHERE o.org_id=$1 AND o.id=$2`, [orgId, id]);
    if (!r) throw fail.notFound("Ownership record not found");
    return view(r);
  };
  return {
    async list(orgId: string, propertyId?: string) {
      return {
        ownerships: (
          await db.rows<OwnershipRow>(
            `${sql} WHERE o.org_id=$1 AND ($2::text IS NULL OR o.property_id=$2) AND o.status<>'revoked' ORDER BY o.created_at`,
            [orgId, propertyId ?? null],
          )
        ).map(view),
      };
    },
    async create(
      s: OrgScope,
      b: {
        propertyId: string;
        unitIds?: string[];
        ownerId: string;
        ownerType: "individual" | "company";
        evidenceRef: string;
        note: string;
      },
    ) {
      const ids: string[] = [];
      await db.tx(async (t) => {
        await R.propertyRow(t, s.orgId, b.propertyId, true);
        await d.core.contacts.live(t, s.orgId, b.ownerId, true);
        const selected = b.unitIds ? [...new Set(b.unitIds)] : [null];
        for (const unitId of selected) {
          if (unitId) {
            const u = await R.unitRow(t, s.orgId, unitId);
            if (u.property_id !== b.propertyId) throw fail.invalid("The selected unit is not in this property");
          }
          const id = newId("pow");
          await t.run(
            `INSERT INTO pm_ownerships(id,org_id,property_id,unit_id,owner_id,owner_type,evidence_ref,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [id, s.orgId, b.propertyId, unitId, b.ownerId, b.ownerType, b.evidenceRef, b.note, s.userId],
          );
          ids.push(id);
        }
        await d.core.contacts.addTypes(t, s.orgId, b.ownerId, ["owner"]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Ownership recorded pending verification",
          target: b.propertyId,
          after: { ...b, ownershipIds: ids },
        });
      });
      return { ownerships: await Promise.all(ids.map((id) => one(s.orgId, id))) };
    },
    async verify(s: OrgScope, id: string) {
      requireAuthorityReviewer(s);
      await db.tx(async (t) => {
        const r = await t.row<OwnershipRow>("SELECT * FROM pm_ownerships WHERE org_id=$1 AND id=$2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!r) throw fail.notFound("Ownership record not found");
        if (r.status === "revoked") throw fail.conflict("This ownership record has been revoked");
        await d.core.contacts.live(t, s.orgId, r.owner_id);
        if (r.evidence_ref.trim().length < 3)
          throw fail.invalid("Record the ownership document or evidence reference before verifying ownership");
        await t.run(
          "UPDATE pm_ownerships SET status='verified',verified_by=$3,verified_at=now() WHERE org_id=$1 AND id=$2",
          [s.orgId, id, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Ownership evidence verified",
          target: id,
          detail: r.evidence_ref,
        });
      });
      return one(s.orgId, id);
    },
    async update(s: OrgScope, id: string, b: { ownerId: string; evidenceRef: string; note: string }) {
      await db.tx(async (t) => {
        const r = await t.row<OwnershipRow>("SELECT * FROM pm_ownerships WHERE org_id=$1 AND id=$2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!r || r.status === "revoked") throw fail.notFound("Ownership record not found");
        await d.core.contacts.live(t, s.orgId, b.ownerId, true);
        await d.core.contacts.addTypes(t, s.orgId, b.ownerId, ["owner"]);
        await t.run(
          "UPDATE pm_ownerships SET owner_id=$3,evidence_ref=$4,note=$5,status='pending',verified_by=NULL,verified_at=NULL WHERE org_id=$1 AND id=$2",
          [s.orgId, id, b.ownerId, b.evidenceRef, b.note],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Ownership corrected; verification required again",
          target: id,
          before: { ownerId: r.owner_id, evidenceRef: r.evidence_ref },
          after: b,
        });
      });
      return one(s.orgId, id);
    },
  };
}
