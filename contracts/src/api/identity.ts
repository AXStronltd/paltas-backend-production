// Sign-in, sessions, the signed-in person, password and two-factor set-up. Also the health check.
import { z } from "zod";
import { Product, Role, StaffRole } from "../access.js";
import { Email, IsoDate, Ok } from "../common.js";
import { endpoint } from "../endpoint.js";

export const SignedInUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  staff: z.boolean(),
  staffRole: StaffRole.nullable(),
  mfaEnabled: z.boolean(),
  /** A temporary password must be replaced before anything else (me.changePassword). */
  mustChangePassword: z.boolean(),
});
export type SignedInUser = z.infer<typeof SignedInUser>;

export const SixDigitCode = z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");
export const NewPassword = z.string().min(12, "Passwords need at least 12 characters").max(200);

export const health = endpoint({
  id: "health",
  method: "GET",
  path: "/api/v1/health",
  auth: "public",
  summary: "Is the server up, and which database and billing mode is it using",
  response: z.object({
    ok: z.literal(true),
    database: z.literal("postgres"),
    billingMode: z.enum(["provider", "simulated"]),
    today: IsoDate,
  }),
});

export const login = endpoint({
  id: "auth.login",
  method: "POST",
  path: "/api/v1/auth/login",
  auth: "public",
  summary: "Sign in. PALTAS staff and anyone with two-factor turned on must also send the 6-digit code.",
  body: z.object({
    email: Email,
    password: z.string().min(1).max(200),
    code: SixDigitCode.optional(),
  }),
  response: z.object({ token: z.string(), expiresInMinutes: z.number().int(), user: SignedInUser }),
});

export const logout = endpoint({
  id: "auth.logout",
  method: "POST",
  path: "/api/v1/auth/logout",
  auth: "user",
  summary: "End this session",
  response: Ok,
});

export const MyOrganisation = z.object({
  id: z.string(),
  name: z.string(),
  products: z.array(Product),
  role: Role,
});

export const Invitation = z.object({ orgId: z.string(), orgName: z.string(), role: Role });

export const me = endpoint({
  id: "me.get",
  method: "GET",
  path: "/api/v1/me",
  auth: "user",
  summary: "The signed-in person, the organisations they belong to, and invitations waiting for an answer",
  response: z.object({ user: SignedInUser, organisations: z.array(MyOrganisation), invitations: z.array(Invitation) }),
});

const InvitationParams = z.object({ orgId: z.string().min(1) });

export const acceptInvitation = endpoint({
  id: "me.invitations.accept",
  method: "POST",
  path: "/api/v1/me/invitations/:orgId/accept",
  auth: "user",
  summary: "Accept an invitation to join an organisation",
  params: InvitationParams,
  response: Ok,
});

export const declineInvitation = endpoint({
  id: "me.invitations.decline",
  method: "POST",
  path: "/api/v1/me/invitations/:orgId/decline",
  auth: "user",
  summary: "Decline an invitation; the organisation keeps no membership",
  params: InvitationParams,
  response: Ok,
});

export const changePassword = endpoint({
  id: "me.changePassword",
  method: "POST",
  path: "/api/v1/me/password",
  auth: "user",
  summary: "Change your password. Every other session of yours is signed out.",
  body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: NewPassword }),
  response: Ok,
});

export const startMfa = endpoint({
  id: "me.mfa.start",
  method: "POST",
  path: "/api/v1/me/mfa/setup",
  auth: "user",
  summary: "Start turning on two-factor sign-in: returns a secret for an authenticator app (shown once)",
  response: z.object({ secret: z.string(), otpauthUrl: z.string() }),
});

export const confirmMfa = endpoint({
  id: "me.mfa.confirm",
  method: "POST",
  path: "/api/v1/me/mfa/confirm",
  auth: "user",
  summary: "Finish turning on two-factor sign-in with a code from the authenticator app",
  body: z.object({ code: SixDigitCode }),
  response: Ok,
});
