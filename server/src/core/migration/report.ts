/*
 * The migration report (what was planned, imported and reconciled) and the exception file (every row, document and
 * file that was refused, skipped, merged, flagged or left unlinked — with the reason). CSV or JSON.
 */
import type { MigrationJob } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import { toBatch, type BatchRow, type JobRow } from "./migration.repo.js";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // a leading = + - @ would be read as a formula by spreadsheet software
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

interface ExceptionRow {
  kind: string;
  file: string;
  table: string | null;
  row_no: number | null;
  entity: string | null;
  source_record_id: string | null;
  status: string;
  severity: string | null;
  code: string | null;
  message: string | null;
  decision: string | null;
  reason: string | null;
}

async function exceptions(db: Db, jobId: string): Promise<ExceptionRow[]> {
  return db.rows<ExceptionRow>(
    `SELECT * FROM (SELECT 'row' AS kind, f.original_ref AS file, t.name AS "table", r.row_no, r.entity, r.source_record_id, r.status,
            i.severity, i.code, i.message, r.decision,
            COALESCE(r.decision_reason, CASE WHEN t.ignored THEN 'Table ignored: ' || t.ignore_reason END) AS reason
     FROM mig_rows r JOIN mig_tables t ON t.id = r.table_id JOIN mig_files f ON f.id = t.file_id
     LEFT JOIN mig_issues i ON i.row_id = r.id
     WHERE r.job_id = $1 AND (r.status IN ('error', 'skipped', 'merged') OR i.id IS NOT NULL)
     UNION ALL
     SELECT 'document', d.original_ref, NULL, NULL, d.link_entity, d.link_source_id, d.status, i.severity, i.code,
            i.message, NULL, d.reason
     FROM mig_documents d LEFT JOIN mig_issues i ON i.document_id = d.id
     WHERE d.job_id = $1 AND (d.status <> 'linked' OR i.id IS NOT NULL)
     UNION ALL
     SELECT 'file', original_ref, NULL, NULL, NULL, NULL, status, 'error', 'FILE_REFUSED', refusal, NULL, NULL
     FROM mig_files WHERE job_id = $1 AND status = 'refused'
     UNION ALL
     SELECT 'job', '', NULL, NULL, entity, NULL, 'error', severity, code, message, NULL, NULL
     FROM mig_issues WHERE job_id = $1 AND row_id IS NULL AND document_id IS NULL) x
     ORDER BY kind COLLATE "C", file COLLATE "C", row_no`,
    [jobId],
  );
}

export async function buildReport(
  db: Db,
  job: JobRow,
  view: MigrationJob,
  kind: "report" | "exceptions",
  format: "csv" | "json",
) {
  const base = `${job.number}-${kind === "report" ? "migration-report" : "exceptions"}`;
  if (kind === "exceptions") {
    const rows = await exceptions(db, job.id);
    if (format === "json")
      return {
        filename: `${base}.json`,
        contentType: "application/json" as const,
        content: JSON.stringify({ job: view.number, exceptions: rows }, null, 2),
      };
    return {
      filename: `${base}.csv`,
      contentType: "text/csv" as const,
      content: csv(
        [
          "kind",
          "file",
          "table",
          "row",
          "entity",
          "source_record_id",
          "status",
          "severity",
          "code",
          "message",
          "decision",
          "reason",
        ],
        rows.map((r) => [
          r.kind,
          r.file,
          r.table,
          r.row_no,
          r.entity,
          r.source_record_id,
          r.status,
          r.severity,
          r.code,
          r.message,
          r.decision,
          r.reason,
        ]),
      ),
    };
  }
  const batches = (await db.rows<BatchRow>("SELECT * FROM mig_batches WHERE job_id = $1 ORDER BY seq", [job.id])).map(
    toBatch,
  );
  const audit = await db.rows<{
    at: string;
    actor_user: string | null;
    actor_role: string | null;
    action: string;
    detail: string;
  }>("SELECT at, actor_user, actor_role, action, detail FROM audit_log WHERE org_id = $1 AND target = $2 ORDER BY id", [
    job.org_id,
    job.id,
  ]);
  const report = {
    job: view,
    validation: job.validation,
    dryRun: job.dry_run,
    reconciliation: job.reconciliation,
    batches,
    audit,
  };
  if (format === "json")
    return {
      filename: `${base}.json`,
      contentType: "application/json" as const,
      content: JSON.stringify(report, null, 2),
    };
  const lines: unknown[][] = [
    ["job", "number", null, view.number, null, null, null],
    ["job", "status", null, view.status, null, null, null],
    ["job", "source system", null, view.sourceSystem, null, null, null],
    ["job", "cut-over date", null, view.cutoverDate, null, null, null],
    ...Object.entries(view.counts).map(([k, v]) => ["counts", k, null, v, null, null, null]),
    ...(job.dry_run?.byEntity ?? []).map((e) => ["dry run", "would create", e.entity, e.create, null, null, null]),
  ];
  const r = job.reconciliation;
  for (const [section, list] of [
    ["reconciliation: records", r?.counts ?? []],
    ["reconciliation: money", r?.money ?? []],
    ["reconciliation: relationships", r?.relationships ?? []],
    ["reconciliation: ledger", r?.ledger ?? []],
  ] as const)
    for (const l of list)
      lines.push([section, l.check, l.entity, l.source, l.destination, l.difference, l.ok ? "ok" : "MISMATCH"]);
  for (const b of batches)
    lines.push(["batch", `#${b.seq} ${b.status}`, b.entity, b.rowCount, b.createdCount, b.presentCount, b.error ?? ""]);
  for (const a of audit) lines.push(["audit", a.action, a.actor_role, a.at, a.actor_user, null, a.detail]);
  return {
    filename: `${base}.csv`,
    contentType: "text/csv" as const,
    content: csv(["section", "check", "entity", "source", "destination", "difference", "result"], lines),
  };
}
