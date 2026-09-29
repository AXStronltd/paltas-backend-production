/* ====================================================================== *
 * THE LEDGER, END TO END.
 *
 * domain/ledger.js enforces four rules — a posted entry balances, a posted
 * entry is immutable, a closed period does not move, and nothing crosses an
 * organization. It has enforced them for some time with no way to reach it.
 * These are the tests that the ROUTES do not quietly weaken any of them.
 *
 * ── WHY THIS NEEDS A REAL DATABASE ─────────────────────────────────────
 *
 * Most end-to-end tests in this suite can run against test/fake-prisma.js.
 * These cannot, and the fake says so itself: accountBalance() filters lines
 * THROUGH their entry — `where: { entry: { status: "POSTED" } }` — and the
 * fake refuses relation filters rather than pretending to support them.
 *
 * That is the right outcome anyway. This is the money. The things worth
 * proving here are a real transaction rolling back, a real unique constraint
 * on the entry reference, and BigInt arriving back as the figure that was
 * sent — none of which an in-memory stand-in can honestly answer.
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 *
 * Without a database this file skips, like the other end-to-end files.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* Its own schema, dropped and rebuilt every run — so it must not be one any
   other file reads. NOT "test_ledger": that belongs to ledger.test.js, which
   proves the same rules one layer down, and two files dropping one schema
   concurrently fails with a duplicate-type error that reads like a broken
   migration rather than a name clash. */
const SCHEMA = "test_receipts_api";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping receipt tests";
/* The sentence explain() produced, held so it prints in full at the end of
   the run rather than truncated into a skip reason. */
let dbHelp: string | null = null;
/*
 * LOADED INSIDE A `try`, SO THEY ARE DECLARED OUTSIDE IT.
 *
 * Importing the service pulls in the Prisma client, and a checkout where
 * nobody has run `prisma generate` throws on that import rather than failing
 * a test — a setup problem, reported as one below.
 *
 * `typeof import(...)` is the module's own type, so these handles are checked
 * against the real thing rather than carried as `any`.
 */
let createApp: typeof import("../src/server.ts")["createApp"];
let db: typeof import("../src/db.ts")["db"];
let pg: typeof import("pg")["default"];

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/did not initialize|locate the Query Engine|generate/.test(m)) {
      skip = "RUN `npx prisma generate` FIRST — the receipt tests cannot run without it";
    } else {
      const help = explain(e, DB);
      if (help) { skip = "database configuration — see below"; dbHelp = help; }
      else skip = "database unreachable: " + m.slice(0, 90);
    }
  }
}

/* ---------------------------------------------------------------- rig */

let server: import("node:http").Server;
let base: string;
let pool: import("pg").Pool;

async function boot() {
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${portOf(server)}`;
}

async function signIn(
  { email, name, orgId }: { email: string; name: string; orgId?: string },
) {
  const user = await db.user.upsert({
    where: { email },
    create: { email, name, googleSub: "sub_" + email },
    update: {},
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: orgId || null,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { user, cookie: `paltas_session=${token}` };
}

let seq = 0;
async function company(
  { role = "OWNER", country = "ke" }: { role?: import("@prisma/client").$Enums.Role; country?: string } = {},
) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Receipts Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `receipts${n}@example.com`, name: `Person ${n}`, orgId: org.id,
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  return { org, user, cookie };
}

async function call(
  path: string, { method = "GET", body, cookie }: CallOptions = {},
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Wire = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});

/* ====================================================================== *
 * REACHABILITY — the thing that was actually missing
 * ====================================================================== */

/* ====================================================================== *
 * ISSUING, END TO END.
 * ====================================================================== */

/** A payment of the given shape, through the real API. */
async function paymentOf(cookie: string, over: Record<string, unknown> = {}) {
  const res = await call("/payments", {
    method: "POST", cookie,
    body: { amount: 50_000, method: "CASH", receivedBy: "A Person", ...over },
  });
  assert.equal(res.status, 201, `could not record a payment: ${res.status} ${res.text.slice(0, 160)}`);
  return res.json.payment;
}

test("a stranger cannot read or issue receipts", { skip }, async () => {
  for (const path of ["/receipts", "/payments/x/receipt"]) {
    const res = await call(path);
    assert.equal(res.status, 401, `${path} answered ${res.status} to a stranger`);
  }
});

test("a cash payment produces a receipt that says what it rests on", { skip }, async () => {
  const { cookie } = await company();
  const payment = await paymentOf(cookie);

  const res = await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie });
  assert.equal(res.status, 201, `${res.status} ${res.text.slice(0, 200)}`);

  const r = res.json.receipt;
  assert.match(r.ref, /^RCP-\d{4}$/, `numbered ${r.ref}`);
  assert.equal(r.basis, "TAKEN_IN_PERSON");
  assert.equal(Number(r.amount), 50_000);
  assert.equal(r.voided, false);
  assert.match(res.json.basisWords, /in person/i);
});

test("pressing it twice returns the same document, not a second one", { skip }, async () => {
  /*
   * One receipt per payment is a unique constraint, so a second press cannot
   * make a second number. Answering 200 with the existing one is the honest
   * reply to what was asked — they want the receipt, and it exists.
   */
  const { cookie } = await company();
  const payment = await paymentOf(cookie);

  const first = await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie });
  const second = await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.receipt.id, first.json.receipt.id);
  assert.equal(second.json.receipt.ref, first.json.receipt.ref);
});

test("an unbanked transfer is refused in words that say what would fix it", { skip }, async () => {
  const { cookie } = await company();
  const payment = await paymentOf(cookie, { method: "BANK", reference: "FT26091234" });

  const res = await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie });
  assert.equal(res.status, 400, `${res.status} ${res.text.slice(0, 160)}`);
  assert.match(res.json.message, /reconcile/i);
});

test("a voided payment is refused a receipt", { skip }, async () => {
  const { cookie } = await company();
  const payment = await paymentOf(cookie);
  await call(`/payments/${payment.id}/void`, {
    method: "POST", cookie, body: { reason: "taken in error at the desk" },
  });

  const res = await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /voided/i);
});

test("the screen can ask whether a receipt is possible, and why not", { skip }, async () => {
  /* So a payments list draws the right control per row without a second copy
     of the confirmation rule living in the console. */
  const { cookie } = await company();
  const ok = await paymentOf(cookie);
  const not = await paymentOf(cookie, { method: "CHEQUE", reference: "004521" });

  const a = await call(`/payments/${ok.id}/receipt`, { cookie });
  assert.equal(a.json.canIssue, true);
  assert.equal(a.json.receipt, null);

  const b = await call(`/payments/${not.id}/receipt`, { cookie });
  assert.equal(b.json.canIssue, false);
  assert.match(String(b.json.why), /reconcile/i);
});

/* ====================================================================== *
 * IT IS EVIDENCE, SO IT DOES NOT MOVE.
 * ====================================================================== */

test("a receipt cannot be written directly, only issued from a payment", { skip }, async () => {
  const { cookie } = await company();
  const res = await call("/receipts", {
    method: "POST", cookie,
    body: { amount: 999_999, currency: "KES", payerName: "Nobody" },
  });
  assert.notEqual(res.status, 201,
    "a receipt could be forged for money that never arrived");
  assert.ok(res.status === 404 || res.status === 405 || res.status === 403,
    `expected the create door to be shut, got ${res.status}`);
});

test("a receipt cannot be edited or deleted", { skip }, async () => {
  const { cookie } = await company();
  const payment = await paymentOf(cookie);
  const issued = (await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie })).json.receipt;

  const patch = await call(`/receipts/${issued.id}`, {
    method: "PATCH", cookie, body: { payerName: "Somebody Else" },
  });
  assert.notEqual(patch.status, 200, "a receipt was edited under the customer's copy");

  const del = await call(`/receipts/${issued.id}`, { method: "DELETE", cookie });
  assert.notEqual(del.status, 200, "a receipt was deleted");
});

test("voiding keeps the number and records why", { skip }, async () => {
  const { cookie } = await company();
  const payment = await paymentOf(cookie);
  const issued = (await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie })).json.receipt;

  const bare = await call(`/receipts/${issued.id}/void`, { method: "POST", cookie, body: {} });
  assert.equal(bare.status, 400, "a void without a reason was accepted");

  const res = await call(`/receipts/${issued.id}/void`, {
    method: "POST", cookie, body: { reason: "issued against the wrong invoice" },
  });
  assert.equal(res.status, 200, `${res.status} ${res.text.slice(0, 160)}`);
  assert.equal(res.json.receipt.voided, true);
  assert.equal(res.json.receipt.ref, issued.ref,
    "the number changed — the customer's copy would no longer be findable");
  assert.match(res.json.receipt.voidReason, /wrong invoice/);
});

/* ====================================================================== *
 * THE THINGS EVERY RESOURCE MUST GET RIGHT.
 * ====================================================================== */

test("one company cannot see another's receipts", { skip }, async () => {
  const a = await company();
  const b = await company();
  const payment = await paymentOf(a.cookie);
  const issued = (await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie: a.cookie })).json.receipt;

  const seen = await call(`/receipts/${issued.id}`, { cookie: b.cookie });
  assert.equal(seen.status, 404, `another company read a receipt (${seen.status})`);

  const list = await call("/receipts", { cookie: b.cookie });
  assert.equal(list.json.receipts.length, 0, "another company's receipt appeared in the list");
});

test("issuing is written to the audit trail", { skip }, async () => {
  const { cookie, org } = await company();
  const payment = await paymentOf(cookie);
  await call(`/payments/${payment.id}/receipt`, { method: "POST", cookie });

  const events = await db.auditEvent.findMany({
    where: { orgId: org.id, action: "receipt.issue" },
  });
  assert.equal(events.length, 1, "issuing a receipt left no trace");
  assert.equal(events[0]!.entity, "receipt");
});

test("numbering is per company and does not leak volume", { skip }, async () => {
  const a = await company();
  const b = await company();
  for (let i = 0; i < 3; i++) {
    const p = await paymentOf(a.cookie, { reference: `A${i}` });
    await call(`/payments/${p.id}/receipt`, { method: "POST", cookie: a.cookie });
  }
  const p = await paymentOf(b.cookie);
  const first = await call(`/payments/${p.id}/receipt`, { method: "POST", cookie: b.cookie });
  assert.equal(first.json.receipt.ref, "RCP-0001",
    "a new company's first receipt was numbered from another company's count");
});
