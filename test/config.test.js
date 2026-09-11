/* ====================================================================== *
 * BOOT.
 *
 * A service that starts happily and fails on the first sign-in is worse than
 * one that refuses to start: the first you find in production, the second you
 * find in the deploy log. These are the refusals.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

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
  assert.deepEqual(c.origins, [
    "https://paltas.io", "https://staging.paltas.io", "http://127.0.0.1:8899",
  ]);
});

test("cookies are secure unless something explicitly turns that off", () => {
  assert.equal(readConfig({ ...ok }).secureCookies, true);
  assert.equal(readConfig({ ...ok, INSECURE_COOKIES: "1" }).secureCookies, false);
  /* Any other value is not an opt-out. "0", "false" and "no" all leave the
     cookie secure, which is the safe reading of an ambiguous setting. */
  assert.equal(readConfig({ ...ok, INSECURE_COOKIES: "0" }).secureCookies, true);
  assert.equal(readConfig({ ...ok, INSECURE_COOKIES: "false" }).secureCookies, true);
});
