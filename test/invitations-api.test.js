/* ====================================================================== *
 * INVITATIONS, END TO END.
 *
 * An invitation writes a Membership, and a Membership is the only thing that
 * decides what a person can reach. So this is a privilege-escalation surface,
 * and most of what is tested here is what it REFUSES.
 *
 * The one that matters most: a manager must not be able to mint an owner. If
 * they can, every manager is one invitation away from owning the company —
 * invite yourself at a second address, accept, done, and nobody approved it.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_invites";
process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping invitation tests";
let createApp, db, pg, upsertUser, createSession, hashToken;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
    ({ createApp } = await import("../src/server.js"));
    ({ upsertUser } = await import("../src/routes/auth.js"));
    ({ createSession } = await import("../src/auth/sessions.js"));
    ({ hashToken } = await import("../src/domain/invitations.js"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST" : "database unreachable: " + m.slice(0, 90);
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
  try { json = JSON.parse(text); } catch { /* not all responses are JSON */ }
  return { status: res.status, json, text };
}

let seq = 0;
async function person(email) {
  const n = ++seq;
  const user = await upsertUser({
    googleSub: "sub-" + n, email: email || `p${n}@example.com`,
    name: `Person ${n}`, picture: "",
  });
  const { token } = await createSession(user.id, { userAgent: "t", ip: "1" });
  return { user, cookie: `paltas_session=${token}` };
}

/** An owner with a company. */
async function company(name) {
  const owner = await person();
  const r = await call("/organizations", {
    method: "POST", cookie: owner.cookie,
    body: { name, work: ["act_for"] },
  });
  assert.equal(r.status, 201, r.text.slice(0, 160));
  const org = await db.organization.findFirst({ where: { name } });
  return { owner, org };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (skip) console.log("\n  INVITATION TESTS DID NOT RUN.\n  " + skip + "\n");
});

/* ================================================================ *
 * THE JOURNEY.
 * ================================================================ */

test("an owner invites a colleague, who joins with the right role", { skip }, async () => {
  const { owner, org } = await company("Kabole LTD");

  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "Colleague@Example.com", role: "LEASING" },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  assert.ok(made.json.link.includes("token="), "no link came back to send");
  assert.equal(made.json.invitation.email, "colleague@example.com",
    "the address was not normalised — two spellings would be two people");
  assert.equal(made.json.invitation.state, "LIVE");

  const token = new URL(made.json.link).searchParams.get("token");

  /* The link says what it is, without a session. */
  const peek = await call(`/invitations/${token}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.json.company, "Kabole LTD");
  assert.equal(peek.json.role, "LEASING");
  assert.equal(peek.json.why, null);

  /* And the colleague takes it up. */
  const them = await person("colleague@example.com");
  const joined = await call(`/invitations/${token}/accept`, {
    method: "POST", cookie: them.cookie,
  });
  assert.equal(joined.status, 201, joined.text.slice(0, 200));
  assert.equal(joined.json.role, "LEASING");

  const m = await db.membership.findUnique({
    where: { userId_orgId: { userId: them.user.id, orgId: org.id } },
  });
  assert.ok(m, "no membership was written");
  assert.equal(m.role, "LEASING");

  /* The company now answers to them, at their own level. */
  const listings = await call("/listings", { cookie: them.cookie });
  assert.equal(listings.status, 200, "the person who just joined cannot reach the company");
});

test("the token is never stored, and never comes back", { skip }, async () => {
  const { owner, org } = await company("Hash Ltd");
  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "x@example.com", role: "OPERATIONS" },
  });
  const token = new URL(made.json.link).searchParams.get("token");

  const row = await db.invitation.findFirst({ where: { orgId: org.id } });
  assert.notEqual(row.tokenHash, token, "the plaintext token is in the database");
  assert.equal(row.tokenHash, hashToken(token), "the stored hash is not the token's");

  /* And no read path hands it back. */
  const list = await call(`/organizations/${org.id}/invitations`, { cookie: owner.cookie });
  assert.ok(!list.text.includes(token), "listing invitations leaked a live link");
  const peek = await call(`/invitations/${token}`);
  assert.ok(!peek.text.includes(token), "the preview echoed the token back");
});

/* ================================================================ *
 * WHAT IT REFUSES.
 * ================================================================ */

test("a manager cannot mint an owner", { skip }, async () => {
  const { owner, org } = await company("Escalate Ltd");

  /* Make a manager the proper way. */
  const mgr = await person("mgr@example.com");
  const inv = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "mgr@example.com", role: "MANAGER" },
  });
  const t = new URL(inv.json.link).searchParams.get("token");
  await call(`/invitations/${t}/accept`, { method: "POST", cookie: mgr.cookie });

  /* Now the manager tries to hand out OWNER. */
  const bad = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: mgr.cookie,
    body: { email: "mgr.second@example.com", role: "OWNER" },
  });
  assert.equal(bad.status, 403,
    "a manager can create an owner — every manager is one invitation from the company");
  assert.match(bad.json.message, /owner/i);

  /* But may still invite below that. */
  const ok = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: mgr.cookie,
    body: { email: "clerk@example.com", role: "FRONT_DESK" },
  });
  assert.equal(ok.status, 201, ok.text.slice(0, 160));
});

test("a specialist cannot invite at all", { skip }, async () => {
  const { owner, org } = await company("Specialist Ltd");
  const leasing = await person("leasing@example.com");
  const inv = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "leasing@example.com", role: "LEASING" },
  });
  const t = new URL(inv.json.link).searchParams.get("token");
  await call(`/invitations/${t}/accept`, { method: "POST", cookie: leasing.cookie });

  const bad = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: leasing.cookie,
    body: { email: "friend@example.com", role: "LEASING" },
  });
  assert.equal(bad.status, 403, "anyone in the company can bring people in");
});

test("PALTAS's own roles are not a customer's to grant", { skip }, async () => {
  const { owner, org } = await company("Platform Ltd");
  for (const role of ["MARKETING", "COMPLIANCE", "PUBLISHER"]) {
    const r = await call(`/organizations/${org.id}/invitations`, {
      method: "POST", cookie: owner.cookie,
      body: { email: `${role.toLowerCase()}@example.com`, role },
    });
    assert.equal(r.status, 403,
      `a customer granted ${role} — that role reviews every company's promotions`);
  }
  const guest = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "guest@example.com", role: "GUEST" },
  });
  assert.equal(guest.status, 403, "a guest is not staff");
});

test("a link only works for the address it was sent to", { skip }, async () => {
  const { owner, org } = await company("Bound Ltd");
  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "intended@example.com", role: "OPERATIONS" },
  });
  const token = new URL(made.json.link).searchParams.get("token");

  const stranger = await person("stranger@example.com");
  const r = await call(`/invitations/${token}/accept`, {
    method: "POST", cookie: stranger.cookie,
  });
  assert.equal(r.status, 403,
    "a forwarded link let a stranger into the company");
  assert.match(r.json.message, /intended@example\.com/,
    "the refusal must say which address is expected");

  assert.equal(await db.membership.count({ where: { orgId: org.id } }), 1,
    "a membership was written for the wrong person");
});

test("a link works once", { skip }, async () => {
  const { owner, org } = await company("Once Ltd");
  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "once@example.com", role: "FINANCE" },
  });
  const token = new URL(made.json.link).searchParams.get("token");

  const them = await person("once@example.com");
  assert.equal((await call(`/invitations/${token}/accept`, { method: "POST", cookie: them.cookie })).status, 201);

  const again = await call(`/invitations/${token}/accept`, { method: "POST", cookie: them.cookie });
  assert.equal(again.status, 409, "the link is still live after being used");
});

test("a withdrawn link stops working", { skip }, async () => {
  const { owner, org } = await company("Revoke Ltd");
  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "gone@example.com", role: "OPERATIONS" },
  });
  const token = new URL(made.json.link).searchParams.get("token");

  const rev = await call(`/organizations/${org.id}/invitations/${made.json.invitation.id}/revoke`, {
    method: "POST", cookie: owner.cookie,
  });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.invitation.state, "REVOKED");

  const them = await person("gone@example.com");
  const r = await call(`/invitations/${token}/accept`, { method: "POST", cookie: them.cookie });
  assert.equal(r.status, 409, "a withdrawn link still let somebody in");
  assert.match(r.json.message, /withdrawn/i);
});

test("an expired link stops working", { skip }, async () => {
  const { owner, org } = await company("Expiry Ltd");
  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "late@example.com", role: "OPERATIONS" },
  });
  const token = new URL(made.json.link).searchParams.get("token");
  await db.invitation.update({
    where: { id: made.json.invitation.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const them = await person("late@example.com");
  const r = await call(`/invitations/${token}/accept`, { method: "POST", cookie: them.cookie });
  assert.equal(r.status, 409);
  assert.match(r.json.message, /expired/i);
});

test("sending a second invitation retires the first", { skip }, async () => {
  const { owner, org } = await company("Resend Ltd");
  const a = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "dup@example.com", role: "OPERATIONS" },
  });
  const b = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "dup@example.com", role: "FINANCE" },
  });
  assert.equal(b.status, 201);

  const first = new URL(a.json.link).searchParams.get("token");
  const them = await person("dup@example.com");
  const r = await call(`/invitations/${first}/accept`, { method: "POST", cookie: them.cookie });
  assert.equal(r.status, 409,
    "the superseded link still works — the old role could be claimed instead");
});

test("one company cannot invite into another", { skip }, async () => {
  const a = await company("Mine Ltd");
  const b = await company("Theirs Ltd");

  const r = await call(`/organizations/${b.org.id}/invitations`, {
    method: "POST", cookie: a.owner.cookie,
    body: { email: "x@example.com", role: "MANAGER" },
  });
  assert.equal(r.status, 404,
    "'not yours' must be indistinguishable from 'does not exist'");
});

test("a bad or guessed token says nothing", { skip }, async () => {
  for (const t of ["nope", crypto.randomBytes(32).toString("base64url")]) {
    const r = await call(`/invitations/${t}`);
    assert.equal(r.status, 404);
    assert.ok(!/company|role/i.test(r.json.message || ""), "the refusal described something");
  }
});

test("accepting needs a session", { skip }, async () => {
  const { owner, org } = await company("NoSession Ltd");
  const made = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: "s@example.com", role: "OPERATIONS" },
  });
  const token = new URL(made.json.link).searchParams.get("token");
  const r = await call(`/invitations/${token}/accept`, { method: "POST" });
  assert.equal(r.status, 401);
});

test("somebody already in the company is not re-invited", { skip }, async () => {
  const { owner, org } = await company("Already Ltd");
  const me = await db.user.findUnique({ where: { id: owner.user.id } });
  const r = await call(`/organizations/${org.id}/invitations`, {
    method: "POST", cookie: owner.cookie,
    body: { email: me.email, role: "FRONT_DESK" },
  });
  assert.equal(r.status, 409,
    "an invitation could quietly change somebody's role without anyone deciding to");
});

test("an address that is not an address is refused", { skip }, async () => {
  const { owner, org } = await company("Email Ltd");
  for (const email of ["", "nope", "a@b", "a b@c.com"]) {
    const r = await call(`/organizations/${org.id}/invitations`, {
      method: "POST", cookie: owner.cookie, body: { email, role: "OPERATIONS" },
    });
    assert.equal(r.status, 400, `"${email}" was accepted as an email address`);
  }
});

test("joining a second company does not disturb the first", { skip }, async () => {
  const a = await company("First Ltd");
  const b = await company("Second Ltd");

  const inv = await call(`/organizations/${b.org.id}/invitations`, {
    method: "POST", cookie: b.owner.cookie,
    body: { email: (await db.user.findUnique({ where: { id: a.owner.user.id } })).email, role: "FINANCE" },
  });
  const t = new URL(inv.json.link).searchParams.get("token");
  const r = await call(`/invitations/${t}/accept`, { method: "POST", cookie: a.owner.cookie });
  assert.equal(r.status, 201, "a person cannot belong to two companies: " + r.text.slice(0, 160));

  const mine = await db.membership.findMany({ where: { userId: a.owner.user.id } });
  assert.equal(mine.length, 2);
  assert.equal(mine.find((m) => m.orgId === a.org.id).role, "OWNER",
    "joining another company changed their role in their own");
});

/* ====================================================================== *
 * THE LINK HAS TO LAND SOMEWHERE.
 *
 * inviteLink() builds a URL into the frontend. The two repositories deploy
 * separately, so nothing but a test stops the backend from handing out links
 * to a page that was never added — and the failure is invisible from the
 * backend: every API test passes and every invitation 404s in a browser.
 * ====================================================================== */

import { existsSync, readFileSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolvePath(process.cwd(), "..", "paltas-frontend 2");
const JOIN = joinPath(FE, "auth/join.html");
const skipFE = existsSync(JOIN) ? undefined : `no frontend at ${FE}`;

test("the invite link points at a page that exists", { skip: skipFE }, async () => {
  const { inviteLink } = await import("../src/domain/invitations.js");
  const url = new URL(inviteLink("https://paltas.io", "tok123"));

  assert.equal(url.pathname, "/auth/join.html",
    "the link changed shape — check the page was renamed with it");
  assert.equal(url.searchParams.get("token"), "tok123");
  assert.ok(existsSync(joinPath(FE, url.pathname.replace(/^\//, ""))),
    `the backend hands out links to ${url.pathname}, which is not in the frontend`);
});

test("the join page asks the API rather than deciding for itself", { skip: skipFE }, () => {
  const html = readFileSync(JOIN, "utf8");

  assert.match(html, /\/invitations\/" \+ encodeURIComponent\(token\)/,
    "the page does not read the invitation from the API");
  assert.match(html, /\/accept", \{ method: "POST" \}/,
    "the page never accepts the invitation");
  assert.match(html, /URLSearchParams\(location\.search\)\.get\("token"\)/,
    "the page does not read the token from the link");

  /*
   * The token is a credential. It may be sent as a value and must never be
   * written into the page, where a crafted link becomes script on the origin
   * that holds the session cookie.
   */
  assert.ok(!/innerHTML[^\n]*\btoken\b/.test(html),
    "the token is interpolated into markup — that is an XSS through the invite link");
  assert.match(html, /function esc\(/,
    "the page has no escaper for the company name and role it prints");
});

test("the join page shows the server's refusal, not its own", { skip: skipFE }, () => {
  const html = readFileSync(JOIN, "utf8");
  assert.match(html, /e && e\.message/,
    "a failed accept shows an invented message instead of the reason");
  assert.match(html, /found\.why/,
    "an expired or withdrawn invitation is not explained to the person holding it");
});
