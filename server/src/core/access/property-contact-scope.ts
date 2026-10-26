import type { Db } from "../../db/database.js";
/** Fixed internal aliases/placeholders only. All historical relationships must fit the manager's scope. */
export function contactScopeSql(alias: string, properties: string, user: string) {
  return `(${properties}::text[] IS NULL OR (NOT EXISTS(SELECT 1 FROM (SELECT property_id FROM pm_leases WHERE org_id=${alias}.org_id AND tenant_id=${alias}.id UNION SELECT l.property_id FROM pm_lease_people lp JOIN pm_leases l ON l.org_id=lp.org_id AND l.id=lp.lease_id WHERE lp.org_id=${alias}.org_id AND lp.contact_id=${alias}.id UNION SELECT property_id FROM pm_ownerships WHERE org_id=${alias}.org_id AND owner_id=${alias}.id) related WHERE NOT(related.property_id=ANY(${properties}))) AND (EXISTS(SELECT 1 FROM pm_leases WHERE org_id=${alias}.org_id AND tenant_id=${alias}.id) OR EXISTS(SELECT 1 FROM pm_ownerships WHERE org_id=${alias}.org_id AND owner_id=${alias}.id) OR EXISTS(SELECT 1 FROM pm_lease_people WHERE org_id=${alias}.org_id AND contact_id=${alias}.id) OR ${alias}.created_by=${user})))`;
}
export async function contactWithinScope(
  db: Db,
  orgId: string,
  id: string,
  propertyIds: readonly string[],
  userId: string,
) {
  return !!(await db.row(
    `SELECT 1 FROM contacts c WHERE c.org_id=$1 AND c.id=$2 AND ${contactScopeSql("c", "$3", "$4")}`,
    [orgId, id, propertyIds, userId],
  ));
}
