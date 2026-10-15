/*
 * The import itself: rows become records in the domain's tables, batch by batch, each batch in ONE transaction.
 *
 * - Idempotent: every record carries (source_system, source_record_id), unique per organisation. A record that is
 *   already there is linked (already_present), never created twice — re-running an import creates nothing new.
 * - Money: a batch's ledger posting (e.g. opening balances) goes through postSystemJournal with the batch as its
 *   source document, so a retried batch can never post twice.
 * - Documents: one record per file and what it belongs to (documentKey), so the same file attached to two records
 *   is linked to both, and a re-run finds both.
 * - Dry run: the very same code inside a transaction that is rolled back.
 * - Rollback: deletes only the records a batch created (they point at it) and reverses its journal.
 */
import type { DryRunSummary, Journal } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import { columnOf, entityOf, type EntitySpec, type MigrationDomain, type PostingRow } from "./domain.js";
import { DOCUMENTS_ENTITY, type BatchRow, type DocumentRow, type JobRow, type RowRow } from "./migration.repo.js";

export interface BatchOutcome {
  created: number;
  present: number;
  createdRows: PostingRow[];
  journal: Journal | null;
}

/**
 * The source key of a document record: the file's SHA-256, plus the entity and PALTAS id of the record it is linked
 * to. Identical bytes kept unlinked collapse into one record; identical bytes linked to different records do not.
 */
export function documentKey(sha256: string, linkEntity: string | null, linkId: string | null): string {
  return linkEntity && linkId ? `${sha256}:${linkEntity}:${linkId}` : sha256;
}

/** Split what is ready to import into batches, in the domain's dependency order, documents last. */
export async function createBatches(t: Db, job: JobRow, domain: MigrationDomain, batchSize: number): Promise<number> {
  const last = await t.row<{ n: number }>("SELECT COALESCE(max(seq), 0)::int AS n FROM mig_batches WHERE job_id = $1", [
    job.id,
  ]);
  let seq = last?.n ?? 0;
  let made = 0;
  const add = async (entity: string, ids: (number | string)[], table: "mig_rows" | "mig_documents") => {
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const id = newId("mbt");
      await t.run(
        `INSERT INTO mig_batches (id, org_id, job_id, seq, entity, row_count, status) VALUES ($1, $2, $3, $4, $5, $6, 'queued')`,
        [id, job.org_id, job.id, ++seq, entity, chunk.length],
      );
      await t.run(`UPDATE ${table} SET batch_id = $1 WHERE id = ANY($2)`, [id, chunk]);
      made++;
    }
  };
  for (const spec of domain.entities) {
    const rows = await t.rows<{ id: number }>(
      "SELECT id FROM mig_rows WHERE job_id = $1 AND entity = $2 AND status = 'valid' ORDER BY id",
      [job.id, spec.name],
    );
    await add(
      spec.name,
      rows.map((r) => r.id),
      "mig_rows",
    );
  }
  const docs = await t.rows<{ id: string }>(
    "SELECT id FROM mig_documents WHERE job_id = $1 AND status IN ('linked', 'unlinked') AND target_id IS NULL ORDER BY original_ref COLLATE \"C\"",
    [job.id],
  );
  await add(
    DOCUMENTS_ENTITY,
    docs.map((d) => d.id),
    "mig_documents",
  );
  return made;
}

async function insertRecord(
  t: Db,
  table: string,
  key: { orgId: string; sourceSystem: string; sourceId: string; jobId: string; batchId: string },
  fixed: Record<string, string>,
  columns: Record<string, unknown>,
): Promise<{ id: string; created: boolean }> {
  const all: [string, unknown][] = [
    ["id", newId(table.replace(/^dev_/, "").slice(0, 4))],
    ["org_id", key.orgId],
    ["source_system", key.sourceSystem],
    ["source_record_id", key.sourceId],
    ["mig_job_id", key.jobId],
    ["mig_batch_id", key.batchId],
    ...Object.entries(fixed),
    ...Object.entries(columns),
  ];
  const inserted = await t.row<{ id: string }>(
    `INSERT INTO ${table} (${all.map(([c]) => c).join(", ")}) VALUES (${all.map((_, i) => `$${i + 1}`).join(", ")})
     ON CONFLICT DO NOTHING RETURNING id`,
    all.map(([, v]) => v),
  );
  if (inserted) return { id: inserted.id, created: true };
  const f = Object.entries(fixed);
  const existing = await t.row<{ id: string }>(
    `SELECT id FROM ${table} WHERE org_id = $1 AND source_system = $2 AND source_record_id = $3
     ${f.map(([c], i) => `AND ${c} = $${i + 4}`).join(" ")}`,
    [key.orgId, key.sourceSystem, key.sourceId, ...f.map(([, v]) => v)],
  );
  if (!existing) throw new Error(`Could not insert or find ${table} ${key.sourceId}`);
  return { id: existing.id, created: false };
}

async function importRows(t: Db, job: JobRow, batch: BatchRow, spec: EntitySpec): Promise<BatchOutcome> {
  const rows = await t.rows<Pick<RowRow, "id" | "source_record_id" | "data">>(
    "SELECT id, source_record_id, data FROM mig_rows WHERE batch_id = $1 ORDER BY id",
    [batch.id],
  );
  const refRows = rows.flatMap((r) =>
    Object.values(r.data?.refs ?? {}).flatMap((x) => (x && "rowId" in x ? [x.rowId] : [])),
  );
  const targets = new Map(
    (
      await t.rows<{ id: number; target_id: string | null }>("SELECT id, target_id FROM mig_rows WHERE id = ANY($1)", [
        [...new Set(refRows)],
      ])
    ).map((r) => [r.id, r.target_id]),
  );
  const out: BatchOutcome = { created: 0, present: 0, createdRows: [], journal: null };
  const updates: { id: number; status: string; target: string }[] = [];
  for (const r of rows) {
    const values = r.data?.values ?? {};
    const columns: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (f.type === "ref") {
        const ref = r.data?.refs[f.name];
        if (!ref) continue;
        const id = "targetId" in ref ? ref.targetId : targets.get(ref.rowId);
        if (!id) throw new Error(`Row ${r.id} refers to row ${"rowId" in ref ? ref.rowId : ""}, which is not imported`);
        columns[columnOf(f)] = id;
      } else if (values[f.name] !== null && values[f.name] !== undefined) columns[columnOf(f)] = values[f.name];
    }
    const res = await insertRecord(
      t,
      spec.table,
      {
        orgId: job.org_id,
        sourceSystem: job.source_system,
        sourceId: r.source_record_id as string,
        jobId: job.id,
        batchId: batch.id,
      },
      spec.fixed ?? {},
      columns,
    );
    updates.push({ id: r.id, status: res.created ? "imported" : "already_present", target: res.id });
    if (res.created) {
      out.created++;
      out.createdRows.push({ targetId: res.id, sourceId: r.source_record_id as string, values });
    } else out.present++;
  }
  await t.run(
    `UPDATE mig_rows m SET status = x.s, target_id = x.t FROM unnest($1::bigint[], $2::text[], $3::text[]) AS x(id, s, t)
     WHERE m.id = x.id`,
    [updates.map((u) => u.id), updates.map((u) => u.status), updates.map((u) => u.target)],
  );
  return out;
}

async function importDocuments(t: Db, job: JobRow, batch: BatchRow, domain: MigrationDomain): Promise<BatchOutcome> {
  const docs = await t.rows<DocumentRow>(
    'SELECT * FROM mig_documents WHERE batch_id = $1 ORDER BY original_ref COLLATE "C"',
    [batch.id],
  );
  const out: BatchOutcome = { created: 0, present: 0, createdRows: [], journal: null };
  for (const d of docs) {
    let linkId = d.link_target_id;
    if (d.status === "linked" && !linkId && d.link_entity && d.link_source_id) {
      const r = await t.row<{ target_id: string | null }>(
        "SELECT target_id FROM mig_rows WHERE job_id = $1 AND entity = $2 AND source_record_id = $3 AND target_id IS NOT NULL LIMIT 1",
        [job.id, d.link_entity, d.link_source_id],
      );
      linkId = r?.target_id ?? null;
      if (!linkId)
        throw new Error(`${d.original_ref} is linked to ${d.link_entity} ${d.link_source_id}, which is not imported`);
    }
    const linked = d.status === "linked";
    const res = await insertRecord(
      t,
      domain.documentTable,
      {
        orgId: job.org_id,
        sourceSystem: job.source_system,
        sourceId: documentKey(d.sha256, linked ? d.link_entity : null, linked ? linkId : null),
        jobId: job.id,
        batchId: batch.id,
      },
      {},
      {
        file_id: d.file_id,
        filename: d.filename,
        size_bytes: d.size_bytes,
        sha256: d.sha256,
        detected_type: d.detected_type,
        original_ref: d.original_ref,
        link_entity: linked ? d.link_entity : null,
        link_id: linked ? linkId : null,
      },
    );
    await t.run("UPDATE mig_documents SET target_id = $2 WHERE id = $1", [d.id, res.id]);
    if (res.created) out.created++;
    else out.present++;
  }
  return out;
}

/** Run one batch inside the caller's transaction: records, row statuses, and the batch's ledger posting. */
export async function runBatch(
  t: Db,
  job: JobRow,
  batch: BatchRow,
  domain: MigrationDomain,
  ledger: LedgerService,
): Promise<BatchOutcome> {
  if (batch.entity === DOCUMENTS_ENTITY) return importDocuments(t, job, batch, domain);
  const spec = entityOf(domain, batch.entity);
  if (!spec) throw new Error(`Unknown entity ${batch.entity}`);
  const out = await importRows(t, job, batch, spec);
  const posting = domain.posting?.(spec.name, out.createdRows, job.cutover_date);
  if (posting && posting.lines.length >= 2) {
    out.journal = await ledger.postSystemJournal(t, {
      orgId: job.org_id,
      date: job.cutover_date,
      memo: `${posting.memo} · ${job.number} batch ${batch.seq}`,
      source: "system:migration",
      sourceRef: `migration:${batch.id}`,
      lines: posting.lines,
    });
  }
  return out;
}

class DryRunFinished extends Error {
  constructor(readonly summary: DryRunSummary) {
    super("dry run finished");
  }
}

/** Everything the import would do, inside a transaction that is always rolled back. */
export async function dryRun(
  db: Db,
  job: JobRow,
  domain: MigrationDomain,
  ledger: LedgerService,
  batchSize: number,
  at: string,
): Promise<DryRunSummary> {
  try {
    await db.tx(async (t) => {
      const made = await createBatches(t, job, domain, batchSize);
      const batches = await t.rows<BatchRow>(
        "SELECT * FROM mig_batches WHERE job_id = $1 AND status = 'queued' ORDER BY seq",
        [job.id],
      );
      const byEntity = new Map<string, { create: number; present: number; money: Record<string, number> }>();
      const accounts = new Map<string, { name: string; dr: number; cr: number }>();
      for (const b of batches) {
        const o = await runBatch(t, job, b, domain, ledger);
        const e = byEntity.get(b.entity) ?? { create: 0, present: 0, money: {} };
        e.create += o.created;
        e.present += o.present;
        for (const f of entityOf(domain, b.entity)?.fields.filter((x) => x.type === "money") ?? [])
          e.money[f.name] =
            (e.money[f.name] ?? 0) + o.createdRows.reduce((s, r) => s + (Number(r.values[f.name]) || 0), 0);
        byEntity.set(b.entity, e);
        for (const l of o.journal?.lines ?? []) {
          const a = accounts.get(l.account) ?? { name: l.accountName, dr: 0, cr: 0 };
          a.dr += l.debitMinor;
          a.cr += l.creditMinor;
          accounts.set(l.account, a);
        }
      }
      const validation = job.validation?.byEntity ?? [];
      const entities = domain.entities.map((spec) => {
        const v = validation.find((x) => x.entity === spec.name);
        const e = byEntity.get(spec.name);
        return {
          entity: spec.name,
          create: e?.create ?? 0,
          alreadyPresent: (v?.alreadyPresent ?? 0) + (e?.present ?? 0),
          linkedToExisting: v?.linkedToExisting ?? 0,
          skipped: v?.skipped ?? 0,
          merged: v?.merged ?? 0,
          money: e?.money ?? Object.fromEntries(Object.keys(v?.money ?? {}).map((k) => [k, 0])),
        };
      });
      const docs = await t.rows<{ status: string; n: number }>(
        "SELECT status, count(*)::int AS n FROM mig_documents WHERE job_id = $1 GROUP BY status",
        [job.id],
      );
      const docCount = (s: string) => docs.find((d) => d.status === s)?.n ?? 0;
      throw new DryRunFinished({
        at,
        byEntity: entities.filter((e) => e.create + e.alreadyPresent + e.linkedToExisting + e.skipped + e.merged > 0),
        wouldCreate: entities.reduce((s, e) => s + e.create, 0),
        alreadyPresent: entities.reduce((s, e) => s + e.alreadyPresent, 0),
        documents: { linked: docCount("linked"), unlinked: docCount("unlinked"), excluded: docCount("excluded") },
        ledger: [...accounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([account, a]) => ({ account, name: a.name, debitMinor: a.dr, creditMinor: a.cr })),
        batches: made,
        rolledBack: true,
      });
    });
  } catch (e) {
    if (e instanceof DryRunFinished) return e.summary;
    throw e;
  }
  throw new Error("The dry run did not finish");
}

/** Undo one batch: only what it created, plus the reversal of its journal. */
export async function rollbackBatch(
  t: Db,
  job: JobRow,
  batch: BatchRow,
  domain: MigrationDomain,
  ledger: LedgerService,
): Promise<string | null> {
  const table = batch.entity === DOCUMENTS_ENTITY ? domain.documentTable : entityOf(domain, batch.entity)?.table;
  if (!table) throw new Error(`Unknown entity ${batch.entity}`);
  await t.run("SAVEPOINT migration_rollback");
  try {
    await t.run(`DELETE FROM ${table} WHERE org_id = $1 AND mig_batch_id = $2`, [job.org_id, batch.id]);
    await t.run("RELEASE SAVEPOINT migration_rollback");
  } catch (e) {
    await t.run("ROLLBACK TO SAVEPOINT migration_rollback");
    if ((e as { code?: string }).code === "23503")
      throw fail.conflict(
        "Records added to PALTAS after this batch use what it created — remove or roll those back first",
      );
    throw e;
  }
  if (batch.entity === DOCUMENTS_ENTITY)
    await t.run("UPDATE mig_documents SET target_id = NULL, batch_id = NULL WHERE batch_id = $1", [batch.id]);
  else
    await t.run("UPDATE mig_rows SET status = 'valid', target_id = NULL, batch_id = NULL WHERE batch_id = $1", [
      batch.id,
    ]);
  if (!batch.journal_id) return null;
  const original = await t.row<{ number: string }>("SELECT number FROM journal_entries WHERE id = $1", [
    batch.journal_id,
  ]);
  if (!original) return null;
  const lines = await t.rows<{ account_code: string; debit_minor: number; credit_minor: number; memo: string }>(
    "SELECT account_code, debit_minor, credit_minor, memo FROM journal_lines WHERE entry_id = $1 ORDER BY line_no",
    [batch.journal_id],
  );
  const reversal = await ledger.postSystemJournal(t, {
    orgId: job.org_id,
    date: job.cutover_date,
    memo: `Reversal of ${original.number}: migration ${job.number} batch ${batch.seq} rolled back`,
    source: "system:migration",
    sourceRef: `migration:${batch.id}:reversal`,
    lines: lines.map((l) => ({
      account: l.account_code,
      debitMinor: l.credit_minor,
      creditMinor: l.debit_minor,
      memo: l.memo,
    })),
  });
  return reversal.id;
}
