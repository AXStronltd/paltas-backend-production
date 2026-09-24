/* ====================================================================== *
 * SESSIONS — a row in the database, not a token in the browser.
 *
 * The cookie holds a random 32-byte token and nothing else. Everything about
 * who you are is looked up server-side on every request.
 *
 * That choice costs one indexed query per request and buys two things a
 * self-contained JWT cannot give you at any price:
 *
 *   SIGNING OUT IS REAL. Delete the row and the session is over, everywhere,
 *   immediately. A JWT is valid until it expires no matter how loudly you
 *   press sign out.
 *
 *   A CHANGE OF ROLE TAKES EFFECT NOW. Remove somebody's publisher rights and
 *   their next request has already lost them. With a JWT they keep whatever
 *   the token said until it runs out.
 *
 * The database stores the SHA-256 of the token, never the token. A leaked
 * backup is then a list of hashes rather than a drawer of working keys.
 * ====================================================================== */

import crypto from "node:crypto";
import { config } from "../config.ts";
import type { Prisma } from "@prisma/client";
import type { Response } from "express";

import { db } from "../db.ts";

export const COOKIE = "paltas_session";

const hash = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

/** What a browser was given, and when it stops working. */
export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Where the sign-in came from. All optional — a session can be made without. */
export interface SessionOrigin {
  readonly orgId?: string | null;
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

export async function createSession(
  userId: string,
  { orgId, userAgent, ip }: SessionOrigin = {},
): Promise<IssuedSession> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);

  await db.session.create({
    data: {
      tokenHash: hash(token),
      userId,
      orgId: orgId || null,
      userAgent: String(userAgent || "").slice(0, 300),
      ip: String(ip || "").slice(0, 60),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/**
 * The row behind a cookie, or null. An expired row is deleted on sight rather
 * than left to a cleanup job that may never be written.
 */
/**
 * A session row with its user attached.
 *
 * Derived from Prisma rather than written out, so it cannot drift from the
 * `include` two lines below it — which is the failure a hand-written shape
 * has: somebody adds a column, the type does not know, and every reader gets
 * a field the compiler says does not exist.
 */
export type SessionWithUser = Prisma.SessionGetPayload<{ include: { user: true } }>;

export async function readSession(
  token: string | undefined | null,
): Promise<SessionWithUser | null> {
  if (!token) return null;
  const row = await db.session.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: true },
  });
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    await db.session.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  return row;
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hash(token) } });
}

/** Sign out everywhere — used when an account is compromised or closed. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

export async function switchOrganization(sessionId: string, orgId: string): Promise<void> {
  await db.session.update({ where: { id: sessionId }, data: { orgId } });
}

/* ------------------------------------------------------------ cookies */

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(COOKIE, token, {
    /* JavaScript cannot read it. An XSS bug then cannot steal the session,
       which is the difference between a bad day and a very bad day. */
    httpOnly: true,
    /* Only over HTTPS. Required outright once sameSite is "none". */
    secure: config.secureCookies,
    /*
     * "lax" when the app and the API share an origin, "none" when they do
     * not — decided in config.js from the two URLs rather than set by hand.
     *
     * "lax" is the one to want. A "none" cookie is third-party, and Safari
     * blocks third-party cookies by default: sign-in then fails on every
     * iPhone, silently, because the cookie is never stored at all. Proxying
     * the API under the app's own domain is what avoids that, and it is what
     * netlify.toml in the frontend repository does.
     */
    sameSite: config.cookieSameSite,
    expires: expiresAt,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    secure: config.secureCookies,
    /* Must match how it was set, or the browser keeps the old one and the
       person stays signed in after pressing sign out. */
    sameSite: config.cookieSameSite,
    path: "/",
  });
}

/** Delete sessions that have expired. Called on boot; cheap, and stops the
    table growing forever on a service nobody is watching. */
export async function pruneExpiredSessions() {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
