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

/** Levels, re-exported so a route can name one without reaching into access. */
export type { Level };
