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

const { beginSignIn, completeSignIn, verifyIdToken, _resetPending, _pendingSize } =
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

test.beforeEach(() => _resetPending());

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
  const { url, state } = beginSignIn({});
  const challenge = new URL(url).searchParams.get("code_challenge");

  const sink = {};
  await completeSignIn({ code: "abc", state }, {
    fetch: tokenEndpoint(await idToken(), sink),
    jwks,
  });

  const verifier = sink.body.get("code_verifier");
  assert.ok(verifier, "no code_verifier was sent — PKCE is decorative");
  const derived = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(derived, challenge, "the verifier does not match the challenge");
});

test("a state can be used exactly once", async () => {
  const { state } = beginSignIn({});
  const deps = { fetch: tokenEndpoint(await idToken()), jwks };

  const first = await completeSignIn({ code: "abc", state }, deps);
  assert.equal(first.identity.email, "person@example.com");

  /* A replayed callback must not produce a second session. */
  await assert.rejects(
    () => completeSignIn({ code: "abc", state }, deps),
    /expired or was already used/i);
});

test("a state nobody issued is refused", async () => {
  const deps = { fetch: tokenEndpoint(await idToken()), jwks };
  await assert.rejects(
    () => completeSignIn({ code: "abc", state: "invented" }, deps),
    /expired or was already used/i);
});

test("a missing code or state is refused before anything else happens", async () => {
  const { state } = beginSignIn({});
  await assert.rejects(() => completeSignIn({ state }, {}), /did not return a sign-in code/i);
  await assert.rejects(() => completeSignIn({ code: "x" }, {}), /did not return the state/i);
  /* And neither attempt consumed the pending sign-in. */
  assert.equal(_pendingSize(), 1);
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
    _resetPending();
    const { state } = beginSignIn({ next: bad });
    const { next } = await completeSignIn({ code: "abc", state },
      { fetch: tokenEndpoint(await idToken()), jwks });
    assert.ok(next.startsWith("/") && !next.startsWith("//"),
      `\`next\` of ${JSON.stringify(bad)} produced ${JSON.stringify(next)}`);
    assert.ok(!/^[a-z]+:/i.test(next), `\`next\` kept a scheme: ${next}`);
  }
});

test("a legitimate path is kept", async () => {
  const { state } = beginSignIn({ next: "/dashboard/hotel.html" });
  const { next } = await completeSignIn({ code: "abc", state },
    { fetch: tokenEndpoint(await idToken()), jwks });
  assert.equal(next, "/dashboard/hotel.html");
});

/* ================================================================ */
test("a refusal from Google's token endpoint names the likely cause", async () => {
  const { state } = beginSignIn({});
  const failing = async () => ({
    ok: false,
    text: async () => '{"error":"redirect_uri_mismatch"}',
  });
  await assert.rejects(
    () => completeSignIn({ code: "abc", state }, { fetch: failing, jwks }),
    /redirect URI registered in Google Cloud must be exactly/i);
});

test("a response with no ID token is refused rather than half-trusted", async () => {
  const { state } = beginSignIn({});
  const noToken = async () => ({ ok: true, json: async () => ({ access_token: "a" }) });
  await assert.rejects(
    () => completeSignIn({ code: "abc", state }, { fetch: noToken, jwks }),
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
