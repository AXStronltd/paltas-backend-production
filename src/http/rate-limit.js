/* ====================================================================== *
 * TOO MANY REQUESTS.
 * ====================================================================== */

/*
 * A small fixed-window counter, in memory.
 *
 * Not a defence against a determined attacker — that belongs at the edge. This
 * stops the ordinary accidents: a retry loop in someone's script, a page that
 * calls the public feed on every scroll event, a sign-in button double-clicked
 * forty times. Those are what actually take a small service down.
 */
export function rateLimit({ windowMs = 60_000, max = 120, key } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = (key ? key(req) : req.ip) || "anon";
    const bucket = hits.get(id);

    if (!bucket || bucket.reset < now) {
      hits.set(id, { n: 1, reset: now + windowMs });
    } else if (++bucket.n > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.reset - now) / 1000));
      return res.status(429).json({
        error: "too_many_requests",
        message: "That is more requests than this endpoint allows in a minute. Wait a moment and try again.",
      });
    }

    /* Sweep occasionally rather than on every request. */
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}
