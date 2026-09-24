/* ====================================================================== *
 * THE THREE NUMBERS ON THE DEVELOPMENT SCREEN.
 *
 * The property console's Development screen shows, per project: how many
 * units are SOLD, how many are RESERVED, and the revenue agreed on the sold
 * ones. It has shown all three since the console was built.
 *
 * None of them was ever computed. The frontend adapter read:
 *
 *     sold: 0, res: 0, built: 0,
 *     revenue: major(r.budget),
 *
 * under a comment saying the sales pipeline was "a pipeline this schema does
 * not model" — which was true. So a developer with a tower half sold saw
 * nothing sold, nothing reserved, no build progress, and a "Revenue banked"
 * figure that was really the CONSTRUCTION BUDGET: a cost, on the line the
 * screen labels "agreed prices on sold units only".
 *
 * `Contract` models the sale now and `projects.rollup` counts it. This is the
 * test that the counting is right, because the failure mode it replaces was
 * not a crash — it was four confident, wrong numbers that looked fine.
 *
 * WHAT IS EASY TO GET WRONG HERE, and is therefore what this asserts:
 *
 *   - a RESERVED unit is committed stock but NOT revenue. Counting deposits
 *     as revenue inflates it by exactly the sales most likely to fall through.
 *   - a CANCELLED reservation counts nowhere. It is why a unit is back on the
 *     market; it is not stock and it is not money.
 *   - one project's sales must never be counted against another.
 *   - a project with no contracts reads 0, not undefined — `undefined` renders
 *     as "NaN%" in the stock-committed tile.
 * ====================================================================== */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DATABASE_URL ||= "postgresql://fake@127.0.0.1:5432/fake";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

const skip = typeof mock.module === "function"
  ? false
  : "run with --experimental-test-module-mocks (npm test does)";

let db, createApp;
if (!skip) {
  const { createFakeDb } = await import("./fake-prisma.js");
  db = createFakeDb();
  mock.module("../src/db.ts", { namedExports: { db, closeDb: async () => {} } });
  ({ createApp } = await import("../src/server.js"));
}

let server, base;
if (!skip) {
  test.before(async () => {
    const app = createApp();
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
}
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

let seq = 0;
async function company() {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Developer ${n}`,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const email = `dev${n}@example.com`;
  const user = await db.user.create({
    data: { email, name: `Dev ${n}`, googleSub: "sub_" + email },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role: "OWNER" } });
  return { org, cookie: `paltas_session=${token}` };
}

async function get(path, cookie) {
  const res = await fetch(base + path, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

/** A contract straight into the database — this tests the counting, not the form. */
let refSeq = 0;
function sale(orgId, projectId, status, price) {
  return db.contract.create({
    data: { orgId, projectId, status, price: BigInt(price), ref: `CON-${++refSeq}` },
  });
}

test("sold counts signed and completed sales, and nothing else", { skip }, async () => {
  const { org, cookie } = await company();
  const p = await db.project.create({
    data: { orgId: org.id, name: "Golden Park Phase 2", units: 120, built: 68 },
  });

  await sale(org.id, p.id, "SOLD", 38_000_000);
  await sale(org.id, p.id, "COMPLETED", 51_000_000);
  await sale(org.id, p.id, "RESERVED", 40_000_000);
  await sale(org.id, p.id, "CANCELLED", 99_000_000);

  const { status, json } = await get("/projects", cookie);
  assert.equal(status, 200);
  const row = json.projects.find((x) => x.id === p.id);

  assert.equal(row.sold, 2, "a sale is SOLD or COMPLETED — a reservation is not one");
  assert.equal(row.reserved, 1, "only RESERVED is reserved");
});

test("a reservation is committed stock, never banked revenue", { skip }, async () => {
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Marina Vista Tower 2" } });

  await sale(org.id, p.id, "SOLD", 38_000_000);
  await sale(org.id, p.id, "COMPLETED", 51_000_000);
  await sale(org.id, p.id, "RESERVED", 40_000_000);

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);

  assert.equal(row.revenue, 89_000_000,
    "revenue is the agreed price of SOLD and COMPLETED units only — the screen " +
    "labels it 'agreed prices on sold units only', and a deposit is not an agreed price");
});

test("a cancelled reservation counts nowhere at all", { skip }, async () => {
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Karen Grove Villas" } });

  await sale(org.id, p.id, "CANCELLED", 99_000_000);

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);

  assert.deepEqual(
    { sold: row.sold, reserved: row.reserved, revenue: row.revenue },
    { sold: 0, reserved: 0, revenue: 0 },
    "a sale that fell through is why a unit is back on the market, not stock and not money");
});

test("one project's sales are never counted against another", { skip }, async () => {
  const { org, cookie } = await company();
  const a = await db.project.create({ data: { orgId: org.id, name: "Project A" } });
  const b = await db.project.create({ data: { orgId: org.id, name: "Project B" } });

  await sale(org.id, a.id, "SOLD", 10_000_000);
  await sale(org.id, a.id, "SOLD", 20_000_000);
  await sale(org.id, b.id, "SOLD", 5_000_000);

  const { json } = await get("/projects", cookie);
  const rowA = json.projects.find((x) => x.id === a.id);
  const rowB = json.projects.find((x) => x.id === b.id);

  assert.deepEqual([rowA.sold, rowA.revenue], [2, 30_000_000]);
  assert.deepEqual([rowB.sold, rowB.revenue], [1, 5_000_000]);
});

test("a project with no sales reads zero, not undefined", { skip }, async () => {
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Not yet selling", units: 40 } });

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);

  /*
   * Not a pedantic check. The screen computes `pct(sold + res, stock)` for its
   * "stock committed" tile — with undefined that renders NaN%, and the build
   * progress bar reads `x.built` straight into a width.
   */
  assert.equal(row.sold, 0);
  assert.equal(row.reserved, 0);
  assert.equal(row.revenue, 0);
  assert.equal(typeof row.built, "number", "built is a column now, not a guess");
});

test("another company's sales are never counted into these", { skip }, async () => {
  /*
   * A developer seeing a competitor's revenue on their own project is the
   * worst failure this system has, so it is asserted end to end.
   *
   * HONESTLY: this passes even if the rollup's own `orgId` filter is deleted,
   * because the query already narrows to `projectId IN (this company's
   * projects)` — the resource framework scoped those rows before the rollup
   * saw them. Verified by deleting it and watching this still pass.
   *
   * The filter stays as defence in depth: it is what keeps the answer right if
   * a contract ever points at a project in another company, which creates
   * cannot produce today but a migration or an import could. What this test
   * proves is the OUTCOME, not that the filter is load-bearing.
   */
  const mine = await company();
  const theirs = await company();

  const p = await db.project.create({ data: { orgId: mine.org.id, name: "Shared name" } });
  const q = await db.project.create({ data: { orgId: theirs.org.id, name: "Shared name" } });

  await sale(mine.org.id, p.id, "SOLD", 1_000_000);
  await sale(theirs.org.id, q.id, "SOLD", 777_000_000);

  const { json } = await get("/projects", mine.cookie);
  assert.equal(json.projects.length, 1, "a company sees only its own projects");
  assert.equal(json.projects[0].revenue, 1_000_000,
    "the other company's sale reached this company's rollup");
});

/* ====================================================================== *
 * HOW FAR BUILT — from the programme, where there is one
 * ====================================================================== */

let phaseSeq = 0;
function phase(orgId, projectId, progress, weight) {
  return db.projectPhase.create({
    data: { orgId, projectId, name: `Phase ${++phaseSeq}`, progress, weight, status: "IN_PROGRESS" },
  });
}

test("a project with no phases keeps the figure somebody typed", { skip }, async () => {
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Typed only", built: 42 } });

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);
  assert.equal(row.phases, 0);
  assert.equal(row.progress, 42, "a project with no programme lost the figure it had");
  assert.equal(row.built, 42, "the typed figure was overwritten");
});

test("phases of equal weight average plainly", { skip }, async () => {
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Even", built: 0 } });
  await phase(org.id, p.id, 100, 0);
  await phase(org.id, p.id, 50, 0);
  await phase(org.id, p.id, 0, 0);

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);
  assert.equal(row.phases, 3);
  assert.equal(row.progress, 50, "three phases at 100, 50 and 0 are half done");
});

test("weight decides how much a phase counts", { skip }, async () => {
  /*
   * THE REASON WEIGHT EXISTS. Ten per cent of the superstructure is not ten
   * per cent of the job. A finished ground survey and an untouched tower are
   * not a half-built development, and a plain average says they are.
   */
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Weighted", built: 0 } });
  await phase(org.id, p.id, 100, 10);   // the survey, done
  await phase(org.id, p.id, 0, 90);     // the tower, not started

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);
  assert.equal(row.progress, 10, "a plain average called this half built");
});

test("the typed figure and the programme are both reported", { skip }, async () => {
  /*
   * Not overwritten, deliberately. A project manager who entered 80 and a
   * programme that comes to 25 needs to see both — one silently replacing the
   * other is how a development reports progress nobody stands behind.
   */
  const { org, cookie } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Disagreeing", built: 80 } });
  await phase(org.id, p.id, 25, 0);

  const { json } = await get("/projects", cookie);
  const row = json.projects.find((x) => x.id === p.id);
  assert.equal(row.built, 80, "the typed figure was lost");
  assert.equal(row.progress, 25, "the programme was ignored");
});

test("one project's phases never count toward another", { skip }, async () => {
  const { org, cookie } = await company();
  const a = await db.project.create({ data: { orgId: org.id, name: "A", built: 0 } });
  const b = await db.project.create({ data: { orgId: org.id, name: "B", built: 0 } });
  await phase(org.id, a.id, 100, 0);

  const { json } = await get("/projects", cookie);
  assert.equal(json.projects.find((x) => x.id === a.id).progress, 100);
  assert.equal(json.projects.find((x) => x.id === b.id).progress, 0,
    "a phase leaked into a project it does not belong to");
});

test("deleting a project takes its programme with it", { skip }, async () => {
  /* Cascade, unlike most references here — an orphan phase would make some
     other project's progress wrong, or none at all. */
  const { org } = await company();
  const p = await db.project.create({ data: { orgId: org.id, name: "Cancelled", built: 0 } });
  await phase(org.id, p.id, 60, 0);
  await db.milestone.create({ data: { orgId: org.id, projectId: p.id, name: "Handover" } });

  await db.project.delete({ where: { id: p.id } });
  assert.equal(await db.projectPhase.count({ where: { projectId: p.id } }), 0);
  assert.equal(await db.milestone.count({ where: { projectId: p.id } }), 0);
});
