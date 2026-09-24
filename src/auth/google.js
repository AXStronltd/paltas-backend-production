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
import { badRequest, unauthorized } from "../http/errors.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/* Google's signing keys, fetched once and refreshed by the library on its own
   schedule. Google rotates them; a service that caches them forever starts
   rejecting every sign-in on a random Tuesday. */
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/* ------------------------------------------------------ the handshake */

/*
 * THE PENDING SIGN-IN LIVES IN A COOKIE, NOT IN THIS PROCESS.
 *
 * It used to be `new Map()`, held in memory for ten minutes, with a comment
 * saying the cost was that "a sign-in started before a deploy and finished
 * after it fails — the person presses the button again". That reasoning was
 * sound and the conclusion was wrong for where this actually runs:
 *
 *   Render stops an idle instance. Somebody arrives at a cold site, presses
 *   sign in, spends twenty seconds on Google's account chooser, and comes back
 *   to a process that was started after their state was created.
 *
 *   Every deploy empties the Map. On a day with a dozen deploys, a dozen
 *   windows exist in which any sign-in in flight dies.
 *
 *   A second instance breaks it outright: the callback can land anywhere.
 *
 * And the failure is the worst shape available — no error a person can act on,
 * just a redirect back to the sign-in page they started from, which reads as
 * "this site will not let me in" rather than "try again".
 *
 * So the verifier travels with the browser instead, in a signed, HttpOnly,
 * ten-minute cookie. No storage, nothing to sweep, nothing to lose on deploy,
 * and it works with any number of instances. The signature is what stops it
 * being forged; `state` still has to match what Google hands back, so a cookie
 * from one attempt cannot complete another.
 *
 * SameSite=Lax is correct and load-bearing: Google's callback is a top-level
 * GET navigation, which Lax permits. "Strict" would drop the cookie on exactly
 * that request and break every sign-in.
 */
const TEN_MINUTES = 10 * 60 * 1000;

export const OAUTH_COOKIE = "paltas_oauth";

function sign(payload) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

/** The cookie value: the payload, and proof this service wrote it. */
export function sealPending(held) {
  const body = Buffer.from(JSON.stringify(held)).toString("base64url");
  return body + "." + sign(body);
}

/**
 * Read it back, or nothing.
 *
 * Returns null for anything that is not exactly right — missing, malformed,
 * wrong signature, expired. A caller cannot accidentally treat a forged cookie
 * as a real one, because there is no shape in which this returns a half-valid
 * answer.
 */
export function openPending(cookie) {
  if (!cookie || typeof cookie !== "string") return null;
  const cut = cookie.lastIndexOf(".");
  if (cut < 1) return null;
  const body = cookie.slice(0, cut);
  const mac = cookie.slice(cut + 1);

  const expect = sign(body);
  /* Constant-time, so a wrong signature cannot be found one character at a
     time by measuring how long the comparison took. */
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let held;
  try { held = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }

  if (!held || typeof held.verifier !== "string" || typeof held.state !== "string") return null;
  if (!Number.isFinite(held.expires) || Date.now() > held.expires) return null;
  return held;
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
  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  const held = {
    state, verifier, next: safeNext(next), expires: Date.now() + TEN_MINUTES,
  };

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

  /* The caller sets `cookie`; this module never touches a response. */
  return { url: url.toString(), state, cookie: sealPending(held) };
}

/**
 * Where the person is sent after signing in. Only a path on the app, never a
 * full URL somebody supplied — the check is "does it start with a single
 * slash", which rejects `//evil.example` as well as `https://evil.example`.
 */
function safeNext(next) {
  const s = String(next || "");
  if (!s) return "/";

  /* Must be a path on this app, not somewhere else's. */
  if (!s.startsWith("/") || s.startsWith("//")) return "/";

  /*
   * A BACKSLASH IS A SLASH TO A BROWSER.
   *
   * "/\evil.example" passes a startsWith("//") check and is then normalised by
   * Chrome and Safari into "//evil.example" — the same off-site redirect the
   * line above exists to stop, spelled differently. Refused outright rather
   * than rewritten, because there is no legitimate path here with one in it.
   */
  if (s.includes("\\")) return "/";

  /*
   * NO CLIMBING OUT.
   *
   * "/../../etc" survived the checks above and resolved to somewhere the app
   * does not live. Same origin, so not an open redirect — but `next` is
   * documented as a path on the app and this was not one.
   */
  if (s.split(/[/?#]/).some((seg) => seg === "..")) return "/";

  /*
   * A newline in a Location header is a second header. Express escapes this
   * today; relying on that is relying on somebody else's implementation
   * detail for a security property.
   */
  if (/[\r\n\t\0]/.test(s)) return "/";

  return s;
}

/**
 * Step two. Hand it the `code` and `state` Google came back with; get a
 * verified identity or an error that says which part failed.
 */
export async function completeSignIn({ code, state, cookie }, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;

  if (!code) throw badRequest("Google did not return a sign-in code.");
  if (!state) throw badRequest("Google did not return the state value.");

  const held = openPending(cookie);

  /*
   * THE STATE FROM GOOGLE MUST MATCH THE ONE IN THE COOKIE.
   *
   * The signature proves this service issued the cookie; this proves it was
   * issued for THIS attempt. Without it a valid cookie from one sign-in could
   * complete a callback belonging to another, which is the cross-site request
   * forgery that `state` exists to prevent.
   *
   * Single use is the caller's job — the route clears the cookie before it
   * gets here, so a replayed callback arrives with nothing.
   */
  if (!held || held.state !== state) {
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
    /*
     * GOOGLE ALREADY SAID WHAT IS WRONG. CARRY IT.
     *
     * The body is `{"error":"invalid_client", ...}` and every value means
     * something different and is fixed somewhere different:
     *
     *   invalid_client       the client id or SECRET is wrong in this
     *                        deployment's environment
     *   invalid_grant        the code was already used, or expired
     *   redirect_uri_mismatch  the URI is not the one registered
     *   unauthorized_client  this client may not use this grant type
     *
     * All four were collapsed into one sentence — "sign-in did not complete,
     * try again" — which is true of all of them and useful for none. Somebody
     * whose client secret is wrong would retry forever.
     *
     * An ALLOW-LIST of Google's own codes, never the raw body: the body is
     * Google's to change, and echoing an unknown string from an upstream
     * service into a redirect is how something that should not be public
     * becomes public.
     */
    const detail = await res.text().catch(() => "");
    let code = "";
    try { code = String(JSON.parse(detail).error || ""); } catch { code = ""; }

    const KNOWN = new Set([
      "invalid_client", "invalid_grant", "invalid_request",
      "redirect_uri_mismatch", "unauthorized_client", "unsupported_grant_type",
    ]);
    const named = KNOWN.has(code) ? code : "";

    const hint = named === "redirect_uri_mismatch"
      ? ` The redirect URI registered in Google Cloud must be exactly: ${config.google.redirectUri}`
      : named === "invalid_client"
        ? " Google did not accept this application's credentials."
        : "";

    const err = unauthorized("Google would not complete the sign-in." + hint);
    /* Read by the route to name the failure on the page the person lands on. */
    err.googleError = named;
    throw err;
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

/*
 * There is nothing left to reset.
 *
 * `_resetPending()` and `_pendingSize()` existed to empty and count the Map
 * this module used to keep. Nothing is stored here now — the pending sign-in
 * travels in the browser's cookie — so both are gone rather than left as
 * functions that would quietly do nothing and let a test believe it had
 * cleared state that never existed.
 */
