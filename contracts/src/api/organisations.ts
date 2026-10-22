// An organisation (a PALTAS customer), its members and its own audit trail.
import { z } from "zod";
import { Product, ProductRoles, Role, ManagerGrant } from "../access.js";
import { Currency, Email, IsoDateTime } from "../common.js";
import { endpoint } from "../endpoint.js";
import { CompanyRegistrationProfile } from "./signup.js";

export const OrgParams = z.object({ orgId: z.string().min(1) });
/** Which product subscription a request is about. Omitted = the organisation's first product. */
export const ProductQuery = z.object({ product: Product.optional() });

export const Organisation = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  registrationProfile: CompanyRegistrationProfile.nullable().optional(),
  country: z.string(),
  currency: Currency,
  timezone: z.string(),
  demo: z.boolean(),
  products: z.array(Product),
});
export type Organisation = z.infer<typeof Organisation>;

/** "invited": an existing PALTAS account was invited and has not accepted yet (it has no access until it does). */
export const MemberStatus = z.enum(["active", "suspended", "invited"]);
export const Member = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: Role,
  status: MemberStatus,
  since: IsoDateTime,
  productRoles: ProductRoles.nullable().optional(),
});
export type Member = z.infer<typeof Member>;

export const getOrganisation = endpoint({
  id: "orgs.get",
  method: "GET",
  path: "/api/v1/orgs/:orgId",
  auth: "user",
  summary: "The organisation's profile and its products",
  params: OrgParams,
  response: Organisation,
});

export const listMembers = endpoint({
  id: "members.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/members",
  auth: "user",
  summary: "People in the organisation and their roles",
  params: OrgParams,
  response: z.object({ members: z.array(Member) }),
});

export const addMember = endpoint({
  id: "members.add",
  method: "POST",
  path: "/api/v1/orgs/:orgId/members",
  auth: "user",
  summary:
    "Add a person with a role. A new account gets a temporary password, returned ONCE, to pass on through a secure channel. " +
    "An existing PALTAS account is invited instead and has no access until that person accepts.",
  params: OrgParams,
  body: z.object({
    email: Email,
    name: z.string().trim().min(2).max(120).optional(),
    role: Role,
    productRoles: ProductRoles.nullable().optional(),
  }),
  response: z.object({ member: Member, temporaryPassword: z.string().nullable() }),
  status: 201,
});

export const updateMember = endpoint({
  id: "members.update",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/members/:userId",
  auth: "user",
  summary: "Change a person's role or suspend them. You cannot change your own access.",
  params: OrgParams.extend({ userId: z.string().min(1) }),
  body: z
    .object({
      role: Role.optional(),
      status: z.enum(["active", "suspended"]).optional(),
      productRoles: ProductRoles.nullable().optional(),
    })
    .refine(
      (b) => b.role !== undefined || b.status !== undefined || b.productRoles !== undefined,
      "Send a role, status or product access",
    ),
  response: Member,
});

export const AuditEntry = z.object({
  id: z.string(),
  at: IsoDateTime,
  actorUserId: z.string().nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  detail: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const listAudit = endpoint({
  id: "audit.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/audit",
  auth: "user",
  summary: "The organisation's audit trail, newest first. Entries can never be changed or deleted.",
  params: OrgParams,
  query: z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before: z.string().optional(),
  }),
  response: z.object({ entries: z.array(AuditEntry) }),
});

export const getManagerGrants = endpoint({
  id: "members.managerGrants.get",
  method: "GET",
  path: "/api/v1/orgs/:orgId/main-managers/:userId",
  auth: "user",
  summary: "Owner-controlled operational delegation",
  params: OrgParams.extend({ userId: z.string().min(1) }),
  response: z.object({ grants: z.array(ManagerGrant) }),
});
export const setManagerGrants = endpoint({
  id: "members.managerGrants.set",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/main-managers/:userId",
  auth: "user",
  summary: "Owner confirms product permissions and property scope; empty grants revoke all delegated access",
  params: OrgParams.extend({ userId: z.string().min(1) }),
  body: z.object({
    grants: z.array(ManagerGrant).max(5),
    reason: z.string().trim().min(5).max(500),
    confirm: z.literal("SAVE_PERMISSIONS"),
  }),
  response: z.object({ grants: z.array(ManagerGrant) }),
});
