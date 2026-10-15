/*
 * The ledger accounts a Development organisation needs (added to its chart when it subscribes, and before every
 * posting for organisations that subscribed earlier). The migration's own accounts (1170, 2400, 3900) are the same
 * accounts the day-to-day product posts to. Core accounts used as well: 1000 operating bank (supplier payments),
 * 2000 accounts payable.
 */
import type { AccountSeed } from "../../core/ledger/default-chart.js";
import { developmentMigration } from "./migration-domain.js";

export const DEV_ACCOUNTS: AccountSeed[] = [
  ...developmentMigration.accounts.map(({ code, name, type, system }) => ({ code, name, type, system })),
  { code: "1010", name: "Bank — buyer collections", type: "asset", system: true },
  { code: "1200", name: "VAT recoverable on purchases", type: "asset", system: true },
  { code: "1510", name: "Development WIP — land and acquisition", type: "asset", system: true },
  { code: "1520", name: "Development WIP — professional fees and permits", type: "asset", system: true },
  { code: "1530", name: "Development WIP — construction", type: "asset", system: true },
  { code: "2050", name: "Retention payable", type: "liability", system: true },
  { code: "2200", name: "Withholding tax payable", type: "liability", system: true },
  { code: "4600", name: "Unit sales revenue", type: "income", system: true },
  { code: "5700", name: "Cost of units sold", type: "expense", system: true },
  { code: "6100", name: "Selling and marketing", type: "expense", system: false },
];

export const ACC = {
  bank: "1000",
  collections: "1010",
  receivables: "1170",
  vatInput: "1200",
  payables: "2000",
  retention: "2050",
  wht: "2200",
  deposits: "2400",
  openingEquity: "3900",
  revenue: "4600",
  costOfSales: "5700",
} as const;

/**
 * The cost breakdown structure a new organisation starts with (renamed, extended or re-mapped in settings).
 * Contingency is never invoiced directly: it funds transfers and change orders.
 */
export const DEFAULT_COST_CODES: { code: string; name: string; account: string }[] = [
  { code: "01", name: "Land and acquisition", account: "1510" },
  { code: "02", name: "Design and professional fees", account: "1520" },
  { code: "03", name: "Permits and statutory", account: "1520" },
  { code: "04", name: "Site preparation and infrastructure", account: "1530" },
  { code: "05", name: "Substructure", account: "1530" },
  { code: "06", name: "Superstructure", account: "1530" },
  { code: "07", name: "Finishes", account: "1530" },
  { code: "08", name: "MEP services", account: "1530" },
  { code: "09", name: "External works", account: "1530" },
  { code: "10", name: "Preliminaries and site facilities", account: "1530" },
  { code: "11", name: "Sales and marketing", account: "6100" },
  { code: "12", name: "Finance costs (capitalised while building)", account: "1530" },
  { code: "13", name: "Contingency", account: "1530" },
];
