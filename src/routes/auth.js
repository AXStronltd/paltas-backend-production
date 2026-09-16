/* ====================================================================== *
 * /auth — signing in, reading the session, signing out.
 *
 * The endpoints the frontend's backend.md §1 names, plus the two Google needs.
 * ====================================================================== */

import { Router } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { beginSignIn, completeSignIn, OAUTH_COOKIE } from "../auth/google.js";
import {
  COOKIE, clearSessionCookie, createSession, destroySession,
  setSessionCookie, switchOrganization,
} from "../auth/sessions.js";
import { sessionView } from "../domain/session-view.js";
import { badRequest, forbidden, rateLimit, requireSession, unauthorized } from "../http/index.js";

export const authRoutes = Router();

/* Sign-in is the endpoint most worth throttling: it is unauthenticated and it
   costs a round trip to Google. */
const signInLimit = rateLimit({ windowMs: 60_000, max: 20 });

/**
 * GET /auth/google — start.
 *
 * A redirect rather than JSON, so the frontend can point a plain link at it
 * and needs no code at all to start a sign-in.
 */
authRoutes.get("/google", signInLimit, (req, res) => {
  const { url, cookie } = beginSignIn({ next: req.query.next });

  /*
   * The verifier travels with the browser rather than in this process.
   *
   * It used to sit in a Map here, which meant a sign-in begun before a deploy
   * or on an instance Render later stopped could never be completed — the
   * person was bounced back to the sign-in page with nothing to act on. See
   * the long note in auth/google.js.
   *
   * SameSite=Lax is load-bearing: Google's callback is a top-level GET
   * navigation and Lax permits it. "Strict" would drop the cookie on exactly
   * the request that needs it.
   */
  res.cookie(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: config.google.cookiePath,
  });

  res.redirect(url);
});

/**
 * GET /auth/google/callback — finish.
 *
 * Google sends the person here. This is the only endpoint in the service that
 * redirects a human rather than answering a program, so its failures have to
 * land somewhere a person can read, not in a JSON body they will never see.
 */
/*
 * WHERE A FAILED SIGN-IN LANDS: /auth/login.html?signin=cancelled|failed.
 *
 * That path is correct and the page is live. I briefly "fixed" it to
 * /login.html after testing the wrong URL and concluding the sign-in page did
 * not exist — it does, in the auth/ folder, which is also what the frontend's
 * own ${A} prefix resolves to. Left exactly as it was.
 */
authRoutes.get("/google/callback", signInLimit, async (req, res, next) => {
  try {
    if (req.query.error) {
      /* The person pressed Cancel on Google's screen. That is not an error,
         it is an answer. */
      const why = req.query.error === "access_denied" ? "cancelled" : "failed";
      return res.redirect(`${config.appUrl}/auth/login.html?signin=${why}`);
    }

    const cookie = req.cookies ? req.cookies[OAUTH_COOKIE] : null;
    /*
     * CLEARED BEFORE IT IS USED, AND THAT IS WHAT MAKES IT SINGLE USE.
     *
     * A replayed callback then arrives with no cookie and cannot mint a second
     * session, which is the property the old Map got from deleting the entry.
     */
    res.clearCookie(OAUTH_COOKIE, {
      httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: config.google.cookiePath,
    });

    const { identity, next: where } = await completeSignIn({
      code: req.query.code,
      state: req.query.state,
      cookie,
    });

    const user = await upsertUser(identity);
    const { token, expiresAt } = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    setSessionCookie(res, token, expiresAt);

    res.redirect(config.appUrl + where);
  } catch (e) {
    /* A sign-in failure the person can act on, in words, on a page — not a
       500 with a stack trace. */
    if (e && e.status === 401) {
      return res.redirect(`${config.appUrl}/auth/login.html?signin=failed`);
    }
    next(e);
  }
});

/**
 * Find this person, or make them.
 *
 * MATCHED ON GOOGLE'S `sub`, NOT ON EMAIL. Google's subject claim is the only
 * identifier it promises never to reuse; an email address can be changed, and
 * on Workspace domains it can be reassigned to a different human being
 * entirely. Matching on email means the new holder of an old address inherits
 * the previous person's PALTAS account.
 *
 * The one exception is the first sign-in of somebody a colleague invited by
 * email: that row exists with no `googleSub` yet, so it is claimed here, once.
 */
/*
 * THE FUNCTION THAT CREATES EVERY PALTAS ACCOUNT.
 *
 * Exported because it had no test, and an untested account-creation path is
 * the last thing to discover with a client in front of you. Three behaviours
 * here are load-bearing and none of them was covered: that a second sign-in
 * returns the SAME person rather than a second one, that an address already on
 * file is claimed by its rightful Google account, and that an address claimed
 * by a DIFFERENT Google account is refused outright rather than guessed at —
 * guessing means handing somebody another person's company.
 */
export async function upsertUser(identity) {
  const bySub = await db.user.findUnique({ where: { googleSub: identity.googleSub } });
  if (bySub) {
    return db.user.update({
      where: { id: bySub.id },
      data: {
        email: identity.email,
        name: identity.name || bySub.name,
        picture: identity.picture || bySub.picture,
      },
    });
  }

  const byEmail = await db.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== identity.googleSub) {
      /* Two different Google accounts claiming one address. Refuse rather than
         guess, because guessing means handing one person another's company. */
      throw forbidden(
        "That email address is already attached to a different Google account. " +
        "Sign in with the original account, or contact PALTAS."
      );
    }
    return db.user.update({
      where: { id: byEmail.id },
      data: {
        googleSub: identity.googleSub,
        name: byEmail.name || identity.name,
        picture: identity.picture || byEmail.picture,
      },
    });
  }

  return db.user.create({
    data: {
      email: identity.email,
      googleSub: identity.googleSub,
      name: identity.name,
      picture: identity.picture,
    },
  });
}

/**
 * GET /auth/session — the object in backend.md §1, or 401.
 *
 * `no-store` matters: a shared cache holding one person's session and serving
 * it to the next visitor is the worst bug this service could have.
 */
authRoutes.get("/session", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, private");
  if (!req.session) {
    return res.status(401).json({ error: "unauthorized", message: "Not signed in.", signedIn: false });
  }
  res.json(req.view);
});

/**
 * POST /auth/sessions — named in §1 for parity.
 *
 * There is no password to post, so this cannot create a session; it says so
 * and points at the door that can. Answering 404 here would look like the
 * endpoint was never built.
 */
authRoutes.post("/sessions", (_req, res) => {
  res.status(400).json({
    error: "use_google",
    message: "PALTAS signs in with Google. Send the person to /auth/google instead.",
    signInUrl: config.publicUrl + "/auth/google",
  });
});

/** DELETE /auth/sessions — sign out. Really out: the row is deleted. */
authRoutes.delete("/sessions", async (req, res, next) => {
  try {
    await destroySession(req.cookies ? req.cookies[COOKIE] : null);
    clearSessionCookie(res);
    res.json({ signedOut: true });
  } catch (e) { next(e); }
});

/**
 * POST /auth/session/organization — act for a different company.
 *
 * A person can belong to several. The session remembers which one they chose,
 * and the choice is checked against their memberships rather than trusted.
 */
authRoutes.post("/session/organization", requireSession(), async (req, res, next) => {
  try {
    const orgId = String(req.body?.organizationId || "");
    if (!orgId) throw badRequest("Which organization? Send `organizationId`.");

    const member = await db.membership.findUnique({
      where: { userId_orgId: { userId: req.session.userId, orgId } },
    });
    if (!member) throw unauthorized("This account is not a member of that organization.");

    await switchOrganization(req.session.id, orgId);
    const row = { ...req.session, orgId };
    res.json(await sessionView(row));
  } catch (e) { next(e); }
});
