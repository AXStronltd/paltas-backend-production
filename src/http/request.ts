/* ====================================================================== *
 * WHAT MIDDLEWARE PUTS ON A REQUEST.
 *
 * ── WHY THIS IS A FILE OF ITS OWN ──────────────────────────────────────
 *
 * `req.actor` is read 269 times in this service, `req.body` 216, `req.session`
 * 79, `req.view` 44. Express knows about none of them: they are attached by
 * withSession() and every route reads them back. Until now that was an
 * agreement held together by convention and by tests.
 *
 * The augmentation below is what makes it an agreement the compiler enforces.
 *
 * ── AND WHY ALL THREE ARE OPTIONAL ─────────────────────────────────────
 *
 * Because they genuinely are. withSession() attaches them only when a valid
 * cookie is present, and it NEVER rejects — that is what keeps
 * `GET /promotions/public` genuinely public while still knowing who the
 * visitor is if they happen to be signed in.
 *
 * Declaring them non-optional would be the comfortable lie: every route would
 * read `req.actor.orgId` without complaint, including the handful that run
 * before requireSession() and the ones that are deliberately public. The
 * compiler would have been turned off at exactly the place it is most needed.
 *
 * So they are optional, and a route that needs one says so — by composing
 * requireSession() and requireOrganization(), and by narrowing. The friction
 * is the feature.
 * ====================================================================== */

import type { Request } from "express";

import type { Level } from "../domain/access.ts";
import type { SessionWithUser } from "../auth/sessions.ts";

/**
 * The caller, built from their MEMBERSHIPS and never from anything the
 * request said. That is the line every other check in this service rests on —
 * see actorFor() in domain/session-view.js.
 */
export interface Actor {
  readonly userId: string;
  readonly userName: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly role: string;
  /** A Json column: `{ all: true }` or `{ sites: [...] }`, or older shapes. */
  readonly scope: unknown;
  readonly products: readonly string[];
  /** PALTAS's own staff. An entitlement, never a role — see actorFor(). */
  readonly isPlatform: boolean;
  readonly subscriptionStatus: string;
  readonly verificationStatus: string;
}

/**
 * What the console is handed at sign-in.
 *
 * Re-exported from where it is built rather than restated, so there is one
 * definition and it cannot drift. It is a union — signed in with a company,
 * and signed in without one — which is what makes `if (!view.organization)`
 * narrow both the organization and the subscription.
 */
export type { SessionView } from "../domain/session-view.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The session row and its user. Absent when nobody is signed in. */
      session?: SessionWithUser;
      /** What the console reads. Absent when nobody is signed in. */
      view?: import("../domain/session-view.ts").SessionView;
      /**
       * Who is acting, and for which company.
       *
       * Absent when nobody is signed in AND when a signed-in person has not
       * joined a company yet — those are two different situations and
       * requireOrganization() tells them apart.
       */
      actor?: Actor;
    }
  }
}

/**
 * A REQUEST THAT HAS ALREADY BEEN THROUGH THE GUARDS.
 *
 * `req.actor` is optional on an ordinary Request, and rightly so — plenty of
 * routes run without one. But a handler mounted behind requireSession() and
 * requireOrganization() cannot reach a caller who has neither, and saying so
 * once is better than an `if (!req.actor)` in every hook that would never be
 * true and could never be tested.
 *
 * The guarantee is enforced by the middleware, not by this type. The one
 * place that asserts it is http/resource.ts, where the guards are visible on
 * the same page.
 */
export interface AuthenticatedRequest extends Request {
  readonly actor: Actor;
  readonly session: SessionWithUser;
}

/**
 * THE CALLER, ON A ROUTER THAT HAS ALREADY REQUIRED ONE.
 *
 * `req.actor` is optional and stays optional — see the long note at the top
 * of this file for why that is the honest declaration. This is how a handler
 * that IS behind requireSession() + requireOrganization() reads it without
 * an `if` that could never be true and could never be tested.
 *
 * A thrown error rather than a cast. If a router is ever mounted without its
 * guards, the failure names that, at the first line of the first handler,
 * instead of reading `undefined.orgId` three frames later.
 *
 * `where` is the caller's own description of itself, because "a route ran
 * with no actor" is a sentence somebody has to act on and it does not say
 * which route.
 */
export function actorOf(req: Request, where = "a route"): Actor {
  const actor = req.actor;
  if (!actor) {
    throw new Error(
      `${where} ran with no actor — it must stay mounted behind requireSession() ` +
      "and requireOrganization()");
  }
  return actor;
}

/**
 * The session, on the same routers, for the same reason.
 *
 * Separate from actorOf() rather than folded into it: an actor is built from
 * memberships and a session is who signed in, and there are routes that have
 * a session and no company — `POST /organizations` is exactly one.
 */
export function sessionOf(req: Request, where = "a route"): SessionWithUser {
  const session = req.session;
  if (!session) {
    throw new Error(`${where} ran with no session — it must stay mounted behind requireSession()`);
  }
  return session;
}

/** Levels, re-exported so a route can name one without reaching into access. */
export type { Level };

/**
 * A ROUTE PARAMETER, ON A ROUTE THAT DECLARES IT.
 *
 * Express types `req.params` as `{ [key: string]: string }`, so under
 * `noUncheckedIndexedAccess` every `req.params.id` reads as
 * `string | undefined`. On a route registered as `/offers/:id` that can never
 * be true — Express would not have matched the request at all.
 *
 * So this is not a null check that will ever fire in production. It is the
 * same trade actorOf() makes: name the invariant once, and if a route is
 * renamed while a handler still reads the old parameter, fail at the first
 * line with a sentence saying which parameter and which route — rather than
 * passing `undefined` into a `where` clause and returning somebody else's
 * row, or none, with no explanation.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") {
    throw new Error(
      `${req.method} ${req.route?.path ?? req.path} read the route parameter ` +
      `":${name}", which it does not declare`);
  }
  return value;
}
