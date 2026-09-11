/* ====================================================================== *
 * SIGNING IN WITH GOOGLE.
 *
 * The authorization-code flow with PKCE. In plain terms:
 *
 *   1. We send the person to Google with a one-time `state` and a `code
 *      challenge` — a hash of a secret only this server knows.
 *   2. Google sends them back with a `code`.
 *   3. We swap that code for tokens, proving we are the same party by
 *      producing the secret behind the hash.
 *   4. We verify the ID token's signature against Google's public keys, and
 *      check who it was issued to and who issued it.
 *
 * WHY PKCE WHEN WE ALSO HAVE A CLIENT SECRET: the code travels back through
 * the person's browser, where it can be observed — a shared machine, a logging
 * proxy, an extension. Without PKCE a stolen code is a working sign-in. With
 * it, the code is worthless to anybody who does not hold the verifier, which
 * never leaves this server.
 *
 * WHAT THIS FILE NEVER DOES: touch a password, store one, or see one. That is
 * the point of choosing Google — the most dangerous thing a small team can
 * hold is a table of other people's passwords, and this way there isn't one.
 * ====================================================================== */

import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { badRequest, unauthorized } from "../http/errors.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/* Google's signing keys, fetched once and refreshed by the library on its own
   schedule. Google rotates them; a service that caches them forever starts
   rejecting every sign-in on a random Tuesday. */
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/* ------------------------------------------------------ the handshake */

/*
 * The pending sign-in, held for ten minutes.
 *
 * In memory, deliberately. These rows are worthless thirty seconds after they
 * are made and putting them in Postgres means a write and a delete on every
 * sign-in for no benefit. The cost is that a sign-in started before a deploy
 * and finished after it fails — the person presses the button again. If PALTAS
 * ever runs more than one instance of this service, this moves to Redis or the
 * database, and that is the only reason it would need to.
 */
const pending = new Map();
const TEN_MINUTES = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Step one. Returns the URL to send the person to.
 *
 * `next` is where they end up afterwards, and it is checked against the
 * allowed origins rather than trusted: an open redirect on a sign-in endpoint
 * is how a phishing page borrows your domain's good name.
 */
export function beginSignIn({ next } = {}) {
  sweep();

  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  pending.set(state, { verifier, next: safeNext(next), expires: Date.now() + TEN_MINUTES });

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", config.google.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  /* Ask for an account chooser rather than silently reusing whichever Google
     account the browser happens to be signed into. People have a work account
     and a personal one, and guessing wrong is how somebody creates a company
     under the wrong identity. */
  url.searchParams.set("prompt", "select_account");

  return { url: url.toString(), state };
}

/**
 * Where the person is sent after signing in. Only a path on the app, never a
 * full URL somebody supplied — the check is "does it start with a single
 * slash", which rejects `//evil.example` as well as `https://evil.example`.
 */
function safeNext(next) {
  const s = String(next || "");
  if (!s) return "/";
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  return s;
}

/**
 * Step two. Hand it the `code` and `state` Google came back with; get a
 * verified identity or an error that says which part failed.
 */
export async function completeSignIn({ code, state }, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  sweep();

  if (!code) throw badRequest("Google did not return a sign-in code.");
  if (!state) throw badRequest("Google did not return the state value.");

  const held = pending.get(state);
  /* Single use. A replayed callback must not produce a second session. */
  pending.delete(state);

  if (!held) {
    throw unauthorized(
      "That sign-in link has expired or was already used. Press sign in again — it takes a second."
    );
  }

  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: "authorization_code",
    code_verifier: held.verifier,
  });

  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    /* Google's error body names the misconfiguration — redirect_uri_mismatch
       is far and away the most common, and it is worth saying so rather than
       making somebody read a generic failure. */
    const detail = await res.text().catch(() => "");
    const hint = /redirect_uri_mismatch/.test(detail)
      ? ` The redirect URI registered in Google Cloud must be exactly: ${config.google.redirectUri}`
      : "";
    throw unauthorized("Google would not complete the sign-in." + hint);
  }

  const tokens = await res.json();
  if (!tokens.id_token) throw unauthorized("Google did not return an identity token.");

  const identity = await verifyIdToken(tokens.id_token, deps);
  return { identity, next: held.next };
}

/**
 * Verify the ID token properly: signature against Google's keys, `iss` is
 * Google, `aud` is this application. Skipping any of the three turns a signed
 * assertion into a string anybody can type.
 */
export async function verifyIdToken(idToken, deps = {}) {
  const keys = deps.jwks || JWKS;
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: ISSUERS,
      audience: config.google.clientId,
    }));
  } catch (e) {
    throw unauthorized("That Google identity could not be verified.");
  }

  if (!payload.sub) throw unauthorized("Google's response had no account identifier.");
  if (!payload.email) {
    throw unauthorized("This Google account has no email address, and PALTAS needs one.");
  }
  /*
   * AN UNVERIFIED GOOGLE EMAIL IS NOT AN EMAIL.
   *
   * Google will happily assert an address the account holder never proved they
   * control. Accepting it means somebody can claim a colleague's address and
   * be matched to their PALTAS user.
   */
  if (payload.email_verified === false) {
    throw unauthorized(
      "Google has not verified that address. Verify it with Google and sign in again."
    );
  }

  return {
    googleSub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || ""),
    picture: String(payload.picture || ""),
  };
}

/** For tests, and for a deploy that wants to start clean. */
export function _resetPending() {
  pending.clear();
}
export function _pendingSize() {
  return pending.size;
}
