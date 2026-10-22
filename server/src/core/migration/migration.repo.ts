// SQL for the migration engine: rows of the mig_* tables and their API shapes. No business rules here.
import type {
  ColumnMapping,
  DryRunSummary,
  MigrationBatch,
  MigrationDocument,
  MigrationFile,
  MigrationIssue,
  MigrationJob,
  MigrationStatus,
  MigrationTable,
  ParseSettings,
  Reconciliation,
  ValidationSummary,
} from "@paltas/contracts";
import type { TableAnalysis } from "./files/tables.js";
import type { Db } from "../../db/database.js";

export interface JobRow {
  id: string;
  org_id: string;
  number: string;
  domain: string;
  name: string;
  source_system: string;
  profile_id: string | null;
  cutover_date: string;
  currency: string;
  settings: ParseSettings;
  status: MigrationStatus;
  created_by: string;
  validation: ValidationSummary | null;
  dry_run: DryRunSummary | null;
  dry_run_by: string | null;
  dry_run_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  reconciliation: Reconciliation | null;
  completed_by: string | null;
  completed_at: string | null;
  last_error: string | null;
  /** bumped by every change to what would be imported; dry_run_revision is the one the dry run saw */
  revision: number;
  dry_run_revision: number | null;
  /** everyone who changed a mapping, a row or a document decision (none of them may approve) */
  changed_by: string[];
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  org_id: string;
  job_id: string;
  parent_id: string | null;
  filename: string;
  original_ref: string;
  declared_size: number;
  declared_sha256: string | null;
  size_bytes: number | null;
  sha256: string | null;
  detected_type: string | null;
  status: "uploading" | "stored" | "refused";
  refusal: string | null;
  created_at: string;
  received_bytes?: number;
}

export interface TableRow {
  id: string;
  job_id: string;
  file_id: string;
  name: string;
  headers: string[];
  row_count: number;
  entity: string | null;
  confidence: number;
  ignored: boolean;
  mapping: ColumnMapping[];
  sample: Record<string, string>[];
  analysis?: TableAnalysis | null;
}

export interface RowRow {
  id: number;
  job_id: string;
  table_id: string;
  row_no: number;
  raw: Record<string, string>;
  entity: string | null;
  source_record_id: string | null;
  data: {
    values: Record<string, unknown>;
    refs: Record<string, { rowId: number } | { targetId: string } | null>;
  } | null;
  correction: Record<string, string>;
  decision: "skip" | "merge" | "keep" | null;
  decision_reason: string | null;
  merge_into_row: number | null;
  merge_into_target: string | null;
  status: "pending" | "valid" | "error" | "skipped" | "merged" | "already_present" | "imported";
  batch_id: string | null;
  target_id: string | null;
}

export interface BatchRow {
  id: string;
  org_id: string;
  job_id: string;
  seq: number;
  entity: string;
  row_count: number;
  status: MigrationBatch["status"];
  attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  error: string | null;
  created_count: number;
  present_count: number;
  journal_id: string | null;
  reversal_journal_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  rolled_back_by: string | null;
  rollback_reason: string | null;
}

export interface DocumentRow {
  id: string;
  job_id: string;
  file_id: string;
  filename: string;
  original_ref: string;
  size_bytes: number;
  sha256: string;
  detected_type: string;
  status: MigrationDocument["status"];
  link_mode: "auto" | "manual" | null;
  link_entity: string | null;
  link_source_id: string | null;
  link_target_id: string | null;
  reason: string;
  candidates: { entity: string; sourceRecordId: string }[];
  batch_id: string | null;
  target_id: string | null;
}

export const DOCUMENTS_ENTITY = "__documents";

export async function jobRow(db: Db, orgId: string, jobId: string, lock = false): Promise<JobRow | null> {
  return db.row<JobRow>(`SELECT * FROM mig_jobs WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [
    orgId,
    jobId,
  ]);
}

interface CountsRow {
  files: number;
  refused: number;
  tables: number;
  rows: number;
  valid: number;
  errors: number;
  skipped: number;
  merged: number;
  present: number;
  imported: number;
  documents: number;
  review: number;
  b_total: number;
  b_done: number;
  b_failed: number;
  b_rolled: number;
  to_import: number;
  done_rows: number;
}

export async function toJob(db: Db, j: JobRow): Promise<MigrationJob> {
  const c = (await db.row<CountsRow>(
    `SELECT
       (SELECT count(*) FROM mig_files WHERE job_id = $1 AND status = 'stored')::int AS files,
       (SELECT count(*) FROM mig_files WHERE job_id = $1 AND status = 'refused')::int AS refused,
       (SELECT count(*) FROM mig_tables WHERE job_id = $1)::int AS tables,
       r.rows, r.valid, r.errors, r.skipped, r.merged, r.present, r.imported,
       (SELECT count(*) FROM mig_documents WHERE job_id = $1)::int AS documents,
       (SELECT count(*) FROM mig_documents WHERE job_id = $1 AND status = 'review')::int AS review,
       b.b_total, b.b_done, b.b_failed, b.b_rolled, b.to_import, b.done_rows
     FROM
       (SELECT count(*)::int AS rows,
               count(*) FILTER (WHERE status = 'valid')::int AS valid,
               count(*) FILTER (WHERE status = 'error')::int AS errors,
               count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
               count(*) FILTER (WHERE status = 'merged')::int AS merged,
               count(*) FILTER (WHERE status = 'already_present')::int AS present,
               count(*) FILTER (WHERE status = 'imported')::int AS imported
        FROM mig_rows WHERE job_id = $1) r,
       (SELECT count(*) FILTER (WHERE status <> 'rolled_back')::int AS b_total,
               count(*) FILTER (WHERE status = 'done')::int AS b_done,
               count(*) FILTER (WHERE status = 'failed')::int AS b_failed,
               count(*) FILTER (WHERE status = 'rolled_back')::int AS b_rolled,
               COALESCE(sum(row_count) FILTER (WHERE status <> 'rolled_back'), 0)::int AS to_import,
               COALESCE(sum(row_count) FILTER (WHERE status = 'done'), 0)::int AS done_rows
        FROM mig_batches WHERE job_id = $1) b`,
    [j.id],
  )) as CountsRow;
  return {
    id: j.id,
    number: j.number,
    domain: j.domain,
    name: j.name,
    sourceSystem: j.source_system,
    profileId: j.profile_id,
    cutoverDate: j.cutover_date,
    currency: j.currency,
    settings: j.settings,
    status: j.status,
    createdBy: j.created_by,
    dryRunBy: j.dry_run_by,
    dryRunAt: j.dry_run_at,
    approvedBy: j.approved_by,
    approvedAt: j.approved_at,
    completedBy: j.completed_by,
    completedAt: j.completed_at,
    lastError: j.last_error,
    counts: {
      files: c.files,
      refusedFiles: c.refused,
      tables: c.tables,
      rows: c.rows,
      valid: c.valid,
      errors: c.errors,
      skipped: c.skipped,
      merged: c.merged,
      alreadyPresent: c.present,
      imported: c.imported,
      documents: c.documents,
      documentsInReview: c.review,
    },
    progress: {
      batchesTotal: c.b_total,
      batchesDone: c.b_done,
      batchesFailed: c.b_failed,
      batchesRolledBack: c.b_rolled,
      rowsToImport: c.to_import,
      rowsImported: c.done_rows,
      percent: c.to_import ? Math.floor((100 * c.done_rows) / c.to_import) : 0,
    },
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

export const toFile = (f: FileRow): MigrationFile => ({
  id: f.id,
  parentId: f.parent_id,
  filename: f.filename,
  originalRef: f.original_ref,
  sizeBytes: f.size_bytes,
  sha256: f.sha256,
  detectedType: f.detected_type,
  status: f.status,
  refusal: f.refusal,
  receivedBytes: f.received_bytes ?? (f.status === "stored" ? (f.size_bytes ?? 0) : 0),
  createdAt: f.created_at,
});

export const FILE_COLUMNS = `id, org_id, job_id, parent_id, filename, original_ref, declared_size, declared_sha256,
  size_bytes, sha256, detected_type, status, refusal, created_at,
  (SELECT COALESCE(sum(length(data)), 0)::bigint FROM mig_upload_chunks c WHERE c.file_id = mig_files.id) AS received_bytes`;

export function toTable(t: TableRow): MigrationTable {
  const mapped = new Set(t.mapping.map((m) => m.source));
  return {
    id: t.id,
    fileId: t.file_id,
    name: t.name,
    headers: t.headers,
    rowCount: t.row_count,
    entity: t.entity,
    confidence: Number(t.confidence),
    ignored: t.ignored,
    mapping: t.mapping,
    unmappedColumns: t.ignored ? [] : t.headers.filter((h) => !mapped.has(h)),
    sample: t.sample,
    analysis: t.analysis ?? null,
  };
}

export interface IssueRow {
  id: number;
  row_id: number | null;
  document_id: string | null;
  entity: string | null;
  field: string | null;
  severity: "error" | "warning";
  code: string;
  message: string;
  source_record_id: string | null;
  table_name: string | null;
  row_no: number | null;
}

export const ISSUE_SELECT = `SELECT i.id, i.row_id, i.document_id, i.entity, i.field, i.severity, i.code, i.message,
    r.source_record_id, t.name AS table_name, CASE WHEN r.entity='historical_summary' AND r.raw->>'source_cell' ~ '^[A-Z]{1,3}[0-9]{1,7}$' THEN regexp_replace(r.raw->>'source_cell','^[A-Z]+','')::int ELSE r.row_no END AS row_no
  FROM mig_issues i LEFT JOIN mig_rows r ON r.id = i.row_id LEFT JOIN mig_tables t ON t.id = r.table_id`;

export const toIssue = (i: IssueRow): MigrationIssue => ({
  id: String(i.id),
  rowId: i.row_id === null ? null : String(i.row_id),
  documentId: i.document_id,
  entity: i.entity,
  sourceRecordId: i.source_record_id,
  table: i.table_name,
  rowNo: i.row_no,
  field: i.field,
  severity: i.severity,
  code: i.code,
  message: i.message,
});

export const toBatch = (b: BatchRow): MigrationBatch => ({
  id: b.id,
  seq: b.seq,
  entity: b.entity,
  rowCount: b.row_count,
  status: b.status,
  attempts: b.attempts,
  error: b.error,
  createdCount: b.created_count,
  presentCount: b.present_count,
  journalId: b.journal_id,
  reversalJournalId: b.reversal_journal_id,
  startedAt: b.started_at,
  finishedAt: b.finished_at,
  rolledBackBy: b.rolled_back_by,
  rollbackReason: b.rollback_reason,
});

export const toDocument = (d: DocumentRow): MigrationDocument => ({
  id: d.id,
  fileId: d.file_id,
  filename: d.filename,
  originalRef: d.original_ref,
  sizeBytes: d.size_bytes,
  sha256: d.sha256,
  detectedType: d.detected_type,
  status: d.status,
  linkMode: d.link_mode,
  linkEntity: d.link_entity,
  linkSourceId: d.link_source_id,
  reason: d.reason,
  candidates: d.candidates,
  targetId: d.target_id,
});

/** Insert many rows with one statement per chunk (jsonb sent as text). */
export async function insertRows(
  db: Db,
  orgId: string,
  jobId: string,
  tableId: string,
  rows: Record<string, string>[],
  sourceRows?: number[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await db.run(
      `INSERT INTO mig_rows (org_id, job_id, table_id, row_no, raw)
       SELECT $1, $2, $3, n, r::jsonb FROM unnest($4::int[], $5::text[]) AS x(n, r)`,
      [
        orgId,
        jobId,
        tableId,
        chunk.map((_, k) => sourceRows?.[i + k] ?? i + k + 2),
        chunk.map((r) => JSON.stringify(r)),
      ],
    );
  }
}
