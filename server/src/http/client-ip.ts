/*
 * Who is calling: the client address every per-address limit uses (req.ip).
 *
 * paltas.io reaches this API through Netlify's proxy (/api/*), and Render's load balancer sits in front of the server.
 * The leftmost X-Forwarded-For entry is whatever the caller wrote, so trusting it lets anyone pick a fresh address per
 * request and step around the sign-up, password-reset, enquiry and booking limits.
 *
 * With PROXY_SIGNING_SECRET set (the same value as Netlify's signed-proxy secret), each request is resolved here:
 * - signed by Netlify (x-nf-sign, HS256 with the shared secret): the visitor's address Netlify measured
 *   (x-nf-client-connection-ip);
 * - anything else (a direct call to the Render URL): the address Render's load balancer saw — the rightmost
 *   X-Forwarded-For entry, which the caller cannot write.
 * Without the secret nothing changes. Activation order: Netlify signs first, then the secret is set on Render.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** True when the token is a compact HS256 JWS signed with the secret and issued by Netlify. */
export function netlifySigned(token: unknown, secret: string): boolean {
  if (typeof token !== "string" || token.length > 4096) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(b64url(h).toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return false;
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const given = b64url(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const claims = JSON.parse(b64url(p).toString("utf8")) as { iss?: string; exp?: number };
    if (claims.iss !== undefined && claims.iss !== "netlify") return false;
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(",") : (v ?? ""));

/** The client address for this request's headers (see above). Empty when there is nothing trustworthy. */
export function clientAddress(headers: Record<string, string | string[] | undefined>, secret: string): string {
  if (netlifySigned(headers["x-nf-sign"], secret)) {
    const measured = one(headers["x-nf-client-connection-ip"]).trim();
    if (measured) return measured;
  }
  const chain = one(headers["x-forwarded-for"])
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - 1] ?? "";
}

/** Rewrites X-Forwarded-For to the one trusted address before anything reads req.ip. */
export function registerClientAddress(server: FastifyInstance, secret: string | undefined): void {
  if (!secret) return;
  server.addHook("onRequest", async (req) => {
    const h = req.raw.headers;
    const addr = clientAddress(h, secret);
    if (addr) h["x-forwarded-for"] = addr;
    else delete h["x-forwarded-for"];
  });
}
