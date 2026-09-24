/* ====================================================================== *
 * THE API, END TO END.
 *
 * The real Express app, the real routes, the real Prisma client, a real
 * Postgres. It signs people in by writing a session row directly, because the
 * Google half is already tested in google.test.js and putting a real Google
 * round trip in here would test Google rather than PALTAS.
 *
 * ── WHY THIS MAY SKIP ──────────────────────────────────────────────────
 *
 * It needs a generated Prisma client, and `prisma generate` downloads an
 * engine from binaries.prisma.sh. If that host is unreachable — some CI
 * sandboxes block it — this file skips with a message rather than failing,
 * and everything in rules.test.js, google.test.js, config.test.js and
 * schema.test.js still runs.
 *
 * To run it:
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

/* Reading the migrations off disk is db-help.js's job now, so the filesystem
   and path imports this file used to need have gone with it. */
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* This file's own schema. It DROPs and rebuilds on every run, so it must not
   be a schema any other test file is reading — see db-help.js. Prisma is
   pointed at it HERE, before src/db.js is imported, because the client reads
   DATABASE_URL once when it is constructed. */
const SCHEMA = "test_api";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

/* Decide up front whether this file can run at all. */
let skip = DB ? false : "no TEST_DATABASE_URL — skipping API tests";
let dbHelp = null;
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.js"));
    /* Touch the client so a missing engine fails HERE, with a useful message,
       rather than inside the first test. */
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    /*
     * A SHORT, ACTIONABLE REASON — not 120 characters of a Prisma stack.
     *
     * These, with products-api.test.js, are the only end-to-end tests in
     * the suite — everything else is a rule or a schema check. If they are
     * skipping, the person running `npm test` needs to notice and needs to
     * know what to do, so the reason names the fix rather than the symptom.
     */
    const m = String(e && e.message);
    if (/did not initialize|locate the Query Engine|generate/.test(m)) {
      skip = "RUN `npx prisma generate` FIRST — the end-to-end tests cannot run without it";
    } else {
      /* A configuration failure gets its own explanation, printed in full at
         the end of the run rather than truncated into a skip reason. */
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

/** Sign somebody in the way the Google callback does: a real session row. */
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
      userId: user.id,
      orgId: orgId || null,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { user, cookie: `paltas_session=${token}` };
}

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a redirect has no body */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A company with a product, a role and a subscription, made directly. */
async function makeCompany({ name, email, person, product, role, subscription = "ACTIVE",
                             verification = "COMPLETE" }) {
  const org = await db.organization.create({
    data: {
      name,
      subscription: { create: { status: subscription } },
      verification: { create: { status: verification } },
      workspace: { create: { preferred: product } },
      entitlements: { create: [{ product }] },
    },
  });
  const { user, cookie } = await signIn({ email, name: person, orgId: org.id });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  return { org, user, cookie };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();

  if (dbHelp) {
    console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
  }
  if (skip) {
    console.log(
      "\n" +
      "  ┌────────────────────────────────────────────────────────────────┐\n" +
      "  │  THE END-TO-END API TESTS DID NOT RUN.                         │\n" +
      "  │                                                                │\n" +
      "  │  " + String(skip).slice(0, 60).padEnd(60) + "  │\n" +
      "  │                                                                │\n" +
      "  │  Everything else passed, and everything else is a rule or a    │\n" +
      "  │  schema check. These are the only tests that exercise the      │\n" +
      "  │  real routes against a real database. Do not deploy without    │\n" +
      "  │  seeing them green.                                            │\n" +
      "  └────────────────────────────────────────────────────────────────┘\n"
    );
  }
});

/* ================================================================ */
test("health says whether the database is actually reachable", { skip }, async () => {
  const r = await call("/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("an unsigned-in caller gets 401 from the session, not a crash", { skip }, async () => {
  const r = await call("/auth/session");
  assert.equal(r.status, 401);
  assert.equal(r.json.signedIn, false);
});

test("the session is never cached by anything in between", { skip }, async () => {
  const { cookie } = await signIn({ email: "cache@example.com", name: "C" });
  const r = await call("/auth/session", { cookie });
  assert.match(r.headers.get("cache-control") || "", /no-store/);
});

test("POST /auth/sessions points at Google rather than pretending to work", { skip }, async () => {
  const r = await call("/auth/sessions", { method: "POST", body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "use_google");
  assert.match(r.json.signInUrl, /\/auth\/google$/);
});

test("signing out really ends the session", { skip }, async () => {
  const { cookie } = await signIn({ email: "out@example.com", name: "O" });
  assert.equal((await call("/auth/session", { cookie })).status, 200);

  const bye = await call("/auth/sessions", { method: "DELETE", cookie });
  assert.equal(bye.status, 200);

  /* The same cookie, immediately afterwards. A JWT would still work here. */
  assert.equal((await call("/auth/session", { cookie })).status, 401);
});

/* ================================================================ */
test("the session object is exactly the shape the frontend reads", { skip }, async () => {
  const { cookie } = await makeCompany({
    name: "Marina Vista Hotels", email: "gm@marina.test", person: "Layla Hassan",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });
  const r = await call("/auth/session", { cookie });
  assert.equal(r.status, 200);
  const s = r.json;

  for (const k of ["v", "signedIn", "user", "organization", "subscription",
                   "entitlements", "verification", "memberships", "workspace"]) {
    assert.ok(k in s, `the session is missing ${k}`);
  }
  assert.deepEqual(Object.keys(s.user).sort(), ["email", "id", "name", "phone"]);
  assert.equal(s.organization.name, "Marina Vista Hotels");
  assert.equal(s.entitlements[0].product, "HOTEL_MANAGEMENT");
  assert.equal(s.memberships[0].role, "OWNER");
  assert.equal(s.subscription.status, "ACTIVE");
  assert.equal(s.verification.status, "COMPLETE");
});

test("the session carries the shape version the frontend gates on", { skip }, async () => {
  /*
   * `v` LOOKS INERT AND IS THE OPPOSITE.
   *
   * assets/console.js:
   *
   *     var VERSION = 2;
   *     function read() { ... return o.v === VERSION ? o : migrate(o); }
   *
   * `migrate()` upgrades a VERSION-1 session, which was a flat object of
   * `{ email, who, caps, sub, plan }`. A response without `v` is therefore
   * not read as "one field short" — it is read as an OLD session and handed
   * to a migrator looking for keys this service has never sent. It finds
   * none, and returns a blank.
   *
   * Running the frontend's own Session module against this service's real
   * response, with `v` absent: signedIn stayed true and the company name,
   * the email, both entitlements and the membership all came back empty.
   * `resolve()` then answered NOT_ENTITLED and sent the person to
   * index.html — signed in, and locked out of every console they own.
   *
   * `contract/backend.md` §1 never mentioned the field, which is why it was
   * missing: the contract was incomplete and this service implemented the
   * contract. So the test is here rather than in contract.test.js, which can
   * only ever check what the document already says.
   */
  const { cookie } = await makeCompany({
    name: "Shape Version Ltd", email: "v@shape.test", person: "V",
    product: "PROPERTY_MANAGEMENT", role: "OWNER",
  });
  const r = await call("/auth/session", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.v, 2,
    "the session must carry v:2 — without it the frontend migrates it to a blank session");

  /* And on the other branch too: somebody who has signed in but has no
     company still has to be able to reach the workspace picker. */
  const { cookie: alone } = await signIn({ email: "alone@shape.test", name: "Alone" });
  const r2 = await call("/auth/session", { cookie: alone });
  assert.equal(r2.json.v, 2, "a session with no organization needs the version too");
});

test("a person with no company gets a session and no organization", { skip }, async () => {
  const { cookie } = await signIn({ email: "nobody@example.com", name: "Nobody" });
  const r = await call("/auth/session", { cookie });
  assert.equal(r.status, 200, "a signed-in person with no company should still have a session");
  assert.equal(r.json.organization, null);
  assert.deepEqual(r.json.memberships, []);
});

/* ================================================================ */
test("creating a company makes every row in one go", { skip }, async () => {
  const { cookie } = await signIn({ email: "founder@example.com", name: "A Founder" });
  const r = await call("/organizations", {
    method: "POST", cookie,
    body: { name: "Akram Hotel", country: "ae", city: "Dubai", work: ["hotel"] },
  });

  assert.equal(r.status, 201);
  assert.equal(r.json.organization.name, "Akram Hotel");
  assert.equal(r.json.entitlements[0].product, "HOTEL_MANAGEMENT");
  assert.equal(r.json.memberships[0].role, "OWNER");
  /* A new company is TRIALING. ACTIVE means somebody paid. */
  assert.equal(r.json.subscription.status, "TRIALING");
  assert.equal(r.json.verification.status, "NOT_STARTED");
  assert.equal(r.json.workspace.preferred, "HOTEL_MANAGEMENT");
});

test("the six lines of work map to products, and two lines can mean one product", { skip }, async () => {
  const { cookie } = await signIn({ email: "dev@example.com", name: "D" });
  const r = await call("/organizations", {
    method: "POST", cookie,
    body: { name: "Alma Real Estate", work: ["develop", "own_let", "manage"] },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.entitlements.length, 1, "three property lines should be one product");
  assert.equal(r.json.entitlements[0].product, "PROPERTY_MANAGEMENT");
});

test("nobody can grant themselves the PALTAS staff console", { skip }, async () => {
  const { cookie } = await signIn({ email: "chancer@example.com", name: "C" });
  const r = await call("/organizations", {
    method: "POST", cookie,
    body: { name: "Totally Legitimate Ltd", products: ["PLATFORM"] },
  });
  assert.equal(r.status, 403, "PLATFORM was grantable at signup");
  assert.match(r.json.message, /granted by PALTAS/i);
});

test("a company with no stated work is refused, and told what to send", { skip }, async () => {
  const { cookie } = await signIn({ email: "empty@example.com", name: "E" });
  const r = await call("/organizations", { method: "POST", cookie, body: { name: "X" } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /Say what the company does/i);
});

/* ================================================================ */
test("a customer writes a promotion; it is a DRAFT whatever they send", { skip }, async () => {
  const { cookie } = await makeCompany({
    name: "Coast Hotels", email: "coast@example.com", person: "Wanjiru Kamau",
    product: "HOTEL_MANAGEMENT", role: "PROMO_CONTRIBUTOR",
  });

  const r = await call("/promotions", {
    method: "POST", cookie,
    body: { title: "Coast weekend", headline: "Two nights on the coast", status: "PUBLISHED" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "DRAFT", "a request set its own status");
  assert.match(r.json.id, /^PR-\d{4}$/);
  assert.equal(r.json.createdBy, "Wanjiru Kamau");
  assert.equal(r.json.reviewHistory.length, 1);
});

test("an incomplete promotion cannot be submitted, and is told which parts", { skip }, async () => {
  const { cookie } = await makeCompany({
    name: "Half Done Ltd", email: "half@example.com", person: "H",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });
  const made = await call("/promotions", {
    method: "POST", cookie, body: { headline: "Something", title: "t" },
  });
  const r = await call(`/promotions/${made.json.id}/submit`, { method: "POST", cookie });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /not ready to submit/i);
  assert.ok(Array.isArray(r.json.details));
});

test("a customer cannot publish their own promotion by any route", { skip }, async () => {
  const { cookie } = await makeCompany({
    name: "Impatient Ltd", email: "imp@example.com", person: "I",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });
  const made = await call("/promotions", { method: "POST", cookie, body: complete() });

  for (const path of ["publish", "schedule", "review/approve"]) {
    const r = await call(`/promotions/${made.json.id}/${path}`, { method: "POST", cookie });
    assert.equal(r.status, 403, `a customer could ${path}`);
  }
});

test("one company cannot see another's promotions", { skip }, async () => {
  const a = await makeCompany({
    name: "Company A", email: "a@example.com", person: "A",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });
  const b = await makeCompany({
    name: "Company B", email: "b@example.com", person: "B",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });

  const mine = await call("/promotions", { method: "POST", cookie: a.cookie, body: complete() });

  const list = await call("/promotions", { cookie: b.cookie });
  assert.equal(list.json.promotions.length, 0, "another company's promotion was listed");

  /* And asking for it by reference answers "does not exist", not "forbidden" —
     a 403 would confirm the reference is real. */
  const direct = await call(`/promotions/${mine.json.id}`, { cookie: b.cookie });
  assert.equal(direct.status, 404);

  /* And scope=all is refused rather than quietly narrowed. */
  const all = await call("/promotions?scope=all", { cookie: b.cookie });
  assert.equal(all.status, 403);
});

/* ================================================================ */
test("the whole workflow, by the three people it takes", { skip }, async () => {
  const hotel = await makeCompany({
    name: "Marina Vista", email: "hotel@example.com", person: "Layla Hassan",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });
  const paltas = await db.organization.create({
    data: {
      name: "PALTAS",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PLATFORM" } },
      entitlements: { create: [{ product: "PLATFORM" }] },
    },
  });
  const marketing = await signIn({ email: "grace@paltas.io", name: "Grace Wambui", orgId: paltas.id });
  await db.membership.create({
    data: { userId: marketing.user.id, orgId: paltas.id, role: "MARKETING" } });
  const publisher = await signIn({ email: "ahmed@paltas.io", name: "Ahmed Akboole", orgId: paltas.id });
  await db.membership.create({
    data: { userId: publisher.user.id, orgId: paltas.id, role: "PUBLISHER" } });

  /* 1 — the customer writes and submits. */
  const made = await call("/promotions", { method: "POST", cookie: hotel.cookie, body: complete() });
  const ref = made.json.id;
  const sub = await call(`/promotions/${ref}/submit`, { method: "POST", cookie: hotel.cookie });
  assert.equal(sub.json.status, "SUBMITTED");

  /* Not public. */
  assert.equal(await publicCount(), 0);

  /* 2 — marketing cannot publish, and says so. */
  const tryPublish = await call(`/promotions/${ref}/publish`,
    { method: "POST", cookie: marketing.cookie });
  assert.equal(tryPublish.status, 403, "MARKETING published something");
  assert.match(tryPublish.json.message, /publisher/i);

  /* 3 — sending it back needs a real message. */
  const empty = await call(`/promotions/${ref}/review/changes`,
    { method: "POST", cookie: marketing.cookie, body: { message: "no" } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.message, /Say what needs to change/i);

  const back = await call(`/promotions/${ref}/review/changes`, {
    method: "POST", cookie: marketing.cookie,
    body: { message: "Please add the vehicle type and the number of bags the price covers." },
  });
  assert.equal(back.json.status, "CHANGES_REQUESTED");
  const last = back.json.reviewHistory.at(-1);
  assert.equal(last.by, "Grace Wambui");
  assert.match(last.why, /number of bags/);

  /* 4 — the customer fixes it. Coming back is a RESUBMISSION. */
  await call(`/promotions/${ref}`, {
    method: "PATCH", cookie: hotel.cookie,
    body: { description: "Two nights on the coast, breakfast for two included." },
  });
  const again = await call(`/promotions/${ref}/submit`, { method: "POST", cookie: hotel.cookie });
  assert.equal(again.json.status, "RESUBMITTED");

  /* 5 — marketing approves. Still not public. */
  const approved = await call(`/promotions/${ref}/review/approve`,
    { method: "POST", cookie: marketing.cookie });
  assert.equal(approved.json.status, "MARKETING_APPROVED");
  assert.equal(await publicCount(), 0, "marketing approval put something on the homepage");

  /* 6 — the publisher publishes. NOW it is public. */
  const live = await call(`/promotions/${ref}/publish`, { method: "POST", cookie: publisher.cookie });
  assert.equal(live.json.status, "PUBLISHED");
  assert.equal(await publicCount(), 1);

  /* 7 — and pausing takes it straight back off. */
  const paused = await call(`/promotions/${ref}/pause`, {
    method: "POST", cookie: publisher.cookie,
    body: { message: "Paused at the customer's request while they change the dates." },
  });
  assert.equal(paused.json.status, "PAUSED");
  assert.equal(await publicCount(), 0);

  /* Nothing was deleted. */
  const still = await call(`/promotions/${ref}`, { cookie: hotel.cookie });
  assert.equal(still.status, 200);
  assert.ok(still.json.reviewHistory.length >= 6, "the history was not kept in full");
});

test("scheduling is not publishing, even inside the dates", { skip }, async () => {
  const paltas = await db.organization.findFirst({ where: { name: "PALTAS" } });
  const publisher = await signIn({ email: "ahmed@paltas.io", name: "Ahmed Akboole", orgId: paltas.id });

  const hotel = await makeCompany({
    name: "Scheduler Ltd", email: "sched@example.com", person: "S",
    product: "HOTEL_MANAGEMENT", role: "OWNER",
  });
  const made = await call("/promotions", { method: "POST", cookie: hotel.cookie, body: complete() });
  const ref = made.json.id;
  await call(`/promotions/${ref}/submit`, { method: "POST", cookie: hotel.cookie });

  const marketing = await db.user.findUnique({ where: { email: "grace@paltas.io" } });
  assert.ok(marketing);
  const g = await signIn({ email: "grace@paltas.io", name: "Grace Wambui", orgId: paltas.id });
  await call(`/promotions/${ref}/review/approve`, { method: "POST", cookie: g.cookie });

  const before = await publicCount();
  const s = await call(`/promotions/${ref}/schedule`, { method: "POST", cookie: publisher.cookie });
  assert.equal(s.json.status, "SCHEDULED");
  assert.equal(await publicCount(), before, "a SCHEDULED promotion reached the homepage");
});

test("the public feed needs no session and leaks nothing", { skip }, async () => {
  const r = await call("/promotions/public");
  assert.equal(r.status, 200, "the homepage needed a session to read promotions");
  assert.ok(Array.isArray(r.json.promotions));
  for (const p of r.json.promotions) {
    assert.equal(p.status, "PUBLISHED");
    assert.ok(!("createdBy" in p), "the public feed named an author");
    assert.ok(!("reviewHistory" in p), "the public feed carried a review history");
  }
  assert.match(r.headers.get("cache-control") || "", /public/);
});

/* ------------------------------------------------------------ helpers */

async function publicCount() {
  const r = await call("/promotions/public");
  return r.json.promotions.length;
}

function complete() {
  const year = new Date().getFullYear();
  return {
    title: "Coast weekend",
    headline: "Two nights on the coast",
    subtitle: "With breakfast.",
    description: "Two nights on the coast with breakfast for two included.",
    type: "destination", offer: "Breakfast included", destination: "Diani",
    startDate: `${year - 1}-01-01`, endDate: `${year + 1}-12-31`,
    ctaLabel: "See the offer", ctaDestination: "index.html?go=stay",
    terms: "Selected room types, subject to availability. Direct bookings only.",
    placement: "discover", audience: "travellers", language: "en", priority: 60,
  };
}

test("starting a sign-in hands the browser its pending state, and the callback spends it", { skip }, async () => {
  /*
   * THE BUG THIS EXISTS FOR — reported from production, before onboarding.
   *
   * "Log in with Google, pick my email, and I come back where I started."
   *
   * The PKCE verifier was held in a `new Map()` in this process. Render stops
   * an idle instance; every deploy empties the Map; a second instance would
   * break it outright. So a person who pressed sign in, spent twenty seconds on
   * Google's account chooser and came back to a process started in between had
   * their state looked up in a Map that no longer held it — and was redirected
   * to the sign-in page with nothing to act on. It reads as "this site will not
   * let me in" rather than "try again".
   *
   * It travels with the browser now, so none of those three things can lose it.
   */
  const r = await fetch(`${base}/auth/google`, { redirect: "manual" });
  assert.equal(r.status, 302, "sign-in does not redirect to Google");

  const setCookie = r.headers.getSetCookie
    ? r.headers.getSetCookie().join("\n")
    : (r.headers.get("set-cookie") || "");
  assert.match(setCookie, /paltas_oauth=/,
    "the browser is given nothing to bring back, so the callback cannot complete");

  /*
   * SameSite=Lax is load-bearing, not a default worth leaving to chance.
   * Google's callback is a top-level GET navigation, which Lax permits;
   * "Strict" would drop the cookie on exactly the request that needs it, and
   * the sign-in would fail the same way it did before.
   */
  assert.match(setCookie, /SameSite=Lax/i, "the cookie will not survive Google's redirect back");
  assert.match(setCookie, /HttpOnly/i, "script can read the pending sign-in");

  /* And the value is signed, not a readable payload anybody could mint. */
  const value = (setCookie.match(/paltas_oauth=([^;]+)/) || [])[1];
  assert.ok(value && value.includes("."), "the cookie carries no signature");

  /*
   * THE CALLBACK CLEARS IT BEFORE USING IT, and that is what makes it single
   * use — the property the old Map got from deleting its entry as it read it.
   * A replayed callback then arrives with nothing.
   */
  const state = new URL(r.headers.get("location")).searchParams.get("state");
  const cb = await fetch(
    `${base}/auth/google/callback?code=irrelevant&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `paltas_oauth=${value}` }, redirect: "manual" });

  const cleared = cb.headers.getSetCookie
    ? cb.headers.getSetCookie().join("\n")
    : (cb.headers.get("set-cookie") || "");
  assert.match(cleared, /paltas_oauth=;|paltas_oauth=(?=;|$)/,
    "the callback does not clear the pending cookie, so it could be replayed");

  /* The code is nonsense, so this cannot succeed — it must land a person on a
     page with words rather than on a stack trace. */
  assert.equal(cb.status, 302, "a failed sign-in does not redirect a human anywhere");
  assert.match(cb.headers.get("location") || "", /login\.html\?signin=/,
    "a failed sign-in does not land on the sign-in page");
});

/* ======================================================================
 * REGISTRATION — the function that creates every PALTAS account.
 *
 * It had no test. Sign-in was covered end to end; what happens to the PERSON
 * on the other side of it was not, which is the half a client experiences.
 * ====================================================================== */

const IDENTITY = {
  googleSub: "sub_new_person_001",
  email: "new.person@example.com",
  name: "New Person",
  picture: "https://lh3.example/pic.jpg",
};

test("a first sign-in creates the account", { skip }, async () => {
  const { upsertUser } = await import("../src/routes/auth.js");

  const before = await db.user.findUnique({ where: { email: IDENTITY.email } });
  assert.equal(before, null, "the fixture is dirty — this person already exists");

  const user = await upsertUser(IDENTITY);
  assert.ok(user.id, "no account was created");
  assert.equal(user.email, IDENTITY.email);
  assert.equal(user.googleSub, IDENTITY.googleSub);
  assert.equal(user.name, "New Person");

  /* A registration is a row somebody can be looked up by later, not an object
     returned once. */
  const stored = await db.user.findUnique({ where: { googleSub: IDENTITY.googleSub } });
  assert.ok(stored, "the account was returned but not stored");
  assert.equal(stored.id, user.id);
});

test("signing in again returns the same person, not a second one", { skip }, async () => {
  const { upsertUser } = await import("../src/routes/auth.js");

  const first = await upsertUser(IDENTITY);
  const second = await upsertUser(IDENTITY);
  assert.equal(second.id, first.id, "a second sign-in created a SECOND account");

  const all = await db.user.findMany({ where: { email: IDENTITY.email } });
  assert.equal(all.length, 1, `${all.length} accounts exist for one person`);
});

test("a returning person's name and picture are refreshed from Google", { skip }, async () => {
  const { upsertUser } = await import("../src/routes/auth.js");
  await upsertUser(IDENTITY);

  const updated = await upsertUser({ ...IDENTITY, name: "New Name", picture: "https://lh3.example/2.jpg" });
  assert.equal(updated.name, "New Name", "a changed name is not picked up");
  assert.equal(updated.picture, "https://lh3.example/2.jpg");

  /* But Google sending nothing must not erase what is on file. */
  const blanked = await upsertUser({ ...IDENTITY, name: "", picture: "" });
  assert.equal(blanked.name, "New Name", "an empty name from Google wiped the stored one");
});

test("an address already on file is claimed by its Google account", { skip }, async () => {
  const { upsertUser } = await import("../src/routes/auth.js");

  /*
   * Somebody invited to a company before they ever signed in: a User row with
   * an email and NO googleSub. Their first sign-in must attach to that row, or
   * they arrive as a stranger with none of the access they were given.
   */
  const invited = await db.user.create({
    data: { email: "invited@example.com", name: "Invited Person" },
  });
  assert.equal(invited.googleSub, null);

  const claimed = await upsertUser({
    googleSub: "sub_invited_001", email: "invited@example.com",
    name: "Invited From Google", picture: "",
  });
  assert.equal(claimed.id, invited.id, "the invitation was not claimed — a duplicate person was made");
  assert.equal(claimed.googleSub, "sub_invited_001");
  /* The name already on file wins: somebody chose it deliberately. */
  assert.equal(claimed.name, "Invited Person", "a stored name was overwritten by Google's");
});

test("an address claimed by a DIFFERENT Google account is refused", { skip }, async () => {
  const { upsertUser } = await import("../src/routes/auth.js");

  /*
   * THE REFUSAL THAT MATTERS MOST, AND IT HAD NO TEST.
   *
   * Two Google accounts presenting one address. Guessing means handing one
   * person another's company — every membership, every booking, every invoice.
   * It refuses and says which account to use instead.
   */
  await upsertUser({ googleSub: "sub_owner_A", email: "shared@example.com", name: "Owner A", picture: "" });

  await assert.rejects(
    () => upsertUser({ googleSub: "sub_intruder_B", email: "shared@example.com", name: "B", picture: "" }),
    (e) => {
      assert.equal(e.status, 403, `refused with ${e.status}, expected 403`);
      assert.match(e.message, /already attached to a different Google account/);
      return true;
    },
    "a second Google account took over an existing address");

  /* And the original is untouched. */
  const owner = await db.user.findUnique({ where: { email: "shared@example.com" } });
  assert.equal(owner.googleSub, "sub_owner_A", "the intruder overwrote the owner's account");
  assert.equal(owner.name, "Owner A");
});

test("a new account can sign in and reach its own data", { skip }, async () => {
  /*
   * Registration is only complete if the person can then USE the site. This
   * walks it: create the account the way the Google callback does, mint the
   * session the same way, and call the endpoints a new guest would hit.
   */
  const { upsertUser } = await import("../src/routes/auth.js");
  const user = await upsertUser({
    googleSub: "sub_walks_001", email: "walks@example.com", name: "Walker", picture: "",
  });

  const { createSession } = await import("../src/auth/sessions.js");
  const { token } = await createSession(user.id, { userAgent: "test", ip: "127.0.0.1" });
  const cookie = `paltas_session=${token}`;

  const who = await fetch(`${base}/auth/session`, { headers: { cookie } });
  assert.equal(who.status, 200, "a freshly registered person cannot read their own session");
  const body = await who.json();
  assert.equal(body.user.email, "walks@example.com");

  /* A guest with no company is a valid, complete state — not a broken one. */
  assert.ok(!body.organization || body.organization === null,
    "a person with no company was given one");

  /* And the endpoints a new guest uses answer them rather than refusing. */
  const mine = await fetch(`${base}/marketplace/stays`, { headers: { cookie } });
  assert.equal(mine.status, 200, "a registered person cannot list their own bookings");
  const stays = await mine.json();
  assert.ok(Array.isArray(stays.stays || stays.bookings || []),
    "the bookings endpoint did not return a list");
});
