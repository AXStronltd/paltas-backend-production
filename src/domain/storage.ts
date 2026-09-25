import type { Env } from "../config.ts";

/* ====================================================================== *
 * WHERE A CUSTOMER'S DOCUMENTS ACTUALLY LIVE.
 *
 * The Document row has always carried `storageKey` — "WHERE THE BYTES
 * ACTUALLY ARE. A key in object storage, never content." — and there was no
 * object storage. A company could record that a title deed exists and had no
 * way to attach it. This is the missing half.
 *
 * ── PALTAS NEVER HOLDS THE BYTES ───────────────────────────────────────
 *
 * The browser uploads straight to storage with a presigned URL. Nothing is
 * posted through this API. That is not only about bandwidth: documents here
 * are title deeds, certificates of incorporation and tax records, and the
 * fewer places they pass through the smaller the question of who has seen
 * them.
 *
 * ── THE KEY IS THE SERVER'S TO DECIDE ──────────────────────────────────
 *
 * This is the whole security of the thing, so it is stated plainly: a caller
 * NEVER supplies a storage key. It is built here from the organization that
 * owns the document, and every key begins `org/<orgId>/`. A presigned URL can
 * therefore only ever write inside the tenant that asked for it.
 *
 * Reading is checked the same way and separately — `keyBelongsTo()` is
 * applied before any download is signed, so a storageKey that somehow got
 * changed in the database still cannot be used to read another company's file.
 *
 * ── NOT CONFIGURED IS AN ANSWER ────────────────────────────────────────
 *
 * With no credentials set, this reports that uploads are unavailable and says
 * why, in the same shape as a connected one. It does not throw at import and
 * it does not take the service down. Every other part of PALTAS keeps working
 * without it, exactly as it did before.
 * ====================================================================== */

import crypto from "node:crypto";
import { presign } from "../storage/sigv4.js";

/* Kept small on purpose. A document is a certificate or a deed; anything
   approaching this size is a video somebody has put in the wrong place. */
export const MAX_BYTES = 25 * 1024 * 1024;

/* What a document may be. An allow-list rather than a block-list: the risk is
   an uploaded file that a browser will later EXECUTE, and listing what is
   dangerous has never once been a complete list. */
export const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function settings(env = process.env) {
  const accountId = String(env.R2_ACCOUNT_ID || "").trim();
  const bucket = String(env.R2_BUCKET || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  /*
   * The endpoint is derived from the account, and overridable.
   *
   * R2's host is account-specific, so it is computed rather than configured.
   * R2_ENDPOINT exists for the two cases where that is not what is wanted: an
   * S3-compatible provider that is not R2, and the round-trip test, which
   * stands a real HTTP server up in front of this and puts a file through it.
   * A feature that can only be tested against production is a feature nobody
   * tests.
   */
  const endpoint = String(env.R2_ENDPOINT || "").trim();
  return {
    accountId, bucket, accessKeyId, secretAccessKey,
    /* R2 is S3-compatible and path-style: the bucket is part of the path. */
    host: endpoint ? endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "")
                   : `${accountId}.r2.cloudflarestorage.com`,
    insecure: /^http:\/\//.test(endpoint),
    region: String(env.R2_REGION || "auto"),
  };
}

export function isConfigured(env: Env = process.env): boolean { return settings(env) !== null; }

/**
 * Whether documents can be uploaded, and if not, exactly what is missing.
 * Never throws — a settings screen asking "can we take documents" must get an
 * answer, and "no, because X" is an answer.
 */
export function describe(env: Env = process.env) {
  const s = settings(env);
  if (s) {
    return {
      connected: true, provider: "cloudflare-r2", bucket: s.bucket,
      maxBytes: MAX_BYTES, accepts: [...ALLOWED_TYPES],
      why: "Document uploads are available.",
    };
  }
  const missing = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    .filter((k) => !String(env[k] || "").trim());
  return {
    connected: false, provider: "cloudflare-r2", bucket: "",
    maxBytes: MAX_BYTES, accepts: [...ALLOWED_TYPES],
    why: `Document uploads are not available: ${missing.join(", ")} ${
      missing.length === 1 ? "is" : "are"} not set.`,
  };
}

/** A visitor-safe version: says whether it works, never which setting is absent. */
export function publicDescribe(env: Env = process.env) {
  const d = describe(env);
  return {
    connected: d.connected, maxBytes: d.maxBytes, accepts: d.accepts,
    why: d.connected ? "" : "Document uploads are not available at the moment.",
  };
}

/** What a storage key is built from. Never accepted from a caller. */
export interface KeyParts {
  readonly orgId?: string;
  readonly documentId?: string;
  readonly filename?: unknown;
}

/** Permission to upload one file, to one key, for a few minutes. */
export interface UploadRequest extends KeyParts {
  readonly contentType?: unknown;
  readonly bytes?: unknown;
  readonly env?: Env;
}

export interface DownloadRequest {
  readonly storageKey?: string;
  readonly orgId?: string;
  readonly filename?: unknown;
  readonly env?: Env;
}

export interface HeadRequest {
  readonly storageKey?: string;
  readonly orgId?: string;
  readonly env?: Env;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Only the characters a filename may keep. Everything else becomes "-". */
export function safeName(name: unknown): string {
  const base = String(name || "file").split(/[\\/]/).pop() ?? "file";
  const cleaned = base.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-");
  const trimmed = cleaned.replace(/^[.\-]+/, "").slice(0, 80);
  return trimmed || "file";
}

/**
 * The object key for a document.
 *
 * Built here and never accepted from a caller. The organization is the first
 * path segment, which is what every tenancy check below relies on. The random
 * segment means re-uploading does not silently overwrite the previous file,
 * so a replaced document is still recoverable.
 */
export function keyFor({ orgId, documentId, filename }: KeyParts): string {
  if (!orgId) throw new Error("a storage key needs an organization");
  if (!documentId) throw new Error("a storage key needs a document");
  const unique = crypto.randomBytes(8).toString("hex");
  return `org/${orgId}/documents/${documentId}/${unique}-${safeName(filename)}`;
}

/** Does this key belong to this company? The guard before any download. */
export function keyBelongsTo(storageKey: unknown, orgId: unknown): boolean {
  if (!storageKey || !orgId) return false;
  return String(storageKey).startsWith(`org/${orgId}/`);
}

/**
 * Permission to upload one file, to one key, for a few minutes.
 *
 * content-type and content-length are SIGNED, so they bind: an uploader that
 * declares a PDF cannot send an executable, and one that declares 2MB cannot
 * send 2GB. Checking after the fact would mean the file is already stored.
 */
export function presignUpload(
  { orgId, documentId, filename, contentType, bytes, env = process.env }: UploadRequest,
) {
  const s = settings(env);
  if (!s) /* The PUBLIC reason. describe().why names the missing environment
       variables, which is what an operator needs and what a customer must
       never be handed — they cannot act on it, and it describes how the
       deployment is put together. */
    return { ok: false, why: publicDescribe(env).why };

  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_TYPES.has(type)) {
    return { ok: false, why: `A ${type || "file of unknown type"} cannot be uploaded. ` +
      `Documents may be PDF, an image, Word or Excel.` };
  }
  const size = Number(bytes);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, why: "The size of the file must be given, in bytes." };
  }
  if (size > MAX_BYTES) {
    return { ok: false, why: `That file is ${(size / 1048576).toFixed(1)}MB. ` +
      `A document may be up to ${MAX_BYTES / 1048576}MB.` };
  }

  const key = keyFor({ orgId, documentId, filename });
  const signed = presign({
    method: "PUT", host: s.host, key: `${s.bucket}/${key}`,
    accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey,
    region: s.region, expiresIn: 600,
    extraHeaders: { "content-type": type, "content-length": String(size) },
  });

  return {
    ok: true, url: s.insecure ? signed.url.replace(/^https:/, "http:") : signed.url,
    method: "PUT", storageKey: key,
    /* The uploader must send exactly these, because they were signed. */
    headers: { "Content-Type": type, "Content-Length": String(size) },
    expiresIn: signed.expiresIn,
  };
}

/** A short-lived link to read one document, checked against its owner first. */
export function presignDownload(
  { storageKey, orgId, filename, env = process.env }: DownloadRequest,
) {
  const s = settings(env);
  if (!s) /* The PUBLIC reason. describe().why names the missing environment
       variables, which is what an operator needs and what a customer must
       never be handed — they cannot act on it, and it describes how the
       deployment is put together. */
    return { ok: false, why: publicDescribe(env).why };
  if (!storageKey) return { ok: false, why: "That document has no file attached yet." };
  if (!keyBelongsTo(storageKey, orgId)) {
    /* Not an explanation. A key that is not this company's is not this
       company's business, including the fact that it exists. */
    return { ok: false, why: "That document has no file attached yet." };
  }
  const signed = presign({
    method: "GET", host: s.host, key: `${s.bucket}/${storageKey}`,
    accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey,
    region: s.region, expiresIn: 300,
    query: filename
      ? { "response-content-disposition": `attachment; filename="${safeName(filename)}"` }
      : {},
  });
  return {
    ok: true,
    url: s.insecure ? signed.url.replace(/^https:/, "http:") : signed.url,
    expiresIn: signed.expiresIn,
  };
}

/**
 * What is ACTUALLY in storage under this key.
 *
 * Used to confirm an upload rather than believing the browser that said it
 * finished. A client reporting a size and type it did not upload is the
 * easiest possible thing to do, so the record is written from what the
 * storage provider reports instead.
 */
export async function head(
  { storageKey, orgId, env = process.env, fetchImpl = fetch }: HeadRequest,
) {
  const s = settings(env);
  if (!s) /* The PUBLIC reason. describe().why names the missing environment
       variables, which is what an operator needs and what a customer must
       never be handed — they cannot act on it, and it describes how the
       deployment is put together. */
    return { ok: false, why: publicDescribe(env).why };
  if (!keyBelongsTo(storageKey, orgId)) return { ok: false, why: "Not this company's file." };

  const signed = presign({
    method: "HEAD", host: s.host, key: `${s.bucket}/${storageKey}`,
    accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey,
    region: s.region, expiresIn: 120,
  });
  const url = s.insecure ? signed.url.replace(/^https:/, "http:") : signed.url;
  let res;
  try {
    res = await fetchImpl(url, { method: "HEAD" });
  } catch (e) {
    return { ok: false, why: "Storage could not be reached to confirm the upload." };
  }
  if (res.status === 404) return { ok: false, why: "No file was uploaded." };
  if (!res.ok) return { ok: false, why: `Storage answered ${res.status} when confirming the upload.` };
  return {
    ok: true,
    bytes: Number(res.headers.get("content-length") || 0),
    mimeType: String(res.headers.get("content-type") || "").split(";")[0].trim(),
    checksum: String(res.headers.get("etag") || "").replace(/"/g, ""),
  };
}
