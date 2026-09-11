/* The web plumbing, in one import for the places that compose all of it.
   Each concern still lives in its own file — this only saves server.js four
   import lines and makes the layering obvious at a glance. */
export { errorHandler, ApiError, badRequest, conflict, forbidden, hidden,
         notFound, unauthorized } from "./errors.js";
export { cors } from "./cors.js";
export { rateLimit } from "./rate-limit.js";
export { securityHeaders } from "./security-headers.js";
export { resourceRouter, clean } from "./resource.js";
export { withSession, requireSession, requireOrganization,
         requireOpenSubscription, requireProduct } from "./session.js";
