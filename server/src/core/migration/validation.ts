/*
 * Validation: every row of every mapped table, checked by the engine and then by the domain.
 *
 * Engine checks (any domain): required fields; formats (dates, money, email, phone, enums); the source id;
 * conflicting rows (same source id, different content — an exact copy is merged and reported); records already in
 * PALTAS from an earlier import (linked, never created twice); references that do not resolve or point to a
 * skipped row; duplicates by the entity's duplicate keys, inside the upload and against existing records;
 * the plan's allowance; documents waiting for a link.
 * Domain checks: its own balance and relationship rules (domain.checks).
 *
 * Decisions a person made (skip, merge, keep, corrections) are applied first. Nothing is dropped silently: every
 * row ends valid, error, skipped, merged, already_present or imported, and every non-valid row has its reason.
 */
import type { ParseSettings, ProfileConfig, ValidationSummary } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import type { EntitlementContext } from "../subscriptions/entitlement.service.js";
import { MANIFEST, SOURCE_ID } from "./detect.js";
import {
  columnOf,
  entityOf,
  type CheckContext,
  type CheckIssue,
  type CheckRow,
  type EntitySpec,
  type MigrationDomain,
  type ResolvedRef,
} from "./domain.js";
import { linkDocuments, type DocumentIssue, type ManifestEntry, type RecordIndex } from "./documents.js";
import type { JobRow, RowRow, TableRow } from "./migration.repo.js";
import { applyTransforms, convert } from "./transforms.js";

type Issue = CheckIssue & { documentId?: string; entity?: string | null };
type Status = RowRow["status"];

interface Work {
  row: RowRow;
  table: TableRow;
  spec: EntitySpec | null;
  check: CheckRow;
  status: Status;
  targetId: string | null;
  /** merged rows: where they went */
  alias: ResolvedRef | null;
}

const normKey: Record<string, (v: string) => string> = {
  email: (v) => v.toLowerCase(),
  phone: (v) => v.replace(/\D/g, ""),
  text: (v) => v.toUpperCase().replace(/\s+/g, ""),
};
const sqlKey: Record<string, (col: string) => string> = {
  email: (c) => `lower(${c})`,
  phone: (c) => `regexp_replace(${c}, '\\D', '', 'g')`,
  text: (c) => `upper(regexp_replace(${c}, '\\s', '', 'g'))`,
};

function fixedSql(spec: EntitySpec, from: number): { sql: string; params: string[] } {
  const f = Object.entries(spec.fixed ?? {});
  return { sql: f.map(([k], i) => ` AND ${k} = $${from + i}`).join(""), params: f.map(([, v]) => v) };
}

/** Rows' mapped values: column transforms (or the person's correction) then the field's type. */
function mapRow(
  w: Work,
  settings: ParseSettings,
  currency: string,
  cutoverDate: string,
  profile: ProfileConfig,
  issues: Issue[],
): void {
  const { row, table, spec } = w;
  const values: Record<string, unknown> = {};
  const err = (field: string, code: string, message: string) =>
    issues.push({ rowId: row.id, field, severity: "error", code, message, entity: table.entity });
  const textOf = (field: string): string | null => {
    if (field in row.correction) return row.correction[field] ?? "";
    const col = table.mapping.find((m) => m.field === field);
    if (!col) return null;
    const r = applyTransforms(row.raw[col.source] ?? "", col.transforms);
    if (!r.ok) {
      err(field, "INVALID_VALUE", `${col.source}: ${r.message}`);
      return "";
    }
    return String(r.value);
  };
  if (table.entity === MANIFEST) {
    for (const f of ["filename", "entity", "record_ref"]) values[f] = (textOf(f) ?? "").trim();
    w.check.values = values;
    return;
  }
  if (!spec) return;
  const sourceId = (textOf(SOURCE_ID) ?? "").trim();
  if (!sourceId) err(SOURCE_ID, "MISSING_SOURCE_ID", "The record's id in the source system is missing");
  for (const f of spec.fields) {
    const text = textOf(f.name);
    const given = text && text.trim() ? text : (f.defaultValue ?? (f.defaultsToCutover ? cutoverDate : ""));
    const c = convert(f, given, settings, currency, profile.enums[`${spec.name}.${f.name}`] ?? {});
    if (!c.ok) {
      err(f.name, "INVALID_VALUE", `${f.label}: ${c.message}`);
      values[f.name] = null;
    } else values[f.name] = c.value;
    if (f.required && c.ok && (c.value === null || c.value === "")) err(f.name, "REQUIRED", `${f.label} is required`);
  }
  w.check.sourceId = sourceId;
  w.check.values = values;
}

export async function runValidation(
  t: Db,
  job: JobRow,
  domain: MigrationDomain,
  profile: ProfileConfig,
  entitlement: EntitlementContext,
  at: string,
): Promise<ValidationSummary> {
  const tables = await t.rows<TableRow>('SELECT * FROM mig_tables WHERE job_id = $1 ORDER BY name COLLATE "C"', [
    job.id,
  ]);
  const unmapped = tables.filter((x) => !x.ignored && !x.entity);
  if (unmapped.length) {
    throw fail.conflict(`Map or ignore every table first: ${unmapped.map((x) => x.name).join(", ")}`);
  }
  const byTable = new Map(tables.map((x) => [x.id, x]));
  const rows = await t.rows<RowRow>("SELECT * FROM mig_rows WHERE job_id = $1 ORDER BY id", [job.id]);
  const issues: Issue[] = [];
  const works: Work[] = [];
  const ignoredRows: number[] = [];
  for (const row of rows) {
    const table = byTable.get(row.table_id) as TableRow;
    if (table.ignored) {
      ignoredRows.push(row.id);
      continue;
    }
    const spec = table.entity === MANIFEST ? null : (entityOf(domain, table.entity ?? "") ?? null);
    const w: Work = {
      row,
      table,
      spec,
      check: { rowId: row.id, entity: table.entity ?? "", sourceId: "", values: {}, refs: {}, inactive: false },
      status: "valid",
      targetId: null,
      alias: null,
    };
    mapRow(w, job.settings, job.currency, job.cutover_date, profile, issues);
    if (row.status === "imported" && row.target_id) {
      w.status = "imported";
      w.targetId = row.target_id;
    } else if (row.decision === "skip") w.status = "skipped";
    else if (row.decision === "merge") {
      w.status = "merged";
      w.alias = row.merge_into_target ? { targetId: row.merge_into_target } : { rowId: row.merge_into_row as number };
    }
    works.push(w);
  }
  const live = (w: Work) => w.status === "valid";
  const records = works.filter((w) => w.spec);
  const ofEntity = (e: string) => records.filter((w) => w.check.entity === e);

  // conflicting rows: one source id, two contents (an exact copy is merged into the first and reported)
  for (const spec of domain.entities) {
    const seen = new Map<string, Work[]>();
    for (const w of ofEntity(spec.name).filter((x) => live(x) || x.status === "imported")) {
      if (!w.check.sourceId) continue;
      seen.set(w.check.sourceId, [...(seen.get(w.check.sourceId) ?? []), w]);
    }
    for (const [id, group] of seen) {
      if (group.length < 2) continue;
      const [first, ...rest] = group as [Work, ...Work[]];
      const same = rest.every((w) => JSON.stringify(w.check.values) === JSON.stringify(first.check.values));
      if (same) {
        for (const w of rest.filter(live)) {
          w.status = "merged";
          w.alias = { rowId: first.row.id };
          issues.push({
            rowId: w.row.id,
            severity: "warning",
            code: "EXACT_DUPLICATE",
            message: `An exact copy of ${spec.label.toLowerCase()} ${id} (row ${first.row.row_no} of ${first.table.name}) — imported once`,
            entity: spec.name,
          });
        }
      } else
        for (const w of group.filter(live))
          issues.push({
            rowId: w.row.id,
            field: SOURCE_ID,
            severity: "error",
            code: "CONFLICTING_RECORD",
            message: `${group.length} different rows claim to be ${spec.label.toLowerCase()} ${id} (rows ${group.map((x) => `${x.table.name}:${x.row.row_no}`).join(", ")}) — correct or skip all but one`,
            entity: spec.name,
          });
    }
  }

  // already in PALTAS from an earlier import with the same source system: linked, never created twice
  for (const spec of domain.entities) {
    const pending = ofEntity(spec.name).filter((w) => live(w) && w.check.sourceId);
    if (!pending.length) continue;
    const fx = fixedSql(spec, 4);
    const found = await t.rows<{ id: string; source_record_id: string }>(
      `SELECT id, source_record_id FROM ${spec.table} WHERE org_id = $1 AND source_system = $2 AND source_record_id = ANY($3)${fx.sql}`,
      [job.org_id, job.source_system, pending.map((w) => w.check.sourceId), ...fx.params],
    );
    const ids = new Map(found.map((f) => [f.source_record_id, f.id]));
    for (const w of pending) {
      const id = ids.get(w.check.sourceId);
      if (!id) continue;
      w.status = "already_present";
      w.targetId = id;
      issues.push({
        rowId: w.row.id,
        severity: "warning",
        code: "ALREADY_PRESENT",
        message: `${spec.label} ${w.check.sourceId} is already in PALTAS from an earlier import — it will be linked, not created again`,
        entity: spec.name,
      });
    }
  }

  // what each source id resolves to
  const index: RecordIndex = new Map();
  const skippedIds = new Map<string, Set<string>>();
  const byRow = new Map(records.map((w) => [w.row.id, w]));
  const follow = (w: Work, depth = 0): ResolvedRef | null => {
    if (w.status === "imported" || w.status === "already_present") return w.targetId ? { targetId: w.targetId } : null;
    if (w.status === "merged" && w.alias) {
      if ("targetId" in w.alias) return w.alias;
      const into = byRow.get(w.alias.rowId);
      return into && depth < 10 ? follow(into, depth + 1) : null;
    }
    if (w.status === "skipped") return null;
    return { rowId: w.row.id };
  };
  for (const w of records) {
    if (!w.check.sourceId) continue;
    const r = follow(w);
    if (!index.has(w.check.entity)) index.set(w.check.entity, new Map());
    const m = index.get(w.check.entity) as Map<string, ResolvedRef>;
    if (r && !m.has(w.check.sourceId)) m.set(w.check.sourceId, r);
    if (!r) skippedIds.set(w.check.entity, (skippedIds.get(w.check.entity) ?? new Set()).add(w.check.sourceId));
  }
  // references to records outside the upload (imported earlier with the same source system)
  for (const spec of domain.entities) {
    for (const f of spec.fields.filter((x) => x.type === "ref")) {
      const target = entityOf(domain, f.ref as string) as EntitySpec;
      const missing = [
        ...new Set(
          ofEntity(spec.name)
            .filter(live)
            .map((w) => w.check.values[f.name])
            .filter((v): v is string => typeof v === "string" && !!v && !index.get(target.name)?.has(v)),
        ),
      ];
      if (!missing.length) continue;
      const fx = fixedSql(target, 4);
      const found = await t.rows<{ id: string; source_record_id: string }>(
        `SELECT id, source_record_id FROM ${target.table} WHERE org_id = $1 AND source_system = $2 AND source_record_id = ANY($3)${fx.sql}`,
        [job.org_id, job.source_system, missing, ...fx.params],
      );
      if (!index.has(target.name)) index.set(target.name, new Map());
      for (const x of found) index.get(target.name)?.set(x.source_record_id, { targetId: x.id });
    }
  }
  for (const w of records.filter(live)) {
    for (const f of (w.spec as EntitySpec).fields.filter((x) => x.type === "ref")) {
      const v = w.check.values[f.name];
      if (typeof v !== "string" || !v) {
        w.check.refs[f.name] = null;
        continue;
      }
      const hit = index.get(f.ref as string)?.get(v) ?? null;
      w.check.refs[f.name] = hit;
      if (hit) continue;
      const label = entityOf(domain, f.ref as string)?.label ?? f.ref;
      issues.push(
        skippedIds.get(f.ref as string)?.has(v)
          ? {
              rowId: w.row.id,
              field: f.name,
              severity: "error",
              code: "REFERENCE_SKIPPED",
              message: `${f.label}: ${label} ${v} is skipped — skip this row too, or undo that decision`,
              entity: w.check.entity,
            }
          : {
              rowId: w.row.id,
              field: f.name,
              severity: "error",
              code: "BROKEN_REFERENCE",
              message: `${f.label}: ${label} ${v} is not in the upload or in PALTAS`,
              entity: w.check.entity,
            },
      );
    }
  }

  // duplicates by the entity's keys: inside the upload, and against records already in PALTAS
  for (const spec of domain.entities) {
    for (const keys of spec.duplicateKeys ?? []) {
      const fields = keys.map((k) => spec.fields.find((f) => f.name === k)).filter((f) => !!f);
      const keyOf = (w: Work) => {
        const parts = fields.map((f) => w.check.values[f.name]);
        if (parts.some((p) => p === null || p === undefined || p === "")) return null;
        return parts.map((p, i) => (normKey[fields[i]?.type ?? "text"] ?? normKey.text)?.(String(p))).join("|");
      };
      const groups = new Map<string, Work[]>();
      for (const w of ofEntity(spec.name).filter(live)) {
        const k = keyOf(w);
        if (k) groups.set(k, [...(groups.get(k) ?? []), w]);
      }
      const what = keys.map((k) => fields.find((f) => f.name === k)?.label ?? k).join(" + ");
      for (const group of groups.values()) {
        const open = group.filter((w) => w.row.decision !== "keep");
        if (group.length < 2 || open.length < 2) continue;
        for (const w of open)
          issues.push({
            rowId: w.row.id,
            severity: "error",
            code: "DUPLICATE",
            message: `Same ${what} as ${group
              .filter((x) => x !== w)
              .map((x) => `${spec.label.toLowerCase()} ${x.check.sourceId}`)
              .join(", ")} — merge them, or keep both if they are different`,
            entity: spec.name,
          });
      }
      const candidates = [...groups.entries()].filter(([, g]) => g.some((w) => w.row.decision !== "keep"));
      if (!candidates.length) continue;
      const expr = fields.map((f) => (sqlKey[f.type] ?? sqlKey.text)?.(columnOf(f))).join(" || '|' || ");
      const fx = fixedSql(spec, 3);
      const existing = await t.rows<{ id: string; k: string; label: string }>(
        `SELECT id, ${expr} AS k, ${spec.labelField}::text AS label FROM ${spec.table}
         WHERE org_id = $1 AND ${expr} = ANY($2)${fx.sql}`,
        [job.org_id, candidates.map(([k]) => k), ...fx.params],
      );
      for (const e of existing) {
        for (const w of groups.get(e.k) ?? []) {
          if (w.row.decision === "keep") continue;
          issues.push({
            rowId: w.row.id,
            severity: "error",
            code: "DUPLICATE_EXISTING",
            message: `Same ${what} as ${spec.label.toLowerCase()} "${e.label}" already in PALTAS (${e.id}) — merge into it, or keep both`,
            entity: spec.name,
          });
        }
      }
    }
  }

  // the domain's own rules
  const checkRows = records.map((w) => {
    w.check.inactive = !live(w);
    return w.check;
  });
  const checkRowById = new Map(checkRows.map((r) => [r.rowId, r]));
  const ctx: CheckContext = {
    cutoverDate: job.cutover_date,
    currency: job.currency,
    rows: checkRows,
    byEntity: (e) => checkRows.filter((r) => r.entity === e),
    rowOf: (ref) => (ref && "rowId" in ref ? (checkRowById.get(ref.rowId) ?? null) : null),
    row: (id) => checkRowById.get(id) ?? null,
    db: t,
    orgId: job.org_id,
  };
  for (const i of (await domain.checks?.(ctx)) ?? [])
    issues.push({ ...i, entity: i.rowId ? (checkRowById.get(i.rowId)?.entity ?? null) : null });

  // the plan's allowance (projects for Development)
  if (domain.allowanceEntity) {
    const fresh = ofEntity(domain.allowanceEntity).filter(live).length;
    const { used, allowed } = entitlement.ent.buildings;
    if (fresh && used + fresh > allowed) {
      const label = entityOf(domain, domain.allowanceEntity)?.label.toLowerCase() ?? domain.allowanceEntity;
      issues.push({
        rowId: null,
        severity: "error",
        code: "ALLOWANCE_EXCEEDED",
        message: `This migration adds ${fresh} ${label}(s); your plan allows ${allowed} and ${used} are in use — upgrade or skip some`,
        entity: domain.allowanceEntity,
      });
    }
  }

  // documents
  const manifest: ManifestEntry[] = works
    .filter((w) => w.table.entity === MANIFEST && w.status === "valid")
    .map((w) => ({
      rowId: w.row.id,
      filename: String(w.check.values.filename ?? ""),
      entity: String(w.check.values.entity ?? ""),
      recordRef: String(w.check.values.record_ref ?? ""),
    }));
  const docIssues: DocumentIssue[] = await linkDocuments(t, job, domain, index, manifest);

  // row statuses
  const erroneous = new Set(issues.filter((i) => i.severity === "error" && i.rowId).map((i) => i.rowId));
  for (const w of works) if (live(w) && erroneous.has(w.row.id)) w.status = "error";

  // write back
  await t.run("DELETE FROM mig_issues WHERE job_id = $1", [job.id]);
  const all: Issue[] = [...issues, ...docIssues];
  for (let i = 0; i < all.length; i += 2000) {
    const c = all.slice(i, i + 2000);
    await t.run(
      `INSERT INTO mig_issues (org_id, job_id, row_id, document_id, entity, field, severity, code, message)
       SELECT $1, $2, r, d, e, f, s, c, m
       FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) AS x(r, d, e, f, s, c, m)`,
      [
        job.org_id,
        job.id,
        c.map((x) => x.rowId),
        c.map((x) => x.documentId ?? null),
        c.map((x) => x.entity ?? null),
        c.map((x) => x.field ?? null),
        c.map((x) => x.severity),
        c.map((x) => x.code),
        c.map((x) => x.message),
      ],
    );
  }
  for (let i = 0; i < works.length; i += 2000) {
    const c = works.slice(i, i + 2000);
    await t.run(
      `UPDATE mig_rows m SET entity = x.e, source_record_id = NULLIF(x.s, ''), data = x.d::jsonb, status = x.st,
         target_id = x.tg
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(id, e, s, d, st, tg)
       WHERE m.id = x.id`,
      [
        c.map((w) => w.row.id),
        c.map((w) => w.table.entity),
        c.map((w) => w.check.sourceId),
        c.map((w) => JSON.stringify({ values: w.check.values, refs: w.check.refs })),
        c.map((w) => w.status),
        c.map((w) => w.targetId),
      ],
    );
  }
  if (ignoredRows.length)
    await t.run("UPDATE mig_rows SET status = 'skipped', data = NULL WHERE id = ANY($1)", [ignoredRows]);

  // summary
  const byCode: Record<string, number> = {};
  for (const i of all) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  const byEntity = domain.entities
    .map((spec) => {
      const ws = ofEntity(spec.name);
      const money: Record<string, number> = {};
      for (const f of spec.fields.filter((x) => x.type === "money"))
        money[f.name] = ws.filter(live).reduce((s, w) => s + (Number(w.check.values[f.name]) || 0), 0);
      return {
        entity: spec.name,
        create: ws.filter(live).length,
        alreadyPresent: ws.filter((w) => w.status === "already_present" || w.status === "imported").length,
        linkedToExisting: ws.filter((w) => w.status === "merged" && w.alias && "targetId" in w.alias).length,
        skipped: ws.filter((w) => w.status === "skipped").length,
        merged: ws.filter((w) => w.status === "merged" && w.alias && "rowId" in w.alias).length,
        money,
      };
    })
    .filter((e) => e.create + e.alreadyPresent + e.linkedToExisting + e.skipped + e.merged > 0);
  const errors = all.filter((i) => i.severity === "error").length;
  return {
    at,
    errors,
    warnings: all.length - errors,
    blocking: errors > 0,
    byCode,
    byEntity,
  };
}
