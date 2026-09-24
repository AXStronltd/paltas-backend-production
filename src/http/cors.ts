/* ====================================================================== *
 * WHICH BROWSERS MAY CALL THIS API.
 * ====================================================================== */

import { config } from "../config.ts";
import type { RequestHandler } from "express";

/*
 * An allow-list, and never "*".
 *
 * The session travels as a cookie, so `Access-Control-Allow-Credentials` is
 * on; a wildcard origin with credentials is the browser handing a session to
 * whichever site asked for it. A request from an origin not on the list gets
 * no CORS headers at all and the browser refuses it — which is the correct
 * outcome and needs no error of our own.
 */
export function cors(): RequestHandler {
  const allowed = new Set(config.origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin.replace(/\/+$/, ""))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  };
}
