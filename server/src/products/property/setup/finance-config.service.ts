import { listAudit } from "../../../core/audit/audit.service.js";
import { auditExport } from "../../../core/audit/integrity.js";
import type { property as P, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { calculateQuote } from "../../../core/billing/pricing.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import * as R from "../shared/records.js";

type Category = z.infer<typeof P.CustomExpenseCategory>;
type CategoryInput = z.infer<typeof P.ExpenseCategoryInput>;
export interface TariffRow {
  id: string;
  org_id: string;
  charge_type_id: string;
  unit_id: string | null;
  effective_period: string;
  tiers: z.infer<typeof P.UtilityTariffInput>["tiers"];
  fixed_minor: number;
  meter_serial: string;
  reason: string;
  created_at: string;
}
const tariffView = (r: TariffRow) => ({
  id: r.id,
  chargeTypeId: r.charge_type_id,
  unitId: r.unit_id,
  effectivePeriod: r.effective_period,
  tiers: r.tiers,
  fixedMinor: r.fixed_minor,
  meterSerial: r.meter_serial,
  reason: r.reason,
  createdAt: r.created_at,
});
const CATEGORY_SQL =
  'SELECT id,name,base_category AS "baseCategory",tax_code AS "taxCode",active,version FROM pm_expense_categories';
function globalSettings(s: OrgScope) {
  if (s.propertyIds != null)
    throw fail.forbidden("Organisation-wide configuration requires organisation-wide authority.");
}
export async function billCategory(t: Db, orgId: string, id: string | null | undefined, existingId?: string | null) {
  if (!id) return null;
  const row = await t.row<Category>(`${CATEGORY_SQL} WHERE org_id=$1 AND id=$2 FOR SHARE`, [orgId, id]);
  if (!row) throw fail.notFound("Expense category not found");
  if (!row.active && row.id !== existingId)
    throw fail.conflict("This expense category is inactive. Choose an active category.");
  return row;
}
export function quoteTariff(r: TariffRow, previous: string, current: string, consumption: number, currency: string) {
  const quote = calculateQuote({
    currency,
    lines: [
      {
        categoryId: r.charge_type_id,
        categoryVersion: 1,
        description: "Metered consumption",
        classification: "customer_service",
        currency,
        pricing: { kind: "tiered", quantity: String(consumption), tiers: r.tiers },
        tax: { mode: "exclusive", components: [] },
      },
      {
        categoryId: r.charge_type_id,
        categoryVersion: 1,
        description: "Fixed surcharge",
        classification: "customer_service",
        currency,
        pricing: { kind: "fixed", amountMinor: r.fixed_minor },
        tax: { mode: "exclusive", components: [] },
      },
    ],
  });
  const variable = quote.lines[0];
  if (!variable) throw new Error("Missing tariff calculation");
  return {
    amountMinor: quote.totalMinor,
    snapshot: {
      currency,
      tariffId: r.id,
      effectivePeriod: r.effective_period,
      previous,
      current,
      consumption,
      tiers: r.tiers,
      fixedMinor: r.fixed_minor,
      meterSerial: r.meter_serial,
      variableMinor: variable.totalMinor,
      calculationVersion: quote.calculationVersion,
    },
  };
}
export function financeConfigService(d: PmDeps) {
  const db = d.core.db;
  return {
    async exportAudit(s: OrgScope) {
      globalSettings(s);
      const entries = (await listAudit(db, { orgId: s.orgId, limit: 1000 })).reverse();
      const result = auditExport(s.orgId, entries);
      return {
        export: result as unknown as Record<string, unknown>,
        fingerprint: result.root,
        coverage:
          "Latest 1000 entries at most; this is an export integrity check, not a complete ledger or independently anchored database history.",
      };
    },
    async tariffs(s: OrgScope, chargeTypeId: string) {
      if (!(await db.row("SELECT id FROM pm_charge_types WHERE org_id=$1 AND id=$2", [s.orgId, chargeTypeId])))
        throw fail.notFound("Charge type not found");
      const rows = await db.rows<TariffRow>(
        `SELECT t.* FROM pm_utility_tariffs t LEFT JOIN pm_units u ON u.id=t.unit_id
    WHERE t.org_id=$1 AND t.charge_type_id=$2 AND ($3::text[] IS NULL OR t.unit_id IS NULL OR u.property_id=ANY($3)) ORDER BY effective_period DESC,created_at DESC`,
        [s.orgId, chargeTypeId, s.propertyIds ?? null],
      );
      return { tariffs: rows.map(tariffView) };
    },
    async createTariff(s: OrgScope, chargeTypeId: string, b: z.infer<typeof P.UtilityTariffInput>) {
      return financeTransaction(db, s.orgId, async (t) => {
        const ct = await t.row<{ metered: boolean }>(
          "SELECT metered FROM pm_charge_types WHERE org_id=$1 AND id=$2 FOR SHARE",
          [s.orgId, chargeTypeId],
        );
        if (!ct) throw fail.notFound("Charge type not found");
        if (!ct.metered) throw fail.invalid("Tiered tariffs are only available for metered services.");
        if (b.unitId) {
          const u = await R.unitRow(t, s.orgId, b.unitId);
          if (s.propertyIds != null && !s.propertyIds.includes(u.property_id)) throw fail.notFound("Unit not found");
        } else globalSettings(s);
        if (!b.unitId && b.meterSerial)
          throw fail.invalid("Assign a meter serial to a specific unit, not a shared tariff.");
        const row: TariffRow = {
          id: newId("ptr"),
          org_id: s.orgId,
          charge_type_id: chargeTypeId,
          unit_id: b.unitId,
          effective_period: b.effectivePeriod,
          tiers: b.tiers,
          fixed_minor: b.fixedMinor,
          meter_serial: b.meterSerial,
          reason: b.reason,
          created_at: "",
        };
        try {
          quoteTariff(row, "0", "0", 0, s.entitlement.org.currency);
        } catch (e) {
          throw fail.invalid(e instanceof Error ? e.message : "Invalid tariff");
        }
        const billed = await t.row(
          `SELECT 1 FROM pm_invoices i JOIN pm_leases l ON l.id=i.lease_id JOIN pm_lease_charges lc ON lc.lease_id=l.id
     WHERE i.org_id=$1 AND i.kind='charge' AND i.recurring AND lc.charge_type_id=$2 AND i.period >= $3 AND ($4::text IS NULL OR l.unit_id=$4) LIMIT 1`,
          [s.orgId, chargeTypeId, b.effectivePeriod, b.unitId],
        );
        if (billed)
          throw fail.conflict(
            "A charge invoice already exists in or after this period. Choose a later period; issued invoices cannot be repriced.",
          );
        await t.run(
          `INSERT INTO pm_utility_tariffs(id,org_id,charge_type_id,unit_id,effective_period,tiers,fixed_minor,meter_serial,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.id,
            s.orgId,
            chargeTypeId,
            b.unitId,
            b.effectivePeriod,
            JSON.stringify(b.tiers),
            b.fixedMinor,
            b.meterSerial,
            b.reason,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Utility tariff scheduled",
          target: row.id,
          after: b,
          detail: b.reason,
        });
        const saved = await t.row<TariffRow>("SELECT * FROM pm_utility_tariffs WHERE id=$1", [row.id]);
        if (!saved) throw new Error("Saved tariff unavailable");
        return tariffView(saved);
      });
    },
    async categories(s: OrgScope) {
      return { categories: await db.rows<Category>(`${CATEGORY_SQL} WHERE org_id=$1 ORDER BY lower(name)`, [s.orgId]) };
    },
    async saveCategory(
      s: OrgScope,
      id: string | null,
      b: CategoryInput & { expectedVersion?: number; reason?: string },
    ) {
      globalSettings(s);
      return financeTransaction(db, s.orgId, async (t) => {
        const before = id
          ? await t.row<Category>(`${CATEGORY_SQL} WHERE org_id=$1 AND id=$2 FOR UPDATE`, [s.orgId, id])
          : undefined;
        if (id && !before) throw fail.notFound("Expense category not found");
        if (before && before.version !== b.expectedVersion)
          throw fail.conflict("Category changed. Reopen it before saving.");
        const categoryId = id ?? newId("pec");
        if (before)
          await t.run(
            "UPDATE pm_expense_categories SET name=$3,base_category=$4,tax_code=$5,active=$6,version=version+1 WHERE org_id=$1 AND id=$2",
            [s.orgId, categoryId, b.name, b.baseCategory, b.taxCode, b.active],
          );
        else
          await t.run(
            "INSERT INTO pm_expense_categories(id,org_id,name,base_category,tax_code,active) VALUES($1,$2,$3,$4,$5,$6)",
            [categoryId, s.orgId, b.name, b.baseCategory, b.taxCode, b.active],
          );
        const after = await t.row<Category>(`${CATEGORY_SQL} WHERE org_id=$1 AND id=$2`, [s.orgId, categoryId]);
        if (!after) throw new Error("Saved category unavailable");
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: before ? "Expense category changed" : "Expense category created",
          target: categoryId,
          before,
          after,
          detail: b.reason ?? "Reusable category; no financial posting",
        });
        return after;
      });
    },
  };
}
