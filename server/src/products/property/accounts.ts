/*
 * The ledger accounts a Property Management organisation needs, added to its chart when it subscribes
 * (ProductModule.accounts), and which account each kind of PM money movement posts to. This is trust (client-money)
 * accounting as the workspace shows it on "Ledger and posting rules": rent belongs to the owner, so it is never
 * company revenue; deposits are a liability; only the management fee and agency charges are income.
 *
 *   Rent / owner charge invoiced     Dr 1120 Tenant receivables          Cr 2150 Owner rent billed, not collected
 *   Deposit invoiced                 Dr 1120                              Cr 2160 Deposits billed, not collected
 *   Agency charge invoiced           Dr 1120                              Cr 2170 Agency charges billed, not collected
 *   Payment recorded                 Dr 1040 Client account               Cr 1120 (allocated) / Cr 2310 (unallocated)
 *   Rent collected                   Dr 2150                              Cr 2250 Owner funds payable
 *   Management fee                   Dr 2250                              Cr 4650 Management fee income (+ Cr 2100 VAT)
 *   Agency charge collected          Dr 2170                              Cr 4660 Agency charges income (+ Cr 2100 VAT)
 *   Deposit collected                Dr 2160                              Cr 2300 Tenant deposits held
 *   Credit applied                   Dr 2310                              Cr 1120
 *   Deposit settled at move-out      Dr 2300 held  Cr 1120 arrears · Cr 2250 deductions (owner) · Cr 1040 refund
 *   Owner-recoverable bill approved  Dr 2250                              Cr 2000 Accounts payable
 *   Company bill approved            Dr 5650 Repairs absorbed by company  Cr 2000
 *   Bill paid                        Dr 2000                              Cr 1040 (owner cost) / 1000 (company cost)
 *   Owner payout released            Dr 2250                              Cr 1040
 *   Opening balances (migration)     Dr 1040 · Cr 2300 · Cr 2250 · Dr 1120 · Cr 2000, balanced by 3900
 *
 * Core accounts used as well: 1000 operating bank, 2000 payables, 2100 VAT payable.
 * The workspace shows 1010 / 1100 / 2200 / 2400 / 4000 / 4100 / 5200; here they are 1040 / 1120 / 2250 / 2310 / 4650 /
 * 4660 / 5650, because other products (Development, Hotel, Security) use those codes for other things in the same chart,
 * and "equal to the ledger" checks need accounts that only Property Management posts to.
 */
import type { AccountSeed } from "../../core/ledger/default-chart.js";

export const PM_ACCOUNTS: AccountSeed[] = [
  { code: "1040", name: "Client account (owners' and tenants' money)", type: "asset", system: true },
  { code: "1120", name: "Tenant receivables", type: "asset", system: true },
  { code: "2150", name: "Owner rent and charges billed, not yet collected", type: "liability", system: true },
  { code: "2160", name: "Deposits billed, not yet collected", type: "liability", system: true },
  { code: "2170", name: "Agency charges billed, not yet collected", type: "liability", system: true },
  { code: "2250", name: "Owner funds payable", type: "liability", system: true },
  { code: "2300", name: "Tenant deposits held", type: "liability", system: true },
  { code: "2310", name: "Tenant credits (unallocated payments)", type: "liability", system: true },
  { code: "3900", name: "Opening balance equity", type: "equity", system: true },
  { code: "4650", name: "Management fee income", type: "income", system: true },
  { code: "4660", name: "Agency charges income", type: "income", system: true },
  { code: "5650", name: "Repairs absorbed by the company", type: "expense", system: true },
];

export const ACC = {
  operatingBank: "1000",
  clientBank: "1040",
  receivables: "1120",
  payables: "2000",
  vat: "2100",
  ownerBilled: "2150",
  depositBilled: "2160",
  agencyBilled: "2170",
  ownerFunds: "2250",
  depositsHeld: "2300",
  tenantCredits: "2310",
  openingEquity: "3900",
  managementFees: "4650",
  agencyIncome: "4660",
  companyRepairs: "5650",
} as const;

/** Where an invoice line is credited when it is issued, by payee. */
export const BILLED_ACCOUNT = {
  owner: ACC.ownerBilled,
  agency: ACC.agencyBilled,
  deposit: ACC.depositBilled,
} as const;
