import { randomBytes } from "node:crypto";

/** A random, unguessable id with a readable prefix, e.g. "usr_3kT9…". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}
