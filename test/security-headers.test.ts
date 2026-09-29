/* ====================================================================== *
 * WHAT EVERY RESPONSE CARRIES.
 *
 * These headers had no test at all until this file. That is worth saying
 * plainly: they are the cheapest security control in the service and the
 * easiest to delete by accident, because nothing breaks when they go. A
 * response with no Content-Security-Policy serves every request correctly
 * and passes every other test in this suite.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

/*
 * config.js validates the environment AT IMPORT TIME and throws if anything
 * is missing, and this module imports it. Same reason and same shape as
 * config.test.js: satisfy the environment first, then import dynamically.
 * These particular values are never read by anything under test here — only
 * the presence check is.
 */
process.env.DATABASE_URL ||= "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "shh";
process.env.PUBLIC_URL ||= "https://api.example.test";
process.env.APP_URL ||= "https://app.example.test";

const { headersFor } = await import("../src/http/security-headers.ts");

const HTTPS = headersFor(true);
const PLAIN = headersFor(false);

test("the headers that do not depend on the scheme are always sent", () => {
  for (const headers of [HTTPS, PLAIN]) {
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
    assert.equal(headers["X-Frame-Options"], "DENY");
  }
});

test("the policy allows nothing, because this service returns JSON", () => {
  /* `default-src 'none'` is the whole point — an API response that is somehow
     rendered as a document must not be able to fetch, script or frame. */
  assert.equal(HTTPS["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(PLAIN["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("HSTS is sent over https, for a year, including subdomains", () => {
  const hsts = HTTPS["Strict-Transport-Security"];
  assert.equal(hsts, "max-age=31536000; includeSubDomains");
});

test("HSTS is NOT sent over plain http", () => {
  /*
   * A browser ignores HSTS on a plain-http response, so sending it would be
   * harmless — and untrue. Local development runs on http deliberately; a
   * header asserting the origin is https-only is a statement this service
   * would be making falsely about itself.
   */
  assert.equal(PLAIN["Strict-Transport-Security"], undefined);
});

test("HSTS does not ask to be preloaded", () => {
  /*
   * Preload is a one-way door: the entry is compiled into browser binaries
   * and removal takes months. It is a decision somebody makes on purpose,
   * having checked that every subdomain can serve https forever — not a word
   * that arrives inside a security sweep.
   */
  assert.ok(!String(HTTPS["Strict-Transport-Security"]).includes("preload"));
});
