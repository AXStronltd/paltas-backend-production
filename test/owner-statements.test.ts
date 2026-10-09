/* ======================================================================
 * WHAT WE COLLECTED, WHAT WE SPENT, WHAT WE KEPT, WHAT YOU ARE OWED.
 *
 * A managing agent does not own the building. It collects the rent, pays the
 * costs, keeps a fee and sends the rest on — and PALTAS could record none of
 * that. The rent of a managed property was booked as the COMPANY's income,
 * because nothing said otherwise, so a managing agent's accounts showed
 * revenue many times what it earned and tax on money belonging to its clients.
 *
 * These tests are mostly about four ways to be quietly wrong about somebody
 * else's money:
 *
 *   whose rent is this      an agreement over ONE UNIT must not be credited
 *                           with the block's rent
 *   collected vs billed     they differ by exactly the arrears, which is the
 *                           number an owner and an agent argue about
 *   which costs             only what somebody marked recoverable, and the
 *                           rest reported rather than silently absorbed
 *   and is it frozen        the owner is holding a copy; a document that
 *                           recomputes itself stops matching theirs
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explain, freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
import { portOf } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/* Its own schema, dropped and rebuilt every run. */
const SCHEMA = "test_owners";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping owner-statement tests";
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
      name: `Owner Co ${n}`, country,
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: { create: [{ product: "PROPERTY_MANAGEMENT" }] },
    },
  });
  const { user, cookie } = await signIn({
    email: `own${n}@example.com`, name: `Person ${n}`, orgId: org.id,
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

const SEP = "2026-09";

/*
 * A PROPERTY THIS COMPANY MANAGES FOR SOMEBODY ELSE, with a tenant in it.
 *
 * The unit reference is per CALL, not a constant. Two of the tests below have
 * one company managing two properties — that is the whole point of them — and
 * a fixed "A-101" collided on Unit's unique (orgId, ref). The failure surfaced
 * as a 500 from prisma.unit.create inside this helper, which reads as a broken
 * route rather than as a reference this file reused.
 */
let managedSeq = 0;

async function managed(
  cookie: string, orgId: string,
  over: { feeBps?: number; basis?: string; feeFixed?: number; unitOnly?: boolean } = {},
) {
  const n = ++managedSeq;
  const unitRef = `A-${100 + n}`;
  const site = await db.site.create({
    data: { orgId, name: `Riverside Court ${n}`, currency: "KES" } });
  const unit = await db.unit.create({ data: { orgId, siteId: site.id, ref: unitRef } });
  const owner = await db.party.create({
    data: { orgId, name: "Amina Yusuf", kind: "OWNER" } });
  const tenant = await db.party.create({
    data: { orgId, name: "Grace Wanjiru", kind: "TENANT" } });
  const lease = await db.lease.create({
    data: {
      orgId, unitId: unit.id, tenantId: tenant.id,
      ref: "L-" + Math.random().toString(36).slice(2, 8),
      unitRef, tenantName: "Grace Wanjiru",
      rent: 13500000n, currency: "KES", rentDay: 1,
      startsOn: new Date("2026-01-01T00:00:00Z"), status: "ACTIVE",
    },
  });

  const made = await call("/management-agreements", {
    method: "POST", cookie,
    body: {
      ownerId: owner.id, siteId: site.id,
      ...(over.unitOnly ? { unitId: unit.id } : {}),
      basis: over.basis || "COLLECTED",
      feeBps: over.feeBps === undefined ? 1000 : over.feeBps,
      ...(over.feeFixed === undefined ? {} : { feeFixed: over.feeFixed }),
      currency: "KES",
    },
  });
  assert.equal(made.status, 201, made.text.slice(0, 250));
  return { site, unit, owner, tenant, lease, agreement: made.json.agreement as Wire };
}

/** An issued invoice against a tenancy, in the period. */
async function billFor(
  cookie: string, leaseId: string, partyId: string, amount: number,
  issuedOn = "2026-09-01",
) {
  const made = await call("/invoices", {
    method: "POST", cookie,
    body: { leaseId, partyId, currency: "KES", status: "SENT", issuedOn },
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

/** Money arriving against an invoice, in the period. */
async function paid(cookie: string, invoiceId: string, amount: number, at = "2026-09-05") {
  const res = await call("/payments", {
    method: "POST", cookie,
    body: { invoiceId, amount, currency: "KES", method: "BANK",
            reference: "FT" + Math.random().toString(36).slice(2, 8),
            receivedAt: at },
  });
  assert.equal(res.status, 201, res.text.slice(0, 250));
  return res.json.payment as Wire;
}

/** A cost against the property, recoverable or not. */
async function cost(
  cookie: string, siteId: string, amount: number,
  { recoverable = true, category = "maintenance", spentOn = "2026-09-10", detail = "Gutter repair" } = {},
) {
  const res = await call("/expenses", {
    method: "POST", cookie,
    body: { siteId, detail, category, amount, currency: "KES", spentOn, recoverable },
  });
  assert.equal(res.status, 201, res.text.slice(0, 250));
  return res.json.expense as Wire;
}

const preview = async (cookie: string, agreementId: string, period = SEP) =>
  call(`/management-agreements/${agreementId}/statement?period=${period}`, { cookie });

const issue = async (cookie: string, agreementId: string, period = SEP) =>
  call(`/management-agreements/${agreementId}/statements`,
       { method: "POST", cookie, body: { period } });

const T = (r: Reply) => r.json.totals as Record<string, string>;

/* ====================================================================== *
 * THE AGREEMENT
 * ====================================================================== */

test("an agreement says whose property it is and what the fee is", { skip }, async () => {
  const { org, cookie } = await company();
  const { agreement, owner, site } = await managed(cookie, org.id);
  assert.match(String(agreement.ref), /^MGT-/);
  assert.equal(agreement.ownerId, owner.id);
  assert.equal(agreement.siteId, site.id);
  assert.equal(agreement.basis, "COLLECTED");
  assert.equal(agreement.feeBps, 1000);
  assert.equal(agreement.currency, "KES", "the currency came from the company, not the property");
});

test("A BASIS-POINT TYPO IS REFUSED", { skip }, async () => {
  /*
   * The silent one. Somebody meaning 10% types 10000 and the company takes the
   * entire rent; somebody types 10 and takes 0.1%. The second is a mistake
   * anybody notices. The first is a mistake the owner notices.
   */
  const { org, cookie } = await company();
  const site = await db.site.create({ data: { orgId: org.id, name: "A", currency: "KES" } });
  const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });

  const res = await call("/management-agreements", {
    method: "POST", cookie,
    body: { ownerId: owner.id, siteId: site.id, feeBps: 10000, currency: "KES" },
  });
  assert.equal(res.status, 400, res.text.slice(0, 250));
  assert.match(res.text, /100\.00% of the rent/);
  assert.match(res.text, /10% is 1000, not 10000/, "it does not say what they probably meant");
});

test("an agreement with no property is refused", { skip }, async () => {
  const { org, cookie } = await company();
  const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });
  const res = await call("/management-agreements", {
    method: "POST", cookie, body: { ownerId: owner.id, feeBps: 1000, currency: "KES" } });
  assert.equal(res.status, 400, res.text.slice(0, 200));
  assert.match(res.text, /which property it covers/);
});

test("a unit in another building cannot be named", { skip }, async () => {
  /* Otherwise every statement under it accounts for one owner's rent against
     another's property. */
  const { org, cookie } = await company();
  const a = await db.site.create({ data: { orgId: org.id, name: "Riverside", currency: "KES" } });
  const b = await db.site.create({ data: { orgId: org.id, name: "Kilimani", currency: "KES" } });
  const elsewhere = await db.unit.create({ data: { orgId: org.id, siteId: b.id, ref: "C-402" } });
  const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });

  const res = await call("/management-agreements", {
    method: "POST", cookie,
    body: { ownerId: owner.id, siteId: a.id, unitId: elsewhere.id, feeBps: 1000, currency: "KES" },
  });
  assert.equal(res.status, 400, res.text.slice(0, 250));
  assert.match(res.text, /C-402 is not in Riverside/);
});

test("a fixed fee needs an amount", { skip }, async () => {
  const { org, cookie } = await company();
  const site = await db.site.create({ data: { orgId: org.id, name: "A", currency: "KES" } });
  const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });
  const res = await call("/management-agreements", {
    method: "POST", cookie,
    body: { ownerId: owner.id, siteId: site.id, basis: "FIXED", currency: "KES" } });
  assert.equal(res.status, 400, res.text.slice(0, 200));
  assert.match(res.text, /flat fee of nothing/);
});

test("the fee rate is re-checked on every edit", { skip }, async () => {
  /* A rate that drifts out of range between create and edit is a rate
     somebody will be charged. */
  const { org, cookie } = await company();
  const { agreement } = await managed(cookie, org.id);
  const res = await call(`/management-agreements/${agreement.id}`, {
    method: "PATCH", cookie, body: { feeBps: 9000 } });
  assert.equal(res.status, 400, res.text.slice(0, 200));
  const after = await db.managementAgreement.findUnique({ where: { id: String(agreement.id) } });
  assert.equal(after!.feeBps, 1000, "the rate changed behind the refusal");
});

/* ====================================================================== *
 * THE ARITHMETIC
 * ====================================================================== */

test("collected, costs, fee, net — in that order", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);                       /* 10% of collected */
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(inv.id), 13500000);
  await cost(cookie, String(m.site.id), 2000000);

  const res = await preview(cookie, String(m.agreement.id));
  assert.equal(res.status, 200, res.text.slice(0, 250));
  const t = T(res);
  assert.equal(t.collected, "13500000");
  assert.equal(t.billed, "13500000");
  assert.equal(t.costs, "2000000");
  assert.equal(t.fee, "1350000", "the fee is not 10% of what was collected");
  assert.equal(t.net, "10150000", "collected less costs less fee");
  assert.equal(t.opening, "0", "there is no earlier statement to bring forward");
  assert.equal(t.closing, "10150000");
});

test("COLLECTED AND BILLED ARE DIFFERENT NUMBERS, and both are shown", { skip }, async () => {
  /*
   * They differ by exactly the arrears. An owner seeing only one of them cannot
   * tell a month where the tenant paid late from a month where the agent did
   * not chase — and on a COLLECTED fee the agent is paid for the difference.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(inv.id), 6000000);                   /* part paid */

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.billed, "13500000");
  assert.equal(t.collected, "6000000");
  assert.equal(t.fee, "600000", "a fee on collected rent was charged on billed rent");
});

test("a BILLED fee charges on what was invoiced, paid or not", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id, { basis: "BILLED", feeBps: 1000 });
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(inv.id), 6000000);

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.fee, "1350000", "a BILLED fee was charged on what arrived instead");
  /* And the net can go negative: the owner owes the agent a fee on rent that
     never came in. That is what the contract says, and hiding it would be
     worse than showing it. */
  assert.equal(t.net, "4650000");
});

test("a FIXED fee is the same whatever happened", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id, { basis: "FIXED", feeFixed: 500000, feeBps: 0 });
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(inv.id), 13500000);

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.fee, "500000");
});

test("the fee rounds in the OWNER's favour", { skip }, async () => {
  /*
   * A half-cent has to go somewhere, and the party that wrote the contract and
   * does the arithmetic is not the party it should go to.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id, { feeBps: 333 });      /* 3.33% */
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10001);
  await paid(cookie, String(inv.id), 10001);

  const t = T(await preview(cookie, String(m.agreement.id)));
  /* 10001 * 333 / 10000 = 333.03 -> 333, not 334. */
  assert.equal(t.fee, "333");
});

test("a credit note comes off what was billed", { skip }, async () => {
  /* An invoice partly written off was never billed for that part, and a fee on
     it would be a fee on money nobody owes. */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id, { basis: "BILLED", feeBps: 1000 });
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  const cn = await call(`/invoices/${inv.id}/credit-notes`, {
    method: "POST", cookie,
    body: { amount: 4000000, reason: "Two weeks without water, agreed with the tenant" },
  });
  assert.equal(cn.status, 201, cn.text.slice(0, 250));

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.billed, "6000000", "the credited part is still being charged a fee on");
  assert.equal(t.fee, "600000");
});

test("a refund reduces what was collected", { skip }, async () => {
  /* A refund is a negative payment — the schema says so on the column — so
     money that went back was not collected. */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  const p = await paid(cookie, String(inv.id), 10000000);
  const back = await call(`/payments/${p.id}/refund`, {
    method: "POST", cookie,
    body: { amount: 3000000, reason: "Overpaid by the tenant's bank" } });
  assert.equal(back.status, 201, back.text.slice(0, 250));

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.collected, "7000000");
  assert.equal(t.fee, "700000");
});

/* ====================================================================== *
 * WHOSE RENT IS THIS
 * ====================================================================== */

test("AN AGREEMENT OVER ONE UNIT IS NOT CREDITED WITH THE BLOCK'S RENT", { skip }, async () => {
  /*
   * An agent managing a single flat in a block. If the site were used as a
   * fallback, that owner's statement would show the whole building's rent and
   * the agent would charge a fee on all of it.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id, { unitOnly: true });

  /* A second flat in the same building, nothing to do with this owner. */
  const other = await db.unit.create({ data: { orgId: org.id, siteId: m.site.id, ref: "B-202" } });
  const theirTenant = await db.party.create({
    data: { orgId: org.id, name: "Somebody Else", kind: "TENANT" } });
  const theirLease = await db.lease.create({
    data: {
      orgId: org.id, unitId: other.id, tenantId: theirTenant.id,
      ref: "L-other", unitRef: "B-202", rent: 9000000n, currency: "KES",
      startsOn: new Date("2026-01-01T00:00:00Z"), status: "ACTIVE",
    },
  });

  const mine = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(mine.id), 13500000);
  const theirs = await billFor(cookie, theirLease.id, theirTenant.id, 9000000);
  await paid(cookie, String(theirs.id), 9000000);

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.collected, "13500000",
    "the other flat's rent is on this owner's statement, and they are being "
    + "charged a fee on it");
});

test("another property's costs are not charged to this owner", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const elsewhere = await db.site.create({
    data: { orgId: org.id, name: "Kilimani Heights", currency: "KES" } });
  await cost(cookie, String(elsewhere.id), 5000000, { detail: "Another building's lift" });

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.costs, "0");
});

test("money outside the period is outside the statement", { skip }, async () => {
  /*
   * The period is HALF-OPEN — [first of the month, first of the next) — which
   * is the only way to tile months without a gap or an overlap. An inclusive
   * end date loses everything after midnight on the 30th, or counts it twice.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000, "2026-09-01");
  await paid(cookie, String(inv.id), 4000000, "2026-08-31T23:59:00Z");
  await paid(cookie, String(inv.id), 6000000, "2026-09-30T23:59:00Z");

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.collected, "6000000",
    "the August payment is in September's statement, or the 30th's is missing");

  const oct = T(await preview(cookie, String(m.agreement.id), "2026-10"));
  assert.equal(oct.collected, "0", "September's last day leaked into October");
});

/* ====================================================================== *
 * WHICH COSTS — and the ones nobody charged on
 * ====================================================================== */

test("ONLY COSTS SOMEBODY MARKED RECOVERABLE ARE CHARGED ON", { skip }, async () => {
  /*
   * `Expense.recoverable` has always meant "can be billed on to an owner or a
   * tenant", and a cost nobody marked is one the landlord absorbed. Charging an
   * owner for something nobody said was chargeable is the wrong direction to
   * err in.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  await cost(cookie, String(m.site.id), 2000000, { detail: "Gutter repair", recoverable: true });
  await cost(cookie, String(m.site.id), 800000,
             { detail: "Our own site visit", recoverable: false });

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.costs, "2000000", "a cost nobody marked recoverable was charged to the owner");
  /* And it is REPORTED, not dropped: a cost quietly left off is one the company
     absorbed without deciding to. */
  assert.equal(t.costsLeftOff, 1);
  assert.equal(t.costsLeftOffTotal, "800000");
});

test("a rejected cost is not on the statement at all", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const e = await cost(cookie, String(m.site.id), 2000000);
  await call(`/expenses/${e.id}`, { method: "PATCH", cookie, body: { status: "REJECTED" } });

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.costs, "0");
  assert.equal(t.costsLeftOff, 0, "a rejected cost is reported as one the company absorbed");
});

/* ====================================================================== *
 * ISSUING IT — and freezing it
 * ====================================================================== */

test("the lines add up to the net, and are frozen with it", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(inv.id), 13500000);
  await cost(cookie, String(m.site.id), 2000000);

  const res = await issue(cookie, String(m.agreement.id));
  assert.equal(res.status, 201, res.text.slice(0, 300));
  const st = res.json.statement as Wire;
  assert.match(String(st.ref), /^OS-/);
  assert.equal(String(st.net), "10150000");

  const lines = st.lines as Wire[];
  const sum = lines.filter((l: Wire) => l.kind !== "PAYOUT")
    .reduce((t: number, l: Wire) => t + Number(l.amount), 0);
  assert.equal(sum, 10150000, "the lines do not add up to the total the owner is shown");

  const kinds = lines.map((l: Wire) => l.kind);
  assert.ok(kinds.includes("RENT"), "the rent is not itemised");
  assert.ok(kinds.includes("COST"), "the cost is not itemised");
  assert.ok(kinds.includes("FEE"), "the fee is not itemised — an owner cannot see what we charged");
});

test("A STATEMENT DOES NOT CHANGE WHEN THE DATA BEHIND IT DOES", { skip }, async () => {
  /*
   * The whole reason it is frozen. The owner is holding a copy: if ours
   * recomputed, an invoice credited next week would quietly change what we told
   * them last month, and theirs is the one in the email.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000);
  await paid(cookie, String(inv.id), 13500000);

  const issued = (await issue(cookie, String(m.agreement.id))).json.statement as Wire;
  assert.equal(String(issued.collected), "13500000");

  /* Now change everything the statement was built from. */
  await call(`/invoices/${inv.id}/credit-notes`, {
    method: "POST", cookie,
    body: { amount: 5000000, reason: "Agreed after the statement went out" } });
  await cost(cookie, String(m.site.id), 9000000, { detail: "A cost booked later" });

  const again = await db.ownerStatement.findUnique({
    where: { id: String(issued.id) }, include: { lines: true } });
  assert.equal(String(again!.collected), "13500000", "the issued statement changed underneath");
  assert.equal(String(again!.costs), "0", "a later cost appeared on a statement already sent");
  assert.equal(String(again!.net), String(issued.net));
});

test("one statement per agreement per month", { skip }, async () => {
  /* Two statements for one month are two different answers to one question,
     and the owner has both. */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  assert.equal((await issue(cookie, String(m.agreement.id))).status, 201);

  const twice = await issue(cookie, String(m.agreement.id));
  assert.equal(twice.status, 409, twice.text.slice(0, 250));
  assert.match(twice.text, /already covers September 2026/);
  assert.match(twice.text, /void that one first/, "it does not say what to do instead");
});

test("THE BALANCE IS CARRIED FORWARD", { skip }, async () => {
  /*
   * A relationship that restarts at zero every month hides a balance that has
   * been owed for six of them.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const sep = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000, "2026-09-01");
  await paid(cookie, String(sep.id), 10000000, "2026-09-05");

  const first = (await issue(cookie, String(m.agreement.id), "2026-09")).json.statement as Wire;
  assert.equal(String(first.closing), "9000000", "10,000,000 less a 10% fee");

  /* October: nothing collected, and nothing paid out. */
  const second = await preview(cookie, String(m.agreement.id), "2026-10");
  const t = T(second);
  assert.equal(t.opening, "9000000", "September's closing balance was not brought forward");
  assert.equal(t.net, "0");
  assert.equal(t.closing, "9000000", "the owner is still owed it");
  assert.equal(second.json.broughtForwardFrom, first.ref);
});

test("money already sent comes off what is still owed", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  await paid(cookie, String(inv.id), 10000000);

  /* A payout under this agreement, sent inside the period. */
  const out = await call("/payouts", {
    method: "POST", cookie,
    body: {
      agreementId: m.agreement.id, partyId: m.owner.id,
      gross: 5000000, fees: 0, currency: "KES",
      status: "SENT", sentAt: "2026-09-28",
    },
  });
  assert.equal(out.status, 201, out.text.slice(0, 250));

  const t = T(await preview(cookie, String(m.agreement.id)));
  assert.equal(t.net, "9000000", "the period still produced the same net");
  assert.equal(t.paidOut, "5000000");
  assert.equal(t.closing, "4000000", "what is still owed does not account for the payout");
});

test("a payout under another agreement is not counted", { skip }, async () => {
  const { org, cookie } = await company();
  const a = await managed(cookie, org.id);
  const b = await managed(cookie, org.id);
  await call("/payouts", {
    method: "POST", cookie,
    body: { agreementId: b.agreement.id, partyId: b.owner.id, gross: 5000000, fees: 0,
            currency: "KES", status: "SENT", sentAt: "2026-09-28" },
  });
  const t = T(await preview(cookie, String(a.agreement.id)));
  assert.equal(t.paidOut, "0");
});

/* ====================================================================== *
 * THE REFUSALS
 * ====================================================================== */

test("a draft agreement issues nothing", { skip }, async () => {
  const { org, cookie } = await company();
  const site = await db.site.create({ data: { orgId: org.id, name: "A", currency: "KES" } });
  const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });
  const made = await call("/management-agreements", {
    method: "POST", cookie,
    body: { ownerId: owner.id, siteId: site.id, feeBps: 1000, currency: "KES", status: "DRAFT" } });
  assert.equal(made.status, 201, made.text.slice(0, 200));

  const res = await issue(cookie, String((made.json.agreement as Wire).id));
  assert.equal(res.status, 400, res.text.slice(0, 250));
  assert.match(res.text, /still a draft/);
  assert.match(res.text, /never consented/);
});

test("a period before the agreement began is refused", { skip }, async () => {
  /* Billing a management fee for a month before the owner engaged the company
     is charging for work nobody asked for. */
  const { org, cookie } = await company();
  const site = await db.site.create({ data: { orgId: org.id, name: "A", currency: "KES" } });
  const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });
  const made = await call("/management-agreements", {
    method: "POST", cookie,
    body: { ownerId: owner.id, siteId: site.id, feeBps: 1000, currency: "KES",
            startsOn: "2026-10-01" } });

  const res = await issue(cookie, String((made.json.agreement as Wire).id), "2026-09");
  assert.equal(res.status, 400, res.text.slice(0, 250));
  assert.match(res.text, /does not start until/);
});

test("a period is a month, written as 2026-09", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  for (const bad of ["", "September", "2026", "2026-13", "2026-09-01"]) {
    const res = await issue(cookie, String(m.agreement.id), bad);
    assert.equal(res.status, 400, `"${bad}" was accepted: ${res.text.slice(0, 160)}`);
  }
});

test("there is no POST /owner-statements — the path says where to go", { skip }, async () => {
  /*
   * A generic create would let somebody send an owner a document with whatever
   * numbers they liked on it, under the company's letterhead. That document is
   * what the relationship is settled on.
   */
  const { cookie } = await company();
  const res = await call("/owner-statements", {
    method: "POST", cookie, body: { collected: 999999999 } });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  assert.match(res.text, /management-agreements\/:id\/statements/, res.text.slice(0, 250));
});

test("a statement is not edited through the generic path", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const st = (await issue(cookie, String(m.agreement.id))).json.statement as Wire;
  const res = await call(`/owner-statements/${st.id}`, {
    method: "PATCH", cookie, body: { fee: 99999999, net: 0 } });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  assert.match(res.text, /holding a copy/i, res.text.slice(0, 250));
});

test("TWO ISSUE PRESSES AT ONCE PRODUCE ONE STATEMENT", { skip }, async () => {
  /*
   * The route reads "is there already one for this month" and then writes, and
   * two requests can both pass that read before either writes. A
   * double-clicked button is the ordinary way it happens, and the result would
   * be the one thing this module exists to prevent: two statements for one
   * month, both of them sent, disagreeing with each other.
   *
   * @@unique([orgId, agreementId, livePeriodFrom]) is what settles it, and the
   * loser is answered 409 rather than 500 — the same refusal the pre-check
   * gives, because from outside it is the same situation.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  await paid(cookie, String(inv.id), 10000000);

  const both = await Promise.all([
    issue(cookie, String(m.agreement.id)),
    issue(cookie, String(m.agreement.id)),
  ]);

  assert.deepEqual(
    both.map((r) => r.status).sort((a, b) => a - b), [201, 409],
    "both requests were answered the same way: "
      + both.map((r) => `${r.status} ${r.text.slice(0, 90)}`).join(" | "));

  const standing = await db.ownerStatement.findMany({
    where: { orgId: org.id, agreementId: String(m.agreement.id), voided: false },
  });
  assert.equal(standing.length, 1,
    `${standing.length} statements stand for one month: ${standing.map((x) => x.ref).join(", ")}`);
});

test("a voided statement stops holding its month, and the row still says so",
  { skip }, async () => {
  /*
   * The mechanism behind the test above, checked directly: `livePeriodFrom` is
   * what occupies the month, and voiding has to release it WITHOUT changing
   * anything about what the statement said. A void that also cleared the
   * period figures would destroy the record of what the owner was sent.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const st = (await issue(cookie, String(m.agreement.id))).json.statement as Wire;

  const before = await db.ownerStatement.findUniqueOrThrow({ where: { id: String(st.id) } });
  assert.deepEqual(before.livePeriodFrom, before.periodFrom,
    "an issued statement does not occupy its own month");

  await call(`/owner-statements/${st.id}/void`, {
    method: "POST", cookie, body: { reason: "The September costs had not been entered yet" } });

  const after = await db.ownerStatement.findUniqueOrThrow({ where: { id: String(st.id) } });
  assert.equal(after.livePeriodFrom, null, "a voided statement still holds its month");
  assert.deepEqual(after.periodFrom, before.periodFrom,
    "voiding moved the period the statement was for");
  assert.equal(after.net, before.net, "voiding changed what the statement said");
  assert.equal(after.closing, before.closing, "voiding changed the balance it stated");
});

/* ====================================================================== *
 * VOIDING ONE
 * ====================================================================== */

test("a statement is voided with a reason, and re-issued", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const st = (await issue(cookie, String(m.agreement.id))).json.statement as Wire;

  const bare = await call(`/owner-statements/${st.id}/void`, { method: "POST", cookie, body: {} });
  assert.equal(bare.status, 400, bare.text.slice(0, 200));

  const res = await call(`/owner-statements/${st.id}/void`, {
    method: "POST", cookie, body: { reason: "The September costs had not been entered yet" } });
  assert.equal(res.status, 200, res.text.slice(0, 250));
  assert.equal((res.json.statement as Wire).voided, true);

  /* The row stays, and the month is free again. */
  assert.ok(await db.ownerStatement.findUnique({ where: { id: String(st.id) } }),
    "it was deleted rather than voided");
  assert.equal((await issue(cookie, String(m.agreement.id))).status, 201,
    "the month is still blocked by the voided statement");
});

test("A LATER STATEMENT BLOCKS VOIDING AN EARLIER ONE", { skip }, async () => {
  /*
   * October brought September's closing balance forward. Voiding September
   * would leave October's opening figure resting on a document that no longer
   * stands — so it is refused, with the order to do it in.
   */
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const sep = (await issue(cookie, String(m.agreement.id), "2026-09")).json.statement as Wire;
  const oct = (await issue(cookie, String(m.agreement.id), "2026-10")).json.statement as Wire;

  const res = await call(`/owner-statements/${sep.id}/void`, {
    method: "POST", cookie, body: { reason: "Wrong figures in September" } });
  assert.equal(res.status, 409, res.text.slice(0, 300));
  assert.match(res.text, new RegExp(String(oct.ref)));
  assert.match(res.text, /newest first/);

  /* Newest first works. */
  assert.equal((await call(`/owner-statements/${oct.id}/void`, {
    method: "POST", cookie, body: { reason: "Voiding forwards to fix September" } })).status, 200);
  assert.equal((await call(`/owner-statements/${sep.id}/void`, {
    method: "POST", cookie, body: { reason: "Wrong figures in September" } })).status, 200);
});

test("a voided statement is not brought forward", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000, "2026-09-01");
  await paid(cookie, String(inv.id), 10000000, "2026-09-05");
  const sep = (await issue(cookie, String(m.agreement.id), "2026-09")).json.statement as Wire;
  await call(`/owner-statements/${sep.id}/void`, {
    method: "POST", cookie, body: { reason: "Issued against the wrong agreement" } });

  const t = T(await preview(cookie, String(m.agreement.id), "2026-10"));
  assert.equal(t.opening, "0", "a withdrawn statement's balance was carried forward");
});

/* ====================================================================== *
 * THE BOOKS — a managed property's rent is not the agent's income
 * ====================================================================== */

async function entriesFor(cookie: string, sourceId: string) {
  const { json } = await call("/ledger/entries", { cookie });
  return (json.entries as Wire[]).filter((e: Wire) => e.sourceId === sourceId);
}

test("ISSUING MOVES THE OWNER'S RENT OUT OF THE COMPANY'S INCOME", { skip }, async () => {
  /*
   * When a tenant is invoiced, PALTAS credits 4000 Rent — the company's income
   * — because until an agreement existed nothing could say otherwise. For a
   * MANAGED property that was never true, and a managing agent's accounts
   * showed revenue many times what it earned, with tax on money belonging to
   * its clients.
   */
  const { org, cookie } = await company();
  const chart = await chartOf(cookie);
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  await paid(cookie, String(inv.id), 10000000);
  await cost(cookie, String(m.site.id), 2000000, { category: "maintenance" });

  const res = await issue(cookie, String(m.agreement.id));
  assert.equal(res.status, 201, res.text.slice(0, 300));
  const booking = res.json.booking as Wire;
  assert.ok(booking && booking.booked, `nothing was booked: ${JSON.stringify(booking)}`);

  const [entry] = await entriesFor(cookie, String((res.json.statement as Wire).id));
  assert.ok(entry, "the statement is not in the books");
  const lines = entry.lines as Wire[];

  const at = (code: string) => lines.filter((l: Wire) => l.accountId === chart[code]);
  const net = (code: string) => at(code)
    .reduce((t: number, l: Wire) => t + Number(l.debit) - Number(l.credit), 0);

  /* The rent leaves income, in full. */
  assert.equal(net("4000"), 10000000,
    "the owner's rent is still sitting in this company's rent income");
  /* The fee is the only revenue. */
  assert.equal(net("4020"), -1000000,
    "the management fee was not recognised as the company's own income");
  /* The cost is recovered where it was booked. */
  assert.equal(net("5000"), -2000000,
    "the recharged maintenance was not credited back to maintenance");
  /* And what is left owed to the owner is exactly the statement's net. */
  assert.equal(net("2200"), -7000000,
    "owner payable does not equal the statement's net — the owner is owed a "
    + "different amount in the books than on the document");
  assert.equal(String((res.json.statement as Wire).net), "7000000");
});

test("voiding a statement reverses the entry", { skip }, async () => {
  /* A statement that moved an owner's rent out of income and then vanished
     would leave the books short by exactly that rent. */
  const { org, cookie } = await company();
  await chartOf(cookie);
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  await paid(cookie, String(inv.id), 10000000);
  const st = (await issue(cookie, String(m.agreement.id))).json.statement as Wire;

  const res = await call(`/owner-statements/${st.id}/void`, {
    method: "POST", cookie, body: { reason: "Issued a month too early" } });
  assert.equal(res.status, 200, res.text.slice(0, 250));
  const booking = res.json.booking as Wire;
  assert.ok(booking && (booking.booked || booking.reversed),
    `the ledger entry was not reversed: ${JSON.stringify(booking)}`);
});

test("a month where nothing happened still produces a statement", { skip }, async () => {
  /* An owner whose property sat empty gets one saying so. There is simply
     nothing for the books to record about it. */
  const { org, cookie } = await company();
  await chartOf(cookie);
  const m = await managed(cookie, org.id);

  const res = await issue(cookie, String(m.agreement.id));
  assert.equal(res.status, 201, res.text.slice(0, 250));
  assert.equal(String((res.json.statement as Wire).net), "0");
  assert.match(String((res.json.booking as Wire).why || ""), /no entry to make/);
});

test("with no chart the statement is still issued, and says why not booked", { skip }, async () => {
  const { org, cookie } = await company();
  const m = await managed(cookie, org.id);
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 10000000);
  await paid(cookie, String(inv.id), 10000000);

  const res = await issue(cookie, String(m.agreement.id));
  assert.equal(res.status, 201, res.text.slice(0, 250));
  assert.match(String((res.json.booking as Wire).why || ""), /chart/);
});

/* ====================================================================== *
 * WHAT THE COMPANY OWES ITS OWNERS
 * ====================================================================== */

test("owed is per currency, and an agreement never stated is counted", { skip }, async () => {
  /*
   * "Nothing owed" and "nothing issued" are different facts, and only one of
   * them is good news.
   */
  const { org, cookie } = await company();
  const a = await managed(cookie, org.id);
  await managed(cookie, org.id);                                 /* never stated */
  const inv = await billFor(cookie, String(a.lease.id), String(a.tenant.id), 10000000);
  await paid(cookie, String(inv.id), 10000000);
  await issue(cookie, String(a.agreement.id));

  const res = await call("/owners-owed", { cookie });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  const kes = (res.json.currencies as Wire[]).find((c: Wire) => c.currency === "KES");
  assert.equal(kes.owed, "9000000");
  assert.equal(kes.agreements, 2);
  assert.equal(kes.neverStated, 1, "an agreement with no statement reads as nothing owed");
});

/* ====================================================================== *
 * WHO MAY DO WHAT, AND WHOSE IT IS
 * ====================================================================== */

for (const [role, allowed] of [
  ["OWNER", true], ["MANAGER", true], ["FINANCE", true],
  ["LEASING", false], ["HOUSEKEEPING", false],
] as const) {
  test(`${role} ${allowed ? "may" : "may not"} write an agreement and issue a statement`,
    { skip }, async () => {
      const { org, cookie } = await company({ role });
      const site = await db.site.create({ data: { orgId: org.id, name: "A", currency: "KES" } });
      const owner = await db.party.create({ data: { orgId: org.id, name: "O", kind: "OWNER" } });

      const made = await call("/management-agreements", {
        method: "POST", cookie,
        body: { ownerId: owner.id, siteId: site.id, feeBps: 1000, currency: "KES" } });
      if (!allowed) {
        assert.ok(made.status === 403 || made.status === 404, `${role} wrote one: ${made.status}`);
        return;
      }
      assert.equal(made.status, 201, made.text.slice(0, 200));
      const res = await issue(cookie, String((made.json.agreement as Wire).id));
      assert.equal(res.status, 201, `${role} could not issue: ${res.text.slice(0, 200)}`);
    });
}

test("another company's agreement and statement are not reachable", { skip }, async () => {
  const a = await company();
  const b = await company();
  const m = await managed(a.cookie, a.org.id);
  const st = (await issue(a.cookie, String(m.agreement.id))).json.statement as Wire;

  for (const [path, method, body] of [
    [`/management-agreements/${m.agreement.id}`, "GET", undefined],
    [`/management-agreements/${m.agreement.id}/statement?period=2026-09`, "GET", undefined],
    [`/management-agreements/${m.agreement.id}/statements`, "POST", { period: "2026-10" }],
    [`/management-agreements/${m.agreement.id}`, "PATCH", { feeBps: 4000 }],
    [`/owner-statements/${st.id}`, "GET", undefined],
    [`/owner-statements/${st.id}/void`, "POST", { reason: "Voiding somebody else's" }],
  ] as const) {
    const res = await call(path, { method, cookie: b.cookie, body: body as never });
    assert.ok(res.status === 404 || res.status === 403,
      `${method} ${path} answered ${res.status} to another company`);
  }

  const after = await db.managementAgreement.findUnique({ where: { id: String(m.agreement.id) } });
  assert.equal(after!.feeBps, 1000, "another company changed the fee");
  const stillThere = await db.ownerStatement.findUnique({ where: { id: String(st.id) } });
  assert.equal(stillThere!.voided, false, "another company voided it");
});

/* ====================================================================== *
 * AND A MONTH, END TO END
 * ====================================================================== */

test("a managed property's September, from rent to what is owed", { skip }, async () => {
  const { org, cookie } = await company();
  await chartOf(cookie);
  const m = await managed(cookie, org.id);                       /* 10% of collected */

  /* Rent billed and paid, one cost charged on, one absorbed. */
  const inv = await billFor(cookie, String(m.lease.id), String(m.tenant.id), 13500000, "2026-09-01");
  await paid(cookie, String(inv.id), 13500000, "2026-09-03");
  await cost(cookie, String(m.site.id), 1800000,
             { detail: "Lift service contract", category: "maintenance" });
  await cost(cookie, String(m.site.id), 400000,
             { detail: "Our own inspection visit", recoverable: false });

  /* Look before issuing. */
  const look = await preview(cookie, String(m.agreement.id));
  assert.equal(look.json.why, null, `it says it cannot be issued: ${look.json.why}`);
  assert.equal(look.json.issued, null);

  /* Issue it. */
  const res = await issue(cookie, String(m.agreement.id));
  const st = res.json.statement as Wire;
  assert.equal(String(st.collected), "13500000");
  assert.equal(String(st.costs), "1800000");
  assert.equal(String(st.fee), "1350000");
  assert.equal(String(st.net), "10350000");
  assert.equal(String(st.closing), "10350000");
  assert.equal(st.costsLeftOff, 1, "the absorbed cost is not reported");

  /* The preview now says it has been issued, rather than offering it again. */
  const after = await preview(cookie, String(m.agreement.id));
  assert.equal((after.json.issued as Wire).ref, st.ref);

  /* Pay the owner, and October opens with nothing owed. */
  const out = await call("/payouts", {
    method: "POST", cookie,
    body: { agreementId: m.agreement.id, partyId: m.owner.id, gross: 10350000, fees: 0,
            currency: "KES", status: "SENT", sentAt: "2026-10-02" },
  });
  assert.equal(out.status, 201, out.text.slice(0, 250));

  const oct = (await issue(cookie, String(m.agreement.id), "2026-10")).json.statement as Wire;
  assert.equal(String(oct.opening), "10350000", "September's balance was not brought forward");
  assert.equal(String(oct.paidOut), "10350000");
  assert.equal(String(oct.closing), "0", "the owner is still owed money they were paid");

  /* And every step is answerable. */
  const trail = await db.auditEvent.findMany({
    where: { orgId: org.id, entity: { in: ["managementAgreement", "ownerStatement"] } },
    orderBy: { at: "asc" } });
  const actions = trail.map((e) => e.action);
  for (const want of ["agreement.write", "owner-statement.issue"]) {
    assert.ok(actions.includes(want), `nothing recorded ${want}: ${actions.join(", ")}`);
  }
  assert.ok(trail.every((e) => e.actorId), "something happened with nobody's name on it");
});
