/* ====================================================================== *
 * HEADERS ON EVERY RESPONSE.
 * ====================================================================== */

export function securityHeaders() {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    /* This service returns JSON, not pages. Nothing it sends should ever be
       treated as a document with permission to load anything. */
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.removeHeader("X-Powered-By");
    next();
  };
}
