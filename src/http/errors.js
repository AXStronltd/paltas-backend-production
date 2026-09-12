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

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, "bad_request", msg, details);
export const unauthorized = (msg) => new ApiError(401, "unauthorized", msg || "Sign in first.");
export const forbidden = (msg) => new ApiError(403, "forbidden", msg || "This account may not do that.");
export const notFound = (msg) => new ApiError(404, "not_found", msg || "That does not exist.");
export const conflict = (msg) => new ApiError(409, "conflict", msg);
/*
 * A capability this installation does not have.
 *
 * 503 and not 500, because nothing is broken: no tokenisation provider is
 * connected, and the honest answer to "issue these units" is "there is nothing
 * here that can". A 500 would say the service failed, and somebody would go
 * looking for a bug that is not there.
 */
export const unavailable = (msg) => new ApiError(503, "unavailable", msg);

/*
 * NOT FOUND RATHER THAN FORBIDDEN, FOR SOMEBODY ELSE'S RECORD.
 *
 * If asking for another company's promotion returned 403, the 403 itself
 * confirms the promotion exists. Two companies on the same platform can then
 * enumerate each other's work by watching which ids answer differently. So a
 * record you may not see is a record that does not exist, as far as you are
 * concerned.
 */
export const hidden = () => notFound("That does not exist, or this account cannot see it.");

/** The last thing in the middleware chain. Nothing throws past this. */
export function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
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
