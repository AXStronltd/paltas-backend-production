/*
 * Builds the HTTP server: security headers, CORS, JSON parsing (keeping the raw bytes for webhook signatures),
 * rate limiting on sign-in, uniform error answers, and every route from the core and the products.
 */
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { allEndpoints } from "@paltas/contracts";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";
import { adminRoutes } from "./core/admin/admin.routes.js";
import { contactsRoutes } from "./core/contacts/contacts.routes.js";
import { opsRoutes } from "./core/admin/ops.routes.js";
import { createCoreServices, type CoreServices } from "./core/core-services.js";
import { identityRoutes } from "./core/identity/identity.routes.js";
import { ledgerRoutes } from "./core/ledger/ledger.routes.js";
import { migrationRoutes } from "./core/migration/migration.routes.js";
import { notificationsRoutes } from "./core/notifications/notifications.routes.js";
import { organisationsRoutes } from "./core/organisations/organisations.routes.js";
import { verifySignature } from "./core/payments/signature.js";
import { paymentsRoutes } from "./core/payments/payments.routes.js";
import { providersRoutes } from "./core/payments/providers.routes.js";
import { signupRoutes } from "./core/signup/signup.routes.js";
import { stripeRoutes } from "./core/subscriptions/stripe.routes.js";
import { subscriptionsRoutes } from "./core/subscriptions/subscriptions.routes.js";
import { connect, type Database } from "./db/database.js";
import { migrate } from "./db/migrate.js";
import { ApiError, fail, fromDatabaseError } from "./http/errors.js";
import { LOG_REDACT } from "./http/logging.js";
import { registerRoutes, type RawBodyRequest, type Route } from "./http/route.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { secretBox } from "./lib/secret-box.js";
import { PRODUCTS } from "./products/index.js";
import { ProductRegistry, type ProductModule } from "./products/registry.js";

export interface App {
  server: FastifyInstance;
  ctx: AppContext;
  core: CoreServices;
  clock: Clock & { setToday(d: string | null): void };
  /** Every endpoint this server registered (core and products), for checks and API docs. */
  endpoints: Route["endpoint"][];
  close(): Promise<void>;
}

export interface AppOptions {
  /** Use an existing database connection (tests). */
  db?: Database;
  /** Products to run (default: all in products/index.ts). */
  products?: ProductModule[];
  /** Run migrations at start-up (default true). */
  migrate?: boolean;
  /** Tests only: reach the e-mail provider through local fake servers (a fetch, the fake SMTP certificate). */
  emailTransport?: AppContext["emailTransport"];
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<App> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      redact: LOG_REDACT,
    },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    return503OnClosing: true,
  });
  const db = options.db ?? connect(config.databaseUrl, config.databasePoolSize);
  if (options.migrate !== false) await migrate(db);

  const clock = systemClock(config.fixedToday);
  const ctx: AppContext = {
    config,
    db,
    clock,
    log: server.log,
    secrets: secretBox(config.secretsKey),
    products: new ProductRegistry(options.products ?? PRODUCTS),
    ...(options.emailTransport ? { emailTransport: options.emailTransport } : {}),
  };
  const core = createCoreServices(ctx);

  // ---- request handling
  // an API serves no pages: nothing may be framed, scripted or loaded from its responses
  await server.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    frameguard: { action: "deny" },
  });
  await server.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  await server.register(rateLimit, {
    global: false,
    errorResponseBuilder: (req) =>
      fail.tooManyAttempts(
        req.url.startsWith("/api/v1/auth/login")
          ? "Too many sign-in attempts from this address — wait a minute and try again"
          : "Too many requests — wait a minute and try again",
      ),
  });
  server.addHook("onSend", async (_req, reply, payload) => {
    // nothing is cached, except the public read-only answers a route marked cacheable (route.ts)
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  // keep the exact bytes: webhook signatures are computed over them
  server.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      done(fail.invalid("Body is not valid JSON"), undefined);
    }
  });

  // ---- errors: one shape for everything
  server.setErrorHandler((err: FastifyError | ApiError | Error, req, reply) => {
    const known = err instanceof ApiError ? err : (fromDatabaseError(err) ?? frameworkError(err as FastifyError));
    if (known) {
      return reply.status(known.status).send({
        error: {
          code: known.code,
          message: known.message,
          ...(known.details === undefined ? {} : { details: known.details }),
        },
      });
    }
    req.log.error({ err }, "Unexpected error");
    return reply
      .status(500)
      .send({ error: { code: "SERVER_ERROR", message: "Something went wrong — it has been logged" } });
  });
  const patterns = allEndpoints().map((e) => new RegExp("^" + e.path.replace(/:[A-Za-z_]+/g, "[^/]+") + "/?$"));
  server.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const knownPath = patterns.some((re) => re.test(path));
    const err = knownPath
      ? new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed")
      : fail.notFound("No such endpoint");
    return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
  });

  // ---- routes: core first, then each product
  const routes: Route[] = [
    ...identityRoutes(ctx, core.identity, core.passwordReset),
    ...organisationsRoutes(core),
    ...subscriptionsRoutes(core),
    ...stripeRoutes(ctx, core),
    ...paymentsRoutes(core.payments),
    ...ledgerRoutes(core),
    ...adminRoutes(core),
    ...migrationRoutes(core),
    ...opsRoutes(ctx, core),
    ...notificationsRoutes(core, config),
    ...providersRoutes(core),
    ...contactsRoutes(core),
    ...signupRoutes(core),
    ...ctx.products.modules.flatMap((m) => m.routes(ctx, core)),
  ];
  registerRoutes(
    server,
    {
      authenticate: (token) => core.identity.authenticate(token),
      verifyWebhook: (provider, header, raw) => verifySignature(config.webhookSecrets, provider, header, raw),
    },
    routes,
    {
      login: config.loginRateLimitPerMinute,
      sensitive: config.sensitiveRateLimitPerMinute,
      webhook: config.webhookRateLimitPerMinute,
      publicRead: config.publicRead.perMinute,
    },
    config.publicRead.cacheSeconds,
  );

  // scheduled jobs: the platform's own (registered by the core) and each product's
  core.scheduler.register(ctx.products.modules.flatMap((m) => m.scheduledJobs?.(ctx, core) ?? []));
  await core.scheduler.ensurePlatformJobs();

  // The background workers (data-migration batches, scheduled jobs) run in this process. Shutdown order:
  // server.close() stops taking requests and waits for those in flight, then these hooks stop the workers (each
  // finishes its current batch or run), and only then does close() end the database pool.
  server.addHook("onClose", async () => {
    await Promise.all([core.migration.worker.stop(), core.schedulerWorker.stop()]);
  });
  await server.ready();
  if (config.migration.worker) core.migration.worker.start();
  if (config.scheduler.worker) core.schedulerWorker.start();
  return {
    server,
    ctx,
    core,
    clock,
    endpoints: routes.map((r) => r.endpoint),
    close: async () => {
      await server.close();
      if (!options.db) await db.close();
    },
  };
}

/** Fastify's own errors (bad JSON, body too large, wrong content type) as API errors. */
function frameworkError(err: FastifyError): ApiError | null {
  if (!err || typeof err.statusCode !== "number" || err.statusCode >= 500) return null;
  if (err.statusCode === 429) return fail.tooManyAttempts(err.message);
  if (err.statusCode === 413) return fail.invalid("Request body too large");
  if (err.statusCode === 415) return fail.invalid("Send JSON (Content-Type: application/json)");
  return fail.invalid(err.message);
}

export type { Config };
