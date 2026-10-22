// The Super Admin portal's console: the PALTAS staff team and their roles, the client company directory, the people
// search and the platform overview. Staff only (second factor at sign-in). Everyone on the staff can read; changes need
// the permission named on each endpoint (see STAFF_ROLE_DEFINITIONS in access.ts).
import { z } from "zod";
import { Product, Role, StaffPermission, StaffRole } from "../access.js";
import { Currency, Email, IsoDate, IsoDateTime, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";

// ------------------------------------------------------------------ the PALTAS team
export const StaffMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: StaffRole,
  active: z.boolean(),
  /** The temporary password has not been replaced yet (invited or reset, never signed in since). */
  mustChangePassword: z.boolean(),
  createdAt: IsoDateTime,
  lastSignInAt: IsoDateTime.nullable(),
});
export type StaffMember = z.infer<typeof StaffMember>;

export const StaffRoleInfo = z.object({
  role: StaffRole,
  label: z.string(),
  description: z.string(),
  permissions: z.array(StaffPermission),
});

export const listStaff = endpoint({
  id: "admin.staff.list",
  method: "GET",
  path: "/api/v1/admin/staff",
  auth: "staff",
  summary: "The PALTAS team: every staff account with its role, and what each role may change",
  response: z.object({
    staff: z.array(StaffMember),
    roles: z.array(StaffRoleInfo),
    permissions: z.array(z.object({ permission: StaffPermission, label: z.string() })),
  }),
});

/** Handed over ONCE, in person or over a secure channel: only hashes and the sealed secret are stored. */
export const StaffCredentials = z.object({
  userId: z.string(),
  email: z.string(),
  temporaryPassword: z.string(),
  /** For the authenticator app (or scan otpauthUrl as a QR code). Every sign-in needs its 6-digit code. */
  authenticatorSecret: z.string(),
  otpauthUrl: z.string(),
});

export const inviteStaff = endpoint({
  id: "admin.staff.invite",
  method: "POST",
  path: "/api/v1/admin/staff",
  auth: "staff",
  summary:
    "Add a PALTAS staff member with a role (Super Admin only). Returns a temporary password and an authenticator " +
    "secret ONCE; the person must change the password at first sign-in and always signs in with a 6-digit code.",
  body: z.object({
    email: Email,
    name: z.string().trim().min(2).max(120),
    role: StaffRole,
    reason: Reason,
  }),
  response: StaffCredentials,
  status: 201,
});

const StaffParams = z.object({ userId: z.string().min(1) });

export const updateStaff = endpoint({
  id: "admin.staff.update",
  method: "PUT",
  path: "/api/v1/admin/staff/:userId",
  auth: "staff",
  summary:
    "Change a staff member's role, or deactivate / reactivate the account (Super Admin only). Their open sessions " +
    "end. Nobody changes their own account here, and the last active Super Admin cannot be removed.",
  params: StaffParams,
  body: z
    .object({ role: StaffRole.optional(), active: z.boolean().optional(), reason: Reason })
    .refine((b) => b.role !== undefined || b.active !== undefined, "Choose a new role or the account status"),
  response: z.object({ ok: z.literal(true) }),
});

export const resetStaffAccess = endpoint({
  id: "admin.staff.resetAccess",
  method: "POST",
  path: "/api/v1/admin/staff/:userId/reset-access",
  auth: "staff",
  summary:
    "A lost phone or password: issue a new temporary password and a new authenticator secret (Super Admin only), " +
    "returned ONCE. The old ones stop working and every open session ends.",
  params: StaffParams,
  body: z.object({ reason: Reason }),
  response: StaffCredentials,
});

// ------------------------------------------------------------------ client companies
/** How the company came to PALTAS. */
export const ClientSource = z.enum(["self_signup", "business_request", "paltas_staff", "demo"]);
export const ClientStatus = z.enum(["trial", "active", "suspended", "expired"]);

export const ClientRow = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  country: z.string(),
  currency: Currency,
  createdAt: IsoDateTime,
  source: ClientSource,
  /** Suspended as a whole by PALTAS (every product), with the reason. */
  suspended: z.object({ at: IsoDateTime, reason: z.string() }).nullable(),
  products: z.array(
    z.object({ product: Product, plan: z.string().nullable(), status: ClientStatus, trialEnds: IsoDate.nullable() }),
  ),
  /** The first active administrator (organisation admin). */
  admin: z.object({ name: z.string(), email: z.string(), emailVerified: z.boolean() }).nullable(),
  members: z.number().int(),
  listings: z.number().int(),
  openInvoices: z.number().int(),
  /** The latest sign-in of any of its members. */
  lastActiveAt: IsoDateTime.nullable(),
});
export type ClientRow = z.infer<typeof ClientRow>;

export const listClients = endpoint({
  id: "admin.clients.list",
  method: "GET",
  path: "/api/v1/admin/clients",
  auth: "staff",
  summary: "The client company directory: search and filter by product, status, country and how they registered",
  query: z.object({
    q: z.string().trim().max(120).optional(),
    product: Product.optional(),
    status: ClientStatus.optional(),
    country: z.string().trim().max(80).optional(),
    source: ClientSource.optional(),
    sort: z.enum(["newest", "oldest", "name", "last_active"]).default("newest"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  response: z.object({
    total: z.number().int(),
    clients: z.array(ClientRow),
    /** Every country with at least one client (for the filter). */
    countries: z.array(z.string()),
  }),
});

// ------------------------------------------------------------------ people (client accounts)
export const PersonRow = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  active: z.boolean(),
  emailVerified: z.boolean(),
  twoFactor: z.boolean(),
  createdAt: IsoDateTime,
  lastSignInAt: IsoDateTime.nullable(),
  memberships: z.array(
    z.object({
      orgId: z.string(),
      orgName: z.string(),
      role: Role,
      status: z.enum(["active", "suspended", "invited"]),
    }),
  ),
});

export const searchPeople = endpoint({
  id: "admin.people.search",
  method: "GET",
  path: "/api/v1/admin/people",
  auth: "staff",
  summary: "Find a client account by name or e-mail, with every company it belongs to (PALTAS staff are not listed)",
  query: z.object({
    q: z.string().trim().min(2, "Type at least 2 characters").max(120),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }),
  response: z.object({ people: z.array(PersonRow) }),
});

// ------------------------------------------------------------------ platform overview
const Count = z.number().int();
const MoneyByCurrency = z.array(z.object({ currency: Currency, amountMinor: z.number().int() }));

export const platformOverview = endpoint({
  id: "admin.overview",
  method: "GET",
  path: "/api/v1/admin/overview",
  auth: "staff",
  summary: "The whole platform at a glance: clients, people, money and every queue waiting for a PALTAS decision",
  response: z.object({
    asOf: IsoDateTime,
    clients: z.object({
      total: Count,
      newLast30Days: Count,
      suspended: Count,
      bySource: z.record(ClientSource, Count),
      /** Product subscriptions by product and status. */
      subscriptions: z.array(z.object({ product: Product, status: ClientStatus, count: Count })),
    }),
    people: z.object({ clientAccounts: Count, signedInLast30Days: Count, staff: Count }),
    money: z.object({
      outstanding: MoneyByCurrency,
      overdue: MoneyByCurrency,
      paidLast30Days: MoneyByCurrency,
    }),
    marketplace: z.object({ liveListings: Count, bookingsLast30Days: Count, offersLast30Days: Count }),
    queues: z.object({
      signups: Count,
      businessRequests: Count,
      listings: Count,
      reviews: Count,
      payments: Count,
      priceChanges: Count,
    }),
  }),
});

/** Platform-only metadata: no document contents, guest codes or financial credentials. */
export const dashboardInsights = endpoint({
  id: "admin.dashboardInsights",
  summary: "Staff-only inventory totals and bounded UTC creation series",
  method: "GET",
  path: "/api/v1/admin/dashboard-insights",
  auth: "staff",
  query: z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }),
  response: z.object({
    asOf: IsoDateTime,
    days: Count,
    totals: z.object({
      properties: Count,
      units: Count,
      projects: Count,
      hotels: Count,
      listings: Count,
      securitySites: Count,
      bookings: Count,
      documents: Count,
      countries: Count,
    }),
    timeline: z.array(z.object({ date: IsoDate, organisations: Count, users: Count, bookings: Count })),
    countries: z.array(z.object({ country: z.string(), organisations: Count })),
  }),
});
export const platformRecords = endpoint({
  id: "admin.platformRecords",
  summary: "Staff-only paginated property, booking and document metadata",
  method: "GET",
  path: "/api/v1/admin/platform-records",
  auth: "staff",
  query: z.object({
    kind: z.enum(["properties", "bookings", "documents"]).default("properties"),
    q: z.string().max(120).optional(),
    orgId: z.string().max(100).optional(),
    product: Product.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }),
  response: z.object({
    total: Count,
    records: z.array(
      z.object({
        id: z.string(),
        orgId: z.string(),
        orgName: z.string(),
        product: Product,
        name: z.string(),
        status: z.string(),
        createdAt: IsoDateTime,
      }),
    ),
  }),
});
