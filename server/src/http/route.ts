/*
 * Registers a handler for an endpoint defined in @paltas/contracts. For every request it:
 *   1. checks who is calling (endpoint.auth): signed-in user, PALTAS staff, or a signed payment webhook;
 *   2. validates params, query and body against the contract (400 with the problems if they don't match);
 *   3. runs the handler;
 *   4. validates the response against the contract — which also drops any field the contract does not list,
 *      so internal columns can never leak.
 *
 * Handlers therefore receive typed, already-checked input and only contain business logic.
 */
import type { EndpointAuth, EndpointDefinition, z } from "@paltas/contracts";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionUser } from "../core/identity/identity.service.js";
import { fail } from "./errors.js";
import { PUBLIC_READ_IDS, rateLimitFor, type RateLimits } from "./rate-limits.js";

type Def = EndpointDefinition<
  z.ZodType<Record<string, unknown>>,
  z.ZodType<Record<string, unknown>>,
  z.ZodType,
  z.ZodType,
  EndpointAuth
>;

type UserFor<A extends EndpointAuth> = A extends "user" | "staff" ? SessionUser : null;

export interface RequestContext<E extends Def> {
  params: z.output<E["params"]>;
  query: z.output<E["query"]>;
  body: z.output<E["body"]>;
  user: UserFor<E["auth"]>;
  ip: string;
  /** The exact bytes received (signed webhooks are verified against these). */
  rawBody: Buffer | null;
  header(name: string): string | undefined;
}

export interface Route {
  endpoint: Def;
  handler(req: RequestContext<Def>): Promise<unknown>;
  /** The handler answers with a stream (large exports) instead of one object. */
  stream?: true;
  /** Per-route upload cap; the default JSON limit remains unchanged. */
  bodyLimit?: number;
}

export interface StreamedAnswer {
  /** JSON written as it is produced; its shape is the endpoint's response contract. */
  body: Readable;
  filename: string;
  contentType?: "image/jpeg";
}

/** Bind a handler to its endpoint definition. */
export function route<E extends Def>(
  endpoint: E,
  handler: (req: RequestContext<E>) => Promise<z.input<E["response"]>>,
): Route {
  return { endpoint, handler: handler as unknown as Route["handler"] };
}

/**
 * Bind a handler whose answer is streamed as it is produced (e.g. an organisation's data export). The request is
 * checked exactly like any other; the body follows the endpoint's response contract but is not held in memory to be
 * validated as a whole.
 */
export function streamRoute<E extends Def>(
  endpoint: E,
  handler: (req: RequestContext<E>) => Promise<StreamedAnswer>,
): Route {
  return { endpoint, handler: handler as unknown as Route["handler"], stream: true };
}

export interface RouteDependencies {
  /** Look up the session for a bearer token (null if unknown or expired). */
  authenticate(token: string): Promise<SessionUser | null>;
  /** Verify a payment provider's signature; throws if it is not valid. */
  verifyWebhook(provider: string, signatureHeader: string | undefined, rawBody: Buffer): void;
}

function parse<T extends z.ZodType>(schema: T, value: unknown, part: string): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const problems = r.error.issues.map((i) => ({ field: [part, ...i.path].join("."), problem: i.message }));
    throw fail.invalid(problems.map((p) => `${p.field}: ${p.problem}`).join("; "), { problems });
  }
  return r.data;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
  routes: Route[],
  limits: RateLimits,
  publicCacheSeconds = 0,
) {
  const seen = new Set<string>();
  for (const { endpoint, handler, stream, bodyLimit } of routes) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (seen.has(key)) throw new Error(`Two handlers for ${key}`);
    seen.add(key);
    const rateLimit = rateLimitFor(endpoint, limits);

    app.route({
      method: endpoint.method,
      url: endpoint.path,
      ...(bodyLimit ? { bodyLimit } : {}),
      config: rateLimit ? { rateLimit } : {},
      handler: async (request: FastifyRequest, reply) => {
        if (
          endpoint.id.startsWith("auth.staffEnrollment.") ||
          endpoint.id.startsWith("auth.staffPasswordReset.") ||
          endpoint.id === "auth.staffBackup.login"
        ) {
          reply.header("Cache-Control", "no-store");
          reply.header("Referrer-Policy", "no-referrer");
        }
        const user = await caller(endpoint, request, deps);
        const ctx: RequestContext<Def> = {
          params: parse(endpoint.params, request.params ?? {}, "params"),
          query: parse(endpoint.query, request.query ?? {}, "query"),
          body: parse(endpoint.body, bodyOf(endpoint, request.body), "body"),
          user: user as never,
          ip: request.ip,
          rawBody: (request as RawBodyRequest).rawBody ?? null,
          header: (name) => {
            const v = request.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          },
        };
        const out = await handler(ctx);
        if (stream) {
          const { body, filename, contentType } = out as StreamedAnswer;
          reply.status(endpoint.status);
          reply.header("Content-Type", contentType ?? "application/json; charset=utf-8");
          if (contentType) reply.header("Cache-Control", "no-store");
          reply.header(
            "Content-Disposition",
            `${contentType ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
          );
          return reply.send(body);
        }
        const checked = endpoint.response.safeParse(out);
        if (!checked.success) {
          // a response can hold secrets (a temporary password, a reset link): nothing derived from it is logged
          request.log.error(
            { route: `${request.method} ${request.routeOptions.url}`, issueCount: checked.error.issues.length },
            "Response does not match its contract",
          );
          throw new Error(`Response for ${request.method} ${request.routeOptions.url} does not match its contract`);
        }
        reply.status(endpoint.status);
        // the same answer for everyone: browsers and the front end's CDN may keep it for a while
        if (PUBLIC_READ_IDS.has(endpoint.id) && publicCacheSeconds > 0)
          reply.header("Cache-Control", `public, max-age=${publicCacheSeconds}`);
        return checked.data;
      },
    });
  }
}

/** An endpoint without a body also accepts an empty JSON object, as many HTTP clients send `{}` by default. */
function bodyOf(endpoint: Def, body: unknown): unknown {
  const empty = body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  return empty && endpoint.body.safeParse(undefined).success ? undefined : (body ?? undefined);
}

export interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(["me.get", "me.changePassword", "auth.logout"]);

async function caller(endpoint: Def, request: FastifyRequest, deps: RouteDependencies): Promise<SessionUser | null> {
  switch (endpoint.auth) {
    case "public":
      return null;
    case "signed-webhook": {
      const provider = String((request.params as Record<string, string>).provider ?? "").toLowerCase();
      const raw = (request as RawBodyRequest).rawBody ?? Buffer.alloc(0);
      deps.verifyWebhook(provider, request.headers["x-paltas-signature"] as string | undefined, raw);
      return null;
    }
    case "user":
    case "staff": {
      const m = /^Bearer\s+(\S+)$/.exec(request.headers.authorization ?? "");
      const user = m?.[1] ? await deps.authenticate(m[1]) : null;
      if (!user) throw fail.notSignedIn();
      // staff endpoints are invisible to everyone else
      if (endpoint.auth === "staff" && !user.staffRole) throw fail.notFound("No such endpoint");
      // a temporary password must be replaced before anything else
      if (user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(endpoint.id)) {
        throw fail.forbidden("Change your temporary password first", { mustChangePassword: true });
      }
      return user;
    }
  }
}
