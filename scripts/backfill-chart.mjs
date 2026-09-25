#!/usr/bin/env node
/* ====================================================================== *
 * GIVE THE COMPANIES THAT PREDATE IT A CHART OF ACCOUNTS.
 *
 * A company created from now on gets the standard property chart at signup,
 * so its invoices, payments and expenses post journal entries from the first
 * one. Every company created BEFORE that has no chart, so domain/posting.js
 * skips all of their postings with a stated reason and their books stay
 * empty. This is the one-off that closes that gap.
 *
 * ── WHAT IT DOES, EXACTLY ──────────────────────────────────────────────
 *
 * For each organization that has NO ledger accounts at all, it creates the
 * standard chart — the same ~33 accounts seedChartOfAccounts() gives a new
 * company. That is the whole of it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * IT POSTS NOTHING. No historical invoice, payment or expense is booked. A
 * company's books start from the moment it has a chart, not from its first
 * ever transaction.
 *
 * That is a deliberate refusal, not an omission. Booking the past would
 * restate figures these customers have already seen, invent dates for entries
 * nobody approved, and produce a P&L for a period that was never closed and
 * never reviewed. If the history is wanted in the books it is an accounting
 * decision — an opening balance somebody signs off — not a script.
 *
 * ── IT IS SAFE TO RUN, AND SAFE TO RUN TWICE ───────────────────────────
 *
 *   · It reads and reports by default. Nothing is written without --apply.
 *   · It only touches organizations with ZERO accounts, so a company whose
 *     accountant has already built a chart is never modified.
 *   · seedChartOfAccounts() is itself idempotent, so a second run — or a run
 *     that was interrupted halfway — cannot produce a duplicate.
 *   · It never updates and never deletes. Only inserts.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────
 *
 *     DATABASE_URL=postgresql://…  node scripts/backfill-chart.mjs
 *     DATABASE_URL=postgresql://…  node scripts/backfill-chart.mjs --apply
 *
 *     --apply        actually write. Without it, nothing is written.
 *     --org=<id>     one company only, for a careful first run.
 *     --limit=<n>    stop after n companies.
 * ====================================================================== */

import { PrismaClient } from "@prisma/client";
import { seedChartOfAccounts, DEFAULT_CHART } from "../src/domain/ledger.ts";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : null;
};

const APPLY = has("--apply");
const ONLY = val("--org");
const LIMIT = Number(val("--limit")) || 0;

const url = process.env.DATABASE_URL || "";
if (!url) {
  console.error("DATABASE_URL is not set. Point it at the database you mean to change.");
  process.exit(1);
}
/* The placeholder in .env.example has reached real runs before — see the note
   in scripts/test.mjs. Refusing beats connecting to nothing and reporting
   "0 companies", which reads like success. */
if (/placeholder/i.test(url)) {
  console.error("DATABASE_URL is the placeholder from .env.example, not a database.");
  process.exit(1);
}

const redacted = url.replace(/:[^:@/]+@/, ":****@");
const db = new PrismaClient();

function line(n = 72) { return "─".repeat(n); }

async function main() {
  console.log("\n" + line());
  console.log("  CHART OF ACCOUNTS BACKFILL");
  console.log("  database : " + redacted);
  console.log("  mode     : " + (APPLY ? "APPLY — this writes" : "dry run — nothing will be written"));
  if (ONLY) console.log("  scope    : one company (" + ONLY + ")");
  if (LIMIT) console.log("  limit    : " + LIMIT);
  console.log(line() + "\n");

  const orgs = await db.organization.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true, name: true, country: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (ONLY && !orgs.length) {
    console.error(`No company with id ${ONLY}.`);
    process.exitCode = 1;
    return;
  }

  /* One query rather than one per company: a company with any account at all
     is left alone, whether that chart came from signup or from its own
     accountant. */
  const withAccounts = new Set(
    (await db.ledgerAccount.findMany({
      where: ONLY ? { orgId: ONLY } : {},
      select: { orgId: true },
      distinct: ["orgId"],
    })).map((a) => a.orgId),
  );

  const missing = orgs.filter((o) => !withAccounts.has(o.id));
  const todo = LIMIT ? missing.slice(0, LIMIT) : missing;

  console.log(`  companies            : ${orgs.length}`);
  console.log(`  already have a chart : ${orgs.length - missing.length}`);
  console.log(`  need one             : ${missing.length}`);
  if (LIMIT && missing.length > todo.length) {
    console.log(`  doing now            : ${todo.length}  (--limit)`);
  }
  console.log("");

  if (!todo.length) {
    console.log("  Nothing to do.\n");
    return;
  }

  if (!APPLY) {
    for (const o of todo) {
      console.log(`  would seed ${DEFAULT_CHART.length} accounts  ·  ${o.name}  (${o.id})`);
    }
    console.log(
      `\n  Dry run. Nothing was written.\n` +
      `  Re-run with --apply to create ${DEFAULT_CHART.length} accounts for each of ` +
      `${todo.length} compan${todo.length === 1 ? "y" : "ies"}.\n`);
    return;
  }

  let done = 0, created = 0, failed = 0;
  for (const o of todo) {
    try {
      const rows = await seedChartOfAccounts(db, o.id);
      done += 1;
      created += rows.length;
      console.log(`  seeded ${String(rows.length).padStart(3)} accounts  ·  ${o.name}  (${o.id})`);
    } catch (e) {
      failed += 1;
      /* One company's failure is not a reason to abandon the rest — and the
         run is idempotent, so a later run picks up whatever was missed. */
      console.error(`  FAILED                     ·  ${o.name}  (${o.id})  —  ${e.message}`);
    }
  }

  console.log("\n" + line());
  console.log(`  seeded   : ${done} compan${done === 1 ? "y" : "ies"}, ${created} accounts`);
  if (failed) console.log(`  failed   : ${failed} — re-run to pick them up, it is idempotent`);
  console.log(line());
  console.log(
    "\n  These companies now post journal entries from their NEXT invoice,\n" +
    "  payment or expense. Nothing historical was booked — see the note at\n" +
    "  the top of this file.\n");
}

main()
  .catch((e) => { console.error("\nbackfill failed:", e.message, "\n"); process.exitCode = 1; })
  .finally(() => db.$disconnect());
