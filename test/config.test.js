/* ====================================================================== *
 * BOOT.
 *
 * A service that starts happily and fails on the first sign-in is worse than
 * one that refuses to start: the first you find in production, the second you
 * find in the deploy log. These are the refusals.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * config.js validates the environment AT IMPORT TIME and throws if anything is
 * missing. That is the behaviour under test, and it also means this file has
 * to satisfy it before importing — so the import is dynamic and comes after
 * the environment is set. The alternative, making the module import lazily,
 * would weaken the very guarantee these tests exist to protect.
 */
process.env.DATABASE_URL ||= "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "shh";
process.env.PUBLIC_URL ||= "https://api.example.test";
process.env.APP_URL ||= "https://app.example.test";

const { readConfig } = await import("../src/config.js");

const ok = {
  DATABASE_URL: "postgresql://u@h/db",
  SESSION_SECRET: "a-long-random-string",
  GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "shh",
  PUBLIC_URL: "https://api.paltas.io",
  APP_URL: "https://paltas.io",
};

test("a complete environment is accepted", () => {
  const c = readConfig({ ...ok });
  assert.equal(c.publicUrl, "https://api.paltas.io");
  assert.equal(c.appUrl, "https://paltas.io");
  assert.equal(c.google.redirectUri, "https://api.paltas.io/auth/google/callback");
});

test("a missing setting stops the service, and the message says which", () => {
  for (const key of Object.keys(ok)) {
    const env = { ...ok };
    delete env[key];
    assert.throws(() => readConfig(env), (e) => {
      assert.match(e.message, new RegExp(key), `the error does not name ${key}`);
      assert.match(e.message, /cannot start/i);
      return true;
    }, `a missing ${key} was allowed`);
  }
});

test("an empty setting counts as missing", () => {
  assert.throws(() => readConfig({ ...ok, SESSION_SECRET: "   " }), /SESSION_SECRET/);
});

test("a trailing slash does not become a double slash in the redirect URI", () => {
  const c = readConfig({ ...ok, PUBLIC_URL: "https://api.paltas.io/" });
  assert.equal(c.google.redirectUri, "https://api.paltas.io/auth/google/callback");
});

/* ================================================================ *
 * The one that exists because it has bitten this project before.
 * ================================================================ */
test("a secret named NEXT_PUBLIC_ refuses to start the service", () => {
  assert.throws(
    () => readConfig({ ...ok, NEXT_PUBLIC_DATABASE_URL: "postgresql://u@h/db" }),
    /compiled into the browser bundle/i);

  assert.throws(
    () => readConfig({ ...ok, NEXT_PUBLIC_STRIPE_SECRET_KEY: "pretend_value_not_a_key" }),
    /NEXT_PUBLIC_STRIPE_SECRET_KEY/);

  assert.throws(
    () => readConfig({ ...ok, NEXT_PUBLIC_API_TOKEN: "t" }), /rotate the values/i);
});

test("a NEXT_PUBLIC_ value that is genuinely public is fine", () => {
  /* The prefix is not the problem. A secret carrying it is. */
  assert.doesNotThrow(() => readConfig({ ...ok, NEXT_PUBLIC_SITE_NAME: "PALTAS" }));
  assert.doesNotThrow(() => readConfig({ ...ok, NEXT_PUBLIC_MAP_STYLE: "streets" }));
});

/* ================================================================ */
test("the app's own origin is always allowed to call the API", () => {
  const c = readConfig({ ...ok });
  assert.ok(c.origins.includes("https://paltas.io"));
});

test("extra origins are parsed, trimmed and de-slashed", () => {
  const c = readConfig({
    ...ok,
    ALLOWED_ORIGINS: " https://staging.paltas.io/ , http://127.0.0.1:8899 ,, ",
  });
  /* Trailing slashes removed, whitespace trimmed, empty entries dropped. */
  assert.ok(c.origins.includes("https://staging.paltas.io"), "trailing slash not removed");
  assert.ok(c.origins.includes("http://127.0.0.1:8899"), "whitespace not trimmed");
  assert.equal(c.origins.filter((o) => o === "").length, 0, "an empty entry survived");
});

test("the deployment's own origins are allowed without anybody setting a variable", () => {
  /*
   * WHY THESE ARE IN CODE AND NOT ONLY IN THE ENVIRONMENT.
   *
   * APP_URL and ALLOWED_ORIGINS are both dashboard settings, so both can be
   * missing or wrong in a console nobody has opened — and a missing origin
   * does not fail loudly at boot. It fails as a CORS error, in one browser, on
   * one deployment, for one person, long after the deploy looked fine.
   *
   * The production hostnames are facts about where this is deployed, not
   * preferences, so they are written down.
   */
  const c = readConfig({ ...ok });
  for (const o of ["https://paltas.io", "https://www.paltas.io",
                   "https://paltas-frontend.netlify.app"]) {
    assert.ok(c.origins.includes(o), `${o} is not allowed to call the API`);
  }
});

test("it is still an allow-list, and an origin listed twice is listed once", () => {
  /* APP_URL repeats a production origin here. A duplicate is harmless to a
     Set but makes the list misleading to read, and a wildcard would be a
     different thing entirely — the session is a cookie, so "*" with
     credentials hands it to whatever site asks. */
  const c = readConfig({ ...ok, ALLOWED_ORIGINS: "https://paltas.io, https://paltas.io/" });
  assert.equal(c.origins.filter((o) => o === "https://paltas.io").length, 1,
    "https://paltas.io appears more than once");
  assert.equal(c.origins.includes("*"), false, "a wildcard origin must never appear");
  assert.ok(c.origins.length >= 3);
});

test("cookies are secure unless something explicitly turns that off", () => {
  assert.equal(readConfig({ ...ok }).secureCookies, true);
  assert.equal(readConfig({ ...ok, INSECURE_COOKIES: "1" }).secureCookies, false);
  /* Any other value is not an opt-out. "0", "false" and "no" all leave the
     cookie secure, which is the safe reading of an ambiguous setting. */
  assert.equal(readConfig({ ...ok, INSECURE_COOKIES: "0" }).secureCookies, true);
  assert.equal(readConfig({ ...ok, INSECURE_COOKIES: "false" }).secureCookies, true);
});

/* ================================================================ *
 * THE DEPLOYMENT SHAPE, AND THE COOKIE IT IMPLIES.
 *
 * This is the setting that fails in the worst possible way when it is
 * wrong: a third-party session cookie is one Safari refuses to store, so
 * sign-in works on the developer's laptop and fails on every iPhone, with
 * no error in any console. It is decided from the two URLs rather than
 * configured twice and got wrong once.
 * ================================================================ */

test("the API proxied under the app's own domain is same-origin", () => {
  const c = readConfig({ ...ok, PUBLIC_URL: "https://paltas.io/api", APP_URL: "https://paltas.io" });
  assert.equal(c.sameOrigin, true, "a path prefix should not change the origin");
  assert.equal(c.cookieSameSite, "lax", "a first-party cookie should be Lax");
});

test("a separate API hostname is cross-site, and says so", () => {
  const c = readConfig({ ...ok, PUBLIC_URL: "https://api.paltas.io", APP_URL: "https://paltas.io" });
  assert.equal(c.sameOrigin, false, "api.paltas.io and paltas.io are different origins");
  assert.equal(c.cookieSameSite, "none",
    "a third-party cookie must be SameSite=None or it is not sent at all");
});

test("a different scheme is a different origin", () => {
  const c = readConfig({ ...ok, PUBLIC_URL: "http://paltas.io/api", APP_URL: "https://paltas.io" });
  assert.equal(c.sameOrigin, false);
});

test("a different port is a different origin", () => {
  const c = readConfig({
    ...ok, PUBLIC_URL: "http://127.0.0.1:8080", APP_URL: "http://127.0.0.1:8899",
  });
  assert.equal(c.sameOrigin, false, "two ports on localhost are two origins");
});

test("the same-site setting can still be forced by hand", () => {
  /* An escape hatch, because a deployment shape nobody anticipated should not
     need a code change — but it is an override, not the normal path. */
  const c = readConfig({ ...ok, COOKIE_SAMESITE: "strict" });
  assert.equal(c.cookieSameSite, "strict");
});

test("a proxied deployment trusts one more hop than a direct one", () => {
  /* Netlify → Render is two proxies; Render alone is one. Trust too few and
     every request looks like it came from the proxy, so one noisy visitor
     rate-limits everybody; trust too many and X-Forwarded-For can be spoofed. */
  const proxied = readConfig({ ...ok, PUBLIC_URL: "https://paltas.io/api", APP_URL: "https://paltas.io" });
  const direct = readConfig({ ...ok, PUBLIC_URL: "https://api.paltas.io", APP_URL: "https://paltas.io" });
  assert.equal(proxied.trustProxyHops, 2);
  assert.equal(direct.trustProxyHops, 1);
  assert.equal(readConfig({ ...ok, TRUST_PROXY_HOPS: "3" }).trustProxyHops, 3);
});

test("the Google redirect URI survives a path prefix", () => {
  const c = readConfig({ ...ok, PUBLIC_URL: "https://paltas.io/api", APP_URL: "https://paltas.io" });
  assert.equal(c.google.redirectUri, "https://paltas.io/api/auth/google/callback",
    "this exact string is what has to be registered in Google Cloud");
});

test("the cookie is set and cleared with the same same-site value", async () => {
  /* A cookie cleared with different attributes is a cookie the browser keeps —
     which is somebody pressing sign out and staying signed in. */
  const sessions = readFileSync(new URL("../src/auth/sessions.js", import.meta.url), "utf8");
  const set = sessions.match(/setSessionCookie[\s\S]*?\n\}/)[0];
  const clear = sessions.match(/clearSessionCookie[\s\S]*?\n\}/)[0];
  for (const attr of ["httpOnly", "secure", "sameSite", "path"]) {
    assert.ok(set.includes(attr), `setSessionCookie does not set ${attr}`);
    assert.ok(clear.includes(attr), `clearSessionCookie does not match on ${attr}`);
  }
  assert.ok(set.includes("config.cookieSameSite") && clear.includes("config.cookieSameSite"),
    "the two disagree about sameSite");
});
