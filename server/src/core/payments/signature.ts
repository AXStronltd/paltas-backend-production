/*
 * Payment provider signatures. Header:  X-Paltas-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
 * The body is verified exactly as received, the timestamp must be recent (replay protection), and the comparison
 * is constant-time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SIGNATURE_MAX_AGE_SECONDS } from "@paltas/contracts";
import { fail } from "../../http/errors.js";

export function signPayload(secret: string, rawBody: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac("sha256", secret).update(`${unixSeconds}.${rawBody}`).digest("hex")}`;
}

export function verifySignature(
  secrets: Record<string, string>,
  provider: string,
  header: string | undefined,
  rawBody: Buffer,
  nowSeconds: number = Date.now() / 1000,
): void {
  const secret = Object.hasOwn(secrets, provider) ? secrets[provider] : undefined;
  if (!secret) throw fail.notFound("Unknown payment provider");
  const parts = Object.fromEntries((header ?? "").split(",").map((x) => x.split("=") as [string, string]));
  const t = Number(parts.t);
  const sig = String(parts.v1 ?? "");
  if (!t || !/^[0-9a-f]{64}$/.test(sig)) throw fail.notSignedIn("Missing or malformed signature");
  if (Math.abs(nowSeconds - t) > SIGNATURE_MAX_AGE_SECONDS) throw fail.notSignedIn("Signature too old");
  const want = createHmac("sha256", secret)
    .update(`${t}.${rawBody.toString("utf8")}`)
    .digest("hex");
  if (!timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(sig, "hex")))
    throw fail.notSignedIn("Signature does not match");
}
