/* ====================================================================== *
 * THE LEDGER.
 *
 * Four things this file exists to prove, and they are the four an auditor
 * would ask about before trusting a single figure:
 *
 *   1. EVERY POSTED ENTRY BALANCES. Not "the happy path balances" — an
 *      entry that does not balance is REFUSED, in the transaction currency
 *      and in the reporting currency, and the trial balance for the whole
 *      organization comes to zero afterwards.
 *   2. A POSTED ENTRY CANNOT BE CHANGED. A correction is a reversal that
 *      names what it reverses and why; the original's lines are still
 *      exactly what was posted.
 *   3. A CLOSED PERIOD DOES NOT MOVE. Posting into one is refused.
 *   4. NOTHING CROSSES AN ORGANIZATION. An entry naming another
 *      organization's account is refused, and one organization's balances
 *      never include another's lines.
 *
 * These run against real PostgreSQL in their own schema, because the rules
 * they check are partly constraints and a fake would agree with whatever
 * the code did.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SCHEMA = "test_ledger";

process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping ledger tests";
let db, pg, L;

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    L = await import("../src/domain/ledger.ts");
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = String(e && e.message);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST"
      : "database unreachable: " + m.slice(0, 90);
  }
}

let pool, orgA, orgB, acc = {}, accB = {};
let seq = 0;
const ref = (p) => `${p}-${String(++seq).padStart(5, "0")}`;

test.before(async () => {
  if (skip) return;
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);

  orgA = await db.organization.create({ data: { name: "Akram Property Co" } });
  orgB = await db.organization.create({ data: { name: "Someone Else Ltd" } });

  await L.seedChartOfAccounts(db, orgA.id);
  await L.seedChartOfAccounts(db, orgB.id);

  const load = async (orgId, into) => {
    for (const a of await db.ledgerAccount.findMany({ where: { orgId } })) into[a.code] = a;
  };
  await load(orgA.id, acc);
  await load(orgB.id, accB);
});

test.after(async () => { if (pool) await pool.end(); });

/* Post a tenant's rent payment: bank up, receivable down. */
const rentPayment = (amount = 120000n) => ({
  orgId: orgA.id, ref: ref("JE"), date: new Date("2026-09-15"),
  currency: "KES", baseCurrency: "KES",
  memo: "Rent received",
  lines: [
    { accountId: acc["1000"].id, debit: amount, credit: 0n },
    { accountId: acc["1110"].id, debit: 0n, credit: amount },
  ],
});

/* ------------------------------------------------ 1. debits = credits */

test("a balanced entry posts, and the trial balance comes to zero", { skip }, async () => {
  const entry = await L.postJournal(db, rentPayment());
  assert.equal(entry.status, "POSTED");
  assert.equal(entry.lines.length, 2);
  assert.ok(entry.postedAt, "a posted entry records when");

  const tb = await L.trialBalance(db, { orgId: orgA.id });
  assert.equal(tb.balanced, true, `trial balance off by ${tb.difference}`);
  assert.equal(tb.difference, 0n);
});

test("an unbalanced entry is refused, and nothing is written", { skip }, async () => {
  const before = await db.journalEntry.count({ where: { orgId: orgA.id } });
  await assert.rejects(
    () => L.postJournal(db, {
      ...rentPayment(),
      lines: [
        { accountId: acc["1000"].id, debit: 100000n, credit: 0n },
        { accountId: acc["1110"].id, debit: 0n, credit: 99999n },
      ],
    }),
    (e) => e.code === "UNBALANCED",
  );
  assert.equal(await db.journalEntry.count({ where: { orgId: orgA.id } }), before,
    "a refused entry must not leave a row behind");
});

test("a line cannot be both a debit and a credit, or negative, or empty", { skip }, async () => {
  const bad = (lines) => L.postJournal(db, { ...rentPayment(), lines });
  await assert.rejects(() => bad([
    { accountId: acc["1000"].id, debit: 10n, credit: 10n },
    { accountId: acc["1110"].id, debit: 0n, credit: 10n },
  ]), (e) => e.code === "LINE_BOTH_SIDES");

  await assert.rejects(() => bad([
    { accountId: acc["1000"].id, debit: -10n, credit: 0n },
    { accountId: acc["1110"].id, debit: 0n, credit: -10n },
  ]), (e) => e.code === "NEGATIVE_AMOUNT");

  await assert.rejects(() => bad([
    { accountId: acc["1000"].id, debit: 0n, credit: 0n },
    { accountId: acc["1110"].id, debit: 0n, credit: 0n },
  ]), (e) => e.code === "LINE_EMPTY");
});

test("one line is not an entry", { skip }, async () => {
  await assert.rejects(
    () => L.postJournal(db, { ...rentPayment(), lines: [{ accountId: acc["1000"].id, debit: 1n, credit: 0n }] }),
    (e) => e.code === "TOO_FEW_LINES",
  );
});

/* ------------------------------------- 2. posted entries are immutable */

test("a correction is a reversal, and the original is left as posted", { skip }, async () => {
  const original = await L.postJournal(db, rentPayment(75000n));

  const reversal = await L.reverseJournal(db, {
    orgId: orgA.id, entryId: original.id, ref: ref("JE"),
    date: new Date("2026-09-16"), reason: "Paid against the wrong lease",
  });

  // the mirror
  assert.equal(reversal.reversesId, original.id);
  assert.equal(reversal.reversalReason, "Paid against the wrong lease");
  const rBank = reversal.lines.find((l) => l.accountId === acc["1000"].id);
  assert.equal(rBank.credit, 75000n, "what was debited is credited back");
  assert.equal(rBank.debit, 0n);

  // the original is untouched apart from its status
  const after = await db.journalEntry.findUnique({
    where: { id: original.id }, include: { lines: true },
  });
  assert.equal(after.status, "REVERSED");
  const oBank = after.lines.find((l) => l.accountId === acc["1000"].id);
  assert.equal(oBank.debit, 75000n, "the original lines still say what was posted");

  // and the two together are financially a no-op
  const pair = await L.trialBalance(db, { orgId: orgA.id, from: new Date("2026-09-15"), to: new Date("2026-09-17") });
  assert.equal(pair.balanced, true);
});

test("a reversal states a reason, and nothing is reversed twice", { skip }, async () => {
  const e = await L.postJournal(db, rentPayment(1000n));
  await assert.rejects(
    () => L.reverseJournal(db, { orgId: orgA.id, entryId: e.id, ref: ref("JE"), reason: "" }),
    (err) => err.code === "REASON_REQUIRED",
  );
  await L.reverseJournal(db, { orgId: orgA.id, entryId: e.id, ref: ref("JE"), reason: "duplicate" });
  await assert.rejects(
    () => L.reverseJournal(db, { orgId: orgA.id, entryId: e.id, ref: ref("JE"), reason: "again" }),
    (err) => err.code === "ALREADY_REVERSED",
  );
});

/* ------------------------------------------- 3. a closed period holds */

test("a closed period refuses a posting; an open one accepts it", { skip }, async () => {
  await db.financialPeriod.create({
    data: {
      orgId: orgA.id, label: "2026-01",
      opensAt: new Date("2026-01-01"), closesAt: new Date("2026-01-31T23:59:59Z"),
      status: "CLOSED", closedAt: new Date(),
    },
  });

  await assert.rejects(
    () => L.postJournal(db, { ...rentPayment(), date: new Date("2026-01-15") }),
    (e) => e.code === "PERIOD_CLOSED",
  );

  await db.financialPeriod.create({
    data: {
      orgId: orgA.id, label: "2026-02",
      opensAt: new Date("2026-02-01"), closesAt: new Date("2026-02-28T23:59:59Z"),
      status: "OPEN",
    },
  });
  const ok = await L.postJournal(db, { ...rentPayment(), date: new Date("2026-02-10") });
  assert.equal(ok.status, "POSTED");
  assert.ok(ok.periodId, "a posting inside a period records which one");
});

/* ------------------------------------------ 4. organization isolation */

test("an entry cannot name another organization's account", { skip }, async () => {
  await assert.rejects(
    () => L.postJournal(db, {
      ...rentPayment(),
      lines: [
        { accountId: acc["1000"].id, debit: 500n, credit: 0n },
        { accountId: accB["1110"].id, debit: 0n, credit: 500n },   // orgB's
      ],
    }),
    (e) => e.code === "CROSS_ORG_ACCOUNT",
  );
});

test("one organization's balances never include another's", { skip }, async () => {
  await L.postJournal(db, {
    orgId: orgB.id, ref: ref("JE-B"), date: new Date("2026-09-15"),
    currency: "KES", baseCurrency: "KES",
    lines: [
      { accountId: accB["1000"].id, debit: 999999n, credit: 0n },
      { accountId: accB["1110"].id, debit: 0n, credit: 999999n },
    ],
  });

  const a = await L.accountBalance(db, { orgId: orgA.id, accountId: acc["1000"].id });
  const b = await L.accountBalance(db, { orgId: orgB.id, accountId: accB["1000"].id });
  assert.equal(b.balance, 999999n, "orgB sees its own posting");
  assert.notEqual(a.balance, b.balance, "orgA's bank is not orgB's bank");

  // and asking for orgB's account as orgA is a refusal, not an empty answer
  await assert.rejects(
    () => L.accountBalance(db, { orgId: orgA.id, accountId: accB["1000"].id }),
    (e) => e.code === "ACCOUNT_UNKNOWN",
  );
});

/* ------------------------------------------------- multi-currency */

test("a foreign-currency entry balances in BOTH currencies or is refused", { skip }, async () => {
  // USD 100.00 at 129.50 → KES 12,950.00
  const ok = await L.postJournal(db, {
    orgId: orgA.id, ref: ref("JE"), date: new Date("2026-09-20"),
    currency: "USD", baseCurrency: "KES", fxRate: "129.5", fxSource: "test",
    fxAt: new Date("2026-09-20"),
    lines: [
      { accountId: acc["1000"].id, debit: 10000n, credit: 0n, baseDebit: 1295000n, baseCredit: 0n },
      { accountId: acc["4000"].id, debit: 0n, credit: 10000n, baseDebit: 0n, baseCredit: 1295000n },
    ],
  });
  assert.equal(ok.currency, "USD");
  assert.equal(ok.baseCurrency, "KES");
  assert.equal(ok.fxRate, "129.5", "the rate used is kept, not recomputed later");

  // the transaction currency balances but the reporting currency does not
  await assert.rejects(
    () => L.postJournal(db, {
      orgId: orgA.id, ref: ref("JE"), date: new Date("2026-09-20"),
      currency: "USD", baseCurrency: "KES", fxRate: "129.5",
      lines: [
        { accountId: acc["1000"].id, debit: 10000n, credit: 0n, baseDebit: 1295000n, baseCredit: 0n },
        { accountId: acc["4000"].id, debit: 0n, credit: 10000n, baseDebit: 0n, baseCredit: 1200000n },
      ],
    }),
    (e) => e.code === "UNBALANCED_BASE",
  );
});

/* ------------------------------------------------- chart of accounts */

test("seeding the chart twice does not produce it twice", { skip }, async () => {
  const before = await db.ledgerAccount.count({ where: { orgId: orgA.id } });
  await L.seedChartOfAccounts(db, orgA.id);
  assert.equal(await db.ledgerAccount.count({ where: { orgId: orgA.id } }), before);
});

test("an account reads in its own normal direction", { skip }, async () => {
  const amount = 50000n;
  await L.postJournal(db, {
    orgId: orgA.id, ref: ref("JE"), date: new Date("2026-09-25"),
    currency: "KES", baseCurrency: "KES",
    lines: [
      { accountId: acc["1000"].id, debit: amount, credit: 0n },
      { accountId: acc["4010"].id, debit: 0n, credit: amount },   // service charge income
    ],
  });
  const income = await L.accountBalance(db, { orgId: orgA.id, accountId: acc["4010"].id });
  assert.equal(income.normal, "CREDIT");
  assert.ok(income.balance > 0n, "income earned reads positive, not negative");
});

test("a heading account takes no postings", { skip }, async () => {
  const parent = await db.ledgerAccount.update({
    where: { id: acc["1100"].id }, data: { postable: false },
  });
  await assert.rejects(
    () => L.postJournal(db, {
      ...rentPayment(),
      lines: [
        { accountId: parent.id, debit: 10n, credit: 0n },
        { accountId: acc["1110"].id, debit: 0n, credit: 10n },
      ],
    }),
    (e) => e.code === "ACCOUNT_NOT_POSTABLE",
  );
  await db.ledgerAccount.update({ where: { id: parent.id }, data: { postable: true } });
});

/* ------------------------------------------- the whole-books property */

test("after every posting above, the organization's books still balance", { skip }, async () => {
  for (const orgId of [orgA.id, orgB.id]) {
    const tb = await L.trialBalance(db, { orgId });
    assert.equal(tb.balanced, true, `books do not balance for ${orgId}: off by ${tb.difference}`);
  }
});
