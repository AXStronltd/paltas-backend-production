/*
 * The organisation's Development rules: settings (reservation days, match tolerance, bank-change hold, offer
 * approval levels), approval limits per role and kind, and the cost codes. Approval checks live here so every
 * approval (requisition, order, budget change, invoice, payment run) applies the same three rules:
 *   1. the role may approve spend at all (developer.approve);
 *   2. never the person who prepared it (separation of duties);
 *   3. the amount is within the role's limit for that kind — the chief executive (developer.executive) has none.
 */
import type { development, Role, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { ensureAccounts } from "../../../core/ledger/default-chart.js";
import type { Db } from "../../../db/database.js";
import { fail, type ApiError } from "../../../http/errors.js";
import { DEFAULT_COST_CODES, DEV_ACCOUNTS } from "../accounts.js";
import { can } from "./access.js";

export interface SettingsRow {
  reservation_days: number;
  price_tolerance_bp: number;
  bank_hold_hours: number;
  manager_discount_bp: number;
  executive_discount_bp: number;
  min_deposit_bp: number;
  manager_max_months: number;
  executive_max_months: number;
}

/** The settings row (created with the defaults the first time) and the starting cost codes. */
export async function ensureDefaults(t: Db, orgId: string): Promise<void> {
  await t.run("INSERT INTO dev_settings (org_id) VALUES ($1) ON CONFLICT DO NOTHING", [orgId]);
  const has = await t.row("SELECT 1 FROM dev_cost_codes WHERE org_id = $1 LIMIT 1", [orgId]);
  if (has) return;
  await ensureAccounts(t, orgId, DEV_ACCOUNTS);
  for (const c of DEFAULT_COST_CODES)
    await t.run(
      "INSERT INTO dev_cost_codes (org_id, code, name, account_code) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [orgId, c.code, c.name, c.account],
    );
}

export async function settingsRow(db: Db, orgId: string): Promise<SettingsRow> {
  const r = await db.row<SettingsRow>("SELECT * FROM dev_settings WHERE org_id = $1", [orgId]);
  if (r) return r;
  // never written yet: the column defaults
  return {
    reservation_days: 14,
    price_tolerance_bp: 200,
    bank_hold_hours: 48,
    manager_discount_bp: 200,
    executive_discount_bp: 500,
    min_deposit_bp: 1000,
    manager_max_months: 12,
    executive_max_months: 18,
  };
}

export async function settingsOut(db: Db, orgId: string): Promise<z.input<typeof development.Settings>> {
  const s = await settingsRow(db, orgId);
  const limits = await db.rows<{
    kind: (typeof development.APPROVAL_KINDS)[number];
    role: Role;
    limit_minor: number | null;
  }>("SELECT kind, role, limit_minor FROM dev_approval_limits WHERE org_id = $1 ORDER BY kind, role", [orgId]);
  const codes = await db.rows<{ code: string; name: string; account_code: string; active: boolean }>(
    "SELECT * FROM dev_cost_codes WHERE org_id = $1 ORDER BY code",
    [orgId],
  );
  return {
    reservationDays: s.reservation_days,
    priceToleranceBp: s.price_tolerance_bp,
    bankHoldHours: s.bank_hold_hours,
    offerRules: {
      managerDiscountBp: s.manager_discount_bp,
      executiveDiscountBp: s.executive_discount_bp,
      minDepositBp: s.min_deposit_bp,
      managerMaxMonths: s.manager_max_months,
      executiveMaxMonths: s.executive_max_months,
    },
    limits: limits.map((l) => ({ kind: l.kind, role: l.role, limitMinor: l.limit_minor })),
    costCodes: codes.map((c) => ({ code: c.code, name: c.name, account: c.account_code, active: c.active })),
  };
}

export interface CostCodeRow {
  code: string;
  name: string;
  account_code: string;
  active: boolean;
}

/** An active cost code of this organisation (400 otherwise). */
export async function costCode(db: Db, orgId: string, code: string): Promise<CostCodeRow> {
  const c = await db.row<CostCodeRow>("SELECT * FROM dev_cost_codes WHERE org_id = $1 AND code = $2", [orgId, code]);
  if (!c || !c.active) throw fail.invalid(`Unknown or inactive cost code ${code}`);
  return c;
}

export type ApprovalKind = (typeof development.APPROVAL_KINDS)[number];

const KIND_LABEL: Record<ApprovalKind, string> = {
  requisition: "requisitions",
  purchase_order: "purchase orders",
  invoice: "supplier invoices",
  budget_change: "budget changes",
  payment_run: "payment runs",
};

/** Why this person may not approve this (null = they may). */
export async function approvalBlock(
  db: Db,
  s: OrgScope,
  kind: ApprovalKind,
  amountMinor: number,
  preparedBy: string | null,
): Promise<ApiError | null> {
  if (!can(s, "developer.approve")) return fail.roleNotAllowed(`Your role cannot approve ${KIND_LABEL[kind]}`);
  if (preparedBy && preparedBy === s.userId)
    return fail.separationOfDuties("You prepared this — someone else must approve it");
  if (can(s, "developer.executive")) return null;
  const r = await db.row<{ limit_minor: number | null }>(
    "SELECT limit_minor FROM dev_approval_limits WHERE org_id = $1 AND kind = $2 AND role = $3",
    [s.orgId, kind, s.role],
  );
  if (!r) return fail.forbidden(`Your role has no approval limit for ${KIND_LABEL[kind]}`, { kind });
  if (r.limit_minor !== null && amountMinor > r.limit_minor)
    return fail.forbidden(`Above your approval limit for ${KIND_LABEL[kind]}`, {
      kind,
      limitMinor: r.limit_minor,
      amountMinor,
    });
  return null;
}

export async function requireApproval(
  db: Db,
  s: OrgScope,
  kind: ApprovalKind,
  amountMinor: number,
  preparedBy: string | null,
): Promise<void> {
  const block = await approvalBlock(db, s, kind, amountMinor, preparedBy);
  if (block) throw block;
}
