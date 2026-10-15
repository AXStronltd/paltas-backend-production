/*
 * The accounts every organisation starts with. Products add their own (e.g. Property Management adds the client
 * account and owner funds) through ProductModule.accounts when the organisation subscribes.
 * Codes follow the first-digit rule: 1 asset, 2 liability, 3 equity, 4 income, 5–9 expense.
 */
import type { AccountType } from "@paltas/contracts";
import type { Db } from "../../db/database.js";

export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  /** Used by automatic postings: can be renamed, never deactivated. */
  system: boolean;
}

export const CORE_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Operating bank account (company money)", type: "asset", system: true },
  { code: "1100", name: "Accounts receivable", type: "asset", system: true },
  { code: "2000", name: "Accounts payable (suppliers)", type: "liability", system: true },
  { code: "2100", name: "VAT payable", type: "liability", system: true },
  { code: "3000", name: "Company equity", type: "equity", system: true },
  { code: "3100", name: "Retained earnings", type: "equity", system: true },
  { code: "4000", name: "Revenue", type: "income", system: true },
  { code: "5000", name: "Operating expenses", type: "expense", system: false },
  { code: "5300", name: "Bank charges", type: "expense", system: false },
];

/** Add any missing accounts; existing accounts (and their names) are left as they are. */
export async function ensureAccounts(db: Db, orgId: string, seeds: AccountSeed[]): Promise<void> {
  for (const a of seeds) {
    await db.run(
      `INSERT INTO ledger_accounts (org_id, code, name, type, system) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, a.code, a.name, a.type, a.system],
    );
  }
}
