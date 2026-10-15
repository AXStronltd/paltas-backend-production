/*
 * API errors. Throw `fail.*(…)` anywhere; the error handler turns it into
 *   { "error": { "code": "...", "message": "...", "details": … } }
 * with the right HTTP status. Database rule violations (ledger, uniqueness) are translated here too, so the
 * database's own guarantees reach the user as clear messages.
 */
import type { ErrorCode } from "@paltas/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const fail = {
  invalid: (message: string, details?: unknown) => new ApiError(400, "INVALID_REQUEST", message, details),
  notSignedIn: (message = "Sign in first") => new ApiError(401, "NOT_SIGNED_IN", message),
  forbidden: (message = "You do not have permission for this", details?: unknown) =>
    new ApiError(403, "FORBIDDEN", message, details),
  roleNotAllowed: (message: string) => new ApiError(403, "ROLE_NOT_ALLOWED", message),
  staffRoleNotAllowed: () => new ApiError(403, "STAFF_ROLE_NOT_ALLOWED", "Your PALTAS role cannot do this"),
  /** Someone else's records look exactly like records that do not exist. */
  notFound: (message = "Not found") => new ApiError(404, "NOT_FOUND", message),
  conflict: (message: string, details?: unknown) => new ApiError(409, "CONFLICT", message, details),
  paymentRequired: (message: string, details?: unknown) => new ApiError(402, "PAYMENT_REQUIRED", message, details),
  subscriptionInactive: (message: string, details?: unknown) =>
    new ApiError(402, "SUBSCRIPTION_INACTIVE", message, details),
  moduleNotEntitled: (message: string, details?: unknown) => new ApiError(403, "MODULE_NOT_ENTITLED", message, details),
  allowanceExceeded: (message: string, details?: unknown) => new ApiError(402, "ALLOWANCE_EXCEEDED", message, details),
  tooManyAttempts: (message: string) => new ApiError(429, "TOO_MANY_ATTEMPTS", message),
  periodClosed: (message: string) => new ApiError(409, "PERIOD_CLOSED", message),
  separationOfDuties: (message: string) => new ApiError(403, "SEPARATION_OF_DUTIES", message),
};

interface PgError {
  code?: string;
  message?: string;
  constraint?: string;
}

/** Turn a PostgreSQL error into an ApiError when it is a business rule; otherwise null (a real server error). */
export function fromDatabaseError(e: unknown): ApiError | null {
  const err = e as PgError;
  if (!err || typeof err.code !== "string") return null;
  switch (err.code) {
    case "PA001":
      return fail.periodClosed(err.message ?? "That month is closed");
    case "PA002":
      return fail.invalid(err.message ?? "The journal does not balance");
    case "PA003":
    case "PA005":
      return fail.conflict(err.message ?? "This record cannot be changed");
    case "23505":
      return fail.conflict("This already exists");
    case "23514":
      if (err.constraint === "manual_journal_needs_second_person")
        return fail.separationOfDuties("A journal must be approved by someone other than the person who prepared it");
      if (err.constraint === "account_code_matches_type")
        return fail.invalid(
          "The account code's first digit must match its type (1 asset, 2 liability, 3 equity, 4 income, 5–9 expense)",
        );
      return fail.invalid("A value is not allowed here");
    case "23503":
      return fail.invalid("A referenced record does not exist");
    default:
      return null;
  }
}
