/* ====================================================================== *
 * TOKENISED INVESTMENT.
 *
 * Four things this file exists to prove, and they are the four that would
 * matter to somebody putting money in:
 *
 *   1. An offering cannot reach LIVE without having been APPROVED, and cannot
 *      be APPROVED without having been REVIEWED. Proved by walking every path
 *      through the transition table, not by testing one happy route.
 *   2. A company cannot approve its own offering. It holds no such right.
 *   3. A company that is not an approved issuer cannot raise anything, whatever
 *      it has bought.
 *   4. With no tokenisation provider connected, nothing is recorded as issued.
 *      No plausible reference, no holding row, no number on a screen.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";
import {
  OFFERING_TRANSITIONS, OFFERING_RIGHTS, eligibilityRefusal, offeringRefusal,
  offeringRights, submissionGaps, splitCodes,
} from "../src/domain/investments.js";
import * as tokens from "../src/domain/tokenisation.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_investments";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping investment tests";
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.js"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST"
      : "database unreachable: " + m.slice(0, 90);
  }
}

let server, base, pool;
test.before(async () => {
  if (skip) return;
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
  tokens.clear();
});

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
               ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not always JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;

/** A company, optionally an approved issuer, with a development to raise on. */
async function company({ role = "OWNER", issuer = null, platform = false } = {}) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Firm ${n}`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { status: "ACTIVE" } },
      entitlements: { create: (platform ? ["PLATFORM"] : ["PROPERTY_MANAGEMENT"]).map((p) => ({ product: p })) },
    },
  });
  if (issuer) {
    await db.issuerProfile.create({
      data: {
        orgId: org.id, status: issuer.status || "APPROVED",
        regulator: "CMA", licenceRef: `CMA/${n}`,
        jurisdictions: issuer.jurisdictions || "KE,AE",
        legalName: `Firm ${n} Ltd`, approvedAt: new Date(), approvedBy: "PALTAS ops",
      },
    });
  }
  const email = `i${n}.${Date.now()}@inv.test`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub" + email } });
  await db.membership.create({ data: { orgId: org.id, userId: user.id, role } });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
            userId: user.id, orgId: org.id, expiresAt: new Date(Date.now() + 3600_000) },
  });
  const project = await db.project.create({
    data: { orgId: org.id, name: `Karen Ridge ${n}`, budget: 50_000_000_00n } });
  return { org, user, project, cookie: `paltas_session=${token}` };
}

/** A complete, submittable offering for this company. */
async function completeOffering(c, { sandbox = false, units = 1000, price = 10_000n } = {}) {
  const o = await db.offering.create({
    data: {
      orgId: c.org.id, projectId: c.project.id,
      ref: `OFF-${++seq}`, title: "Karen Ridge, phase 2",
      targetRaise: price * BigInt(units), tokenUnits: units, unitPrice: price,
      currency: "KES", jurisdictions: "KE",
      distributionRule: "Quarterly, pro rata to units held",
      minUnits: 1, sandbox,
    },
  });
  for (const role of ["PROPERTY_OWNER", "ISSUER", "TOKENISATION_PROVIDER"]) {
    await db.offeringParty.create({
      data: { offeringId: o.id, role, legalName: `${role} Ltd`, jurisdiction: "KE" } });
  }
  for (const role of ["PROSPECTUS", "RISK_DISCLOSURE"]) {
    const doc = await db.document.create({
      data: { orgId: c.org.id, name: `${role}.pdf`, kind: "OTHER" } });
    await db.offeringDocument.create({
      data: { offeringId: o.id, documentId: doc.id, role, required: true } });
  }
  return o;
}

/* ================================================================ *
 * 1. THE INVARIANT, WALKED RATHER THAN SAMPLED — no database needed.
 * ================================================================ */

test("no path reaches LIVE without passing through approve", () => {
  const T = OFFERING_TRANSITIONS;
  const paths = [];
  (function walk(state, seen, path) {
    if (seen.has(state)) return;
    if (state === "LIVE") { paths.push(path); return; }
    for (const [name, rule] of Object.entries(T)) {
      if (rule.from.includes(state)) walk(rule.to, new Set([...seen, state]), path.concat(name));
    }
  })("DRAFT", new Set(), []);

  assert.ok(paths.length > 0, "there is no route from DRAFT to LIVE at all");
  const cheats = paths.filter((p) => !p.includes("approve"));
  assert.deepEqual(cheats, [],
    "these routes reach LIVE without an approval:\n  " +
    cheats.map((p) => p.join(" -> ")).join("\n  "));
});

test("APPROVED comes only from UNDER_REVIEW", () => {
  assert.deepEqual(OFFERING_TRANSITIONS.approve.from, ["UNDER_REVIEW"],
    "if SUBMITTED could be approved directly, the review step would be optional " +
    "in practice while still appearing in the diagram");
});

test("all ten requested states are reachable, and so are the two a review needs", () => {
  const T = OFFERING_TRANSITIONS;
  const reach = new Set(["DRAFT"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const rule of Object.values(T)) {
      if (rule.from.some((f) => reach.has(f)) && !reach.has(rule.to)) {
        reach.add(rule.to); grew = true;
      }
    }
  }
  for (const s of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "SCHEDULED",
                   "LIVE", "FUNDED", "CLOSED", "DISTRIBUTING", "COMPLETED",
                   "REJECTED", "CHANGES_REQUESTED"]) {
    assert.ok(reach.has(s), `${s} cannot be reached from DRAFT`);
  }
});

test("no customer role can approve its own offering", () => {
  for (const role of ["OWNER", "MANAGER", "GM", "FINANCE"]) {
    const rights = offeringRights({ role, isPlatform: false });
    assert.ok(!rights.approve, `${role} holds approve, so a company can approve its own offering`);
    assert.ok(!rights.goLive, `${role} holds goLive`);
  }
  /* And a PALTAS owner is the publisher on PALTAS's own platform. */
  assert.ok(offeringRights({ role: "OWNER", isPlatform: true }).approve,
    "nobody can approve anything, which is also broken");
  assert.equal(OFFERING_RIGHTS.MARKETING.approve, undefined,
    "reviewing is not approving — marketing may request changes, not approve");
});

test("a refusal says what state it would have to be in", () => {
  const why = offeringRefusal({ role: "OWNER" }, "submit", { status: "LIVE" });
  assert.match(why, /live/i);
  assert.match(why, /draft/i, "the refusal should name the states it is possible from");
});

/* ================================================================ *
 * 2. SUBMISSION COMPLETENESS — and the arithmetic nobody checks by eye.
 * ================================================================ */

test("units x price must equal the target raise", () => {
  const gaps = submissionGaps(
    { title: "x", targetRaise: 20_000_000, tokenUnits: 1000, unitPrice: 10_000,
      jurisdictions: "KE", distributionRule: "quarterly" },
    { parties: [{ role: "PROPERTY_OWNER" }, { role: "ISSUER" }, { role: "TOKENISATION_PROVIDER" }],
      documents: [{ role: "PROSPECTUS" }, { role: "RISK_DISCLOSURE" }],
      issuer: { status: "APPROVED", jurisdictions: "KE" } });
  assert.ok(gaps.some((g) => /matches units x price/.test(g)),
    "1000 x 10,000 is 10,000,000 and the offering claims 20,000,000 — " +
    "whichever an investor reads, one of them is false. Gaps: " + gaps.join("; "));
});

test("an offering cannot name a jurisdiction the company is not licensed for", () => {
  const gaps = submissionGaps(
    { title: "x", targetRaise: 100, tokenUnits: 10, unitPrice: 10,
      jurisdictions: "KE,GB", distributionRule: "quarterly" },
    { parties: [{ role: "PROPERTY_OWNER" }, { role: "ISSUER" }, { role: "TOKENISATION_PROVIDER" }],
      documents: [{ role: "PROSPECTUS" }, { role: "RISK_DISCLOSURE" }],
      issuer: { status: "APPROVED", jurisdictions: "KE,AE" } });
  assert.ok(gaps.some((g) => /not licensed for: GB/.test(g)), gaps.join("; "));
});

test("the property owner and the issuer must both be named", () => {
  const gaps = submissionGaps(
    { title: "x", targetRaise: 100, tokenUnits: 10, unitPrice: 10,
      jurisdictions: "KE", distributionRule: "quarterly" },
    { parties: [], documents: [{ role: "PROSPECTUS" }, { role: "RISK_DISCLOSURE" }],
      issuer: { status: "APPROVED", jurisdictions: "KE" } });
  assert.ok(gaps.some((g) => /property owner/.test(g)), gaps.join("; "));
  assert.ok(gaps.some((g) => /issuer named/.test(g)), gaps.join("; "));
});

/* ================================================================ *
 * 3. COMPLIANCE GATING.
 * ================================================================ */

test("an investor with unfinished checks cannot be sold anything", () => {
  const live = { status: "LIVE", jurisdictions: "KE", eligibility: "RETAIL_PERMITTED" };
  assert.match(eligibilityRefusal(live, { kyc: "PENDING", aml: "CLEAR" }), /identity checks/i);
  assert.match(eligibilityRefusal(live, { kyc: "VERIFIED", aml: "BLOCKED" }), /blocked/i);
  assert.match(eligibilityRefusal(live, { kyc: "VERIFIED", aml: "REVIEW" }), /screening/i);
  assert.equal(eligibilityRefusal(live,
    { kyc: "VERIFIED", aml: "CLEAR", jurisdiction: "KE", classifiedAs: "RETAIL_PERMITTED" }), null);
});

test("jurisdiction and classification both bite", () => {
  const keOnly = { status: "LIVE", jurisdictions: "KE", eligibility: "RETAIL_PERMITTED" };
  const clear = { kyc: "VERIFIED", aml: "CLEAR", classifiedAs: "RETAIL_PERMITTED" };
  assert.match(eligibilityRefusal(keOnly, { ...clear, jurisdiction: "GB" }), /not available in GB/);
  assert.match(eligibilityRefusal(keOnly, { ...clear, jurisdiction: "" }), /not recorded/);

  const pro = { status: "LIVE", jurisdictions: "KE", eligibility: "ACCREDITED_ONLY" };
  assert.match(
    eligibilityRefusal(pro, { ...clear, jurisdiction: "KE", classifiedAs: "PROFESSIONAL_ONLY" }),
    /accredited only/i);
});

test("an offering that is not LIVE is not open, whatever the investor looks like", () => {
  const clear = { kyc: "VERIFIED", aml: "CLEAR", jurisdiction: "KE", classifiedAs: "RETAIL_PERMITTED" };
  for (const status of ["DRAFT", "SUBMITTED", "APPROVED", "SCHEDULED", "CLOSED"]) {
    assert.match(eligibilityRefusal({ status, jurisdictions: "KE" }, clear),
      /not open for investment/, `${status} was treated as open`);
  }
});

/* ================================================================ *
 * 4. THE TOKENISATION ADAPTER — refuses, never fabricates.
 * ================================================================ */

test("with no provider connected, issuing refuses and records nothing", async () => {
  tokens.clear();
  const st = tokens.status();
  assert.equal(st.connected, false);
  assert.match(st.why, /No tokenisation provider is connected/);

  await assert.rejects(
    () => tokens.provider().mint({ offeringRef: "OFF-1", investorRef: "I-1", units: 10 }),
    (e) => {
      assert.equal(e.name, "TokenisationUnavailable");
      assert.equal(e.status, 503, "a missing capability is 503, not 500 — nothing is broken");
      return true;
    },
    "mint() returned something. A plausible reference here is how a platform " +
    "tells an investor they own units that do not exist.");

  /* Reading, by contrast, answers: "none that this service can see" is true. */
  assert.deepEqual(await tokens.provider().positionsFor({ offeringRef: "OFF-1" }), []);
});

test("every sandbox reference is marked as one", async () => {
  tokens.register(tokens.sandboxProvider());
  const r = await tokens.provider().mint({ offeringRef: "OFF-1", investorRef: "I-1", units: 40 });
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "string") continue;
    assert.ok(/^SANDBOX/.test(v) || v === "sandbox",
      `${k} is "${v}", which could be mistaken for a real reference`);
  }
  assert.equal(tokens.status().sandbox, true);
  tokens.clear();
});

/* ================================================================ *
 * 5. THE ROUTES, AGAINST A REAL DATABASE.
 * ================================================================ */

test("a company that is not an approved issuer cannot create an offering",
  { skip }, async () => {
  const c = await company({ issuer: null });
  const r = await call("/investments/offerings", { method: "POST", cookie: c.cookie,
    body: { title: "Anything", projectId: c.project.id } });
  assert.equal(r.status, 403, r.text.slice(0, 200));
  assert.match(r.json.message, /not an approved issuer/);

  /* And the eligibility endpoint says so plainly rather than 403-ing. */
  const e = await call("/investments/eligibility", { cookie: c.cookie });
  assert.equal(e.status, 200);
  assert.equal(e.json.eligible, false);
  assert.equal(e.json.status, "NOT_APPLIED");
});

test("a suspended issuer is refused in the same words as one that never applied",
  { skip }, async () => {
  const a = await company({ issuer: { status: "SUSPENDED" } });
  const b = await company({ issuer: null });
  const ra = await call("/investments/offerings", { method: "POST", cookie: a.cookie,
    body: { title: "X", projectId: a.project.id } });
  const rb = await call("/investments/offerings", { method: "POST", cookie: b.cookie,
    body: { title: "X", projectId: b.project.id } });
  assert.equal(ra.status, 403);
  assert.equal(rb.status, 403);
  assert.equal(ra.json.message, rb.json.message,
    "a suspension is a conversation with PALTAS, not something a 403 body discloses");
});

test("an offering is created as a DRAFT against this company's own development",
  { skip }, async () => {
  const c = await company({ issuer: {} });
  const other = await company({ issuer: {} });

  const r = await call("/investments/offerings", { method: "POST", cookie: c.cookie,
    body: { title: "Karen Ridge, phase 2", projectId: c.project.id,
            targetRaise: 10_000_000, tokenUnits: 1000, unitPrice: 10_000,
            jurisdictions: "KE", distributionRule: "Quarterly, pro rata" } });
  assert.equal(r.status, 201, r.text.slice(0, 300));
  assert.equal(r.json.offering.status, "DRAFT", "there is no way to create one in any other state");
  assert.equal(r.json.offering.sandbox, false);
  assert.match(r.json.offering.ref, /^OFF-/);

  /* Another company's development is not available to raise against. */
  const cross = await call("/investments/offerings", { method: "POST", cookie: c.cookie,
    body: { title: "Theirs", projectId: other.project.id } });
  assert.equal(cross.status, 400);
  assert.match(cross.json.message, /not one of this company's/);
});

test("an offering cannot be submitted until it is complete, and says what is missing",
  { skip }, async () => {
  const c = await company({ issuer: {} });
  const bare = await db.offering.create({
    data: { orgId: c.org.id, projectId: c.project.id, ref: `OFF-B${++seq}`, title: "Bare" } });

  const r = await call(`/investments/offerings/${bare.id}/submit`,
    { method: "POST", cookie: c.cookie });
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assert.match(r.json.message, /still needs/);
  assert.ok(Array.isArray(r.json.details && r.json.details.outstanding),
    "the list of what is missing should be machine-readable for the screen");
  assert.ok(r.json.details.outstanding.length >= 4, r.json.details.outstanding.join("; "));

  const full = await completeOffering(c);
  const ok = await call(`/investments/offerings/${full.id}/submit`,
    { method: "POST", cookie: c.cookie });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.json.offering.status, "SUBMITTED");
});

test("the company cannot approve it, and cannot put it live", { skip }, async () => {
  const c = await company({ issuer: {} });
  const o = await completeOffering(c);
  await call(`/investments/offerings/${o.id}/submit`, { method: "POST", cookie: c.cookie });

  for (const action of ["claim", "approve", "goLive", "schedule"]) {
    const r = await call(`/investments/offerings/${o.id}/${action}`,
      { method: "POST", cookie: c.cookie });
    assert.equal(r.status, 403, `${action} was allowed: ${r.text.slice(0, 160)}`);
  }
  const after = await db.offering.findUnique({ where: { id: o.id } });
  assert.equal(after.status, "SUBMITTED", "the offering moved anyway");
});

test("PALTAS staff review, approve and then it can go live — in that order",
  { skip }, async () => {
  const c = await company({ issuer: {} });
  const o = await completeOffering(c);
  await call(`/investments/offerings/${o.id}/submit`, { method: "POST", cookie: c.cookie });

  /*
   * The reviewer is a PALTAS membership. Created against the SAME company here
   * because these routes are org-scoped — what is being tested is the RIGHT,
   * not the tenancy, which tenancy.test.js covers for every resource.
   */
  await db.entitlement.create({ data: { orgId: c.org.id, product: "PLATFORM" } });
  const staffEmail = `pub${++seq}.${Date.now()}@paltas.io`;
  const staff = await db.user.create({
    data: { email: staffEmail, name: "Publisher", googleSub: "s" + staffEmail } });
  await db.membership.create({ data: { orgId: c.org.id, userId: staff.id, role: "PUBLISHER" } });
  const tok = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(tok).digest("hex"),
            userId: staff.id, orgId: c.org.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const pub = `paltas_session=${tok}`;

  /* Straight to live, skipping the review, must fail. */
  const early = await call(`/investments/offerings/${o.id}/goLive`, { method: "POST", cookie: pub });
  assert.equal(early.status, 403, "an offering went live from SUBMITTED");

  assert.equal((await call(`/investments/offerings/${o.id}/claim`, { method: "POST", cookie: pub })).json.offering.status, "UNDER_REVIEW");
  assert.equal((await call(`/investments/offerings/${o.id}/approve`, { method: "POST", cookie: pub })).json.offering.status, "APPROVED");
  const live = await call(`/investments/offerings/${o.id}/goLive`, { method: "POST", cookie: pub });
  assert.equal(live.status, 200, live.text.slice(0, 200));
  assert.equal(live.json.offering.status, "LIVE");
  assert.ok(live.json.offering.liveAt, "going live should be stamped");
});

test("sending an offering back needs a reason", { skip }, async () => {
  const c = await company({ issuer: {} });
  const o = await completeOffering(c);
  await call(`/investments/offerings/${o.id}/submit`, { method: "POST", cookie: c.cookie });
  await db.entitlement.create({ data: { orgId: c.org.id, product: "PLATFORM" } });
  const e = `cmp${++seq}.${Date.now()}@paltas.io`;
  const u = await db.user.create({ data: { email: e, name: "Compliance", googleSub: "s" + e } });
  await db.membership.create({ data: { orgId: c.org.id, userId: u.id, role: "COMPLIANCE" } });
  const tok = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(tok).digest("hex"),
            userId: u.id, orgId: c.org.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const cookie = `paltas_session=${tok}`;

  const bare = await call(`/investments/offerings/${o.id}/requestChanges`,
    { method: "POST", cookie });
  assert.equal(bare.status, 403);
  assert.match(bare.json.message, /Say why/);

  const withReason = await call(`/investments/offerings/${o.id}/requestChanges`,
    { method: "POST", cookie, body: { reason: "The valuation is two years old." } });
  assert.equal(withReason.status, 200, withReason.text.slice(0, 200));
  assert.equal(withReason.json.offering.status, "CHANGES_REQUESTED");
  assert.match(withReason.json.offering.decisionNote, /valuation/);
});

test("a live offering's terms are fixed", { skip }, async () => {
  const c = await company({ issuer: {} });
  const o = await db.offering.create({
    data: { orgId: c.org.id, projectId: c.project.id, ref: `OFF-L${++seq}`,
            title: "Live one", status: "LIVE", tokenUnits: 100, unitPrice: 1000n,
            targetRaise: 100_000n, currency: "KES" } });
  const r = await call(`/investments/offerings/${o.id}`,
    { method: "PATCH", cookie: c.cookie, body: { unitPrice: 1 } });
  assert.equal(r.status, 409, r.text.slice(0, 200));
  const after = await db.offering.findUnique({ where: { id: o.id } });
  assert.equal(after.unitPrice, 1000n, "the price changed under a live offering");
});

test("an order on a live offering is held when compliance is not clear", { skip }, async () => {
  const c = await company({ issuer: {} });
  const o = await db.offering.create({
    data: { orgId: c.org.id, projectId: c.project.id, ref: `OFF-O${++seq}`,
            title: "Open", status: "LIVE", tokenUnits: 1000, unitPrice: 10_000n,
            targetRaise: 10_000_000n, currency: "KES", jurisdictions: "KE",
            eligibility: "RETAIL_PERMITTED", minUnits: 1 } });
  const inv = await db.investor.create({
    data: { orgId: c.org.id, name: "Rift Valley Capital", kind: "FUND" } });

  /* No profile at all: held, with a reason, and recorded. */
  const held = await call(`/investments/offerings/${o.id}/orders`,
    { method: "POST", cookie: c.cookie, body: { investorId: inv.id, units: 10 } });
  assert.equal(held.status, 201, held.text.slice(0, 200));
  assert.equal(held.json.order.status, "COMPLIANCE_HOLD");
  assert.equal(held.json.held, true);
  assert.match(held.json.why, /compliance profile/i);
  assert.equal(held.json.settled, false, "no provider is integrated; nothing settles");

  /* Amount is computed, never taken from the request. */
  assert.equal(String(held.json.order.amount), String(10 * 10_000),
    "the amount must be units x the offering's unit price");

  await db.investorProfile.create({
    data: { orgId: c.org.id, investorId: inv.id, kyc: "VERIFIED", aml: "CLEAR",
            jurisdiction: "KE", classifiedAs: "RETAIL_PERMITTED" } });
  const ok = await call(`/investments/offerings/${o.id}/orders`,
    { method: "POST", cookie: c.cookie, body: { investorId: inv.id, units: 5 } });
  assert.equal(ok.json.order.status, "APPROVED");
  assert.equal(ok.json.held, false);
});

test("an order cannot exceed the units left, and issuing needs a settled order",
  { skip }, async () => {
  const c = await company({ issuer: {} });
  const o = await db.offering.create({
    data: { orgId: c.org.id, projectId: c.project.id, ref: `OFF-C${++seq}`,
            title: "Small", status: "LIVE", tokenUnits: 10, unitPrice: 1000n,
            targetRaise: 10_000n, currency: "KES", jurisdictions: "KE",
            eligibility: "RETAIL_PERMITTED", minUnits: 1 } });
  const inv = await db.investor.create({ data: { orgId: c.org.id, name: "Someone" } });
  await db.investorProfile.create({
    data: { orgId: c.org.id, investorId: inv.id, kyc: "VERIFIED", aml: "CLEAR",
            jurisdiction: "KE", classifiedAs: "RETAIL_PERMITTED" } });

  const first = await call(`/investments/offerings/${o.id}/orders`,
    { method: "POST", cookie: c.cookie, body: { investorId: inv.id, units: 8 } });
  assert.equal(first.json.order.status, "APPROVED");

  const over = await call(`/investments/offerings/${o.id}/orders`,
    { method: "POST", cookie: c.cookie, body: { investorId: inv.id, units: 5 } });
  assert.equal(over.status, 409, over.text.slice(0, 200));
  assert.match(over.json.message, /still available/);

  /* Issuing against an order that has not settled must refuse. */
  const issue = await call(`/tokenization/offerings/${o.id}/issue`,
    { method: "POST", cookie: c.cookie, body: { orderId: first.json.order.id } });
  assert.equal(issue.status, 409, issue.text.slice(0, 200));
  assert.match(issue.json.message, /settled order/);

  /* And with it settled but no provider connected, it refuses with 503 and
     writes no holding. */
  await db.investmentOrder.update({
    where: { id: first.json.order.id }, data: { status: "SETTLED", settledAt: new Date() } });
  tokens.clear();
  const none = await call(`/tokenization/offerings/${o.id}/issue`,
    { method: "POST", cookie: c.cookie, body: { orderId: first.json.order.id } });
  assert.equal(none.status, 503, none.text.slice(0, 200));
  assert.equal(await db.tokenHolding.count({ where: { offeringId: o.id } }), 0,
    "a holding was written with no provider behind it");
  assert.equal(await db.tokenEvent.count({ where: { offeringId: o.id } }), 0);
});

test("sandbox offerings are excluded from lists and totals by default", { skip }, async () => {
  const c = await company({ issuer: {} });
  await completeOffering(c, { sandbox: false });
  await completeOffering(c, { sandbox: true });

  const real = await call("/investments/offerings", { cookie: c.cookie });
  assert.equal(real.json.offerings.length, 1, "a sandbox offering appeared in a production list");
  assert.equal(real.json.offerings[0].sandbox, false);

  const sbx = await call("/investments/offerings?sandbox=true", { cookie: c.cookie });
  assert.equal(sbx.json.offerings.length, 1);
  assert.equal(sbx.json.offerings[0].sandbox, true);

  const sum = await call("/investments/summary", { cookie: c.cookie });
  assert.equal(sum.json.counts.offerings, 1, "the summary counted a test offering");
  assert.equal(sum.json.tokenisation.connected, false);
});

test("one company cannot see another's offerings, orders or investors",
  { skip }, async () => {
  const a = await company({ issuer: {} });
  const b = await company({ issuer: {} });
  const mine = await completeOffering(a);

  assert.equal((await call(`/investments/offerings/${mine.id}`, { cookie: b.cookie })).status, 404);
  const listed = await call("/investments/offerings", { cookie: b.cookie });
  assert.equal((listed.json.offerings || []).filter((o) => o.id === mine.id).length, 0);
  assert.equal((await call(`/investments/offerings/${mine.id}/parties`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(`/investments/offerings/${mine.id}/submit`,
    { method: "POST", cookie: b.cookie })).status, 404);
});

test("my investments is scoped to the person, not the company", { skip }, async () => {
  const c = await company({ issuer: {} });
  const inv = await db.investor.create({
    data: { orgId: c.org.id, name: "Person 1's holding", userId: c.user.id } });
  const other = await db.investor.create({
    data: { orgId: c.org.id, name: "Somebody else" } });

  const o = await db.offering.create({
    data: { orgId: c.org.id, ref: `OFF-M${++seq}`, title: "Mine", status: "LIVE",
            tokenUnits: 100, unitPrice: 1000n, targetRaise: 100_000n } });
  for (const [who, ref] of [[inv.id, "ORD-MINE"], [other.id, "ORD-THEIRS"]]) {
    await db.investmentOrder.create({
      data: { orgId: c.org.id, offeringId: o.id, investorId: who, ref,
              units: 4, amount: 4000n, status: "APPROVED" } });
  }

  const r = await call("/investments/mine", { cookie: c.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.linked, true);
  assert.equal(r.json.investments.length, 1, "a person saw somebody else's order");
  assert.equal(r.json.investments[0].ref, "ORD-MINE");
  /*
   * NO VALUATION.
   *
   * "What is this worth now" needs a current valuation of the property, and
   * nothing in this platform holds one.
   */
  assert.equal(r.json.valuation, null);
  assert.deepEqual(r.json.holdings, [], "units exist only when a provider reports them");
});

test("a person with no investor record gets an empty answer, not a 403", { skip }, async () => {
  const c = await company({ issuer: {} });
  const r = await call("/investments/mine", { cookie: c.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.linked, false);
  assert.deepEqual(r.json.investments, []);
});

test("a role without the investments area is refused", { skip }, async () => {
  /* HOUSEKEEPING has `none` on investments, like most roles. */
  const c = await company({ role: "HOUSEKEEPING", issuer: {} });
  for (const path of ["/investments/offerings", "/investments/summary", "/tokenization/status"]) {
    const r = await call(path, { cookie: c.cookie });
    assert.equal(r.status, 403, `${path} answered ${r.status}`);
  }
});

/* ================================================================ *
 * THE REVIEWER IS IN A DIFFERENT COMPANY.
 *
 * This is the regression test for a bug no unit test found, because every test
 * above put the reviewer in the same organization as the offering. In
 * production a PALTAS reviewer sits in PALTAS's OWN organization, and
 * ownOffering() was strictly org-scoped — so submit, claim, approve and goLive
 * all answered 403 for the only people holding those rights, and the entire
 * review step was unreachable.
 *
 * It took walking the lifecycle over real HTTP with two separate companies to
 * see it. So that is what this test does.
 * ================================================================ */

/** PALTAS's own organization, with a staff member in it. */
async function paltasStaff(role) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `PALTAS ${n}`, country: "ke",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { status: "ACTIVE" } },
      entitlements: { create: [{ product: "PLATFORM" }] },
    },
  });
  const email = `staff${n}.${Date.now()}@paltas.io`;
  const user = await db.user.create({
    data: { email, name: `Staff ${n}`, googleSub: "s" + email } });
  await db.membership.create({ data: { orgId: org.id, userId: user.id, role } });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
            userId: user.id, orgId: org.id, expiresAt: new Date(Date.now() + 3600_000) } });
  return { org, user, cookie: `paltas_session=${token}` };
}

test("a reviewer in PALTAS's own company can review another company's offering",
  { skip }, async () => {
  const customer = await company({ issuer: {} });
  const reviewer = await paltasStaff("PUBLISHER");
  const o = await completeOffering(customer);

  assert.equal((await call(`/investments/offerings/${o.id}/submit`,
    { method: "POST", cookie: customer.cookie })).json.offering.status, "SUBMITTED");

  /* Straight to live still refused — the rule is about state, not about who. */
  assert.equal((await call(`/investments/offerings/${o.id}/goLive`,
    { method: "POST", cookie: reviewer.cookie })).status, 403);

  for (const [action, state] of [["claim", "UNDER_REVIEW"], ["approve", "APPROVED"],
                                 ["goLive", "LIVE"]]) {
    const r = await call(`/investments/offerings/${o.id}/${action}`,
      { method: "POST", cookie: reviewer.cookie });
    assert.equal(r.status, 200,
      `${action} from PALTAS's own company answered ${r.status}: ${r.text.slice(0, 180)}`);
    assert.equal(r.json.offering.status, state);
  }
});

test("the review queue is refused to a customer, not quietly narrowed", { skip }, async () => {
  const customer = await company({ issuer: {} });
  const reviewer = await paltasStaff("COMPLIANCE");
  const o = await completeOffering(customer);
  await call(`/investments/offerings/${o.id}/submit`, { method: "POST", cookie: customer.cookie });

  /*
   * Refused rather than narrowed. Returning the caller's own offerings to
   * somebody who asked for the queue would hide an integration bug behind a
   * plausible-looking list.
   */
  const denied = await call("/investments/offerings?queue=true", { cookie: customer.cookie });
  assert.equal(denied.status, 403, denied.text.slice(0, 160));
  assert.match(denied.json.message, /PALTAS staff/);

  const queue = await call("/investments/offerings?queue=true", { cookie: reviewer.cookie });
  assert.equal(queue.status, 200, queue.text.slice(0, 200));
  assert.ok(queue.json.offerings.some((x) => x.id === o.id),
    "the submitted offering is not in the reviewer's queue");
});

test("a customer still cannot reach another customer's offering", { skip }, async () => {
  /* The cross-org path opened above must be for REVIEWERS only. */
  const a = await company({ issuer: {} });
  const b = await company({ issuer: {} });
  const mine = await completeOffering(a);

  assert.equal((await call(`/investments/offerings/${mine.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(`/investments/offerings/${mine.id}/submit`,
    { method: "POST", cookie: b.cookie })).status, 404);
  const listed = await call("/investments/offerings", { cookie: b.cookie });
  assert.equal((listed.json.offerings || []).filter((x) => x.id === mine.id).length, 0);
});
