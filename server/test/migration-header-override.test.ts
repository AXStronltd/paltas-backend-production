import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, startPropertyServer } from "./support/property-fixture.js";
import { upload, migrationSettings } from "./support/migration-fixtures.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";
describe("header correction is scoped, audited and stages actual Excel row numbers", () => {
  let S: TestServer, admin: Person, orgId: string, jobId: string, tableId: string;
  beforeAll(async () => {
    S = await startPropertyServer();
    const o = await pmOrg(S);
    admin = o.admin;
    orgId = o.orgId;
    jobId = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: { domain: "property", name: "Header review", sourceSystem: "old-export", cutoverDate: "2026-10-01" },
      })
    ).id;
    await upload(
      admin.api,
      orgId,
      jobId,
      "properties.csv",
      Buffer.from("COMPANY LIMITED\nAnnual export\n\nSource ID,Property Name\nP1,Example Court\n\nP2,Second Court"),
    );
    const r = await admin.api.migration.detect({ params: { orgId, jobId } });
    tableId = r.tables[0]!.id;
  });
  afterAll(() => S.close());
  it("detects the true header, persists analysis and source coordinates", async () => {
    const tables = (await admin.api.migration.listTables({ params: { orgId, jobId } })).tables;
    expect(tables[0]!.analysis).toMatchObject({ headerRow: 4 });
    expect(tables[0]!.headers).toEqual(["Source ID", "Property Name"]);
    expect(
      (await S.sql("SELECT row_no FROM mig_rows WHERE table_id=$1 ORDER BY row_no", [tableId])).map((r) => r.row_no),
    ).toEqual([5, 7]);
  });
  it("allows override, clears prior matching and refuses an empty header without losing rows", async () => {
    const p = { orgId, jobId, tableId };
    const r = await admin.api.migration.mapTable({ params: p, body: { headerRow: 4 } });
    expect(r.analysis!.headerRow).toBe(4);
    expect(r.rowCount).toBe(2);
    await refused(admin.api.migration.mapTable({ params: p, body: { headerRow: 3 } }), 400);
    expect(
      (await S.sql("SELECT row_no FROM mig_rows WHERE table_id=$1 ORDER BY row_no", [tableId])).map((r) => r.row_no),
    ).toEqual([5, 7]);
    expect((await S.sql("SELECT count(*)::int n FROM pm_properties WHERE org_id=$1", [orgId]))[0]!.n).toBe(0);
    expect(
      (
        await S.sql("SELECT count(*)::int n FROM audit_log WHERE org_id=$1 AND action='Header row corrected'", [orgId])
      )[0]!.n,
    ).toBe(1);
  });
  it("retains an accepted original file when its table syntax needs correction", async () => {
    const id = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: {
          domain: "property",
          name: "Original retained for audit",
          sourceSystem: "old-export",
          cutoverDate: "2026-10-01",
        },
      })
    ).id;
    const data = Buffer.from('Unit,Amount\n101,"unclosed');
    await upload(admin.api, orgId, id, "needs-correction.csv", data);
    const detected = await admin.api.migration.detect({ params: { orgId, jobId: id } });
    expect(detected.tables).toHaveLength(0);
    const [file] = await S.sql("SELECT status,content,refusal FROM mig_files WHERE job_id=$1", [id]);
    expect(file!.status).toBe("stored");
    expect(file!.refusal).toMatch(/quoted value is never closed/);
    expect(file!.content).toEqual(data);
  });
  it("counts retained structural failures against the upload quota", async () => {
    const test = await startPropertyServer({ migration: migrationSettings({ maxFileBytes: 1024, maxJobBytes: 2048 }) });
    try {
      const o = await test.newOrg({ product: "property", plan: "PM-GROWTH" }),
        p = { orgId: o.orgId };
      const id = (
        await o.admin.api.migration.createJob({
          params: p,
          body: {
            domain: "property",
            name: "Retained source quota",
            sourceSystem: "old-export",
            cutoverDate: "2026-10-01",
          },
        })
      ).id;
      const prefix = 'Unit,Amount\n101,"',
        bad = Buffer.from(prefix + "x".repeat(1024 - prefix.length));
      await upload(o.admin.api, o.orgId, id, "needs-correction.csv", bad);
      await o.admin.api.migration.detect({ params: { ...p, jobId: id } });
      await o.admin.api.migration.startUpload({
        params: { ...p, jobId: id },
        body: { filename: "pending.csv", sizeBytes: 1024, sha256: "f".repeat(64) },
      });
      const e = await refused(
        o.admin.api.migration.startUpload({
          params: { ...p, jobId: id },
          body: { filename: "too-many.csv", sizeBytes: 1, sha256: "e".repeat(64) },
        }),
        400,
      );
      expect(e.message).toMatch(/over|limit|exceed/i);
    } finally {
      await test.close();
    }
  });
  it("refuses cross-company header changes", async () => {
    const other = await pmOrg(S);
    await refused(
      other.admin.api.migration.mapTable({ params: { orgId, jobId, tableId }, body: { headerRow: 4 } }),
      404,
    );
  });
});
