// The import runs in a background worker with leases: a failed batch is retried, a wrongly approved batch is
// rolled back (only what it created, with its journal reversed), and a server killed in the middle of a batch
// leaves nothing half-written — another server picks the batch up when the lease runs out.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PaltasClient } from "@paltas/api-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { development } from "../dist/products/development/index.js";
import { csv, migrationSettings, upload, waitFor } from "./support/migration-fixtures.js";
import { refused, startServer, TODAY, type Person, type TestServer } from "./support/test-server.js";

const CUTOVER = "2026-09-30";

/** A small export: 1 project, 4 units, 2 buyers (one already in PALTAS), 2 contracts, 2 suppliers, 2 opening balances. */
function smallExport() {
  return [
    {
      name: "projects.csv",
      data: csv([
        ["Project ID", "Project Name"],
        ["P-1", "Lake View"],
      ]),
    },
    {
      name: "units.csv",
      data: csv([
        ["Unit ID", "Project", "Unit Number", "List Price"],
        ["U-1", "P-1", "101", "5000000"],
        ["U-2", "P-1", "102", "5000000"],
        ["U-3", "P-1", "103", "6000000"],
        ["U-4", "P-1", "104", "6000000"],
      ]),
    },
    {
      name: "buyers.csv",
      data: csv([
        ["Buyer ID", "Name", "Email"],
        ["B-1", "Wanjiru Kamau", "wanjiru@example.com"],
        ["B-2", "Juma Ali (already a PALTAS contact)", "juma@example.com"],
      ]),
    },
    {
      name: "contracts.csv",
      data: csv([
        ["Contract ID", "Unit", "Buyer", "Contract Date", "Price"],
        ["K-1", "U-1", "B-1", "2026-05-01", "5000000"],
        ["K-2", "U-2", "B-2", "2026-06-01", "5000000"],
      ]),
    },
    {
      name: "suppliers.csv",
      data: csv([
        ["Supplier ID", "Name", "Tax ID"],
        ["S-1", "Lake Hardware", "P000000001A"],
        ["S-2", "Rift Timber", "P000000002B"],
      ]),
    },
    {
      name: "opening balances.csv",
      data: csv([
        // no date column: opening balances are as of the cut-over date
        ["Opening Balance ID", "Kind", "Supplier", "Amount"],
        ["OB-1", "supplier_payable", "S-1", "120000.00"],
        ["OB-2", "supplier_payable", "S-2", "80000.50"],
      ]),
    },
  ].map((f) => ({ name: f.name, data: Buffer.from(f.data) }));
}

async function toApproved(S: TestServer, orgId: string, admin: Person, fd: Person) {
  const job = await admin.api.migration.createJob({
    params: { orgId },
    body: { domain: "development", name: "Lake View", sourceSystem: "lakeview-xls", cutoverDate: CUTOVER },
  });
  const P = { orgId, jobId: job.id };
  for (const f of smallExport()) await upload(admin.api, orgId, job.id, f.name, f.data);
  const { tables } = await admin.api.migration.detect({ params: P });
  expect(tables.map((t) => t.entity).sort()).toEqual([
    "buyer",
    "contract",
    "opening_balance",
    "project",
    "supplier",
    "unit",
  ]);
  const v = await admin.api.migration.validate({ params: P });
  if (v.byCode.DUPLICATE_EXISTING) {
    // B-2 is the contact already in PALTAS: link to it instead of creating a second one
    const [b2] = (await admin.api.migration.listRows({ params: P, query: { entity: "buyer", sourceRecordId: "B-2" } }))
      .rows;
    const [existing] = await S.sql("SELECT id FROM dev_contacts WHERE org_id = $1 AND email = 'juma@example.com'", [
      orgId,
    ]);
    await admin.api.migration.resolveRow({
      params: { ...P, rowId: b2!.id },
      body: { action: "merge", intoTargetId: existing.id, reason: "Already a PALTAS contact" },
    });
  }
  expect((await admin.api.migration.getJob({ params: P })).status).toBe("resolved");
  await admin.api.migration.dryRun({ params: P });
  await fd.api.migration.approve({ params: P, body: { confirm: "CONFIRM" } });
  return job.id;
}

describe("migration worker: failure, retry and rollback", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let fd: Person;
  let jobId: string;
  let nativeSupplier: string;
  let existingBuyer: string;
  const P = () => ({ orgId, jobId });
  const job = (api: PaltasClient = admin.api) => api.migration.getJob({ params: P() });
  const settled = () => waitFor(job, (j) => j.status !== "importing");
  const batches = async () => (await admin.api.migration.listBatches({ params: P() })).batches;
  const count = async (table: string) =>
    Number((await S.sql(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId]))[0].n);
  const migrationJournals = async () =>
    (await fd.api.ledger.listJournals({ params: { orgId }, query: {} })).journals.filter(
      (j) => j.source === "system:migration",
    );

  beforeAll(async () => {
    S = await startServer({ products: [development], config: { migration: migrationSettings({ batchSize: 2 }) } });
    const o = await S.newOrg({ product: "developer", plan: "DEV-PRO", trial: false });
    orgId = o.orgId;
    admin = o.admin;
    fd = await S.addMember(orgId, admin.api, "finance_director");
    // records that existed in PALTAS before the migration
    nativeSupplier = "supp_native";
    existingBuyer = "cont_existing";
    await S.sql("INSERT INTO dev_suppliers (id, org_id, kind, name) VALUES ($1, $2, 'supplier', 'Existing supplier')", [
      nativeSupplier,
      orgId,
    ]);
    await S.sql(
      "INSERT INTO dev_contacts (id, org_id, kind, name, email) VALUES ($1, $2, 'buyer', 'Juma Ali', 'juma@example.com')",
      [existingBuyer, orgId],
    );
    jobId = await toApproved(S, orgId, admin, fd);
  });
  afterAll(() => S.close());

  it("a batch that fails (September was closed meanwhile) stops the import; nothing of it is written", async () => {
    await fd.api.ledger.closePeriod({
      params: { orgId, month: "2026-09" },
      body: { reason: "September books closed" },
    });
    await admin.api.migration.startImport({ params: P() });
    const j = await settled();
    expect(j.status).toBe("failed");
    expect(j.lastError).toMatch(/Batch 7 \(opening_balance\) failed: .*closed/);
    const b = await batches();
    expect(b.map((x) => [x.seq, x.entity, x.status])).toEqual([
      [1, "project", "done"],
      [2, "unit", "done"],
      [3, "unit", "done"],
      [4, "buyer", "done"],
      [5, "contract", "done"],
      [6, "supplier", "done"],
      [7, "opening_balance", "failed"],
    ]);
    expect(b[6]!.attempts).toBe(1);
    expect(await count("dev_opening_balances")).toBe(0);
    expect(await migrationJournals()).toEqual([]);
    expect(j.progress).toMatchObject({ batchesDone: 6, batchesFailed: 1, percent: 83 });
  });

  it("retry: still closed → fails again; reopened → completes, posted once", async () => {
    await admin.api.migration.retry({ params: P() });
    expect((await settled()).status).toBe("failed");
    await fd.api.ledger.reopenPeriod({
      params: { orgId, month: "2026-09" },
      body: { reason: "Opening balances still to post" },
    });
    await admin.api.migration.retry({ params: P() });
    const j = await settled();
    expect(j.status).toBe("reconciled");
    expect(j.reconciliation!.ok).toBe(true);
    expect((await batches())[6]).toMatchObject({ status: "done", attempts: 3, createdCount: 2 });
    const js = await migrationJournals();
    expect(js.length).toBe(1);
    expect(js[0]!.lines.map((l) => [l.account, l.debitMinor, l.creditMinor])).toEqual([
      ["2000", 0, 20_000_050],
      ["3900", 20_000_050, 0],
    ]);
    const obs = await S.sql("SELECT DISTINCT as_of FROM dev_opening_balances WHERE org_id = $1", [orgId]);
    expect(obs).toEqual([{ as_of: CUTOVER }]);
    // the buyer already in PALTAS was linked, not duplicated
    expect(await count("dev_contacts")).toBe(2);
    const [k2] = await S.sql("SELECT buyer_id FROM dev_contracts WHERE org_id = $1 AND source_record_id = 'K-2'", [
      orgId,
    ]);
    expect(k2.buyer_id).toBe(existingBuyer);
  });

  it("rollback undoes only what a batch created, in reverse order, with the journal reversed", async () => {
    await refused(admin.api.migration.retry({ params: P() }), 409);
    // the latest batches first
    await refused(
      fd.api.migration.rollbackBatch({
        params: { ...P(), seq: 6 },
        body: { reason: "Wrong supplier list approved", confirm: "CONFIRM" },
      }),
      409,
    );
    const r7 = await fd.api.migration.rollbackBatch({
      params: { ...P(), seq: 7 },
      body: { reason: "Wrong opening balances approved", confirm: "CONFIRM" },
    });
    expect([r7.status, r7.rollbackReason]).toEqual(["rolled_back", "Wrong opening balances approved"]);
    expect(r7.reversalJournalId).toBeTruthy();
    expect(await count("dev_opening_balances")).toBe(0);
    const js = await migrationJournals();
    expect(js.length).toBe(2);
    const tb = await fd.api.ledger.trialBalance({ params: { orgId }, query: { asOf: CUTOVER } });
    expect(
      tb.rows.filter((r) => ["2000", "3900"].includes(r.code)).every((r) => r.debitMinor === 0 && r.creditMinor === 0),
    ).toBe(true);
    // suppliers: the two migrated ones go, the supplier that existed before stays
    await fd.api.migration.rollbackBatch({
      params: { ...P(), seq: 6 },
      body: { reason: "Wrong supplier list approved", confirm: "CONFIRM" },
    });
    expect((await S.sql("SELECT id FROM dev_suppliers WHERE org_id = $1", [orgId])).map((r) => r.id)).toEqual([
      nativeSupplier,
    ]);
    // a record added in PALTAS since then depends on a migrated contract: that batch cannot be undone
    const [k1] = await S.sql("SELECT id FROM dev_contracts WHERE org_id = $1 AND source_record_id = 'K-1'", [orgId]);
    await S.sql(
      "INSERT INTO dev_payments (id, org_id, contract_id, kind, date, amount_minor) VALUES ('pay_native', $1, $2, 'receipt', '2026-10-05', 100000)",
      [orgId, k1.id],
    );
    const err = await refused(
      fd.api.migration.rollbackBatch({
        params: { ...P(), seq: 5 },
        body: { reason: "Contracts approved by mistake", confirm: "CONFIRM" },
      }),
      409,
    );
    expect(err.message).toMatch(/Records added to PALTAS after this batch/);
    expect(await count("dev_contracts")).toBe(2);
    await S.sql("DELETE FROM dev_payments WHERE id = 'pay_native'");
    await fd.api.migration.rollbackBatch({
      params: { ...P(), seq: 5 },
      body: { reason: "Contracts approved by mistake", confirm: "CONFIRM" },
    });
    await fd.api.migration.rollbackBatch({
      params: { ...P(), seq: 4 },
      body: { reason: "Buyers approved by mistake", confirm: "CONFIRM" },
    });
    // the buyer that existed before the migration is untouched
    expect((await S.sql("SELECT id FROM dev_contacts WHERE org_id = $1", [orgId])).map((r) => r.id)).toEqual([
      existingBuyer,
    ]);
    const j = await job();
    expect(j.status).toBe("rolled_back");
    expect(j.counts.imported).toBe(5); // project and units remain
    const { entries } = await admin.api.migration.audit({ params: P() });
    expect(entries.filter((e) => e.action === "Batch rolled back").map((e) => e.actorUserId)).toEqual([
      fd.userId,
      fd.userId,
      fd.userId,
      fd.userId,
    ]);
  });

  it("after a rollback the remaining rows go through validation, dry run and approval again", async () => {
    await refused(admin.api.migration.startImport({ params: P() }), 409);
    const v = await admin.api.migration.validate({ params: P() });
    expect(v.blocking).toBe(false);
    const d = await admin.api.migration.dryRun({ params: P() });
    expect(Object.fromEntries(d.byEntity.filter((e) => e.create).map((e) => [e.entity, e.create]))).toEqual({
      buyer: 1,
      contract: 2,
      supplier: 2,
      opening_balance: 2,
    });
    await fd.api.migration.approve({ params: P(), body: { confirm: "CONFIRM" } });
    await admin.api.migration.startImport({ params: P() });
    const j = await settled();
    expect(j.status).toBe("reconciled");
    expect(j.reconciliation!.mismatches).toEqual([]);
    expect(await count("dev_units")).toBe(4);
    expect(await count("dev_suppliers")).toBe(3);
    expect(await count("dev_opening_balances")).toBe(2);
    expect((await migrationJournals()).length).toBe(3); // posted, reversed, posted again
    const tb = await fd.api.ledger.trialBalance({ params: { orgId }, query: { asOf: CUTOVER } });
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.code === "2000")!.creditMinor).toBe(20_000_050);
  });
});

describe("migration worker: a server killed mid-batch is resumed by another", () => {
  let S: TestServer;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    S = await startServer({
      products: [development],
      config: { migration: migrationSettings({ worker: false, batchSize: 2, leaseMs: 1000 }) },
    });
  });
  afterAll(async () => {
    child?.kill("SIGKILL");
    await S.app.core.migration.worker.stop();
    await S.close();
  });

  it("SIGKILL during a batch: no partial records, the lease runs out, the batch is claimed again and finishes", async () => {
    const o = await S.newOrg({ product: "developer", plan: "DEV-PRO" });
    const orgId = o.orgId;
    const fd = await S.addMember(orgId, o.admin.api, "finance_director");
    const jobId = await toApproved(S, orgId, o.admin, fd);
    const P = { orgId, jobId };
    await o.admin.api.migration.startImport({ params: P });
    expect((await o.admin.api.migration.getJob({ params: P })).status).toBe("importing");

    // hold the units table so the other server's unit batch is stuck inside its transaction
    const lock = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
    await lock.connect();
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE dev_units IN ACCESS EXCLUSIVE MODE");
    const script = fileURLToPath(new URL("./support/migration-worker-child.mjs", import.meta.url));
    const proc = spawn(process.execPath, [script, S.app.ctx.config.databaseUrl, TODAY], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child = proc;
    const workerId = await new Promise<string>((resolve) =>
      proc.stdout!.on("data", (b: Buffer) => {
        const m = /worker (\S+)/.exec(b.toString());
        if (m) resolve(m[1]!);
      }),
    );
    const stuck = await waitFor(
      () => S.sql("SELECT seq, status, lease_owner, attempts FROM mig_batches WHERE job_id = $1 AND seq = 2", [jobId]),
      (r) => r[0]?.status === "running",
    );
    expect(stuck[0]).toMatchObject({ lease_owner: workerId, attempts: 1 });
    await waitFor(
      () =>
        S.sql(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO dev_units%'",
        ),
      (r) => r[0].n === 1,
    );
    // the server dies in the middle of the batch
    proc.kill("SIGKILL");
    await new Promise((r) => proc.once("exit", r));
    child = null;
    await lock.query("COMMIT");
    await lock.end();

    const [after] = await S.sql("SELECT status, lease_owner FROM mig_batches WHERE job_id = $1 AND seq = 2", [jobId]);
    expect(after).toEqual({ status: "running", lease_owner: workerId });
    expect((await S.sql("SELECT count(*)::int AS n FROM dev_units WHERE org_id = $1", [orgId]))[0].n).toBe(0);

    // another server starts its worker: once the lease has run out it resumes from batch 2
    S.app.core.migration.worker.start();
    const job = await waitFor(
      () => o.admin.api.migration.getJob({ params: P }),
      (j) => j.status !== "importing",
    );
    expect(job.status).toBe("reconciled");
    expect(job.reconciliation!.ok).toBe(true);
    const b = (await o.admin.api.migration.listBatches({ params: P })).batches;
    expect(b.map((x) => [x.seq, x.status, x.attempts])).toEqual([
      [1, "done", 1],
      [2, "done", 2],
      [3, "done", 1],
      [4, "done", 1],
      [5, "done", 1],
      [6, "done", 1],
      [7, "done", 1],
    ]);
    const units = await S.sql(
      'SELECT source_record_id FROM dev_units WHERE org_id = $1 ORDER BY source_record_id COLLATE "C"',
      [orgId],
    );
    expect(units.map((u) => u.source_record_id)).toEqual(["U-1", "U-2", "U-3", "U-4"]);
    expect(
      (await fd.api.ledger.listJournals({ params: { orgId }, query: {} })).journals.filter(
        (j) => j.source === "system:migration",
      ).length,
    ).toBe(1);
  });
});
