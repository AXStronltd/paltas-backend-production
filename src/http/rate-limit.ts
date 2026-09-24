/* ====================================================================== *
 * TOO MANY REQUESTS.
 * ====================================================================== */

import type { Request, RequestHandler } from "express";

/*
 * A small fixed-window counter, in memory.
 *
 * Not a defence against a determined attacker — that belongs at the edge. This
 * stops the ordinary accidents: a retry loop in someone's script, a page that
 * calls the public feed on every scroll event, a sign-in button double-clicked
 * forty times. Those are what actually take a small service down.
 */
export interface RateLimitOptions {
  readonly windowMs?: number;
  readonly max?: number;
  /**
   * What counts as one caller.
   *
   * Defaults to req.ip. The endpoints that cost money key by something
   * narrower — a session, an organization — because an IP is shared by an
   * office and a mobile network.
   */
  readonly key?: (req: Request) => string | undefined;
}

/** One caller's count, and when it resets. */
interface Bucket { n: number; reset: number }

export function rateLimit({ windowMs = 60_000, max = 120, key }: RateLimitOptions = {}): RequestHandler {
  const hits = new Map<string, Bucket>();
  return (req, res, next) => {
    const now = Date.now();
    const id = (key ? key(req) : req.ip) || "anon";
    const bucket = hits.get(id);

    if (!bucket || bucket.reset < now) {
      hits.set(id, { n: 1, reset: now + windowMs });
    } else if (++bucket.n > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.reset - now) / 1000));
      res.status(429).json({
        error: "too_many_requests",
        message: "That is more requests than this endpoint allows in a minute. Wait a moment and try again.",
      });
      return;
    }

    /* Sweep occasionally rather than on every request. */
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}
