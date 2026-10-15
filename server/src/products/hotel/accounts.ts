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
  // extensions (migration 0011 adds them to hotel organisations that subscribed earlier)
  { code: "1020", name: "FF&E replacement reserve fund", type: "asset", system: true },
  { code: "1300", name: "Inventory — food, beverage, linen and amenities", type: "asset", system: true },
  { code: "1500", name: "Fixed assets — furniture, fixtures and equipment", type: "asset", system: true },
  { code: "1590", name: "Accumulated depreciation", type: "asset", system: true },
  { code: "2010", name: "Goods received not invoiced", type: "liability", system: true },
  { code: "2130", name: "Tips payable to staff", type: "liability", system: true },
  { code: "2200", name: "Wages payable", type: "liability", system: true },
  { code: "2400", name: "Loyalty points liability", type: "liability", system: true },
  { code: "4900", name: "Gain on disposal of assets", type: "income", system: true },
  { code: "5150", name: "Rooms payroll", type: "expense", system: true },
  { code: "5250", name: "Food and beverage payroll", type: "expense", system: true },
  { code: "5350", name: "Spa and activities payroll", type: "expense", system: true },
  { code: "5450", name: "Other departments payroll", type: "expense", system: true },
  { code: "5700", name: "Loyalty programme cost", type: "expense", system: true },
  { code: "5950", name: "Administrative and general payroll", type: "expense", system: true },
  { code: "6100", name: "Depreciation", type: "expense", system: true },
  { code: "6150", name: "Loss on disposal of assets", type: "expense", system: true },
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
  receivables: "1100",
  bankCharges: "5300",
  ffeReserve: "1020",
  inventory: "1300",
  fixedAssets: "1500",
  accumulatedDepreciation: "1590",
  grni: "2010",
  tips: "2130",
  wages: "2200",
  loyalty: "2400",
  disposalGain: "4900",
  roomsCosts: "5100",
  fnbCostOfSales: "5200",
  loyaltyCost: "5700",
  depreciation: "6100",
  disposalLoss: "6150",
} as const;

/** Payroll expense per staff department (USALI: departmental payroll; admin is undistributed). */
export const PAYROLL_ACCOUNT: Record<hotel.StaffDepartment, string> = {
  rooms: "5150",
  fnb: "5250",
  spa: "5350",
  other: "5450",
  admin: "5950",
};

/** Where stock used up is expensed: food and beverage to cost of sales, the rest to rooms department costs. */
export const STOCK_EXPENSE_ACCOUNT: Record<hotel.StockCategory, string> = {
  food: "5200",
  beverage: "5200",
  linen: "5100",
  amenity: "5100",
  cleaning: "5100",
  other: "5100",
};

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
  rooms: { revenue: ["4100", "4500"], costs: ["5100", "5600", "5150"] },
  fnb: { revenue: ["4200"], costs: ["5200", "5250"] },
  spa: { revenue: ["4300"], costs: ["5350"] },
  other: { revenue: ["4400"], costs: ["5450"] },
  undistributed: { costs: ["5000", "5300", "5950", "5700"] },
};
