/* ======================================================================
 * BRINGING A CLIENT'S EXISTING RECORDS IN.
 *
 * ── WHY THIS DECIDES WHETHER ANYBODY CAN ADOPT PALTAS ─────────────────
 *
 * The resource framework takes one row per request. A property company
 * arriving with 200 units, 180 tenants and 180 leases in a spreadsheet
 * therefore faced about 560 forms, or not adopting the product. That is
 * not an inconvenience; it is the reason a signed customer never goes
 * live, and no amount of feature work downstream of it matters.
 *
 * ── THE FOUR RULES THIS FILE EXISTS TO KEEP ───────────────────────────
 *
 * ALL OR NOTHING. An import of 200 rows that fails at row 150 leaving 149
 * behind is worse than one that refuses everything: the client now has a
 * half-migrated company and no way to tell which half. Commit runs in one
 * transaction.
 *
 * SAY WHAT WOULD HAPPEN FIRST. `preview` does the whole job — parsing,
 * resolving, validating — and writes nothing. Somebody moving their
 * company into a new system is entitled to see the outcome before it
 * happens, and a preview that can differ from the commit is not one, so
 * both call the same code.
 *
 * NEVER OVERWRITE WHAT IS ALREADY LIVE. A row whose natural key already
 * exists is SKIPPED and reported, never updated. An import re-run after a
 * correction must not silently replace a record somebody has since edited
 * in the console — and a client will re-run it, because the first attempt
 * is never the last.
 *
 * NEVER MERGE TWO PEOPLE. A tenant is matched by email, which is a real
 * identifier. Two rows both called "John Kamau" with no email are two
 * people until somebody says otherwise: creating two rows a human can
 * merge is recoverable, and merging two tenants who are not the same
 * person is not.
 * ====================================================================== */

import type { $Enums } from "@prisma/client";
import type { Db } from "../db.ts";
import { badRequest } from "../http/errors.ts";

/** What one line of a client's spreadsheet is asking for. */
export type RowKind = "unit" | "tenant" | "lease";

export interface MigrationRow {
  /*
   * A STRING, NOT RowKind.
   *
   * These rows come off somebody's spreadsheet, so `kind` is whatever they
   * typed. Declaring it as the union would mean a cast at the boundary and a
   * runtime check that TypeScript believes is unreachable — and the check is
   * the thing that produces the useful sentence naming what was not
   * understood.
   */
  readonly kind: string;
  readonly [field: string]: unknown;
}

export type Outcome = "create" | "skip" | "refuse";

export interface RowResult {
  readonly line: number;
  readonly kind: RowKind;
  /** The natural key, so a person can find the row in their own file. */
  readonly key: string;
  readonly outcome: Outcome;
  readonly why: string;
}

export interface MigrationReport {
  readonly rows: readonly RowResult[];
  readonly created: number;
  readonly skipped: number;
  readonly refused: number;
  /** True only when every row would go in. A commit refuses otherwise. */
  readonly clean: boolean;
}

const text = (v: unknown): string => String(v ?? "").trim();

/**
 * Minor units from what a person typed. "45,000.00" is 4500000.
 *
 * AN EMPTY CELL IS ZERO; A CELL WITH WORDS IN IT IS AN ERROR. The first
 * version stripped everything that was not a digit and then treated the
 * empty result as zero — so "not a number", "TBC" and "ask Grace" all
 * imported silently as a rent of nothing. Found by a test that expected
 * three refusals and got two.
 */
function minor(v: unknown): bigint | null {
  const typed = text(v);
  if (!typed) return 0n;
  const raw = typed.replace(/[^0-9.-]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(Math.round(n * 100));
}

function when(v: unknown): Date | null | "bad" {
  const raw = text(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "bad" : d;
}

/**
 * THE WHOLE JOB, DONE ONCE.
 *
 * `commit` is the only difference between a preview and a real import, and
 * it is a single argument rather than a second code path — so a preview
 * that says a row will go in cannot be wrong about it.
 *
 * Resolution looks at the database AND at the rows earlier in the same
 * file, so a lease may reference a unit that this import is creating. That
 * is how a spreadsheet is actually shaped: units on one sheet, leases on
 * the next, and nobody has ids for anything.
 */
export async function runMigration(
  db: Db, orgId: string, rows: readonly MigrationRow[], commit: boolean,
): Promise<MigrationReport> {
  if (!rows.length) throw badRequest("There are no rows to import.");
  if (rows.length > 2000) {
    throw badRequest(
      `That is ${rows.length} rows. Split the file — a single import that has to ` +
      `be reasoned about in halves is harder than two that do not.`);
  }

  /* What this import is creating, by natural key, so a later row can point
     at an earlier one before either exists in the database. */
  const newUnits = new Map<string, { ref: string; rent: bigint; currency: string }>();
  const newTenants = new Map<string, { name: string; email: string }>();
  const newLeases = new Set<string>();
  const results: RowResult[] = [];

  /* Existing keys, read once rather than per row: 200 rows should not be
     600 queries, and a client's first import is the worst possible time to
     discover how this performs. */
  const [units, leases, parties] = await Promise.all([
    db.unit.findMany({ where: { orgId }, select: { id: true, ref: true } }),
    db.lease.findMany({ where: { orgId }, select: { ref: true } }),
    db.party.findMany({
      where: { orgId, email: { not: "" } }, select: { id: true, email: true },
    }),
  ]);
  const unitByRef = new Map(units.map((u) => [u.ref.toUpperCase(), u.id]));
  const leaseRefs = new Set(leases.map((l) => l.ref.toUpperCase()));
  const partyByEmail = new Map(parties.map((p) => [p.email.toLowerCase(), p.id]));

  /*
   * TWO PASSES, BECAUSE A SPREADSHEET IS NOT IN DEPENDENCY ORDER.
   *
   * The first version validated in one forward pass, so a lease listed
   * above its unit was refused for naming a unit that "is not in this file
   * either" — when it was, four lines down. A client's sheets come out in
   * whatever order their old system exported them, and telling them to
   * re-sort the file is asking them to do the computer's job.
   *
   * So units and tenants are collected first, then leases are resolved
   * against everything the file declares, wherever it appears.
   */
  const pass = (only: (k: string) => boolean) => rows.forEach((row, i) => {
    if (!only(row.kind)) return;
    const line = i + 1;
    const add = (kind: RowKind, key: string, outcome: Outcome, why: string) =>
      results.push({ line, kind, key, outcome, why });

    if (row.kind === "unit") {
      const ref = text(row["ref"]);
      if (!ref) return add("unit", `line ${line}`, "refuse", "A unit needs a reference.");
      const k = ref.toUpperCase();
      if (unitByRef.has(k)) {
        return add("unit", ref, "skip", "A unit with this reference is already here.");
      }
      if (newUnits.has(k)) {
        return add("unit", ref, "refuse", "This reference appears twice in the file.");
      }
      const rent = minor(row["rent"]);
      if (rent === null) return add("unit", ref, "refuse", "The rent is not an amount.");
      newUnits.set(k, { ref, rent, currency: text(row["currency"]) || "KES" });
      return add("unit", ref, "create", "");
    }

    if (row.kind === "tenant") {
      const name = text(row["name"]);
      if (!name) return add("tenant", `line ${line}`, "refuse", "A tenant needs a name.");
      const email = text(row["email"]).toLowerCase();

      if (email && partyByEmail.has(email)) {
        return add("tenant", email, "skip", "Somebody with this email is already here.");
      }
      if (email && newTenants.has(email)) {
        return add("tenant", email, "refuse", "This email appears twice in the file.");
      }
      /* No email is not an error. It means this row cannot be matched to
         anybody, so it becomes a new person — said out loud, because two
         rows for one tenant is a thing a human fixes in a minute and a
         wrongly merged tenant is not. */
      const key = email || `${name} (line ${line})`;
      newTenants.set(key, { name, email });
      return add("tenant", key, "create",
        email ? "" : "No email, so this is recorded as a new person rather than matched.");
    }

    if (row.kind === "lease") {
      const ref = text(row["ref"]);
      if (!ref) return add("lease", `line ${line}`, "refuse", "A lease needs a reference.");
      const k = ref.toUpperCase();
      if (leaseRefs.has(k)) {
        return add("lease", ref, "skip", "A lease with this reference is already here.");
      }
      if (newLeases.has(k)) {
        return add("lease", ref, "refuse", "This reference appears twice in the file.");
      }

      const unitRef = text(row["unitRef"]);
      if (!unitRef) return add("lease", ref, "refuse", "A lease needs the unit it is for.");
      const uk = unitRef.toUpperCase();
      if (!unitByRef.has(uk) && !newUnits.has(uk)) {
        return add("lease", ref, "refuse",
          `No unit ${unitRef} — not already here, and not in this file either.`);
      }

      const rent = minor(row["rent"]);
      const deposit = minor(row["deposit"]);
      if (rent === null) return add("lease", ref, "refuse", "The rent is not an amount.");
      if (deposit === null) return add("lease", ref, "refuse", "The deposit is not an amount.");
      const starts = when(row["startsOn"]);
      const ends = when(row["endsOn"]);
      if (starts === "bad") return add("lease", ref, "refuse", "The start date cannot be read.");
      if (ends === "bad") return add("lease", ref, "refuse", "The end date cannot be read.");
      if (starts && ends && ends < starts) {
        return add("lease", ref, "refuse", "The lease ends before it starts.");
      }

      newLeases.add(k);
      return add("lease", ref, "create", "");
    }

    return add("unit", `line ${line}`,
      "refuse", `"${String(row.kind)}" is not something this import understands.`);
  });

  pass((k) => k === "unit" || k === "tenant");
  pass((k) => k !== "unit" && k !== "tenant");

  /* Back into the client's own order, so the report reads like their file. */
  results.sort((a, b) => a.line - b.line);

  const created = results.filter((r) => r.outcome === "create").length;
  const skipped = results.filter((r) => r.outcome === "skip").length;
  const refused = results.filter((r) => r.outcome === "refuse").length;
  const report: MigrationReport = {
    rows: results, created, skipped, refused, clean: refused === 0,
  };

  if (!commit) return report;

  /*
   * A REFUSAL ANYWHERE STOPS EVERYTHING.
   *
   * Not "import the good rows and report the bad" — that leaves a
   * half-migrated company and nobody able to say which half. The client
   * fixes the file and runs it again, which is cheap, and which is what
   * they will do anyway.
   */
  if (refused > 0) {
    throw badRequest(
      `${refused} of ${rows.length} rows cannot be imported, so none were. ` +
      `Fix those rows and run it again — the report says which and why.`);
  }

  await db.$transaction(async (tx) => {
    /* Order matters: a lease needs its unit and its tenant to exist. */
    for (const u of newUnits.values()) {
      await tx.unit.create({
        data: { orgId, ref: u.ref, rent: u.rent, currency: u.currency, status: "VACANT" },
      });
    }
    for (const t of newTenants.values()) {
      await tx.party.create({
        data: { orgId, name: t.name, email: t.email, kind: "TENANT" },
      });
    }

    /* Re-read inside the transaction: the ids of everything just written,
       plus whatever was already there. Resolving from the maps above would
       mean holding ids that did not exist when they were built. */
    const [allUnits, allParties] = await Promise.all([
      tx.unit.findMany({ where: { orgId }, select: { id: true, ref: true } }),
      tx.party.findMany({ where: { orgId }, select: { id: true, email: true, name: true } }),
    ]);
    const uById = new Map(allUnits.map((u) => [u.ref.toUpperCase(), u.id]));
    const pByEmail = new Map(
      allParties.filter((p) => p.email).map((p) => [p.email.toLowerCase(), p.id]));
    const pByName = new Map(allParties.map((p) => [p.name.toLowerCase(), p.id]));

    for (const row of rows) {
      if (row.kind !== "lease") continue;
      /*
       * ONLY THE ONES THE REPORT SAID WOULD BE CREATED.
       *
       * This looped over every lease row, so a re-run of the same file tried
       * to create a lease whose reference already existed and died on the
       * unique constraint — a 500 on the second run of a file that worked
       * the first time, which is exactly what a client does.
       *
       * `newLeases` holds what the pass above decided. The decision is made
       * once and acted on here, rather than being made twice and disagreeing.
       */
      if (!newLeases.has(text(row["ref"]).toUpperCase())) continue;
      const unitRef = text(row["unitRef"]).toUpperCase();
      const email = text(row["tenantEmail"]).toLowerCase();
      const tenantName = text(row["tenantName"]);
      const starts = when(row["startsOn"]);
      const ends = when(row["endsOn"]);

      await tx.lease.create({
        data: {
          orgId, ref: text(row["ref"]),
          unitId: uById.get(unitRef) ?? null,
          unitRef: text(row["unitRef"]),
          tenantId: (email ? pByEmail.get(email) : pByName.get(tenantName.toLowerCase())) ?? null,
          tenantName,
          rent: minor(row["rent"]) ?? 0n,
          deposit: minor(row["deposit"]) ?? 0n,
          currency: text(row["currency"]) || "KES",
          startsOn: starts === "bad" ? null : starts,
          endsOn: ends === "bad" ? null : ends,
          /* DRAFT, deliberately. An imported lease must not occupy its unit
             until somebody has looked at it — see domain/occupancy.ts, where
             an ACTIVE lease moves the unit. A migration that silently filled
             a building would leave nothing for a person to check against
             their own records. */
          status: "DRAFT" as $Enums.LeaseStatus,
        },
      });
    }
  });

  return report;
}
