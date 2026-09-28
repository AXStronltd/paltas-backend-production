/* ====================================================================== *
 * THE PALTAS API.
 *
 * Sessions, organizations and the promotion workflow — the first slice of the
 * contract in the frontend's backend.md, built so the frontend needs no change
 * above `PromoAPI` and `PALTAS.Session`.
 * ====================================================================== */

import express from "express";
import cookieParser from "cookie-parser";

import { config } from "./config.ts";
import { db, closeDb } from "./db.ts";
import {
  cors, errorHandler, notFound, rateLimit, securityHeaders, withSession,
} from "./http/index.ts";
import { pruneExpiredSessions } from "./auth/sessions.ts";
import { tick } from "./domain/scheduler.ts";
import { authRoutes } from "./routes/auth.ts";
import { organizationRoutes } from "./routes/organizations.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { provisioningRoutes } from "./routes/provisioning.ts";
import { promotionRoutes } from "./routes/promotions.ts";
import { productRoutes } from "./routes/products.ts";
import { formRoutes } from "./routes/forms.ts";
import { marketRoutes } from "./routes/market.ts";
import { ledgerRoutes } from "./routes/ledger.ts";
import { companyRoutes } from "./routes/company.ts";
import { offerRoutes } from "./routes/offers.ts";
import { workflowRoutes } from "./routes/workflow.ts";
import { commsRoutes } from "./routes/comms.ts";
import { siteRoutes } from "./routes/site.ts";
import { procurementRoutes } from "./routes/procurement.ts";
import { predevRoutes } from "./routes/predevelopment.ts";
import { handoverRoutes } from "./routes/handover.ts";
import { reportRoutes } from "./routes/reports.ts";
import { commsWebhookRoutes } from "./routes/comms-webhook.ts";
import { marketplaceRoutes } from "./routes/marketplace.ts";
import { stayRoutes } from "./routes/stays.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.ts";
import { register as registerProcessor, fromEnv as stripeFromEnv, status as payStatus } from "./payments/stripe.ts";
import { guestRoutes } from "./routes/guest.ts";
import { platformRoutes } from "./routes/platform.ts";
import { investmentRoutes } from "./routes/investments.ts";
import { dnaRoutes } from "./routes/dna.ts";
import { authorityRoutes } from "./modules/authority/api/routes.ts";
import { register as registerSupplier, status as supplierStatus } from "./domain/supply.ts";
import { fromEnv as liteApiFromEnv } from "./suppliers/liteapi.ts";
import { fromEnv as stayingApiFromEnv, KEY_NAMES as STAYING_KEYS } from "./suppliers/stayingapi.ts";
import { registerCompare, compareStatus, noteCompareUnavailable } from "./domain/compare.ts";
import { fromEnv as expediaRapidFromEnv } from "./suppliers/expedia-rapid.ts";
import { fromEnv as bookingDemandFromEnv } from "./suppliers/booking-demand.ts";
import { fromEnv as sampleCatalogueFromEnv } from "./suppliers/sample-catalogue.ts";
import { messageOf } from "./http/errors.ts";

const log = {
  info: (...a: unknown[]) => console.log(new Date().toISOString(), ...a),
  error: (...a: unknown[]) => console.error(new Date().toISOString(), ...a),
};

/* Fixed at import, so it is the process's age and not the request's clock. */
const STARTED_AT = new Date().toISOString();

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
  app.set("json replacer", function (key: string, value: unknown) {
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
  /*
   * THE STRIPE WEBHOOK GOES FIRST, and the order is not cosmetic.
   *
   * Its signature is computed over the exact bytes Stripe sent. express.json()
   * parses and discards them, and a re-serialised object does not verify — so
   * mounted after this line, every webhook would fail with a signature error
   * that looks exactly like a wrong secret. It carries its own express.raw().
   */
  app.use(stripeWebhookRoutes);

  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, max: 600 }));

  /*
   * DELIVERY RECEIPTS FROM A MAIL OR SMS PROVIDER.
   *
   * Above every router that requires a session, because a provider has none.
   * Below express.json(), unlike Stripe's: this one authenticates with a
   * shared secret in a header rather than a signature over the exact bytes,
   * so the parsed body is fine and the raw one is not needed.
   */
  app.use(commsWebhookRoutes);
  app.use(withSession());

  /*
   * WHICH BUILD IS ANSWERING, AND SINCE WHEN.
   *
   * Written once and spread into both branches of /health below. Two copies
   * would be two things to keep in step, and the one that gets forgotten is
   * always the error path — which is the branch that matters most.
   */
  const identity = () => ({
    commit: String(process.env.BUILD_COMMIT || process.env.RENDER_GIT_COMMIT || "")
      .slice(0, 7) || null,
    startedAt: STARTED_AT,
  });

  /* Render polls this. It touches the database on purpose: a service that
     answers "healthy" while its database is unreachable has told you nothing
     worth knowing. */
  app.get("/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({
        ok: true, service: "paltas-api", env: config.env,
        /*
         * WHICH BUILD IS ANSWERING, AND SINCE WHEN.
         *
         * Without these, "is my change live yet?" is answered by guessing from
         * behaviour — and that fails exactly when it matters, because the
         * interesting case is usually one where the old build and the new one
         * say the same thing. It cost several rounds of confusion over an
         * environment variable before this existed.
         *
         * `startedAt` also answers "did it restart when I saved that variable",
         * which is the other half of the same question.
         *
         * A commit SHA identifies a build; it is not a credential and grants
         * nothing.
         *
         * BUILD_COMMIT first, because the Dockerfile bakes it in and an image
         * that knows what it is cannot be wrong about it. RENDER_GIT_COMMIT
         * second, which the platform injects at runtime — that is what this
         * read before, and dropping it would break a deploy that works today.
         *
         * Neither set is null rather than a guess. An image built by hand has
         * no commit, and saying so is better than claiming one.
         */
        ...identity(),
      });
    } catch (e) {
      /*
       * THE BUILD IS REPORTED EVEN WHEN THE DATABASE IS NOT REACHABLE.
       *
       * It did not used to be, and that was backwards: an unreachable
       * database is precisely the moment somebody needs to know which build
       * is answering — "did the deploy I just made break this, or was it
       * already broken" is the first question of every incident, and it had
       * no answer at exactly the point it mattered.
       *
       * The commit and the start time are facts about the PROCESS. They do
       * not depend on the database being up, so they are not withheld
       * because it is down. `ok` is still false and the status is still 503,
       * so nothing that reads this as a health check is misled.
       */
      res.status(503).json({
        ok: false, error: "database_unreachable", service: "paltas-api",
        ...identity(),
      });
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
  app.use("/invitations", invitationRoutes);
  app.use("/", provisioningRoutes);
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

  app.use(marketplaceRoutes);
  app.use(stayRoutes);
  app.use(paymentRoutes);
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

  /*
   * PROPERTY DNA — before productRoutes, for the same reason investments is.
   *
   * productRoutes mounts at "/" and builds a CRUD router for every declared
   * resource, so anything registered after it competes with those paths.
   * These are /properties/:siteId/... and there is no `properties` resource,
   * but the ordering rule is the one that keeps that true if one is ever
   * added.
   */
  app.use(dnaRoutes);

  /*
   * THE AUTHORITY LAYER, after Property DNA and before productRoutes.
   *
   * It does NOT sit behind requireOpenSubscription: a public authority is not
   * a paying customer and has no subscription to lapse. Putting that guard on
   * it would make a land registry's access depend on somebody's card.
   */
  app.use(authorityRoutes);

  /*
   * THE LEDGER, above productRoutes for the same reason as everything else
   * here: productRoutes mounts at "/" behind requireSession(), so a path
   * registered after it answers 401 rather than 404 and the failure reads as
   * an auth fault. test/ledger-api.test.js fails if this order is reversed.
   *
   * The double-entry engine in domain/ledger.js predates this by some time
   * and had no transport at all — no routes, and no caller anywhere in the
   * service. These are that transport, and nothing more: every rule about
   * balance, immutability, closed periods and organization isolation is
   * still enforced in the domain.
   */
  app.use(ledgerRoutes);

  /*
   * WHAT A COMPANY CAN ASK ABOUT ITSELF — its audit trail, its expiring
   * documents, one customer's payment history, and its own settings.
   *
   * Above productRoutes like the rest: `/documents/expiring` would otherwise
   * reach the documents RESOURCE router first and be read as a document with
   * the id "expiring".
   */
  app.use(companyRoutes);

  /*
   * MOVING AN OFFER — send, view, accept, reject. Above productRoutes because
   * `/offers/:id/accept` would otherwise reach the offers RESOURCE router and
   * be read as an update to an offer called ":id/accept".
   *
   * The resource itself still creates and edits them; only the acts with
   * consequences live here.
   */
  app.use(offerRoutes);

  /*
   * THE OPERATING LOOP — meeting → decision → task. Above productRoutes for
   * the usual reason: `/tasks/mine` and `/tasks/:id/done` would otherwise
   * reach the tasks RESOURCE router and be read as a task called "mine".
   */
  app.use(workflowRoutes);

  /*
   * COMMUNICATIONS — above productRoutes, like the rest. `/dispatches/outbox`
   * would otherwise reach the dispatches RESOURCE router and be read as a
   * dispatch with the id "outbox".
   */
  app.use(commsRoutes);

  /*
   * THE SITE REGISTERS — above productRoutes for the usual reason.
   * `/rfis/overdue` and `/defects/outstanding` would otherwise reach their
   * own resource routers and be read as an RFI called "overdue".
   *
   * It also carries the site diary's OWN create and update, which is why it
   * must be here rather than after: the diary resource declares ownCreate and
   * ownUpdate, so the framework registers neither, and a request landing on
   * productRoutes first would find nothing.
   */
  app.use(siteRoutes);

  /*
   * PROCUREMENT AND VARIATIONS — above productRoutes, like the rest.
   * `/purchase-orders/committed` and `/contracts/:id/value` would otherwise
   * reach their resource routers and be read as an order called "committed".
   */
  app.use(procurementRoutes);

  /*
   * BEFORE ANYBODY BUILDS — land, feasibility, drawings, permits. Above
   * productRoutes like the rest: `/drawings/current` and `/permits/blocking`
   * would otherwise be read as a drawing called "current".
   */
  app.use(predevRoutes);

  /*
   * HANDING IT OVER, THE SALE THAT PRECEDES IT, AND THE TEAM. Above
   * productRoutes: `/contracts/:id/balance` and `/projects/:id/team` would
   * otherwise be swallowed by their own resource routers.
   */
  app.use(handoverRoutes);

  /*
   * ONE DEVELOPMENT ON ONE PAGE, AND ITS TRAIL. Above productRoutes, like
   * everything else: `/projects/:id/report` would otherwise be read by the
   * projects resource router as a project with the id "report".
   */
  app.use(reportRoutes);

  /* The six products. Every path under here is organization-scoped and
     permission-checked by construction — see http/resource.js. */
  app.use("/", productRoutes);
  /* What a "＋ Add" button should ask for — assembled from console-map,
     the registry and Prisma's enums, so the console does not keep a copy
     of any of them. */
  app.use("/", formRoutes);

  app.use((req, _res, next) => next(notFound(`No endpoint at ${req.method} ${req.path}.`)));
  app.use(errorHandler(log));

  return app;
}

/* Only start a server when run directly — importing this file in a test must
   not bind a port. */
const isMain = Boolean(
  process.argv[1] && import.meta.url.endsWith(String(process.argv[1].split("/").pop())));

/**
 * Attach an accommodation supplier, if this installation has credentials for one.
 *
 * Called from the boot path below and NOT from createApp(), deliberately. A
 * test builds the app dozens of times and must decide for itself whether a
 * supplier exists — registering inside createApp() would let a real wholesaler
 * be reached from a test run that never asked for one.
 *
 * Absent credentials are the NORMAL state and not an error: nothing is
 * registered, the marketplace serves PALTAS's own listings exactly as before,
 * and the log says which it is so an operator is never left guessing.
 */
/**
 * Attach a payment processor, if this installation has a key.
 *
 * Out of createApp() for the same reason as connectSuppliers: a test builds the
 * app many times and must decide for itself whether Stripe exists. Registering
 * inside createApp() would let a LIVE key be reached from a test run that never
 * asked for one, which on this seam means real money.
 */
export function connectPayments(env = process.env) {
  try {
    const stripe = stripeFromEnv(env);
    if (!stripe) {
      log.info("payment processor: none configured — companies cannot collect card payments");
      return null;
    }
    registerProcessor(stripe);
    const s = payStatus();
    log.info(`payment processor: ${s.name}${s.livemode ? " (LIVE — real cards)" : " (test mode)"}`);
    if (s.livemode && !env.STRIPE_WEBHOOK_SECRET) {
      /* Live, and unable to verify a webhook. Payments would be taken and never
         recorded, because the only place a Payment row is written is the
         verified webhook. */
      log.error(
        "  *** STRIPE IS LIVE BUT STRIPE_WEBHOOK_SECRET IS NOT SET. " +
        "No webhook can be verified, so no payment will be recorded. ***");
    }
    return s;
  } catch (e) {
    log.error("payment processor failed to connect:", messageOf(e));
    return null;
  }
}

/**
 * The price-comparison provider — separate from connectSuppliers(), and that
 * separation is the point.
 *
 * StayingAPI has no booking endpoint. Registering it as a SUPPLIER would put
 * rooms on the marketplace that nobody can take; registering it here attaches
 * what other sellers charge to a LiteAPI room that IS bookable. Two different
 * seams, because they are two different promises to a visitor.
 */
export function connectComparison(env = process.env) {
  try {
    const p = stayingApiFromEnv(env);
    if (!p) {
      /*
       * WHY fromEnv() returned nothing, in the detail an operator needs.
       *
       * "Not set" is true of three different mistakes and only one of them is
       * "you forgot". A value that saved as empty, and a value that saved under
       * a name one character out, both present as absent — and from outside the
       * machine there is no way to tell them apart, which is exactly where
       * somebody debugging this is standing.
       *
       * NAMES ARE NOT SECRETS. Listing which STAYING-ish variables this process
       * can actually see turns a typo from an afternoon into a sentence. No
       * value is read, and none could be: only Object.keys is consulted.
       */
      const blank = STAYING_KEYS.filter(
        (n) => typeof env[n] === "string" && String(env[n]).trim() === "");
      const nearby = Object.keys(env)
        .filter((k) => /STAYING/i.test(k) && !STAYING_KEYS.includes(k))
        .sort();

      let why;
      if (blank.length) {
        why = blank.join(" and ") + " exists on this service but its value is empty.";
      } else if (nearby.length) {
        why = STAYING_KEYS.join(" / ") + " are not set, but this service can see " +
              nearby.join(" and ") + " — one of those is probably meant to be it.";
      } else {
        why = "Neither " + STAYING_KEYS.join(" nor ") +
              " is set on this service, so no other sellers are shown.";
      }
      noteCompareUnavailable(why);
      log.info("price comparison: " + why);
      return null;
    }
    registerCompare(p);
    const s = compareStatus();
    log.info(`price comparison: ${s.name}${s.sandbox ? " (SANDBOX — fixtures, no credits)" : " (LIVE — 30 credits per comparison)"}`);
    if (!s.sandbox) {
      /*
       * Worth saying on every boot. This is the only endpoint PALTAS has that
       * spends money per request, and the guards on it — a hotel PALTAS
       * already sells, a six-hour cache, twenty a minute — are the difference
       * between a feature and a bill.
       */
      log.info("  comparisons are cached for 6h and rate limited to 20/min, and only for hotels PALTAS sells");
    }
    return s;
  } catch (e) {
    /* A comparison is an extra. Failing to wire one must never stop the API
       from booting or take a bookable room off the marketplace.
       The message is the adapter's own and never contains a credential — it
       refuses an unrecognised key by describing the PREFIX it wanted. */
    const why = messageOf(e) || "the provider could not be built";
    noteCompareUnavailable("STAYINGAPI_KEY was set but rejected: " + why);
    log.error("price comparison failed to connect:", why);
    return null;
  }
}

export function connectSuppliers(env = process.env) {
  try {
    /*
     * PRECEDENCE, and it is deliberate.
     *
     * A licensed supplier always wins. The sample catalogue is reached for only
     * when neither Expedia nor Booking.com has credentials AND somebody has
     * explicitly set PALTAS_SAMPLE_SUPPLY=1 — so demonstration content can
     * never quietly outrank real inventory, and can never appear because a
     * variable was left at its default.
     */
    /*
     * LiteAPI first because it is the supplier this installation holds a key
     * for, and because it is the only one of the three that can price a city by
     * NAME — the other two need a hand-maintained id map and return nothing for
     * any city missing from it.
     */
    const real = liteApiFromEnv(env)
      || expediaRapidFromEnv(env)
      || bookingDemandFromEnv(env);
    const chosen = real || sampleCatalogueFromEnv(env);

    if (!chosen) {
      log.info("accommodation supplier: none configured — PALTAS listings only");
      return null;
    }

    registerSupplier(chosen);
    const s = supplierStatus();
    /* The name and the mode. Never a credential — status() has no field that
       could carry one. */
    log.info(`accommodation supplier: ${s.name}${s.sandbox ? " (SANDBOX/TEST)" : ""}`);

    if (!real) {
      /*
       * Loud, and on every boot. Sample inventory on a public marketplace is
       * the kind of thing that gets switched on for a demo and forgotten, and
       * the log is the only place an operator will ever notice.
       */
      log.error(
        "  *** SAMPLE CATALOGUE IS LIVE. The properties on the marketplace are " +
        "demonstration content: not real, not bookable, marked on every card. " +
        "Unset PALTAS_SAMPLE_SUPPLY to turn it off. ***");
    }
    return s;
  } catch (e) {
    /* A misconfigured supplier must not stop the API from booting. The
       marketplace degrades to PALTAS's own listings, which is the behaviour it
       had before any supplier existed. */
    log.error("accommodation supplier failed to connect:", messageOf(e));
    return null;
  }
}

if (isMain) {
  connectSuppliers();
  connectComparison();
  connectPayments();
  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`paltas-api listening on :${config.port} (${config.env})`);
    log.info(`  sign in at ${config.publicUrl}/auth/google`);
    log.info(`  app origin ${config.appUrl}`);
  });

  pruneExpiredSessions()
    .then((n) => n && log.info(`pruned ${n} expired session(s)`))
    .catch((e: unknown) => log.error("session prune failed", messageOf(e)));

  /*
   * THE SCHEDULER.
   *
   * In this process rather than a separate service, because the work is small,
   * the claim that makes it safe lives in the database, and a second service
   * is a second thing to deploy, watch and pay for.
   *
   * TICKING OFTEN IS HARMLESS AND THAT IS THE POINT. A period already claimed
   * is skipped, so a quarter-hourly beat, a deploy, two instances and somebody
   * pressing the button in the staff console cannot do the same work twice —
   * see domain/scheduler.ts. The interval is therefore about how soon work
   * starts, never about whether it happens once.
   *
   * It beats once at boot too, so a deploy picks up anything a previous
   * instance did not reach.
   *
   * SCHEDULER=off turns it off, for running a second instance deliberately
   * without one, or for a local process that should not touch shared data.
   */
  if (process.env["SCHEDULER"] !== "off") {
    const beat = () => {
      tick(db)
        .then((runs) => {
          for (const r of runs) {
            if (r.error) log.error(`job ${r.job} ${r.periodKey} failed`, r.error);
            else if (r.ran) {
              log.info(`job ${r.job} ${r.periodKey}: scanned ${r.scanned}, changed ${r.changed}`);
            }
          }
        })
        /* tick() does not throw; this is here because a promise with no catch
           is an unhandled rejection, and that is a process-level event. */
        .catch((e: unknown) => log.error("scheduler tick failed", messageOf(e)));
    };
    /* unref, so a tick pending at SIGTERM cannot hold the process open past
       the shutdown the platform is waiting on. */
    setInterval(beat, 15 * 60_000).unref();
    beat();
  } else {
    log.info("scheduler off (SCHEDULER=off)");
  }

  /* Render sends SIGTERM on deploy. Finishing the requests already in flight
     is the difference between a clean deploy and a handful of people seeing a
     failure for no reason. */
  const stop = async (signal: string) => {
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
