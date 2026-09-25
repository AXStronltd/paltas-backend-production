/* ====================================================================== *
 * DOCUMENT STORAGE.
 *
 * The question this file exists to answer is not "does an upload work". It is
 * "can a company reach a file that is not theirs" — because a title deed
 * leaking to another tenant is the worst thing this feature could do, and it
 * would do it silently.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isConfigured, describe, publicDescribe, keyFor, keyBelongsTo, safeName,
  presignUpload, presignDownload, head, MAX_BYTES, ALLOWED_TYPES,
} from "../src/domain/storage.ts";

const ENV = {
  R2_ACCOUNT_ID: "acct123", R2_BUCKET: "paltas-docs",
  R2_ACCESS_KEY_ID: "AKEXAMPLE", R2_SECRET_ACCESS_KEY: "SKEXAMPLE",
};
const ORG_A = "org_aaa", ORG_B = "org_bbb";

/* ---------------------------------------------------------- not configured */

test("with no credentials it says so, and takes nothing else down", () => {
  assert.equal(isConfigured({}), false);
  const d = describe({});
  assert.equal(d.connected, false);
  assert.match(d.why, /R2_ACCOUNT_ID/, "an operator is not told what is missing");

  /* A customer is told it does not work, not which setting is absent. */
  const p = publicDescribe({});
  assert.equal(p.connected, false);
  assert.ok(!/R2_|KEY|SECRET/.test(p.why), "an environment variable reached a customer: " + p.why);

  /* And nothing throws. */
  assert.equal(presignUpload({ orgId: ORG_A, documentId: "d1", filename: "a.pdf",
    contentType: "application/pdf", bytes: 10, env: {} }).ok, false);
  assert.equal(presignDownload({ storageKey: `org/${ORG_A}/x`, orgId: ORG_A, env: {} }).ok, false);
});

test("partial credentials are not configured, rather than half working", () => {
  assert.equal(isConfigured({ ...ENV, R2_SECRET_ACCESS_KEY: "" }), false);
  assert.equal(isConfigured({ ...ENV, R2_BUCKET: "   " }), false, "whitespace is not a bucket");
  assert.equal(isConfigured(ENV), true);
});

/* ------------------------------------------------------------ the key */

test("a key is built from the organization and cannot be supplied", () => {
  const k = keyFor({ orgId: ORG_A, documentId: "doc1", filename: "Title Deed.pdf" });
  assert.match(k, new RegExp(`^org/${ORG_A}/documents/doc1/`));
  assert.match(k, /Title-Deed\.pdf$/);

  /* Two uploads of the same name do not collide, so replacing a document does
     not destroy the one it replaced. */
  assert.notEqual(k, keyFor({ orgId: ORG_A, documentId: "doc1", filename: "Title Deed.pdf" }));

  assert.throws(() => keyFor({ documentId: "d", filename: "a" }), /organization/);
  assert.throws(() => keyFor({ orgId: ORG_A, filename: "a" }), /document/);
});

test("a filename cannot climb out of its folder or hide its extension", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("/absolute/deed.pdf"), "deed.pdf");
  assert.equal(safeName("..\\..\\windows\\system32"), "system32");
  assert.equal(safeName(""), "file");
  assert.equal(safeName("....pdf"), "pdf", "a leading run of dots is not a name");
  assert.ok(safeName("x".repeat(500)).length <= 80);

  /* The key is what the path becomes, so traversal must not survive into it. */
  const k = keyFor({ orgId: ORG_A, documentId: "d1", filename: "../../../other-org/secret.pdf" });
  assert.ok(!k.includes(".."), "a key containing .. escapes its own prefix: " + k);
  assert.match(k, new RegExp(`^org/${ORG_A}/`));
});

/* ------------------------------------------------------ the tenant wall */

test("a key belongs to exactly one company", () => {
  assert.equal(keyBelongsTo(`org/${ORG_A}/documents/d/x.pdf`, ORG_A), true);
  assert.equal(keyBelongsTo(`org/${ORG_A}/documents/d/x.pdf`, ORG_B), false);
  assert.equal(keyBelongsTo("", ORG_A), false);
  assert.equal(keyBelongsTo(`org/${ORG_A}/x`, ""), false);

  /*
   * The prefix check must require the separator. Without it an organization
   * whose id merely STARTS with another's would read its files — the same
   * mistake the authority jurisdiction check exists to avoid.
   */
  assert.equal(keyBelongsTo("org/org_aaa_evil/documents/d/x.pdf", "org_aaa"), false,
    "a company whose id is a prefix of another's could read its documents");
});

test("one company cannot be handed a link to another's file", () => {
  const mine = keyFor({ orgId: ORG_A, documentId: "d1", filename: "deed.pdf" });

  const ok = presignDownload({ storageKey: mine, orgId: ORG_A, env: ENV });
  assert.equal(ok.ok, true);
  assert.match(ok.url, /X-Amz-Signature=/);

  const theirs = presignDownload({ storageKey: mine, orgId: ORG_B, env: ENV });
  assert.equal(theirs.ok, false, "*** a company was signed a link to another company's file ***");

  /* And it is not told that the file exists, which a different message would. */
  const missing = presignDownload({ storageKey: "", orgId: ORG_B, env: ENV });
  assert.equal(theirs.why, missing.why,
    "the refusal distinguishes 'someone else's file' from 'no file', which confirms it exists");
});

/* ------------------------------------------------------- what may be sent */

test("only document-shaped files, and only up to the limit", () => {
  const base = { orgId: ORG_A, documentId: "d1", filename: "a.pdf", env: ENV };

  assert.equal(presignUpload({ ...base, contentType: "application/pdf", bytes: 1000 }).ok, true);

  const html = presignUpload({ ...base, contentType: "text/html", bytes: 10 });
  assert.equal(html.ok, false, "a file a browser would execute was accepted");

  for (const t of ["application/x-msdownload", "image/svg+xml", "text/html", ""]) {
    assert.equal(presignUpload({ ...base, contentType: t, bytes: 10 }).ok, false, t + " was accepted");
  }
  for (const t of ALLOWED_TYPES) {
    assert.equal(presignUpload({ ...base, contentType: t, bytes: 10 }).ok, true, t + " was refused");
  }

  assert.equal(presignUpload({ ...base, contentType: "application/pdf", bytes: MAX_BYTES + 1 }).ok, false);
  assert.equal(presignUpload({ ...base, contentType: "application/pdf", bytes: 0 }).ok, false);
  assert.equal(presignUpload({ ...base, contentType: "application/pdf", bytes: -5 }).ok, false);
  assert.equal(presignUpload({ ...base, contentType: "application/pdf" }).ok, false,
    "an upload with no declared size was permitted");

  /* A parameterised type is still that type. */
  assert.equal(presignUpload({ ...base, contentType: "application/pdf; charset=binary", bytes: 10 }).ok, true);
});

test("the declared type and size are signed, so they bind", () => {
  const out = presignUpload({
    orgId: ORG_A, documentId: "d1", filename: "a.pdf",
    contentType: "application/pdf", bytes: 1234, env: ENV,
  });
  assert.equal(out.ok, true);
  assert.equal(out.method, "PUT");
  assert.equal(out.headers["Content-Type"], "application/pdf");
  assert.equal(out.headers["Content-Length"], "1234");
  assert.match(out.url, /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost/,
    "content-type and content-length are not signed, so the uploader may send anything");

  /* Short-lived. A permanent URL is a permanent hole. */
  assert.ok(out.expiresIn <= 900, "an upload URL lives for " + out.expiresIn + "s");
  assert.match(out.url, new RegExp(`/${ENV.R2_BUCKET}/org/${ORG_A}/`));
});

/* ------------------------------------------------ confirming what landed */

test("the upload is confirmed from storage, not from the uploader", async () => {
  const key = keyFor({ orgId: ORG_A, documentId: "d1", filename: "deed.pdf" });
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => ({
      "content-length": "2048", "content-type": "application/pdf", etag: '"abc123"',
    })[h.toLowerCase()] },
  });
  const out = await head({ storageKey: key, orgId: ORG_A, env: ENV, fetchImpl });
  assert.deepEqual(
    { ok: out.ok, bytes: out.bytes, mimeType: out.mimeType, checksum: out.checksum },
    { ok: true, bytes: 2048, mimeType: "application/pdf", checksum: "abc123" });
});

test("a file that was never uploaded is not confirmed", async () => {
  const key = keyFor({ orgId: ORG_A, documentId: "d1", filename: "deed.pdf" });
  const gone = await head({ storageKey: key, orgId: ORG_A, env: ENV,
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) });
  assert.equal(gone.ok, false);
  assert.match(gone.why, /No file/);

  const broken = await head({ storageKey: key, orgId: ORG_A, env: ENV,
    fetchImpl: async () => { throw new Error("network"); } });
  assert.equal(broken.ok, false, "an unreachable storage provider threw instead of answering");

  /* And it will not confirm across the tenant wall either. */
  const notMine = await head({ storageKey: key, orgId: ORG_B, env: ENV,
    fetchImpl: async () => { throw new Error("should never be called"); } });
  assert.equal(notMine.ok, false);
});

/* ====================================================================== *
 * THE WHOLE ROUND TRIP, THROUGH A REAL HTTP SERVER.
 *
 * Every test above checks one piece. This one puts an actual file through the
 * actual flow — sign, PUT over HTTP, confirm from storage, sign a download,
 * GET it back — and compares the bytes that come out with the bytes that went
 * in. The pieces can each be right while the flow is wrong.
 * ====================================================================== */

import http from "node:http";
import crypto from "node:crypto";

/** A minimal S3-shaped store: PUT keeps the bytes, HEAD and GET report them. */
function objectStore() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.split("?")[0]);
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        objects.set(key, { body, type: req.headers["content-type"] || "" });
        res.writeHead(200, { etag: `"${crypto.createHash("md5").update(body).digest("hex")}"` });
        res.end();
      });
      return;
    }
    const o = objects.get(key);
    if (!o) { res.writeHead(404); res.end(); return; }
    const headers = {
      "content-length": String(o.body.length),
      "content-type": o.type,
      etag: `"${crypto.createHash("md5").update(o.body).digest("hex")}"`,
    };
    if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers); res.end(o.body);
  });
  return { server, objects };
}

test("a file goes up, is confirmed, and comes back byte for byte", async () => {
  const { server, objects } = objectStore();
  await new Promise((r) => server.listen(0, r));
  const env = { ...ENV, R2_ENDPOINT: `http://127.0.0.1:${server.address().port}` };

  try {
    const fileBytes = Buffer.from("%PDF-1.7\nthe client's certificate of incorporation\n");

    /* 1 — permission to write exactly one object. */
    const up = presignUpload({
      orgId: ORG_A, documentId: "doc_1", filename: "Certificate of Incorporation.pdf",
      contentType: "application/pdf", bytes: fileBytes.length, env,
    });
    assert.equal(up.ok, true, up.why);

    /* 2 — the browser uploads straight to storage. Nothing through PALTAS. */
    const put = await fetch(up.url, { method: "PUT", headers: up.headers, body: fileBytes });
    assert.equal(put.status, 200, "the signed upload was rejected by storage");
    assert.equal(objects.size, 1);
    assert.ok([...objects.keys()][0].includes(`org/${ORG_A}/documents/doc_1/`),
      "the object did not land under its own company's prefix");

    /* 3 — confirm from STORAGE, not from whoever said they finished. */
    const found = await head({ storageKey: up.storageKey, orgId: ORG_A, env });
    assert.equal(found.ok, true, found.why);
    assert.equal(found.bytes, fileBytes.length);
    assert.equal(found.mimeType, "application/pdf");
    assert.ok(found.checksum, "nothing was recorded to detect a tampered file");

    /* 4 — read it back. */
    const down = presignDownload({
      storageKey: up.storageKey, orgId: ORG_A, filename: "Certificate of Incorporation.pdf", env,
    });
    assert.equal(down.ok, true, down.why);
    const got = await fetch(down.url);
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), fileBytes,
      "what came back is not what went in");

    /* And the other company still cannot have a link to it. */
    assert.equal(presignDownload({ storageKey: up.storageKey, orgId: ORG_B, env }).ok, false);

    /* A second upload for the same document does not overwrite the first. */
    const again = presignUpload({
      orgId: ORG_A, documentId: "doc_1", filename: "Certificate of Incorporation.pdf",
      contentType: "application/pdf", bytes: 10, env,
    });
    assert.notEqual(again.storageKey, up.storageKey,
      "re-uploading destroys the document it replaces, so a mistake is unrecoverable");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
