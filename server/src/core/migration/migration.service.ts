/*
 * The migration engine's stages, as one service every product uses (through the domain it registers).
 *
 *   createJob → upload (start, chunks, complete) → detect → map → validate ⇄ resolve → dryRun → approve
 *   → startImport (the worker runs the batches) → reconciled → complete;   retry / rollbackBatch on failure.
 *
 * Each stage checks the job is in a stage that allows it, and moves it on. Changing what an earlier stage produced
 * (a file, a mapping, a row) sends the job back, which also withdraws a dry run or an approval: what was approved is
 * exactly what is imported. Every change is audited against the job (audit_log.target = job id).
 */
import { createHash } from "node:crypto";
import type {
  ColumnMapping,
  MigrationRow,
  MigrationStatus,
  ParseSettings as ParseSettingsT,
  ProfileConfig as ProfileConfigT,
} from "@paltas/contracts";
import { ParseSettings, ProfileConfig } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { nextNumber } from "../../db/counters.js";
import type { Db } from "../../db/database.js";
import { ApiError, fail, fromDatabaseError } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import type { OrgScope } from "../access/org-access.js";
import { recordAudit, SYSTEM, type Actor } from "../audit/audit.service.js";
import { ensureAccounts } from "../ledger/default-chart.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import { guessEntity, MANIFEST, MANIFEST_FIELDS, SOURCE_ID } from "./detect.js";
import { DomainRegistry, entityOf, type MigrationDomain } from "./domain.js";
import { existingRecord } from "./documents.js";
import { DATA_TYPES } from "./files/sniff.js";
import { readTables, UnreadableFile } from "./files/tables.js";
import { ZipRefused } from "./files/zip.js";
import { createBatches, dryRun, rollbackBatch, runBatch } from "./importer.js";
import {
  FILE_COLUMNS,
  insertRows,
  ISSUE_SELECT,
  jobRow,
  toBatch,
  toDocument,
  toFile,
  toIssue,
  toJob,
  toTable,
  type BatchRow,
  type DocumentRow,
  type FileRow,
  type IssueRow,
  type JobRow,
  type RowRow,
  type TableRow,
} from "./migration.repo.js";
import { reconcileJob } from "./reconcile.js";
import { buildReport } from "./report.js";
import { CHUNK_BYTES, uploads, zipLimits } from "./uploads.js";
import { convert } from "./transforms.js";
import { runValidation } from "./validation.js";
import { createWorker } from "./worker.js";

/** Stages in which files, mappings and rows may still change (each change sends the job back). */
const EDITABLE: MigrationStatus[] = [
  "created",
  "uploaded",
  "detected",
  "mapped",
  "validated",
  "resolved",
  "dry_run",
  "approved",
  "rolled_back",
];
const ANALYSED: MigrationStatus[] = [
  "detected",
  "mapped",
  "validated",
  "resolved",
  "dry_run",
  "approved",
  "rolled_back",
];

/** The stages a job may be in to move to each stage (checked again, under the job lock, on every move). */
const MOVES_FROM: Partial<Record<MigrationStatus, readonly MigrationStatus[]>> = {
  uploaded: EDITABLE,
  detected: EDITABLE,
  mapped: ANALYSED,
  validated: ANALYSED,
  resolved: ANALYSED,
  dry_run: ["resolved", "dry_run", "approved"],
  approved: ["dry_run"],
  importing: ["approved", "failed"],
  rolled_back: ["failed", "reconciled", "rolled_back"],
};
/** Moving to one of these means what would be imported changed: the job's revision goes up. */
const CHANGES: MigrationStatus[] = ["uploaded", "detected", "mapped", "validated", "resolved", "rolled_back"];
const RERUN_DRY_RUN = "The rows, mappings or decisions changed since the dry run — run the dry run again";

class LeaseLost extends Error {}

function need(job: JobRow, allowed: readonly MigrationStatus[], action: string): void {
  if (!allowed.includes(job.status))
    throw fail.conflict(`This migration is ${job.status.replace("_", " ")} — ${action} is not possible now`, {
      status: job.status,
    });
}

export function migrationService(ctx: AppContext, deps: { ledger: LedgerService }) {
  const { db, clock, log } = ctx;
  const settings = ctx.config.migration;
  const ledger = deps.ledger;
  const domains = new DomainRegistry(ctx.products.modules.flatMap((m) => (m.migration ? [m.migration] : [])));
  const files = uploads(settings);
  const now = () => clock.now().toISOString();

  const domainOf = (job: JobRow): MigrationDomain => {
    const d = domains.get(job.domain);
    if (!d) throw fail.notFound(`Migration domain ${job.domain} is not available on this server`);
    return d;
  };

  async function load(t: Db, orgId: string, jobId: string, lock = false): Promise<JobRow> {
    const j = await jobRow(t, orgId, jobId, lock);
    if (!j) throw fail.notFound("Migration not found");
    return j;
  }

  async function audit(t: Db, actor: Actor, job: JobRow, action: string, detail = "", after?: unknown) {
    await recordAudit(t, {
      actor,
      orgId: job.org_id,
      action,
      target: job.id,
      detail: `${job.number}: ${detail}`.trim(),
      after,
    });
  }

  /**
   * Move the job to a stage; going back withdraws later results (validation, dry run, approval) and bumps the
   * revision. The job row is read again under a lock and the move refused unless its current stage allows it, so a
   * caller working from an older copy of the job can never overwrite a stage reached meanwhile (e.g. importing).
   */
  async function moveTo(t: Db, job: JobRow, status: MigrationStatus) {
    const current = await t.row<{ status: MigrationStatus }>("SELECT status FROM mig_jobs WHERE id = $1 FOR UPDATE", [
      job.id,
    ]);
    if (!current || !(MOVES_FROM[status] ?? []).includes(current.status))
      throw fail.conflict(
        `This migration is ${(current?.status ?? "gone").replace("_", " ")} — it cannot move to ${status.replace("_", " ")} now`,
        { status: current?.status },
      );
    const keepValidation = ["validated", "resolved", "dry_run", "approved", "importing", "reconciled"].includes(status);
    const keepDryRun = ["dry_run", "approved", "importing", "reconciled"].includes(status);
    await t.run(
      `UPDATE mig_jobs SET status = $2, updated_at = now(),
         validation = CASE WHEN $3 THEN validation END,
         dry_run = CASE WHEN $4 THEN dry_run END, dry_run_by = CASE WHEN $4 THEN dry_run_by END,
         dry_run_at = CASE WHEN $4 THEN dry_run_at END, dry_run_revision = CASE WHEN $4 THEN dry_run_revision END,
         approved_by = CASE WHEN $5 THEN approved_by END, approved_at = CASE WHEN $5 THEN approved_at END,
         revision = revision + CASE WHEN $6 THEN 1 ELSE 0 END
       WHERE id = $1`,
      [
        job.id,
        status,
        keepValidation,
        keepDryRun,
        ["approved", "importing", "reconciled"].includes(status),
        CHANGES.includes(status),
      ],
    );
    job.status = status;
  }

  /** Remember who changed a mapping, a row or a document decision: none of them may approve the import. */
  async function noteChange(t: Db, job: JobRow, userId: string) {
    await t.run(
      "UPDATE mig_jobs SET changed_by = array_append(changed_by, $2) WHERE id = $1 AND NOT ($2 = ANY (changed_by))",
      [job.id, userId],
    );
  }

  /** Approval and import go ahead only for exactly the data the dry run saw. */
  function sameAsDryRun(job: JobRow) {
    if (job.dry_run_revision === null || job.dry_run_revision !== job.revision)
      throw fail.conflict(RERUN_DRY_RUN, { revision: job.revision, dryRunRevision: job.dry_run_revision });
  }

  async function profileConfig(t: Db, job: JobRow): Promise<ProfileConfigT> {
    if (!job.profile_id) return ProfileConfig.parse({});
    const p = await t.row<{ config: unknown }>("SELECT config FROM mig_profiles WHERE id = $1", [job.profile_id]);
    return ProfileConfig.parse(p?.config ?? {});
  }

  async function hasImported(t: Db, jobId: string): Promise<boolean> {
    return !!(await t.row("SELECT 1 FROM mig_batches WHERE job_id = $1 AND status = 'done' LIMIT 1", [jobId]));
  }

  async function validateIn(t: Db, s: OrgScope, job: JobRow) {
    const summary = await runValidation(t, job, domainOf(job), await profileConfig(t, job), s.entitlement, now());
    await moveTo(t, job, summary.blocking ? "validated" : "resolved");
    await t.run("UPDATE mig_jobs SET validation = $2 WHERE id = $1", [job.id, JSON.stringify(summary)]);
    job.validation = summary;
    return summary;
  }

  async function rowView(t: Db, jobId: string, rows: RowRow[]): Promise<MigrationRow[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const issues = await t.rows<IssueRow>(`${ISSUE_SELECT} WHERE i.job_id = $1 AND i.row_id = ANY($2) ORDER BY i.id`, [
      jobId,
      ids,
    ]);
    const tables = new Map(
      (await t.rows<{ id: string; name: string }>("SELECT id, name FROM mig_tables WHERE job_id = $1", [jobId])).map(
        (x) => [x.id, x.name],
      ),
    );
    return rows.map((r) => ({
      id: String(r.id),
      tableId: r.table_id,
      table: tables.get(r.table_id) ?? "",
      rowNo:
        r.entity === "historical_summary" && /^[A-Z]{1,3}[0-9]{1,7}$/.test(r.raw.source_cell ?? "")
          ? Number((r.raw.source_cell ?? "").replace(/^[A-Z]+/, ""))
          : r.row_no,
      entity: r.entity,
      sourceRecordId: r.source_record_id,
      status: r.status,
      raw: r.raw,
      data: r.data ? { ...r.data.values } : null,
      correction: r.correction,
      decision: r.decision,
      decisionReason: r.decision_reason,
      mergeIntoRowId: r.merge_into_row === null ? null : String(r.merge_into_row),
      mergeIntoTargetId: r.merge_into_target,
      targetId: r.target_id,
      issues: issues.filter((i) => i.row_id === r.id).map(toIssue),
    }));
  }

  // ------------------------------------------------------------------ the worker's part
  async function processClaimed(batch: BatchRow, workerId: string): Promise<void> {
    const job = (await db.row<JobRow>("SELECT * FROM mig_jobs WHERE id = $1", [batch.job_id])) as JobRow;
    try {
      await db.tx(async (t) => {
        const mine = await t.row<BatchRow>(
          "SELECT * FROM mig_batches WHERE id = $1 AND lease_owner = $2 AND status = 'running'",
          [batch.id, workerId],
        );
        if (!mine) throw new LeaseLost();
        const out = await runBatch(t, job, mine, domainOf(job), ledger);
        const n = await t.run(
          `UPDATE mig_batches SET status = 'done', created_count = $3, present_count = $4, journal_id = $5,
             finished_at = now(), lease_owner = NULL, lease_until = NULL
           WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [batch.id, workerId, out.created, out.present, out.journal?.id ?? null],
        );
        if (n !== 1) throw new LeaseLost();
        await audit(
          t,
          SYSTEM,
          job,
          `Import batch ${batch.seq} done`,
          `${batch.entity}: ${out.created} created, ${out.present} already in PALTAS`,
        );
        const left = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM mig_batches WHERE job_id = $1 AND status NOT IN ('done', 'rolled_back')",
          [job.id],
        );
        await t.run("UPDATE mig_jobs SET updated_at = now() WHERE id = $1", [job.id]);
        if (left?.n === 0) await finishImport(t, job);
      });
    } catch (e) {
      if (e instanceof LeaseLost) {
        log.warn({ batch: batch.id }, "Migration batch lease lost — another worker took it over");
        return;
      }
      const message = e instanceof ApiError ? e.message : (fromDatabaseError(e)?.message ?? (e as Error).message);
      await db.tx(async (t) => {
        const n = await t.run(
          `UPDATE mig_batches SET status = 'failed', error = $3, finished_at = now(), lease_owner = NULL, lease_until = NULL
           WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [batch.id, workerId, message],
        );
        if (!n) return;
        await t.run(
          "UPDATE mig_jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'importing'",
          [job.id, `Batch ${batch.seq} (${batch.entity}) failed: ${message}`],
        );
        await audit(t, SYSTEM, job, `Import batch ${batch.seq} failed`, message);
      });
    }
  }

  async function finishImport(t: Db, job: JobRow) {
    const rec = await reconcileJob(t, job, domainOf(job), ledger, now());
    await t.run(
      "UPDATE mig_jobs SET status = 'reconciled', reconciliation = $2, last_error = NULL, updated_at = now() WHERE id = $1",
      [job.id, JSON.stringify(rec)],
    );
    await audit(
      t,
      SYSTEM,
      job,
      "Import finished and reconciled",
      rec.ok ? "Source and PALTAS agree" : `${rec.mismatches.length} difference(s)`,
    );
  }

  const worker = createWorker({
    db,
    log,
    pollMs: settings.workerPollMs,
    leaseMs: settings.leaseMs,
    run: processClaimed,
  });

  // ------------------------------------------------------------------ the stages
  return {
    worker,
    domains,

    /** The product a job belongs to (for the access check), or null if there is no such job. */
    async productOf(orgId: string, jobId: string) {
      const j = await db.row<{ domain: string }>("SELECT domain FROM mig_jobs WHERE org_id = $1 AND id = $2", [
        orgId,
        jobId,
      ]);
      return j ? (domains.get(j.domain)?.product ?? null) : null;
    },

    listDomains(products: readonly string[]) {
      return domains.all
        .filter((d) => products.includes(d.product))
        .map((d) => ({
          key: d.key,
          label: d.label,
          product: d.product,
          documentTargets: [...d.documentTargets],
          accounts: d.accounts.map((a) => ({ code: a.code, name: a.name, use: a.use })),
          entities: d.entities.map((e) => ({
            name: e.name,
            label: e.label,
            duplicateKeys: e.duplicateKeys ?? [],
            fields: [
              { name: SOURCE_ID, label: "Id in the source system", type: "text" as const, required: true },
              ...e.fields.map((f) => ({
                name: f.name,
                label: f.label,
                type: f.type,
                required: !!f.required,
                aliases: [...(f.aliases ?? [])],
                ...(f.values ? { values: [...f.values] } : {}),
                ...(f.ref ? { ref: f.ref } : {}),
              })),
            ],
          })),
        }));
    },

    async listProfiles(orgId: string, domain?: string) {
      const rows = await db.rows<{
        id: string;
        org_id: string | null;
        domain: string;
        name: string;
        description: string;
        config: unknown;
        updated_at: string;
      }>(
        `SELECT * FROM mig_profiles WHERE (org_id IS NULL OR org_id = $1) AND ($2::text IS NULL OR domain = $2)
         ORDER BY org_id NULLS FIRST, name COLLATE "C"`,
        [orgId, domain ?? null],
      );
      return rows.map((p) => ({
        id: p.id,
        domain: p.domain,
        name: p.name,
        description: p.description,
        builtIn: p.org_id === null,
        config: ProfileConfig.parse(p.config),
        updatedAt: p.updated_at,
      }));
    },

    async saveProfile(
      s: OrgScope,
      input: { domain: string; name: string; description: string; config: ProfileConfigT },
    ) {
      const d = domains.get(input.domain);
      if (!d) throw fail.invalid(`Unknown domain ${input.domain}`);
      for (const e of [...Object.keys(input.config.entityHints), ...Object.keys(input.config.aliases)])
        if (!entityOf(d, e)) throw fail.invalid(`The profile names an entity that does not exist: ${e}`);
      for (const [e, fields] of Object.entries(input.config.aliases))
        for (const f of Object.keys(fields))
          if (f !== SOURCE_ID && !entityOf(d, e)?.fields.some((x) => x.name === f))
            throw fail.invalid(`The profile names a field that does not exist: ${e}.${f}`);
      return db.tx(async (t) => {
        const row = await t.row<{ id: string; updated_at: string }>(
          `INSERT INTO mig_profiles (id, org_id, domain, name, description, config, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT ((COALESCE(org_id, '')), domain, lower(name))
           DO UPDATE SET description = EXCLUDED.description, config = EXCLUDED.config, updated_at = now()
           RETURNING id, updated_at`,
          [newId("mpf"), s.orgId, input.domain, input.name, input.description, JSON.stringify(input.config), s.userId],
        );
        const r = row as { id: string; updated_at: string };
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Migration profile saved",
          target: r.id,
          detail: input.name,
        });
        return {
          id: r.id,
          domain: input.domain,
          name: input.name,
          description: input.description,
          builtIn: false,
          config: input.config,
          updatedAt: r.updated_at,
        };
      });
    },

    async createJob(
      s: OrgScope,
      input: {
        domain: string;
        name: string;
        sourceSystem: string;
        profileId?: string | undefined;
        cutoverDate: string;
        settings?: Partial<ParseSettingsT> | undefined;
      },
    ) {
      const d = domains.get(input.domain);
      if (!d) throw fail.invalid(`Unknown domain ${input.domain}`);
      return db.tx(async (t) => {
        let profileSettings = {};
        if (input.profileId) {
          const p = await t.row<{ domain: string; config: unknown }>(
            "SELECT domain, config FROM mig_profiles WHERE id = $1 AND (org_id IS NULL OR org_id = $2)",
            [input.profileId, s.orgId],
          );
          if (!p || p.domain !== d.key) throw fail.invalid("That profile does not exist for this domain");
          profileSettings = ProfileConfig.parse(p.config).settings;
        }
        const parsed = ParseSettings.parse({ ...profileSettings, ...(input.settings ?? {}) });
        if (parsed.decimalSeparator === parsed.thousandsSeparator)
          throw fail.invalid("The decimal and thousands separators must differ");
        const org = await t.row<{ currency: string }>("SELECT currency FROM organisations WHERE id = $1", [s.orgId]);
        await ensureAccounts(t, s.orgId, d.accounts);
        const id = newId("mig");
        await t.run(
          `INSERT INTO mig_jobs (id, org_id, number, domain, name, source_system, profile_id, cutover_date, currency, settings, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'created', $11)`,
          [
            id,
            s.orgId,
            await nextNumber(t, s.orgId, "MIG", 5),
            d.key,
            input.name,
            input.sourceSystem,
            input.profileId ?? null,
            input.cutoverDate,
            org?.currency,
            JSON.stringify(parsed),
            s.userId,
          ],
        );
        const job = await load(t, s.orgId, id);
        await audit(
          t,
          s.actor,
          job,
          "Migration started",
          `${input.name} · from ${input.sourceSystem} · cut-over ${input.cutoverDate}`,
        );
        return toJob(t, job);
      });
    },

    async listJobs(orgId: string) {
      const rows = await db.rows<JobRow>("SELECT * FROM mig_jobs WHERE org_id = $1 ORDER BY created_at DESC", [orgId]);
      return Promise.all(rows.map((j) => toJob(db, j)));
    },

    async getJob(orgId: string, jobId: string) {
      const j = await load(db, orgId, jobId);
      return { ...(await toJob(db, j)), validation: j.validation, dryRun: j.dry_run, reconciliation: j.reconciliation };
    },

    // ---------------------------------------------------------------- files
    async startUpload(s: OrgScope, jobId: string, input: { filename: string; sizeBytes: number; sha256: string }) {
      const file = await db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, EDITABLE, "adding files");
        if (await hasImported(t, job.id))
          throw fail.conflict("Records from this migration are imported — start a new migration for more files");
        return files.start(t, job, s.userId, input);
      });
      return { file, chunkBytes: CHUNK_BYTES };
    },

    async uploadChunk(s: OrgScope, jobId: string, fileId: string, index: number, dataBase64: string) {
      await load(db, s.orgId, jobId);
      return files.chunk(db, jobId, fileId, index, dataBase64);
    },

    async completeUpload(s: OrgScope, jobId: string, fileId: string) {
      const job = await load(db, s.orgId, jobId);
      need(job, EDITABLE, "adding files");
      try {
        return await files.complete(db, jobId, fileId, s.userId, {
          // the stage may have moved on while the bytes were checked (e.g. the import started): check it again
          locked: async (t) => {
            const now = await load(t, s.orgId, jobId, true);
            need(now, EDITABLE, "adding files");
            if (await hasImported(t, now.id))
              throw fail.conflict("Records from this migration are imported — start a new migration for more files");
          },
          stored: async (t, out) => {
            await moveTo(t, job, "uploaded");
            await audit(
              t,
              s.actor,
              job,
              "File uploaded",
              `${out.file.filename} (${out.file.detectedType}, ${out.file.sizeBytes} bytes, sha256 ${out.file.sha256})${out.extracted.length ? `, ${out.extracted.length} file(s) inside` : ""}`,
            );
          },
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 400 && (e.details as { fileId?: string } | undefined)?.fileId)
          await audit(db, s.actor, job, "File refused", e.message);
        throw e;
      }
    },

    async listFiles(orgId: string, jobId: string) {
      await load(db, orgId, jobId);
      const rows = await db.rows<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM mig_files WHERE job_id = $1 ORDER BY created_at, original_ref COLLATE "C"`,
        [jobId],
      );
      return rows.map(toFile);
    },

    // ---------------------------------------------------------------- detect and map
    async detect(s: OrgScope, jobId: string) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(
          job,
          EDITABLE.filter((x) => x !== "created"),
          "reading the files",
        );
        if (await hasImported(t, job.id))
          throw fail.conflict("Records from this migration are imported — the files can no longer be read again");
        const d = domainOf(job);
        const profile = await profileConfig(t, job);
        await t.run("DELETE FROM mig_issues WHERE job_id = $1", [job.id]);
        await t.run("DELETE FROM mig_rows WHERE job_id = $1", [job.id]);
        await t.run("DELETE FROM mig_tables WHERE job_id = $1", [job.id]);
        const dataFiles = await t.rows<FileRow & { content: Buffer }>(
          "SELECT * FROM mig_files WHERE job_id = $1 AND status = 'stored' AND detected_type = ANY($2) ORDER BY original_ref COLLATE \"C\"",
          [job.id, DATA_TYPES],
        );
        let tableCount = 0;
        for (const f of dataFiles) {
          let tables;
          try {
            tables = readTables(f.detected_type as "csv", f.filename, f.content, zipLimits(settings));
          } catch (e) {
            if (!(e instanceof UnreadableFile || e instanceof ZipRefused || e instanceof SyntaxError)) throw e;
            await t.run(
              "UPDATE mig_files SET status = CASE WHEN $3::boolean THEN 'refused' ELSE 'stored' END, refusal = $2, content = CASE WHEN $3::boolean THEN NULL ELSE content END WHERE id = $1",
              [f.id, `Could not be read: ${e.message}`, e instanceof ZipRefused],
            );
            continue;
          }
          for (const tb of tables) {
            const guess =
              tb.analysis?.classification === "annual_matrix"
                ? { entity: null, confidence: 0, mapping: [] }
                : guessEntity(d, tb.name, f.filename, tb.headers, profile);
            const id = newId("mtb");
            await t.run(
              `INSERT INTO mig_tables (id, org_id, job_id, file_id, name, headers, row_count, entity, confidence, mapping, sample, analysis)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                id,
                job.org_id,
                job.id,
                f.id,
                tables.length > 1 ? `${f.filename} · ${tb.name}` : f.filename,
                JSON.stringify(tb.headers),
                tb.rows.length,
                guess.entity,
                guess.confidence,
                JSON.stringify(guess.mapping),
                JSON.stringify(tb.rows.slice(0, 5)),
                JSON.stringify(tb.analysis ?? null),
              ],
            );
            await insertRows(t, job.org_id, job.id, id, tb.rows, tb.sourceRows);
            tableCount++;
          }
        }
        await moveTo(t, job, "detected");
        await audit(t, s.actor, job, "Files read", `${dataFiles.length} data file(s), ${tableCount} table(s)`);
        const tables = await t.rows<TableRow>('SELECT * FROM mig_tables WHERE job_id = $1 ORDER BY name COLLATE "C"', [
          job.id,
        ]);
        const docs = await t.rows<DocumentRow>(
          'SELECT * FROM mig_documents WHERE job_id = $1 ORDER BY original_ref COLLATE "C"',
          [job.id],
        );
        return { tables: tables.map(toTable), documents: docs.map(toDocument) };
      });
    },

    async listTables(orgId: string, jobId: string) {
      await load(db, orgId, jobId);
      return (
        await db.rows<TableRow>('SELECT * FROM mig_tables WHERE job_id = $1 ORDER BY name COLLATE "C"', [jobId])
      ).map(toTable);
    },

    async mapTable(
      s: OrgScope,
      jobId: string,
      tableId: string,
      input:
        | { entity: string; columns: ColumnMapping[] }
        | { ignore: true; reason: string }
        | { headerRow: number }
        | {
            normaliseAnnual: {
              propertyId: string;
              year: number;
              unitColumn: string;
              subjectColumn: string;
              subjectType: "tenant" | "owner";
              kind:
                "service_charge_summary" | "rent_summary" | "payment_summary" | "balance_summary" | "expense_summary";
              currency: string;
              confirm: "REFERENCE ONLY";
            };
          },
    ) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ANALYSED, "changing the mapping");
        if (await hasImported(t, job.id))
          throw fail.conflict("Records from this migration are imported — the mapping can no longer change");
        const table = await t.row<TableRow>("SELECT * FROM mig_tables WHERE job_id = $1 AND id = $2", [
          job.id,
          tableId,
        ]);
        if (!table) throw fail.notFound("Table not found");
        if ("normaliseAnnual" in input) {
          const b = input.normaliseAnnual;
          if (job.domain !== "property" || table.analysis?.classification !== "annual_matrix")
            throw fail.invalid("Choose a detected annual property report before preparing monthly reference history");
          if (!table.headers.includes(b.subjectColumn) || (b.unitColumn && !table.headers.includes(b.unitColumn)))
            throw fail.invalid("Choose actual name and unit columns from this worksheet");
          if (!b.unitColumn && b.kind !== "expense_summary")
            throw fail.invalid(
              "Select the apartment identifier column; a tenant or owner name is not assumed to be an apartment",
            );
          if (!(await t.row("SELECT id FROM pm_properties WHERE org_id=$1 AND id=$2", [s.orgId, b.propertyId])))
            throw fail.notFound("Property not found");
          const f = await t.row<{ filename: string }>("SELECT filename FROM mig_files WHERE id=$1 AND org_id=$2", [
            table.file_id,
            s.orgId,
          ]);
          if (!f) throw fail.notFound("Source workbook not found");
          const source = await t.rows<{ row_no: number; raw: Record<string, string> }>(
            "SELECT row_no,raw FROM mig_rows WHERE job_id=$1 AND table_id=$2 ORDER BY id",
            [job.id, tableId],
          );
          const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
          const monthly = table.headers
            .map((h, i) => ({
              header: h,
              column: table.analysis?.columnNumbers?.[i] ?? i + 1,
              month: months.indexOf(h.trim().toLowerCase().slice(0, 3)) + 1,
            }))
            .filter((x) => x.month > 0);
          const letter = (n: number): string =>
            n > 26
              ? letter(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + ((n - 1) % 26))
              : String.fromCharCode(64 + n);
          const rows: Record<string, string>[] = [];
          let blanks = 0;
          for (const r of source)
            for (const m of monthly) {
              const amount = r.raw[m.header] ?? "";
              if (!amount.trim()) {
                blanks++;
                continue;
              }
              const cell = letter(m.column) + r.row_no;
              if (rows.length >= 100_000)
                throw fail.invalid(
                  "This monthly report would exceed 100,000 reference records. Split it into smaller financial-year files before preparing the preview",
                );
              rows.push({
                source_record_id: createHash("sha256")
                  .update(JSON.stringify([b.propertyId, b.kind, b.year, table.analysis.sheet, cell]))
                  .digest("hex"),
                property_id: b.propertyId,
                unit_label: b.unitColumn ? (r.raw[b.unitColumn] ?? "") : "",
                record_kind: b.kind,
                period: `${b.year}-${String(m.month).padStart(2, "0")}`,
                source_subject: r.raw[b.subjectColumn] ?? "",
                subject_type: b.subjectType,
                amount,
                currency: b.currency.toUpperCase(),
                source_workbook: f.filename,
                source_worksheet: table.analysis.sheet,
                source_cell: cell,
              });
            }
          if (!rows.length)
            throw fail.invalid("No monthly amounts were found. Review the detected headings and selected columns");
          if (b.currency.toUpperCase() !== job.currency)
            throw fail.invalid(
              "Use the original currency matching this workspace. PALTAS will not convert historical records automatically",
            );
          const totals = table.analysis.totals ?? [],
            grand = totals.filter((x) => /^grand total/i.test(x.label));
          const reported = grand.length === 1 ? grand[0] : totals.length === 1 ? totals[0] : undefined;
          const reconciliationChecks: {
            column: string;
            sourceRow: number;
            sourceMinor: number;
            detectedMinor: number;
            ok: boolean;
          }[] = [];
          const minor = (value: string, cell: string) => {
            const n = convert(
              { name: "amount", label: "Monthly amount", type: "money", signed: true },
              value,
              job.settings,
              job.currency,
            );
            if (!n.ok || typeof n.value !== "number")
              throw fail.invalid(`${table.name} · ${cell}: ${!n.ok ? n.message : "A monetary amount is required"}`);
            return n.value;
          };
          if (reported)
            for (const m of monthly) {
              const value = reported.values[m.header] ?? "";
              if (!value.trim()) continue;
              const expected = minor(value, letter(m.column) + reported.row);
              const sum = rows
                .filter((r) => r.period === `${b.year}-${String(m.month).padStart(2, "0")}`)
                .reduce((n, r) => n + BigInt(minor(r.amount ?? "", r.source_cell ?? "")), 0n);
              if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER))
                throw fail.invalid("Monthly total exceeds the supported exact amount range");
              const actual = Number(sum);
              reconciliationChecks.push({
                column: m.header,
                sourceRow: reported.row,
                sourceMinor: expected,
                detectedMinor: actual,
                ok: expected === actual,
              });
              if (expected !== actual)
                throw fail.invalid(
                  `${table.name} · ${m.header}: detected amounts do not agree with the reported total at ${letter(m.column) + reported.row}. Review table boundaries and missing rows before preparing history`,
                  { sourceMinor: expected, detectedMinor: actual },
                );
            }

          const headers = Object.keys(rows[0] ?? {}),
            mapping = headers.map((field) => ({ source: field, field, transforms: [] }));
          const analysis = {
            ...table.analysis,
            classification: "records",
            reconciliationChecks,
            warnings: [
              ...table.analysis.warnings,
              ...(table.headers.filter(
                (h) => h !== b.unitColumn && h !== b.subjectColumn && !monthly.some((m) => m.header === h),
              ).length
                ? [
                    "Not converted into monthly history: " +
                      table.headers
                        .filter(
                          (h) => h !== b.unitColumn && h !== b.subjectColumn && !monthly.some((m) => m.header === h),
                        )
                        .join(", ") +
                      ". These columns remain in the original workbook; review opening/closing balances and other information separately.",
                  ]
                : []),
              ...(reconciliationChecks.length
                ? [`${reconciliationChecks.length} monthly source totals reconciled exactly.`]
                : [
                    "No unambiguous monthly grand total was available; review the source totals manually before approving reference history.",
                  ]),
              `Prepared monthly REFERENCE history only: no invoices, payments, allocations or ledger entries will be created. ${blanks} blank amount cells were not interpreted as zero. Actual transaction dates are unknown and have not been invented.`,
            ],
          };
          await t.run("DELETE FROM mig_rows WHERE job_id=$1 AND table_id=$2", [job.id, tableId]);
          await t.run(
            "UPDATE mig_tables SET headers=$2,row_count=$3,entity='historical_summary',confidence=1,mapping=$4,sample=$5,analysis=$6,ignored=false,ignore_reason=NULL,mapped_by=$7 WHERE id=$1",
            [
              tableId,
              JSON.stringify(headers),
              rows.length,
              JSON.stringify(mapping),
              JSON.stringify(rows.slice(0, 5)),
              JSON.stringify(analysis),
              s.userId,
            ],
          );
          await insertRows(t, s.orgId, job.id, tableId, rows);
          await audit(
            t,
            s.actor,
            job,
            "Monthly reference history prepared",
            `${table.name}: ${rows.length} monthly amounts; meaning ${b.kind}, identity ${b.subjectType}, year ${b.year}. No live financial posting.`,
          );
        } else if ("headerRow" in input) {
          const f = await t.row<FileRow & { content: Buffer }>(
            "SELECT * FROM mig_files WHERE id=$1 AND org_id=$2 AND job_id=$3 AND status='stored'",
            [table.file_id, s.orgId, job.id],
          );
          if (!f || !table.analysis) throw fail.invalid("Read this file again before choosing a header row");
          let parsed;
          try {
            parsed = readTables(f.detected_type as "csv", f.filename, f.content, zipLimits(settings), {
              [table.analysis.sheet]: input.headerRow,
            });
          } catch (e) {
            if (e instanceof UnreadableFile) throw fail.invalid(e.message);
            throw e;
          }
          const tb = parsed.find((x) => x.name === table.analysis?.sheet);
          if (!tb?.analysis) throw fail.invalid("This worksheet cannot be reanalysed");
          const guess =
            tb.analysis.classification === "annual_matrix"
              ? { entity: null, confidence: 0, mapping: [] }
              : guessEntity(domainOf(job), tb.name, f.filename, tb.headers, await profileConfig(t, job));
          await t.run(
            "DELETE FROM mig_issues WHERE job_id=$1 AND row_id IN (SELECT id FROM mig_rows WHERE table_id=$2)",
            [job.id, tableId],
          );
          await t.run("DELETE FROM mig_rows WHERE table_id=$1 AND job_id=$2", [tableId, job.id]);
          await t.run(
            "UPDATE mig_tables SET headers=$2,row_count=$3,entity=$4,confidence=$5,mapping=$6,sample=$7,analysis=$8,ignored=false,ignore_reason=NULL,mapped_by=NULL WHERE id=$1",
            [
              tableId,
              JSON.stringify(tb.headers),
              tb.rows.length,
              guess.entity,
              guess.confidence,
              JSON.stringify(guess.mapping),
              JSON.stringify(tb.rows.slice(0, 5)),
              JSON.stringify(tb.analysis),
            ],
          );
          await insertRows(t, job.org_id, job.id, tableId, tb.rows, tb.sourceRows);
          await audit(t, s.actor, job, "Header row corrected", `${table.name}: row ${input.headerRow}`);
        } else if ("ignore" in input) {
          await t.run(
            "UPDATE mig_tables SET ignored = true, ignore_reason = $2, entity = NULL, mapping = '[]', mapped_by = $3 WHERE id = $1",
            [tableId, input.reason, s.userId],
          );
          await audit(t, s.actor, job, "Table ignored", `${table.name}: ${input.reason}`);
        } else {
          const d = domainOf(job);
          const spec = entityOf(d, input.entity);
          if (!spec && input.entity !== MANIFEST) throw fail.invalid(`Unknown entity ${input.entity}`);
          if (table.analysis?.classification === "annual_matrix" && spec?.fields.some((f) => f.type === "money"))
            throw fail.invalid(
              "This worksheet is an annual monthly report, not a dated transaction export. Confirm whether amounts are charges, payments or balances and review unit matching before financial import. Do not map monthly totals to opening invoices.",
              {
                table: table.name,
                headerRow: table.analysis.headerRow,
                correction: { action: "review_historical_report", tableId },
              },
            );
          const allowed = new Set(spec ? [SOURCE_ID, ...spec.fields.map((f) => f.name)] : MANIFEST_FIELDS);
          const seen = new Set<string>();
          for (const c of input.columns) {
            if (!table.headers.includes(c.source)) throw fail.invalid(`Column "${c.source}" is not in ${table.name}`);
            if (!allowed.has(c.field)) throw fail.invalid(`${input.entity} has no field ${c.field}`);
            if (seen.has(c.field)) throw fail.invalid(`Field ${c.field} is mapped twice`);
            seen.add(c.field);
          }
          const missing = spec
            ? [SOURCE_ID, ...spec.fields.filter((f) => f.required && !f.defaultValue).map((f) => f.name)].filter(
                (f) => !seen.has(f),
              )
            : MANIFEST_FIELDS.filter((f) => !seen.has(f));
          if (missing.length) throw fail.invalid(`Map these required fields: ${missing.join(", ")}`, { missing });
          await t.run(
            "UPDATE mig_tables SET ignored = false, ignore_reason = NULL, entity = $2, mapping = $3, mapped_by = $4 WHERE id = $1",
            [tableId, input.entity, JSON.stringify(input.columns), s.userId],
          );
          await audit(
            t,
            s.actor,
            job,
            "Table mapped",
            `${table.name} → ${input.entity} (${input.columns.length} columns)`,
          );
        }
        const open = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM mig_tables WHERE job_id = $1 AND NOT ignored AND entity IS NULL",
          [job.id],
        );
        await moveTo(t, job, open?.n ? "detected" : "mapped");
        await noteChange(t, job, s.userId);
        return toTable((await t.row<TableRow>("SELECT * FROM mig_tables WHERE id = $1", [tableId])) as TableRow);
      });
    },

    // ---------------------------------------------------------------- validate and resolve
    async validate(s: OrgScope, jobId: string) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ANALYSED, "validation");
        const summary = await validateIn(t, s, job);
        await audit(
          t,
          s.actor,
          job,
          "Migration validated",
          `${summary.errors} error(s), ${summary.warnings} warning(s)`,
        );
        return summary;
      });
    },

    async listIssues(
      orgId: string,
      jobId: string,
      q: { severity?: string | undefined; entity?: string | undefined; code?: string | undefined; limit: number },
    ) {
      await load(db, orgId, jobId);
      const where = `WHERE i.job_id = $1 AND ($2::text IS NULL OR i.severity = $2) AND ($3::text IS NULL OR i.entity = $3) AND ($4::text IS NULL OR i.code = $4)`;
      const p = [jobId, q.severity ?? null, q.entity ?? null, q.code ?? null];
      const rows = await db.rows<IssueRow>(`${ISSUE_SELECT} ${where} ORDER BY i.id LIMIT $5`, [...p, q.limit]);
      const total = await db.row<{ n: number }>(`SELECT count(*)::int AS n FROM mig_issues i ${where}`, p);
      return { issues: rows.map(toIssue), total: total?.n ?? 0 };
    },

    async listRows(
      orgId: string,
      jobId: string,
      q: {
        status?: string | undefined;
        entity?: string | undefined;
        sourceRecordId?: string | undefined;
        limit: number;
        afterId?: string | undefined;
      },
    ) {
      await load(db, orgId, jobId);
      const rows = await db.rows<RowRow>(
        `SELECT * FROM mig_rows WHERE job_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR entity = $3)
           AND ($4::text IS NULL OR source_record_id = $4) AND ($5::bigint IS NULL OR id > $5)
         ORDER BY id LIMIT $6`,
        [jobId, q.status ?? null, q.entity ?? null, q.sourceRecordId ?? null, q.afterId ?? null, q.limit],
      );
      return rowView(db, jobId, rows);
    },

    async resolveRow(
      s: OrgScope,
      jobId: string,
      rowId: string,
      input:
        | { action: "correct"; values: Record<string, string> }
        | { action: "skip"; reason: string }
        | { action: "merge"; intoRowId?: string | undefined; intoTargetId?: string | undefined; reason: string }
        | { action: "keep"; reason: string }
        | { action: "reset" },
    ) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ANALYSED, "resolving rows");
        const row = await t.row<RowRow>("SELECT * FROM mig_rows WHERE job_id = $1 AND id = $2", [job.id, rowId]);
        if (!row) throw fail.notFound("Row not found");
        if (row.status === "imported") throw fail.conflict("This row is imported — roll back its batch to change it");
        const d = domainOf(job);
        const spec = row.entity ? entityOf(d, row.entity) : undefined;
        let detail: string;
        switch (input.action) {
          case "correct": {
            const allowed = new Set(spec ? [SOURCE_ID, ...spec.fields.map((f) => f.name)] : MANIFEST_FIELDS);
            for (const k of Object.keys(input.values))
              if (!allowed.has(k)) throw fail.invalid(`${row.entity ?? "This row"} has no field ${k}`);
            await t.run("UPDATE mig_rows SET correction = correction || $2::jsonb, decided_by = $3 WHERE id = $1", [
              row.id,
              JSON.stringify(input.values),
              s.userId,
            ]);
            detail = `Row ${row.row_no} corrected: ${Object.entries(input.values)
              .map(([k, v]) => `${k} = "${v}"`)
              .join(", ")}`;
            break;
          }
          case "skip":
          case "keep":
            await t.run(
              "UPDATE mig_rows SET decision = $2, decision_reason = $3, merge_into_row = NULL, merge_into_target = NULL, decided_by = $4 WHERE id = $1",
              [row.id, input.action, input.reason, s.userId],
            );
            detail = `Row ${row.row_no} (${row.entity} ${row.source_record_id ?? ""}) ${input.action === "skip" ? "skipped" : "kept as a separate record"}: ${input.reason}`;
            break;
          case "merge": {
            if (!!input.intoRowId === !!input.intoTargetId)
              throw fail.invalid("Merge into one row (intoRowId) or one existing record (intoTargetId)");
            if (!spec) throw fail.invalid("Only record rows can be merged");
            if (input.intoRowId) {
              const into = await t.row<RowRow>("SELECT * FROM mig_rows WHERE job_id = $1 AND id = $2", [
                job.id,
                input.intoRowId,
              ]);
              if (!into || into.entity !== row.entity)
                throw fail.invalid(`Merge into a row of the same kind (${row.entity})`);
              if (into.id === row.id || into.decision === "skip" || into.decision === "merge")
                throw fail.invalid("Merge into a row that is itself kept");
            } else {
              const fixed = Object.entries(spec.fixed ?? {});
              const target = await t.row(
                `SELECT 1 FROM ${spec.table} WHERE org_id = $1 AND id = $2 ${fixed.map(([c], i) => `AND ${c} = $${i + 3}`).join(" ")}`,
                [job.org_id, input.intoTargetId, ...fixed.map(([, v]) => v)],
              );
              if (!target) throw fail.invalid(`No ${spec.label.toLowerCase()} ${input.intoTargetId} in PALTAS`);
            }
            await t.run(
              "UPDATE mig_rows SET decision = 'merge', decision_reason = $2, merge_into_row = $3, merge_into_target = $4, decided_by = $5 WHERE id = $1",
              [row.id, input.reason, input.intoRowId ?? null, input.intoTargetId ?? null, s.userId],
            );
            detail = `Row ${row.row_no} (${row.entity} ${row.source_record_id ?? ""}) merged into ${input.intoRowId ? `row ${input.intoRowId}` : `existing record ${input.intoTargetId}`}: ${input.reason}`;
            break;
          }
          case "reset":
            await t.run(
              "UPDATE mig_rows SET decision = NULL, decision_reason = NULL, merge_into_row = NULL, merge_into_target = NULL, correction = '{}', decided_by = $2 WHERE id = $1",
              [row.id, s.userId],
            );
            detail = `Row ${row.row_no}: decisions and corrections undone`;
            break;
        }
        await audit(t, s.actor, job, "Row resolved", detail);
        const validation = await validateIn(t, s, job);
        await noteChange(t, job, s.userId);
        const fresh = (await t.row<RowRow>("SELECT * FROM mig_rows WHERE id = $1", [row.id])) as RowRow;
        const [view] = await rowView(t, job.id, [fresh]);
        return { row: view as MigrationRow, validation };
      });
    },

    // ---------------------------------------------------------------- documents
    async listDocuments(orgId: string, jobId: string, status?: string) {
      await load(db, orgId, jobId);
      const rows = await db.rows<DocumentRow>(
        'SELECT * FROM mig_documents WHERE job_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY original_ref COLLATE "C"',
        [jobId, status ?? null],
      );
      return rows.map(toDocument);
    },

    async resolveDocument(
      s: OrgScope,
      jobId: string,
      documentId: string,
      input:
        { action: "link"; entity: string; sourceRecordId: string } | { action: "unlinked" | "exclude"; reason: string },
    ) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ANALYSED, "resolving documents");
        const doc = await t.row<DocumentRow>("SELECT * FROM mig_documents WHERE job_id = $1 AND id = $2", [
          job.id,
          documentId,
        ]);
        if (!doc) throw fail.notFound("Document not found");
        if (doc.status === "unsupported" || doc.status === "corrupt")
          throw fail.conflict(`This file is ${doc.status} and cannot be imported`);
        if (doc.target_id) throw fail.conflict("This document is imported — roll back its batch to change it");
        const d = domainOf(job);
        if (input.action === "link") {
          if (!d.documentTargets.includes(input.entity))
            throw fail.invalid(`Documents can be linked to: ${d.documentTargets.join(", ")}`);
          const inJob = await t.row<{ target_id: string | null }>(
            "SELECT target_id FROM mig_rows WHERE job_id = $1 AND entity = $2 AND source_record_id = $3 AND status IN ('valid', 'imported', 'already_present', 'error') LIMIT 1",
            [job.id, input.entity, input.sourceRecordId],
          );
          const existing = inJob
            ? inJob.target_id
            : await existingRecord(t, job.org_id, job.source_system, d, input.entity, input.sourceRecordId);
          if (!inJob && !existing)
            throw fail.invalid(`No ${input.entity} ${input.sourceRecordId} in the upload or in PALTAS`);
          await t.run(
            `UPDATE mig_documents SET status = 'linked', link_mode = 'manual', link_entity = $2, link_source_id = $3, link_target_id = $4,
               reason = 'Linked by hand', decided_by = $5 WHERE id = $1`,
            [doc.id, input.entity, input.sourceRecordId, existing, s.userId],
          );
          await audit(
            t,
            s.actor,
            job,
            "Document linked",
            `${doc.original_ref} → ${input.entity} ${input.sourceRecordId}`,
          );
        } else {
          const status = input.action === "exclude" ? "excluded" : "unlinked";
          await t.run(
            `UPDATE mig_documents SET status = $2, link_mode = NULL, link_entity = NULL, link_source_id = NULL, link_target_id = NULL,
               reason = $3, decided_by = $4 WHERE id = $1`,
            [doc.id, status, input.reason, s.userId],
          );
          await audit(
            t,
            s.actor,
            job,
            status === "excluded" ? "Document excluded" : "Document kept unlinked",
            `${doc.original_ref}: ${input.reason}`,
          );
        }
        await validateIn(t, s, job);
        await noteChange(t, job, s.userId);
        return toDocument(
          (await t.row<DocumentRow>("SELECT * FROM mig_documents WHERE id = $1", [doc.id])) as DocumentRow,
        );
      });
    },

    // ---------------------------------------------------------------- dry run, approval, import
    async dryRun(s: OrgScope, jobId: string) {
      const job = await load(db, s.orgId, jobId);
      need(job, ["resolved", "dry_run", "approved"], "a dry run (resolve every error first)");
      const summary = await dryRun(db, job, domainOf(job), ledger, settings.batchSize, now());
      await db.tx(async (t) => {
        const j = await load(t, s.orgId, jobId, true);
        need(j, ["resolved", "dry_run", "approved"], "a dry run");
        // a change committed while the dry run ran would not be in its summary
        if (j.revision !== job.revision)
          throw fail.conflict("The rows, mappings or decisions changed while the dry run ran — run the dry run again");
        await moveTo(t, j, "dry_run");
        await t.run(
          "UPDATE mig_jobs SET dry_run = $2, dry_run_by = $3, dry_run_at = now(), dry_run_revision = $4 WHERE id = $1",
          [j.id, JSON.stringify(summary), s.userId, j.revision],
        );
        await audit(
          t,
          s.actor,
          j,
          "Dry run",
          `${summary.wouldCreate} record(s) would be created, ${summary.alreadyPresent} already in PALTAS, ${summary.batches} batch(es); nothing was written`,
        );
      });
      return summary;
    },

    async approve(s: OrgScope, jobId: string) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ["dry_run"], "approval (run the dry run first)");
        sameAsDryRun(job);
        if (job.dry_run_by === s.userId)
          throw fail.separationOfDuties("You ran this dry run — someone else must approve the import");
        if (job.changed_by.includes(s.userId))
          throw fail.separationOfDuties(
            "You changed mappings, rows or document decisions of this migration — someone else must approve the import",
          );
        await moveTo(t, job, "approved");
        await t.run("UPDATE mig_jobs SET approved_by = $2, approved_at = now() WHERE id = $1", [job.id, s.userId]);
        await audit(t, s.actor, job, "Migration approved", `Dry run of ${job.dry_run?.at ?? ""} approved for import`);
        return toJob(t, (await load(t, s.orgId, jobId)) as JobRow);
      });
    },

    async startImport(s: OrgScope, jobId: string) {
      const out = await db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ["approved"], "the import (it must be approved first)");
        sameAsDryRun(job);
        await t.run(
          `UPDATE mig_batches SET status = 'rolled_back', rollback_reason = 'Replaced by a new import run', lease_owner = NULL, lease_until = NULL
           WHERE job_id = $1 AND status IN ('queued', 'failed')`,
          [job.id],
        );
        const made = await createBatches(t, job, domainOf(job), settings.batchSize);
        await moveTo(t, job, "importing");
        await t.run("UPDATE mig_jobs SET last_error = NULL WHERE id = $1", [job.id]);
        await audit(t, s.actor, job, "Import queued", `${made} batch(es) for the server worker`);
        if (!made) await finishImport(t, job);
        return toJob(t, await load(t, s.orgId, jobId));
      });
      worker.wake();
      return out;
    },

    async retry(s: OrgScope, jobId: string) {
      const out = await db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ["failed"], "a retry");
        const n = await t.run(
          "UPDATE mig_batches SET status = 'queued', error = NULL, queued_at = now() WHERE job_id = $1 AND status = 'failed'",
          [job.id],
        );
        await moveTo(t, job, "importing");
        await t.run("UPDATE mig_jobs SET last_error = NULL WHERE id = $1", [job.id]);
        await audit(t, s.actor, job, "Failed batches queued again", `${n} batch(es)`);
        return toJob(t, await load(t, s.orgId, jobId));
      });
      worker.wake();
      return out;
    },

    async listBatches(orgId: string, jobId: string) {
      await load(db, orgId, jobId);
      return (await db.rows<BatchRow>("SELECT * FROM mig_batches WHERE job_id = $1 ORDER BY seq", [jobId])).map(
        toBatch,
      );
    },

    async rollbackBatch(s: OrgScope, jobId: string, seq: number, reason: string) {
      // the reason is kept on the batch and in the audit trail; one person may roll back (a second is not required)
      if (reason.trim().length < 5) throw fail.invalid("Record the reason for the rollback (at least 5 characters)");
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(
          job,
          ["failed", "reconciled", "rolled_back"],
          "rolling back a batch (a signed-off migration is corrected with journals, not rolled back)",
        );
        const batch = await t.row<BatchRow>("SELECT * FROM mig_batches WHERE job_id = $1 AND seq = $2 FOR UPDATE", [
          job.id,
          seq,
        ]);
        if (!batch) throw fail.notFound("Batch not found");
        if (batch.status !== "done")
          throw fail.conflict(
            `Batch ${seq} is ${batch.status.replace("_", " ")} — only an imported batch can be rolled back`,
          );
        const later = await t.rows<{ seq: number }>(
          "SELECT seq FROM mig_batches WHERE job_id = $1 AND seq > $2 AND status = 'done' ORDER BY seq DESC",
          [job.id, seq],
        );
        if (later.length)
          throw fail.conflict(`Roll back the later batches first: ${later.map((b) => b.seq).join(", ")}`);
        const reversal = await rollbackBatch(t, job, batch, domainOf(job), ledger);
        await t.run(
          `UPDATE mig_batches SET status = 'rolled_back', reversal_journal_id = $2, rolled_back_by = $3, rolled_back_at = now(), rollback_reason = $4
           WHERE id = $1`,
          [batch.id, reversal, s.userId, reason],
        );
        await moveTo(t, job, "rolled_back");
        await t.run("UPDATE mig_jobs SET reconciliation = NULL WHERE id = $1", [job.id]);
        await audit(
          t,
          s.actor,
          job,
          "Batch rolled back",
          `Batch ${seq} (${batch.entity}): ${batch.created_count} record(s) removed${reversal ? ", journal reversed" : ""} — ${reason}`,
        );
        return toBatch((await t.row<BatchRow>("SELECT * FROM mig_batches WHERE id = $1", [batch.id])) as BatchRow);
      });
    },

    // ---------------------------------------------------------------- reconcile, sign off, reports
    async reconcile(s: OrgScope, jobId: string) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ["reconciled", "completed", "failed", "rolled_back"], "reconciliation (import first)");
        const rec = await reconcileJob(t, job, domainOf(job), ledger, now());
        await t.run("UPDATE mig_jobs SET reconciliation = $2, updated_at = now() WHERE id = $1", [
          job.id,
          JSON.stringify(rec),
        ]);
        await audit(t, s.actor, job, "Reconciled", rec.ok ? "Source and PALTAS agree" : rec.mismatches.join("; "));
        return rec;
      });
    },

    async complete(s: OrgScope, jobId: string) {
      return db.tx(async (t) => {
        const job = await load(t, s.orgId, jobId, true);
        need(job, ["reconciled"], "sign-off (the import must be finished and reconciled)");
        if (job.approved_by === s.userId)
          throw fail.separationOfDuties("You approved this import — someone else must sign it off");
        const rec = await reconcileJob(t, job, domainOf(job), ledger, now());
        await t.run("UPDATE mig_jobs SET reconciliation = $2 WHERE id = $1", [job.id, JSON.stringify(rec)]);
        if (!rec.ok)
          throw fail.conflict("Reconciliation shows differences — resolve them before signing off", {
            mismatches: rec.mismatches,
          });
        await t.run(
          "UPDATE mig_jobs SET status = 'completed', completed_by = $2, completed_at = now(), updated_at = now() WHERE id = $1",
          [job.id, s.userId],
        );
        await audit(t, s.actor, job, "Migration signed off", "PALTAS is now the system of record for these records");
        return toJob(t, await load(t, s.orgId, jobId));
      });
    },

    async report(orgId: string, jobId: string, kind: "report" | "exceptions", format: "csv" | "json") {
      const job = await load(db, orgId, jobId);
      return buildReport(db, job, await toJob(db, job), kind, format);
    },

    async listRecords(orgId: string, jobId: string, entity: string, limit: number) {
      const job = await load(db, orgId, jobId);
      const d = domainOf(job);
      const spec = entityOf(d, entity);
      const table = entity === "document" ? d.documentTable : spec?.table;
      if (!table) throw fail.invalid(`Unknown entity ${entity}`);
      const label = spec ? spec.labelField : "filename";
      const fixed = Object.entries(spec?.fixed ?? {});
      const rows = await db.rows<{
        id: string;
        source_record_id: string;
        mig_batch_id: string | null;
        label: string | null;
      }>(
        `SELECT id, source_record_id, mig_batch_id, ${label}::text AS label FROM ${table}
         WHERE org_id = $1 AND mig_job_id = $2 ${fixed.map(([c], i) => `AND ${c} = $${i + 4}`).join(" ")}
         ORDER BY source_record_id COLLATE "C" LIMIT $3`,
        [orgId, jobId, limit, ...fixed.map(([, v]) => v)],
      );
      return rows.map((r) => ({
        entity,
        id: r.id,
        sourceRecordId: r.source_record_id,
        batchId: r.mig_batch_id,
        label: r.label ?? "",
      }));
    },

    async audit(orgId: string, jobId: string) {
      await load(db, orgId, jobId);
      const rows = await db.rows<{
        at: string;
        actor_user: string | null;
        actor_role: string | null;
        action: string;
        detail: string;
      }>(
        "SELECT at, actor_user, actor_role, action, detail FROM audit_log WHERE org_id = $1 AND target = $2 ORDER BY id",
        [orgId, jobId],
      );
      return rows.map((r) => ({
        at: r.at,
        actorUserId: r.actor_user,
        actorRole: r.actor_role,
        action: r.action,
        detail: r.detail,
      }));
    },
  };
}

export type MigrationService = ReturnType<typeof migrationService>;
