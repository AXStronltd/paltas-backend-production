/* ======================================================================
 * MONEY THE COMPANY IS HOLDING, AND DOES NOT OWN.
 *
 * A tenancy deposit is the TENANT's money. `Lease.deposit` has carried a
 * figure from the beginning and said nothing about whether it arrived, where
 * it sits, what was kept at the end or what went back — so a company could
 * record the agreement and nothing else.
 *
 * The bar here is higher than for rent, and for a reason that is not technical:
 * the person whose money this is is not in the room when any of these
 * decisions is taken. So the tests below are mostly about refusals — keeping
 * more than is held, keeping money without saying why, keeping more while the
 * tenant is objecting, settling another tenant's debt out of it — and about
 * the one accounting fact everything rests on: a deposit is a LIABILITY, and
 * booking it as income means paying tax on money you have to give back.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* Its own schema, dropped and rebuilt every run. */
const SCHEMA = "test_deposits";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping deposit tests";
let dbHelp: string | null = null;

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

/* ---------------------------------------------------------------- rig */

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

async function signIn({ email, name, orgId }: { email: string; name: string; orgId?: string }) {
  const user = await db.user.upsert({
    where: { email },
    create: { email, name, googleSub: "sub_" + email },
    update: {},
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: orgId || null,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return { user, cookie: `paltas_session=${token}` };
}

let seq = 0;
async function company(
  { role = "OWNER", country = "ke" }:
  { role?: import("@prisma/client").$Enums.Role; country?: string } = {},
) {
  const n = ++seq;
  const org = await db.organization.create({
    data: {
      name: `Deposit Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `dep${n}@example.com`, name: `Person ${n}`, orgId: org.id,
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  return { org, user, cookie };
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

/** The chart, seeded, as a code → id map. */
async function chartOf(cookie: string) {
  await call("/ledger/accounts/seed", { method: "POST", cookie });
  const { json } = await call("/ledger/accounts", { cookie });
  return Object.fromEntries((json.accounts as Wire[]).map((a: Wire) => [a.code, a.id]));
}

if (!skip) { test.before(boot); }
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.$disconnect();
  if (dbHelp) console.log("\n" + "─".repeat(72) + "\n" + dbHelp + "\n" + "─".repeat(72) + "\n");
});

/* ---------------------------------------------------------------- scene */

/** A live tenancy, with a deposit figure agreed on the lease. */
async function tenancy(orgId: string, over: Record<string, unknown> = {}) {
  const site = await db.site.create({ data: { orgId, name: "Riverside Court" } });
  const unit = await db.unit.create({
    data: { orgId, siteId: site.id, ref: String(over["unitRef"] || "A-101") } });
  const tenant = await db.party.create({
    data: { orgId, name: String(over["tenantName"] || "Grace Wanjiru"), kind: "TENANT" } });
  const lease = await db.lease.create({
    data: {
      orgId, unitId: unit.id, tenantId: tenant.id,
      ref: "L-" + Math.random().toString(36).slice(2, 8),
      unitRef: String(over["unitRef"] || "A-101"),
      tenantName: String(over["tenantName"] || "Grace Wanjiru"),
      rent: 13500000n, deposit: 27000000n, currency: "KES",
      rentDay: 1, startsOn: new Date("2026-01-01T00:00:00Z"), status: "ACTIVE",
      ...over,
    },
  });
  return { site, unit, tenant, lease };
}

/** A deposit, opened and holding `held` minor units. */
async function holding(
  cookie: string, orgId: string, held: bigint | null = 27000000n,
  over: Record<string, unknown> = {},
) {
  const { lease, tenant, unit } = await tenancy(orgId, over);
  const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  assert.equal(open.status, 201, open.text.slice(0, 200));
  const deposit = open.json.deposit as Wire;
  if (held && held > 0n) {
    const got = await call(`/deposits/${deposit.id}/receive`, {
      method: "POST", cookie, body: { amount: Number(held), method: "BANK" },
    });
    assert.equal(got.status, 201, got.text.slice(0, 200));
  }
  return { deposit, lease, tenant, unit };
}

const figuresOf = (r: Reply) => r.json.figures as Record<string, string>;

/* ====================================================================== *
 * OPENING ONE
 * ====================================================================== */

test("a deposit is opened against a tenancy, and holds nothing yet", { skip }, async () => {
  /*
   * THE FIRST WAY THIS FEATURE COULD LIE. A deposit that says it holds money
   * the moment it is created would show a company holding deposits it has
   * never received — and the figure it must not spend would be wrong upwards.
   */
  const { org, cookie } = await company();
  const { lease } = await tenancy(org.id);

  const res = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  assert.equal(res.status, 201, res.text.slice(0, 200));

  const d = res.json.deposit as Wire;
  assert.match(String(d.ref), /^DEP-/, "a deposit is numbered, like every document");
  assert.equal(d.status, "DUE", "it claims to hold money before any arrived");
  assert.equal(String(d.required), "27000000", "the figure the agreement asks for, off the lease");
  assert.equal(d.currency, "KES", "the lease's currency, not the company's");
  assert.equal(d.partyId, (await db.lease.findUnique({ where: { id: lease.id } }))!.tenantId,
    "it does not know whose money it is");

  const f = figuresOf(res);
  assert.equal(f.held, "0");
  assert.equal(f.received, "0");
  assert.equal(f.deductible, "0", "it offers a deduction out of nothing");
});

test("one tenancy holds one deposit, and the second is refused in words", { skip }, async () => {
  const { org, cookie } = await company();
  const { lease } = await tenancy(org.id);
  await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });

  const again = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  assert.equal(again.status, 409, again.text.slice(0, 200));
  assert.match(again.text, /already open against this tenancy/);
  assert.match(again.text, /receive/, "it does not say what to do instead");
});

test("there is no POST /deposits — the path says where to go", { skip }, async () => {
  /*
   * The ceiling, the currency and the agreed figure all come off the lease, so
   * a bare create could check none of them. The refusal has to explain itself:
   * a 404 would read like the feature is missing.
   */
  const { cookie } = await company();
  const res = await call("/deposits", { method: "POST", cookie, body: { required: 100 } });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  assert.match(res.text, /leases\/:id\/deposit/, res.text.slice(0, 200));
});

test("asking about a tenancy with no deposit is an answer, not an error", { skip }, async () => {
  const { org, cookie } = await company();
  const { lease } = await tenancy(org.id);
  const res = await call(`/leases/${lease.id}/deposit`, { cookie });
  assert.equal(res.status, 200, res.text.slice(0, 160));
  assert.equal(res.json.deposit, null);
  assert.equal(res.json.required, "27000000", "it does not say what was agreed");
  assert.match(String(res.json.why), /No deposit has been opened/);
});

/* ====================================================================== *
 * TAKING IT IN
 * ====================================================================== */

test("money arriving is held, and the status says so", { skip }, async () => {
  const { org, cookie } = await company();
  const { lease } = await tenancy(org.id);
  const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  const id = (open.json.deposit as Wire).id;

  const res = await call(`/deposits/${id}/receive`, {
    method: "POST", cookie, body: { amount: 27000000, method: "BANK", reference: "FT2026" },
  });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  assert.equal((res.json.deposit as Wire).status, "HELD");
  assert.equal(figuresOf(res).held, "27000000");
  assert.equal(figuresOf(res).returnable, "27000000");
});

test("short of what was agreed reads PARTIAL — the state a landlord chases", { skip }, async () => {
  const { org, cookie } = await company();
  const { lease } = await tenancy(org.id);
  const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  const res = await call(`/deposits/${(open.json.deposit as Wire).id}/receive`, {
    method: "POST", cookie, body: { amount: 10000000 },
  });
  assert.equal((res.json.deposit as Wire).status, "PARTIAL");
  assert.equal(figuresOf(res).held, "10000000");
});

test("a top-up is a second receipt on the same deposit", { skip }, async () => {
  /* Rents rise and deposits are topped up to match. The agreement's figure
     does not change retrospectively, and the two receipts both survive. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, 10000000n);
  const res = await call(`/deposits/${deposit.id}/receive`, {
    method: "POST", cookie, body: { amount: 17000000 },
  });
  assert.equal(figuresOf(res).held, "27000000");
  assert.equal((res.json.deposit as Wire).status, "HELD");
  const movements = await db.depositMovement.findMany({ where: { depositId: deposit.id } });
  assert.equal(movements.length, 2, "the first receipt was overwritten rather than added to");
});

test("more than the agreement asks for is accepted, not refused", { skip }, async () => {
  /* It has already arrived. A record-keeping system that refuses money in the
     account is worse than one that records a number nobody expected. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, null);
  const res = await call(`/deposits/${deposit.id}/receive`, {
    method: "POST", cookie, body: { amount: 30000000 },
  });
  assert.equal(res.status, 201, res.text.slice(0, 160));
  assert.equal(figuresOf(res).held, "30000000");
  assert.equal((res.json.deposit as Wire).status, "HELD");
});

test("another currency is refused, with the reason", { skip }, async () => {
  /* There is no exchange-rate source anywhere in this service, and a silent
     1:1 fallback has been refused everywhere else. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, null);
  const res = await call(`/deposits/${deposit.id}/receive`, {
    method: "POST", cookie, body: { amount: 1000, currency: "USD" },
  });
  assert.equal(res.status, 400, res.text.slice(0, 160));
  assert.match(res.text, /KES/);
  assert.match(res.text, /exchange rate/);
});

/* ====================================================================== *
 * KEEPING SOME OF IT — the act everything here is careful about
 * ====================================================================== */

test("a deduction needs a sentence", { skip }, async () => {
  /*
   * This is a company keeping somebody else's money while they are not in the
   * room. "Deducted 40,000" with no reason is indefensible in any forum that
   * later asks, which is every forum that ever asks about a deposit.
   */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 4000000 },
  });
  assert.equal(res.status, 400, res.text.slice(0, 160));
  assert.match(res.text, /needs a reason/);
  assert.match(res.text, /somebody else's money/);
});

test("a deduction comes off what is held, and the rest stays the tenant's", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 4000000, reason: "Broken window in the second bedroom" },
  });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  const f = figuresOf(res);
  assert.equal(f.deducted, "4000000");
  assert.equal(f.held, "23000000", "what is left is wrong, which is the tenant's money");
  assert.equal((res.json.deposit as Wire).status, "PARTIAL",
    "less than the agreement requires is held, and nothing says so");
});

test("MORE THAN IS HELD IS REFUSED, and the refusal says what to do", { skip }, async () => {
  /*
   * The hard ceiling. A company cannot keep money it does not have, and the
   * tempting mistake — deducting the whole arrears when the deposit only
   * covers part — turns a debt into a deduction and loses the rest of the
   * debt entirely.
   */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, 10000000n);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 12000000, reason: "Unpaid rent and damage" },
  });
  assert.equal(res.status, 400, res.text.slice(0, 200));
  assert.match(res.text, /more than is being held/);
  assert.match(res.text, /10000000/, "it does not say how much is left");
  assert.match(res.text, /a debt, not a deduction/);

  const after = await db.depositMovement.count({ where: { depositId: deposit.id, kind: "DEDUCTED" } });
  assert.equal(after, 0, "it was refused and recorded anyway");
});

test("deducting everything settles the deposit", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, 10000000n);
  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 10000000, reason: "Rent arrears for two months" },
  });
  assert.equal((res.json.deposit as Wire).status, "SETTLED");
  assert.equal(figuresOf(res).held, "0");
  assert.equal(figuresOf(res).deductible, "0");
});

test("a zero or negative deduction is refused", { skip }, async () => {
  /* The direction is which act this is, never the sign of the amount: a
     negative deduction would be a top-up nobody authorised. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  for (const amount of [0, -5000, 1.5]) {
    const res = await call(`/deposits/${deposit.id}/deduct`, {
      method: "POST", cookie, body: { amount, reason: "Trying it on" },
    });
    assert.equal(res.status, 400, `${amount} was accepted: ${res.text.slice(0, 120)}`);
  }
});

/* ====================================================================== *
 * ARREARS — the commonest use, and the one that must not go wrong
 * ====================================================================== */

/** An issued invoice against this tenancy, for `amount`. */
async function arrears(cookie: string, leaseId: string, partyId: string, amount: number) {
  const made = await call("/invoices", {
    method: "POST", cookie,
    body: { leaseId, partyId, currency: "KES", status: "SENT" },
  });
  assert.equal(made.status, 201, made.text.slice(0, 200));
  const inv = made.json.invoice as Wire;
  const line = await call(`/invoices/${inv.id}/lines`, {
    method: "POST", cookie,
    body: { detail: "Rent — September 2026", quantity: 1, unitPrice: amount, taxBps: 0 },
  });
  assert.equal(line.status, 201, line.text.slice(0, 200));
  return inv;
}

test("A DEDUCTION FOR ARREARS SETTLES THE INVOICE", { skip }, async () => {
  /*
   * THE SINGLE WORST THING THIS FEATURE COULD DO is take rent out of a deposit
   * and leave the invoice outstanding — Collections then chases a tenant for
   * money the company has already taken, and the tenant is being asked twice
   * for one month's rent.
   */
  const { org, cookie } = await company();
  const { deposit, lease, tenant } = await holding(cookie, org.id);
  const invoice = await arrears(cookie, lease.id, tenant.id, 13500000);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 13500000, reason: "September rent, unpaid at move-out", invoiceId: invoice.id },
  });
  assert.equal(res.status, 201, res.text.slice(0, 300));

  const after = res.json.invoice as Wire;
  assert.equal(String(after.paid), "13500000", "the invoice is still owed");
  assert.equal(after.status, "PAID", `the invoice reads ${after.status}`);
  assert.equal(figuresOf(res).held, "13500000", "the deposit did not fall");

  /* And it is a real payment, pointing back at where the money came from. */
  const payment = res.json.payment as Wire;
  assert.ok(payment, "nothing settled the invoice");
  assert.equal(payment.fromDepositId, deposit.id,
    "the payment does not say it came out of the deposit — so anything counting "
    + "cash received will count this money twice");
  assert.equal(payment.method, "OTHER", "it claims a bank or cash movement that never happened");
});

test("a deduction may not settle another tenant's debt", { skip }, async () => {
  /*
   * Without this, one tenant's deposit pays another's rent: money taken from
   * somebody who owes nothing, to clear a debt that is not theirs.
   */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, 27000000n, { unitRef: "A-101" });
  const other = await tenancy(org.id, { unitRef: "B-202", tenantName: "Someone Else" });
  const theirs = await arrears(cookie, other.lease.id, other.tenant.id, 5000000);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 5000000, reason: "Covering the other flat", invoiceId: theirs.id },
  });
  assert.equal(res.status, 400, res.text.slice(0, 250));
  assert.match(res.text, /not against this tenancy or this tenant/);
});

test("a deduction may not overpay the invoice it names", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit, lease, tenant } = await holding(cookie, org.id);
  const invoice = await arrears(cookie, lease.id, tenant.id, 5000000);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 9000000, reason: "Rent and some damage together", invoiceId: invoice.id },
  });
  assert.equal(res.status, 400, res.text.slice(0, 250));
  assert.match(res.text, /more than/);
  assert.match(res.text, /with its own reason/, "it does not say what to do instead");
});

test("an invoice that owes nothing cannot be paid out of the deposit again", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit, lease, tenant } = await holding(cookie, org.id);
  const invoice = await arrears(cookie, lease.id, tenant.id, 5000000);
  await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 5000000, reason: "September rent, unpaid", invoiceId: invoice.id },
  });

  const again = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 1000000, reason: "September rent, again", invoiceId: invoice.id },
  });
  assert.equal(again.status, 400, again.text.slice(0, 250));
  assert.match(again.text, /Nothing is owed/);
  assert.match(again.text, /owed money twice/);
});

/* ====================================================================== *
 * GIVING IT BACK
 * ====================================================================== */

test("the balance goes back, and the deposit is settled", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 4000000, reason: "Repainting the hallway" },
  });

  const res = await call(`/deposits/${deposit.id}/return`, {
    method: "POST", cookie,
    body: { amount: 23000000, reason: "Balance returned at end of tenancy", method: "BANK" },
  });
  assert.equal(res.status, 201, res.text.slice(0, 200));
  assert.equal(figuresOf(res).held, "0");
  assert.equal(figuresOf(res).returned, "23000000");
  assert.equal((res.json.deposit as Wire).status, "SETTLED");
});

test("returning more than is held is refused", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id, 10000000n);
  const res = await call(`/deposits/${deposit.id}/return`, {
    method: "POST", cookie, body: { amount: 12000000, reason: "Giving it all back" },
  });
  assert.equal(res.status, 400, res.text.slice(0, 200));
  assert.match(res.text, /more than is being held/);
  assert.match(res.text, /the company's own money going out/);
});

test("a return needs a reason too", { skip }, async () => {
  /* Not because giving money back is suspicious, but because a bank line
     leaving the account with nothing explaining it is what an audit asks
     about, in either direction. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const res = await call(`/deposits/${deposit.id}/return`, {
    method: "POST", cookie, body: { amount: 1000000 },
  });
  assert.equal(res.status, 400, res.text.slice(0, 160));
  assert.match(res.text, /needs a reason/);
});

/* ====================================================================== *
 * WHEN THE TENANT OBJECTS
 * ====================================================================== */

test("a dispute stops further deductions", { skip }, async () => {
  /*
   * A company must not keep taking more out of the money it is holding while
   * the person it belongs to is objecting to what has been taken already.
   */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 4000000, reason: "Damage to the kitchen worktop" },
  });

  const raised = await call(`/deposits/${deposit.id}/dispute`, {
    method: "POST", cookie, body: { reason: "Tenant says the worktop was already marked" },
  });
  assert.equal(raised.status, 200, raised.text.slice(0, 200));
  assert.equal((raised.json.deposit as Wire).status, "DISPUTED");
  assert.equal(figuresOf(raised).deductible, "0", "it still offers a deduction");

  const more = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 1000000, reason: "And the carpet as well" },
  });
  assert.equal(more.status, 400, more.text.slice(0, 200));
  assert.match(more.text, /in dispute/);
});

test("A DISPUTE DOES NOT STOP A RETURN", { skip }, async () => {
  /*
   * Deliberate, and the opposite of the rule above. Giving money back is never
   * the harmful direction, and several jurisdictions require the undisputed
   * part to go back promptly whatever else is unresolved. A system that froze
   * the whole deposit would make the company break that rule by default.
   */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  await call(`/deposits/${deposit.id}/dispute`, {
    method: "POST", cookie, body: { reason: "Tenant contests the cleaning charge" },
  });

  const res = await call(`/deposits/${deposit.id}/return`, {
    method: "POST", cookie,
    body: { amount: 20000000, reason: "The part nobody is arguing about" },
  });
  assert.equal(res.status, 201, res.text.slice(0, 250));
  assert.equal(figuresOf(res).held, "7000000");
  assert.equal((res.json.deposit as Wire).status, "DISPUTED",
    "the dispute was cleared by a figure changing");
});

test("resolving a dispute keeps what it was about", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  await call(`/deposits/${deposit.id}/dispute`, {
    method: "POST", cookie, body: { reason: "Tenant contests the cleaning charge" },
  });

  const res = await call(`/deposits/${deposit.id}/resolve`, {
    method: "POST", cookie, body: { reason: "Charge withdrawn after the inventory was checked" },
  });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  const d = res.json.deposit as Wire;
  assert.equal(d.disputed, false);
  assert.equal(d.status, "HELD", "the status did not go back to what the figures say");
  assert.match(String(d.disputeReason), /contests the cleaning charge/,
    "the original complaint was overwritten");
  assert.match(String(d.disputeReason), /resolved:/);
  assert.ok(d.resolvedAt, "nothing says when it ended");

  /* And deductions work again. */
  const after = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 1000000, reason: "The agreed cleaning charge" },
  });
  assert.equal(after.status, 201, after.text.slice(0, 200));
});

test("a dispute cannot be raised twice, or resolved when there is none", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const none = await call(`/deposits/${deposit.id}/resolve`, {
    method: "POST", cookie, body: { reason: "Nothing to resolve here" },
  });
  assert.equal(none.status, 409, none.text.slice(0, 160));

  await call(`/deposits/${deposit.id}/dispute`, {
    method: "POST", cookie, body: { reason: "Tenant objects to the charge" } });
  const twice = await call(`/deposits/${deposit.id}/dispute`, {
    method: "POST", cookie, body: { reason: "Tenant objects again" } });
  assert.equal(twice.status, 409, twice.text.slice(0, 160));
});

/* ====================================================================== *
 * UNDOING A MISTAKE
 * ====================================================================== */

test("voiding a deduction gives the money back", { skip }, async () => {
  /* Excluded from every sum, and the row stays saying what was tried. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const made = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 4000000, reason: "Charged to the wrong tenancy" },
  });
  const movementId = (made.json.movement as Wire).id;

  const res = await call(`/deposit-movements/${movementId}/void`, {
    method: "POST", cookie, body: { reason: "Wrong tenancy — this was B-202" },
  });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(figuresOf(res).held, "27000000", "the money did not come back");
  assert.equal(figuresOf(res).deducted, "0");
  assert.equal((res.json.deposit as Wire).status, "HELD");

  const row = await db.depositMovement.findUnique({ where: { id: movementId } });
  assert.ok(row, "the movement was deleted rather than voided");
  assert.equal(row.voided, true);
  assert.match(row.voidReason, /Wrong tenancy/);
});

test("VOIDING AN ARREARS DEDUCTION MAKES THE INVOICE OWED AGAIN", { skip }, async () => {
  /*
   * Otherwise the invoice stays settled out of money the company has just
   * given back — a debt that disappeared because of a correction, which is the
   * quietest way for money to go missing.
   */
  const { org, cookie } = await company();
  const { deposit, lease, tenant } = await holding(cookie, org.id);
  const invoice = await arrears(cookie, lease.id, tenant.id, 5000000);
  const made = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 5000000, reason: "September rent, unpaid", invoiceId: invoice.id },
  });
  assert.equal((made.json.invoice as Wire).status, "PAID");

  const res = await call(`/deposit-movements/${(made.json.movement as Wire).id}/void`, {
    method: "POST", cookie, body: { reason: "The tenant had in fact paid by cheque" },
  });
  assert.equal(res.status, 200, res.text.slice(0, 250));

  const after = res.json.invoice as Wire;
  assert.equal(String(after.paid), "0", "the invoice is still settled out of returned money");
  assert.notEqual(after.status, "PAID");
  assert.equal(figuresOf(res).held, "27000000");

  const payments = await db.payment.findMany({ where: { invoiceId: invoice.id } });
  assert.equal(payments.length, 1, "the payment was deleted rather than voided");
  assert.equal(payments[0]!.voided, true);
});

test("a void needs a reason, and cannot happen twice", { skip }, async () => {
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const made = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 1000000, reason: "Something that will be undone" },
  });
  const id = (made.json.movement as Wire).id;

  const bare = await call(`/deposit-movements/${id}/void`, { method: "POST", cookie, body: {} });
  assert.equal(bare.status, 400, bare.text.slice(0, 160));

  await call(`/deposit-movements/${id}/void`, {
    method: "POST", cookie, body: { reason: "Entered against the wrong unit" } });
  const twice = await call(`/deposit-movements/${id}/void`, {
    method: "POST", cookie, body: { reason: "Entered against the wrong unit" } });
  assert.equal(twice.status, 409, twice.text.slice(0, 160));
});

/* ====================================================================== *
 * THE BOOKS — a deposit is a LIABILITY, and never revenue
 * ====================================================================== */

async function entriesFor(cookie: string, movementId: string) {
  const { json } = await call("/ledger/entries", { cookie });
  return (json.entries as Wire[]).filter((e: Wire) => e.sourceId === movementId);
}

test("MONEY ARRIVING IS BOOKED AS A LIABILITY, NOT AS INCOME", { skip }, async () => {
  /*
   * The accounting fact the whole feature rests on. A company that books
   * deposits as revenue overstates what it earned, pays tax on money it has to
   * give back, and reads its own bank balance as spendable when part of it
   * belongs to its tenants.
   *
   * 2100 "Tenant deposits held" has been in the starting chart from the
   * beginning with nothing posting to it. This is what posts to it.
   */
  const { org, cookie } = await company();
  const chart = await chartOf(cookie);
  const { lease } = await tenancy(org.id);
  const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  const res = await call(`/deposits/${(open.json.deposit as Wire).id}/receive`, {
    method: "POST", cookie, body: { amount: 27000000, method: "BANK" },
  });

  const booking = res.json.booking as Wire;
  assert.ok(booking && booking.booked, `nothing was booked: ${JSON.stringify(booking)}`);

  const [entry] = await entriesFor(cookie, (res.json.movement as Wire).id);
  assert.ok(entry, "the movement is not in the books");
  const lines = entry.lines as Wire[];
  const debit = lines.find((l: Wire) => Number(l.debit) > 0);
  const credit = lines.find((l: Wire) => Number(l.credit) > 0);

  assert.equal(debit.accountId, chart["1000"], "the money did not land in the bank");
  assert.equal(credit.accountId, chart["2100"],
    "a tenancy deposit was credited somewhere other than 2100 — if that is an "
    + "income account, this company now owes tax on money it must give back");
  assert.equal(String(credit.credit), "27000000");
});

test("a deduction for damage IS income — and comes out of the liability", { skip }, async () => {
  /* The company really does keep this, so it really is earned, in the period
     it was kept. The repair it pays for is its own expense, separately. */
  const { org, cookie } = await company();
  const chart = await chartOf(cookie);
  const { deposit } = await holding(cookie, org.id);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie, body: { amount: 4000000, reason: "Replacing the bedroom door" },
  });
  const [entry] = await entriesFor(cookie, (res.json.movement as Wire).id);
  assert.ok(entry, "the deduction is not in the books");
  const lines = entry.lines as Wire[];
  const debit = lines.find((l: Wire) => Number(l.debit) > 0);
  const credit = lines.find((l: Wire) => Number(l.credit) > 0);

  assert.equal(debit.accountId, chart["2100"], "the company still owes the tenant this");
  assert.equal(credit.accountId, chart["4090"], "what it kept was not recognised at all");
});

test("a deduction for ARREARS is not income — the rent was earned already", { skip }, async () => {
  /*
   * Crediting income here would count the same rent twice: once when the
   * invoice was raised, again when the deposit covered it.
   */
  const { org, cookie } = await company();
  const chart = await chartOf(cookie);
  const { deposit, lease, tenant } = await holding(cookie, org.id);
  const invoice = await arrears(cookie, lease.id, tenant.id, 5000000);

  const res = await call(`/deposits/${deposit.id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 5000000, reason: "September rent, unpaid at move-out", invoiceId: invoice.id },
  });
  const [entry] = await entriesFor(cookie, (res.json.movement as Wire).id);
  assert.ok(entry, "the deduction is not in the books");
  const lines = entry.lines as Wire[];
  const debit = lines.find((l: Wire) => Number(l.debit) > 0);
  const credit = lines.find((l: Wire) => Number(l.credit) > 0);

  assert.equal(debit.accountId, chart["2100"]);
  assert.equal(credit.accountId, chart["1100"],
    "the arrears settlement credited income — the same rent is now counted twice");

  /* And the payment that settles the invoice must NOT have been booked a
     second time, or the bank would show cash that never arrived. */
  const payment = res.json.payment as Wire;
  const double = await entriesFor(cookie, payment.id as string);
  assert.equal(double.length, 0,
    "the settlement payment was booked as well, so the books show money arriving in the bank");
});

test("giving it back discharges the liability and touches no income", { skip }, async () => {
  const { org, cookie } = await company();
  const chart = await chartOf(cookie);
  const { deposit } = await holding(cookie, org.id);

  const res = await call(`/deposits/${deposit.id}/return`, {
    method: "POST", cookie,
    body: { amount: 27000000, reason: "Returned in full, no deductions", method: "BANK" },
  });
  const [entry] = await entriesFor(cookie, (res.json.movement as Wire).id);
  const lines = entry.lines as Wire[];
  assert.equal(lines.find((l: Wire) => Number(l.debit) > 0).accountId, chart["2100"]);
  assert.equal(lines.find((l: Wire) => Number(l.credit) > 0).accountId, chart["1000"]);
  for (const l of lines) {
    assert.notEqual(l.accountId, chart["4090"], "returning a deposit reduced income");
    assert.notEqual(l.accountId, chart["4000"], "returning a deposit reduced rent earned");
  }
});

test("with no chart of accounts the money is still recorded, and says why not booked",
  { skip }, async () => {
    /* Bookkeeping never blocks money. A company that has not set up its chart
       must still be able to record a deposit it has physically received. */
    const { org, cookie } = await company();
    const { lease } = await tenancy(org.id);
    const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
    const res = await call(`/deposits/${(open.json.deposit as Wire).id}/receive`, {
      method: "POST", cookie, body: { amount: 27000000 },
    });
    assert.equal(res.status, 201, res.text.slice(0, 200));
    assert.equal(figuresOf(res).held, "27000000");
    const booking = res.json.booking as Wire;
    assert.equal(booking.booked, null, "it claims to have booked something");
    assert.match(String(booking.why || ""), /chart/,
      `it did not say why: ${JSON.stringify(booking)}`);
  });

/* ====================================================================== *
 * WHAT THE COMPANY IS HOLDING, IN TOTAL
 * ====================================================================== */

test("the total held is per currency, because there is no rate to add with", { skip }, async () => {
  const { org, cookie } = await company();
  await holding(cookie, org.id, 27000000n, { unitRef: "A-1" });
  await holding(cookie, org.id, 10000000n, { unitRef: "A-2", currency: "USD", deposit: 100000n });

  const res = await call("/deposits-held", { cookie });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  const rows = res.json.currencies as Wire[];
  const kes = rows.find((r: Wire) => r.currency === "KES");
  const usd = rows.find((r: Wire) => r.currency === "USD");
  assert.equal(kes.held, "27000000");
  assert.equal(usd.held, "10000000");
  assert.equal(rows.length, 2, "two currencies were added into one figure");
});

test("the states are counted, so a landlord knows what to chase", { skip }, async () => {
  const { org, cookie } = await company();
  await holding(cookie, org.id, 27000000n, { unitRef: "A-1" });          /* HELD */
  await holding(cookie, org.id, 5000000n, { unitRef: "A-2" });           /* PARTIAL */
  await holding(cookie, org.id, null, { unitRef: "A-3" });               /* DUE */

  const res = await call("/deposits-held", { cookie });
  const states = res.json.states as Record<string, number>;
  assert.equal(states.HELD, 1);
  assert.equal(states.PARTIAL, 1);
  assert.equal(states.DUE, 1);
});

/* ====================================================================== *
 * WHO MAY DO WHAT
 * ====================================================================== */

/*
 * RECORDING MONEY THAT ARRIVED is a create — refusing it to the person who
 * took the cash is how a record goes unwritten. KEEPING or RETURNING it is
 * the manage level, the same as a credit note: both decide the fate of
 * somebody else's money.
 */
for (const [role, mayRecord, mayKeep] of [
  ["OWNER", true, true],
  ["MANAGER", true, true],
  /* FINANCE may do all of it. Deposits are money, and a finance role exists to
     handle money — the same level that issues a credit note. The roles that
     may not are the ones with no business in the books at all. */
  ["FINANCE", true, true],
  ["LEASING", false, false],
  ["HOUSEKEEPING", false, false],
] as const) {
  test(`${role}: record ${mayRecord ? "yes" : "no"}, deduct ${mayKeep ? "yes" : "no"}`,
    { skip }, async () => {
      const { org, cookie } = await company({ role });
      const { lease } = await tenancy(org.id);

      const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
      if (!mayRecord) {
        assert.ok(open.status === 403 || open.status === 404, `${role} opened one: ${open.status}`);
        return;
      }
      assert.equal(open.status, 201, open.text.slice(0, 200));
      const id = (open.json.deposit as Wire).id;

      const got = await call(`/deposits/${id}/receive`, {
        method: "POST", cookie, body: { amount: 27000000 } });
      assert.equal(got.status, 201, `${role} could not record money arriving: ${got.text.slice(0, 160)}`);

      const kept = await call(`/deposits/${id}/deduct`, {
        method: "POST", cookie, body: { amount: 1000000, reason: "Damage to the front door" } });
      if (mayKeep) assert.equal(kept.status, 201, kept.text.slice(0, 200));
      else assert.ok(kept.status === 403 || kept.status === 404, `${role} kept some: ${kept.status}`);

      const back = await call(`/deposits/${id}/return`, {
        method: "POST", cookie, body: { amount: 1000000, reason: "Partial return at move-out" } });
      if (mayKeep) assert.equal(back.status, 201, back.text.slice(0, 200));
      else assert.ok(back.status === 403 || back.status === 404, `${role} returned some: ${back.status}`);
    });
}

test("a deposit is never deleted, whoever asks", { skip }, async () => {
  /* It is somebody else's money, and the record of what happened to it is the
     only defence a company has if asked. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const res = await call(`/deposits/${deposit.id}`, { method: "DELETE", cookie });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  assert.ok(await db.deposit.findUnique({ where: { id: deposit.id } }), "it was deleted");
});

test("a deposit is not edited through the generic path", { skip }, async () => {
  /* `status` is computed from the movements. A caller who could PATCH it could
     write SETTLED over money the company is still holding. */
  const { org, cookie } = await company();
  const { deposit } = await holding(cookie, org.id);
  const res = await call(`/deposits/${deposit.id}`, {
    method: "PATCH", cookie, body: { status: "SETTLED", required: 1 },
  });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}: ${res.text.slice(0, 160)}`);
  const after = await db.deposit.findUnique({ where: { id: deposit.id } });
  assert.equal(after!.status, "HELD", "the status was overwritten");
});

/* ====================================================================== *
 * ONE COMPANY'S MONEY IS NOT ANOTHER'S
 * ====================================================================== */

test("another company's deposit is not reachable, and not even admitted to", { skip }, async () => {
  const a = await company();
  const b = await company();
  const { deposit } = await holding(a.cookie, a.org.id);

  for (const [path, method, body] of [
    [`/deposits/${deposit.id}`, "GET", undefined],
    [`/deposits/${deposit.id}/receive`, "POST", { amount: 1000 }],
    [`/deposits/${deposit.id}/deduct`, "POST", { amount: 1000, reason: "Taking somebody else's" }],
    [`/deposits/${deposit.id}/return`, "POST", { amount: 1000, reason: "Sending it to myself" }],
    [`/deposits/${deposit.id}/dispute`, "POST", { reason: "Objecting on their behalf" }],
  ] as const) {
    const res = await call(path, { method, cookie: b.cookie, body: body as never });
    assert.ok(res.status === 404 || res.status === 403,
      `${method} ${path} answered ${res.status} to another company`);
  }

  const after = await db.depositMovement.count({ where: { depositId: deposit.id } });
  assert.equal(after, 1, "another company moved money in this deposit");
});

/* ====================================================================== *
 * AND THE WHOLE LIFECYCLE, ONCE, IN ORDER
 * ====================================================================== */

test("a tenancy from agreement to settled", { skip }, async () => {
  const { org, cookie } = await company();
  await chartOf(cookie);
  const { lease, tenant } = await tenancy(org.id);

  /* 1. Agreed. */
  const open = await call(`/leases/${lease.id}/deposit`, { method: "POST", cookie, body: {} });
  const id = (open.json.deposit as Wire).id;
  assert.equal((open.json.deposit as Wire).status, "DUE");

  /* 2. Paid, in two instalments as tenants often do. */
  await call(`/deposits/${id}/receive`, { method: "POST", cookie, body: { amount: 13500000 } });
  const second = await call(`/deposits/${id}/receive`, {
    method: "POST", cookie, body: { amount: 13500000 } });
  assert.equal((second.json.deposit as Wire).status, "HELD");

  /* 3. Held in a named account, because somebody may have to ask which. */
  const account = await db.bankAccount.create({
    data: { orgId: org.id, name: "Deposit account", currency: "KES" } });
  const where = await call(`/deposits/${id}/held-in`, {
    method: "PATCH", cookie, body: { heldInId: account.id } });
  assert.equal(where.status, 200, where.text.slice(0, 200));
  assert.equal((where.json.deposit as Wire).heldInId, account.id);

  /* 4. Move-out: a month of rent unpaid, and a damaged door. */
  const invoice = await arrears(cookie, lease.id, tenant.id, 13500000);
  const rent = await call(`/deposits/${id}/deduct`, {
    method: "POST", cookie,
    body: { amount: 13500000, reason: "September rent, unpaid at move-out", invoiceId: invoice.id },
  });
  assert.equal((rent.json.invoice as Wire).status, "PAID");
  await call(`/deposits/${id}/deduct`, {
    method: "POST", cookie, body: { amount: 3500000, reason: "Bedroom door replaced" } });

  /* 5. The balance back. */
  const back = await call(`/deposits/${id}/return`, {
    method: "POST", cookie,
    body: { amount: 10000000, reason: "Balance returned, agreed with the tenant", method: "BANK" },
  });
  assert.equal(back.status, 201, back.text.slice(0, 200));

  const f = figuresOf(back);
  assert.equal(f.received, "27000000");
  assert.equal(f.deducted, "17000000");
  assert.equal(f.returned, "10000000");
  assert.equal(f.held, "0", "the arithmetic of the whole tenancy does not close");
  assert.equal((back.json.deposit as Wire).status, "SETTLED");

  /* 6. And every step is answerable afterwards. */
  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, entityId: id }, orderBy: { at: "asc" } });
  const actions = trail.map((e) => e.action);
  for (const want of ["deposit.open", "deposit.receive", "deposit.held_in",
                      "deposit.deduct", "deposit.return"]) {
    assert.ok(actions.includes(want), `nothing recorded ${want}: ${actions.join(", ")}`);
  }
  assert.ok(trail.every((e) => e.actorId), "something happened with nobody's name on it");
});
