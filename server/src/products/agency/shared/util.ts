// Small helpers shared by the agency services: percentages, tokens, database rule errors, the audit actor of a
// public visitor.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Actor } from "../../../core/audit/audit.service.js";
import { fail } from "../../../http/errors.js";

/** A percentage (two decimals at most) as basis points: 7.5 → 750. */
export const toBp = (pct: number): number => Math.round(pct * 100);
export const toPct = (bp: number): number => bp / 100;

/** bp of an amount in minor units, rounded half up, exact for any safe integer. */
export function shareOf(amountMinor: number, bp: number): number {
  return Number((BigInt(amountMinor) * BigInt(bp) + 5000n) / 10000n);
}

/** A private token for a buyer or guest (returned once) and the hash that is stored. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The private code for a request the browser identified with a random request id: derived with the server's secret
 *  key, so the same request sent again gets the same code (a lost answer can be recovered) and nobody can compute it
 *  without that key. */
export function requestToken(
  key: string,
  kind: "booking" | "offer",
  requestId: string,
): { token: string; hash: string } {
  const token = createHmac("sha256", key).update(`${kind}:${requestId}`).digest("base64url").slice(0, 32);
  return { token, hash: hashToken(token) };
}

/** Who acts on a public endpoint: an anonymous visitor (the audit log keeps no address). */
export const VISITOR: Actor = { userId: null, role: "public visitor" };

/** Run a statement; a violation of the named exclusion constraint becomes a clear 409. */
export async function exclusive<T>(p: Promise<T>, message: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23P01") throw fail.conflict(message);
    // Competing exclusion checks can deadlock. PostgreSQL rolls back a victim; never report a server crash
    // or automatically retry a customer action. The client can refresh the calendar and choose again.
    if (code === "40P01" || code === "40001")
      throw fail.conflict("The booking calendar changed while you were saving. Refresh and try again.");
    throw e;
  }
}

/** Run a statement; a unique-index violation becomes a clear 409. */
export async function unique<T>(p: Promise<T>, message: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw fail.conflict(message);
    throw e;
  }
}

/** Phone numbers are matched without spaces, dashes or brackets. */
export const normPhone = (p: string | null | undefined): string | null => (p ? p.replace(/[\s()-]/g, "") : null);

/** Whole days from a to b ("YYYY-MM-DD"). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}
