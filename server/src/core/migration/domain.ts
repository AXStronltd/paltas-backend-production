/*
 * How a product's records become a migration target. A product registers ONE MigrationDomain (through its
 * ProductModule): its entities in dependency order, each entity's fields, required fields, formats, references,
 * duplicate keys, and the domain's own cross-record checks (balances) and ledger postings.
 *
 * The engine is generic: it parses, maps, transforms, checks required fields / formats / references / duplicates /
 * conflicting source records, inserts rows into the entity's table, reconciles counts and money totals and rolls
 * batches back — all from this description. A domain only writes code for what is truly its own (checks, postings).
 */
import type { Product } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import type { AccountSeed } from "../ledger/default-chart.js";
import type { NewLine } from "../ledger/ledger.repo.js";

export type FieldType = "text" | "email" | "phone" | "date" | "money" | "int" | "decimal" | "enum" | "ref";

export interface FieldSpec {
  /** Field name (snake_case). The column is the same name, "<name>_minor" for money, "<x>_id" for a ref "<x>_ref". */
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** enum values */
  values?: readonly string[];
  /** ref: the entity it points to */
  ref?: string;
  /** money: may be negative (e.g. a price reduction) */
  signed?: boolean;
  /** int/decimal bounds; for money, the smallest amount in minor units (1 = must be above zero) */
  min?: number;
  max?: number;
  /** other source column names that mean this field */
  aliases?: readonly string[];
  /** value used when the source has none */
  defaultValue?: string;
  /** a date that, when the source has none, is the migration's cut-over date */
  defaultsToCutover?: boolean;
}

export interface EntitySpec {
  name: string;
  label: string;
  /** target table: must have id, org_id, source_system, source_record_id, mig_job_id, mig_batch_id */
  table: string;
  /** constant columns, e.g. { kind: "buyer" } when two entities share one table */
  fixed?: Record<string, string>;
  fields: FieldSpec[];
  /** sets of fields that identify the same real-world record, e.g. [["email"], ["phone"], ["national_id"]] */
  duplicateKeys?: string[][];
  /** keywords in a sheet or file name that point to this entity */
  hints: readonly string[];
  /** other column names for the record's id in the source system (besides "id", "<entity> id", "ref" …) */
  idAliases?: readonly string[];
  /** the field shown as the record's name in lists */
  labelField: string;
}

/** One row as the checks see it (after mapping, transforms and corrections). */
export interface CheckRow {
  rowId: number;
  entity: string;
  sourceId: string;
  values: Record<string, unknown>;
  /** for refs: the row (in this job) or existing record it resolves to */
  refs: Record<string, ResolvedRef | null>;
  /** the row will not create a record (skipped, merged, or already in PALTAS) */
  inactive: boolean;
}

export type ResolvedRef = { rowId: number } | { targetId: string };

export interface CheckIssue {
  rowId: number | null;
  field?: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface CheckContext {
  cutoverDate: string;
  currency: string;
  rows: CheckRow[];
  byEntity(entity: string): CheckRow[];
  /** the row a resolved ref points to in this job (null for an existing record or no ref) */
  rowOf(ref: ResolvedRef | null | undefined): CheckRow | null;
  /** a single row by id */
  row(rowId: number): CheckRow | null;
  db: Db;
  orgId: string;
}

/** Rows of one batch, after insert, for postings. */
export interface PostingRow {
  targetId: string;
  sourceId: string;
  values: Record<string, unknown>;
}

export interface MigrationDomain {
  key: string;
  label: string;
  product: Product;
  /** in dependency order: an entity only references entities listed before it */
  entities: EntitySpec[];
  /** entities documents may be attached to (filename or manifest match) */
  documentTargets: readonly string[];
  /** the table document records go to */
  documentTable: string;
  /** ledger accounts the domain's postings use, with what they are for */
  accounts: (AccountSeed & { use: string })[];
  /** the domain's own cross-record rules (balances, allocations, links that must agree) */
  checks?(c: CheckContext): Promise<CheckIssue[]>;
  /** the entity the plan's allowance counts (projects for Development, buildings for Property Management) */
  allowanceEntity?: string;
  /** journal lines for a batch of this entity (posted once per batch to the ONE ledger), or null */
  posting?(entity: string, rows: PostingRow[], cutoverDate: string): { memo: string; lines: NewLine[] } | null;
}

export class DomainRegistry {
  private readonly byKey = new Map<string, MigrationDomain>();

  constructor(domains: MigrationDomain[]) {
    for (const d of domains) {
      if (this.byKey.has(d.key)) throw new Error(`Migration domain ${d.key} is registered twice`);
      const seen = new Set<string>();
      for (const e of d.entities) {
        for (const f of e.fields) {
          if (f.type === "ref" && (!f.ref || !seen.has(f.ref)))
            throw new Error(`${d.key}.${e.name}.${f.name} refers to ${f.ref}, which is not listed before it`);
        }
        seen.add(e.name);
      }
      this.byKey.set(d.key, d);
    }
  }

  get all(): MigrationDomain[] {
    return [...this.byKey.values()];
  }

  get(key: string): MigrationDomain | undefined {
    return this.byKey.get(key);
  }
}

export function entityOf(d: MigrationDomain, name: string): EntitySpec | undefined {
  return d.entities.find((e) => e.name === name);
}

/** The column a field is stored in. */
export function columnOf(f: FieldSpec): string {
  if (f.type === "money") return `${f.name}_minor`;
  if (f.type === "ref") return f.name.replace(/_ref$/, "_id");
  return f.name;
}
