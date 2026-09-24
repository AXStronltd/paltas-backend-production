/* ====================================================================== *
 * WHO IS CALLING, AND MAY THEY.
 *
 * Attaching the caller to the request, and the four guards every protected
 * route composes from: signed in, in a company, subscription open, product
 * entitled.
 * ====================================================================== */

import type { RequestHandler } from "express";

import { COOKIE, readSession } from "../auth/sessions.ts";
/* The augmentation that puts session, view and actor on Express's Request.
   Imported for the side effect of the `declare global` inside it. */
import type { Actor } from "./request.ts";
import "./request.ts";
import { actorFor, sessionView } from "../domain/session-view.ts";
import { forbidden, unauthorized } from "./errors.ts";
import { subscriptionOpens } from "../domain/rights.ts";

/**
 * Attaches `req.session`, `req.view` and `req.actor` when a valid cookie is
 * present. Never rejects — routes decide whether they need a caller. That
 * keeps `GET /promotions/public` genuinely public while still knowing who the
 * visitor is if they happen to be signed in.
 */
export function withSession(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const row = await readSession(req.cookies ? req.cookies[COOKIE] : null);
      if (row) {
        req.session = row;
        /*
         * session-view.js is still JavaScript. `view` needs no cast — the
         * augmentation types it `unknown` until that file converts, which is
         * honest about what is actually known.
         *
         * `actor` does, because actorFor() returns NULL for a signed-in
         * person who has not joined a company — a real state that
         * requireOrganization() exists to tell apart from being signed out.
         * Assigning null would make `req.actor` present-but-null, and every
         * `if (!req.actor)` in the service would still work while the type
         * said something false.
         */
        req.view = await sessionView(row);
        const actor = (await actorFor(row)) as Actor | null;
        if (actor) req.actor = actor;
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireSession(): RequestHandler {
  return (req, _res, next) => {
    if (!req.session) { next(unauthorized("Sign in first.")); return; }
    next();
  };
}

/** A signed-in person who has not yet created or joined a company. */
export function requireOrganization(): RequestHandler {
  return (req, _res, next) => {
    if (!req.session) { next(unauthorized("Sign in first.")); return; }
    if (!req.actor) {
      next(forbidden(
        "This account is not part of a company yet. Create one first — it takes a minute."
      ));
      return;
    }
    next();
  };
}

/** CANCELED and EXPIRED close the door. TRIALING, ACTIVE and PAST_DUE do not. */
export function requireOpenSubscription(): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) { next(); return; }
    if (!subscriptionOpens(req.actor.subscriptionStatus)) {
      next(forbidden(
        `This company's subscription is ${String(req.actor.subscriptionStatus).toLowerCase()}. ` +
        `Renew it and everything is exactly where it was — nothing has been deleted.`
      ));
      return;
    }
    next();
  };
}

/**
 * Entitlement decides which console exists. A role inside a company that does
 * not hold a product cannot reach that product's data by asking politely.
 */
export function requireProduct(product: string): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) { next(unauthorized("Sign in first.")); return; }
    if (!req.actor.products.includes(product)) {
      next(forbidden(
        `This company's subscription does not include ${product.replace(/_/g, " ").toLowerCase()}.`
      ));
      return;
    }
    next();
  };
}
