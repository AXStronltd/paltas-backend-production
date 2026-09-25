/* ====================================================================== *
 * MEETING → DECISION → TASK — the loop, not the tables.
 *
 * A development is run in a loop: something is discussed in a meeting, a
 * decision comes out of it, tasks come out of the decision, somebody owns each
 * one and it is either done by its date or it is not.
 *
 * These test the LOOP rather than the three tables. Creating a meeting row
 * proves nothing; what matters is that a decision cannot be approved with
 * nobody accountable, that a register only moves forwards, that finishing a
 * parent task is refused while its children are open, and that every one of
 * those moves is recorded.
 *
 *     npx prisma generate
 *     TEST_DATABASE_URL=postgresql://…  npm test
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";
import { present } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_workflow";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping workflow tests";
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
 * THE LOOP
 * ====================================================================== */

async function project(cookie: string, name?: string) {
  const p = await call("/projects", { method: "POST", cookie, body: { name: name || `Tower ${++seq}`, city: "Nairobi" } });
  assert.equal(p.status, 201, p.text.slice(0, 160));
  return p.json.project.id;
}

async function meeting(cookie: Wire, projectId: Wire, title?: Wire) {
  const m = await call("/meetings", { method: "POST", cookie,
    body: { projectId, title: title || "Site progress", kind: "SITE", startsAt: "2026-04-01T09:00:00Z",
            agenda: "Programme, procurement, snagging" } });
  assert.equal(m.status, 201, m.text.slice(0, 200));
  return m.json.meeting;
}

test("a meeting is held, with who was actually in the room", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);
  const m = await meeting(cookie, pid);
  assert.match(m.ref, /^MTG-\d{4}$/);
  assert.equal(m.status, "SCHEDULED");

  const a = await call(`/meetings/${m.id}/participants`, { method: "POST", cookie,
    body: { name: "Grace Wanjiru", email: "grace@example.com", role: "Architect" } });
  const b = await call(`/meetings/${m.id}/participants`, { method: "POST", cookie,
    body: { name: "Peter Mwangi", role: "QS" } });
  assert.equal(a.status, 201);

  /* Only one of them turned up. Invited is not attended. */
  const held = await call(`/meetings/${m.id}/hold`, { method: "POST", cookie,
    body: { attended: [a.json.participant.id], minutes: "Programme reviewed." } });
  assert.equal(held.status, 200);
  assert.equal(held.json.meeting.status, "HELD");

  const back = await call(`/meetings/${m.id}`, { cookie });
  const byName = Object.fromEntries(back.json.meeting.participants.map((p: Wire) => [p.name, p.attended]));
  assert.equal(byName["Grace Wanjiru"], true);
  assert.equal(byName["Peter Mwangi"], false, "somebody who was absent was recorded as present");
});

test("a meeting that happened cannot be cancelled", { skip }, async () => {
  const { cookie } = await company();
  const m = await meeting(cookie, await project(cookie));
  await call(`/meetings/${m.id}/hold`, { method: "POST", cookie, body: {} });
  const res = await call(`/meetings/${m.id}/cancel`, { method: "POST", cookie });
  assert.equal(res.status, 409, "a meeting that was held was cancelled out of existence");
});

test("minutes are never reported as sent to nobody", { skip }, async () => {
  /*
   * THE HONEST BUTTON. Issuing minutes to a meeting where no participant has
   * an email is a send that cannot happen, and reporting it as done is how a
   * product teaches people not to trust it.
   */
  const { cookie } = await company();
  const m = await meeting(cookie, await project(cookie));
  await call(`/meetings/${m.id}/participants`, { method: "POST", cookie, body: { name: "No Email" } });

  const blind = await call(`/meetings/${m.id}/minutes`, { method: "POST", cookie,
    body: { minutes: "Discussed.", send: true } });
  assert.equal(blind.status, 400);
  assert.match(blind.json.message, /nobody to send/i);

  /* Saving them without sending is fine, and says it did not send. */
  const saved = await call(`/meetings/${m.id}/minutes`, { method: "POST", cookie,
    body: { minutes: "Discussed." } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.issued, false);
  assert.equal(saved.json.meeting.minutesSentAt, null);

  await call(`/meetings/${m.id}/participants`, { method: "POST", cookie,
    body: { name: "Has Email", email: "x@example.com" } });
  const issued = await call(`/meetings/${m.id}/minutes`, { method: "POST", cookie,
    body: { minutes: "Discussed.", send: true } });
  assert.equal(issued.json.issued, true);
  assert.equal(issued.json.recipients.length, 1);

  /*
   * A REAL MESSAGE PER PERSON, not a promise that one exists.
   *
   * Issuing used to stamp the meeting and say delivery was the communications
   * layer's job. There is a communications layer now, so it hands each
   * recipient to it — and with no mail provider connected the honest outcome
   * is a queued message, which is what these assert.
   */
  assert.equal(issued.json.dispatches.length, 1);
  assert.equal(issued.json.dispatches[0].to, "x@example.com");
  assert.equal(issued.json.dispatches[0].status, "QUEUED",
    "minutes were recorded as sent with no provider to send them");
  assert.match(issued.json.delivery, /nothing has been sent yet/i);

  /* And it is really in the outbox, against the meeting it came from. */
  const box = await call("/dispatches/outbox?view=queued", { cookie });
  assert.equal(box.json.count, 1);
  assert.equal(box.json.dispatches[0].meetingId, m.id);
  assert.match(box.json.dispatches[0].subject, /Minutes — Site progress/);
});

/* ---------------------------------------------------------------- *
 * DECISIONS
 * ---------------------------------------------------------------- */

test("a decision register only moves forwards", { skip }, async () => {
  const { cookie } = await company();
  const pid = await project(cookie);
  const d = await call("/decisions", { method: "POST", cookie,
    body: { projectId: pid, subject: "Cladding specification", options: "Aluminium, or render" } });
  assert.equal(d.status, 201);
  assert.match(d.json.decision.ref, /^DEC-\d{4}$/);

  const move = (to: Wire, body: Wire) => call(`/decisions/${d.json.decision.id}/status`, {
    method: "POST", cookie, body: { status: to, ...(body || {}) } });

  assert.equal((await move("UNDER_REVIEW")).status, 200);
  assert.equal((await move("APPROVED", { ownerName: "Grace Wanjiru" })).status, 200);
  assert.equal((await move("IMPLEMENTED")).status, 200);
  assert.equal((await move("CLOSED")).status, 200);

  /* A closed decision is not reopened — a changed mind is a new decision. */
  const back = await move("OPEN");
  assert.equal(back.status, 409);
  assert.match(back.json.message, /supersedes/i);
});

test("a decision cannot be approved with nobody accountable", { skip }, async () => {
  const { cookie } = await company();
  const d = await call("/decisions", { method: "POST", cookie,
    body: { projectId: await project(cookie), subject: "Lift supplier" } });

  const bare = await call(`/decisions/${d.json.decision.id}/status`, {
    method: "POST", cookie, body: { status: "APPROVED" } });
  assert.equal(bare.status, 400, "a decision was approved with no owner");

  const ok = await call(`/decisions/${d.json.decision.id}/status`, {
    method: "POST", cookie, body: { status: "APPROVED", ownerName: "Peter Mwangi" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.decision.decidedOn, "an approved decision was not dated");
});

test("rejecting a decision keeps the reasoning", { skip }, async () => {
  const { cookie } = await company();
  const d = await call("/decisions", { method: "POST", cookie,
    body: { projectId: await project(cookie), subject: "Basement extension" } });

  assert.equal((await call(`/decisions/${d.json.decision.id}/status`, {
    method: "POST", cookie, body: { status: "REJECTED" } })).status, 400);

  const res = await call(`/decisions/${d.json.decision.id}/status`, {
    method: "POST", cookie, body: { status: "REJECTED", note: "Ground conditions" } });
  assert.equal(res.status, 200);

  const back = await call(`/decisions/${d.json.decision.id}`, { cookie });
  const hist = back.json.decision.history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].status, "REJECTED");
  assert.equal(hist[0].note, "Ground conditions");
  assert.ok(hist[0].byName, "the history does not say who");
});

test("the history is append-only — every move leaves a row", { skip }, async () => {
  const { cookie } = await company();
  const d = await call("/decisions", { method: "POST", cookie,
    body: { projectId: await project(cookie), subject: "Roof finish" } });
  const id = d.json.decision.id;
  await call(`/decisions/${id}/status`, { method: "POST", cookie, body: { status: "UNDER_REVIEW" } });
  await call(`/decisions/${id}/status`, { method: "POST", cookie, body: { status: "APPROVED", ownerName: "A" } });
  await call(`/decisions/${id}/status`, { method: "POST", cookie, body: { status: "IMPLEMENTED" } });

  const back = await call(`/decisions/${id}`, { cookie });
  assert.deepEqual(back.json.decision.history.map((h: Wire) => h.status),
    ["UNDER_REVIEW", "APPROVED", "IMPLEMENTED"],
    "the register does not show how it got here");
});

/* ---------------------------------------------------------------- *
 * TASKS
 * ---------------------------------------------------------------- */

test("a decision produces tasks that know where they came from", { skip }, async () => {
  /* THE LOOP. meeting → decision → task, traceable in both directions. */
  const { cookie } = await company();
  const pid = await project(cookie);
  const m = await meeting(cookie, pid);
  const d = await call("/decisions", { method: "POST", cookie,
    body: { projectId: pid, meetingId: m.id, subject: "Re-tender the cladding" } });

  const t = await call("/tasks", { method: "POST", cookie,
    body: { projectId: pid, meetingId: m.id, decisionId: d.json.decision.id,
            title: "Issue tender pack", priority: "HIGH", dueOn: "2026-04-15" } });
  assert.equal(t.status, 201, t.text.slice(0, 200));
  assert.match(t.json.task.ref, /^TSK-\d{4}$/);

  const back = await call(`/tasks/${t.json.task.id}`, { cookie });
  assert.equal(back.json.task.meeting.ref, m.ref);
  assert.equal(back.json.task.decision.ref, d.json.decision.ref);
});

test("a task is assigned, reassigned, and only to this company", { skip }, async () => {
  const { cookie } = await company();
  const t = await call("/tasks", { method: "POST", cookie, body: { title: "Chase the QS" } });
  const id = t.json.task.id;

  const first = await call(`/tasks/${id}/assign`, { method: "POST", cookie,
    body: { assigneeName: "Grace Wanjiru" } });
  assert.equal(first.status, 200);
  assert.equal(first.json.reassigned, false);

  const second = await call(`/tasks/${id}/assign`, { method: "POST", cookie,
    body: { assigneeName: "Peter Mwangi" } });
  assert.equal(second.json.reassigned, true, "a reassignment was not recognised as one");

  /* Somebody outside this company cannot be given work in it. */
  const stranger = await db.user.create({
    data: { email: `out${++seq}@example.com`, name: "Outsider", googleSub: `s${seq}` } });
  const bad = await call(`/tasks/${id}/assign`, { method: "POST", cookie,
    body: { assigneeId: stranger.id } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /not a member/i);
});

test("a parent task cannot be finished while its subtasks are open", { skip }, async () => {
  const { cookie } = await company();
  const parent = await call("/tasks", { method: "POST", cookie, body: { title: "Close out level 3" } });
  const pid = parent.json.task.id;
  const child = await call("/tasks", { method: "POST", cookie,
    body: { title: "Snag the corridors", parentId: pid } });

  const early = await call(`/tasks/${pid}/done`, { method: "POST", cookie });
  assert.equal(early.status, 409, "a parent was closed over open children");
  assert.match(early.json.message, /subtask/i);

  await call(`/tasks/${child.json.task.id}/done`, { method: "POST", cookie });
  const now = await call(`/tasks/${pid}/done`, { method: "POST", cookie });
  assert.equal(now.status, 200);
  assert.ok(now.json.task.completedAt, "a finished task was not stamped");
});

test("reopening a task clears the fact that it was finished", { skip }, async () => {
  const { cookie } = await company();
  const t = await call("/tasks", { method: "POST", cookie, body: { title: "Re-test the pumps" } });
  const id = t.json.task.id;
  await call(`/tasks/${id}/done`, { method: "POST", cookie });

  const re = await call(`/tasks/${id}/reopen`, { method: "POST", cookie });
  assert.equal(re.status, 200);
  assert.equal(re.json.task.status, "TODO");
  assert.equal(re.json.task.completedAt, null,
    "a reopened task was still stamped as completed — finished and unfinished at once");
});

test("a task finished after its date says so", { skip }, async () => {
  const { cookie } = await company();
  const t = await call("/tasks", { method: "POST", cookie,
    body: { title: "Late one", dueOn: "2020-01-01" } });
  const done = await call(`/tasks/${t.json.task.id}/done`, { method: "POST", cookie });
  assert.equal(done.json.late, true, "a task finished six years late read as on time");
});

test("checklists and comments persist against the task", { skip }, async () => {
  const { cookie } = await company();
  const t = await call("/tasks", { method: "POST", cookie, body: { title: "Handover pack" } });
  const id = t.json.task.id;

  const one = await call(`/tasks/${id}/checklist`, { method: "POST", cookie, body: { text: "O&M manuals" } });
  await call(`/tasks/${id}/checklist`, { method: "POST", cookie, body: { text: "Warranties" } });
  assert.equal(one.status, 201);

  await call(`/tasks/${id}/checklist/${one.json.item.id}/toggle`, { method: "POST", cookie });
  await call(`/tasks/${id}/comments`, { method: "POST", cookie, body: { body: "Waiting on the M&E contractor." } });

  const back = await call(`/tasks/${id}`, { cookie });
  assert.equal(back.json.task.checklist.length, 2);
  assert.equal(back.json.task.checklist.find((c: Wire) => c.id === one.json.item.id).done, true);
  assert.ok(back.json.task.checklist.find((c: Wire) => c.id === one.json.item.id).doneAt);
  assert.equal(back.json.task.comments.length, 1);
  assert.ok(back.json.task.comments[0].byName, "a comment with nobody against it");
});

test("my tasks are the six lists somebody actually works from", { skip }, async () => {
  const { cookie, name } = await company();
  const mk = async (title: Wire, extra: Wire) => {
    const t = await call("/tasks", { method: "POST", cookie, body: { title, ...extra } });
    await call(`/tasks/${t.json.task.id}/assign`, { method: "POST", cookie, body: { assigneeName: name } });
    return t.json.task.id;
  };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  await mk("Overdue one", { dueOn: "2020-01-01" });
  await mk("Today one", { dueOn: today.toISOString() });
  await mk("Soon one", { dueOn: new Date(Date.now() + 3 * 864e5).toISOString() });
  await mk("Someday one", { dueOn: new Date(Date.now() + 90 * 864e5).toISOString() });

  const overdue = await call("/tasks/mine?view=overdue", { cookie });
  assert.equal(overdue.json.count, 1, "overdue is wrong");
  const todayList = await call("/tasks/mine?view=today", { cookie });
  assert.equal(todayList.json.count, 1, "today is wrong");
  const upcoming = await call("/tasks/mine?view=upcoming", { cookie });
  assert.equal(upcoming.json.count, 1, "upcoming should be the next seven days only");

  const assigned = await call("/tasks/mine?view=assigned", { cookie });
  assert.equal(assigned.json.count, 4);
  /* The counts come with every view, so a screen can show the tabs without
     four more requests. */
  assert.equal(assigned.json.counts.overdue, 1);

  const bad = await call("/tasks/mine?view=nonsense", { cookie });
  assert.equal(bad.status, 400);
});

test("a done task leaves every open list", { skip }, async () => {
  const { cookie, name } = await company();
  const t = await call("/tasks", { method: "POST", cookie, body: { title: "Finish me", dueOn: "2020-01-01" } });
  await call(`/tasks/${t.json.task.id}/assign`, { method: "POST", cookie, body: { assigneeName: name } });
  assert.equal((await call("/tasks/mine?view=overdue", { cookie })).json.count, 1);

  await call(`/tasks/${t.json.task.id}/done`, { method: "POST", cookie });
  assert.equal((await call("/tasks/mine?view=overdue", { cookie })).json.count, 0,
    "a finished task is still being chased");
});

/* ---------------------------------------------------------------- *
 * TENANCY AND THE TRAIL
 * ---------------------------------------------------------------- */

test("none of it crosses a company", { skip }, async () => {
  const mine = await company();
  const theirs = await company();
  const pid = await project(theirs.cookie);
  const m = await meeting(theirs.cookie, pid);
  const d = await call("/decisions", { method: "POST", cookie: theirs.cookie,
    body: { projectId: pid, subject: "Theirs" } });
  const t = await call("/tasks", { method: "POST", cookie: theirs.cookie, body: { title: "Theirs" } });

  assert.equal((await call(`/meetings/${m.id}/hold`, { method: "POST", cookie: mine.cookie })).status, 404);
  assert.equal((await call(`/decisions/${d.json.decision.id}/status`, {
    method: "POST", cookie: mine.cookie, body: { status: "APPROVED", ownerName: "X" } })).status, 404);
  assert.equal((await call(`/tasks/${t.json.task.id}/done`, { method: "POST", cookie: mine.cookie })).status, 404);
  assert.equal((await call("/tasks/mine?view=all", { cookie: mine.cookie })).json.count, 0);
});

test("every move in the loop is recorded", { skip }, async () => {
  const { orgId, cookie } = await company();
  const pid = await project(cookie);
  const m = await meeting(cookie, pid);
  await call(`/meetings/${m.id}/hold`, { method: "POST", cookie, body: {} });
  const d = await call("/decisions", { method: "POST", cookie, body: { projectId: pid, subject: "S" } });
  await call(`/decisions/${d.json.decision.id}/status`, { method: "POST", cookie,
    body: { status: "APPROVED", ownerName: "A" } });
  const t = await call("/tasks", { method: "POST", cookie, body: { title: "T" } });
  await call(`/tasks/${t.json.task.id}/assign`, { method: "POST", cookie, body: { assigneeName: "A" } });
  await call(`/tasks/${t.json.task.id}/done`, { method: "POST", cookie });

  const events = await db.auditEvent.findMany({ where: { orgId }, select: { action: true } });
  const actions = new Set(events.map((e) => e.action));
  for (const want of ["meeting.hold", "decision.status", "task.assign", "task.done"]) {
    assert.ok(actions.has(want), `${want} was not recorded`);
  }
});
