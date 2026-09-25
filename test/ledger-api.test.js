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

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* Its own schema, dropped and rebuilt every run — so it must not be one any
   other file reads. NOT "test_ledger": that belongs to ledger.test.js, which
   proves the same rules one layer down, and two files dropping one schema
   concurrently fails with a duplicate-type error that reads like a broken
   migration rather than a name clash. */
const SCHEMA = "test_ledger_api";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping ledger tests";
let dbHelp = null;
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    if (/did not initialize|locate the Query Engine|generate/.test(m)) {
      skip = "RUN `npx prisma generate` FIRST — the ledger tests cannot run without it";
    } else {
      const help = explain(e, DB);
      if (help) { skip = "database configuration — see below"; dbHelp = help; }
      else skip = "database unreachable: " + m.slice(0, 90);
    }
  }
}

/* ---------------------------------------------------------------- rig */

let server, base, pool;

async function boot() {
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function signIn({ email, name, orgId }) {
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
async function company({ role = "OWNER", country = "ke" } = {}) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Ledger Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `ledger${n}@example.com`, name: `Person ${n}`, orgId: org.id,
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  return { org, user, cookie };
}

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** The chart, seeded, as a code → id map. */
async function chartOf(cookie) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries(json.accounts.map((a) => [a.code, a.id]));
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

test("the ledger answers at all, which it never did before", { skip }, async () => {
  const { cookie } = await company();
  const res = await call("/ledger/accounts", { cookie });

  /*
   * Worth asserting explicitly. Before these routes existed the path fell
   * through to productRoutes, which mounts at "/" behind requireSession(),
   * so every ledger URL answered 401 — a reachable-looking auth error for a
   * route that did not exist. A 401 here means the mount order regressed.
   */
  assert.equal(res.status, 200, `expected the chart, got ${res.status}: ${res.text.slice(0, 160)}`);
  assert.ok(Array.isArray(res.json.accounts));
});

test("an unsigned-in caller gets 401, not the books", { skip }, async () => {
  for (const path of ["/ledger/accounts", "/ledger/entries", "/ledger/trial-balance"]) {
    const res = await call(path);
    assert.equal(res.status, 401, `${path} answered ${res.status} to a stranger`);
  }
});

/* ====================================================================== *
 * THE CHART
 * ====================================================================== */

test("the starting chart seeds once, and says so the second time", { skip }, async () => {
  const { cookie } = await company();

  const first = await call("/ledger/accounts/seed", { method: "POST", cookie });
  assert.equal(first.status, 201);
  assert.ok(first.json.created > 20, `only ${first.json.created} accounts seeded`);

  /* Onboarding gets re-run. A second call must not double the chart. */
  const second = await call("/ledger/accounts/seed", { method: "POST", cookie });
  assert.equal(second.status, 200);
  assert.equal(second.json.created, 0);

  const { json } = await call("/ledger/accounts", { cookie });
  const codes = json.accounts.map((a) => a.code);
  assert.equal(new Set(codes).size, codes.length, "the chart has duplicate codes");
});

test("an account carries the normal balance its type implies", { skip }, async () => {
  const { cookie } = await company();
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  const by = Object.fromEntries(json.accounts.map((a) => [a.code, a]));

  assert.equal(by["1000"].normal, "DEBIT", "Bank is an asset and increases on the debit side");
  assert.equal(by["4000"].normal, "CREDIT", "Rent is income and increases on the credit side");
  assert.equal(by["5000"].normal, "DEBIT", "Maintenance is an expense");
  assert.equal(by["2100"].normal, "CREDIT", "Deposits held are a liability");
});

test("a code cannot be reused inside one company", { skip }, async () => {
  const { cookie } = await company();
  const mk = () => call("/ledger/accounts", {
    method: "POST", cookie, body: { code: "4444", name: "Kiosk rent", type: "INCOME" },
  });
  assert.equal((await mk()).status, 201);
  assert.equal((await mk()).status, 409, "the same code was accepted twice");
});

test("a code and a type cannot be edited once posted against", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  for (const field of ["code", "type"]) {
    const res = await call(`/ledger/accounts/${codes["4000"]}`, {
      method: "PATCH", cookie, body: { [field]: field === "code" ? "9999" : "EXPENSE" },
    });
    assert.equal(res.status, 400, `${field} was editable — that restates posted history`);
  }

  /* A name is a label and may be corrected. */
  const ok = await call(`/ledger/accounts/${codes["4000"]}`, {
    method: "PATCH", cookie, body: { name: "Rental income" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.account.name, "Rental income");
});

/* ====================================================================== *
 * POSTING — rule 1, a posted entry balances
 * ====================================================================== */

test("a balanced entry posts, and comes back as the figures that were sent", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      date: "2026-03-01", memo: "March rent, A-204",
      lines: [
        { accountId: codes["1100"], debit: 8_500_000, memo: "Receivable" },
        { accountId: codes["4000"], credit: 8_500_000, memo: "Rent" },
      ],
    },
  });

  assert.equal(res.status, 201, res.text.slice(0, 200));
  const e = res.json.entry;
  assert.equal(e.status, "POSTED");
  assert.match(e.ref, /^JE-\d{4}$/, `reference was ${e.ref}`);
  assert.equal(e.lines.length, 2);

  /* BigInt on the wire is a JSON number — see the replacer in server.js. The
     point of the assertion is that 8,500,000 minor units survives the round
     trip exactly, because money that is quietly wrong is the worst defect
     this system can have. */
  const debit = e.lines.find((l) => Number(l.debit) > 0);
  assert.equal(Number(debit.debit), 8_500_000);
  assert.equal(Number(debit.credit), 0);
});

test("an unbalanced entry is refused, not posted and corrected later", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      lines: [
        { accountId: codes["1100"], debit: 8_500_000 },
        { accountId: codes["4000"], credit: 8_000_000 },
      ],
    },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /equal/i);

  const after = await call("/ledger/entries", { cookie });
  assert.equal(after.json.total, 0, "a refused entry was written anyway");
});

test("a one-line entry is refused", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 100 }] },
  });
  assert.equal(res.status, 400);
});

test("a line cannot be a debit and a credit at once", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      lines: [
        { accountId: codes["1100"], debit: 500, credit: 500 },
        { accountId: codes["4000"], credit: 500 },
      ],
    },
  });
  assert.equal(res.status, 400);
});

test("a negative amount is refused — direction is which column is filled", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      lines: [
        { accountId: codes["1100"], debit: -500 },
        { accountId: codes["4000"], credit: -500 },
      ],
    },
  });
  assert.equal(res.status, 400);
});

test("fractional minor units are refused rather than rounded", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      lines: [
        { accountId: codes["1100"], debit: 10.5 },
        { accountId: codes["4000"], credit: 10.5 },
      ],
    },
  });
  assert.equal(res.status, 400, "half a cent was accepted");
});

test("a caller may not choose its own reference", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const res = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      ref: "JE-0001",
      lines: [
        { accountId: codes["1100"], debit: 100 },
        { accountId: codes["4000"], credit: 100 },
      ],
    },
  });
  assert.equal(res.status, 400, "a chosen reference was accepted — two entries could share one");
});

test("references are allocated per company and do not collide", { skip }, async () => {
  const a = await company();
  const b = await company();
  const ca = await chartOf(a.cookie), cb = await chartOf(b.cookie);

  const post = (cookie, codes) => call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 100 }, { accountId: codes["4000"], credit: 100 }] },
  });

  const first = await post(a.cookie, ca);
  const second = await post(a.cookie, ca);
  const other = await post(b.cookie, cb);

  assert.notEqual(first.json.entry.ref, second.json.entry.ref, "one company got the same reference twice");
  /* Numbering is per company, so the second company starts at its own 0001
     rather than continuing somebody else's sequence. */
  assert.equal(other.json.entry.ref, "JE-0001");
});

/* ====================================================================== *
 * RULE 4 — nothing crosses an organization
 * ====================================================================== */

test("an entry cannot name another company's account", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const ca = await chartOf(mine.cookie);
  const cb = await chartOf(theirs.cookie);

  const res = await call("/ledger/entries", {
    method: "POST", cookie: mine.cookie,
    body: {
      lines: [
        { accountId: ca["1100"], debit: 100 },
        { accountId: cb["4000"], credit: 100 },   // somebody else's books
      ],
    },
  });
  assert.equal(res.status, 404, "an entry reached across companies");
});

test("one company's journal is invisible to another", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const ca = await chartOf(mine.cookie);
  await chartOf(theirs.cookie);

  const posted = await call("/ledger/entries", {
    method: "POST", cookie: mine.cookie,
    body: { lines: [{ accountId: ca["1100"], debit: 4242 }, { accountId: ca["4000"], credit: 4242 }] },
  });
  assert.equal(posted.status, 201);

  const list = await call("/ledger/entries", { cookie: theirs.cookie });
  assert.equal(list.json.total, 0, "another company's entries were listed");

  const one = await call(`/ledger/entries/${posted.json.entry.id}`, { cookie: theirs.cookie });
  assert.equal(one.status, 404);

  const tb = await call("/ledger/trial-balance", { cookie: theirs.cookie });
  assert.equal(tb.json.rows.length, 0, "another company's figures reached this trial balance");
});

/* ====================================================================== *
 * RULE 2 — a posted entry is immutable; corrections are reversals
 * ====================================================================== */

test("a reversal mirrors the original and states why", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 90_000 }, { accountId: codes["4000"], credit: 90_000 }] },
  });
  const original = posted.json.entry;

  const rev = await call(`/ledger/entries/${original.id}/reverse`, {
    method: "POST", cookie, body: { reason: "Billed the wrong tenant" },
  });
  assert.equal(rev.status, 201, rev.text.slice(0, 200));

  const mirror = rev.json.entry;
  assert.equal(mirror.reversesId, original.id);
  assert.equal(mirror.reversalReason, "Billed the wrong tenant");

  /* Debit became credit, credit became debit. */
  const was = original.lines.find((l) => Number(l.debit) > 0);
  const now = mirror.lines.find((l) => l.accountId === was.accountId);
  assert.equal(Number(now.credit), Number(was.debit));
  assert.equal(Number(now.debit), 0);

  /* The original is marked, not edited — and both halves are reachable from
     either end, so a reader never has to go looking for the other one. */
  const back = await call(`/ledger/entries/${original.id}`, { cookie });
  assert.equal(back.json.entry.status, "REVERSED");
  assert.equal(back.json.entry.lines.length, original.lines.length, "the original's lines were touched");
  assert.equal(back.json.reversedBy.ref, mirror.ref);
});

test("a reversal without a reason is refused", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 10 }, { accountId: codes["4000"], credit: 10 }] },
  });
  const res = await call(`/ledger/entries/${posted.json.entry.id}/reverse`, {
    method: "POST", cookie, body: {},
  });
  assert.equal(res.status, 400);
});

test("an entry cannot be reversed twice", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 10 }, { accountId: codes["4000"], credit: 10 }] },
  });
  const id = posted.json.entry.id;
  assert.equal((await call(`/ledger/entries/${id}/reverse`, { method: "POST", cookie, body: { reason: "first" } })).status, 201);
  const twice = await call(`/ledger/entries/${id}/reverse`, { method: "POST", cookie, body: { reason: "again" } });
  assert.equal(twice.status, 409, "the same entry was reversed twice");
});

test("a reversal leaves the books balanced and the account flat", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 70_000 }, { accountId: codes["4000"], credit: 70_000 }] },
  });
  await call(`/ledger/entries/${posted.json.entry.id}/reverse`, {
    method: "POST", cookie, body: { reason: "Duplicate" },
  });

  /* The reversal is a POSTED entry of its own, so the account's balance
     nets to nothing while both halves stay in the history. */
  const bal = await call(`/ledger/accounts/${codes["4000"]}/balance`, { cookie });
  assert.equal(Number(bal.json.balance.balance), 0, "a reversed entry left a balance behind");
  assert.equal(bal.json.balance.lineCount, 2, "the history lost a line");

  const tb = await call("/ledger/trial-balance", { cookie });
  assert.equal(tb.json.balanced, true);
});

/* ====================================================================== *
 * RULE 3 — a closed period does not move
 * ====================================================================== */

test("a closed period refuses a posting dated inside it", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  const period = await call("/ledger/periods", {
    method: "POST", cookie,
    body: { label: "March 2026", opensAt: "2026-03-01", closesAt: "2026-03-31" },
  });
  assert.equal(period.status, 201, period.text.slice(0, 200));

  const line = (d) => ({
    date: d,
    lines: [{ accountId: codes["1100"], debit: 500 }, { accountId: codes["4000"], credit: 500 }],
  });

  assert.equal((await call("/ledger/entries", { method: "POST", cookie, body: line("2026-03-10") })).status, 201,
    "an OPEN period refused a posting");

  const closed = await call(`/ledger/periods/${period.json.period.id}/close`, { method: "POST", cookie });
  assert.equal(closed.status, 200);

  const after = await call("/ledger/entries", { method: "POST", cookie, body: line("2026-03-11") });
  assert.equal(after.status, 409, "a closed period accepted a posting");

  /* A date outside it is unaffected — closing March does not close April. */
  assert.equal((await call("/ledger/entries", { method: "POST", cookie, body: line("2026-04-02") })).status, 201);
});

test("reopening a closed period demands a reason and records it", { skip }, async () => {
  const { cookie } = await company();
  const period = await call("/ledger/periods", {
    method: "POST", cookie,
    body: { label: "April 2026", opensAt: "2026-04-01", closesAt: "2026-04-30" },
  });
  const id = period.json.period.id;
  await call(`/ledger/periods/${id}/close`, { method: "POST", cookie });

  const bare = await call(`/ledger/periods/${id}/reopen`, { method: "POST", cookie, body: {} });
  assert.equal(bare.status, 400, "a period was reopened with no reason");

  const ok = await call(`/ledger/periods/${id}/reopen`, {
    method: "POST", cookie, body: { reason: "Late supplier invoice" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.period.status, "OPEN");
  assert.equal(ok.json.period.reopenReason, "Late supplier invoice");
  assert.ok(ok.json.period.reopenedAt, "the reopen was not stamped");
});

test("periods may not overlap", { skip }, async () => {
  const { cookie } = await company();
  const mk = (label, opensAt, closesAt) =>
    call("/ledger/periods", { method: "POST", cookie, body: { label, opensAt, closesAt } });

  assert.equal((await mk("May 2026", "2026-05-01", "2026-05-31")).status, 201);
  assert.equal((await mk("Mid May", "2026-05-15", "2026-06-15")).status, 409,
    "two periods claimed the same day, so which one an entry falls in is a coin toss");
});

/* ====================================================================== *
 * READING
 * ====================================================================== */

test("a balance reads in the account's normal direction", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1000"], debit: 120_000 }, { accountId: codes["4000"], credit: 120_000 }] },
  });

  const bank = await call(`/ledger/accounts/${codes["1000"]}/balance`, { cookie });
  const rent = await call(`/ledger/accounts/${codes["4000"]}/balance`, { cookie });

  /* Both positive: the bank has more in it and rent has earned. A stored
     sign would eventually get one of these the wrong way round. */
  assert.equal(Number(bank.json.balance.balance), 120_000, "an asset that received money read negative");
  assert.equal(Number(rent.json.balance.balance), 120_000, "income that was earned read negative");
});

test("the trial balance balances, and says so as its own field", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  for (const [d, c, amt] of [["1000", "4000", 50_000], ["5000", "2000", 18_000], ["1100", "4010", 7_500]]) {
    const res = await call("/ledger/entries", {
      method: "POST", cookie,
      body: { lines: [{ accountId: codes[d], debit: amt }, { accountId: codes[c], credit: amt }] },
    });
    assert.equal(res.status, 201, res.text.slice(0, 160));
  }

  const tb = await call("/ledger/trial-balance", { cookie });
  assert.equal(tb.status, 200);
  assert.equal(tb.json.balanced, true, "the books do not balance");
  assert.equal(Number(tb.json.debit), Number(tb.json.credit));
  assert.equal(Number(tb.json.debit), 75_500);
  /* An account nobody used is not a row — a chart of forty accounts would
     otherwise bury three real ones. */
  assert.equal(tb.json.rows.length, 6);
});

test("a date range narrows the figures", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);
  const post = (date, amt) => call("/ledger/entries", {
    method: "POST", cookie,
    body: { date, lines: [{ accountId: codes["1000"], debit: amt }, { accountId: codes["4000"], credit: amt }] },
  });
  await post("2026-01-15", 10_000);
  await post("2026-02-15", 20_000);

  const jan = await call("/ledger/trial-balance?from=2026-01-01&to=2026-01-31", { cookie });
  assert.equal(Number(jan.json.debit), 10_000, "the range let another month in");

  const both = await call("/ledger/trial-balance?from=2026-01-01&to=2026-02-28", { cookie });
  assert.equal(Number(both.json.debit), 30_000);
});

test("the journal can be asked which entries touched one account", { skip }, async () => {
  const { cookie } = await company();
  const codes = await chartOf(cookie);

  await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1000"], debit: 1_000 }, { accountId: codes["4000"], credit: 1_000 }] },
  });
  await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["5000"], debit: 2_000 }, { accountId: codes["2000"], credit: 2_000 }] },
  });

  const onBank = await call(`/ledger/entries?accountId=${codes["1000"]}`, { cookie });
  assert.equal(onBank.json.total, 1, "the account filter returned the wrong set");
});

/* ====================================================================== *
 * THE REPORTING CURRENCY — global, not Kenyan
 * ====================================================================== */

test("the reporting currency comes from the company's own country", { skip }, async () => {
  const ke = await company({ country: "ke" });
  const se = await company({ country: "se" });

  const post = async ({ cookie }) => {
    const codes = await chartOf(cookie);
    const res = await call("/ledger/entries", {
      method: "POST", cookie,
      body: { lines: [{ accountId: codes["1000"], debit: 100 }, { accountId: codes["4000"], credit: 100 }] },
    });
    assert.equal(res.status, 201, res.text.slice(0, 160));
    return res.json.entry;
  };

  /*
   * The point of this test. A company in Sweden keeps its books in SEK
   * without anybody configuring anything, because the currency is resolved
   * from the market catalogue rather than defaulted to the currency this
   * platform happened to start in.
   */
  assert.equal((await post(ke)).baseCurrency, "KES");
  assert.equal((await post(se)).baseCurrency, "SEK");
});

test("an entry in another currency must carry its converted amounts", { skip }, async () => {
  const { cookie } = await company({ country: "ke" });
  const codes = await chartOf(cookie);

  /* USD into a KES book, with no base amounts: refusing is the correct
     answer — assuming 1:1 would invent an exchange rate. */
  const guess = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      currency: "USD",
      lines: [{ accountId: codes["1000"], debit: 1_000 }, { accountId: codes["4000"], credit: 1_000 }],
    },
  });
  assert.equal(guess.status, 400);
  assert.match(guess.json.message, /rate|converted/i);

  const stated = await call("/ledger/entries", {
    method: "POST", cookie,
    body: {
      currency: "USD", fxRate: "129",
      lines: [
        { accountId: codes["1000"], debit: 1_000, baseDebit: 129_000 },
        { accountId: codes["4000"], credit: 1_000, baseCredit: 129_000 },
      ],
    },
  });
  assert.equal(stated.status, 201, stated.text.slice(0, 200));
  assert.equal(stated.json.entry.currency, "USD");
  assert.equal(stated.json.entry.baseCurrency, "KES");
});

/* ====================================================================== *
 * WHO MAY DO WHAT
 * ====================================================================== */

test("a role without finance cannot read the books", { skip }, async () => {
  /* ENGINEERING has maintenance and property, and no finance at all. */
  const { cookie } = await company({ role: "ENGINEERING" });
  const res = await call("/ledger/accounts", { cookie });
  assert.equal(res.status, 403, "a role with no finance access read the chart");
});

test("a read-only finance role cannot post", { skip }, async () => {
  /* LEASING reads finance and does not write it. */
  const { cookie } = await company({ role: "LEASING" });
  const owner = await company();
  const codes = await chartOf(owner.cookie);

  const read = await call("/ledger/accounts", { cookie });
  assert.equal(read.status, 200, "a finance-reading role could not read the chart");

  const write = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 10 }, { accountId: codes["4000"], credit: 10 }] },
  });
  assert.equal(write.status, 403, "a read-only role posted to the journal");
});

test("closing a period is a manage-level act", { skip }, async () => {
  /* FINANCE manages finance; the period should close for them. */
  const fin = await company({ role: "FINANCE" });
  const period = await call("/ledger/periods", {
    method: "POST", cookie: fin.cookie,
    body: { label: "June 2026", opensAt: "2026-06-01", closesAt: "2026-06-30" },
  });
  assert.equal(period.status, 201);
  const closed = await call(`/ledger/periods/${period.json.period.id}/close`, {
    method: "POST", cookie: fin.cookie,
  });
  assert.equal(closed.status, 200, "a finance manager could not close a period");
});

/* ====================================================================== *
 * THE TRAIL
 * ====================================================================== */

test("every write leaves an audit entry", { skip }, async () => {
  const { org, cookie } = await company();
  const codes = await chartOf(cookie);

  const posted = await call("/ledger/entries", {
    method: "POST", cookie,
    body: { lines: [{ accountId: codes["1100"], debit: 4_000 }, { accountId: codes["4000"], credit: 4_000 }] },
  });
  await call(`/ledger/entries/${posted.json.entry.id}/reverse`, {
    method: "POST", cookie, body: { reason: "Wrong period" },
  });

  const events = await db.auditEvent.findMany({
    where: { orgId: org.id, action: { startsWith: "ledger." } },
    select: { action: true },
  });
  const actions = new Set(events.map((e) => e.action));

  for (const expected of ["ledger.chart.seed", "ledger.entry.post", "ledger.entry.reverse"]) {
    assert.ok(actions.has(expected), `${expected} was not recorded — the trail has a hole`);
  }
});
