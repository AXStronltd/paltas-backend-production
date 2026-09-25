/* ====================================================================== *
 * SENT, AND DELIVERED, AND THE DIFFERENCE BETWEEN THEM.
 *
 * A property business tells people things, and whether those things arrived
 * is the whole record. The failure these guard against is the comfortable
 * one: a Send button that writes SENT with no provider connected, producing a
 * screen full of messages nobody ever received and a company that finds out
 * when a buyer says they never got the offer.
 *
 * So most of what is below is about what the service is ALLOWED TO CLAIM.
 * With nothing connected it may say a message is queued and no more. With a
 * provider it may say the provider took it and no more. Only the provider's
 * own callback may say it arrived — and that callback is the most attackable
 * surface in the service, so it is tested as one.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { present } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_comms";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping communications tests";
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
      skip = "RUN `npx prisma generate` FIRST";
    } else {
      const help = explain(e, DB);
      if (help) { skip = "database configuration — see below"; dbHelp = help; }
      else skip = "database unreachable: " + m.slice(0, 90);
    }
  }
}

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

let seq = 0;
async function company() {
  const n = ++seq;
  const email = `stmt${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Person ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  const session = await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: null, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const cookie = `paltas_session=${token}`;
  /* Through the real signup, so the chart is seeded the way it is in life. */
  const made = await call("/organizations", {
    method: "POST", cookie, body: { name: `Statements Co ${n}`, work: ["property"], country: "ke" },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  const me = present(await db.session.findFirst({
    where: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") },
    select: { orgId: true, userId: true },
  }), "no me — the row this test made is gone");
  /* The name matters: "assigned to me" matches the account OR the name, because
     plenty of people are given work before they ever sign in. */
  return { cookie, session, orgId: me.orgId, userId: me.userId, name: `Person ${n}` };
}

/*
 * THE REAL fetch, HELD BEFORE ANYTHING REPLACES IT.
 *
 * Several tests below stand a fake mail provider up by swapping
 * globalThis.fetch. Without this line those tests would also intercept the
 * requests this helper makes to the service under test — every call would be
 * answered by the fake provider, and the tests would pass while proving
 * nothing at all.
 */
const realFetch = globalThis.fetch;

async function call(
  path: string, { method = "GET", body, cookie, headers }: CallOptions = {},
): Promise<Reply> {
  const res = await realFetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Wire = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const n = (v: unknown): number => Number(v);

/**
 * A property with a unit, a tenant on a lease, an invoice issued against that
 * lease, and the rent paid. This is the shape every per-entity statement
 * needs, and it is the shape that proves the posting bridge stamps its
 * dimensions.
 */
async function tenancy(
  cookie: string, { rent = 8_500_000, pay = true }: { rent?: number; pay?: boolean } = {},
) {
  /* A unit reference is unique per company, so a second tenancy in the same
     company needs its own — otherwise the create 409s and the failure surfaces
     three lines later as "cannot read properties of undefined". */
  const k = ++seq;
  const site = await call("/sites", { method: "POST", cookie, body: { name: `Kilimani Suites ${k}`, city: "Nairobi" } });
  assert.equal(site.status, 201, site.text.slice(0, 160));
  const siteId = site.json.site.id;
  const unit = await call("/units", { method: "POST", cookie, body: { ref: `A-${200 + k}`, siteId } });
  assert.equal(unit.status, 201, unit.text.slice(0, 160));
  const unitId = unit.json.unit.id;
  const tenant = await call("/parties", { method: "POST", cookie, body: { name: `Tenant ${k}`, kind: "TENANT" } });
  const partyId = tenant.json.party.id;
  const lease = await call("/leases", { method: "POST", cookie, body: { unitId, tenantId: partyId, rent } });
  const leaseId = lease.json.lease.id;

  const inv = await call("/invoices", { method: "POST", cookie, body: { currency: "KES", partyId, leaseId } });
  const invoiceId = inv.json.invoice.id;
  await call(`/invoices/${invoiceId}/lines`, {
    method: "POST", cookie, body: { detail: "March rent", quantity: 1, unitPrice: rent, taxBps: 0 },
  });
  const sent = await call(`/invoices/${invoiceId}`, {
    method: "PATCH", cookie, body: { status: "SENT", issuedOn: "2026-03-01" },
  });
  assert.match(sent.json.booking.booked || "", /^JE-\d{4}$/,
    `the invoice was not booked: ${sent.json.booking.why}`);

  let paid = null;
  if (pay) {
    paid = await call("/payments", {
      method: "POST", cookie,
      body: { invoiceId, amount: rent, method: "MPESA", reference: `R-${++seq}`, receivedAt: "2026-03-05" },
    });
    assert.match(paid.json.booking.booked || "", /^JE-\d{4}$/,
      `the payment was not booked: ${paid.json.booking.why}`);
  }
  return { siteId, unitId, partyId, leaseId, invoiceId, paid };
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});


/** The chart, seeded, as a code → id map. */
async function chartOf(cookie: string) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries(json.accounts.map((a: Wire) => [a.code, a.id]));
}

/** The same company, seen by somebody with a narrower role. */
async function asRole(
  owner: Awaited<ReturnType<typeof company>>,
  role: import("@prisma/client").$Enums.Role,
) {
  const n = ++seq;
  const orgId = owner.orgId;
  const email = `role${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Role ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: String(orgId), expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.membership.create({ data: { userId: user.id, orgId: String(orgId), role } });
  return `paltas_session=${token}`;
}



/* ====================================================================== *
 * WITH NOTHING CONNECTED
 * ====================================================================== */

async function dispatch(cookie: string, body?: Record<string, unknown>) {
  const d = await call("/dispatches", { method: "POST", cookie,
    body: { toName: "Grace Wanjiru", toAddress: "grace@example.com",
            subject: "Your offer", body: "Please find attached.", ...(body || {}) } });
  assert.equal(d.status, 201, d.text.slice(0, 220));
  return d.json.dispatch;
}

test("a message with nowhere to go is queued, and says so", { skip }, async () => {
  /*
   * THE ONE THAT MATTERS. No provider is configured in these tests, which is
   * also the state of a brand new company, and the button must not lie about
   * it.
   */
  const { cookie } = await company();
  const m = await dispatch(cookie);
  assert.match(m.ref, /^MSG-\d{4}$/);
  assert.equal(m.status, "DRAFT");

  const sent = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.dispatch.status, "QUEUED",
    "a message was recorded as sent with nothing to send it");
  assert.equal(sent.json.outcome, "unconfigured");
  assert.equal(sent.json.dispatch.deliveredAt, null);
  assert.equal(sent.json.dispatch.submittedAt, null,
    "a message nothing accepted was stamped as submitted");
  assert.match(sent.json.said, /nothing has been sent/i);
  /* And it does not use the word. */
  assert.ok(!/\bsent\b(?!.*nothing)/i.test(sent.json.said.replace(/has been sent/i, "")),
    `the sentence claims a send: "${sent.json.said}"`);
});

test("the queue says what is missing rather than that it is broken", { skip }, async () => {
  const { cookie } = await company();
  const out = await call("/dispatches/outbox?view=queued", { cookie });
  assert.equal(out.status, 200);
  assert.equal(out.json.providers.EMAIL.configured, false);
  /* The variable names to set, said out loud, so nobody has to read a file
     to find out why nothing is going. */
  assert.ok(out.json.providers.EMAIL.needs.flat().includes("MAIL_FROM"));
  /* In-app is carried by PALTAS itself, so it is always available. */
  assert.equal(out.json.providers.IN_APP.configured, true);
});

test("a message shown inside PALTAS really has arrived", { skip }, async () => {
  /* The single channel this service may call delivered, because it IS the
     carrier: the message is a row in its own database. */
  const { cookie } = await company();
  const m = await dispatch(cookie, { channel: "IN_APP", toAddress: "grace@example.com" });
  const sent = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
  assert.equal(sent.json.dispatch.status, "DELIVERED");
  assert.ok(sent.json.dispatch.deliveredAt);
});

test("a state cannot be set by editing the row", { skip }, async () => {
  const { cookie } = await company();
  const m = await dispatch(cookie);
  for (const body of [{ status: "DELIVERED" }, { deliveredAt: new Date().toISOString() },
                      { provider: "resend" }, { providerRef: "made-up" }]) {
    const res = await call(`/dispatches/${m.id}`, { method: "PATCH", cookie, body });
    assert.equal(res.status, 400,
      `PATCH ${JSON.stringify(body)} was accepted — the outbox is a claim, not a record`);
  }
  const back = await call(`/dispatches/${m.id}`, { cookie });
  assert.equal(back.json.dispatch.status, "DRAFT");
  assert.equal(back.json.dispatch.deliveredAt, null);
});

test("every state says in words what it means", { skip }, async () => {
  const { cookie } = await company();
  const m = await dispatch(cookie);
  const back = await call(`/dispatches/${m.id}`, { cookie });
  assert.match(back.json.dispatch.means, /not released/i);
  assert.equal(back.json.dispatch.canSend, true);

  await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
  const queued = await call(`/dispatches/${m.id}`, { cookie });
  assert.match(queued.json.dispatch.means, /Nothing has been sent/i,
    "QUEUED does not say that nothing has been sent");
});

test("a message is never sent twice", { skip }, async () => {
  const { cookie } = await company();
  const m = await dispatch(cookie, { channel: "IN_APP" });
  await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
  const again = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
  assert.equal(again.status, 409, "the same message went twice");
  assert.match(again.json.message, /twice/i);
});

test("cancelling is not failing", { skip }, async () => {
  const { cookie } = await company();
  const m = await dispatch(cookie);
  const res = await call(`/dispatches/${m.id}/cancel`, { method: "POST", cookie,
    body: { reason: "Sent by post instead." } });
  assert.equal(res.status, 200);
  assert.equal(res.json.dispatch.status, "CANCELLED");

  const back = await call(`/dispatches/${m.id}`, { cookie });
  const states = back.json.dispatch.events.map((e: Wire) => e.status);
  assert.ok(!states.includes("FAILED"),
    "a cancelled message is recorded as one that failed — nobody tried");
  assert.deepEqual(states, ["CANCELLED"]);
  assert.equal(back.json.dispatch.events[0].detail, "Sent by post instead.");
});

/* ====================================================================== *
 * WITH A PROVIDER
 * ====================================================================== */

/**
 * A provider that answers, without leaving this machine.
 *
 * The point is not to test Resend. It is to prove that when something DOES
 * accept a message, this service records SUBMITTED and the provider's own id
 * — and still does not say it arrived.
 */
function withFakeProvider(reply: Wire) {
  const before = globalThis.fetch;
  const seen: { url: string; body: Wire }[] = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return reply();
  };
  process.env.RESEND_API_KEY = "test-key";
  process.env.MAIL_FROM = "noreply@example.com";
  return {
    seen,
    done() {
      globalThis.fetch = before;
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_FROM;
    },
  };
}

const ok = (body: Wire) => () => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" } });
const no = (status: Wire, body: Wire) => () => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" } });

test("a provider accepting a message is not the same as it arriving", { skip }, async () => {
  const fake = withFakeProvider(ok({ id: "re_abc123" }));
  try {
    const { cookie } = await company();
    const m = await dispatch(cookie);
    const sent = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });

    assert.equal(sent.json.dispatch.status, "SUBMITTED");
    assert.equal(sent.json.dispatch.provider, "resend");
    assert.equal(sent.json.dispatch.providerRef, "re_abc123",
      "the provider's own id was not kept — nobody could trace this message");
    assert.ok(sent.json.dispatch.submittedAt);
    assert.equal(sent.json.dispatch.deliveredAt, null,
      "accepting a message was recorded as delivering it");
    assert.match(sent.json.said, /accepted/i);
    assert.doesNotMatch(sent.json.said, /\bdelivered\b/i);

    /* It really went to the provider, with the right body. */
    assert.equal(fake.seen.length, 1);
    assert.match(fake.seen[0].url, /resend\.com/);
    assert.deepEqual(fake.seen[0].body.to, ["grace@example.com"]);
    assert.equal(fake.seen[0].body.subject, "Your offer");
  } finally { fake.done(); }
});

test("a provider refusing keeps its own words", { skip }, async () => {
  const fake = withFakeProvider(no(422, { message: "The domain example.com is not verified." }));
  try {
    const { cookie } = await company();
    const m = await dispatch(cookie);
    const sent = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });

    assert.equal(sent.json.dispatch.status, "FAILED");
    assert.equal(sent.json.dispatch.error, "The domain example.com is not verified.",
      "the provider's reason was replaced with a guess of our own");
    assert.ok(sent.json.dispatch.failedAt);
  } finally { fake.done(); }

  /* And a failure is not the end of it: the message is still there, still
     addressed, and may be sent again once the domain IS verified. */
  const fake2 = withFakeProvider(ok({ id: "re_after_fixing" }));
  try {
    const { cookie } = await company();
    const m = await dispatch(cookie);
    const failed = await withRefusal(cookie, m.id);
    assert.equal(failed, "FAILED");
    const retried = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
    assert.equal(retried.json.dispatch.status, "SUBMITTED");
    assert.equal(retried.json.dispatch.error, "",
      "a message that went on the second try still reads as failed");
  } finally { fake2.done(); }
});

/** One send that the provider refuses, whatever is standing in for it. */
async function withRefusal(cookie: Wire, id: Wire) {
  const before = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "Temporarily unavailable" }), { status: 503 });
  try {
    const res = await call(`/dispatches/${id}/send`, { method: "POST", cookie });
    return res.json.dispatch.status;
  } finally { globalThis.fetch = before; }
}

/* ====================================================================== *
 * A CAMPAIGN
 * ====================================================================== */

async function buyers(cookie: Wire, howMany: Wire, withEmail = true) {
  const made = [];
  for (let i = 0; i < howMany; i += 1) {
    const p = await call("/parties", { method: "POST", cookie,
      body: { name: `Buyer ${++seq}`, kind: "BUYER",
              ...(withEmail ? { email: `b${seq}@example.com` } : {}) } });
    assert.equal(p.status, 201, p.text.slice(0, 200));
    made.push(p.json.party);
  }
  return made;
}

async function campaign(cookie: Wire, body?: Wire) {
  const c = await call("/campaigns", { method: "POST", cookie,
    body: { name: "Quarterly update", subject: "Progress at Riverside",
            body: "The third floor is poured.", ...(body || {}) } });
  assert.equal(c.status, 201, c.text.slice(0, 220));
  return c.json.campaign;
}

test("who a campaign would go to can be looked at before it goes", { skip }, async () => {
  const { cookie } = await company();
  await buyers(cookie, 3);
  const c = await campaign(cookie);

  const who = await call(`/campaigns/${c.id}/audience`, { method: "POST", cookie,
    body: { partyKinds: ["BUYER"] } });
  assert.equal(who.status, 200);
  assert.equal(who.json.count, 3);
  assert.match(who.json.describes, /3 recipients/);

  /* Looking is not sending. */
  const after = await call(`/campaigns/${c.id}`, { cookie });
  assert.equal(after.json.campaign.status, "DRAFT");
  assert.equal(after.json.campaign.total, 0);
});

test("one person on two lists is written to once", { skip }, async () => {
  const { cookie } = await company();
  const [one] = await buyers(cookie, 1);
  const c = await campaign(cookie);

  const who = await call(`/campaigns/${c.id}/audience`, { method: "POST", cookie,
    body: { partyKinds: ["BUYER"],
            /* The same address again, by hand and in a different case. */
            extra: [{ name: "Again", email: (await addressOf(cookie, one.id)).toUpperCase() }] } });
  assert.equal(who.json.count, 1,
    "somebody on two lists would have been told the same thing twice");
});

async function addressOf(cookie: Wire, partyId: Wire) {
  const p = await call(`/parties/${partyId}`, { cookie });
  return p.json.party.email;
}

test("a campaign with nothing to carry it creates every message and sends none", { skip }, async () => {
  /*
   * The important half of a campaign with no provider: the messages must all
   * EXIST, queued, each with its own recipient — because the moment a provider
   * is connected they go, and because a campaign that created nothing would
   * leave no record of what was meant to happen.
   */
  const { cookie } = await company();
  await buyers(cookie, 4);
  const c = await campaign(cookie);

  const sent = await call(`/campaigns/${c.id}/send`, { method: "POST", cookie,
    body: { partyKinds: ["BUYER"] } });
  assert.equal(sent.status, 200, sent.text.slice(0, 220));
  assert.equal(sent.json.total, 4);
  assert.equal(sent.json.queued, 4);
  assert.equal(sent.json.submitted, 0);
  assert.match(sent.json.said, /none of them has been sent/i);
  assert.equal(sent.json.campaign.status, "SENDING",
    "a campaign nothing carried was reported as sent");

  const box = await call("/dispatches/outbox?view=queued", { cookie });
  assert.equal(box.json.count, 4);
  /* Each one its own recipient, not one message with four addresses. */
  assert.equal(new Set(box.json.dispatches.map((d: Wire) => d.toAddress)).size, 4);
  assert.ok(box.json.dispatches.every((d: Wire) => d.campaignId === c.id));
});

test("a batch that half worked is never called sent", { skip }, async () => {
  /*
   * THE MOST MISLEADING WORD AVAILABLE. A campaign of forty where thirteen
   * failed, reported as "sent", is how a company believes it has told people
   * something it has not.
   */
  let n = 0;
  const before = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    return n % 2
      ? new Response(JSON.stringify({ id: `re_${n}` }), { status: 200 })
      : new Response(JSON.stringify({ message: "Recipient refused" }), { status: 422 });
  };
  process.env.RESEND_API_KEY = "k"; process.env.MAIL_FROM = "a@b.c";
  try {
    const { cookie } = await company();
    await buyers(cookie, 4);
    const c = await campaign(cookie);
    const sent = await call(`/campaigns/${c.id}/send`, { method: "POST", cookie,
      body: { partyKinds: ["BUYER"] } });

    assert.equal(sent.json.submitted, 2);
    assert.equal(sent.json.failed, 2);
    assert.equal(sent.json.campaign.status, "PARTIAL",
      `a batch where half failed was recorded as ${sent.json.campaign.status}`);

    /* And the two that failed can be named. */
    const bad = await call("/dispatches/outbox?view=failed", { cookie });
    assert.equal(bad.json.count, 2);
    assert.ok(bad.json.dispatches.every((d: Wire) => d.error === "Recipient refused"));
  } finally {
    globalThis.fetch = before;
    delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
  }
});

test("an audience of nobody creates nothing at all", { skip }, async () => {
  const { cookie } = await company();
  await buyers(cookie, 2, /* withEmail */ false);
  const c = await campaign(cookie);
  const sent = await call(`/campaigns/${c.id}/send`, { method: "POST", cookie,
    body: { partyKinds: ["BUYER"] } });
  assert.equal(sent.status, 400);
  assert.match(sent.json.message, /Nothing has been created/i);

  const after = await call(`/campaigns/${c.id}`, { cookie });
  assert.equal(after.json.campaign.status, "DRAFT");
  assert.equal((await call("/dispatches", { cookie })).json.dispatches.length, 0);
});

test("a campaign is sent once", { skip }, async () => {
  const { cookie } = await company();
  await buyers(cookie, 1);
  const c = await campaign(cookie);
  await call(`/campaigns/${c.id}/send`, { method: "POST", cookie, body: { partyKinds: ["BUYER"] } });
  const again = await call(`/campaigns/${c.id}/send`, { method: "POST", cookie,
    body: { partyKinds: ["BUYER"] } });
  assert.equal(again.status, 409, "everybody was told twice");
});

test("cancelling a campaign stops what has not gone and admits what has", { skip }, async () => {
  const { cookie } = await company();
  await buyers(cookie, 3);
  const c = await campaign(cookie);
  await call(`/campaigns/${c.id}/send`, { method: "POST", cookie, body: { partyKinds: ["BUYER"] } });

  const stop = await call(`/campaigns/${c.id}/cancel`, { method: "POST", cookie });
  assert.equal(stop.json.stopped, 3);
  assert.match(stop.json.said, /cannot be recalled/i,
    "cancelling implied messages already with a provider could be pulled back");
  assert.equal((await call("/dispatches/outbox?view=queued", { cookie })).json.count, 0);
});

/* ====================================================================== *
 * THE CARRIER TELLING US IT ARRIVED
 * ====================================================================== */

async function submitted(cookie: Wire) {
  const fake = withFakeProvider(ok({ id: `re_${++seq}` }));
  try {
    const m = await dispatch(cookie);
    const sent = await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
    return sent.json.dispatch;
  } finally { fake.done(); }
}

const hook = (body: Wire, headers?: Wire) => call("/hooks/comms/resend", {
  method: "POST", body, headers: headers || {},
});

test("with no secret set, nothing is believed at all", { skip }, async () => {
  delete process.env.COMMS_WEBHOOK_SECRET;
  const { cookie } = await company();
  const m = await submitted(cookie);
  const res = await hook({ providerRef: m.providerRef, type: "delivered" });
  assert.equal(res.status, 503);

  const back = await call(`/dispatches/${m.id}`, { cookie });
  assert.equal(back.json.dispatch.status, "SUBMITTED",
    "an unverified callback marked a message as delivered");
});

test("a stranger cannot mark somebody's outbox as delivered", { skip }, async () => {
  process.env.COMMS_WEBHOOK_SECRET = "s3cret-for-tests";
  try {
    const { cookie } = await company();
    const m = await submitted(cookie);

    for (const headers of [{}, { "x-paltas-signature": "" },
                           { "x-paltas-signature": "wrong" },
                           { "x-paltas-signature": "s3cret-for-testsX" }]) {
      const res = await hook({ providerRef: m.providerRef, type: "delivered" }, headers);
      assert.equal(res.status, 401, `signature ${JSON.stringify(headers)} was accepted`);
    }
    const back = await call(`/dispatches/${m.id}`, { cookie });
    assert.equal(back.json.dispatch.status, "SUBMITTED");
  } finally { delete process.env.COMMS_WEBHOOK_SECRET; }
});

test("the provider saying it arrived is the only thing that writes delivered", { skip }, async () => {
  process.env.COMMS_WEBHOOK_SECRET = "s3cret-for-tests";
  try {
    const { cookie } = await company();
    const m = await submitted(cookie);
    assert.equal(m.status, "SUBMITTED");

    const res = await hook({ providerRef: m.providerRef, type: "delivered" },
                           { "x-paltas-signature": "s3cret-for-tests" });
    assert.equal(res.status, 200);

    const back = await call(`/dispatches/${m.id}`, { cookie });
    assert.equal(back.json.dispatch.status, "DELIVERED");
    assert.ok(back.json.dispatch.deliveredAt);
    /* Both facts, in order: taken at one moment, arrived at another. */
    assert.deepEqual(back.json.dispatch.events.map((e: Wire) => e.status),
      ["SUBMITTED", "DELIVERED"]);
    assert.equal(back.json.dispatch.events[1].byName, "system");
  } finally { delete process.env.COMMS_WEBHOOK_SECRET; }
});

test("a bounce is not overwritten by a late delivered", { skip }, async () => {
  /*
   * Providers redeliver, and they redeliver out of order. A `delivered`
   * arriving after a `bounce` would otherwise rewrite a message that came
   * back as one that arrived.
   */
  process.env.COMMS_WEBHOOK_SECRET = "s3cret-for-tests";
  try {
    const { cookie } = await company();
    const m = await submitted(cookie);
    const sig = { "x-paltas-signature": "s3cret-for-tests" };

    await hook({ providerRef: m.providerRef, type: "bounce", reason: "No such mailbox" }, sig);
    await hook({ providerRef: m.providerRef, type: "delivered" }, sig);

    const back = await call(`/dispatches/${m.id}`, { cookie });
    assert.equal(back.json.dispatch.status, "BOUNCED",
      "a message that came back was later recorded as having arrived");
    assert.equal(back.json.dispatch.error, "No such mailbox");
    /* Both are still in the history — the record shows what was reported. */
    assert.deepEqual(back.json.dispatch.events.map((e: Wire) => e.status),
      ["SUBMITTED", "BOUNCED", "DELIVERED"]);
  } finally { delete process.env.COMMS_WEBHOOK_SECRET; }
});

test("a callback for a reference nobody holds changes nothing, and says nothing", { skip }, async () => {
  process.env.COMMS_WEBHOOK_SECRET = "s3cret-for-tests";
  try {
    const { cookie } = await company();
    const m = await submitted(cookie);
    const sig = { "x-paltas-signature": "s3cret-for-tests" };

    /* A wrong reference and a right one must be indistinguishable from
       outside, or the endpoint becomes an oracle for guessing references. */
    const miss = await hook({ providerRef: "re_not_a_real_one", type: "delivered" }, sig);
    const hit = await hook({ providerRef: m.providerRef, type: "delivered" }, sig);
    assert.equal(miss.status, hit.status);
    assert.deepEqual(miss.json, hit.json);
  } finally { delete process.env.COMMS_WEBHOOK_SECRET; }
});

test("a callback from the wrong provider is not believed", { skip }, async () => {
  process.env.COMMS_WEBHOOK_SECRET = "s3cret-for-tests";
  try {
    const { cookie } = await company();
    const m = await submitted(cookie);          /* carried by resend */
    await call("/hooks/comms/postmark", { method: "POST",
      body: { providerRef: m.providerRef, type: "delivered" },
      headers: { "x-paltas-signature": "s3cret-for-tests" } });

    const back = await call(`/dispatches/${m.id}`, { cookie });
    assert.equal(back.json.dispatch.status, "SUBMITTED",
      "one provider's callback resolved another provider's message");
  } finally { delete process.env.COMMS_WEBHOOK_SECRET; }
});

test("a campaign's counters follow its messages", { skip }, async () => {
  process.env.COMMS_WEBHOOK_SECRET = "s3cret-for-tests";
  const fake = withFakeProvider(ok({ id: `re_camp_${++seq}` }));
  try {
    const { cookie } = await company();
    await buyers(cookie, 1);
    const c = await campaign(cookie);
    await call(`/campaigns/${c.id}/send`, { method: "POST", cookie, body: { partyKinds: ["BUYER"] } });

    const one = (await call("/dispatches", { cookie })).json.dispatches[0];
    await hook({ providerRef: one.providerRef, type: "delivered" },
               { "x-paltas-signature": "s3cret-for-tests" });

    const back = await call(`/campaigns/${c.id}`, { cookie });
    assert.equal(back.json.campaign.delivered, 1);
    assert.match(back.json.campaign.progress, /confirmed delivered/);
  } finally {
    fake.done();
    delete process.env.COMMS_WEBHOOK_SECRET;
  }
});

/* ====================================================================== *
 * TENANCY AND AUTHORISATION
 * ====================================================================== */

test("none of it crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const m = await dispatch(theirs.cookie);
  const c = await campaign(theirs.cookie);

  assert.equal((await call(`/dispatches/${m.id}/send`, { method: "POST", cookie: mine.cookie })).status, 404);
  assert.equal((await call(`/dispatches/${m.id}/cancel`, { method: "POST", cookie: mine.cookie })).status, 404);
  assert.equal((await call(`/campaigns/${c.id}/send`, { method: "POST", cookie: mine.cookie,
    body: { partyKinds: ["BUYER"] } })).status, 404);
  assert.equal((await call("/dispatches/outbox?view=queued", { cookie: mine.cookie })).json.count, 0);
});

test("somebody who may not reach people may not write to them", { skip }, async () => {
  const owner = await company();
  const cookie = owner.cookie;
  /* Engineering runs the plant. It has no business emailing the buyer list. */
  const engineer = await asRole(owner, "ENGINEERING");
  const res = await call("/dispatches", { method: "POST", cookie: engineer,
    body: { toAddress: "someone@example.com", body: "hello" } });
  assert.equal(res.status, 403, "an engineer could write to the company's contacts");

  const mine = await dispatch(cookie);
  assert.equal((await call(`/dispatches/${mine.id}/send`,
    { method: "POST", cookie: engineer })).status, 403);
});

test("every send and every batch is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  await buyers(cookie, 1);
  const m = await dispatch(cookie);
  await call(`/dispatches/${m.id}/send`, { method: "POST", cookie });
  const c = await campaign(cookie);
  await call(`/campaigns/${c.id}/send`, { method: "POST", cookie, body: { partyKinds: ["BUYER"] } });
  await call(`/campaigns/${c.id}/cancel`, { method: "POST", cookie });

  const actions = new Set((await db.auditEvent.findMany({
    where: { orgId: String(orgId) }, select: { action: true } })).map((e) => e.action));
  for (const want of ["dispatch.send", "campaign.send", "campaign.cancel"]) {
    assert.ok(actions.has(want), `${want} was not recorded`);
  }
});
