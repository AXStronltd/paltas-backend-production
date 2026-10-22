/*
 * Uploads. A file is announced (name, size, SHA-256), sent in chunks (each request stays small, an interrupted
 * upload resumes by resending a chunk), then completed. Completing checks, in this order:
 *   size as announced → SHA-256 as announced → type by magic bytes (never by name) → for a ZIP: entry count,
 *   unpacked size, paths, symlinks, compression ratio, and each entry's own type → the job's total size.
 * The job's total counts stored files at their size and files still being uploaded at their announced size, so
 * announcing many files at once cannot get round it; announcing and completing hold the job row locked, and at most
 * maxOpenUploads files of a job may be in progress at a time. A chunk may never reach past the announced size.
 * A refused file keeps its name and the reason (for the exception report) but none of its bytes.
 * Inside a ZIP: data files (CSV, XLSX, JSON) and documents (PDF, images) become files of their own; an archive
 * inside the archive is not opened; anything else is reported as unsupported, a mislabelled document as corrupt.
 */
import { createHash } from "node:crypto";
import type { MigrationSettings } from "../../config.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { DATA_TYPES, DOCUMENT_TYPES, extensionType, sniff, type FileType } from "./files/sniff.js";
import { readZip, ZipRefused, type ZipLimits } from "./files/zip.js";
import type { MigrationFile } from "@paltas/contracts";
import { FILE_COLUMNS, toFile, type FileRow } from "./migration.repo.js";

/** Raw bytes per chunk: base64 of this stays under the API's 256 KB request limit. */
export const CHUNK_BYTES = 180 * 1024;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const basename = (p: string) => p.split("/").pop() ?? p;

export function zipLimits(s: MigrationSettings): ZipLimits {
  return { maxEntries: s.zipMaxEntries, maxUncompressedBytes: s.zipMaxUncompressedBytes };
}

async function fileRow(db: Db, jobId: string, fileId: string): Promise<FileRow | null> {
  return db.row<FileRow>(`SELECT ${FILE_COLUMNS} FROM mig_files WHERE job_id = $1 AND id = $2`, [jobId, fileId]);
}

/** Bytes the job holds or has been promised: stored files at their size, uploads in progress at their announced size. */
async function committedBytes(db: Db, jobId: string, exceptFileId: string | null = null): Promise<number> {
  const r = await db.row<{ n: number }>(
    `SELECT COALESCE(sum(CASE WHEN content IS NOT NULL THEN length(content) ELSE declared_size END), 0)::bigint AS n
     FROM mig_files WHERE job_id = $1 AND (status = 'uploading' OR content IS NOT NULL) AND id IS DISTINCT FROM $2`,
    [jobId, exceptFileId],
  );
  return r?.n ?? 0;
}

/** What the caller does while the job row is locked: check its stage first, then record the stored file. */
export interface CompleteHooks {
  locked(t: Db): Promise<void>;
  stored(t: Db, out: { file: MigrationFile; extracted: MigrationFile[] }): Promise<void>;
}

export function uploads(settings: MigrationSettings) {
  const limits = zipLimits(settings);

  /** Announce a file. The caller holds the job row locked (FOR UPDATE), so the limits below cannot race. */
  async function start(
    db: Db,
    job: { id: string; org_id: string },
    userId: string,
    input: { filename: string; sizeBytes: number; sha256: string },
  ) {
    const name = basename(input.filename.replace(/\\/g, "/"));
    if (!extensionType(name))
      throw fail.invalid(`Files of this type are not accepted. Send CSV, XLSX, JSON, ZIP, PDF or images.`);
    if (input.sizeBytes > settings.maxFileBytes)
      throw fail.invalid(`The file is larger than the ${settings.maxFileBytes} bytes allowed per file`);
    const open = await db.row<{ n: number }>(
      "SELECT count(*)::int AS n FROM mig_files WHERE job_id = $1 AND status = 'uploading'",
      [job.id],
    );
    if ((open?.n ?? 0) >= settings.maxOpenUploads)
      throw fail.conflict(
        `${settings.maxOpenUploads} files of this migration are still being uploaded — complete them before announcing more`,
      );
    if ((await committedBytes(db, job.id)) + input.sizeBytes > settings.maxJobBytes)
      throw fail.invalid(`This would take the migration over its ${settings.maxJobBytes} bytes of uploads`);
    const id = newId("mfl");
    await db.run(
      `INSERT INTO mig_files (id, org_id, job_id, filename, original_ref, declared_size, declared_sha256, status, uploaded_by)
       VALUES ($1, $2, $3, $4, $4, $5, $6, 'uploading', $7)`,
      [id, job.org_id, job.id, name, input.sizeBytes, input.sha256, userId],
    );
    return toFile((await fileRow(db, job.id, id)) as FileRow);
  }

  async function chunk(db: Db, jobId: string, fileId: string, index: number, dataBase64: string) {
    const f = await fileRow(db, jobId, fileId);
    if (!f) throw fail.notFound("File not found");
    if (f.status !== "uploading") throw fail.conflict(`This file is already ${f.status}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw fail.invalid("The chunk is not base64");
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > CHUNK_BYTES) throw fail.invalid(`A chunk holds at most ${CHUNK_BYTES} bytes`);
    // chunk i covers bytes [i × CHUNK_BYTES, i × CHUNK_BYTES + length): it must end within the announced size, so
    // the chunks together can never hold more than was announced (checked before anything is kept)
    if (index * CHUNK_BYTES >= f.declared_size) throw fail.invalid("This chunk is beyond the announced size");
    if (index * CHUNK_BYTES + data.length > f.declared_size) throw fail.invalid("More bytes were sent than announced");
    await db.run(
      `INSERT INTO mig_upload_chunks (file_id, idx, data) VALUES ($1, $2, $3)
       ON CONFLICT (file_id, idx) DO UPDATE SET data = EXCLUDED.data`,
      [fileId, index, data],
    );
    return { receivedBytes: (await fileRow(db, jobId, fileId))?.received_bytes ?? 0 };
  }

  async function refuse(db: Db, fileId: string, reason: string, size: number | null, hash: string | null) {
    await db.run(
      `UPDATE mig_files SET status = 'refused', refusal = $2, size_bytes = $3, sha256 = $4, content = NULL WHERE id = $1`,
      [fileId, reason, size, hash],
    );
    await db.run("DELETE FROM mig_upload_chunks WHERE file_id = $1", [fileId]);
  }

  /** A document found in the upload (or uploaded alone), waiting to be linked. */
  async function addDocument(
    db: Db,
    f: { org_id: string; job_id: string; id: string; filename: string; original_ref: string },
    size: number,
    hash: string,
    type: string,
    status: "review" | "unsupported" | "corrupt",
    reason: string,
  ) {
    await db.run(
      `INSERT INTO mig_documents (id, org_id, job_id, file_id, filename, original_ref, size_bytes, sha256, detected_type, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [newId("mdc"), f.org_id, f.job_id, f.id, f.filename, f.original_ref, size, hash, type, status, reason],
    );
  }

  /** One entry of a ZIP: kept as its own file, a document, or reported. */
  async function extractEntry(db: Db, parent: FileRow, userId: string, name: string, data: Buffer) {
    const id = newId("mfl");
    const filename = basename(name);
    const hash = sha256(data);
    const insert = (status: "stored" | "refused", type: string | null, refusal: string | null) =>
      db.run(
        `INSERT INTO mig_files (id, org_id, job_id, parent_id, filename, original_ref, declared_size, size_bytes, sha256,
           detected_type, status, refusal, content, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          parent.org_id,
          parent.job_id,
          parent.id,
          filename,
          `${parent.original_ref}/${name}`,
          data.length,
          hash,
          type,
          status,
          refusal,
          status === "stored" ? data : null,
          userId,
        ],
      );
    const ref = {
      org_id: parent.org_id,
      job_id: parent.job_id,
      id,
      filename,
      original_ref: `${parent.original_ref}/${name}`,
    };
    if (name.startsWith("__MACOSX/") || filename.startsWith("."))
      return insert("refused", null, "A system file added by the archiving tool — not imported");
    const claimed = extensionType(filename);
    const s = sniff(filename, data, limits);
    if (s.ok && s.type === "zip") return insert("refused", "zip", "Archives inside the archive are not opened");
    if (s.ok) {
      await insert("stored", s.type, null);
      if (DOCUMENT_TYPES.includes(s.type))
        await addDocument(db, ref, data.length, hash, s.type, "review", "Waiting for validation to link it");
      return;
    }
    await insert("refused", null, s.reason);
    if (claimed && DOCUMENT_TYPES.includes(claimed))
      await addDocument(db, ref, data.length, hash, claimed, "corrupt", s.reason);
    else if (!claimed || !DATA_TYPES.includes(claimed))
      await addDocument(db, ref, data.length, hash, claimed ?? "unknown", "unsupported", s.reason);
  }

  /**
   * Check and keep the file, or refuse it. Returns the file and anything extracted from it. A refusal is committed
   * (so it is reported) and then raised as a 400 with the reason. The bytes are checked first; then, with the job
   * row locked, the caller checks the job's stage (hooks.locked), the job's total is checked again, the file is
   * kept and the caller records it (hooks.stored) — all in one transaction.
   */
  async function complete(db: Db, jobId: string, fileId: string, userId: string, hooks: CompleteHooks) {
    const f = await fileRow(db, jobId, fileId);
    if (!f) throw fail.notFound("File not found");
    if (f.status !== "uploading") throw fail.conflict(`This file is already ${f.status}`);
    const chunks = await db.rows<{ idx: number; data: Buffer }>(
      "SELECT idx, data FROM mig_upload_chunks WHERE file_id = $1 ORDER BY idx",
      [fileId],
    );
    const missing = chunks.findIndex((c, i) => c.idx !== i);
    const expected = Math.ceil(f.declared_size / CHUNK_BYTES);
    if (missing >= 0 || chunks.length !== expected)
      throw fail.invalid(`Chunks are missing: received ${chunks.length} of ${expected}`, {
        received: chunks.map((c) => c.idx),
      });
    const data = Buffer.concat(chunks.map((c) => c.data));
    const hash = sha256(data);
    let refusal: string | null = null;
    let type: FileType | null = null;
    if (data.length !== f.declared_size) refusal = `Received ${data.length} bytes, announced ${f.declared_size}`;
    else if (hash !== f.declared_sha256) refusal = "The SHA-256 does not match: the file changed or was damaged";
    else {
      const s = sniff(f.filename, data, limits);
      if (s.ok) type = s.type;
      else refusal = s.reason;
    }
    let entries: { name: string; data: Buffer }[] = [];
    if (!refusal && type === "zip") {
      try {
        entries = readZip(data, limits);
      } catch (e) {
        if (!(e instanceof ZipRefused)) throw e;
        refusal = `Archive refused: ${e.message}`;
      }
    }
    if (refusal) {
      await refuse(db, fileId, refusal, data.length, hash);
      throw fail.invalid(refusal, { fileId });
    }
    const unpacked = entries.reduce((n, e) => n + e.data.length, 0);
    const result = await db.tx(async (t) => {
      await t.row("SELECT id FROM mig_jobs WHERE id = $1 FOR UPDATE", [jobId]);
      await hooks.locked(t);
      const now = await t.row<{ status: string }>("SELECT status FROM mig_files WHERE id = $1 FOR UPDATE", [fileId]);
      if (now?.status !== "uploading") throw fail.conflict(`This file is already ${now?.status ?? "gone"}`);
      // the job's total once this file is kept: a ZIP counts its own size and what it unpacks to
      if ((await committedBytes(t, jobId, fileId)) + data.length + unpacked > settings.maxJobBytes) {
        const reason = unpacked
          ? `Unpacked, this archive would take the migration over its ${settings.maxJobBytes} bytes of uploads`
          : `This would take the migration over its ${settings.maxJobBytes} bytes of uploads`;
        await refuse(t, fileId, reason, data.length, hash);
        return { refusal: reason, out: null };
      }
      await t.run(
        `UPDATE mig_files SET status = 'stored', size_bytes = $2, sha256 = $3, detected_type = $4, content = $5 WHERE id = $1`,
        [fileId, data.length, hash, type, type === "zip" ? null : data],
      );
      await t.run("DELETE FROM mig_upload_chunks WHERE file_id = $1", [fileId]);
      const stored = (await fileRow(t, jobId, fileId)) as FileRow;
      if (type && DOCUMENT_TYPES.includes(type))
        await addDocument(t, stored, data.length, hash, type, "review", "Waiting for validation to link it");
      for (const e of entries) await extractEntry(t, stored, userId, e.name, e.data);
      const extracted = await t.rows<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM mig_files WHERE parent_id = $1 ORDER BY original_ref COLLATE "C"`,
        [fileId],
      );
      const out = { file: toFile(stored), extracted: extracted.map(toFile) };
      await hooks.stored(t, out);
      return { refusal: null, out };
    });
    if (result.out === null) throw fail.invalid(result.refusal, { fileId });
    return result.out;
  }

  return { start, chunk, complete };
}
