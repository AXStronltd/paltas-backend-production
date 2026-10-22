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

/** Products a customer can subscribe to (sign up for, or add) today: every product, under one trial policy. */
export const SELLABLE_PRODUCTS = PRODUCTS satisfies readonly Product[];

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
  /** Hotel: enter the day's exchange rates (multi-currency payments use them; no FX provider). */
  "hotel.fx.manage",
  /** Hotel: import bank lines, match recorded payments to the bank, card fees and chargebacks. */
  "hotel.reconcile",
  /** Hotel: stock items, counts, receipts, issues, recipes and purchase orders (housekeeping: linen and amenities only). */
  "hotel.stock.manage",
  /** Hotel: approve purchase orders and supplier bills that do not match (someone other than who entered them). */
  "hotel.purchasing.approve",
  /** Hotel: enter supplier bills and match them to purchase orders and receipts (cannot approve). */
  "hotel.payables",
  /** Hotel: table, spa and activity bookings. */
  "hotel.bookings.manage",
  /** Hotel: events and meetings — quotes, function sheets, contracts, deposits, final billing. */
  "hotel.events.manage",
  /** Hotel: payroll inputs, pay runs, tips and service-charge distribution. The only role that sees salaries. */
  "hotel.payroll",
  /** Hotel: approve a pay run prepared by someone else (sees department totals, never salaries). */
  "hotel.payroll.approve",
  /** Hotel: budgets, forecasts and the FF&E reserve. */
  "hotel.budget.manage",
  /** Hotel: fixed assets, depreciation and disposals. */
  "hotel.assets.manage",
  /** Hotel: labour standards and staff schedules. */
  "hotel.labour.manage",
  /** Development: see the workspace (projects, units, stock, milestones, suppliers, orders). */
  "developer.read",
  /** Development: rules, approval limits and cost codes. */
  "developer.settings",
  /** Development: projects, phases, buildings, units, milestones, legal register. */
  "developer.projects",
  /** Development: prepare and approve price lists (approval by someone other than the preparer). */
  "developer.pricing",
  /** Development: see buyer records (only your own buyers without developer.buyers.all). */
  "developer.buyers.read",
  "developer.buyers.all",
  /** Development: buyers, offers, buyer responses, payment reports, correspondence, after-sales. */
  "developer.sales",
  /** Development: assign and merge buyers, approve offers (manager level) and reservations, sign contracts, handovers. */
  "developer.sales.manage",
  /** Development: chief-executive decisions — offers beyond a manager's level, related-party and over-budget orders, invoice exceptions. */
  "developer.executive",
  /** Development: verify reported buyer payments against the bank and bill instalments. */
  "developer.collections",
  /** Development: suppliers, requisitions, quotations, orders, deliveries. */
  "developer.procurement",
  /** Development: approve spend within the role's approval limits. */
  "developer.approve",
  /** Development: capture supplier invoices, credit notes, disputes; prepare payment runs. */
  "developer.payables",
  /** Development: execute payment runs (bank file) and reconcile bank statements. */
  "developer.treasury",
  /** Development: approve suppliers and verify bank-detail changes. */
  "developer.suppliers.verify",
  /** Development: budgets, forecasts, transfers and change orders. */
  "developer.budget",
  /** Development: defects and site work. */
  "developer.delivery",
  /** Development: dashboards and cost reports. */
  "developer.reports",
  /** Development: tasks and document records. */
  "developer.work",
  /** Agent / Host: see listings, leads, deals, stays and bookings. */
  "agency.read",
  /** Agent / Host: create and edit listings, media, prices and stay calendars (publishing needs marketplace.publish). */
  "agency.listings.manage",
  /** Agent / Host: work leads, viewings and offers (a leasing agent sees their own and unassigned leads). */
  "agency.leads.manage",
  /** Agent / Host: assign leads to agents and see every lead. */
  "agency.leads.assign",
  /** Agent / Host: commission agreements and closing deals (raises the commission for approval). */
  "agency.deals.manage",
  /** Agent / Host: short-stay bookings, blocks, check-in and check-out. */
  "agency.stays.manage",
  /** Agent / Host: record guest payments, refunds and commission receipts; prepare host payouts. */
  "agency.payments.record",
  /** Agent / Host: approve commissions and host payouts prepared by someone else. */
  "agency.finance.approve",
  "agency.reports.read",
  /** Marketplace: the organisation's inbox of public enquiries and viewing requests. */
  "marketplace.inbox",
  /** Marketplace: submit listings to PALTAS for publication, and take them down. */
  "marketplace.publish",
  /** Security: see the operations workspace (sites, contracts, guards, roster, patrols, incidents, alarms). */
  "security.read",
  /** Security: clients, sites, posts and post orders, checkpoints, contracts, settings, sales pipeline. */
  "security.setup",
  /** Security: guards, licences, vetting, training and equipment. */
  "security.guards.manage",
  /** Security: create, assign, offer and publish shifts; correct attendance; act for any guard in the field. */
  "security.roster.manage",
  /** Security: approve timesheets (never ones you recorded or corrected). */
  "security.timesheets.approve",
  /** Security: field actions — clock in/out, post-order acknowledgement, patrol scans, panic (guards: their own only). */
  "security.field",
  /** Security: write incidents and occurrence-book entries. */
  "security.occurrences.write",
  /** Security: the control room — alarms, dispatch, no-show detection, messages to guards. */
  "security.control",
  /** Security: assign investigators and close incidents (never ones you reported). */
  "security.incidents.manage",
  /** Security: visitor reception, gate check-in / check-out and the watchlist. */
  "security.visitors",
  /** Security: doors, access groups and credentials. */
  "security.access.manage",
  /** Security: client invoices, receipts, certificates, late charges, collections, bank lines, costs. */
  "security.billing",
  /** Security: prepare payroll inputs, record wage payments and remittances. */
  "security.payroll.prepare",
  /** Security: approve payroll (never one you prepared) and set the payroll rules. */
  "security.payroll.approve",
  /** Security: KPIs, site profitability and client service reports. */
  "security.reports.read",
  /** Security: the client portal — only the clients a person is linked to. */
  "security.portal",
  /** Notifications: see the organisation's outbox, templates, sender settings and consent history. */
  "notifications.read",
  /** Notifications: sender settings, templates, consents, and recording messages by hand. */
  "notifications.manage",
  /** Bank and provider payments: import bank statements and confirm matches (never your own import). */
  "payments.reconcile",
  /** Contacts (the one shared list of people and companies): see them. */
  "contacts.read",
  /** Contacts: add and change contacts, consent, activities, recorded messages. */
  "contacts.manage",
  /** Contacts: merge duplicates (every product's records move to the contact kept). */
  "contacts.merge",
  /** Property Management: see the workspace (portfolio, leases, invoices, payments, owners, bills). */
  "property.read",
  /** Property Management: properties, units, owners' agreements, charge types, late-fee policies, settings. */
  "property.setup",
  /** Property Management: draft, activate, renew, review rent, notice and end leases; recurring charges; meter readings. */
  "property.leases.manage",
  /** Property Management: billing runs, charge invoices, late fees, credit notes. */
  "property.billing",
  /** Property Management: record tenant payments (never processed), apply credit, check reported payments. */
  "property.payments.record",
  /** Property Management: settle a deposit at move-out (someone else approves). */
  "property.deposits.request",
  /** Property Management: approve deposit settlements requested by someone else. */
  "property.deposits.approve",
  /** Property Management: enter supplier bills. */
  "property.bills.submit",
  /** Property Management: approve supplier bills entered by someone else. */
  "property.bills.approve",
  /** Property Management: record bill payments (never a bill you approved). */
  "property.bills.pay",
  /** Property Management: prepare owner payouts and release approved ones (never one you approved). */
  "property.payouts.prepare",
  /** Property Management: approve owner payouts prepared by someone else. */
  "property.payouts.approve",
  /** Property Management: import the client-account statement, match it, prepare and sign off reconciliations. */
  "property.bank.reconcile",
  /** Property Management: log maintenance requests. */
  "property.maintenance.request",
  /** Property Management: work orders, quotes, purchase orders, verification, inspections. */
  "property.maintenance.manage",
  /** Property Management: approve purchase orders raised by someone else, within the role's limit. */
  "property.maintenance.approve",
  /** Property Management: carry out work orders (technicians: complete with evidence). */
  "property.maintenance.work",
  /** Property Management: enquiries, leads, viewings and applications. */
  "property.crm",
  /** Property Management: approve rental applications screened by someone else. */
  "property.crm.approve",
  /** Property Management: notices to tenants and documents. */
  "property.notices",
  /** Property Management: dashboards, arrears, rent roll, owner statements, client-money check. */
  "property.reports.read",
  /** Tenant portal: the signed-in tenant's own lease, invoices, payments and requests. */
  "property.portal.tenant",
  /** Owner portal: the signed-in owner's properties, statements, approvals and payouts. */
  "property.portal.owner",
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
  "procurement_officer",
  "treasury_officer",
  "control_room_operator",
  "guard",
  "gate_officer",
  "access_administrator",
  "security_client",
  "maintenance_manager",
  "tenant",
  "owner",
] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Null preserves legacy membership roles; an object is an explicit product allowlist. */
export const ProductRoles = z.partialRecord(Product, Role);
export type ProductRoles = z.infer<typeof ProductRoles>;

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
// Development: the workspace's role switcher (CEO = organisation administrator, finance manager = finance director,
// project manager, procurement officer, accounts payable, treasury, sales manager, sales agent).
const DEV_WORK: readonly Capability[] = ["developer.read", "developer.work"];
const DEV_ALL: readonly Capability[] = CAPABILITIES.filter((c) => c.startsWith("developer."));
// Property Management: the workspace's role switcher (pm, acct, agent, fd, mm, aud) plus the owner and tenant portals.
// Money is split so a second person is always needed: the property manager requests deposit settlements and enters
// bills; the accountant or finance director approves them; payouts are prepared, approved and released by different
// people (enforced per record, not only by role).
const PM_CONTACTS: readonly Capability[] = ["contacts.read", "contacts.manage"];
const PM_FINANCE: readonly Capability[] = [
  "property.read",
  "property.billing",
  "property.payments.record",
  "property.deposits.request",
  "property.deposits.approve",
  "property.bills.submit",
  "property.bills.approve",
  "property.bills.pay",
  "property.payouts.prepare",
  "property.payouts.approve",
  "property.bank.reconcile",
  "property.reports.read",
];
const PM_OPERATIONS: readonly Capability[] = [
  "property.read",
  "property.setup",
  "property.leases.manage",
  "property.maintenance.request",
  "property.maintenance.manage",
  "property.maintenance.approve",
  "property.crm",
  "property.crm.approve",
  "property.notices",
  "property.reports.read",
];

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
      ...DEV_ALL,
      "hotel.read",
      "hotel.setup",
      // the person who signs up finishes the first-run set-up alone: prices and rate plans
      "hotel.rates.manage",
      "hotel.group.read",
      "agency.read",
      "agency.listings.manage",
      "agency.reports.read",
      "marketplace.inbox",
      "marketplace.publish",
      "security.read",
      "security.setup",
      "security.guards.manage",
      // first-run set-up alone: the first roster, the reception desk and the control room
      "security.roster.manage",
      "security.visitors",
      "security.control",
      "security.access.manage",
      "security.reports.read",
      "notifications.read",
      "notifications.manage",
      // The company owner can run its daily property workflows. Money approvals remain separate capabilities
      // and still require another person under each record's maker/checker rules.
      ...PM_CONTACTS,
      "contacts.merge",
      ...PM_OPERATIONS,
      "property.billing",
      "property.payments.record",
      "property.bills.submit",
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
      // development finance manager: approves within limits, verifies buyer payments, suppliers and bank changes
      ...DEV_WORK,
      "developer.settings",
      "developer.buyers.read",
      "developer.buyers.all",
      "developer.collections",
      "developer.procurement",
      "developer.approve",
      "developer.payables",
      "developer.suppliers.verify",
      "developer.budget",
      "developer.reports",
      "agency.read",
      "agency.payments.record",
      "agency.finance.approve",
      "agency.reports.read",
      // security finance director: billing, approves payroll (never one they prepared) and sets the payroll rules
      "security.read",
      "security.billing",
      "security.payroll.prepare",
      "security.payroll.approve",
      "security.reports.read",
      "notifications.read",
      "payments.reconcile",
      // property management finance director: everything, still never approving their own work
      ...PM_CONTACTS,
      "contacts.merge",
      ...PM_FINANCE,
      ...PM_OPERATIONS.filter((c) => !PM_FINANCE.includes(c)),
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
      "payments.reconcile",
      // hotel accountant: reports, city ledger and costs; never approves hotel voids or refunds
      "hotel.read",
      "hotel.reports.read",
      "hotel.cityledger",
      "hotel.costs.post",
      "hotel.reconcile",
      "hotel.payables",
      "hotel.assets.manage",
      // development accountant: payables, collections verification and billing; approves no spend
      ...DEV_WORK,
      "developer.buyers.read",
      "developer.buyers.all",
      "developer.collections",
      "developer.payables",
      "developer.reports",
      // agency accountant: records payments and approves what someone else raised or prepared
      "agency.read",
      "agency.payments.record",
      "agency.finance.approve",
      "agency.reports.read",
      // security accountant: billing and payroll preparation; never approves payroll
      "security.read",
      "security.billing",
      "security.payroll.prepare",
      "security.reports.read",
      // property management accountant: billing, payments, approvals of what others prepared, reconciliation
      ...PM_CONTACTS,
      ...PM_FINANCE,
    ],
  },
  property_manager: {
    label: "Property manager",
    products: ["property", "agency"],
    frontendKey: "pm",
    capabilities: [
      ...READ_ONLY,
      // in an agency this is the agency manager
      "agency.read",
      "agency.listings.manage",
      "agency.leads.manage",
      "agency.leads.assign",
      "agency.deals.manage",
      "agency.stays.manage",
      "agency.reports.read",
      "marketplace.inbox",
      "marketplace.publish",
      // property management: runs the buildings; requests deposit settlements and enters bills, never approves them
      ...PM_CONTACTS,
      "contacts.merge",
      ...PM_OPERATIONS,
      "property.billing",
      "property.payments.record",
      "property.deposits.request",
      "property.bills.submit",
      "property.bills.approve",
    ],
  },
  leasing_agent: {
    label: "Leasing agent",
    products: ["property", "agency"],
    frontendKey: "agent",
    capabilities: [
      "org.read",
      "agency.read",
      "agency.listings.manage",
      "agency.leads.manage",
      "agency.stays.manage",
      "marketplace.inbox",
      // property management: enquiries, viewings, applications (approval by a manager), maintenance requests
      ...PM_CONTACTS,
      "property.read",
      "property.crm",
      "property.maintenance.request",
    ],
  },
  front_desk: {
    label: "Front desk",
    products: ["property", "hotel"],
    capabilities: ["org.read", "contacts.read", "property.maintenance.request"],
  },
  technician: {
    label: "Technician",
    products: ["property", "hotel"],
    capabilities: ["org.read", "hotel.read", "hotel.maintenance", "property.maintenance.work"],
  },
  sales_manager: {
    label: "Sales manager",
    products: ["developer"],
    capabilities: [
      ...READ_ONLY,
      ...DEV_WORK,
      "developer.pricing",
      "developer.buyers.read",
      "developer.buyers.all",
      "developer.sales",
      "developer.sales.manage",
      "developer.delivery",
      "developer.reports",
    ],
  },
  sales_agent: {
    label: "Sales agent",
    products: ["developer"],
    // their own buyers only (no developer.buyers.all)
    capabilities: ["org.read", ...DEV_WORK, "developer.buyers.read", "developer.sales"],
  },
  project_manager: {
    label: "Project manager",
    products: ["developer"],
    capabilities: [
      ...READ_ONLY,
      ...DEV_WORK,
      "developer.projects",
      "developer.procurement",
      "developer.approve",
      "developer.budget",
      "developer.delivery",
      "developer.reports",
    ],
  },
  operations_manager: {
    label: "Operations manager",
    products: ["security"],
    capabilities: [
      ...READ_ONLY,
      "audit.read",
      "security.read",
      "security.setup",
      "security.guards.manage",
      "security.roster.manage",
      "security.timesheets.approve",
      "security.occurrences.write",
      "security.control",
      "security.incidents.manage",
      "security.visitors",
      "security.access.manage",
      "security.reports.read",
    ],
  },
  supervisor: {
    label: "Supervisor",
    products: ["security"],
    // records attendance for guards; never approves timesheets
    capabilities: [
      "org.read",
      "security.read",
      "security.roster.manage",
      "security.field",
      "security.occurrences.write",
      "security.control",
      "security.incidents.manage",
      "security.visitors",
    ],
  },
  auditor: {
    label: "Auditor (read-only)",
    products: ALL,
    frontendKey: "aud",
    capabilities: [
      ...READ_ONLY,
      "audit.read",
      "ledger.read",
      "migration.read",
      "hotel.read",
      "hotel.reports.read",
      "developer.read",
      "developer.reports",
      "agency.read",
      "agency.reports.read",
      "notifications.read",
      "security.read",
      "security.reports.read",
      "contacts.read",
      "property.read",
      "property.reports.read",
    ],
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
      "hotel.fx.manage",
      "hotel.stock.manage",
      "hotel.purchasing.approve",
      "hotel.bookings.manage",
      "hotel.events.manage",
      "hotel.payroll.approve",
      "hotel.budget.manage",
      "hotel.labour.manage",
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
      "hotel.fx.manage",
      "hotel.bookings.manage",
      "hotel.events.manage",
      "hotel.labour.manage",
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
      "hotel.bookings.manage",
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
    capabilities: [
      "org.read",
      "hotel.read",
      "hotel.housekeeping",
      "hotel.housekeeping.inspect",
      "hotel.maintenance",
      "hotel.stock.manage",
      "hotel.labour.manage",
    ],
  },
  housekeeping_attendant: {
    label: "Housekeeping attendant",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.housekeeping"],
  },
  outlet_staff: {
    label: "Outlet staff",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.outlet.post", "hotel.cashier", "hotel.bookings.manage"],
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
      "payments.reconcile",
      "hotel.read",
      "hotel.folio.approve",
      "hotel.incomeaudit.signoff",
      "hotel.reports.read",
      "hotel.cityledger",
      "hotel.costs.post",
      "hotel.group.read",
      "hotel.fx.manage",
      "hotel.reconcile",
      "hotel.purchasing.approve",
      "hotel.payables",
      "hotel.payroll.approve",
      "hotel.budget.manage",
      "hotel.assets.manage",
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
    products: [...HOTEL, "developer"],
    capabilities: [
      "org.read",
      "ledger.read",
      "ledger.prepare",
      "hotel.read",
      "hotel.costs.post",
      "hotel.payables",
      ...DEV_WORK,
      "developer.payables",
    ],
  },
  cost_controller: {
    label: "Cost controller",
    products: HOTEL,
    capabilities: [
      "org.read",
      "ledger.read",
      "hotel.read",
      "hotel.reports.read",
      "hotel.costs.post",
      "hotel.stock.manage",
    ],
  },
  payroll_officer: {
    label: "Payroll officer",
    products: HOTEL,
    capabilities: ["org.read", "hotel.read", "hotel.payroll"],
  },
  group_owner: {
    label: "Group / owner (read-only reports)",
    products: HOTEL,
    capabilities: [...READ_ONLY, "ledger.read", "hotel.read", "hotel.reports.read", "hotel.group.read"],
  },
  // ---- Development roles
  procurement_officer: {
    label: "Procurement officer",
    products: ["developer"],
    capabilities: ["org.read", ...DEV_WORK, "developer.procurement", "developer.approve"],
  },
  treasury_officer: {
    label: "Treasury officer",
    products: ["developer"],
    capabilities: [
      "org.read",
      "ledger.read",
      ...DEV_WORK,
      "developer.buyers.read",
      "developer.buyers.all",
      "developer.collections",
      "developer.treasury",
    ],
  },
  // ---- Security roles. A guard acts only for their own guard record; a client sees only the clients linked to them.
  control_room_operator: {
    label: "Control room operator",
    products: ["security"],
    capabilities: ["org.read", "security.read", "security.control", "security.occurrences.write"],
  },
  guard: {
    label: "Guard",
    products: ["security"],
    capabilities: ["org.read", "security.field", "security.occurrences.write"],
  },
  gate_officer: {
    label: "Gate / reception officer",
    products: ["security"],
    capabilities: ["org.read", "security.visitors", "security.occurrences.write"],
  },
  access_administrator: {
    label: "Access control administrator",
    products: ["security"],
    capabilities: ["org.read", "security.read", "security.access.manage"],
  },
  security_client: {
    label: "Security client (portal)",
    products: ["security"],
    capabilities: ["org.read", "security.portal"],
  },
  // ---- Property Management roles
  maintenance_manager: {
    label: "Maintenance manager",
    products: ["property"],
    frontendKey: "mm",
    capabilities: [
      "org.read",
      "contacts.read",
      "property.maintenance.request",
      "property.maintenance.manage",
      "property.maintenance.approve",
      "property.maintenance.work",
    ],
  },
  tenant: {
    label: "Tenant (portal)",
    products: ["property"],
    frontendKey: "tenant",
    capabilities: ["property.portal.tenant"],
  },
  owner: {
    label: "Owner (portal)",
    products: ["property"],
    frontendKey: "owner",
    capabilities: ["property.portal.owner"],
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

// ------------------------------------------------------------------ PALTAS staff (the Super Admin portal)
/**
 * What a PALTAS staff member may CHANGE. Every staff member can see the whole portal (read-only); each permission
 * unlocks one area of changes. Super Admin holds every permission and is the only role that manages the staff team
 * and exports a client's data.
 */
export const STAFF_PERMISSIONS = [
  "staff.manage",
  "clients.manage",
  "billing.manage",
  "marketplace.moderate",
  "marketing.manage",
  "platform.operate",
  "support.respond",
  "data.export",
] as const;
export const StaffPermission = z.enum(STAFF_PERMISSIONS);
export type StaffPermission = z.infer<typeof StaffPermission>;

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  "staff.manage": "Manage the PALTAS team and their roles",
  "clients.manage": "Client companies: create, edit, products, trials, sign-up decisions, suspend and reactivate",
  "billing.manage": "Billing: plans, modules, prices, discounts, invoices and receipts",
  "marketplace.moderate": "Marketplace: approve or reject listings, business requests and reviews",
  "marketing.manage": "Marketing campaigns",
  "platform.operate": "Platform operations: scheduled jobs, trial policy, payment providers",
  "support.respond": "Support chat: reply to clients, assign and close conversations",
  "data.export": "Export a client's complete data",
};

export const STAFF_ROLES = ["super_admin", "operations", "finance", "moderator", "marketing", "support"] as const;
export const StaffRole = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRole>;

export const STAFF_ROLE_DEFINITIONS: Record<
  StaffRole,
  { label: string; description: string; permissions: readonly StaffPermission[] }
> = {
  super_admin: {
    label: "Super Admin",
    description: "Everything, including the PALTAS team, roles and client data exports.",
    permissions: STAFF_PERMISSIONS,
  },
  operations: {
    label: "Operations",
    description: "Runs client companies day to day: onboarding, sign-ups, trials, suspensions, moderation, jobs.",
    permissions: ["clients.manage", "marketplace.moderate", "platform.operate", "support.respond"],
  },
  finance: {
    label: "Finance",
    description: "Plans, prices, discounts, invoices and receipts.",
    permissions: ["billing.manage"],
  },
  moderator: {
    label: "Marketplace moderator",
    description: "Reviews listings, business requests and guest reviews.",
    permissions: ["marketplace.moderate"],
  },
  marketing: {
    label: "Marketing",
    description: "Prepares and runs marketing campaigns.",
    permissions: ["marketing.manage"],
  },
  support: {
    label: "Support",
    description: "Answers clients in the support chat and sees everything to help them; changes nothing else.",
    permissions: ["support.respond"],
  },
};

/** May this staff role make this kind of change? */
export function staffCan(role: StaffRole | null | undefined, permission: StaffPermission): boolean {
  return !!role && STAFF_ROLE_DEFINITIONS[role].permissions.includes(permission);
}
