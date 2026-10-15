/*
 * Request rate limits for sensitive routes (per minute):
 *   - sign-in: per address (LOGIN_RATE_LIMIT_PER_MINUTE);
 *   - provider webhooks: per address (WEBHOOK_RATE_LIMIT_PER_MINUTE);
 *   - password and two-factor changes, invitations, adding members, every PALTAS staff change, data exports,
 *     bank statement work, sign-up, verification and upgrades: per signed-in person (their session), else per
 *     address (SENSITIVE_RATE_LIMIT_PER_MINUTE). Sign-up also has hourly / daily limits in core/signup.
 * Everything else is not limited here (the reverse proxy limits overall traffic).
 */
import { createHash } from "node:crypto";
import type { EndpointDefinition } from "@paltas/contracts";
import type { FastifyRequest } from "fastify";

export interface RateLimits {
  login: number;
  sensitive: number;
  webhook: number;
}

const SENSITIVE_IDS = new Set([
  "me.changePassword",
  "me.mfa.start",
  "me.mfa.confirm",
  "me.invitations.accept",
  "me.invitations.decline",
  "members.add",
  "ops.orgs.export",
  "paymentProviders.bank.import",
  "paymentProviders.bank.confirm",
  "paymentProviders.bank.ignore",
  "signup.create",
  "signup.verify",
  "signup.resend",
  "subscription.upgrade",
  "subscription.export",
]);

/** Per person when signed in (a hash of the session token, never the token), else per address. */
export function personOrAddress(req: FastifyRequest): string {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
  return m?.[1] ? "s:" + createHash("sha256").update(m[1]).digest("hex").slice(0, 32) : "ip:" + req.ip;
}

export function rateLimitFor(e: Pick<EndpointDefinition, "id" | "auth" | "method">, limits: RateLimits) {
  const minute = "1 minute";
  if (e.id === "auth.login") return { max: limits.login, timeWindow: minute };
  if (e.auth === "signed-webhook") return { max: limits.webhook, timeWindow: minute };
  if (SENSITIVE_IDS.has(e.id) || (e.auth === "staff" && e.method !== "GET"))
    return { max: limits.sensitive, timeWindow: minute, keyGenerator: personOrAddress };
  return null;
}
