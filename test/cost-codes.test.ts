/* ======================================================================
 * COST CODES REACH THE LEDGER, OR THEY ARE A TABLE NOBODY POSTS TO.
 *
 * The CostCode table was added in an earlier commit with no workflow at
 * all — nothing referenced it. By this project's own standard that is not
 * a feature, it is a model. These tests are what make it one: a cost code
 * is created, an expense is recorded against it, and the journal lines the
 * expense posts carry it — so "what did the foundations come to" is a
 * query rather than an afternoon with a spreadsheet.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import { portOf, present } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";

process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const skip = DB ? false : "no TEST_DATABASE_URL — skipping cost-code tests";

const SCHEMA = "costcodes_test";
let createApp: typeof import("../src/server.ts")["createApp"];
let db: typeof import("../src/db.ts")["db"];
let pg: typeof import("pg")["default"];
let server: import("node:http").Server;
let base: string;
let seq = 0;

if (!skip) {
  process.env.DATABASE_URL = urlForSchema(String(DB), SCHEMA);
  ({ default: pg } = await import("pg"));
  const pool = poolInSchema(pg, String(DB), SCHEMA);
  try {
    await freshSchema(pool, SCHEMA);
  } catch (e) {
    const said = explain(e, String(DB));
    throw said ? new Error(said) : e;
  } finally {
    await pool.end();
  }
  ({ createApp } = await import("../src/server.ts"));
  ({ db } = await import("../src/db.ts"));
  server = http.createServer(createApp());
  await new Promise<void>((r) => { server.listen(0, () => r()); });
  base = `http://127.0.0.1:${portOf(server)}`;
}

test.after(async () => {
  if (skip) return;
  await new Promise<void>((r) => { server.close(() => r()); });
  await db.$disconnect();
});

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
  try { json = JSON.parse(text); } catch { /* not every reply is JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function company(role: import("@prisma/client").$Enums.Role = "OWNER") {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Cost ${n} Ltd`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `cost${n}@example.test`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { org, user, cookie: `paltas_session=${token}` };
}

/** A company with a chart, so an expense has somewhere to post. */
async function withChart(role: import("@prisma/client").$Enums.Role = "OWNER") {
  const c = await company(role);
  const seeded = await call("/ledger/accounts/seed", { method: "POST", cookie: c.cookie });
  assert.ok(seeded.status === 201 || seeded.status === 200, seeded.text.slice(0, 200));
  return c;
}

async function project(cookie: string) {
  const made = await call("/projects", {
    method: "POST", cookie, body: { name: `Tower ${++seq}`, city: "Nairobi" },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  return made.json.project;
}

/* ==================================================================== *
 * A CODE EXISTS, AND SPEND CAN BE PUT AGAINST IT.
 * ==================================================================== */

test("a cost code can be created and listed", { skip }, async () => {
  const { cookie } = await withChart();
  const p = await project(cookie);

  const made = await call("/cost-codes", {
    method: "POST", cookie,
    body: { code: "02-100", name: "Foundations", projectId: p.id },
  });
  assert.equal(made.status, 201, made.text.slice(0, 240));
  assert.equal(made.json.costCode.code, "02-100");

  const listed = await call("/cost-codes", { cookie });
  assert.equal(listed.status, 200, listed.text.slice(0, 200));
  assert.equal(listed.json["cost-codes"].length, 1);
});

test("an expense posted against a code carries it onto the ledger", { skip }, async () => {
  const { cookie, org } = await withChart();
  const p = await project(cookie);
  const code = (await call("/cost-codes", {
    method: "POST", cookie, body: { code: "02-100", name: "Foundations", projectId: p.id },
  })).json.costCode;

  const spent = await call("/expenses", {
    method: "POST", cookie,
    body: {
      detail: "Concrete pour", category: "materials", amount: 450_000,
      currency: "KES", spentOn: "2026-03-01",
      costCodeId: code.id, projectId: p.id,
    },
  });
  assert.equal(spent.status, 201, spent.text.slice(0, 260));

  /* The expense posts on write — see the registry's afterWrite bridge. */
  const lines = await db.journalLine.findMany({
    where: { orgId: org.id, costCodeId: code.id },
  });
  assert.ok(lines.length >= 2,
    "*** the expense posted no journal line carrying its cost code, so the " +
    "CostCode table is decoration: spend can be tagged and never reported ***");
  assert.ok(lines.every((l) => l.projectId === p.id),
    "the development dimension did not reach the ledger either");

  /* BOTH sides carry it — the cost and what is owed for it. */
  assert.ok(lines.some((l) => l.debit > 0n), "no cost line");
  assert.ok(lines.some((l) => l.credit > 0n), "no payable line");
});

test("spend by cost code is answerable in one query", { skip }, async () => {
  const { cookie, org } = await withChart();
  const p = await project(cookie);
  const mk = async (code: string, name: string) => (await call("/cost-codes", {
    method: "POST", cookie, body: { code, name, projectId: p.id },
  })).json.costCode;

  const foundations = await mk("02-100", "Foundations");
  const roofing = await mk("07-500", "Roofing");

  for (const [c, amount] of [[foundations, 450_000], [foundations, 120_000], [roofing, 90_000]] as const) {
    const r = await call("/expenses", {
      method: "POST", cookie,
      body: {
        detail: `Spend ${++seq}`, category: "materials", amount,
        currency: "KES", spentOn: "2026-03-01", costCodeId: c.id, projectId: p.id,
      },
    });
    assert.equal(r.status, 201, r.text.slice(0, 220));
  }

  const byCode = await db.journalLine.groupBy({
    by: ["costCodeId"],
    where: { orgId: org.id, costCodeId: { not: null }, debit: { gt: 0n } },
    _sum: { debit: true },
  });
  const total = (id: string) =>
    byCode.find((r) => r.costCodeId === id)?._sum.debit ?? 0n;

  assert.equal(total(foundations.id), 570_000n,
    "the foundations should come to 570,000 — this is the whole point of a code");
  assert.equal(total(roofing.id), 90_000n);
});

/* ==================================================================== *
 * A CORRECTION MUST NET OUT, OR THE REPORT IS WRONG FOR EVER.
 * ==================================================================== */

test("reversing an expense removes it from the code's total", { skip }, async () => {
  const { cookie, org } = await withChart();
  const p = await project(cookie);
  const code = (await call("/cost-codes", {
    method: "POST", cookie, body: { code: "02-100", name: "Foundations", projectId: p.id },
  })).json.costCode;

  const spent = await call("/expenses", {
    method: "POST", cookie,
    body: {
      detail: "Entered twice", category: "materials", amount: 450_000,
      currency: "KES", spentOn: "2026-03-01", costCodeId: code.id, projectId: p.id,
    },
  });
  assert.equal(spent.status, 201, spent.text.slice(0, 220));

  const entry = present(
    await db.journalEntry.findFirst({
      where: { orgId: org.id, sourceType: "expense", sourceId: spent.json.expense.id },
    }), "the expense posted nothing");

  /* BEFORE reversing, the code must actually hold the spend. Without this the
     assertion at the end passes on nothing at all — zero minus zero is zero,
     and an earlier version of this test went green against a build where the
     cost code never reached the ledger. */
  const before = await db.journalLine.aggregate({
    where: { orgId: org.id, costCodeId: code.id },
    _sum: { debit: true },
  });
  assert.equal(before._sum.debit, 450_000n,
    "the spend is not on the code, so the netting below would prove nothing");

  const reversed = await call(`/ledger/entries/${entry.id}/reverse`, {
    method: "POST", cookie, body: { reason: "entered twice" },
  });
  assert.equal(reversed.status, 201, reversed.text.slice(0, 240));

  /*
   * MEASURED ON THE REVERSAL'S OWN LINES.
   *
   * An earlier version netted all debits against all credits for the code,
   * which is zero whether or not the reversal carries it — the expense posts
   * a BALANCED pair and both sides are stamped. It passed against a build
   * where the reversal dropped the dimension entirely.
   */
  const mirror = present(
    await db.journalEntry.findFirst({
      where: { orgId: org.id, reversesId: entry.id }, include: { lines: true },
    }), "the reversal posted nothing");

  assert.ok(mirror.lines.length > 0, "the reversal has no lines");
  assert.ok(mirror.lines.every((l) => l.costCodeId === code.id),
    "*** the reversal did not carry the cost code, so the original spend stays " +
    "in the foundations total for ever and the job looks more expensive than " +
    "it was ***");
  assert.ok(mirror.lines.every((l) => l.projectId === p.id),
    "the reversal did not carry the development either");

  /* And the cost account itself nets to nothing, which is the point. */
  const costLines = await db.journalLine.findMany({
    where: { orgId: org.id, costCodeId: code.id },
    include: { account: { select: { type: true } } },
  });
  const onExpense = costLines.filter((l) => l.account.type === "EXPENSE");
  assert.equal(
    onExpense.reduce((a, l) => a + l.debit - l.credit, 0n), 0n,
    "the spend did not come back off the expense account");
});

/* ==================================================================== *
 * WHOSE CODES THEY ARE.
 * ==================================================================== */

test("one company cannot see or spend against another's cost codes", { skip }, async () => {
  const mine = await withChart();
  const theirs = await withChart();
  const p = await project(theirs.cookie);
  const code = (await call("/cost-codes", {
    method: "POST", cookie: theirs.cookie,
    body: { code: "02-100", name: "Foundations", projectId: p.id },
  })).json.costCode;

  const listed = await call("/cost-codes", { cookie: mine.cookie });
  assert.equal(listed.json["cost-codes"].length, 0,
    "*** one company read another's cost structure ***");

  const stolen = await call("/expenses", {
    method: "POST", cookie: mine.cookie,
    body: {
      detail: "Theirs", category: "materials", amount: 1000,
      currency: "KES", spentOn: "2026-03-01", costCodeId: code.id,
    },
  });
  assert.ok(stolen.status === 400 || stolen.status === 404,
    `one company posted spend against another's cost code (${stolen.status})`);
});

test("the same code may exist in two companies", { skip }, async () => {
  const a = await withChart();
  const b = await withChart();
  for (const c of [a, b]) {
    const made = await call("/cost-codes", {
      method: "POST", cookie: c.cookie, body: { code: "02-100", name: "Foundations" },
    });
    assert.equal(made.status, 201,
      `the second company could not use the same code: ${made.text.slice(0, 160)}`);
  }
});

test("only somebody trusted with the money may change the cost structure", { skip }, async () => {
  const { cookie } = await company("HOUSEKEEPING");
  const tried = await call("/cost-codes", {
    method: "POST", cookie, body: { code: "02-100", name: "Foundations" },
  });
  assert.equal(tried.status, 403, "housekeeping rewrote the cost structure");
});
