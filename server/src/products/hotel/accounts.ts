/*
 * The ledger accounts a hotel organisation needs, added to its chart when it subscribes (ProductModule.accounts),
 * and which account each kind of hotel money movement posts to. Core accounts used as well: 1000 operating bank
 * (payments RECORDED as received through the hotel's own provider or till), 2000 payables, 2100 VAT payable.
 */
import type { hotel } from "@paltas/contracts";
import type { AccountSeed } from "../../core/ledger/default-chart.js";

export const HOTEL_ACCOUNTS: AccountSeed[] = [
  { code: "1150", name: "Guest ledger (in-house balances)", type: "asset", system: true },
  { code: "1160", name: "City ledger (company accounts)", type: "asset", system: true },
  { code: "2110", name: "Tourism and city levies payable", type: "liability", system: true },
  { code: "2120", name: "Service charge payable", type: "liability", system: true },
  { code: "2350", name: "Guest advance deposits", type: "liability", system: true },
  { code: "4100", name: "Rooms revenue", type: "income", system: true },
  { code: "4200", name: "Food and beverage revenue", type: "income", system: true },
  { code: "4300", name: "Spa and activities revenue", type: "income", system: true },
  { code: "4400", name: "Other operated departments revenue", type: "income", system: true },
  { code: "4500", name: "No-show and cancellation revenue", type: "income", system: true },
  { code: "5100", name: "Rooms department costs", type: "expense", system: true },
  { code: "5200", name: "Food and beverage cost of sales", type: "expense", system: true },
  { code: "5600", name: "Channel commissions", type: "expense", system: true },
];

export const ACC = {
  bank: "1000",
  payables: "2000",
  vat: "2100",
  guestLedger: "1150",
  cityLedger: "1160",
  levy: "2110",
  serviceCharge: "2120",
  deposits: "2350",
  commissions: "5600",
} as const;

/** Income account per revenue department. */
export const REVENUE_ACCOUNT: Record<hotel.HotelDepartment, string> = {
  rooms: "4100",
  fnb: "4200",
  spa: "4300",
  other: "4400",
  noshow: "4500",
};

/** The default USALI-style mapping a new hotel starts with (changeable per hotel). */
export const DEFAULT_USALI: hotel.UsaliMapping = {
  rooms: { revenue: ["4100", "4500"], costs: ["5100", "5600"] },
  fnb: { revenue: ["4200"], costs: ["5200"] },
  spa: { revenue: ["4300"], costs: [] },
  other: { revenue: ["4400"], costs: [] },
  undistributed: { costs: ["5000", "5300"] },
};
