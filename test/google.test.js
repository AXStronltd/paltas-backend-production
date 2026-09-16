/* ====================================================================== *
 * SIGNING IN WITH GOOGLE.
 *
 * Every assertion here is about a way sign-in can be attacked or can go wrong,
 * and none of them touches the network or the database:
 *
 *   - a `state` cannot be replayed
 *   - the PKCE verifier is actually sent, and it matches the challenge
 *   - an ID token signed by somebody else is refused
 *   - an ID token for a different application is refused
 *   - an unverified Google email is refused
 *   - `next` cannot be turned into an open redirect
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

/* config.js reads the environment at import time and refuses to start without
   it, which is the behaviour we want in production and something a test has to
   satisfy before importing anything. */
process.env.DATABASE_URL ||= "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-not-used-for-anything-real";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "https://api.example.test";
process.env.APP_URL ||= "https://app.example.test";

const { beginSignIn, completeSignIn, verifyIdToken, openPending } =
  await import("../src/auth/google.js");

/* ---------------------------------------------------- a fake Google ---- */

const google = await generateKeyPair("RS256");
const impostor = await generateKeyPair("RS256");

/* A JWKS that holds only Google's real key, as `jose` expects it. */
const jwks = async () => google.publicKey;
const impostorJwks = async () => impostor.publicKey;

async function idToken(claims = {}, key = google.privateKey) {
  return new SignJWT({
    email: "person@example.com",
    email_verified: true,
    name: "A Person",
    picture: "https://example.test/p.jpg",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(claims.iss || "https://accounts.google.com")
    .setAudience(claims.aud || process.env.GOOGLE_CLIENT_ID)
    .setSubject(claims.sub || "google-subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

/** A stand-in for Google's token endpoint that records what it was sent. */
function tokenEndpoint(token, sink = {}) {
  return async (_url, init) => {
    sink.body = new URLSearchParams(init.body);
    return { ok: true, json: async () => ({ id_token: token }) };
  };
}

/* Nothing to reset: the pending sign-in lives in the browser's cookie, not in
   this module. Each test carries its own. */

/* ================================================================ */
test("the sign-in URL carries a PKCE challenge and a state", () => {
  const { url, state } = beginSignIn({});
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), process.env.GOOGLE_CLIENT_ID);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("code_challenge"), "no PKCE challenge");
  assert.equal(u.searchParams.get("state"), state);
  assert.equal(u.searchParams.get("redirect_uri"), "https://api.example.test/auth/google/callback");
  /* An account chooser rather than silently reusing whichever Google account
     the browser happens to be signed into. */
  assert.equal(u.searchParams.get("prompt"), "select_account");
});

test("the verifier sent to Google matches the challenge shown to the browser", async () => {
  const { url, state, cookie } = beginSignIn({});
  const challenge = new URL(url).searchParams.get("code_challenge");

  const sink = {};
  await completeSignIn({ code: "abc", state, cookie }, {
    fetch: tokenEndpoint(await idToken(), sink),
    jwks,
  });

  const verifier = sink.body.get("code_verifier");
  assert.ok(verifier, "no code_verifier was sent — PKCE is decorative");
  const derived = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(derived, challenge, "the verifier does not match the challenge");
});

test("a callback with no cookie is refused, which is what a replay gets", async () => {
  /*
   * WHERE SINGLE USE LIVES NOW.
   *
   * It used to be here: the Map deleted the entry as it read it. The pending
   * sign-in is a cookie now, so the ROUTE clears it before completing — a
   * replayed callback therefore arrives with nothing, and this is that arrival.
   * The route's own test asserts the clearing; this asserts the refusal.
   */
  const { state, cookie } = beginSignIn({});
  const deps = { fetch: tokenEndpoint(await idToken()), jwks };
  await assert.rejects(
    () => completeSignIn({ code: "abc", state, cookie: null }, deps),
    /expired or was already used/i);
});

test("a cookie from one sign-in cannot complete another", async () => {
  /*
   * The signature proves this service issued the cookie. This proves it was
   * issued for THIS attempt — without the check, a valid cookie from one
   * sign-in could complete a callback belonging to a different one, which is
   * exactly the cross-site request forgery `state` exists to prevent.
   */
  const a = beginSignIn({});
  const b = beginSignIn({});
  const deps = { fetch: tokenEndpoint(await idToken()), jwks };
  await assert.rejects(
    () => completeSignIn({ code: "abc", state: b.state, cookie: a.cookie }, deps),
    /expired or was already used/i);
});

test("a forged or tampered cookie is refused", async () => {
  const { state, cookie } = beginSignIn({});
  const deps = { fetch: tokenEndpoint(await idToken()), jwks };

  /* Same payload, a signature somebody made up. */
  const body = cookie.slice(0, cookie.lastIndexOf("."));
  await assert.rejects(
    () => completeSignIn({ code: "abc", state, cookie: body + ".notarealsignature" }, deps),
    /expired or was already used/i);

  /* Unsigned, and shaped like the payload it replaces. */
  const forged = Buffer.from(JSON.stringify({
    state, verifier: "x".repeat(43), next: "/", expires: Date.now() + 60000,
  })).toString("base64url");
  await assert.rejects(
    () => completeSignIn({ code: "abc", state, cookie: forged + "." + forged }, deps),
    /expired or was already used/i);

  assert.equal(openPending(body + ".notarealsignature"), null, "a bad signature opened");
  assert.equal(openPending("nonsense"), null, "a malformed cookie opened");
  assert.equal(openPending(null), null, "a missing cookie opened");
});

test("an expired cookie is refused", () => {
  /* Ten minutes is the window. A cookie past it is not a sign-in in progress,
     it is a tab somebody left open yesterday. */
  const old = Buffer.from(JSON.stringify({
    state: "s", verifier: "v", next: "/", expires: Date.now() - 1,
  })).toString("base64url");
  assert.equal(openPending(old + ".whatever"), null);
});

test("a state nobody issued is refused", async () => {
  const deps = { fetch: tokenEndpoint(await idToken()), jwks };
  await assert.rejects(
    () => completeSignIn({ code: "abc", state: "invented", cookie: null }, deps),
    /expired or was already used/i);
});

test("a missing code or state is refused before anything else happens", async () => {
  const { state, cookie } = beginSignIn({});
  await assert.rejects(() => completeSignIn({ state, cookie }, {}), /did not return a sign-in code/i);
  await assert.rejects(() => completeSignIn({ code: "x", cookie }, {}), /did not return the state/i);
  /* And neither attempt spent the cookie — it is still good for the real one. */
  assert.ok(openPending(cookie), "a refused callback consumed the pending sign-in");
});

test("a token signed by somebody other than Google is refused", async () => {
  const forged = await idToken({}, impostor.privateKey);
  await assert.rejects(() => verifyIdToken(forged, { jwks }), /could not be verified/i);
});

test("a token Google issued for a DIFFERENT application is refused", async () => {
  const other = await idToken({ aud: "someone-elses-app.apps.googleusercontent.com" });
  await assert.rejects(() => verifyIdToken(other, { jwks }), /could not be verified/i);
});

test("a token from the wrong issuer is refused", async () => {
  const other = await idToken({ iss: "https://accounts.not-google.test" });
  await assert.rejects(() => verifyIdToken(other, { jwks }), /could not be verified/i);
});

test("an unverified Google email is refused, and says why", async () => {
  const unverified = await idToken({ email_verified: false });
  await assert.rejects(() => verifyIdToken(unverified, { jwks }),
    /has not verified that address/i);
});

test("a Google account with no email is refused", async () => {
  const noEmail = await new SignJWT({ email_verified: true, name: "X" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience(process.env.GOOGLE_CLIENT_ID)
    .setSubject("sub-2").setIssuedAt().setExpirationTime("5m")
    .sign(google.privateKey);
  await assert.rejects(() => verifyIdToken(noEmail, { jwks }), /no email address/i);
});

test("the email is lower-cased, so one person is one account", async () => {
  const shouty = await idToken({ email: "Person@Example.COM" });
  const id = await verifyIdToken(shouty, { jwks });
  assert.equal(id.email, "person@example.com");
});

test("the identity is keyed on Google's subject, not the email", async () => {
  const id = await verifyIdToken(await idToken({ sub: "stable-123" }), { jwks });
  assert.equal(id.googleSub, "stable-123");
});

/* ================================================================ */
test("`next` cannot be turned into an open redirect", async () => {
  const attempts = [
    "https://evil.example/steal",
    "//evil.example/steal",
    "http://evil.example",
    "javascript:alert(1)",
    "",
    null,
    undefined,
  ];

  for (const bad of attempts) {
    const { state, cookie } = beginSignIn({ next: bad });
    const { next } = await completeSignIn({ code: "abc", state, cookie },
      { fetch: tokenEndpoint(await idToken()), jwks });
    assert.ok(next.startsWith("/") && !next.startsWith("//"),
      `\`next\` of ${JSON.stringify(bad)} produced ${JSON.stringify(next)}`);
    assert.ok(!/^[a-z]+:/i.test(next), `\`next\` kept a scheme: ${next}`);
  }
});

test("a legitimate path is kept", async () => {
  const { state, cookie } = beginSignIn({ next: "/dashboard/hotel.html" });
  const { next } = await completeSignIn({ code: "abc", state, cookie },
    { fetch: tokenEndpoint(await idToken()), jwks });
  assert.equal(next, "/dashboard/hotel.html");
});

/* ================================================================ */
test("a refusal from Google's token endpoint names the likely cause", async () => {
  const { state, cookie } = beginSignIn({});
  const failing = async () => ({
    ok: false,
    text: async () => '{"error":"redirect_uri_mismatch"}',
  });
  await assert.rejects(
    () => completeSignIn({ code: "abc", state, cookie }, { fetch: failing, jwks }),
    /redirect URI registered in Google Cloud must be exactly/i);
});

test("a response with no ID token is refused rather than half-trusted", async () => {
  const { state, cookie } = beginSignIn({});
  const noToken = async () => ({ ok: true, json: async () => ({ access_token: "a" }) });
  await assert.rejects(
    () => completeSignIn({ code: "abc", state, cookie }, { fetch: noToken, jwks }),
    /did not return an identity token/i);
});

/* Keeps the impostor key referenced so the intent of the file is obvious even
   to a reader skimming: there are two keypairs, and only one of them is Google. */
test("the impostor key really is a different key", async () => {
  const a = await exportJWK(google.publicKey);
  const b = await exportJWK(impostor.publicKey);
  assert.notEqual(a.n, b.n);
  assert.ok(impostorJwks);
});

test("`next` is a path on this app, and nothing else", () => {
  /*
   * Found by driving the live endpoint during an audit. The off-site forms were
   * already refused; these three were not.
   */
  const cases = [
    // [what somebody sends,            what must come back]
    ["https://evil.example/steal",      "/"],
    ["//evil.example",                  "/"],
    ["/dashboard/guest.html",           "/dashboard/guest.html"],

    /* A BACKSLASH IS A SLASH TO A BROWSER. Chrome and Safari normalise
       "/\\evil.example" into "//evil.example" — the same off-site redirect,
       spelled so it passes a startsWith("//") check. */
    ["/\\evil.example",                 "/"],
    ["/\\\\evil.example",               "/"],

    /* NO CLIMBING OUT. Same origin, so never an open redirect — but `next` is
       documented as a path on the app, and this was not one. */
    ["/../../etc",                      "/"],
    ["/dashboard/../../../admin",       "/"],

    /* A newline in a Location header is a second header. */
    ["/ok\r\nSet-Cookie: a=b",          "/"],
    ["/ok\nX-Injected: 1",              "/"],

    /* And the ordinary ones still work. */
    ["/",                               "/"],
    ["",                                "/"],
    ["/auth/login.html?signin=failed",  "/auth/login.html?signin=failed"],
    /* ".." only counts as a whole segment — a filename may contain dots. */
    ["/dashboard/my..file.html",        "/dashboard/my..file.html"],
  ];

  for (const [sent, want] of cases) {
    const { state, cookie } = beginSignIn({ next: sent });
    const held = openPending(cookie);
    assert.equal(held.state, state);
    assert.equal(held.next, want,
      `next=${JSON.stringify(sent)} became ${JSON.stringify(held.next)}, expected ${JSON.stringify(want)}`);
  }
});

/* ====================================================================== *
 * THE COOKIE HAS TO REACH THE CALLBACK.
 *
 * This is the bug that made sign-in look like a loop on production: the PKCE
 * cookie was scoped Path=/auth, Google sent the browser to
 * /api/auth/google/callback, and a cookie is only returned on request paths
 * that start with its Path. "/api/auth/google/callback" does not start with
 * "/auth", so it was never sent. The callback found no verifier, refused, and
 * redirected the person back to the login page they started on — no error, no
 * account, no way to tell why.
 *
 * It is silent, it is environment-dependent, and every test that stubs the
 * cookie passes straight through it. So the invariant is asserted directly.
 * ====================================================================== */

test("the PKCE cookie is scoped so the browser sends it to the callback", async () => {
  const cases = [
    ["https://paltas.io/api", "/api/auth"],   /* behind the Netlify proxy */
    ["https://x.onrender.com", "/auth"],      /* straight at the service  */
    ["https://paltas.io/api/", "/api/auth"],  /* trailing slash           */
  ];

  const { readConfig } = await import("../src/config.js");
  const base = {
    DATABASE_URL: "postgresql://u@h/db",
    SESSION_SECRET: "a-long-random-string",
    GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "shh",
    APP_URL: "https://paltas.io",
  };

  for (const [publicUrl, want] of cases) {
    const cfg = readConfig({ ...base, PUBLIC_URL: publicUrl });

    assert.equal(cfg.google.cookiePath, want,
      `PUBLIC_URL=${publicUrl} must scope the cookie to ${want}`);

    /*
     * THE ACTUAL RULE, not a restatement of the line above: whatever the
     * redirect URI is, the cookie path must be a prefix of its path. If these
     * two ever drift apart again, sign-in breaks and this fails.
     */
    const callback = new URL(cfg.google.redirectUri).pathname;
    assert.ok(callback.startsWith(cfg.google.cookiePath),
      `the browser will not send a Path=${cfg.google.cookiePath} cookie to ` +
      `${callback} — sign-in bounces back to the login page`);
  }
});

test("nothing hardcodes the cookie path any more", async () => {
  const { readFileSync } = await import("node:fs");
  const auth = readFileSync(new URL("../src/routes/auth.js", import.meta.url), "utf8");
  assert.ok(!/path: ?"\/auth"/.test(auth),
    'a literal path: "/auth" is back in auth.js. It is correct only when ' +
    "PUBLIC_URL has no prefix, and wrong on production.");
  assert.match(auth, /path: config\.google\.cookiePath/,
    "the cookie path must come from config, where it is derived from PUBLIC_URL");
});
