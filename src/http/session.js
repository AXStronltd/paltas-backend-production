/* ====================================================================== *
 * WHO IS CALLING, AND MAY THEY.
 *
 * Attaching the caller to the request, and the four guards every protected
 * route composes from: signed in, in a company, subscription open, product
 * entitled.
 * ====================================================================== */

import { COOKIE, readSession } from "../auth/sessions.js";
import { actorFor, sessionView } from "../domain/session-view.js";
import { forbidden, unauthorized } from "./errors.ts";
import { subscriptionOpens } from "../domain/rights.ts";

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
