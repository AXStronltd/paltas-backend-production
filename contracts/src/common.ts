// Building blocks every contract uses: dates, money, currency, ids and the error format.
import { z } from "zod";

/** A real calendar date, "YYYY-MM-DD" (2026-02-31 is refused). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-14")
  .refine((d) => {
    const t = new Date(d + "T00:00:00Z");
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }, "That date does not exist");
/** A calendar month, "YYYY-MM" (01–12). */
export const IsoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-10");
/** A moment in time, ISO 8601 with time zone. */
export const IsoDateTime = z.string();

/** Three-letter ISO 4217 currency code, e.g. "KES". */
export const Currency = z.string().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code");

/**
 * Money is always an integer number of minor units (cents) plus a currency, so no amount is ever rounded by
 * floating-point arithmetic. KES 1,250.50 is { amountMinor: 125050, currency: "KES" }.
 */
export const MinorUnits = z.number().int().safe();
export const PositiveMinorUnits = MinorUnits.positive();

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Email looks wrong");

/** Typing CONFIRM is how a person confirms a price, a cancellation or anything else that costs money. */
export const Confirm = z.literal("CONFIRM", { error: 'Confirm by sending confirm: "CONFIRM"' });

/** A short human reason kept in the audit log. */
export const Reason = z.string().trim().min(5, "Record the reason (at least 5 characters)").max(500);

export const Ok = z.object({ ok: z.literal(true) });

/** Every error the API returns has this shape. `code` is stable; `message` is for people. */
export const ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_SIGNED_IN",
  "FORBIDDEN",
  "ROLE_NOT_ALLOWED",
  "STAFF_ROLE_NOT_ALLOWED",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "PAYMENT_REQUIRED",
  "SUBSCRIPTION_INACTIVE",
  "MODULE_NOT_ENTITLED",
  "ALLOWANCE_EXCEEDED",
  "TOO_MANY_ATTEMPTS",
  "PERIOD_CLOSED",
  "SEPARATION_OF_DUTIES",
  "SERVER_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
