/* ====================================================================== *
 * PRESIGNED URLS, SIGNED HERE.
 *
 * Cloudflare R2 speaks S3, and an S3 presigned URL is a URL carrying an
 * AWS Signature Version 4 in its query string. Anyone holding that URL may
 * perform exactly the one operation it was signed for, on exactly the one
 * object, until it expires.
 *
 * ── WHY THIS IS SIXTY LINES AND NOT A DEPENDENCY ───────────────────────
 *
 * The AWS SDK is tens of megabytes and this service needs one function from
 * it. The algorithm is public, fixed, and has a WORKED EXAMPLE published by
 * AWS with an expected signature — so it can be proven correct rather than
 * trusted. test/sigv4.test.js reproduces that example byte for byte; if this
 * file is ever wrong, that test says so immediately.
 *
 * ── WHY PRESIGNING AT ALL ──────────────────────────────────────────────
 *
 * The alternative is uploading through PALTAS: the browser posts the file to
 * the API, the API forwards it to storage. That puts every megabyte of every
 * customer's documents through a server that has no reason to see them, pays
 * for the bandwidth twice, and turns a large upload into a request timeout.
 *
 * With a presigned URL the bytes go browser -> storage directly. PALTAS
 * issues permission and never touches the file.
 *
 * ── WHAT THE SIGNATURE CONSTRAINS ──────────────────────────────────────
 *
 * The URL names ONE bucket, ONE key and ONE method, and the key is built by
 * the server from the organization that owns the document. A customer cannot
 * ask for a URL that writes somewhere else, because they never supply the
 * key — see src/domain/storage.js.
 * ====================================================================== */

import crypto from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED = "UNSIGNED-PAYLOAD";

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key, v) => crypto.createHmac("sha256", key).update(v).digest();

/**
 * RFC 3986, which is not what encodeURIComponent does.
 *
 * encodeURIComponent leaves ! ' ( ) * alone. S3 signs the encoded form, so a
 * key containing any of them would be signed one way and requested another,
 * and the request would be rejected with a signature mismatch that says
 * nothing about why.
 */
export function uriEncode(str, encodeSlash = true) {
  let out = "";
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) { out += ch; continue; }
    if (ch === "/") { out += encodeSlash ? "%2F" : "/"; continue; }
    for (const b of Buffer.from(ch, "utf8")) {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** 20130524T000000Z and 20130524, the two forms the algorithm wants. */
export function stamps(date) {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secret, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service), "aws4_request");
}

/**
 * A presigned URL for one operation on one object.
 *
 * `extraHeaders` are SIGNED, which is what makes them binding rather than
 * advisory: a Content-Type signed here must be sent by the uploader or the
 * request fails. That is how an upload is held to the type it declared.
 */
export function presign({
  method, host, key, accessKeyId, secretAccessKey,
  region = "auto", service = "s3", expiresIn = 900,
  query = {}, extraHeaders = {}, date = new Date(),
}) {
  if (!host) throw new Error("presign needs a host");
  if (!key) throw new Error("presign needs an object key");
  if (!accessKeyId || !secretAccessKey) throw new Error("presign needs credentials");

  const { amzDate, dateStamp } = stamps(date);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  /* Host is always signed. Anything else the caller wants bound goes with it. */
  const headers = { host, ...extraHeaders };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((n) => {
      const actual = Object.keys(headers).find((h) => h.toLowerCase() === n);
      return `${n}:${String(headers[actual]).trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const signedHeaders = names.join(";");

  const q = {
    ...query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  /* Sorted by encoded name, then encoded value — the order is part of the
     signature, so it is not cosmetic. */
  const canonicalQuery = Object.keys(q).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(q[k])}`)
    .join("&");

  const canonicalPath = "/" + uriEncode(String(key).replace(/^\/+/, ""), false);

  const canonicalRequest = [
    method.toUpperCase(), canonicalPath, canonicalQuery,
    canonicalHeaders, signedHeaders, UNSIGNED,
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign).digest("hex");

  return {
    url: `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    signature, canonicalRequest, stringToSign, signedHeaders, amzDate, expiresIn,
  };
}
