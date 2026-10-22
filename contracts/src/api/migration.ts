// Data migration: move records from another system (spreadsheets, other software exports) into PALTAS.
//
// One engine for every product. A product registers a DOMAIN (its entities, fields, relationship rules and balance
// checks); Real Estate Development ("development") is the first. A job walks through these stages:
//
//   created (source selected) → uploaded → detected → mapped → validated → resolved → dry_run → approved
//   → importing (batches, run by a server worker — the browser can close) → reconciled → completed
//   failed (a batch failed: retry it or roll it back) · rolled_back
//
// Changing files, mappings or rows sends the job back to the stage that must be redone; nothing is ever silently
// dropped (every skipped, merged or refused row and file is in the exception report).
import { z } from "zod";
import { Confirm, Currency, IsoDate, IsoDateTime, MinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";

export const MIGRATION_STATUSES = [
  "created",
  "uploaded",
  "detected",
  "mapped",
  "validated",
  "resolved",
  "dry_run",
  "approved",
  "importing",
  "reconciled",
  "completed",
  "failed",
  "rolled_back",
] as const;
export const MigrationStatus = z.enum(MIGRATION_STATUSES);
export type MigrationStatus = z.infer<typeof MigrationStatus>;

/** "a-z0-9._-", e.g. "sage-export" or "crm.hubspot". Part of every migrated record's source key. */
export const SourceSystem = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,59}$/, "Use 2–60 characters: letters, digits, dot, dash, underscore");

export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YYYY", "DD-MM-YYYY"] as const;
export const DateFormat = z.enum(DATE_FORMATS);

export const ParseSettings = z.object({
  dateFormat: DateFormat.default("YYYY-MM-DD"),
  decimalSeparator: z.enum([".", ","]).default("."),
  thousandsSeparator: z.enum([",", ".", " ", "'", ""]).default(","),
});
export type ParseSettings = z.infer<typeof ParseSettings>;

/** A field-level transform applied, in order, to a source value before it is checked. */
export const Transform = z.discriminatedUnion("op", [
  z.object({ op: z.literal("trim") }),
  z.object({ op: z.literal("upper") }),
  z.object({ op: z.literal("lower") }),
  z.object({ op: z.literal("date"), format: DateFormat }),
  z.object({
    op: z.literal("number"),
    decimalSeparator: z.enum([".", ","]),
    thousandsSeparator: z.enum([",", ".", " ", "'", ""]),
  }),
  /** Source values → PALTAS enum values (compared case-insensitively). */
  z.object({ op: z.literal("enum"), map: z.record(z.string(), z.string()) }),
  /** Used when the cell is empty. */
  z.object({ op: z.literal("default"), value: z.string() }),
  /** Keep the part matched by the first group of a regular expression (e.g. a unit number inside a name). */
  z.object({ op: z.literal("extract"), pattern: z.string().min(1).max(200) }),
]);
export type Transform = z.infer<typeof Transform>;

export const ColumnMapping = z.object({
  source: z.string().min(1).max(200),
  field: z.string().min(1).max(60),
  transforms: z.array(Transform).max(10).default([]),
});
export type ColumnMapping = z.infer<typeof ColumnMapping>;

export const ProfileConfig = z.object({
  templates: z
    .array(
      z.object({
        headers: z.array(z.string()).max(200),
        entity: z.string().min(1),
        columns: z.array(ColumnMapping).max(200),
      }),
    )
    .max(100)
    .default([]),
  settings: ParseSettings.partial().default({}),
  /** entity → keywords that, found in a sheet or file name, point to that entity. */
  entityHints: z.record(z.string(), z.array(z.string())).default({}),
  /** entity → field → source column names. */
  aliases: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
  /** "entity.field" → { source value: PALTAS value }. */
  enums: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
export type ProfileConfig = z.infer<typeof ProfileConfig>;

export const MigrationProfile = z.object({
  id: z.string(),
  domain: z.string(),
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  config: ProfileConfig,
  updatedAt: IsoDateTime,
});
export type MigrationProfile = z.infer<typeof MigrationProfile>;

export const FIELD_TYPES = ["text", "email", "phone", "date", "money", "int", "decimal", "enum", "ref"] as const;

export const DomainField = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  aliases: z.array(z.string()).optional(),
  values: z.array(z.string()).optional(),
  ref: z.string().optional(),
});

export const DomainEntity = z.object({
  name: z.string(),
  label: z.string(),
  fields: z.array(DomainField),
  /** Fields that identify the same real-world record (duplicate detection). */
  duplicateKeys: z.array(z.array(z.string())),
});

export const MigrationDomain = z.object({
  key: z.string(),
  label: z.string(),
  product: z.string(),
  entities: z.array(DomainEntity),
  /** Entities a document may be attached to. */
  documentTargets: z.array(z.string()),
  /** Ledger accounts the opening balances post to. */
  accounts: z.array(z.object({ code: z.string(), name: z.string(), use: z.string() })),
});

const Count = z.number().int().min(0);

export const MigrationJob = z.object({
  id: z.string(),
  number: z.string(),
  domain: z.string(),
  name: z.string(),
  sourceSystem: z.string(),
  profileId: z.string().nullable(),
  cutoverDate: IsoDate,
  currency: Currency,
  settings: ParseSettings,
  status: MigrationStatus,
  createdBy: z.string(),
  dryRunBy: z.string().nullable(),
  dryRunAt: IsoDateTime.nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: IsoDateTime.nullable(),
  completedBy: z.string().nullable(),
  completedAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  counts: z.object({
    files: Count,
    refusedFiles: Count,
    tables: Count,
    rows: Count,
    valid: Count,
    errors: Count,
    skipped: Count,
    merged: Count,
    alreadyPresent: Count,
    imported: Count,
    documents: Count,
    documentsInReview: Count,
  }),
  progress: z.object({
    batchesTotal: Count,
    batchesDone: Count,
    batchesFailed: Count,
    batchesRolledBack: Count,
    rowsToImport: Count,
    rowsImported: Count,
    percent: z.number().int().min(0).max(100),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MigrationJob = z.infer<typeof MigrationJob>;

export const UPLOAD_TYPES = ["csv", "xlsx", "json", "zip", "pdf", "png", "jpeg", "gif", "webp", "tiff"] as const;
export const UploadType = z.enum(UPLOAD_TYPES);

export const MigrationFile = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  filename: z.string(),
  originalRef: z.string(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  detectedType: z.string().nullable(),
  status: z.enum(["uploading", "stored", "refused"]),
  refusal: z.string().nullable(),
  receivedBytes: Count,
  createdAt: IsoDateTime,
});
export type MigrationFile = z.infer<typeof MigrationFile>;

export const TableAnalysis = z.object({
  sheet: z.string(),
  headerRow: z.number().int().positive(),
  confidence: z.number(),
  classification: z.enum(["records", "annual_matrix", "unknown"]),
  year: z.number().int().nullable(),
  metadataRows: z.array(z.number().int()),
  mergedRanges: z.array(z.string()).optional(),
  columnNumbers: z.array(z.number().int().positive()).optional(),
  reconciliationChecks: z
    .array(
      z.object({
        column: z.string(),
        sourceRow: z.number().int(),
        sourceMinor: z.number().int(),
        detectedMinor: z.number().int(),
        ok: z.boolean(),
      }),
    )
    .optional(),
  totals: z
    .array(z.object({ row: z.number().int().positive(), label: z.string(), values: z.record(z.string(), z.string()) }))
    .optional(),
  excludedRows: z.array(z.object({ row: z.number().int(), reason: z.enum(["blank", "repeated_header", "total"]) })),
  warnings: z.array(z.string()),
});
export const MigrationTable = z.object({
  id: z.string(),
  fileId: z.string(),
  name: z.string(),
  headers: z.array(z.string()),
  rowCount: Count,
  entity: z.string().nullable(),
  confidence: z.number(),
  ignored: z.boolean(),
  mapping: z.array(ColumnMapping),
  /** Source columns not mapped to any field (shown so nothing is left behind by accident). */
  unmappedColumns: z.array(z.string()),
  sample: z.array(z.record(z.string(), z.string())),
  analysis: TableAnalysis.nullable().optional(),
});
export type MigrationTable = z.infer<typeof MigrationTable>;

export const Severity = z.enum(["error", "warning"]);
export const MigrationIssue = z.object({
  id: z.string(),
  rowId: z.string().nullable(),
  documentId: z.string().nullable(),
  entity: z.string().nullable(),
  sourceRecordId: z.string().nullable(),
  table: z.string().nullable(),
  rowNo: z.number().int().nullable(),
  field: z.string().nullable(),
  severity: Severity,
  code: z.string(),
  message: z.string(),
});
export type MigrationIssue = z.infer<typeof MigrationIssue>;

export const ROW_STATUSES = ["pending", "valid", "error", "skipped", "merged", "already_present", "imported"] as const;

export const MigrationRow = z.object({
  id: z.string(),
  tableId: z.string(),
  table: z.string(),
  rowNo: z.number().int(),
  entity: z.string().nullable(),
  sourceRecordId: z.string().nullable(),
  status: z.enum(ROW_STATUSES),
  raw: z.record(z.string(), z.string()),
  data: z.record(z.string(), z.unknown()).nullable(),
  correction: z.record(z.string(), z.string()),
  decision: z.enum(["skip", "merge", "keep"]).nullable(),
  decisionReason: z.string().nullable(),
  mergeIntoRowId: z.string().nullable(),
  mergeIntoTargetId: z.string().nullable(),
  targetId: z.string().nullable(),
  issues: z.array(MigrationIssue),
});
export type MigrationRow = z.infer<typeof MigrationRow>;

export const EntityTotals = z.object({
  entity: z.string(),
  create: Count,
  alreadyPresent: Count,
  linkedToExisting: Count,
  skipped: Count,
  merged: Count,
  /** Money field → total in minor units of the rows that would be created. */
  money: z.record(z.string(), MinorUnits),
});

export const ValidationSummary = z.object({
  at: IsoDateTime,
  errors: Count,
  warnings: Count,
  blocking: z.boolean(),
  byCode: z.record(z.string(), Count),
  byEntity: z.array(EntityTotals),
});
export type ValidationSummary = z.infer<typeof ValidationSummary>;

export const LedgerPreview = z.object({
  account: z.string(),
  name: z.string(),
  debitMinor: MinorUnits,
  creditMinor: MinorUnits,
});

export const DryRunSummary = z.object({
  at: IsoDateTime,
  byEntity: z.array(EntityTotals),
  wouldCreate: Count,
  alreadyPresent: Count,
  documents: z.object({ linked: Count, unlinked: Count, excluded: Count }),
  ledger: z.array(LedgerPreview),
  batches: Count,
  /** The simulation ran inside a transaction that was rolled back: nothing was written. */
  rolledBack: z.literal(true),
});
export type DryRunSummary = z.infer<typeof DryRunSummary>;

export const ReconciliationLine = z.object({
  check: z.string(),
  entity: z.string().nullable(),
  source: MinorUnits,
  destination: MinorUnits,
  difference: MinorUnits,
  ok: z.boolean(),
});
export const Reconciliation = z.object({
  at: IsoDateTime,
  ok: z.boolean(),
  counts: z.array(ReconciliationLine),
  money: z.array(ReconciliationLine),
  relationships: z.array(ReconciliationLine),
  ledger: z.array(ReconciliationLine),
  mismatches: z.array(z.string()),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

export const MigrationBatch = z.object({
  id: z.string(),
  seq: z.number().int(),
  entity: z.string(),
  rowCount: Count,
  status: z.enum(["queued", "running", "done", "failed", "rolled_back"]),
  attempts: Count,
  error: z.string().nullable(),
  createdCount: Count,
  presentCount: Count,
  journalId: z.string().nullable(),
  reversalJournalId: z.string().nullable(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  rolledBackBy: z.string().nullable(),
  rollbackReason: z.string().nullable(),
});
export type MigrationBatch = z.infer<typeof MigrationBatch>;

export const DOCUMENT_STATUSES = ["linked", "review", "unlinked", "excluded", "unsupported", "corrupt"] as const;
export const MigrationDocument = z.object({
  id: z.string(),
  fileId: z.string(),
  filename: z.string(),
  originalRef: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  detectedType: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  linkMode: z.enum(["auto", "manual"]).nullable(),
  linkEntity: z.string().nullable(),
  linkSourceId: z.string().nullable(),
  reason: z.string(),
  candidates: z.array(z.object({ entity: z.string(), sourceRecordId: z.string() })),
  targetId: z.string().nullable(),
});
export type MigrationDocument = z.infer<typeof MigrationDocument>;

export const MigrationRecord = z.object({
  entity: z.string(),
  id: z.string(),
  sourceRecordId: z.string(),
  batchId: z.string().nullable(),
  label: z.string(),
});

export const ReportFile = z.object({
  filename: z.string(),
  contentType: z.enum(["text/csv", "application/json"]),
  content: z.string(),
});

// ------------------------------------------------------------------ endpoints
const base = "/api/v1/orgs/:orgId/migration";
const JobParams = OrgParams.extend({ jobId: z.string().min(1) });
const FileParams = JobParams.extend({ fileId: z.string().min(1) });

export const listDomains = endpoint({
  id: "migration.domains.list",
  method: "GET",
  path: `${base}/domains`,
  auth: "user",
  summary: "Domains this organisation can migrate into, with their entities, fields and duplicate keys",
  params: OrgParams,
  response: z.object({ domains: z.array(MigrationDomain) }),
});

export const listProfiles = endpoint({
  id: "migration.profiles.list",
  method: "GET",
  path: `${base}/profiles`,
  auth: "user",
  summary: "Source-system profiles: the built-in ones and those saved by this organisation",
  params: OrgParams,
  query: z.object({ domain: z.string().optional() }),
  response: z.object({ profiles: z.array(MigrationProfile) }),
});

export const saveProfile = endpoint({
  id: "migration.profiles.save",
  method: "POST",
  path: `${base}/profiles`,
  auth: "user",
  summary: "Save (create or replace by name) this organisation's own source-system profile",
  params: OrgParams,
  body: z.object({
    domain: z.string().min(1),
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().max(500).default(""),
    config: ProfileConfig,
  }),
  response: MigrationProfile,
  status: 201,
});

export const createJob = endpoint({
  id: "migration.jobs.create",
  method: "POST",
  path: `${base}/jobs`,
  auth: "user",
  summary: "Start a migration: choose the target domain, the source system and the cut-over date",
  params: OrgParams,
  body: z.object({
    domain: z.string().min(1),
    name: z.string().trim().min(3).max(120),
    sourceSystem: SourceSystem,
    profileId: z.string().optional(),
    cutoverDate: IsoDate,
    settings: ParseSettings.partial().optional(),
  }),
  response: MigrationJob,
  status: 201,
});

export const listJobs = endpoint({
  id: "migration.jobs.list",
  method: "GET",
  path: `${base}/jobs`,
  auth: "user",
  summary: "Migration jobs, newest first",
  params: OrgParams,
  response: z.object({ jobs: z.array(MigrationJob) }),
});

export const getJob = endpoint({
  id: "migration.jobs.get",
  method: "GET",
  path: `${base}/jobs/:jobId`,
  auth: "user",
  summary: "A job with its stage, counts and import progress (poll this while it imports)",
  params: JobParams,
  response: MigrationJob.extend({
    validation: ValidationSummary.nullable(),
    dryRun: DryRunSummary.nullable(),
    reconciliation: Reconciliation.nullable(),
  }),
});

export const startUpload = endpoint({
  id: "migration.files.start",
  method: "POST",
  path: `${base}/jobs/:jobId/files`,
  auth: "user",
  summary:
    "Announce a file (name, size, SHA-256). Then send it in chunks of at most chunkBytes, and complete it. Large files never travel in one request.",
  params: JobParams,
  body: z.object({
    filename: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 as 64 lowercase hex characters"),
  }),
  response: z.object({ file: MigrationFile, chunkBytes: z.number().int() }),
  status: 201,
});

export const uploadChunk = endpoint({
  id: "migration.files.chunk",
  method: "PUT",
  path: `${base}/jobs/:jobId/files/:fileId/chunks/:index`,
  auth: "user",
  summary: "Send one chunk (base64). Sending the same chunk again replaces it, so an interrupted upload resumes.",
  params: FileParams.extend({ index: z.coerce.number().int().min(0).max(100_000) }),
  body: z.object({ dataBase64: z.string().min(1).max(260_000) }),
  response: z.object({ receivedBytes: Count }),
});

export const completeUpload = endpoint({
  id: "migration.files.complete",
  method: "POST",
  path: `${base}/jobs/:jobId/files/:fileId/complete`,
  auth: "user",
  summary:
    "Check the file (size, SHA-256, type by its magic bytes, archive safety) and keep it — or refuse it with the reason. ZIP contents are unpacked into files of their own.",
  params: FileParams,
  response: z.object({ file: MigrationFile, extracted: z.array(MigrationFile) }),
});

export const listFiles = endpoint({
  id: "migration.files.list",
  method: "GET",
  path: `${base}/jobs/:jobId/files`,
  auth: "user",
  summary: "Every uploaded and extracted file, including refused ones and why",
  params: JobParams,
  response: z.object({ files: z.array(MigrationFile) }),
});

export const detect = endpoint({
  id: "migration.jobs.detect",
  method: "POST",
  path: `${base}/jobs/:jobId/detect`,
  auth: "user",
  summary:
    "Read every data file: sheets and tables, columns, a guessed entity per table, a proposed column mapping and sample rows. Documents are listed for linking.",
  params: JobParams,
  response: z.object({ tables: z.array(MigrationTable), documents: z.array(MigrationDocument) }),
});

export const listTables = endpoint({
  id: "migration.tables.list",
  method: "GET",
  path: `${base}/jobs/:jobId/tables`,
  auth: "user",
  summary: "Detected tables with their entity and mapping",
  params: JobParams,
  response: z.object({ tables: z.array(MigrationTable) }),
});

export const mapTable = endpoint({
  id: "migration.tables.map",
  method: "PUT",
  path: `${base}/jobs/:jobId/tables/:tableId/mapping`,
  auth: "user",
  summary: "Confirm a table's entity and column mapping (with transforms), or ignore the table with a reason",
  params: JobParams.extend({ tableId: z.string().min(1) }),
  body: z.union([
    z.object({ entity: z.string().min(1), columns: z.array(ColumnMapping).min(1).max(200) }),
    z.object({ ignore: z.literal(true), reason: Reason }),
    z.object({ headerRow: z.number().int().min(1).max(1_048_576) }),
    z.object({
      normaliseAnnual: z.object({
        propertyId: z.string().min(1),
        year: z.number().int().min(1900).max(2200),
        unitColumn: z.string(),
        subjectColumn: z.string().min(1),
        subjectType: z.enum(["tenant", "owner"]),
        kind: z.enum([
          "service_charge_summary",
          "rent_summary",
          "payment_summary",
          "balance_summary",
          "expense_summary",
        ]),
        currency: z.string().length(3),
        confirm: z.literal("REFERENCE ONLY"),
      }),
    }),
  ]),
  response: MigrationTable,
});

export const validate = endpoint({
  id: "migration.jobs.validate",
  method: "POST",
  path: `${base}/jobs/:jobId/validate`,
  auth: "user",
  summary:
    "Check every row: required fields, formats, relationships, duplicates, conflicts and balances. Errors block the import until resolved.",
  params: JobParams,
  response: ValidationSummary,
});

export const listIssues = endpoint({
  id: "migration.issues.list",
  method: "GET",
  path: `${base}/jobs/:jobId/issues`,
  auth: "user",
  summary: "Problems found by the last validation",
  params: JobParams,
  query: z.object({
    severity: Severity.optional(),
    entity: z.string().optional(),
    code: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(500),
  }),
  response: z.object({ issues: z.array(MigrationIssue), total: Count }),
});

export const listRows = endpoint({
  id: "migration.rows.list",
  method: "GET",
  path: `${base}/jobs/:jobId/rows`,
  auth: "user",
  summary: "Rows with their mapped values, decisions and issues",
  params: JobParams,
  query: z.object({
    status: z.enum(ROW_STATUSES).optional(),
    entity: z.string().optional(),
    sourceRecordId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(200),
    afterId: z.string().regex(/^\d+$/).optional(),
  }),
  response: z.object({ rows: z.array(MigrationRow) }),
});

export const resolveRow = endpoint({
  id: "migration.rows.resolve",
  method: "POST",
  path: `${base}/jobs/:jobId/rows/:rowId/resolve`,
  auth: "user",
  summary:
    "Resolve a row: correct values, skip it (with a reason), merge it into another row or an existing record, keep a flagged duplicate, or undo a decision. The job is validated again.",
  params: JobParams.extend({ rowId: z.string().regex(/^\d+$/) }),
  body: z.discriminatedUnion("action", [
    z.object({ action: z.literal("correct"), values: z.record(z.string(), z.string()) }),
    z.object({ action: z.literal("skip"), reason: Reason }),
    z.object({
      action: z.literal("merge"),
      intoRowId: z.string().regex(/^\d+$/).optional(),
      intoTargetId: z.string().min(1).optional(),
      reason: Reason,
    }),
    z.object({ action: z.literal("keep"), reason: Reason }),
    z.object({ action: z.literal("reset") }),
  ]),
  response: z.object({ row: MigrationRow, validation: ValidationSummary }),
});

export const listDocuments = endpoint({
  id: "migration.documents.list",
  method: "GET",
  path: `${base}/jobs/:jobId/documents`,
  auth: "user",
  summary: "Documents found in the upload, how each is linked, and the review queue",
  params: JobParams,
  query: z.object({ status: z.enum(DOCUMENT_STATUSES).optional() }),
  response: z.object({ documents: z.array(MigrationDocument) }),
});

export const resolveDocument = endpoint({
  id: "migration.documents.resolve",
  method: "POST",
  path: `${base}/jobs/:jobId/documents/:documentId/resolve`,
  auth: "user",
  summary: "Link a document to one record, keep it unlinked, or exclude it (with a reason)",
  params: JobParams.extend({ documentId: z.string().min(1) }),
  body: z.discriminatedUnion("action", [
    z.object({ action: z.literal("link"), entity: z.string().min(1), sourceRecordId: z.string().min(1) }),
    z.object({ action: z.literal("unlinked"), reason: Reason }),
    z.object({ action: z.literal("exclude"), reason: Reason }),
  ]),
  response: MigrationDocument,
});

export const dryRun = endpoint({
  id: "migration.jobs.dryRun",
  method: "POST",
  path: `${base}/jobs/:jobId/dry-run`,
  auth: "user",
  summary:
    "Run the whole import inside a transaction that is rolled back: what would be created, what already exists, money totals and the ledger postings. Nothing is written.",
  params: JobParams,
  response: DryRunSummary,
});

export const approve = endpoint({
  id: "migration.jobs.approve",
  method: "POST",
  path: `${base}/jobs/:jobId/approve`,
  auth: "user",
  summary: "Approve the dry run for import. The person who ran the dry run cannot approve it.",
  params: JobParams,
  body: z.object({ confirm: Confirm }),
  response: MigrationJob,
});

export const startImport = endpoint({
  id: "migration.jobs.import",
  method: "POST",
  path: `${base}/jobs/:jobId/import`,
  auth: "user",
  summary:
    "Queue the approved import. A server worker runs it in batches (resumable after a restart); poll the job for progress.",
  params: JobParams,
  response: MigrationJob,
});

export const retry = endpoint({
  id: "migration.jobs.retry",
  method: "POST",
  path: `${base}/jobs/:jobId/retry`,
  auth: "user",
  summary: "Queue the failed batches again (after fixing what made them fail)",
  params: JobParams,
  response: MigrationJob,
});

export const listBatches = endpoint({
  id: "migration.batches.list",
  method: "GET",
  path: `${base}/jobs/:jobId/batches`,
  auth: "user",
  summary: "The import batches and their state",
  params: JobParams,
  response: z.object({ batches: z.array(MigrationBatch) }),
});

export const rollbackBatch = endpoint({
  id: "migration.batches.rollback",
  method: "POST",
  path: `${base}/jobs/:jobId/batches/:seq/rollback`,
  auth: "user",
  summary:
    "Undo one batch: delete only the records it created (never records that existed before) and reverse its ledger posting. Later batches must be rolled back first.",
  params: JobParams.extend({ seq: z.coerce.number().int().min(1) }),
  body: z.object({ reason: Reason, confirm: Confirm }),
  response: MigrationBatch,
});

export const reconcile = endpoint({
  id: "migration.jobs.reconcile",
  method: "POST",
  path: `${base}/jobs/:jobId/reconcile`,
  auth: "user",
  summary: "Compare source and PALTAS again: counts per entity, money totals, relationships and the ledger",
  params: JobParams,
  response: Reconciliation,
});

export const complete = endpoint({
  id: "migration.jobs.complete",
  method: "POST",
  path: `${base}/jobs/:jobId/complete`,
  auth: "user",
  summary: "Sign off a reconciled migration: PALTAS becomes the system of record and batches can no longer be undone",
  params: JobParams,
  body: z.object({ confirm: Confirm }),
  response: MigrationJob,
});

export const report = endpoint({
  id: "migration.jobs.report",
  method: "GET",
  path: `${base}/jobs/:jobId/report`,
  auth: "user",
  summary:
    "Download the migration report (counts, totals, reconciliation, batches) or the exception file (every refused, skipped, merged or flagged row and document)",
  params: JobParams,
  query: z.object({ kind: z.enum(["report", "exceptions"]).default("report"), format: z.enum(["csv", "json"]) }),
  response: ReportFile,
});

export const listRecords = endpoint({
  id: "migration.records.list",
  method: "GET",
  path: `${base}/jobs/:jobId/records`,
  auth: "user",
  summary: "Records this job created in PALTAS, by entity",
  params: JobParams,
  query: z.object({ entity: z.string().min(1), limit: z.coerce.number().int().min(1).max(2000).default(500) }),
  response: z.object({ records: z.array(MigrationRecord) }),
});

export const jobAudit = endpoint({
  id: "migration.jobs.audit",
  method: "GET",
  path: `${base}/jobs/:jobId/audit`,
  auth: "user",
  summary: "Who did what in this migration, oldest first",
  params: JobParams,
  response: z.object({
    entries: z.array(
      z.object({
        at: IsoDateTime,
        actorUserId: z.string().nullable(),
        actorRole: z.string().nullable(),
        action: z.string(),
        detail: z.string(),
      }),
    ),
  }),
});
