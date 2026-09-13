/* ====================================================================== *
 * THE PALTAS API.
 *
 * Sessions, organizations and the promotion workflow — the first slice of the
 * contract in the frontend's backend.md, built so the frontend needs no change
 * above `PromoAPI` and `PALTAS.Session`.
 * ====================================================================== */

import express from "express";
import cookieParser from "cookie-parser";

import { config } from "./config.js";
import { db, closeDb } from "./db.js";
import {
  cors, errorHandler, notFound, rateLimit, securityHeaders, withSession,
} from "./http/index.js";
import { pruneExpiredSessions } from "./auth/sessions.js";
import { authRoutes } from "./routes/auth.js";
import { organizationRoutes } from "./routes/organizations.js";
import { promotionRoutes } from "./routes/promotions.js";
import { productRoutes } from "./routes/products.js";
import { marketRoutes } from "./routes/market.js";
import { guestRoutes } from "./routes/guest.js";
import { platformRoutes } from "./routes/platform.js";
import { investmentRoutes } from "./routes/investments.js";

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

export function createApp() {
  const app = express();

  /* Render terminates TLS at its edge, so the client IP and the protocol
     arrive in headers. Without this, every request looks like it came from
     the proxy — which breaks rate limiting and makes secure cookies look
     insecure. */
  app.set("trust proxy", config.trustProxyHops);
  app.disable("x-powered-by");

  /* ------------------------------------------------------------------ *
   * MONEY ON THE WIRE.
   *
   * Money is stored as BigInt — see prisma/migrations/…_money_bigint. A
   * BigInt cannot be JSON-serialised: `JSON.stringify({a: 1n})` throws
   * "Do not know how to serialize a BigInt", which would be a 500 on every
   * response carrying an amount.
   *
   * So it goes out as a JSON NUMBER, not a string. The frontend reads money
   * as numbers and does arithmetic on it in 135 screens; sending strings
   * would be exact and would break every one of them. A number is exact
   * here too, up to Number.MAX_SAFE_INTEGER — 9,007,199,254,740,991 minor
   * units, or about ninety trillion major. The largest figure this platform
   * actually holds is 5.4e11, so the margin is roughly four orders of
   * magnitude.
   *
   * AND IT REFUSES RATHER THAN ROUNDS. Above MAX_SAFE_INTEGER a JS number
   * silently stops being exact: 9007199254740993 becomes …92. Money that is
   * quietly wrong is worse than a request that failed, so that case throws
   * and the error handler turns it into a 500 naming the field. It should
   * never happen; if it ever does, somebody needs to know rather than to
   * reconcile a ledger that disagrees with itself.
   * ------------------------------------------------------------------ */
  app.set("json replacer", function (key, value) {
    if (typeof value !== "bigint") return value;
    if (value > 9007199254740991n || value < -9007199254740991n) {
      throw new Error(
        `${key} is ${value} minor units, which is past the point a JSON number ` +
        `stays exact. Refusing to send a figure that would be silently wrong.`);
    }
    return Number(value);
  });

  app.use(securityHeaders());
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, max: 600 }));
  app.use(withSession());

  /* Render polls this. It touches the database on purpose: a service that
     answers "healthy" while its database is unreachable has told you nothing
     worth knowing. */
  app.get("/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ ok: true, service: "paltas-api", env: config.env });
    } catch (e) {
      res.status(503).json({ ok: false, error: "database_unreachable" });
    }
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "paltas-api",
      docs: "See backend.md in the paltas-frontend repository.",
      signIn: config.publicUrl + "/auth/google",
    });
  });

  app.use("/auth", authRoutes);
  app.use("/organizations", organizationRoutes);
  app.use("/promotions", promotionRoutes);

  /* ------------------------------------------------------------------ *
   * THE PLATFORM CATALOGUE — AND IT MUST STAY ABOVE productRoutes.
   *
   * These four are public and belong to no organization. productRoutes
   * below applies requireSession() at "/" with no path, so ANY path that
   * reaches it answers 401 — which is exactly why these four answered 401
   * for months before they existed, rather than 404.
   *
   * Registered after it they would be dead, and the failure would read as
   * an authentication problem rather than a routing one.
   * test/market-api.test.js asserts this order.
   * ------------------------------------------------------------------ */
  /*
   * API RESPONSES ARE NOT CACHEABLE BY DEFAULT.
   *
   * This service is proxied through paltas.io, so its responses travel through
   * a shared CDN. One customer's invoice list sitting in that cache and being
   * served to another is exactly the wall this platform sells — and a missing
   * Cache-Control header leaves the decision to whatever heuristics the cache
   * happens to use.
   *
   * Set BEFORE the routers, so the handful of genuinely public, genuinely
   * static endpoints (market config, payment methods, localization) can and do
   * override it with their own `public, max-age=600`. Everything else — every
   * authenticated read of a customer's own data — stays no-store.
   *
   * Netlify cannot do this: [[headers]] do not apply to proxied responses, so a
   * rule there looked right and did nothing at all.
   */
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(marketRoutes);

  /* ------------------------------------------------------------------ *
   * THE GUEST PORTAL — and it must stay above productRoutes too.
   *
   * A guest holds no membership, so requireOrganization() below would refuse
   * them before they reached a single one of their own endpoints. These are
   * scoped to a PERSON rather than a company — see routes/guest.js.
   * ------------------------------------------------------------------ */
  app.use(guestRoutes);

  /* ------------------------------------------------------------------ *
   * THE PALTAS STAFF CONSOLE — above productRoutes, like the others.
   *
   * It is the ONE place in this service that reads across tenants, and it is
   * a separate file for exactly that reason: the organization filter in
   * http/resource.js stays unconditional, and this narrow door sits beside it
   * rather than inside it. Read-only, and every read is audited naming the
   * member of staff. See the long note in routes/platform.js.
   * ------------------------------------------------------------------ */
  app.use(platformRoutes);

  /*
   * TOKENISED INVESTMENT — before productRoutes, like every other router here.
   *
   * productRoutes mounts at "/" behind requireSession(), so anything registered
   * after it gets a 401 instead of reaching its handler. That is the same
   * ordering the market, guest and platform routers depend on.
   */
  app.use(investmentRoutes);

  /* The six products. Every path under here is organization-scoped and
     permission-checked by construction — see http/resource.js. */
  app.use("/", productRoutes);

  app.use((req, _res, next) => next(notFound(`No endpoint at ${req.method} ${req.path}.`)));
  app.use(errorHandler(log));

  return app;
}

/* Only start a server when run directly — importing this file in a test must
   not bind a port. */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (isMain) {
  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`paltas-api listening on :${config.port} (${config.env})`);
    log.info(`  sign in at ${config.publicUrl}/auth/google`);
    log.info(`  app origin ${config.appUrl}`);
  });

  pruneExpiredSessions()
    .then((n) => n && log.info(`pruned ${n} expired session(s)`))
    .catch((e) => log.error("session prune failed", e.message));

  /* Render sends SIGTERM on deploy. Finishing the requests already in flight
     is the difference between a clean deploy and a handful of people seeing a
     failure for no reason. */
  const stop = async (signal) => {
    log.info(`${signal} — shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
