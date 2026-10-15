/*
 * Password hashing with scrypt (memory-hard). Stored form: "scrypt$N$r$p$<salt b64>$<hash b64>".
 * Hashing runs off the main thread (async), so a burst of sign-ins never blocks other requests.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(want, got);
}

/** A hash to compare against when the email is unknown, so the answer takes the same time either way. */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(18).toString("base64"));
  return decoy;
}

/** A random temporary password for a new account (shown once, must be changed at first sign-in). */
export function temporaryPassword(): string {
  return randomBytes(15).toString("base64url");
}
