/* ====================================================================== *
 * WHAT A RESOURCE DECLARATION IS.
 *
 * ── WHY THIS FILE IS THE POINT OF THE MIGRATION ────────────────────────
 *
 * 71 declarations in registry.ts generate about 350 endpoints. Each one names
 * a Prisma model, an area, and a kind for every writable field:
 *
 *     projectId: "id:project", severity: "enum:DefectSeverity", price: "money"
 *
 * Those were strings. Nothing checked them at author time, and three separate
 * test files exist to check them afterwards — that `id:project` names a real
 * model, that `enum:DefectSeverity` names a real enum, that `money` is a
 * BigInt column and not an Int.
 *
 * A typo in one is not a type error today. `"id:projct"` compiles, deploys,
 * and fails on the first request that tries to create the row, with a message
 * about a column nobody recognises.
 *
 * Below, `id:` and `enum:` are template-literal types built from PRISMA'S OWN
 * generated names. `"id:projct"` now stops compiling, and TypeScript suggests
 * `"id:project"` while it does it.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────
 *
 * The declarations are not given a per-model generic. It is possible —
 * `include` and `onRead` could be typed against the exact Prisma payload for
 * each model — and it would make this file the hardest thing in the service
 * to read for a benefit the tests already provide. The line is drawn at what
 * a typo can reach.
 * ====================================================================== */

import type { $Enums, Prisma } from "@prisma/client";
import type { Db } from "../db.ts";
import type { Area } from "./access.ts";
import type { AuthenticatedRequest } from "../http/request.ts";

/**
 * Every model, spelled the way the Prisma client accesses it.
 *
 * `Prisma.ModelName` is PascalCase — "Rfi", "PurchaseOrder" — and the client
 * exposes `db.rfi`, `db.purchaseOrder`. Uncapitalize is the bridge, and it is
 * derived rather than listed so the schema stays the single source of truth.
 */
export type ModelKey = Uncapitalize<Prisma.ModelName>;

/** Every enum the schema declares. */
export type EnumName = keyof typeof $Enums;

/**
 * WHAT A FIELD IS, AND WHAT MAY BE WRITTEN INTO IT.
 *
 * `money` and `signed-money` are the same BigInt column with opposite rules
 * about the sign — see the note in domain/input.ts. They are separate kinds
 * rather than one kind with a flag so that every use of the lenient one is
 * visible here, and `money` stays strict by default.
 */
export type ScalarKind =
  | "string"
  | "text"
  | "int"
  | "float"
  | "bool"
  | "date"
  | "money"
  | "signed-money";

/** A reference to another row in the same company. */
export type ReferenceKind = `id:${ModelKey}`;

/** A value from one of the schema's own enums. */
export type EnumKind = `enum:${EnumName}`;

export type FieldKind = ScalarKind | ReferenceKind | EnumKind;

/**
 * A row on its way out, with whatever `onRead` adds.
 *
 * Deliberately loose: a declaration's `include` decides the shape, and typing
 * each one against its exact Prisma payload would mean a generic per resource.
 * What matters is that the hook is PURE and SYNCHRONOUS — a hook that could
 * query would be one query per row on every list, which is how a fast list
 * becomes a slow one without anybody noticing.
 */
export type ReadRow = Record<string, unknown>;

/** Extra fields to merge onto a row as it is read. See `onRead` in resource.ts. */
export type OnRead = (row: ReadRow) => Record<string, unknown>;

/* ---------------------------------------------------------------- *
 * READING A COLUMN OFF A ROW WHOSE SHAPE IS NOT KNOWN HERE.
 *
 * `onRead` receives a Prisma row, and which columns it has depends on which
 * model it is — so the parameter is `Record<string, unknown>` and every read
 * off it is `unknown`. That is correct and it is also inconvenient 51 times
 * over, which is exactly the situation that produces an `any`.
 *
 * These four are the alternative: small, named, and doing the coercion once
 * where it can be read, rather than at 51 call sites where it cannot.
 * ---------------------------------------------------------------- */

/** A status column, as text. Empty string when absent — never undefined. */
export const statusOf = (row: ReadRow): string => String(row["status"] ?? "");

/** A text column. */
export const textOf = (row: ReadRow, column: string): string =>
  String(row[column] ?? "");

/** A date column, or null. Prisma hands back a Date; a Json path may not. */
export function dateOf(row: ReadRow, column: string): Date | null {
  const v = row[column];
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** A count or amount as a number. BigInt included — money is BigInt here. */
export const numberOf = (row: ReadRow, column: string): number => {
  const v = row[column];
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
};

/**
 * Is this date column in the past?
 *
 * Every "overdue" and "lapsed" flag in the registry asks exactly this, and
 * each one used to spell it `!!row.x && new Date(row.x) < new Date()`. Said
 * once, it is also the place to be clear that these are facts about NOW —
 * computed on the way out rather than stored and left to go stale overnight.
 */
export const isPast = (row: ReadRow, column: string): boolean => {
  const d = dateOf(row, column);
  return d !== null && d < new Date();
};

/** Whether a column holds something. Used for `expenseId`, `lockedAt`, `leftOn`. */
export const isSet = (row: ReadRow, column: string): boolean => {
  const v = row[column];
  return v !== null && v !== undefined && v !== "";
};

/**
 * What to do once a write has succeeded and been audited.
 *
 * It CANNOT undo the write, deliberately — a throw here is caught and logged.
 * The rule it exists for is that bookkeeping never blocks the business record:
 * an expense that was genuinely incurred must be recorded whether or not the
 * company has set up a chart of accounts.
 */
export interface AfterWriteContext {
  readonly row: ReadRow;
  /** The row as it was, on an update. Null on a create. */
  readonly before: ReadRow | null;
  readonly action: "create" | "update";
  /**
   * The request, for the actor and the session.
   *
   * AUTHENTICATED, because afterWrite only ever runs after a write that the
   * resource framework has already permission-checked — which means through
   * requireSession() and requireOrganization(). Declaring it as an ordinary
   * Request would mean an `if (!req.actor)` in every hook that could never be
   * true and could never be tested.
   */
  readonly req: AuthenticatedRequest;
  /** The same client every module shares, passed in so the hook is testable. */
  readonly db: Db;
}

export type AfterWrite =
  (ctx: AfterWriteContext) => Promise<Record<string, unknown> | undefined | void>;

/**
 * Totals computed across a page of rows, in one query rather than one per row.
 *
 * `id` is named because every rollup starts by collecting the page's ids —
 * a portfolio of forty buildings must not become eighty round trips — and
 * because `Record<string, unknown>` alone makes `rows.map((r) => r.id)` an
 * array of `unknown`, which then breaks Prisma's own inference three calls
 * downstream. Naming the one field they all read costs nothing and keeps the
 * query types intact.
 */
export type RollupRow = ReadRow & { readonly id: string };

export type Rollup =
  (page: readonly RollupRow[], orgId: string) => Promise<readonly ReadRow[]>;

/**
 * ONE RESOURCE.
 *
 * Every string that names something elsewhere — a model, an area, an enum,
 * another model — is checked against the thing it names.
 */
export interface ResourceDeclaration {
  /** The Prisma accessor: `db[model]`. */
  readonly model: ModelKey;
  /** Which of the nine areas governs it. See domain/access.ts. */
  readonly area: Area;
  /**
   * The product that must be entitled, or null for something every company
   * has — parties, documents, the ledger.
   */
  readonly product?: string | null;
  /** What to call it in a refusal a person reads. */
  readonly label: string;

  /** Every column a request may write, and what may go in it. */
  readonly fields: Readonly<Record<string, FieldKind>>;
  /** Columns a create must carry. Checked against NOT NULL in registry.test.js. */
  readonly required?: readonly string[];
  /** The console's own abbreviations. Built from console-map.ts. */
  readonly aliases?: Readonly<Record<string, string>>;

  /** Which columns a `?q=` searches. */
  readonly search?: readonly string[];
  /** Default ordering, as Prisma takes it. */
  readonly order?: readonly Record<string, "asc" | "desc">[];
  /** What to join on a read. */
  readonly include?: Record<string, unknown>;

  /**
   * The column whose change appends a history row. Defaults to "status".
   *
   * Supported by the framework and used by no declaration today — which is
   * why it was missing from the first draft of this type, and why the
   * compiler pointed at the two places that read it.
   */
  readonly statusField?: string;

  /** The column a per-company number is written to, usually `ref`. */
  readonly numbered?: string;
  /** Its prefix — INV, RFI, MSG. Upper case letters only. */
  readonly prefix?: string;

  /** Derived fields added on the way out. Pure and synchronous. */
  readonly onRead?: OnRead;
  /** What happens after a successful write. Cannot undo it. */
  readonly afterWrite?: AfterWrite;
  /** Totals across a page, computed in one query. */
  readonly rollup?: Rollup;

  /**
   * WHY THE FRAMEWORK DOES NOT BUILD THIS VERB.
   *
   * Each is a SENTENCE, not a boolean, and routing.test.js refuses one
   * shorter than thirty characters. A flag says a route is missing; a
   * sentence says where it went and why — which is the difference between a
   * reviewer finding the hand-written route and a reviewer finding a 404.
   *
   *   ownCreate  written by hand elsewhere in this service
   *   ownUpdate  the same bargain for edits
   *   noCreate   nothing creates it through a POST to its own path at all
   *   noDelete   nothing deletes it, ever
   */
  readonly ownCreate?: string;
  readonly ownUpdate?: string;
  readonly noCreate?: string;
  readonly noDelete?: string;

  /**
   * An append-only trail written beside every status change.
   *
   * `key` is the column on the EVENT that points back — `workOrderId`,
   * `incidentId`. `status` is the column being watched. Both are named
   * because the framework writes the row itself and has nothing else to go on.
   */
  readonly history?: {
    readonly model: ModelKey;
    readonly key: string;
    readonly status: string;
  };
}

/** The whole registry: a slug for every resource. */
export type Registry = Readonly<Record<string, ResourceDeclaration>>;
