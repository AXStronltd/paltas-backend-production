import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

/** Conservative cash-out guard while a received provider payment is not bank-reconciled.
 * Owner liabilities remain visible in statements; they are not misrepresented as bank cash available for release.
 */
export async function requireSettledProviderFunds(
  t: Db,
  orgId: string,
  subject: { ownerId?: string | null; tenantId?: string | null },
) {
  const r = await t.row(
    `SELECT a.id FROM rent_collection_attempts a WHERE a.org_id=$1 AND a.payment_id IS NOT NULL
  AND a.clearing_state NOT IN ('bank_reconciled','reversed')
  AND (($2::text IS NOT NULL AND a.tenant_id=$2) OR ($3::text IS NOT NULL AND EXISTS(
    SELECT 1 FROM pm_allocations p JOIN pm_invoices i ON i.id=p.invoice_id
    WHERE p.payment_id=a.payment_id AND p.org_id=$1 AND i.org_id=$1 AND i.owner_id=$3))) LIMIT 1`,
    [orgId, subject.tenantId ?? null, subject.ownerId ?? null],
  );
  if (r)
    throw fail.conflict(
      "Provider funds are not bank-reconciled yet. Complete settlement and reconciliation before releasing owner money, paying an owner bill or refunding a deposit.",
    );
}
