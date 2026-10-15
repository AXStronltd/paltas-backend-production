/*
 * The ledger accounts a security organisation needs, added to its chart when it subscribes (ProductModule.accounts).
 * Core accounts used as well: 1000 operating bank (payments RECORDED as received or paid outside PALTAS),
 * 1100 accounts receivable (client invoices), 2000 accounts payable, 2100 VAT payable.
 */
import type { AccountSeed } from "../../core/ledger/default-chart.js";

export const SECURITY_ACCOUNTS: AccountSeed[] = [
  { code: "1810", name: "Withholding tax credits (client certificates)", type: "asset", system: true },
  { code: "1820", name: "VAT withheld by clients (certificates)", type: "asset", system: true },
  { code: "2810", name: "Income tax on wages payable", type: "liability", system: true },
  { code: "2820", name: "Statutory deductions and contributions payable", type: "liability", system: true },
  { code: "2830", name: "Net wages payable", type: "liability", system: true },
  { code: "4810", name: "Guarding contract revenue", type: "income", system: true },
  { code: "4820", name: "Extra cover revenue (billed hours)", type: "income", system: true },
  { code: "4830", name: "Late payment charges", type: "income", system: true },
  { code: "4840", name: "Other security services revenue", type: "income", system: true },
  { code: "5810", name: "Guard wages", type: "expense", system: true },
  { code: "5820", name: "Employer statutory contributions", type: "expense", system: true },
  { code: "5830", name: "Uniforms and kit", type: "expense", system: true },
  { code: "5840", name: "Training and licences", type: "expense", system: true },
  { code: "5850", name: "Vehicles and fuel", type: "expense", system: true },
  { code: "5860", name: "Communications", type: "expense", system: true },
  { code: "5870", name: "Bank and mobile-money charges", type: "expense", system: true },
];

export const ACC = {
  bank: "1000",
  receivables: "1100",
  payables: "2000",
  vat: "2100",
  whtCredits: "1810",
  vatWithheld: "1820",
  incomeTax: "2810",
  statutory: "2820",
  netWages: "2830",
  contractRevenue: "4810",
  extraRevenue: "4820",
  lateFees: "4830",
  otherRevenue: "4840",
  wages: "5810",
  employer: "5820",
} as const;

/** Income account per invoice line kind. */
export const REVENUE_ACCOUNT = {
  contract: ACC.contractRevenue,
  extra_hours: ACC.extraRevenue,
  late_fee: ACC.lateFees,
  other: ACC.otherRevenue,
} as const;
