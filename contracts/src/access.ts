/*
 * Who may do what — the one permission table for the server and the front end.
 *
 * A person's ROLE is set per organisation (a membership). A role grants CAPABILITIES. The server checks capabilities
 * on every request; the front end may use the same table to hide controls, but hiding a control is never the check.
 * PALTAS staff (Super Admin) are separate: a client role can never grant staff access, and staff are never members.
 *
 * Product rounds add their own capabilities here (e.g. "pm.leases.manage") so the whole table stays in one place.
 */
import { z } from "zod";

export const PRODUCTS = ["property", "developer", "agency", "hotel", "security"] as const;
export const Product = z.enum(PRODUCTS);
export type Product = z.infer<typeof Product>;

/** Products a customer can subscribe to today. The others exist in the catalogue but are not sold yet. */
export const SELLABLE_PRODUCTS = ["property", "developer"] as const satisfies readonly Product[];

export const CAPABILITIES = [
  "org.read",
  "members.read",
  "members.manage",
  "subscription.read",
  "subscription.manage",
  /** Add a product or cancel a subscription: the organisation administrator only. */
  "subscription.own",
  "audit.read",
  "ledger.read",
  "ledger.prepare",
  "ledger.approve",
  "ledger.accounts.manage",
  "ledger.periods.close",
  /** Data migration: see jobs and reports; run the stages up to the import; approve, roll back and sign off. */
  "migration.read",
  "migration.run",
  "migration.approve",
  /** Hotel: see the hotel workspace (properties, rooms, reservations, folios). */
  "hotel.read",
  /** Hotel: properties, room types, rooms, channels, outlets, taxes, staff per property. */
  "hotel.setup",
  /** Hotel: rate plans, prices, seasons and restrictions. */
  "hotel.rates.manage",
  "hotel.reservations.manage",
  /** Hotel: pre-check-in, check-in, room moves, extensions, check-out, guest requests, keys, messages. */
  "hotel.frontdesk",
  /** Hotel: post charges, split / transfer / route folios, request voids and refunds. */
  "hotel.folio.manage",
  /** Hotel: approve voids and refunds made by someone else. */
  "hotel.folio.approve",
  /** Hotel: run your own cashier shift and record payments. */
  "hotel.cashier",
  "hotel.outlet.post",
  "hotel.housekeeping",
  /** Hotel: inspect rooms (releases them to the front desk) and assign attendants. */
  "hotel.housekeeping.inspect",
  "hotel.maintenance",
  "hotel.nightaudit.run",
  "hotel.incomeaudit.signoff",
  "hotel.reports.read",
  /** Hotel: company and travel-agent accounts, credit limits, city-ledger payments. */
  "hotel.cityledger",
  /** Hotel: post departmental costs to the ledger. */
  "hotel.costs.post",
  /** Hotel: group (chain) views across two or more hotels. */
  "hotel.group.read",
] as const;
export const Capability = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof Capability>;

export const ROLES = [
  "org_admin",
  "finance_director",
  "accountant",
  "property_manager",
  "leasing_agent",
  "front_desk",
  "technician",
  "sales_manager",
  "sales_agent",
  "project_manager",
  "operations_manager",
  "supervisor",
  "auditor",
  "viewer",
  "general_manager",
  "front_office_manager",
  "receptionist",
  "revenue_manager",
  "housekeeping_supervisor",
  "housekeeping_attendant",
  "outlet_staff",
  "financial_controller",
  "income_auditor",
  "credit_controller",
  "ap_clerk",
  "cost_controller",
  "payroll_officer",
  "group_owner",
] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export interface RoleDefinition {
  label: string;
  /** Products whose organisations may give this role. */
  products: readonly Product[];
  capabilities: readonly Capability[];
  /** The key the browser workspaces use for this role today (pm.html role switcher), where one exists. */
  frontendKey?: string;
}

const ALL: readonly Product[] = PRODUCTS;
const READ_ONLY: readonly Capability[] = ["org.read", "members.read", "subscription.read"];
const HOTEL: readonly Product[] = ["hotel"];

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  org_admin: {
    label: "Organisation administrator",
    products: ALL,
    capabilities: [
      ...READ_ONLY,
      "members.manage",
      "subscription.manage",
      "subscription.own",
      "audit.read",
      "ledger.read",
      "migration.read",
      "migration.run",
      "migration.approve",
      "hotel.read",
      "hotel.setup",
      "hotel.group.read",
    ],
  },
  finance_director: {
    label: "Finance director",
    products: ALL,
    frontendKey: "fd",
    capabilities: [
      ...READ_ONLY,
      "subscription.manage",
      "audit.read",
      "ledger.read",
      "ledger.prepare",
      "ledger.approve",
      "ledger.accounts.manage",
      "ledger.periods.close",
      "migration.read",
      "migration.run",
      "migration.approve",
    ],
  },
  accountant: {
    label: "Accountant",
    products: ALL,
    frontendKey: "acct",
    capabilities: [
      ...READ_ONLY,
      "ledger.read",
      "ledger.prepare",
      "ledger.approve",
      "migration.read",
      // hotel accountant: reports, city ledger and costs; never approves hotel voids or refunds
      "hotel.read",
      "hotel.reports.read",
      "hotel.cityledger",
      "hotel.costs.post",
    ],
  },
  property_manager: {
    label: "Property manager",
    products: ["property", "agency"],
    frontendKey: "pm",
    capabilities: READ_ONLY,
  },
  leasing_agent: {
    label: "Leasing agent",
    products: ["property", "agency"],
    frontendKey: "agent",
    capabilities: ["org.read"],
  },
  front_desk: { label: "Front desk", products: ["property", "hotel"], capabilities: ["org.read"] },
  technician: {
    label: "Technician",
    products: ["property", "hotel"],
    capabilities: ["org.read", "hotel.read", "hotel.maintenance"],
  },
  sales_manager: { label: "Sales manager", products: ["developer"], capabilities: READ_ONLY },
  sales_agent: { label: "Sales agent", products: ["developer"], capabilities: ["org.read"] },
  project_manager: { label: "Project manager", products: ["developer"], capabilities: READ_ONLY },
  operations_manager: { label: "Operations manager", products: ["security"], capabilities: READ_ONLY },
  supervisor: { label: "Supervisor", products: ["security"], capabilities: ["org.read"] },
  auditor: {
    label: "Auditor (read-only)",
    products: ALL,
    frontendKey: "aud",
    capabilities: [...READ_ONLY, "audit.read", "ledger.read", "migration.read", "hotel.read", "hotel.reports.read"],
  },
  viewer: { label: "Viewer (read-only)", products: ALL, capabilities: ["org.read"] },
  // ---- Hotel roles (spec section 9). A receptionist can never change rate plans (no hotel.rates.manage).
  general_manager: {
    label: "General manager",
    products: HOTEL,
    capabilities: [
      ...READ_ONLY,
      "audit.read",
      "ledger.read",
      "hotel.read",
      "hotel.setup",
      "hotel.rates.manage",
      "hotel.reservations.manage",
      "hotel.frontdesk",
      "hotel.folio.manage",
      "hotel.folio.approve",
      "hotel.cashier",
      "hotel.outlet.post",
      "hotel.housekeeping",
      "hotel.housekeeping.inspect",
      "hotel.maintenance",
      "hotel.nightaudit.run",
      "hotel.reports.read",
      "hotel.cityledger",
      "hotel.group.read",
    ],
  },
  front_office_manager: {
    label: "Front office manager",
    products: HOTEL,
    capabilities: [
      ...READ_ONLY,
      "hotel.read",
      "hotel.rates.manage",
      "hotel.reservations.manage",
      "hotel.frontdesk",
      "hotel.folio.manage",
      "hotel.folio.approve",
      "hotel.cashier",
      "hotel.outlet.post",
      "hotel.nightaudit.run",
      "hotel.reports.read",
    ],
  },
  receptionist: {
    label: "Receptionist",
    products: HOTEL,
    capabilities: [
      "org.read",
      "hotel.read",
      "hotel.reservations.manage",
      "hotel.frontdesk",
      "hotel.folio.manage",
      "hotel.cashier",
      "hotel.outlet.post",
    ],
  },
  revenue_manager: {
    label: "Revenue manager",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.rates.manage", "hotel.reservations.manage", "hotel.reports.read"],
  },
  housekeeping_supervisor: {
    label: "Housekeeping supervisor",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.housekeeping", "hotel.housekeeping.inspect", "hotel.maintenance"],
  },
  housekeeping_attendant: {
    label: "Housekeeping attendant",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.housekeeping"],
  },
  outlet_staff: {
    label: "Outlet staff",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.outlet.post", "hotel.cashier"],
  },
  financial_controller: {
    label: "Financial controller",
    products: HOTEL,
    capabilities: [
      ...READ_ONLY,
      "audit.read",
      "ledger.read",
      "ledger.prepare",
      "ledger.approve",
      "ledger.accounts.manage",
      "ledger.periods.close",
      "hotel.read",
      "hotel.folio.approve",
      "hotel.incomeaudit.signoff",
      "hotel.reports.read",
      "hotel.cityledger",
      "hotel.costs.post",
      "hotel.group.read",
    ],
  },
  income_auditor: {
    label: "Income auditor",
    products: HOTEL,
    capabilities: ["org.read", "ledger.read", "hotel.read", "hotel.reports.read", "hotel.incomeaudit.signoff"],
  },
  credit_controller: {
    label: "Credit controller",
    products: HOTEL,
    capabilities: [
      "org.read",
      "ledger.read",
      "hotel.read",
      "hotel.reports.read",
      "hotel.cityledger",
      "hotel.folio.approve",
    ],
  },
  ap_clerk: {
    label: "Accounts payable clerk",
    products: HOTEL,
    capabilities: ["org.read", "ledger.read", "ledger.prepare", "hotel.read", "hotel.costs.post"],
  },
  cost_controller: {
    label: "Cost controller",
    products: HOTEL,
    capabilities: ["org.read", "ledger.read", "hotel.read", "hotel.reports.read", "hotel.costs.post"],
  },
  payroll_officer: {
    label: "Payroll officer",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read"],
  },
  group_owner: {
    label: "Group / owner (read-only reports)",
    products: HOTEL,
    capabilities: [...READ_ONLY, "ledger.read", "hotel.read", "hotel.reports.read", "hotel.group.read"],
  },
};

/** Does this role grant this capability? */
export function roleCan(role: Role, capability: Capability): boolean {
  return ROLE_DEFINITIONS[role].capabilities.includes(capability);
}

/** Roles an organisation holding these products may hand out. */
export function rolesForProducts(products: readonly string[]): Role[] {
  return ROLES.filter((r) => ROLE_DEFINITIONS[r].products.some((p) => products.includes(p)));
}

export const STAFF_ROLES = ["super_admin", "support"] as const;
export const StaffRole = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRole>;
