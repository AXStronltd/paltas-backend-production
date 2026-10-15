/*
 * Time-based one-time codes (RFC 6238, SHA-1, 6 digits, 30-second steps) for authenticator apps.
 * A code from the previous or next step is accepted to allow for clock drift.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totp(secret: string, atMs: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = (h[h.length - 1] as number) & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, atMs: number = Date.now()): boolean {
  const given = Buffer.from(code.trim());
  return [-30_000, 0, 30_000].some((d) => {
    const want = Buffer.from(totp(secret, atMs + d));
    return want.length === given.length && timingSafeEqual(want, given);
  });
}

export function otpauthUrl(secret: string, account: string): string {
  return `otpauth://totp/${encodeURIComponent("PALTAS:" + account)}?secret=${secret}&issuer=PALTAS`;
}
