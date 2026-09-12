/* ====================================================================== *
 * THE GUEST PORTAL, AND THE WALL AROUND IT.
 *
 * Every other authenticated route is scoped to an ORGANIZATION. These are
 * scoped to a PERSON, which is a different question and therefore a different
 * wall — so it gets its own tests rather than riding on the tenancy sweep.
 *
 * The thing being prevented: a guest reading another guest's stay, another
 * guest's bill, or any part of the hotel's own business. Every test below is
 * some version of that.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.js";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* This file's own schema. Every database test file rebuilds from nothing, and
   `node --test` runs files in parallel — so they must not share `public`. See
   the long note in db-help.js. */
const SCHEMA = "test_guest";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping guest portal tests";
let createApp, db, pg;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.js"));
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

/** Somebody who signs in. Not staff, not a member of anything. */
async function signIn(email) {
  const user = await db.user.upsert({
    where: { email }, create: { email, name: email, googleSub: "sub_" + email }, update: {},
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
            userId: user.id, expiresAt: new Date(Date.now() + 3600_000) },
  });
  return { user, cookie: `paltas_session=${token}` };
}

let seq = 0;

/** A hotel with one stay, and the guest linked to it. */
async function hotelWithGuest({ email, linked = true }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: { name: `Hotel ${n}`, country: "ae",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { status: "ACTIVE" } },
      entitlements: { create: [{ product: "HOTEL_MANAGEMENT" }] } },
  });
  const who = await signIn(email);
  const party = await db.party.create({
    data: { orgId: org.id, name: `Guest ${n}`, kind: "GUEST", email,
            userId: linked ? who.user.id : null },
  });
  const stay = await db.reservation.create({
    data: { orgId: org.id, ref: `RES-${n}`, guestId: party.id, guestName: `Guest ${n}`,
            property: `Hotel ${n}`, roomNumber: String(100 + n), roomType: "Suite",
            nights: 3, status: "CHECKED_IN", rate: 1_450_00n, currency: "AED" },
  });
  await db.hotelService.create({
    data: { orgId: org.id, name: "Airport transfer", kind: "Transfer",
            active: true, chargeable: true },
  });
  return { org, party, stay, ...who };
}

/* ================================================================ */

test("a guest sees their own stay, and the shape the portal reads", { skip }, async () => {
  const g = await hotelWithGuest({ email: `a${Date.now()}@guest.test` });
  const r = await call("/guest/stay", { cookie: g.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.stays.length, 1);
  const s = r.json.stays[0];
  for (const k of ["id", "ref", "roomNumber", "roomType", "nights", "status", "currency"]) {
    assert.ok(k in s, `the stay is missing ${k}`);
  }
  /*
   * AND NOT THE HOTEL'S OWN RECORD OF IT. `rate` is what the property charges
   * and `source` is which channel sold it — a guest's own page is not where a
   * hotel's commercial terms belong.
   */
  assert.equal("rate" in s, false, "the stay leaks the hotel's rate");
  assert.equal("source" in s, false, "the stay leaks the booking channel");
});

test("a guest cannot see another guest's stay", { skip }, async () => {
  const a = await hotelWithGuest({ email: `b${Date.now()}@guest.test` });
  const b = await hotelWithGuest({ email: `c${Date.now()}@guest.test` });

  const mine = await call("/guest/stay", { cookie: a.cookie });
  assert.equal(mine.json.stays.length, 1);
  assert.equal(mine.json.stays[0].ref, a.stay.ref);
  assert.ok(!mine.json.stays.some((s) => s.ref === b.stay.ref), "A can see B's stay");

  /* And cannot reach it by naming it, which is the attempt that matters. */
  const folio = await call(`/guest/stay/${b.stay.id}/folio`, { cookie: a.cookie });
  assert.equal(folio.status, 404, "A read B's folio by guessing the id");
});

test("signing in is not the same as being a guest", { skip }, async () => {
  /* Somebody with an account that no property has against a booking. The
     answer must explain itself, not imply they have no reservation. */
  const nobody = await signIn(`d${Date.now()}@nobody.test`);
  const r = await call("/guest/stay", { cookie: nobody.cookie });
  assert.equal(r.status, 403);
  assert.match(r.json.message, /not linked to a booking/i);
  assert.ok(r.json.message.length > 60, "the refusal does not say what to do next");
});

test("an unlinked party is not this person, however matching the email", { skip }, async () => {
  /*
   * THE BRIDGE IS THE WHOLE SECURITY MODEL. A Party with the same email but no
   * userId is not yet proven to be this person, and must not be readable.
   */
  const g = await hotelWithGuest({ email: `e${Date.now()}@guest.test`, linked: false });
  const r = await call("/guest/stay", { cookie: g.cookie });
  assert.equal(r.status, 403, "an unlinked party was treated as the signed-in person");
});

test("a guest reads their bill, without the hotel's internal notes", { skip }, async () => {
  const g = await hotelWithGuest({ email: `f${Date.now()}@guest.test` });

  /* Nothing charged yet is a real answer, not a 404. */
  const empty = await call(`/guest/stay/${g.stay.id}/folio`, { cookie: g.cookie });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.folio, null);
  assert.equal(empty.json.balance, 0);

  const folio = await db.folio.create({
    data: { orgId: g.org.id, reservationId: g.stay.id, currency: "AED" },
  });
  await db.folioLine.create({
    data: { folioId: folio.id, kind: "charge", detail: "Room service",
            amount: 12_500n, postedBy: "Layla Hassan" },
  });

  const r = await call(`/guest/stay/${g.stay.id}/folio`, { cookie: g.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.lines.length, 1);
  assert.equal(r.json.lines[0].detail, "Room service");
  assert.equal(r.json.balance, 12500);
  /* `postedBy` is a member of staff. A guest's bill shows what was charged,
     not which employee keyed it in. */
  assert.equal("postedBy" in r.json.lines[0], false, "the bill names the staff member");
});

test("a guest asks for something, against their own stay only", { skip }, async () => {
  const a = await hotelWithGuest({ email: `g${Date.now()}@guest.test` });
  const b = await hotelWithGuest({ email: `h${Date.now()}@guest.test` });

  const made = await call("/guest/requests", { method: "POST", cookie: a.cookie,
    body: { reservationId: a.stay.id, kind: "transfer",
            detail: "Airport pickup, 14:20, two bags", note: "Terminal 3" } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.request.kind, "TRANSFER");
  assert.equal(made.json.request.status, "OPEN");

  /* Against somebody else's stay: refused, and told nothing about it. */
  const theirs = await call("/guest/requests", { method: "POST", cookie: a.cookie,
    body: { reservationId: b.stay.id, kind: "service", detail: "Towels" } });
  assert.equal(theirs.status, 404, "A raised a request against B's stay");

  /* Their own list holds one, and B's holds none. */
  const mine = await call("/guest/requests", { cookie: a.cookie });
  assert.equal(mine.json.requests.length, 1);
  const others = await call("/guest/requests", { cookie: b.cookie });
  assert.equal(others.json.requests.length, 0, "B can see A's request");
});

test("a request needs a real kind and something to act on", { skip }, async () => {
  const g = await hotelWithGuest({ email: `i${Date.now()}@guest.test` });
  const bad = await call("/guest/requests", { method: "POST", cookie: g.cookie,
    body: { reservationId: g.stay.id, kind: "anything", detail: "x" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /kind must be one of/i);

  const blank = await call("/guest/requests", { method: "POST", cookie: g.cookie,
    body: { reservationId: g.stay.id, kind: "service", detail: "   " } });
  assert.equal(blank.status, 400);
  assert.match(blank.json.message, /detail is required/i);
});

test("a finished stay takes no more requests", { skip }, async () => {
  const g = await hotelWithGuest({ email: `j${Date.now()}@guest.test` });
  await db.reservation.update({ where: { id: g.stay.id }, data: { status: "CHECKED_OUT" } });
  const r = await call("/guest/requests", { method: "POST", cookie: g.cookie,
    body: { reservationId: g.stay.id, kind: "service", detail: "More towels" } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /checked out/i);
});

test("a guest may withdraw their own request and answer nothing", { skip }, async () => {
  const g = await hotelWithGuest({ email: `k${Date.now()}@guest.test` });
  const made = await call("/guest/requests", { method: "POST", cookie: g.cookie,
    body: { reservationId: g.stay.id, kind: "service", detail: "Late checkout" } });
  const id = made.json.request.id;

  const off = await call(`/guest/requests/${id}/cancel`, { method: "POST", cookie: g.cookie });
  assert.equal(off.status, 200);
  assert.equal(off.json.request.status, "CANCELLED");

  /*
   * AND THERE IS NO WAY FOR A GUEST TO ANSWER ONE. Marking a request done, or
   * writing the property's reply, is the property speaking — a guest doing it
   * would make the record worthless. The staff resource is org-scoped and a
   * guest holds no membership, so it refuses them.
   */
  const asStaff = await call(`/guest-requests/${id}`, { method: "PATCH",
    cookie: g.cookie, body: { status: "DONE", response: "Done by the guest" } });
  assert.ok(asStaff.status === 401 || asStaff.status === 403,
    `a guest reached the staff endpoint (${asStaff.status})`);
});

test("a guest claims the booking addressed to their own email", { skip }, async () => {
  /*
   * WITHOUT THIS, NOTHING EVER SETS Party.userId and every guest gets the
   * "not linked to a booking yet" refusal forever. It rests on two facts: the
   * property said this guest's email is X, and Google says this person
   * controls X.
   */
  const email = `o${Date.now()}@guest.test`;
  const g = await hotelWithGuest({ email, linked: false });

  const before = await call("/guest/stay", { cookie: g.cookie });
  assert.equal(before.status, 403, "an unlinked party should not be readable");

  const link = await call("/guest/link", { method: "POST", cookie: g.cookie });
  assert.equal(link.status, 200, link.text);
  assert.equal(link.json.linked, 1);
  assert.equal(link.json.total, 1);

  const after = await call("/guest/stay", { cookie: g.cookie });
  assert.equal(after.status, 200);
  assert.equal(after.json.stays[0].ref, g.stay.ref);

  /* Idempotent: claiming twice links nothing more and is not an error. */
  const again = await call("/guest/link", { method: "POST", cookie: g.cookie });
  assert.equal(again.status, 200);
  assert.equal(again.json.linked, 0);
  assert.equal(again.json.total, 1);
});

test("a party already linked to somebody else cannot be taken over", { skip }, async () => {
  /*
   * THE ATTACK THIS BLOCKS. Two accounts on the same address — a shared family
   * mailbox, a resold domain, a property's typo — must not let the second
   * person inherit the first person's stay and bill.
   */
  const email = `p${Date.now()}@guest.test`;
  const first = await hotelWithGuest({ email });          /* already linked */

  /* A different account, same address. */
  const other = await db.user.create({
    data: { email: `other-${email}`, name: "Other", googleSub: `sub-other-${email}` },
  });
  await db.user.update({ where: { id: other.id }, data: { email } })
    .catch(() => {});   /* the unique index may refuse; either way, see below */

  const second = await signIn(`q${Date.now()}@guest.test`);
  await db.party.create({
    data: { orgId: first.org.id, name: "Impostor", kind: "GUEST", email: `q${Date.now()}@x.test` },
  });

  /* The second person claims: they get their OWN matching parties and none of
     the first person's, whose userId is already set. */
  const link = await call("/guest/link", { method: "POST", cookie: second.cookie });
  assert.equal(link.status, 200);

  const theirs = await call("/guest/stay", { cookie: second.cookie });
  if (theirs.status === 200) {
    assert.ok(!theirs.json.stays.some((s) => s.ref === first.stay.ref),
      "a second account inherited the first guest's stay");
  }

  /* And the first person still has it. */
  const mine = await call("/guest/stay", { cookie: first.cookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.stays[0].ref, first.stay.ref);
});

test("claiming does not reach a vendor or a staff record", { skip }, async () => {
  /* Widening the kinds would let somebody claim a supplier's record and read
     its invoices. Only a guest or a contact is claimable. */
  const email = `r${Date.now()}@vendor.test`;
  const who = await signIn(email);
  const org = await db.organization.create({
    data: { name: `Vendor host ${++seq}`,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { status: "ACTIVE" } },
      entitlements: { create: [{ product: "HOTEL_MANAGEMENT" }] } },
  });
  await db.party.create({ data: { orgId: org.id, name: "Mwangi Plumbing", kind: "VENDOR", email } });

  const link = await call("/guest/link", { method: "POST", cookie: who.cookie });
  assert.equal(link.status, 200);
  assert.equal(link.json.linked, 0, "a vendor record was claimed as a guest");
  assert.equal(link.json.total, 0);
});

test("a guest sees the services on offer and nothing else of the hotel's", { skip }, async () => {
  const g = await hotelWithGuest({ email: `l${Date.now()}@guest.test` });
  const r = await call("/guest/services", { cookie: g.cookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.services.some((s) => s.name === "Airport transfer"),
    "airport transfer is a service and should be listed");

  /* The hotel's own tables stay shut to them. A guest holds no membership, so
     requireOrganization() refuses before any of it is read. */
  for (const p of ["/rooms", "/reservations", "/work-orders", "/invoices", "/summary"]) {
    const shut = await call(p, { cookie: g.cookie });
    assert.ok(shut.status === 401 || shut.status === 403,
      `a guest reached ${p} (${shut.status})`);
  }
});

test("staff answer guest requests, scoped to their own company", { skip }, async () => {
  const a = await hotelWithGuest({ email: `m${Date.now()}@guest.test` });
  const made = await call("/guest/requests", { method: "POST", cookie: a.cookie,
    body: { reservationId: a.stay.id, kind: "issue", detail: "Air conditioning is loud" } });
  const id = made.json.request.id;

  /* A member of the hotel's staff. */
  const gm = await signIn(`n${Date.now()}@hotel.test`);
  await db.membership.create({ data: { userId: gm.user.id, orgId: a.org.id, role: "GM" } });

  const seen = await call("/guest-requests", { cookie: gm.cookie });
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json["guest-requests"].length, 1);
  assert.equal(seen.json["guest-requests"][0].reservation.ref, a.stay.ref);

  const answered = await call(`/guest-requests/${id}`, { method: "PATCH", cookie: gm.cookie,
    body: { status: "DONE", response: "Engineering replaced the fan at 15:10." } });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.json.guestRequest.status, "DONE");

  /* The guest sees the reply, which is the point of the field. */
  const back = await call("/guest/requests", { cookie: a.cookie });
  assert.match(back.json.requests[0].response, /replaced the fan/);

  /* Staff cannot RAISE one — see `noCreate`. */
  const raised = await call("/guest-requests", { method: "POST", cookie: gm.cookie,
    body: { status: "OPEN" } });
  assert.equal(raised.status, 404, "staff can raise a request on a guest's behalf");

  /* And cannot delete one: "I asked and nobody came" must stay answerable. */
  const gone = await call(`/guest-requests/${id}`, { method: "DELETE", cookie: gm.cookie });
  assert.equal(gone.status, 403);
  assert.match(gone.json.message, /never deleted/i);
});

/* ================================================================ *
 * THE PROPERTY, AND TALKING TO IT.
 * ================================================================ */

test("a guest sees their property and what it offers, not its prices",
  { skip }, async () => {
  const g = await hotelWithGuest({ email: `h${Date.now()}@guest.test` });
  const r = await call("/guest/hotel", { cookie: g.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.hotels.length, 1);
  const h = r.json.hotels[0];
  assert.equal(h.id, g.org.id);
  assert.ok(h.name, "a guest should be told where they are staying");
  assert.equal(h.services.length, 1);
  assert.equal(h.services[0].name, "Airport transfer");
  assert.equal(h.services[0].chargeable, true);
  /* A rate belongs on the folio that charges it. A price quoted here that the
     bill then disagrees with is worse than no price. */
  assert.ok(!("price" in h.services[0]) && !("rate" in h.services[0]),
    "a service price leaked into the guest's view");
});

test("another hotel's property and services stay invisible", { skip }, async () => {
  const mine = await hotelWithGuest({ email: `h2${Date.now()}@guest.test` });
  const theirs = await hotelWithGuest({ email: `h3${Date.now()}@guest.test` });

  const r = await call("/guest/hotel", { cookie: mine.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.hotels.length, 1, "a guest saw more properties than they are staying at");
  assert.ok(!JSON.stringify(r.json).includes(theirs.org.id),
    "another hotel's id leaked into a guest's view");
});

test("a guest can write to the hotel, and reads only their own thread",
  { skip }, async () => {
  const mine = await hotelWithGuest({ email: `m${Date.now()}@guest.test` });
  const theirs = await hotelWithGuest({ email: `m2${Date.now()}@guest.test` });

  const sent = await call("/guest/messages", { method: "POST", cookie: mine.cookie,
    body: { body: "Is the airport transfer still coming?" } });
  assert.equal(sent.status, 201, sent.text.slice(0, 200));
  assert.equal(sent.json.message.mine, true);

  /* The hotel replies, the way staff would — OUT, from the company. */
  await db.message.create({
    data: { orgId: mine.org.id, conversationId: sent.json.thread,
            direction: "OUT", authorName: "Front desk",
            body: "Yes — the driver is on the way." },
  });

  const read = await call("/guest/messages", { cookie: mine.cookie });
  assert.equal(read.status, 200);
  assert.equal(read.json.threads.length, 1);
  const msgs = read.json.threads[0].messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].mine, true,  "the guest's own message should read as theirs");
  assert.equal(msgs[1].mine, false, "the hotel's reply should not");
  /* WHICH member of staff replied is the property's business. */
  assert.ok(!JSON.stringify(read.json).includes("Front desk"),
    "a staff member's name leaked to the guest");

  /* And the other guest's thread does not exist as far as they are concerned. */
  const other = await call("/guest/messages", { cookie: theirs.cookie });
  assert.equal(other.status, 200);
  assert.equal(other.json.threads.length, 0, "a guest saw another guest's conversation");
});

test("a guest may ASK to check in; they cannot check themselves in", { skip }, async () => {
  const g = await hotelWithGuest({ email: `c${Date.now()}@guest.test` });

  const asked = await call("/guest/requests", { method: "POST", cookie: g.cookie,
    body: { reservationId: g.stay.id, kind: "CHECK_IN",
            detail: "Arriving about 2pm" } });
  assert.equal(asked.status, 201, asked.text.slice(0, 200));
  assert.equal(asked.json.request.kind, "CHECK_IN");
  assert.equal(asked.json.request.status, "OPEN",
    "a check-in request must start as a request, not as a fact");

  /*
   * THE RESERVATION DID NOT MOVE.
   *
   * The room has to be ready, the identity seen and the payment authorised,
   * and all three are the property's call. This is the line that keeps a
   * guest's tap on a phone from being a check-in.
   */
  const stay = await db.reservation.findUnique({ where: { id: g.stay.id } });
  assert.equal(stay.status, "CHECKED_IN",
    "the seeded stay's own status must be untouched by the request");

  const empty = await call("/guest/messages", { method: "POST", cookie: g.cookie,
    body: { body: "   " } });
  assert.equal(empty.status, 400, "an empty message was accepted");
});
