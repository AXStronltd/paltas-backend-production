/* ====================================================================== *
 * ERRORS THE CALLER CAN ACT ON.
 *
 * Every error this API returns has a machine-readable `error` and a sentence
 * a person could actually read. "Bad request" tells a developer nothing and a
 * customer less; "endDate is before startDate" tells both of them what to do.
 *
 * Nothing internal is ever returned — no stack, no SQL, no Prisma message.
 * Those go to the log, where they belong, with a reference the caller can
 * quote so the two can be matched up.
 * ====================================================================== */

import { $Enums } from "@prisma/client";

import type { ErrorRequestHandler } from "express";

/**
 * The extra lines under the sentence.
 *
 * Always strings, because they are read by a person: `clean()` produces one
 * per refused field, and the create routes produce one per missing reference.
 * Typing it as `unknown` would let an object through, and an object rendered
 * into a response body is how internal shapes leak.
 */
export type ErrorDetails = string[];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    /* Without this, `err.name` is "Error" on a subclass and the log says
       nothing about which kind was thrown. */
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: ErrorDetails): ApiError =>
  new ApiError(400, "bad_request", msg, details);
export const unauthorized = (msg?: string): ApiError =>
  new ApiError(401, "unauthorized", msg || "Sign in first.");
export const forbidden = (msg?: string): ApiError =>
  new ApiError(403, "forbidden", msg || "This account may not do that.");
export const notFound = (msg?: string): ApiError =>
  new ApiError(404, "not_found", msg || "That does not exist.");
export const conflict = (msg: string): ApiError =>
  new ApiError(409, "conflict", msg);

/*
 * A capability this installation does not have.
 *
 * 503 and not 500, because nothing is broken: no tokenisation provider is
 * connected, and the honest answer to "issue these units" is "there is nothing
 * here that can". A 500 would say the service failed, and somebody would go
 * looking for a bug that is not there.
 */
export const unavailable = (msg: string): ApiError =>
  new ApiError(503, "unavailable", msg);

/*
 * NOT FOUND RATHER THAN FORBIDDEN, FOR SOMEBODY ELSE'S RECORD.
 *
 * If asking for another company's promotion returned 403, the 403 itself
 * confirms the promotion exists. Two companies on the same platform can then
 * enumerate each other's work by watching which ids answer differently. So a
 * record you may not see is a record that does not exist, as far as you are
 * concerned.
 */
export const hidden = (): ApiError =>
  notFound("That does not exist, or this account cannot see it.");

/* ====================================================================== *
 * ERRORS FROM OUTSIDE THIS FILE THAT STILL KNOW WHAT THEY ARE.
 * ====================================================================== */

/**
 * What an integration adapter throws.
 *
 * SupplyUnavailable, PaymentsUnavailable, NotReadyToCharge and the
 * tokenisation and channel errors are not ApiError — they live in their own
 * modules and carry `status` and `expose: true` instead. This is the shape
 * the handler below will repeat back to a caller, and NOTHING ELSE IS.
 */
export interface ExposableError {
  readonly expose: true;
  readonly status: number;
  readonly name?: string;
  readonly message: string;
  readonly details?: ErrorDetails;
}

/**
 * THE BASE FOR EVERY ERROR AN ADAPTER THROWS.
 *
 * ChannelUnavailable, SupplyUnavailable, PaymentsUnavailable, NotReadyToCharge
 * and the tokenisation errors all wrote the same four lines by hand:
 *
 *     this.name = "…"; this.status = 503; this.expose = true;
 *
 * Four copies of a contract that `isExposable()` below reads, and nothing
 * checked that they matched it. One of them setting `expected` instead of
 * `expose` — which an earlier draft did — meant an operator was told
 * "something went wrong at our end", the one thing that is NOT true when a
 * capability is simply absent.
 *
 * Extending this makes the contract a type rather than a convention. They
 * stay separate classes because `instanceof` is how the adapters tell their
 * own failures apart from each other's.
 */
export class ExposableFailure extends Error implements ExposableError {
  readonly expose = true as const;
  readonly status: number;
  readonly details: ErrorDetails | undefined;

  constructor(name: string, status: number, message: string, details?: ErrorDetails) {
    super(message);
    /* Read by the handler to name the error in the response body, and lost
       on a subclass unless it is set. */
    this.name = name;
    this.status = status;
    this.details = details;
  }
}

/**
 * Is this safe to say out loud?
 *
 * Guarded on BOTH the explicit flag and a client-safe status, so an exception
 * that merely happens to have a `status` property — a database driver, an HTTP
 * client — cannot talk its way into a response body.
 */
/**
 * WHAT PRISMA THROWS, NARROWED.
 *
 * Prisma's own error classes are a runtime import, and this service already
 * had two hand-written copies of this three-line check — one in
 * http/resource.ts and one in routes/products.ts — because importing the
 * class where all that is wanted is a code string pulls the client into
 * modules that otherwise need none of it.
 *
 * Named here once so the third caller did not become a third copy. The one
 * in resource.ts stays as it is: it narrows to a richer shape carrying
 * `meta`, which is what it needs to name the field a unique constraint
 * fired on.
 */
export function isPrismaError(e: unknown): e is { code: string } {
  return typeof e === "object" && e !== null
    && typeof (e as Record<string, unknown>)["code"] === "string";
}

function isExposable(err: unknown): err is ExposableError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e["expose"] !== true) return false;
  if (typeof e["status"] !== "number" || !Number.isInteger(e["status"])) return false;
  const status = e["status"];
  return (status >= 400 && status < 500) || status === 503;
}

/**
 * Whatever was thrown, as a sentence.
 *
 * `catch (e)` gives `unknown` under strict TypeScript, and this service does
 * it 202 times. Reaching for `e.message` on an unknown is exactly the cast
 * this migration is meant to avoid — and the check is real rather than
 * ceremonial, because `throw "a string"` is legal JavaScript and a library
 * somewhere does it.
 */
export function messageOf(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

/** The narrowest thing this file needs from a logger. */
export interface ErrorLog {
  error: (...args: unknown[]) => void;
}

/** The last thing in the middleware chain. Nothing throws past this. */
export function errorHandler(log: ErrorLog): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }

    /*
     * The adapters' own errors. Before this branch existed they fell through
     * to the generic 500 below, and that mattered: a guest whose card had not
     * gone through was told "Something went wrong at our end" instead of
     * "payment not completed", and a company not yet verified by Stripe was
     * told the same. Both are the caller's situation, not a fault in this
     * service, and both are actionable only if said out loud.
     */
    if (isExposable(err)) {
      res.status(err.status).json({
        error: String(err.name || "error")
          .replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }

    /* Anything else is a bug in this service. The caller gets a reference and
       nothing else; the log gets everything. */
    const ref = Math.random().toString(36).slice(2, 10);
    log.error(`[${ref}] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({
      error: "internal",
      message: "Something went wrong at our end. Quote reference " + ref + " if you report it.",
      reference: ref,
    });
  };
}

/* ====================================================================== *
 * A CALLER'S STRING, CHECKED AGAINST AN ENUM THE SCHEMA DEFINES.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────
 *
 * A filter like `?status=ACTIVE` was read with `String(req.query.status)`
 * and handed straight to Prisma. That works for every value somebody types
 * correctly, and for everything else Prisma refuses the query with an
 * exception this service reports as a 500 — so a typo in a query string
 * reads as "PALTAS is broken" rather than "that is not a status".
 *
 * The values are read from the GENERATED CLIENT rather than a list copied
 * into this file, so an enum extended in schema.prisma is accepted here the
 * moment `prisma generate` runs, and one removed stops being accepted. A
 * hand-written copy is a second source of truth that drifts silently and is
 * only noticed when a legitimate filter starts being refused.
 * ====================================================================== */

/**
 * The caller's value, or a 400 naming what was allowed.
 *
 * Returns `undefined` for an absent filter — a filter nobody sent is not a
 * filter that failed, and the caller then simply does not narrow by it.
 */
export function enumParam<K extends keyof typeof $Enums>(
  name: K,
  raw: unknown,
  what: string,
): (typeof $Enums)[K][keyof (typeof $Enums)[K]] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const values = $Enums[name] as Record<string, string>;
  const asked = String(raw).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(values, asked)) {
    throw badRequest(
      `“${String(raw)}” is not a ${what}. One of: ${Object.keys(values).join(", ")}.`);
  }
  return asked as (typeof $Enums)[K][keyof (typeof $Enums)[K]];
}
