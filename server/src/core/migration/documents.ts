/*
 * Documents link themselves only when it is unambiguous: a manifest row names the file and exactly one record, or
 * the file name contains exactly one record's source id as a whole token (e.g. "CTR-0001_signed.pdf"). Anything
 * else waits in the review queue for a person; a decision (link, keep unlinked, exclude) is never overridden.
 */
import type { Db } from "../../db/database.js";
import type { CheckIssue, MigrationDomain, ResolvedRef } from "./domain.js";
import { entityOf } from "./domain.js";
import type { DocumentRow } from "./migration.repo.js";

export type DocumentIssue = CheckIssue & { documentId: string };

export interface ManifestEntry {
  rowId: number;
  filename: string;
  entity: string;
  recordRef: string;
}

/** entity → source id → what it resolves to (a row of this job, or a record already in PALTAS) */
export type RecordIndex = Map<string, Map<string, ResolvedRef>>;

const tokens = (filename: string) =>
  new Set(
    filename
      .replace(/\.[A-Za-z0-9]+$/, "")
      .split(/[^A-Za-z0-9-]+/)
      .filter(Boolean)
      .map((t) => t.toUpperCase()),
  );

export async function existingRecord(
  db: Db,
  orgId: string,
  sourceSystem: string,
  domain: MigrationDomain,
  entity: string,
  sourceId: string,
): Promise<string | null> {
  const spec = entityOf(domain, entity);
  if (!spec) return null;
  const fixed = Object.entries(spec.fixed ?? {});
  const r = await db.row<{ id: string }>(
    `SELECT id FROM ${spec.table} WHERE org_id = $1 AND source_system = $2 AND source_record_id = $3
     ${fixed.map(([k], i) => `AND ${k} = $${i + 4}`).join(" ")}`,
    [orgId, sourceSystem, sourceId, ...fixed.map(([, v]) => v)],
  );
  return r?.id ?? null;
}

export async function linkDocuments(
  t: Db,
  job: { id: string; org_id: string; source_system: string },
  domain: MigrationDomain,
  index: RecordIndex,
  manifest: ManifestEntry[],
): Promise<DocumentIssue[]> {
  const docs = await t.rows<DocumentRow>(
    'SELECT * FROM mig_documents WHERE job_id = $1 ORDER BY original_ref COLLATE "C"',
    [job.id],
  );
  const issues: DocumentIssue[] = [];
  const resolve = async (entity: string, sourceId: string): Promise<{ targetId: string | null } | null> => {
    const hit = index.get(entity)?.get(sourceId);
    if (hit) return { targetId: "targetId" in hit ? hit.targetId : null };
    const existing = await existingRecord(t, job.org_id, job.source_system, domain, entity, sourceId);
    return existing ? { targetId: existing } : null;
  };
  // which source ids appear as file-name tokens
  const byToken = new Map<string, { entity: string; sourceRecordId: string }[]>();
  for (const entity of domain.documentTargets) {
    for (const id of index.get(entity)?.keys() ?? []) {
      const k = id.toUpperCase();
      byToken.set(k, [...(byToken.get(k) ?? []), { entity, sourceRecordId: id }]);
    }
  }
  const set = (d: DocumentRow, f: Partial<DocumentRow>) =>
    t.run(
      `UPDATE mig_documents SET status = $2, link_mode = $3, link_entity = $4, link_source_id = $5, link_target_id = $6,
         reason = $7, candidates = $8 WHERE id = $1`,
      [
        d.id,
        f.status,
        f.link_mode ?? null,
        f.link_entity ?? null,
        f.link_source_id ?? null,
        f.link_target_id ?? null,
        f.reason ?? "",
        JSON.stringify(f.candidates ?? []),
      ],
    );

  for (const d of docs) {
    if (d.status === "unsupported" || d.status === "corrupt") {
      issues.push({
        rowId: null,
        documentId: d.id,
        severity: "warning",
        code: `DOCUMENT_${d.status.toUpperCase()}`,
        message: `${d.original_ref}: ${d.reason}`,
      });
      continue;
    }
    if (d.status === "excluded" || d.status === "unlinked") continue;
    if (d.link_mode === "manual" && d.link_entity && d.link_source_id) {
      const r = await resolve(d.link_entity, d.link_source_id);
      if (r) {
        await set(d, { ...d, link_target_id: r.targetId });
        continue;
      }
      await set(d, {
        status: "review",
        reason: `The record it was linked to (${d.link_entity} ${d.link_source_id}) is no longer in the upload`,
      });
      issues.push({
        rowId: null,
        documentId: d.id,
        severity: "error",
        code: "DOCUMENT_REVIEW",
        message: `${d.original_ref} needs a link`,
      });
      continue;
    }
    const name = d.filename.toLowerCase();
    const listed = manifest.filter((m) => m.filename.toLowerCase() === name || m.filename === d.original_ref);
    let candidates: { entity: string; sourceRecordId: string }[];
    let why: string;
    if (listed.length) {
      candidates = listed.map((m) => ({ entity: m.entity, sourceRecordId: m.recordRef }));
      why = "the documents manifest";
    } else {
      candidates = [...tokens(d.filename)].flatMap((tk) => byToken.get(tk) ?? []);
      why = "its file name";
    }
    const unique = [...new Map(candidates.map((c) => [`${c.entity}:${c.sourceRecordId}`, c])).values()];
    const only = unique[0];
    if (unique.length === 1 && only && domain.documentTargets.includes(only.entity)) {
      const r = await resolve(only.entity, only.sourceRecordId);
      if (r) {
        await set(d, {
          status: "linked",
          link_mode: "auto",
          link_entity: only.entity,
          link_source_id: only.sourceRecordId,
          link_target_id: r.targetId,
          reason: `Linked by ${why}`,
          candidates: unique,
        });
        continue;
      }
    }
    const reason = !unique.length
      ? "No record matches this file — link it, keep it unlinked or exclude it"
      : unique.length > 1
        ? `Matches ${unique.length} records by ${why} — choose one`
        : `${why === "its file name" ? "Its file name" : "The manifest"} points to ${only?.entity} ${only?.sourceRecordId}, which is not in the upload or in PALTAS`;
    await set(d, { status: "review", reason, candidates: unique });
    issues.push({
      rowId: null,
      documentId: d.id,
      severity: "error",
      code: "DOCUMENT_REVIEW",
      message: `${d.original_ref}: ${reason}`,
    });
  }
  return issues;
}
