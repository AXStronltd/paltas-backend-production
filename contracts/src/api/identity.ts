// Sign-in, sessions, the signed-in person, password and two-factor set-up. Also the health check.
import { z } from "zod";
import { Product, Role, StaffPermission, StaffRole } from "../access.js";
import { Email, IsoDate, Ok } from "../common.js";
import { endpoint } from "../endpoint.js";

export const SignedInUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  staff: z.boolean(),
  staffRole: StaffRole.nullable(),
  /** What a PALTAS staff member may change in the Super Admin portal (empty for clients and view-only staff). */
  staffPermissions: z.array(StaffPermission).default([]),
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
  summary:
    "Is the server up and does its database answer (503 otherwise); which billing mode it uses. Render polls this.",
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

/** Where one product subscription stands in its trial (the shared rules' entitlements.trialState). */
export const SubscriptionTrial = z.object({
  phase: z.enum(["trial", "grace", "expired"]),
  trialEnds: IsoDate,
  graceEnds: IsoDate,
  daysLeft: z.number().int().min(0),
  graceDaysLeft: z.number().int().min(0),
});

export const MyOrganisation = z.object({
  id: z.string(),
  name: z.string(),
  products: z.array(Product),
  role: Role,
  /** Trial days and grace left, per product subscription that is (or was) a trial. */
  trials: z.array(SubscriptionTrial.extend({ product: Product })),
  /**
   * required: a self-service organisation whose administrator has not verified the e-mail address yet (upgrading,
   * paying and inviting members wait for it); verified; or not_required (onboarded by PALTAS staff).
   */
  emailVerification: z.enum(["required", "verified", "not_required"]),
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

/** The same answer whether or not the address has an account, so it never tells anyone who uses PALTAS. */
export const PasswordResetReceived = z.object({ received: z.literal(true), message: z.string() });

export const requestPasswordReset = endpoint({
  id: "auth.passwordReset.request",
  method: "POST",
  path: "/api/v1/public/password-reset",
  auth: "public",
  summary:
    "Ask for a password reset link by e-mail. The answer is the same whether or not the address has an account; " +
    "the link (single use, short-lived) goes through the e-mail outbox. Limited per address and per e-mail.",
  body: z.object({ email: Email }),
  response: PasswordResetReceived,
});

export const completePasswordReset = endpoint({
  id: "auth.passwordReset.complete",
  method: "POST",
  path: "/api/v1/public/password-reset/complete",
  auth: "public",
  summary: "Set a new password with the token from the reset link (works once, expires); every session is signed out",
  body: z.object({ token: z.string().trim().min(20).max(200), newPassword: NewPassword }),
  response: Ok,
});

/** A hosting-operator grant plus mailbox proof. These endpoints never create an administrative session. */
export const beginStaffEnrollment = endpoint({
  id: "auth.staffEnrollment.begin",
  method: "POST",
  path: "/api/v1/auth/staff-enrollment/begin",
  auth: "public",
  summary: "Verify the operator-issued grant and mailbox code; display a new pending authenticator only",
  body: z.object({ token: z.string().min(32).max(200), emailCode: z.string().regex(/^\d{8}$/) }),
  response: z.object({ secret: z.string(), otpauthUrl: z.string(), expiresAt: z.string() }),
});
export const completeStaffEnrollment = endpoint({
  id: "auth.staffEnrollment.complete",
  method: "POST",
  path: "/api/v1/auth/staff-enrollment/complete",
  auth: "public",
  summary: "Verify first authenticator code, set password, consume grant and revoke old sessions atomically",
  body: z.object({ token: z.string().min(32).max(200), code: SixDigitCode, newPassword: NewPassword }),
  response: z.object({ ok: z.literal(true), backupCodes: z.array(z.string()).length(10) }),
});
export const loginWithBackup = endpoint({
  id: "auth.staffBackup.login",
  method: "POST",
  path: "/api/v1/auth/staff-backup/login",
  auth: "public",
  summary: "Staff login with password plus one single-use backup code",
  body: z.object({ email: Email, password: z.string().min(1).max(200), backupCode: z.string().min(10).max(100) }),
  response: login.response,
});
