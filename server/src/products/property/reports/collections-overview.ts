import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

/** Read-only snapshot. Asset-filtered receipts include direct allocations only, never a tenant's unrelated cash. */
export async function collectionsOverview(db: Db, s: OrgScope, q: P.CollectionsQuery): Promise<P.CollectionsOverview> {
  if (q.to > s.today) throw fail.invalid("Receipt end date cannot be in the future");
  if (s.propertyIds && (!q.propertyId || !s.propertyIds.includes(q.propertyId)))
    throw fail.forbidden("Choose an assigned property for this report");
  for (const [id, table] of [
    [q.propertyId, "pm_properties"],
    [q.buildingId, "pm_buildings"],
    [q.unitId, "pm_units"],
    [q.ownerId, "contacts"],
    [q.tenantId, "contacts"],
  ] as const) {
    if (id && !(await db.row(`SELECT id FROM ${table} WHERE org_id=$1 AND id=$2`, [s.orgId, id])))
      throw fail.notFound("Report filter record not found in this organisation");
  }
  const scopedAllocations = !!(q.propertyId || q.buildingId || q.unitId || q.ownerId);
  const args = [
    s.orgId,
    q.from,
    q.to,
    q.propertyId ?? null,
    q.buildingId ?? null,
    q.unitId ?? null,
    q.ownerId ?? null,
    q.tenantId ?? null,
  ];
  const invoices = `SELECT i.* FROM pm_invoices i
    LEFT JOIN pm_units u ON u.id=i.unit_id AND u.org_id=i.org_id
    WHERE i.org_id=$1 AND $2::date <= $3::date AND ($4::text IS NULL OR i.property_id=$4)
    AND ($5::text IS NULL OR u.building_id=$5) AND ($6::text IS NULL OR i.unit_id=$6)
    AND ($7::text IS NULL OR i.owner_id=$7) AND ($8::text IS NULL OR i.tenant_id=$8)`;
  const cash = `WITH selected AS (${invoices}), cash AS (
    SELECT p.id, p.receipt_number AS "receiptNumber", p.tenant_id AS "tenantId", c.name AS "tenantName",
      p.date::text AS date,p.method,p.reference,
      ${
        scopedAllocations
          ? `(SELECT COALESCE(sum(a.amount_minor),0) FROM pm_effective_allocations a
        JOIN selected i ON i.id=a.invoice_id WHERE a.org_id=$1 AND a.payment_id=p.id)`
          : "p.amount_minor"
      }::bigint AS "amountMinor",
      EXISTS(SELECT 1 FROM pm_bank_lines b WHERE b.org_id=$1 AND b.matched_kind='payment'
        AND b.matched_id=p.id AND b.status='matched') OR EXISTS(SELECT 1 FROM pm_kulmipay_requests k JOIN pm_kulmipay_settlements s ON s.org_id=k.org_id AND s.id=k.settlement_id WHERE k.org_id=$1 AND k.ledger_payment_id=p.id AND s.status='approved') AS "bankMatched"
    FROM pm_effective_payments p JOIN contacts c ON c.id=p.tenant_id AND c.org_id=p.org_id
    WHERE p.org_id=$1 AND p.date BETWEEN $2::date AND $3::date AND ($8::text IS NULL OR p.tenant_id=$8)
  ), visible AS (SELECT * FROM cash WHERE "amountMinor">0)`;
  return db.tx(async (t) => {
    await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const totals = await t.row<{
      receiptsMinor: number;
      bankMatchedMinor: number;
      unmatchedMinor: number;
      total: number;
    }>(
      `${cash} SELECT COALESCE(sum("amountMinor"),0)::bigint AS "receiptsMinor",
      COALESCE(sum("amountMinor") FILTER(WHERE "bankMatched"),0)::bigint AS "bankMatchedMinor",
      COALESCE(sum("amountMinor") FILTER(WHERE NOT "bankMatched"),0)::bigint AS "unmatchedMinor",
      count(*)::int AS total FROM visible`,
      args,
    );
    const rows = await t.rows<P.CollectionsOverview["rows"][number]>(
      `${cash} SELECT * FROM visible ORDER BY date DESC,"receiptNumber" DESC,id DESC LIMIT $9 OFFSET $10`,
      [...args, q.limit, q.offset],
    );
    const balances = await t.row<{
      billedMinor: number;
      outstandingMinor: number;
      overdueMinor: number;
      dueTodayMinor: number;
      cohortAllocatedMinor: number;
      cohortCreditedMinor: number;
    }>(
      `WITH selected AS (${invoices}), balances AS (
        SELECT i.*, greatest(0,i.amount_minor-COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a
          WHERE a.org_id=$1 AND a.invoice_id=i.id),0)) AS balance,
          COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=$1 AND a.invoice_id=i.id AND a.source<>'credit_note'),0) AS paid,
          COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=$1 AND a.invoice_id=i.id AND a.source='credit_note'),0) AS credited
          FROM selected i WHERE i.issue_date<=$9::date)
      SELECT COALESCE(sum(paid) FILTER(WHERE issue_date BETWEEN $2::date AND $3::date),0)::bigint AS "cohortAllocatedMinor",
      COALESCE(sum(credited) FILTER(WHERE issue_date BETWEEN $2::date AND $3::date),0)::bigint AS "cohortCreditedMinor",
      COALESCE(sum(amount_minor) FILTER(WHERE issue_date BETWEEN $2::date AND $3::date),0)::bigint AS "billedMinor",
      COALESCE(sum(balance),0)::bigint AS "outstandingMinor",
      COALESCE(sum(balance) FILTER(WHERE due_date<$9::date),0)::bigint AS "overdueMinor",
      COALESCE(sum(balance) FILTER(WHERE due_date=$9::date),0)::bigint AS "dueTodayMinor" FROM balances`,
      [...args, s.today],
    );
    const tenants = await t.row<{ paid: number; partial: number; credited: number; unpaid: number }>(
      `WITH selected AS (${invoices}), people AS (
        SELECT tenant_id,sum(amount_minor) AS billed,
          sum(COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=$1 AND a.invoice_id=i.id),0)) AS settled,
          sum(COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=$1 AND a.invoice_id=i.id AND a.source<>'credit_note'),0)) AS cash
        FROM selected i WHERE issue_date BETWEEN $2::date AND $3::date GROUP BY tenant_id)
      SELECT count(*) FILTER(WHERE cash>=billed)::int AS paid,
        count(*) FILTER(WHERE settled>0 AND settled<billed)::int AS partial,
        count(*) FILTER(WHERE settled>=billed AND cash<billed)::int AS credited,
        count(*) FILTER(WHERE settled=0 AND billed>0)::int AS unpaid FROM people`,
      args,
    );
    const invoiceWhere =
      q.invoiceStatus === "billed"
        ? "issue_date BETWEEN $2::date AND $3::date"
        : q.invoiceStatus === "overdue"
          ? "balance>0 AND due_date<$9::date"
          : q.invoiceStatus === "due_today"
            ? "balance>0 AND due_date=$9::date"
            : "balance>0";
    const invoiceList = await t.row<{ invoiceTotal: number; invoices: P.CollectionsOverview["invoices"] }>(
      `WITH selected AS (${invoices}), balances AS (
        SELECT i.*,greatest(0,i.amount_minor-COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a
          WHERE a.org_id=$1 AND a.invoice_id=i.id),0)) AS balance FROM selected i WHERE issue_date<=$9::date),
      visible AS (SELECT * FROM balances WHERE ${invoiceWhere})
      SELECT (SELECT count(*)::int FROM visible) AS "invoiceTotal",
      COALESCE((SELECT json_agg(x) FROM (SELECT v.id,v.number,c.name AS "tenantName",u.unit_no AS "unitNo",
        v.due_date::text AS "dueDate",v.amount_minor AS "amountMinor",v.balance AS "balanceMinor"
        FROM visible v JOIN contacts c ON c.id=v.tenant_id AND c.org_id=v.org_id
        LEFT JOIN pm_units u ON u.id=v.unit_id AND u.org_id=v.org_id
        ORDER BY v.due_date,v.id LIMIT $10 OFFSET $11) x),'[]'::json) AS invoices`,
      [...args, s.today, q.limit, q.invoiceOffset],
    );
    if (!totals || !balances || !tenants || !invoiceList)
      throw fail.conflict("The collections snapshot could not be read; try again");
    return {
      asOf: s.today,
      currency: s.entitlement.org.currency,
      from: q.from,
      to: q.to,
      scopedAllocations,
      ...totals,
      ...invoiceList,
      ...balances,
      collectionRatePct:
        balances.billedMinor > balances.cohortCreditedMinor
          ? Math.round(
              (10000 * balances.cohortAllocatedMinor) / (balances.billedMinor - balances.cohortCreditedMinor),
            ) / 100
          : null,
      tenants: tenants,
      rows,
    };
  });
}
