/* ====================================================================== *
 * HEADERS ON EVERY RESPONSE.
 * ====================================================================== */

import { config } from "../config.ts";
import type { RequestHandler } from "express";

/**
 * The headers, as a value, for a connection that is or is not HTTPS.
 *
 * Split out from the middleware because it is the part with a decision in it.
 * A middleware can only be checked by standing up a server and reading a
 * response, and a server reads `config` once at import — so a test can hold
 * exactly one answer to "am I on https" per process, and the interesting
 * thing here is that there are two. As a function of a boolean, both are one
 * assertion each.
 */
export function headersFor(https: boolean): Readonly<Record<string, string>> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    /* This service returns JSON, not pages. Nothing it sends should ever be
       treated as a document with permission to load anything. */
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",

    /*
     * ── HSTS, AND WHY THE API NEEDS ITS OWN ──────────────────────────────
     *
     * Netlify already sends this for the app. That covers a browser visiting
     * the site; it does NOT cover this service, which is reachable directly
     * on its Render hostname and answers requests carrying the session
     * cookie. A header the proxy sends says nothing about the origin behind
     * it, so the first plain-http request to the API is the one that leaks
     * the cookie — and that is the request this header stops from ever being
     * made a second time.
     *
     * No `preload`. Preloading is a one-way door baked into browser binaries
     * and removal takes months; it wants a deliberate submission, not a line
     * that arrived with a security sweep.
     */
    ...(https ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

export function securityHeaders(): RequestHandler {
  /*
   * Decided once, not per request. `secureCookies` is already this service's
   * answer to "am I on https" — it is what decides whether the session cookie
   * carries Secure, and a response that would not send the cookie securely
   * must not claim the origin is HTTPS-only either. Keeping the two on one
   * signal means they cannot drift into disagreeing about the same fact.
   */
  const headers = headersFor(config.secureCookies);
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.removeHeader("X-Powered-By");
    next();
  };
}
