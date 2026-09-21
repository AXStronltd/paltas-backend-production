/* ====================================================================== *
 * THE SIGNATURE, PROVEN AGAINST AWS'S OWN WORKED EXAMPLE.
 *
 * This service signs its own presigned URLs rather than carrying the AWS SDK
 * for one function. That is only defensible if the signing is PROVEN, not
 * assumed — a signature that is subtly wrong fails with "SignatureDoesNotMatch"
 * and no indication of which of the nine steps was wrong.
 *
 * AWS publishes a complete worked example of a presigned GET, with the exact
 * canonical request, string to sign and final signature. If this file
 * reproduces that signature from those inputs, every step is right.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { presign, uriEncode, stamps } from "../src/storage/sigv4.js";

/* AWS docs, "Example: Signature Calculation for Presigned URL". */
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  host: "examplebucket.s3.amazonaws.com",
  key: "test.txt",
  region: "us-east-1",
  date: new Date("2013-05-24T00:00:00Z"),
  expiresIn: 86400,
  signature: "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
};

test("the signature matches AWS's published example exactly", () => {
  const out = presign({
    method: "GET",
    host: EXAMPLE.host, key: EXAMPLE.key,
    accessKeyId: EXAMPLE.accessKeyId, secretAccessKey: EXAMPLE.secretAccessKey,
    region: EXAMPLE.region, service: "s3",
    expiresIn: EXAMPLE.expiresIn, date: EXAMPLE.date,
  });

  /* The canonical request first: when the signature is wrong, this says WHICH
     step is wrong, which the signature alone never does. */
  assert.equal(out.canonicalRequest, [
    "GET",
    "/test.txt",
    "X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
    "host:examplebucket.s3.amazonaws.com\n",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n"));

  assert.equal(out.signature, EXAMPLE.signature,
    "the presigned URL would be rejected by the storage provider");
});

test("the date stamps are the two forms the algorithm requires", () => {
  const { amzDate, dateStamp } = stamps(new Date("2013-05-24T00:00:00Z"));
  assert.equal(amzDate, "20130524T000000Z");
  assert.equal(dateStamp, "20130524");
});

test("encoding follows RFC 3986, not encodeURIComponent", () => {
  /*
   * encodeURIComponent leaves ! ' ( ) * alone. S3 signs the encoded form, so a
   * document named "Deed (final).pdf" would be signed one way and requested
   * another — a signature mismatch with nothing in the message about why.
   */
  assert.equal(uriEncode("Deed (final).pdf"), "Deed%20%28final%29.pdf");
  assert.equal(uriEncode("a'b!c*d"), "a%27b%21c%2Ad");
  assert.equal(uriEncode("a/b"), "a%2Fb");
  assert.equal(uriEncode("a/b", false), "a/b", "a path separator must survive in a key");
  assert.equal(uriEncode("Ahmed Kabööle"), "Ahmed%20Kab%C3%B6%C3%B6le", "UTF-8, byte by byte");
  assert.equal(uriEncode("~-._"), "~-._", "unreserved characters are never encoded");
});

test("a signed header is binding, and changes the signature", () => {
  const base = {
    method: "PUT", host: "b.example.com", key: "k.pdf",
    accessKeyId: "AK", secretAccessKey: "SK", date: new Date("2026-01-01T00:00:00Z"),
  };
  const plain = presign(base);
  const typed = presign({ ...base, extraHeaders: { "content-type": "application/pdf" } });

  assert.notEqual(plain.signature, typed.signature,
    "a signed content-type did not change the signature, so it binds nothing");
  assert.match(typed.signedHeaders, /content-type/);
  assert.match(typed.url, /X-Amz-SignedHeaders=content-type%3Bhost/);
});

test("signing refuses to produce a URL it cannot make safe", () => {
  const ok = { method: "PUT", host: "h", key: "k", accessKeyId: "A", secretAccessKey: "S" };
  assert.throws(() => presign({ ...ok, host: "" }), /host/);
  assert.throws(() => presign({ ...ok, key: "" }), /object key/);
  assert.throws(() => presign({ ...ok, secretAccessKey: "" }), /credentials/);
});

test("two signings of the same request at the same instant agree", () => {
  /* Determinism matters: a signature that varies run to run means something
     other than the inputs is getting into it. */
  const args = {
    method: "GET", host: "h.example.com", key: "docs/a b.pdf",
    accessKeyId: "AK", secretAccessKey: "SK", date: new Date("2026-03-04T05:06:07Z"),
  };
  assert.equal(presign(args).signature, presign(args).signature);
  assert.notEqual(presign(args).signature,
    presign({ ...args, key: "docs/a c.pdf" }).signature,
    "two different objects signed to the same value");
});
