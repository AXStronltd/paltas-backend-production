/* ====================================================================== *
 * THE MIDDLEWARE.
 *
 * Four things, in this order, on every request that needs them:
 * who is calling, may they call at all, are they calling too often, and is
 * their company's subscription open.
 * ====================================================================== */

import { config } from "../config.js";
import { COOKIE, readSession } from "../auth/sessions.js";
import { actorFor, sessionView } from "./session-view.js";
import { forbidden, unauthorized } from "./errors.js";
import { subscriptionOpens } from "./rights.js";

/**
 * Attaches `req.session`, `req.view` and `req.actor` when a valid cookie is
 * present. Never rejects — routes decide whether they need a caller. That
 * keeps `GET /promotions/public` genuinely public while still knowing who the
 * visitor is if they happen to be signed in.
 */
export function withSession() {
  return async (req, _res, next) => {
    try {
      const row = await readSession(req.cookies ? req.cookies[COOKIE] : null);
      if (row) {
        req.session = row;
        req.view = await sessionView(row);
        req.actor = await actorFor(row);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireSession() {
  return (req, _res, next) => {
    if (!req.session) return next(unauthorized("Sign in first."));
    next();
  };
}

/** A signed-in person who has not yet created or joined a company. */
export function requireOrganization() {
  return (req, _res, next) => {
    if (!req.session) return next(unauthorized("Sign in first."));
    if (!req.actor) {
      return next(forbidden(
        "This account is not part of a company yet. Create one first — it takes a minute."
      ));
    }
    next();
  };
}

/** CANCELED and EXPIRED close the door. TRIALING, ACTIVE and PAST_DUE do not. */
export function requireOpenSubscription() {
  return (req, _res, next) => {
    if (!req.actor) return next();
    if (!subscriptionOpens(req.actor.subscriptionStatus)) {
      return next(forbidden(
        `This company's subscription is ${String(req.actor.subscriptionStatus).toLowerCase()}. ` +
        `Renew it and everything is exactly where it was — nothing has been deleted.`
      ));
    }
    next();
  };
}

/**
 * Entitlement decides which console exists. A role inside a company that does
 * not hold a product cannot reach that product's data by asking politely.
 */
export function requireProduct(product) {
  return (req, _res, next) => {
    if (!req.actor) return next(unauthorized("Sign in first."));
    if (!req.actor.products.includes(product)) {
      return next(forbidden(
        `This company's subscription does not include ${product.replace(/_/g, " ").toLowerCase()}.`
      ));
    }
    next();
  };
}

/* ------------------------------------------------------------------ CORS */

/*
 * An allow-list, and never "*".
 *
 * The session travels as a cookie, so `Access-Control-Allow-Credentials` is
 * on; a wildcard origin with credentials is the browser handing a session to
 * whichever site asked for it. A request from an origin not on the list gets
 * no CORS headers at all and the browser refuses it — which is the correct
 * outcome and needs no error of our own.
 */
export function cors() {
  const allowed = new Set(config.origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin.replace(/\/+$/, ""))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

/* ------------------------------------------------------------ rate limit */

/*
 * A small fixed-window counter, in memory.
 *
 * Not a defence against a determined attacker — that belongs at the edge. This
 * stops the ordinary accidents: a retry loop in someone's script, a page that
 * calls the public feed on every scroll event, a sign-in button double-clicked
 * forty times. Those are what actually take a small service down.
 */
export function rateLimit({ windowMs = 60_000, max = 120, key } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = (key ? key(req) : req.ip) || "anon";
    const bucket = hits.get(id);

    if (!bucket || bucket.reset < now) {
      hits.set(id, { n: 1, reset: now + windowMs });
    } else if (++bucket.n > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.reset - now) / 1000));
      return res.status(429).json({
        error: "too_many_requests",
        message: "That is more requests than this endpoint allows in a minute. Wait a moment and try again.",
      });
    }

    /* Sweep occasionally rather than on every request. */
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

/* ------------------------------------------------------------- headers */

export function securityHeaders() {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    /* This service returns JSON, not pages. Nothing it sends should ever be
       treated as a document with permission to load anything. */
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.removeHeader("X-Powered-By");
    next();
  };
}
