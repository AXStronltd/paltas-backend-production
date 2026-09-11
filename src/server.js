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
