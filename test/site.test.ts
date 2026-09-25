/* ====================================================================== *
 * FIVE REGISTERS A SITE IS RUN ON, AND THE RULES THAT MAKE THEM ONE.
 *
 * Each of the five exists because somebody will later be asked a question
 * they cannot answer from a spreadsheet — we asked in March and never heard
 * back; which revision did you approve; who signed this off as fixed. The
 * tests below are about the rules that keep the answer true rather than about
 * the rows:
 *
 *   an RFI cannot be closed unanswered, because a register whose questions
 *   can be closed unanswered is one that empties itself;
 *
 *   a submittal sent back OPENS THE NEXT REVISION rather than being edited,
 *   because somebody built to rev 1;
 *
 *   an inspection passed with defects raises them in the same transaction;
 *
 *   a defect cannot be verified by whoever fixed it — the single rule that
 *   stops a snagging list emptying itself the day before handover;
 *
 *   a site diary is one per project per day, never for a day that has not
 *   happened, and fixed once the day is over.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { present } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_site";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping site register tests";
let dbHelp: typeof import("./db-help.ts") | null = null;
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
async function asRole(owner: string, role: string) {
  const n = ++seq;
  const org = await db.session.findFirst({
    where: { tokenHash: { not: "" } }, select: { orgId: true },
    orderBy: { createdAt: "desc" },
  });
  const orgId = owner.orgId;
  const email = `role${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Role ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.membership.create({ data: { userId: user.id, orgId, role } });
  return `paltas_session=${token}`;
}



/* ====================================================================== *
 * SHARED
 * ====================================================================== */

async function project(cookie: string, name?: string) {
  const p = await call("/projects", { method: "POST", cookie,
    body: { name: name || `Riverside ${++seq}`, city: "Nairobi" } });
  assert.equal(p.status, 201, p.text.slice(0, 200));
  return p.json.project.id;
}

/* ====================================================================== *
 * RFIs
 * ====================================================================== */

async function rfi(cookie: Wire, body?: Wire) {
  const r = await call("/rfis", { method: "POST", cookie,
    body: { subject: "Cladding fixing detail at level 4",
            question: "The drawing shows two fixings. Which applies at the reveal?",
            discipline: "Facade", toName: "Grace Wanjiru", ...(body || {}) } });
  assert.equal(r.status, 201, r.text.slice(0, 220));
  return r.json.rfi;
}

test("a question cannot be closed by pretending it was answered", { skip }, async () => {
  /*
   * THE RULE THE WHOLE REGISTER RESTS ON. An RFI register exists because open
   * questions stop work; one whose questions can be closed unanswered empties
   * itself the first time somebody tidies it up.
   */
  const { cookie } = await company();
  const r = await rfi(cookie);
  assert.match(r.ref, /^RFI-\d{4}$/);
  assert.equal(r.status, "OPEN");

  const early = await call(`/rfis/${r.id}/close`, { method: "POST", cookie });
  assert.equal(early.status, 409, "an unanswered question was closed");
  assert.match(early.json.message, /empties itself/i);

  const bare = await call(`/rfis/${r.id}/answer`, { method: "POST", cookie, body: {} });
  assert.equal(bare.status, 400, "an empty answer was accepted");

  const answered = await call(`/rfis/${r.id}/answer`, { method: "POST", cookie,
    body: { answer: "Use the reveal fixing throughout.", answeredBy: "Grace Wanjiru" } });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.rfi.status, "ANSWERED");
  assert.equal(answered.json.rfi.answeredBy, "Grace Wanjiru");
  assert.ok(answered.json.rfi.answeredOn, "an answer with no date");

  assert.equal((await call(`/rfis/${r.id}/close`, { method: "POST", cookie })).status, 200);
});

test("a question that stopped mattering is withdrawn, with the reason", { skip }, async () => {
  const { cookie } = await company();
  const r = await rfi(cookie);

  const bare = await call(`/rfis/${r.id}/void`, { method: "POST", cookie });
  assert.equal(bare.status, 400, "a question vanished with no record of why");

  const out = await call(`/rfis/${r.id}/void`, { method: "POST", cookie,
    body: { reason: "The reveal was redesigned out." } });
  assert.equal(out.status, 200);
  assert.equal(out.json.rfi.status, "VOID");

  const back = await call(`/rfis/${r.id}`, { cookie });
  const e = back.json.rfi.events.find((x: Wire) => x.action === "VOID");
  assert.equal(e.detail, "The reveal was redesigned out.");
  /* And it cannot then be answered as though it were live. */
  assert.equal((await call(`/rfis/${r.id}/answer`, { method: "POST", cookie,
    body: { answer: "..." } })).status, 409);
});

test("an answer that arrives after it was needed says so", { skip }, async () => {
  const { cookie } = await company();
  const r = await rfi(cookie, { dueOn: "2020-01-01" });
  const back = await call(`/rfis/${r.id}`, { cookie });
  assert.equal(back.json.rfi.overdue, true, "a question six years late did not read as overdue");

  const out = await call(`/rfis/${r.id}/answer`, { method: "POST", cookie,
    body: { answer: "Eventually." } });
  assert.equal(out.json.late, true);
  assert.match(out.json.said, /after the date/i);
});

test("what is outstanding is one question, not a filter", { skip }, async () => {
  const { cookie } = await company();
  await rfi(cookie, { dueOn: "2020-01-01" });
  await rfi(cookie, { dueOn: "2099-01-01" });
  const answered = await rfi(cookie, { dueOn: "2020-01-01" });
  await call(`/rfis/${answered.id}/answer`, { method: "POST", cookie, body: { answer: "Done." } });

  const out = await call("/rfis/overdue", { cookie });
  assert.equal(out.json.count, 1, "overdue counted questions that were answered or not yet due");
  assert.equal(out.json.counts.open, 2);
  assert.equal(out.json.counts.answered, 1);
});

/* ====================================================================== *
 * SUBMITTALS
 * ====================================================================== */

async function submittal(cookie: Wire, body?: Wire) {
  const s = await call("/submittals", { method: "POST", cookie,
    body: { title: "Aluminium cladding — shop drawings", specRef: "07 42 13",
            contractor: "Kilimani Facades", discipline: "Facade", ...(body || {}) } });
  assert.equal(s.status, 201, s.text.slice(0, 220));
  return s.json.submittal;
}

test("sending a submittal back opens the next revision, and leaves this one alone", { skip }, async () => {
  /*
   * THE ONE THAT MATTERS. Somebody built to revision 1. If revision 2
   * overwrites it, nobody can ever find out what they built to.
   */
  const { cookie } = await company();
  const s = await submittal(cookie);
  assert.equal(s.revision, 0);

  await call(`/submittals/${s.id}/submit`, { method: "POST", cookie });
  const back = await call(`/submittals/${s.id}/review`, { method: "POST", cookie,
    body: { outcome: "REVISE_RESUBMIT", reviewerName: "Grace Wanjiru",
            comments: "Fixing centres exceed the spec at the reveal." } });
  assert.equal(back.status, 200, back.text.slice(0, 200));

  /* Rev 0 stays exactly as it was reviewed. */
  assert.equal(back.json.submittal.status, "REVISE_RESUBMIT");
  assert.equal(back.json.submittal.comments, "Fixing centres exceed the spec at the reveal.");
  assert.equal(back.json.submittal.reviewerName, "Grace Wanjiru");

  /* And rev 1 exists, in draft, chained to it. */
  const next = back.json.nextRevision;
  assert.ok(next, "nothing was opened for the contractor to resubmit into");
  assert.equal(next.revision, 1);
  assert.equal(next.status, "DRAFT");
  assert.equal(next.previousId, s.id);
  assert.equal(next.title, s.title);
  assert.equal(next.specRef, s.specRef);

  const chain = await call(`/submittals/${next.id}`, { cookie });
  assert.equal(chain.json.submittal.previous.ref, s.ref);
});

test("a submittal sent back without comments is a contractor guessing", { skip }, async () => {
  const { cookie } = await company();
  for (const outcome of ["REVISE_RESUBMIT", "REJECTED"]) {
    const s = await submittal(cookie);
    await call(`/submittals/${s.id}/submit`, { method: "POST", cookie });
    const res = await call(`/submittals/${s.id}/review`, { method: "POST", cookie,
      body: { outcome } });
    assert.equal(res.status, 400, `${outcome} with no comments was accepted`);
  }
});

test("a revision is reviewed once", { skip }, async () => {
  const { cookie } = await company();
  const s = await submittal(cookie);

  /* Not before it has been submitted. */
  const early = await call(`/submittals/${s.id}/review`, { method: "POST", cookie,
    body: { outcome: "APPROVED" } });
  assert.equal(early.status, 409);

  await call(`/submittals/${s.id}/submit`, { method: "POST", cookie });
  assert.equal((await call(`/submittals/${s.id}/review`, { method: "POST", cookie,
    body: { outcome: "APPROVED" } })).status, 200);

  const again = await call(`/submittals/${s.id}/review`, { method: "POST", cookie,
    body: { outcome: "REJECTED", comments: "Changed my mind." } });
  assert.equal(again.status, 409, "one revision was reviewed twice");
  assert.match(again.json.message, /new revision/i);
});

test("approved as noted says that work may continue", { skip }, async () => {
  /* The outcome everybody misreads. Reading it as a rejection stops work that
     could have carried on, which costs a week. */
  const { cookie } = await company();
  const s = await submittal(cookie);
  await call(`/submittals/${s.id}/submit`, { method: "POST", cookie });
  await call(`/submittals/${s.id}/review`, { method: "POST", cookie,
    body: { outcome: "APPROVED_AS_NOTED", comments: "Corrections marked in red." } });

  const back = await call(`/submittals/${s.id}`, { cookie });
  assert.match(back.json.submittal.means, /may continue/i);
  assert.equal(back.json.submittal.canReview, false);
});

/* ====================================================================== *
 * INSPECTIONS AND DEFECTS
 * ====================================================================== */

async function inspection(cookie: Wire, body?: Wire) {
  const i = await call("/inspections", { method: "POST", cookie,
    body: { title: "Level 3 pre-plaster", kind: "Structural", area: "Level 3",
            scheduledOn: "2026-04-10", ...(body || {}) } });
  assert.equal(i.status, 201, i.text.slice(0, 220));
  return i.json.inspection;
}

test("an inspection that found things raises them, in one go", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);
  const i = await inspection(cookie, { projectId: pid });

  const out = await call(`/inspections/${i.id}/record`, { method: "POST", cookie,
    body: {
      result: "PASSED_WITH_DEFECTS", inspectorName: "Peter Mwangi",
      defects: [
        { title: "Conduit not clipped", severity: "MINOR", trade: "Electrical" },
        { title: "Missing fire stopping at riser", severity: "CRITICAL", trade: "Fire" },
      ],
    } });
  assert.equal(out.status, 200, out.text.slice(0, 220));
  assert.equal(out.json.inspection.status, "PASSED_WITH_DEFECTS");
  assert.equal(out.json.raised, 2);

  /* Real defects, numbered, against the same project and inspection. */
  assert.equal(out.json.defects.length, 2);
  assert.ok(out.json.defects.every((d: Wire) => /^DEF-\d{4}$/.test(d.ref)));
  assert.ok(out.json.defects.every((d: Wire) => d.inspectionId === i.id));
  assert.ok(out.json.defects.every((d: Wire) => d.projectId === pid));
  assert.equal(out.json.defects.find((d: Wire) => d.trade === "Fire").severity, "CRITICAL");
});

test("passed with defects, and no defects, is passed", { skip }, async () => {
  const { cookie } = await company();
  const i = await inspection(cookie);
  const res = await call(`/inspections/${i.id}/record`, { method: "POST", cookie,
    body: { result: "PASSED_WITH_DEFECTS", defects: [] } });
  assert.equal(res.status, 400,
    "an inspection claimed defects and produced none — a list nobody can act on");
});

test("an inspection is recorded once", { skip }, async () => {
  const { cookie } = await company();
  const i = await inspection(cookie);
  await call(`/inspections/${i.id}/record`, { method: "POST", cookie, body: { result: "PASSED" } });
  const again = await call(`/inspections/${i.id}/record`, { method: "POST", cookie,
    body: { result: "FAILED", notes: "Actually no." } });
  assert.equal(again.status, 409, "a result was overwritten and the first one lost");
});

test("a defect cannot be signed off by whoever fixed it", { skip }, async () => {
  /*
   * THE RULE THIS REGISTER EXISTS FOR. A snagging list where the person who
   * caused a defect can also close it empties itself the day before handover,
   * and the flat is handed over with the defect still in it.
   */
  const { cookie } = await company();
  const d = await call("/defects", { method: "POST", cookie,
    body: { title: "Scratched glazing to bedroom 2", severity: "MINOR" } });
  assert.equal(d.status, 201);
  const id = d.json.defect.id;

  /* Not verifiable before anybody has fixed it. */
  assert.equal((await call(`/defects/${id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "Anyone" } })).status, 409);

  const fixed = await call(`/defects/${id}/fixed`, { method: "POST", cookie,
    body: { fixedByName: "Peter Mwangi" } });
  assert.equal(fixed.json.defect.status, "FIXED");
  assert.match(fixed.json.said, /not closed until somebody else/i);

  const same = await call(`/defects/${id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "Peter Mwangi" } });
  assert.equal(same.status, 409, "the person who fixed it also signed it off");
  assert.match(same.json.message, /cannot also verify/i);

  /* And not by the same person under a different capitalisation either. */
  assert.equal((await call(`/defects/${id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "peter mwangi" } })).status, 409);

  const other = await call(`/defects/${id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "Grace Wanjiru" } });
  assert.equal(other.status, 200);
  assert.equal(other.json.defect.status, "VERIFIED");
  assert.ok(other.json.defect.verifiedOn);
  /* BOTH names survive. That pair is the whole record. */
  assert.equal(other.json.defect.fixedByName, "Peter Mwangi");
  assert.equal(other.json.defect.verifiedByName, "Grace Wanjiru");
});

test("fixed does not read as finished", { skip }, async () => {
  const { cookie } = await company();
  const d = await call("/defects", { method: "POST", cookie, body: { title: "Chipped tile" } });
  await call(`/defects/${d.json.defect.id}/fixed`, { method: "POST", cookie,
    body: { fixedByName: "Peter Mwangi" } });
  const back = await call(`/defects/${d.json.defect.id}`, { cookie });
  assert.match(back.json.defect.means, /not closed until somebody else/i);
  assert.equal(back.json.defect.canVerify, true);
});

test("rejecting a defect keeps why, because somebody raised it in good faith", { skip }, async () => {
  const { cookie } = await company();
  const d = await call("/defects", { method: "POST", cookie, body: { title: "Wrong ironmongery" } });
  const id = d.json.defect.id;
  assert.equal((await call(`/defects/${id}/reject`, { method: "POST", cookie })).status, 400);

  const out = await call(`/defects/${id}/reject`, { method: "POST", cookie,
    body: { reason: "This is the specified ironmongery — see SUB-0003." } });
  assert.equal(out.json.defect.status, "REJECTED");
  const back = await call(`/defects/${id}`, { cookie });
  assert.match(back.json.defect.events.find((e: Wire) => e.action === "REJECTED").detail, /SUB-0003/);
});

test("what stands between here and handover is grouped by how bad it is", { skip }, async () => {
  const { cookie } = await company();
  const mk = (title: Wire, severity: Wire, extra: Wire) => call("/defects", { method: "POST", cookie,
    body: { title, severity, ...(extra || {}) } });
  await mk("A", "CRITICAL");
  await mk("B", "MAJOR");
  await mk("C", "MINOR", { dueOn: "2020-01-01" });
  const done = await mk("D", "MINOR");
  await call(`/defects/${done.json.defect.id}/fixed`, { method: "POST", cookie,
    body: { fixedByName: "P" } });

  const out = await call("/defects/outstanding", { cookie });
  assert.equal(out.json.counts.critical, 1);
  assert.equal(out.json.counts.major, 1);
  assert.equal(out.json.counts.minor, 2);
  assert.equal(out.json.counts.awaitingVerification, 1,
    "a defect waiting for somebody to check it was not counted as waiting");
  assert.equal(out.json.counts.overdue, 1);

  /* And a verified one leaves the list entirely. */
  await call(`/defects/${done.json.defect.id}/verify`, { method: "POST", cookie,
    body: { verifiedByName: "Somebody Else" } });
  const after = await call("/defects/outstanding", { cookie });
  assert.equal(after.json.counts.minor, 1);
  assert.equal(after.json.counts.awaitingVerification, 0);
});

/* ====================================================================== *
 * THE SITE DIARY
 * ====================================================================== */

const dayOf = (offset: Wire) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

test("one day, one entry", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);

  const first = await call("/site-diary", { method: "POST", cookie,
    body: { projectId: pid, on: dayOf(0), weather: "Dry", labourCount: 42,
            workDone: "Third floor slab poured." } });
  assert.equal(first.status, 201, first.text.slice(0, 220));
  assert.match(first.json.siteDiary.ref, /^SD-\d{4}$/);
  assert.equal(first.json.siteDiary.labourCount, 42);

  const second = await call("/site-diary", { method: "POST", cookie,
    body: { projectId: pid, on: dayOf(0), workDone: "Actually we did nothing." } });
  assert.equal(second.status, 409, "two accounts of one day — a record that contradicts itself");
  assert.match(second.json.message, /amend/i);

  /* A different development's Tuesday is a different Tuesday. */
  const other = await project(cookie);
  assert.equal((await call("/site-diary", { method: "POST", cookie,
    body: { projectId: other, on: dayOf(0), workDone: "Setting out." } })).status, 201);
});

test("a day that has not happened cannot be recorded", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);
  const res = await call("/site-diary", { method: "POST", cookie,
    body: { projectId: pid, on: dayOf(1), workDone: "We will pour the slab." } });
  assert.equal(res.status, 400, "tomorrow was written up in advance");
  assert.match(res.json.message, /has not yet/i);
});

test("today's page can be edited; yesterday's cannot", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);

  const today = await call("/site-diary", { method: "POST", cookie,
    body: { projectId: pid, on: dayOf(0), labourCount: 40 } });
  assert.equal(today.json.locked, false);
  const edit = await call(`/site-diary/${today.json.siteDiary.id}`, { method: "PATCH", cookie,
    body: { labourCount: 44, delays: "Concrete arrived late." } });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.siteDiary.labourCount, 44);

  /* Written up a day late: locked as it is written, with no editable window. */
  const past = await call("/site-diary", { method: "POST", cookie,
    body: { projectId: pid, on: dayOf(-1), labourCount: 38 } });
  assert.equal(past.status, 201);
  assert.equal(past.json.locked, true, "yesterday was left open to editing");
  assert.match(past.json.said, /locked/i);

  const late = await call(`/site-diary/${past.json.siteDiary.id}`, { method: "PATCH", cookie,
    body: { labourCount: 4 } });
  assert.equal(late.status, 409, "a past day was rewritten");
  assert.match(late.json.message, /amendment/i);
});

test("a correction is appended, never written over", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);
  const past = await call("/site-diary", { method: "POST", cookie,
    body: { projectId: pid, on: dayOf(-2), labourCount: 38,
            workDone: "Formwork to level 3." } });
  const id = past.json.siteDiary.id;

  assert.equal((await call(`/site-diary/${id}/amend`, { method: "POST", cookie })).status, 400);

  const out = await call(`/site-diary/${id}/amend`, { method: "POST", cookie,
    body: { note: "Labour was 48, not 38 — the second gang was not counted." } });
  assert.equal(out.status, 200);
  assert.equal(out.json.amendments.length, 1);
  assert.match(out.json.said, /original entry is unchanged/i);

  /* And it really is unchanged — that is the whole point. */
  const back = await call(`/site-diary/${id}`, { cookie });
  assert.equal(back.json.siteDiary.labourCount, 38);
  assert.equal(back.json.siteDiary.workDone, "Formwork to level 3.");
  assert.match(back.json.siteDiary.events.find((e: Wire) => e.action === "AMENDED").detail, /48, not 38/);
  assert.equal(back.json.siteDiary.locked, true);
});

/* ====================================================================== *
 * TENANCY, AUTHORISATION AND THE TRAIL
 * ====================================================================== */

test("none of it crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const pid = await project(theirs.cookie);
  const r = await rfi(theirs.cookie);
  const s = await submittal(theirs.cookie);
  const i = await inspection(theirs.cookie);
  const d = await call("/defects", { method: "POST", cookie: theirs.cookie, body: { title: "Theirs" } });
  const diary = await call("/site-diary", { method: "POST", cookie: theirs.cookie,
    body: { projectId: pid, on: dayOf(0) } });

  const post = (path: Wire) => call(path, { method: "POST", cookie: mine.cookie, body: {} });
  assert.equal((await post(`/rfis/${r.id}/close`)).status, 404);
  assert.equal((await post(`/submittals/${s.id}/submit`)).status, 404);
  assert.equal((await post(`/inspections/${i.id}/record`)).status, 404);
  assert.equal((await post(`/defects/${d.json.defect.id}/fixed`)).status, 404);
  assert.equal((await post(`/site-diary/${diary.json.siteDiary.id}/amend`)).status, 404);

  /* And one company's project cannot be written up by another. */
  assert.equal((await call("/site-diary", { method: "POST", cookie: mine.cookie,
    body: { projectId: pid, on: dayOf(0) } })).status, 400);
  assert.equal((await call("/rfis/overdue", { cookie: mine.cookie })).json.counts.open, 0);
});

test("somebody who may not reach the property may not move these", { skip }, async () => {
  const owner = await company();
  /* Finance keeps the books. It has no business closing an RFI. */
  const finance = await asRole(owner, "FINANCE");
  const r = await rfi(owner.cookie);
  assert.equal((await call(`/rfis/${r.id}/answer`, { method: "POST", cookie: finance,
    body: { answer: "Sure." } })).status, 403);
  assert.equal((await call("/site-diary", { method: "POST", cookie: finance,
    body: { projectId: await project(owner.cookie), on: dayOf(0) } })).status, 403);
});

test("every move in every register is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  const pid = await project(cookie);

  const r = await rfi(cookie);
  await call(`/rfis/${r.id}/answer`, { method: "POST", cookie, body: { answer: "Yes." } });
  const s = await submittal(cookie);
  await call(`/submittals/${s.id}/submit`, { method: "POST", cookie });
  await call(`/submittals/${s.id}/review`, { method: "POST", cookie, body: { outcome: "APPROVED" } });
  const i = await inspection(cookie, { projectId: pid });
  await call(`/inspections/${i.id}/record`, { method: "POST", cookie, body: { result: "PASSED" } });
  const d = await call("/defects", { method: "POST", cookie, body: { title: "X" } });
  await call(`/defects/${d.json.defect.id}/fixed`, { method: "POST", cookie, body: { fixedByName: "A" } });
  await call(`/defects/${d.json.defect.id}/verify`, { method: "POST", cookie, body: { verifiedByName: "B" } });
  await call("/site-diary", { method: "POST", cookie, body: { projectId: pid, on: dayOf(0) } });

  const actions = new Set((await db.auditEvent.findMany({
    where: { orgId }, select: { action: true } })).map((e) => e.action));
  for (const want of ["rfi.answer", "submittal.submit", "submittal.review",
                      "inspection.record", "defect.fixed", "defect.verify", "diary.write"]) {
    assert.ok(actions.has(want), `${want} was not recorded`);
  }
});
