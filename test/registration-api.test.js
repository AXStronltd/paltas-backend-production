/* ====================================================================== *
 * REGISTRATION, ALL THE WAY THROUGH.
 *
 * Not "does POST /organizations return 201" — the whole journey a real estate
 * agent takes on the day they are shown PALTAS:
 *
 *   Google returns  ->  a User row exists      (upsertUser)
 *   a session is minted and the cookie is set
 *   they say what they do  ->  a company, a trial and entitlements exist
 *   they land somewhere that actually works    (/auth/session, /summary, a
 *                                               product endpoint)
 *
 * Every step is asserted against the running service and a real database,
 * because the failure that matters is not any single call returning the wrong
 * status. It is the join between them: a session that exists but reaches
 * nothing, a company with no entitlement, a dashboard that 403s the person who
 * just created it.
 *
 * WHAT IS NOT COVERED: Google itself. The token exchange needs Google, so the
 * identity is handed to upsertUser directly — which is exactly what the
 * callback does with it once the exchange succeeds.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const SCHEMA = "test_registration";
process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping registration tests";
let createApp, db, pg, upsertUser, createSession;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
    ({ createApp } = await import("../src/server.js"));
    ({ upsertUser } = await import("../src/routes/auth.js"));
    ({ createSession } = await import("../src/auth/sessions.js"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST"
      : "database unreachable: " + m.slice(0, 90);
  }
}

let server, base, pool;

async function boot() {
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
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
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;

/** Exactly what the callback does once Google has answered. */
async function arriveFromGoogle(over = {}) {
  const n = ++seq;
  const identity = {
    googleSub: "google-sub-" + n,
    email: `agent${n}@example.com`,
    name: `Agent ${n}`,
    picture: "",
    ...over,
  };
  const user = await upsertUser(identity);
  const { token } = await createSession(user.id, { userAgent: "test", ip: "127.0.0.1" });
  return { user, identity, cookie: `paltas_session=${token}` };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (skip) console.log("\n  REGISTRATION TESTS DID NOT RUN.\n  " + skip + "\n");
});

/* ================================================================ *
 * THE JOURNEY.
 * ================================================================ */

test("a real estate agent gets from Google to a working console", { skip }, async () => {
  const me = await arriveFromGoogle();

  /* 1. Signed in, but nothing of their own yet. This is the state a brand-new
        person is in the instant Google returns, and it must not be an error. */
  const before = await call("/auth/session", { cookie: me.cookie });
  assert.equal(before.status, 200, "a new account cannot read its own session");
  assert.equal(before.json.signedIn, true);
  assert.ok(!before.json.organization,
    "a brand-new account must not already have a company");

  /* 2. They say what they do. "act_for" is the estate agent line. */
  const made = await call("/organizations", {
    method: "POST", cookie: me.cookie,
    body: {
      name: "Alma Real Estate", work: ["act_for"],
      country: "ke", city: "Nairobi", size: "1-10",
    },
  });
  assert.equal(made.status, 201, "creating the company failed: " + made.text.slice(0, 200));

  /* 3. The company exists with a trial and the right entitlement — the three
        rows a console needs before it can render anything at all. */
  const org = await db.organization.findFirst({
    where: { name: "Alma Real Estate" },
    include: { subscription: true, entitlements: true, memberships: true },
  });
  assert.ok(org, "no organization row was written");
  assert.equal(org.subscription.status, "TRIALING",
    "a new company must be TRIALING — ACTIVE means somebody paid");
  assert.deepEqual(org.entitlements.map((e) => e.product), ["AGENT_HOST"],
    '"act_for" must entitle the agent product, and only that');
  assert.equal(org.memberships.length, 1, "the founder is not a member of their own company");
  assert.equal(org.memberships[0].role, "OWNER",
    "the person who created the company must own it");

  /* 4. The session now answers with the company, which is what every console
        screen reads on boot. */
  const after = await call("/auth/session", { cookie: me.cookie });
  assert.equal(after.json.organization.name, "Alma Real Estate");

  /* 5. THE JOIN THAT MATTERS: the console they land on actually answers. A
        session that exists but reaches nothing is the failure that looks like
        a broken product in front of a client. */
  const summary = await call("/summary", { cookie: me.cookie });
  assert.equal(summary.status, 200,
    "the dashboard summary refuses the person who just signed up: " + summary.text.slice(0, 200));

  const listings = await call("/listings", { cookie: me.cookie });
  assert.equal(listings.status, 200,
    "an estate agent cannot read their own (empty) listings: " + listings.text.slice(0, 200));
  assert.deepEqual(listings.json.listings, [],
    "a brand-new company must start empty, not with somebody's sample data");

  /* 6. And they can actually create something, which is the first thing anyone
        does in a demo. */
  const created = await call("/listings", {
    method: "POST", cookie: me.cookie,
    body: { title: "4-bed villa, Karen", kind: "FOR_SALE" },
  });
  assert.ok(created.status === 201 || created.status === 200,
    "the first listing could not be created: " + created.text.slice(0, 200));
});

test("a product the company did not take is refused", { skip }, async () => {
  const me = await arriveFromGoogle();
  await call("/organizations", {
    method: "POST", cookie: me.cookie,
    body: { name: "Agent Only Ltd", work: ["act_for"] },
  });

  /* Hotel rooms belong to HOTEL_MANAGEMENT. An agent has not bought it. */
  const rooms = await call("/rooms", { cookie: me.cookie });
  assert.equal(rooms.status, 403,
    "a company can read a product it never took");
});

test("signing in twice is the same person, not two", { skip }, async () => {
  const first = await arriveFromGoogle({ googleSub: "stable-sub", email: "same@example.com" });
  const again = await upsertUser({
    googleSub: "stable-sub", email: "same@example.com", name: "Same Person", picture: "",
  });
  assert.equal(again.id, first.user.id,
    "a second sign-in created a second account — their company would vanish");

  const count = await db.user.count({ where: { email: "same@example.com" } });
  assert.equal(count, 1);
});

test("a changed Google email follows the same account", { skip }, async () => {
  const me = await arriveFromGoogle({ googleSub: "moving-sub", email: "old@example.com" });
  const moved = await upsertUser({
    googleSub: "moving-sub", email: "new@example.com", name: "Moved", picture: "",
  });
  assert.equal(moved.id, me.user.id, "matching on email rather than sub loses the account");
  assert.equal(moved.email, "new@example.com");
});

test("an address claimed by a different Google account is refused, not guessed", { skip }, async () => {
  await arriveFromGoogle({ googleSub: "owner-sub", email: "shared@example.com" });
  await assert.rejects(
    () => upsertUser({ googleSub: "impostor-sub", email: "shared@example.com", name: "X", picture: "" }),
    /different Google account/,
    "guessing here hands one person another person's company");
});

test("pressing signup twice does not make two companies", { skip }, async () => {
  const me = await arriveFromGoogle();
  const a = await call("/organizations", {
    method: "POST", cookie: me.cookie, body: { name: "Twice Ltd", work: ["act_for"] },
  });
  assert.equal(a.status, 201);

  const b = await call("/organizations", {
    method: "POST", cookie: me.cookie, body: { name: "Twice Ltd", work: ["act_for"] },
  });
  assert.equal(b.status, 409, "a second company was created by pressing the button again");
  assert.match(b.json.message, /already belongs to/);

  assert.equal(await db.organization.count({ where: { name: "Twice Ltd" } }), 1);
});

test("the company must say what it does", { skip }, async () => {
  const me = await arriveFromGoogle();
  const r = await call("/organizations", {
    method: "POST", cookie: me.cookie, body: { name: "Nameless Work Ltd" },
  });
  assert.equal(r.status, 400, "a company with no product line would reach nothing");
  assert.match(r.json.message, /work/);
});

test("registering needs a session", { skip }, async () => {
  const r = await call("/organizations", {
    method: "POST", body: { name: "Anonymous Ltd", work: ["act_for"] },
  });
  assert.equal(r.status, 401, "anyone could create a company without signing in");
});

/* ================================================================ *
 * WHAT THE FORM ACTUALLY SENDS.
 * ================================================================ */

test("every product the signup form offers can actually be registered", { skip }, async () => {
  /*
   * THE BUG THIS EXISTS TO PREVENT, WHICH SHIPPED AND BLOCKED REAL SIGNUPS.
   *
   * The form asks which product the company is buying and posts the answer as
   * the product's short name: "property", "agent", "hotel", "security". The
   * server resolved those against WORK_LINES, which answers a finer and
   * different question — what the company DOES (develop, own_let, manage,
   * act_for...) — and does not contain the product names at all.
   *
   * Two of the four collided by accident. "hotel" and "security" are work
   * lines as well as product names, so those signups worked. "property" and
   * "agent" are not, so choosing Property Management or Agent & Host answered
   * "Say what the company does" and created nothing — while the other half of
   * the form worked perfectly, which is why nobody noticed.
   *
   * Every test in this file missed it for one reason: they all posted the
   * SERVER's vocabulary. The journey test above sends work: ["act_for"], which
   * no form has ever produced. So this one reads the products out of the form
   * itself and posts what a customer's browser posts.
   */
  const FE = process.env.PALTAS_FRONTEND
    || resolve(process.cwd(), "..", "paltas-frontend 2");
  const marketJs = join(FE, "assets", "market.js");
  if (!existsSync(marketJs)) return; /* frontend not checked out beside us */

  const js = readFileSync(marketJs, "utf8");
  const block = js.slice(js.indexOf("const BIZ_PRODUCTS = ["));
  const offered = [...block.slice(0, block.indexOf("\n];")).matchAll(/^\s*\["([a-z_]+)",/gm)]
    .map((m) => m[1]);

  assert.ok(offered.length >= 4,
    `only ${offered.length} products parsed out of the signup form — its shape changed`);

  const failures = [];
  for (const picked of offered) {
    const who = await arriveFromGoogle();
    /* The exact body paltas-auth.js createOrganization() builds. */
    const r = await call("/organizations", {
      method: "POST", cookie: who.cookie,
      body: {
        name: `Form Test ${picked}`, work: [picked], preferred: picked,
        country: "ke", city: "Nairobi", size: "11-50", plan: "Pro", planKey: "pro",
      },
    });
    if (r.status !== 201 && r.status !== 200) {
      failures.push(`${picked}: ${r.status} ${(r.json?.message || r.text).slice(0, 70)}`);
      continue;
    }
    /* Registered is not enough — it must grant ONE product, and the one the
       customer chose decides which console opens at the end of signup. */
    const org = await db.organization.findFirst({
      where: { name: `Form Test ${picked}` },
      include: { entitlements: true, workspace: true },
    });
    if (!org) { failures.push(`${picked}: 201 but no company was written`); continue; }
    if (org.entitlements.length !== 1) {
      failures.push(`${picked}: granted ${org.entitlements.length} products ` +
        `(${org.entitlements.map((e) => e.product).join(",")})`);
    }
    if (org.workspace?.preferred !== org.entitlements[0]?.product) {
      failures.push(`${picked}: opens ${org.workspace?.preferred}, bought ` +
        `${org.entitlements[0]?.product}`);
    }
  }

  assert.deepEqual(failures, [],
    "a product on the signup form cannot be registered:\n   - " + failures.join("\n   - "));

  /* Non-vacuous: a word that is not a product is still refused. */
  const who = await arriveFromGoogle();
  const no = await call("/organizations", {
    method: "POST", cookie: who.cookie,
    body: { name: "Nonsense Ltd", work: ["not_a_product"] },
  });
  assert.equal(no.status, 400, "the server accepts any word as a product");
});
