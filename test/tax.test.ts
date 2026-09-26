/* ======================================================================
 * TAX RULES, AND THE TWO WAYS A TAX TABLE GOES WRONG.
 *
 * The assertions here are ported from paltas-dev-core's own tax test —
 * dated rate change, no overlaps, no silent zero for an unknown code —
 * with the things that module had no concept of added: an organization,
 * a permission, an audit row, and the question of whose rate it is.
 *
 * The one that matters most is the silent zero. An invoice that charges
 * no VAT looks completely normal; nothing about it draws the eye. So a
 * tax code nobody has configured is refused rather than treated as nil.
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
const skip = DB ? false : "no TEST_DATABASE_URL — skipping tax tests";

const SCHEMA = "tax_test";
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
      name: `Tax ${n} Ltd`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `tax${n}@example.test`;
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

const RULE = {
  country: "KE", taxCode: "VAT_STANDARD", rateBp: 1600,
  effectiveFrom: "2026-01-01", confirmedBy: "TEST ONLY — not a real rate",
  label: "VAT 16%",
};

/* ==================================================================== *
 * A RATE IS DATA WITH A DATE ON IT.
 * ==================================================================== */

test("a rate change is a new rule, and the old invoices keep the old rate", { skip }, async () => {
  const { cookie } = await company();

  const first = await call("/tax/rules", { method: "POST", cookie, body: RULE });
  assert.equal(first.status, 201, first.text.slice(0, 240));
  assert.equal(first.json.rule.rateBp, 1600);

  /* End the old rate the day before the new one starts. */
  const ended = await call(`/tax/rules/${first.json.rule.id}/end`, {
    method: "POST", cookie, body: { effectiveTo: "2026-06-30" },
  });
  assert.equal(ended.status, 200, ended.text.slice(0, 200));

  const second = await call("/tax/rules", {
    method: "POST", cookie,
    body: { ...RULE, rateBp: 1800, effectiveFrom: "2026-07-01", label: "VAT 18%" },
  });
  assert.equal(second.status, 201, second.text.slice(0, 240));

  /* The rate asked for on a date is the rate in force on THAT date. */
  const march = await call("/tax/rate?taxCode=VAT_STANDARD&on=2026-03-15&base=100000", { cookie });
  assert.equal(march.json.rateBp, 1600, "March was charged at the July rate");
  assert.equal(march.json.tax, "16000");

  const august = await call("/tax/rate?taxCode=VAT_STANDARD&on=2026-08-15&base=100000", { cookie });
  assert.equal(august.json.rateBp, 1800, "August was charged at the January rate");
  assert.equal(august.json.tax, "18000");
});

test("two rules may not cover the same day", { skip }, async () => {
  const { cookie } = await company();
  assert.equal((await call("/tax/rules", { method: "POST", cookie, body: RULE })).status, 201);

  const clash = await call("/tax/rules", {
    method: "POST", cookie,
    body: { ...RULE, rateBp: 1800, effectiveFrom: "2026-07-01" },
  });
  assert.equal(clash.status, 409,
    "*** two rates now cover July, so the answer depends on which row is read first ***");
  assert.match(String(clash.json.message), /End that one/i,
    "the refusal should say what to do about it");
});

test("an unknown tax code is refused, never charged as nothing", { skip }, async () => {
  const { cookie } = await company();

  const asked = await call("/tax/rate?taxCode=VAT_STANDARD&on=2026-03-15&base=100000", { cookie });
  assert.equal(asked.status, 400,
    "*** an unconfigured tax code returned a rate. An invoice that charges no " +
    "VAT looks entirely normal, which is what makes a silent zero the most " +
    "expensive possible answer here. ***");
  assert.match(String(asked.json.message), /Add the confirmed rate/i);
});

test("NONE means outside the scope of tax, and is not an unknown code", { skip }, async () => {
  const { cookie } = await company();
  const none = await call("/tax/rate?taxCode=NONE&base=100000", { cookie });
  assert.equal(none.status, 200, none.text.slice(0, 200));
  assert.equal(none.json.rateBp, 0);
  assert.equal(none.json.tax, "0");
  assert.equal(none.json.ruleId, null, "outside scope is not a rule");
});

/* ==================================================================== *
 * A RATE NOBODY WILL PUT THEIR NAME TO.
 * ==================================================================== */

test("a rate needs the name of whoever confirmed it", { skip }, async () => {
  const { cookie } = await company();
  const anonymous = await call("/tax/rules", {
    method: "POST", cookie, body: { ...RULE, confirmedBy: "   " },
  });
  assert.equal(anonymous.status, 400);
  assert.match(String(anonymous.json.message), /who said/i,
    "the refusal should explain why a name is wanted, not merely demand one");
});

test("a rate is whole basis points from 0 to 10000", { skip }, async () => {
  const { cookie } = await company();
  for (const rateBp of [-1, 10001, 16.5]) {
    const bad = await call("/tax/rules", {
      method: "POST", cookie, body: { ...RULE, rateBp },
    });
    assert.equal(bad.status, 400, `${rateBp} was accepted as a rate`);
  }
});

test("a rule cannot end before it starts", { skip }, async () => {
  const { cookie } = await company();
  const made = await call("/tax/rules", { method: "POST", cookie, body: RULE });
  const backwards = await call(`/tax/rules/${made.json.rule.id}/end`, {
    method: "POST", cookie, body: { effectiveTo: "2025-01-01" },
  });
  assert.equal(backwards.status, 400);
});

/* ==================================================================== *
 * THE RATE REACHES AN INVOICE, AND STAYS THERE.
 * ==================================================================== */

test("an invoice line takes the rate in force on the INVOICE's date", { skip }, async () => {
  const { cookie } = await company();

  /*
   * Two rules, arranged so that the invoice's date and TODAY fall under
   * DIFFERENT ones. An earlier version of this test left the second rule
   * open-ended, which made today's rate and the invoice's rate the same
   * number — so it went on passing against a version that read the clock
   * instead of the invoice. That is the bug this arrangement exists to catch.
   */
  const first = await call("/tax/rules", { method: "POST", cookie, body: RULE });
  assert.equal(first.status, 201, first.text.slice(0, 240));
  await call(`/tax/rules/${first.json.rule.id}/end`, {
    method: "POST", cookie, body: { effectiveTo: "2026-04-30" },
  });
  const later = await call("/tax/rules", {
    method: "POST", cookie,
    body: { ...RULE, rateBp: 1800, effectiveFrom: "2026-05-01", label: "VAT 18%" },
  });
  assert.equal(later.status, 201, later.text.slice(0, 240));

  /* Today is well past 1 May, so the rate in force NOW is 1800. */
  const now = await call("/tax/rate?taxCode=VAT_STANDARD&base=100000", { cookie });
  assert.equal(now.json.rateBp, 1800, "the arrangement this test relies on is wrong");

  const inv = await call("/invoices", {
    method: "POST", cookie, body: { currency: "KES", issuedOn: "2026-03-01" },
  });
  assert.equal(inv.status, 201, inv.text.slice(0, 220));

  const line = await call(`/invoices/${inv.json.invoice.id}/lines`, {
    method: "POST", cookie,
    body: { detail: "Sale", quantity: 1, unitPrice: 100000, taxCode: "VAT_STANDARD" },
  });
  assert.equal(line.status, 201, line.text.slice(0, 240));

  const saved = present(
    await db.invoiceLine.findFirst({ where: { invoiceId: inv.json.invoice.id } }),
    "the line is gone");
  assert.equal(saved.taxBps, 1600,
    "*** the line was taxed at today's rate (18%) rather than the rate in force " +
    "on the invoice's own date in March (16%). An invoice must not restate " +
    "itself because a rate changed after it was raised. ***");
});

test("a raw taxBps still works, because every existing caller sends one", { skip }, async () => {
  const { cookie } = await company();
  const inv = await call("/invoices", {
    method: "POST", cookie, body: { currency: "KES", issuedOn: "2026-03-01" },
  });
  const line = await call(`/invoices/${inv.json.invoice.id}/lines`, {
    method: "POST", cookie,
    body: { detail: "Sale", quantity: 1, unitPrice: 100000, taxBps: 1600 },
  });
  assert.equal(line.status, 201, line.text.slice(0, 220));
  const saved = present(
    await db.invoiceLine.findFirst({ where: { invoiceId: inv.json.invoice.id } }),
    "the line is gone");
  assert.equal(saved.taxBps, 1600, "adding tax rules broke the callers that send a rate");
});

/* ==================================================================== *
 * WHOSE RATE IT IS — the thing the ported module had no concept of.
 * ==================================================================== */

test("one company cannot read or end another's tax rules", { skip }, async () => {
  const mine = await company();
  const theirs = await company();

  const made = await call("/tax/rules", { method: "POST", cookie: theirs.cookie, body: RULE });
  assert.equal(made.status, 201);

  const listed = await call("/tax/rules", { cookie: mine.cookie });
  assert.equal(listed.json.rules.length, 0,
    "*** one company read another company's tax rates ***");

  const ended = await call(`/tax/rules/${made.json.rule.id}/end`, {
    method: "POST", cookie: mine.cookie, body: { effectiveTo: "2026-06-30" },
  });
  assert.equal(ended.status, 404,
    "'exists but is not yours' must be indistinguishable from 'does not exist'");

  /* And the rule is untouched. */
  const still = present(
    await db.taxRule.findUnique({ where: { id: made.json.rule.id } }), "gone");
  assert.equal(still.effectiveTo, null, "another company ended this rate");
});

test("the same code may hold a different rate in each company", { skip }, async () => {
  const a = await company();
  const b = await company();
  await call("/tax/rules", { method: "POST", cookie: a.cookie, body: RULE });
  await call("/tax/rules", { method: "POST", cookie: b.cookie, body: { ...RULE, rateBp: 500 } });

  const forA = await call("/tax/rate?taxCode=VAT_STANDARD&on=2026-03-15&base=100000", { cookie: a.cookie });
  const forB = await call("/tax/rate?taxCode=VAT_STANDARD&on=2026-03-15&base=100000", { cookie: b.cookie });
  assert.equal(forA.json.rateBp, 1600);
  assert.equal(forB.json.rateBp, 500, "both companies were given the same rate");
});

/* ==================================================================== *
 * PERMISSION AND AUDIT.
 * ==================================================================== */

test("only somebody trusted with the money may set a tax rate", { skip }, async () => {
  const { cookie } = await company("HOUSEKEEPING");
  const tried = await call("/tax/rules", { method: "POST", cookie, body: RULE });
  assert.equal(tried.status, 403,
    "housekeeping set the company's VAT rate");
});

test("setting and ending a rate are both on the record", { skip }, async () => {
  const { cookie, org } = await company();
  const made = await call("/tax/rules", { method: "POST", cookie, body: RULE });
  await call(`/tax/rules/${made.json.rule.id}/end`, {
    method: "POST", cookie, body: { effectiveTo: "2026-06-30" },
  });

  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, entity: "taxRule" }, orderBy: { at: "asc" },
  });
  assert.deepEqual(trail.map((e) => e.action), ["tax.rule.add", "tax.rule.end"]);
  assert.equal((trail[0]?.detail as Wire)?.rateBp, 1600,
    "the trail should say what rate was set, not merely that one was");
  assert.ok(trail.every((e) => e.actorName), "a tax change with nobody attached to it");
});
