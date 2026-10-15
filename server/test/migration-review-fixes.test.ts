// One test per data-migration problem found by the review of 14 October 2026 (findings 6, 7, 8 and 13), so none
// can return unnoticed: upload limits that could be got round, stage changes not checked under the job lock,
// identical documents linked to different records, and separation of duties around approval and sign-off.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { development } from "../dist/products/development/index.js";
import { csv, migrationSettings, sha256, upload, waitFor, zip } from "./support/migration-fixtures.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

const MB = 1024 * 1024;
const CUTOVER = "2026-09-30";
const PDF = Buffer.from("%PDF-1.4\n% Floor plan, standard 2BR\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

const smallExport = () => [
  {
    name: "projects.csv",
    data: Buffer.from(
      csv([
        ["Project ID", "Project Name"],
        ["P-1", "Hill Court"],
      ]),
    ),
  },
  {
    name: "units.csv",
    data: Buffer.from(
      csv([
        ["Unit ID", "Project", "Unit Number"],
        ["U-1", "P-1", "101"],
        ["U-2", "P-1", "102"],
        ["U-3", "P-1", "103"],
      ]),
    ),
  },
];

async function newJob(api: Person["api"], orgId: string, name: string, sourceSystem = "hill-xls") {
  return (
    await api.migration.createJob({
      params: { orgId },
      body: { domain: "development", name, sourceSystem, cutoverDate: CUTOVER },
    })
  ).id;
}

/** Upload, read and validate the small export: the job ends resolved (nothing to fix) unless documents need review. */
async function toResolved(
  api: Person["api"],
  orgId: string,
  jobId: string,
  extra: { name: string; data: Buffer }[] = [],
) {
  for (const f of [...smallExport(), ...extra]) await upload(api, orgId, jobId, f.name, f.data);
  await api.migration.detect({ params: { orgId, jobId } });
  await api.migration.validate({ params: { orgId, jobId } });
  expect((await api.migration.getJob({ params: { orgId, jobId } })).status).toBe(
    extra.length ? "validated" : "resolved",
  );
}

/** Hold an exclusive lock on a table from outside the server until release() is called. */
async function holdTable(S: TestServer, table: string) {
  const c = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
  await c.connect();
  await c.query("BEGIN");
  await c.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  return {
    release: async () => {
      await c.query("COMMIT");
      await c.end();
    },
  };
}

const lockWaiters = (S: TestServer) =>
  S.sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
  ).then((r) => r[0]!.n);

/** Settle a promise into { ok, value | error } so it can be awaited later without an unhandled rejection. */
const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: { status: number; code: string; message: string }) => ({ ok: false as const, error }),
  );

describe("6. upload limits cannot be got round", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  const start = (jobId: string, filename: string, sizeBytes: number, hash = "0".repeat(64)) =>
    admin.api.migration.startUpload({ params: { orgId, jobId }, body: { filename, sizeBytes, sha256: hash } });

  beforeAll(async () => {
    S = await startServer({
      products: [development],
      config: { migration: migrationSettings({ maxFileBytes: 2 * MB, maxJobBytes: 3 * MB, maxOpenUploads: 3 }) },
    });
    ({ orgId, admin } = await S.newOrg({ product: "developer", plan: "DEV-PRO" }));
  });
  afterAll(() => S.close());

  it("an upload in progress counts its announced size, and announcing at once cannot pass the job limit", async () => {
    const jobId = await newJob(admin.api, orgId, "Announced sizes");
    await start(jobId, "a.csv", 2 * MB);
    const err = await refused(start(jobId, "b.csv", 1.5 * MB), 400);
    expect(err.message).toMatch(/over its 3145728 bytes/);
    // two announcements at the same moment: the job row is locked, only one fits
    const other = await newJob(admin.api, orgId, "Parallel announcements");
    const both = await Promise.all([settle(start(other, "x.csv", 2 * MB)), settle(start(other, "y.csv", 2 * MB))]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    expect(both.find((r) => !r.ok)!.error).toMatchObject({ status: 400 });
  });

  it("at most MIGRATION_MAX_OPEN_UPLOADS files of a job may be in progress", async () => {
    const jobId = await newJob(admin.api, orgId, "Open uploads");
    const data = Buffer.from("id,name\n1,x\n");
    const first = await start(jobId, "1.csv", data.length, sha256(data));
    await start(jobId, "2.csv", 10);
    await start(jobId, "3.csv", 10);
    const err = await refused(start(jobId, "4.csv", 10), 409);
    expect(err.message).toMatch(/3 files of this migration are still being uploaded/);
    // completing one makes room for the next
    await admin.api.migration.uploadChunk({
      params: { orgId, jobId, fileId: first.file.id, index: 0 },
      body: { dataBase64: data.toString("base64") },
    });
    await admin.api.migration.completeUpload({ params: { orgId, jobId, fileId: first.file.id } });
    expect((await start(jobId, "4.csv", 10)).file.status).toBe("uploading");
  });

  it("a chunk reaching past the announced size is refused before anything of it is kept", async () => {
    const jobId = await newJob(admin.api, orgId, "Chunk sizes");
    const s = await start(jobId, "abc.csv", 4, sha256(Buffer.from("a\n1\n")));
    const err = await refused(
      admin.api.migration.uploadChunk({
        params: { orgId, jobId, fileId: s.file.id, index: 0 },
        body: { dataBase64: Buffer.from("a\n1\n2\n").toString("base64") },
      }),
      400,
    );
    expect(err.message).toMatch(/More bytes were sent than announced/);
    const [kept] = await S.sql("SELECT count(*)::int AS n FROM mig_upload_chunks WHERE file_id = $1", [s.file.id]);
    expect(kept.n).toBe(0);
    await admin.api.migration.uploadChunk({
      params: { orgId, jobId, fileId: s.file.id, index: 0 },
      body: { dataBase64: Buffer.from("a\n1\n").toString("base64") },
    });
    const done = await admin.api.migration.completeUpload({ params: { orgId, jobId, fileId: s.file.id } });
    expect(done.file.status).toBe("stored");
  });

  it("completing checks the job total again under the lock, counting uploads in progress and what a ZIP unpacks to", async () => {
    const jobId = await newJob(admin.api, orgId, "Totals at completion");
    await start(jobId, "pending.csv", 2 * MB); // announced, not finished: it keeps its 2 MB
    const archive = zip([{ name: "big.csv", data: Buffer.alloc(600 * 1024, 0x41), stored: true }]);
    // announced: 2 MB + 0.6 MB fits; kept: 2 MB + the archive (0.6 MB) + what it unpacks to (0.6 MB) does not
    const err = await refused(upload(admin.api, orgId, jobId, "site.zip", archive), 400);
    expect(err.message).toMatch(/Unpacked, this archive would take the migration over its 3145728 bytes/);
    const [f] = await S.sql("SELECT status, content IS NULL AS empty FROM mig_files WHERE id = $1", [
      err.details.fileId,
    ]);
    expect(f).toEqual({ status: "refused", empty: true });
    expect(
      (await S.sql("SELECT count(*)::int AS n FROM mig_files WHERE parent_id = $1", [err.details.fileId]))[0].n,
    ).toBe(0);
  });
});

describe("7. stage changes are checked again under the job lock", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let fd: Person;
  let jobId: string;
  const P = () => ({ orgId, jobId });
  const job = () => admin.api.migration.getJob({ params: P() });

  beforeAll(async () => {
    S = await startServer({ products: [development], config: { migration: migrationSettings({ worker: false }) } });
    ({ orgId, admin } = await S.newOrg({ product: "developer", plan: "DEV-PRO" }));
    fd = await S.addMember(orgId, admin.api, "finance_director");
    jobId = await newJob(admin.api, orgId, "Stage checks");
    await toResolved(admin.api, orgId, jobId);
  });
  afterAll(async () => {
    await S.app.core.migration.worker.stop();
    await S.close();
  });

  it("a row changed while the dry run runs makes the dry run refuse; it must be run again", async () => {
    const [u3] = (await admin.api.migration.listRows({ params: P(), query: { entity: "unit", sourceRecordId: "U-3" } }))
      .rows;
    const lock = await holdTable(S, "dev_projects");
    const dry = settle(admin.api.migration.dryRun({ params: P() }));
    await waitFor(
      () => lockWaiters(S),
      (n) => n >= 1,
    );
    // the change waits for the dry run's transaction, then commits before the dry run records its result
    const change = settle(
      admin.api.migration.resolveRow({
        params: { ...P(), rowId: u3!.id },
        body: { action: "skip", reason: "Unit 103 was merged into 102 on site" },
      }),
    );
    await waitFor(
      () => lockWaiters(S),
      (n) => n >= 2,
    );
    await lock.release();
    const [d, c] = await Promise.all([dry, change]);
    expect(c.ok).toBe(true);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatchObject({ status: 409, message: expect.stringMatching(/run the dry run again/) });
    const j = await job();
    expect([j.status, j.dryRun, j.dryRunBy]).toEqual(["resolved", null, null]);
    // run again: it sees the skipped unit
    const again = await admin.api.migration.dryRun({ params: P() });
    expect(again.byEntity.find((e) => e.entity === "unit")).toMatchObject({ create: 2, skipped: 1 });
  });

  it("approval and the import refuse a dry run whose revision no longer matches the data", async () => {
    await S.sql("UPDATE mig_jobs SET revision = revision + 1 WHERE id = $1", [jobId]);
    const err = await refused(fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } }), 409);
    expect(err.message).toMatch(/changed since the dry run — run the dry run again/);
    await admin.api.migration.dryRun({ params: P() });
    await fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } });
    await S.sql("UPDATE mig_jobs SET revision = revision + 1 WHERE id = $1", [jobId]);
    await refused(admin.api.migration.startImport({ params: P() }), 409);
    expect((await job()).status).toBe("approved");
    await admin.api.migration.dryRun({ params: P() });
    expect((await fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } })).status).toBe("approved");
  });

  it("completing an upload never overwrites a stage reached meanwhile (the import started)", async () => {
    const data = Buffer.from(
      csv([
        ["Phase ID", "Project", "Phase Name"],
        ["PH-1", "P-1", "Phase 1"],
      ]),
    );
    const s = await admin.api.migration.startUpload({
      params: P(),
      body: { filename: "phases.csv", sizeBytes: data.length, sha256: sha256(data) },
    });
    await admin.api.migration.uploadChunk({
      params: { ...P(), fileId: s.file.id, index: 0 },
      body: { dataBase64: data.toString("base64") },
    });
    // the completion passes its first stage check (approved), then waits on the chunks while the import starts
    const lock = await holdTable(S, "mig_upload_chunks");
    const completing = settle(admin.api.migration.completeUpload({ params: { ...P(), fileId: s.file.id } }));
    await waitFor(
      () => lockWaiters(S),
      (n) => n >= 1,
    );
    expect((await admin.api.migration.startImport({ params: P() })).status).toBe("importing");
    await lock.release();
    const r = await completing;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatchObject({ status: 409 });
    expect((await job()).status).toBe("importing");
    const [f] = await S.sql("SELECT status FROM mig_files WHERE id = $1", [s.file.id]);
    expect(f.status).toBe("uploading");
  });
});

describe("8. the same file linked to two records is linked to both", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let fd: Person;
  const count = async (table: string) =>
    Number((await S.sql(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId]))[0].n);

  beforeAll(async () => {
    S = await startServer({ products: [development], config: { migration: migrationSettings() } });
    ({ orgId, admin } = await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false }));
    fd = await S.addMember(orgId, admin.api, "finance_director");
  });
  afterAll(() => S.close());

  /** One floor plan (identical bytes) filed twice: for unit U-1 and for unit U-2. */
  async function importWithPlans(name: string) {
    const jobId = await newJob(admin.api, orgId, name);
    const P = { orgId, jobId };
    await toResolved(admin.api, orgId, jobId, [
      { name: "plan-a.pdf", data: PDF },
      { name: "plan-b.pdf", data: PDF },
    ]);
    const { documents } = await admin.api.migration.listDocuments({ params: P, query: {} });
    for (const [file, unit] of [
      ["plan-a.pdf", "U-1"],
      ["plan-b.pdf", "U-2"],
    ] as const)
      await admin.api.migration.resolveDocument({
        params: { ...P, documentId: documents.find((d) => d.filename === file)!.id },
        body: { action: "link", entity: "unit", sourceRecordId: unit },
      });
    expect((await admin.api.migration.getJob({ params: P })).status).toBe("resolved");
    const dry = await admin.api.migration.dryRun({ params: P });
    expect(dry.documents.linked).toBe(2);
    await fd.api.migration.approve({ params: P, body: { confirm: "CONFIRM" } });
    await admin.api.migration.startImport({ params: P });
    return waitFor(
      () => admin.api.migration.getJob({ params: P }),
      (j) => j.status !== "importing",
    );
  }

  it("both links are imported; the file's bytes are the same", async () => {
    const job = await importWithPlans("Floor plans");
    expect(job.status).toBe("reconciled");
    expect(job.reconciliation!.ok).toBe(true);
    expect(job.reconciliation!.counts.find((c) => c.entity === "document")).toMatchObject({
      source: 2,
      destination: 2,
    });
    const docs = await S.sql(
      `SELECT u.source_record_id AS unit, d.sha256 FROM dev_documents d JOIN dev_units u ON u.id = d.link_id
       WHERE d.org_id = $1 ORDER BY u.source_record_id COLLATE "C"`,
      [orgId],
    );
    expect(docs).toEqual([
      { unit: "U-1", sha256: sha256(PDF) },
      { unit: "U-2", sha256: sha256(PDF) },
    ]);
  });

  it("running it again creates nothing new", async () => {
    const before = await Promise.all(["dev_units", "dev_documents"].map(count));
    const job = await importWithPlans("Floor plans again");
    expect(job.status).toBe("reconciled");
    expect(job.reconciliation!.ok).toBe(true);
    expect(await Promise.all(["dev_units", "dev_documents"].map(count))).toEqual(before);
    expect(before[1]).toBe(2);
  });
});

describe("13. separation of duties: approver, changers and sign-off", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let fd: Person;
  let fd2: Person;
  let jobId: string;
  const P = () => ({ orgId, jobId });

  beforeAll(async () => {
    S = await startServer({ products: [development], config: { migration: migrationSettings() } });
    ({ orgId, admin } = await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false }));
    fd = await S.addMember(orgId, admin.api, "finance_director");
    fd2 = await S.addMember(orgId, admin.api, "finance_director");
    jobId = await newJob(admin.api, orgId, "Duties");
    await toResolved(admin.api, orgId, jobId);
  });
  afterAll(() => S.close());

  it("whoever changed a row, a mapping or a document decision cannot approve", async () => {
    const [u3] = (await fd.api.migration.listRows({ params: P(), query: { entity: "unit", sourceRecordId: "U-3" } }))
      .rows;
    await fd.api.migration.resolveRow({
      params: { ...P(), rowId: u3!.id },
      body: { action: "skip", reason: "Unit 103 is not for sale yet" },
    });
    await admin.api.migration.dryRun({ params: P() });
    const err = await refused(
      fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    expect(err.message).toMatch(/You changed mappings, rows or document decisions/);
    const [row] = await S.sql("SELECT decided_by FROM mig_rows WHERE id = $1", [u3!.id]);
    expect(row.decided_by).toBe(fd.userId);
    expect((await fd2.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } })).approvedBy).toBe(
      fd2.userId,
    );
    // and the database itself refuses an approver who changed something
    await expect(S.sql("UPDATE mig_jobs SET approved_by = $2 WHERE id = $1", [jobId, fd.userId])).rejects.toThrow(
      /migration_approver_changed_nothing/,
    );
  });

  it("the approver cannot sign off; someone else can", async () => {
    await admin.api.migration.startImport({ params: P() });
    const j = await waitFor(
      () => admin.api.migration.getJob({ params: P() }),
      (x) => x.status !== "importing",
    );
    expect(j.status).toBe("reconciled");
    await refused(
      fd2.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await expect(
      S.sql("UPDATE mig_jobs SET completed_by = approved_by, status = 'completed' WHERE id = $1", [jobId]),
    ).rejects.toThrow(/migration_signed_off_by_another/);
    const done = await fd.api.migration.complete({ params: P(), body: { confirm: "CONFIRM" } });
    expect([done.status, done.completedBy, done.approvedBy]).toEqual(["completed", fd.userId, fd2.userId]);
  });

  it("a rollback needs a reason, which is kept on the batch and in the audit trail (one person may roll back)", async () => {
    const o = await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false });
    const approver = await S.addMember(o.orgId, o.admin.api, "finance_director");
    const second = await newJob(o.admin.api, o.orgId, "Rollback reasons");
    const Q = { orgId: o.orgId, jobId: second };
    await toResolved(o.admin.api, o.orgId, second);
    await o.admin.api.migration.dryRun({ params: Q });
    await approver.api.migration.approve({ params: Q, body: { confirm: "CONFIRM" } });
    await o.admin.api.migration.startImport({ params: Q });
    await waitFor(
      () => o.admin.api.migration.getJob({ params: Q }),
      (x) => x.status === "reconciled",
    );
    const last = Math.max(...(await o.admin.api.migration.listBatches({ params: Q })).batches.map((b) => b.seq));
    for (const reason of ["", "    ", "no"])
      await refused(
        approver.api.migration.rollbackBatch({ params: { ...Q, seq: last }, body: { reason, confirm: "CONFIRM" } }),
        400,
      );
    const b = await approver.api.migration.rollbackBatch({
      params: { ...Q, seq: last },
      body: { reason: "Units were entered against the wrong project", confirm: "CONFIRM" },
    });
    expect([b.status, b.rolledBackBy, b.rollbackReason]).toEqual([
      "rolled_back",
      approver.userId,
      "Units were entered against the wrong project",
    ]);
    const { entries } = await o.admin.api.migration.audit({ params: Q });
    const audit = entries.find((e) => e.action === "Batch rolled back")!;
    expect([audit.actorUserId, audit.detail]).toEqual([
      approver.userId,
      expect.stringContaining("Units were entered against the wrong project"),
    ]);
  });
});
