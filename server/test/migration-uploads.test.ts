// Uploads are hostile until proven otherwise: size limits, SHA-256, magic bytes, ZIP slip, zip bombs, symlinks,
// resumable chunks. Plus the parsers and transforms that turn source text into exact values.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "../dist/core/migration/files/tables.js";
import { convert, parseDate, parseDecimal } from "../dist/core/migration/transforms.js";
import { development } from "../dist/products/development/index.js";
import { csv, migrationSettings, sha256, upload, zip } from "./support/migration-fixtures.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

const MB = 1024 * 1024;

describe("migration uploads refuse anything unsafe", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let viewer: Person;
  let jobId: string;
  const P = () => ({ orgId, jobId });
  const send = (name: string, data: Buffer) => upload(admin.api, orgId, jobId, name, data);

  beforeAll(async () => {
    S = await startServer({
      products: [development],
      config: {
        migration: migrationSettings({
          maxFileBytes: 2 * MB,
          maxJobBytes: 3 * MB,
          zipMaxEntries: 8,
          zipMaxUncompressedBytes: 4 * MB,
        }),
      },
    });
    const o = await S.newOrg({ product: "developer", plan: "DEV-PRO" });
    orgId = o.orgId;
    admin = o.admin;
    viewer = await S.addMember(orgId, admin.api, "viewer");
    jobId = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: { domain: "development", name: "Upload checks", sourceSystem: "legacy", cutoverDate: "2026-09-30" },
      })
    ).id;
  });
  afterAll(() => S.close());

  async function refusedUpload(name: string, data: Buffer, reason: RegExp) {
    const err = await refused(send(name, data), 400, "INVALID_REQUEST");
    expect(err.message).toMatch(reason);
    const { files } = await admin.api.migration.listFiles({ params: P() });
    const f = files.find((x) => x.id === err.details.fileId)!;
    expect([f.status, f.filename]).toEqual(["refused", name]);
    expect(f.refusal).toMatch(reason);
    // a refused file keeps no bytes
    const [row] = await S.sql("SELECT content IS NULL AS empty FROM mig_files WHERE id = $1", [f.id]);
    expect(row.empty).toBe(true);
    return err;
  }

  it("ZIP slip: paths that could escape a folder are refused, whole archive", async () => {
    await refusedUpload(
      "slip.zip",
      zip([
        { name: "ok.csv", data: "a\n1\n" },
        { name: "../../etc/passwd", data: "x" },
      ]),
      /Unsafe path/,
    );
    await refusedUpload("abs.zip", zip([{ name: "/etc/cron.d/x", data: "x" }]), /Unsafe path/);
    await refusedUpload("win.zip", zip([{ name: "..\\..\\boot.ini", data: "x" }]), /Unsafe path/);
    await refusedUpload("link.zip", zip([{ name: "evil", data: "/etc/passwd", mode: 0o120777 }]), /Symbolic link/);
  });

  it("zip bombs: suspicious compression, lying sizes, too much unpacked, too many entries", async () => {
    await refusedUpload("bomb.zip", zip([{ name: "zeros.csv", data: Buffer.alloc(3 * MB) }]), /suspiciously well/);
    await refusedUpload(
      "liar.zip",
      zip([{ name: "small.csv", data: Buffer.alloc(2 * MB, 0x41), declaredSize: 100 }]),
      /unpacks to more than it declares/,
    );
    await refusedUpload(
      "big.zip",
      zip(Array.from({ length: 6 }, (_, i) => ({ name: `part${i}.csv`, data: Buffer.alloc(900 * 1024, 0x41) }))),
      /unpacks to more than 4194304 bytes/,
    );
    await refusedUpload(
      "many.zip",
      zip(Array.from({ length: 9 }, (_, i) => ({ name: `f${i}.csv`, data: "a\n1\n" }))),
      /9 entries; at most 8/,
    );
    // an archive inside the archive is never opened
    const nested = await send(
      "nested.zip",
      zip([{ name: "inner.zip", data: zip([{ name: "a.csv", data: "a\n1\n" }]), stored: true }]),
    );
    expect(nested.extracted.map((f) => [f.filename, f.status, f.refusal])).toEqual([
      ["inner.zip", "refused", "Archives inside the archive are not opened"],
    ]);
  });

  it("wrong magic bytes: the content decides, never the name", async () => {
    const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), Buffer.alloc(64)]);
    await refusedUpload("buyers.csv", exe, /not a type PALTAS accepts/);
    await refusedUpload("photo.png", Buffer.from("%PDF-1.4\n%%EOF\n"), /says it is PNG but its content is PDF/);
    await refusedUpload(
      "sheet.xlsx",
      zip([{ name: "a.txt", data: "hello" }]),
      /says it is XLSX but its content is ZIP/,
    );
    await refusedUpload("data.json", Buffer.from("{ not json"), /not valid JSON/);
    await refusedUpload("scan.pdf", Buffer.from("hello, I am text"), /says it is PDF but contains plain text/);
    await refused(
      admin.api.migration.startUpload({
        params: P(),
        body: { filename: "setup.exe", sizeBytes: 10, sha256: sha256(Buffer.from("x")) },
      }),
      400,
    );
  });

  it("size limits per file and per migration; the SHA-256 must match", async () => {
    await refused(
      admin.api.migration.startUpload({
        params: P(),
        body: { filename: "huge.csv", sizeBytes: 2 * MB + 1, sha256: "0".repeat(64) },
      }),
      400,
    );
    const body = Buffer.from("a\n1\n");
    const start = await admin.api.migration.startUpload({
      params: P(),
      body: { filename: "x.csv", sizeBytes: body.length, sha256: "0".repeat(64) },
    });
    await admin.api.migration.uploadChunk({
      params: { ...P(), fileId: start.file.id, index: 0 },
      body: { dataBase64: body.toString("base64") },
    });
    const err = await refused(admin.api.migration.completeUpload({ params: { ...P(), fileId: start.file.id } }), 400);
    expect(err.message).toMatch(/SHA-256 does not match/);
    // more bytes than announced
    const s2 = await admin.api.migration.startUpload({
      params: P(),
      body: { filename: "y.csv", sizeBytes: 3, sha256: sha256(Buffer.from("abc")) },
    });
    await refused(
      admin.api.migration.uploadChunk({
        params: { ...P(), fileId: s2.file.id, index: 0 },
        body: { dataBase64: Buffer.from("abcdef").toString("base64") },
      }),
      400,
    );
    // the migration's total
    const big = Buffer.from(
      csv([["id", "name"], ...Array.from({ length: 75_000 }, (_, i) => [`P-${i}`, "Project name"])]),
    );
    expect(big.length).toBeGreaterThan(1.4 * MB);
    expect((await send("projects-a.csv", big)).file.status).toBe("stored");
    await refused(
      admin.api.migration.startUpload({
        params: P(),
        body: { filename: "projects-b.csv", sizeBytes: big.length, sha256: sha256(big) },
      }),
      400,
    );
  });

  it("an interrupted upload resumes: missing chunks are named, resending completes it", async () => {
    const data = Buffer.from(csv([["id", "name"], ...Array.from({ length: 20_000 }, (_, i) => [`U-${i}`, "Unit"])]));
    const { file, chunkBytes } = await admin.api.migration.startUpload({
      params: P(),
      body: { filename: "units.csv", sizeBytes: data.length, sha256: sha256(data) },
    });
    expect(data.length).toBeGreaterThan(chunkBytes);
    const chunk = (i: number) =>
      admin.api.migration.uploadChunk({
        params: { ...P(), fileId: file.id, index: i },
        body: { dataBase64: data.subarray(i * chunkBytes, (i + 1) * chunkBytes).toString("base64") },
      });
    await chunk(0);
    const err = await refused(admin.api.migration.completeUpload({ params: { ...P(), fileId: file.id } }), 400);
    expect(err.message).toMatch(/Chunks are missing: received 1 of 2/);
    await chunk(0); // resent: replaced, not doubled
    await chunk(1);
    const done = await admin.api.migration.completeUpload({ params: { ...P(), fileId: file.id } });
    expect([done.file.status, done.file.sizeBytes, done.file.sha256]).toEqual(["stored", data.length, sha256(data)]);
    expect((await S.sql("SELECT count(*)::int AS n FROM mig_upload_chunks WHERE file_id = $1", [file.id]))[0].n).toBe(
      0,
    );
  });

  it("refusals are audited; a viewer cannot upload; another organisation sees nothing", async () => {
    const { entries } = await admin.api.migration.audit({ params: P() });
    expect(entries.filter((e) => e.action === "File refused").length).toBeGreaterThanOrEqual(10);
    await refused(
      viewer.api.migration.startUpload({
        params: P(),
        body: { filename: "a.csv", sizeBytes: 4, sha256: "0".repeat(64) },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const other = await S.newOrg({ product: "developer", plan: "DEV-PRO" });
    await refused(
      other.admin.api.migration.startUpload({
        params: P(),
        body: { filename: "a.csv", sizeBytes: 4, sha256: "0".repeat(64) },
      }),
      404,
    );
    await refused(other.admin.api.migration.listFiles({ params: { orgId: other.orgId, jobId } }), 404);
  });
});

describe("parsing and transforms are exact", () => {
  it("CSV: delimiters, quotes, embedded line breaks, byte-order mark", () => {
    expect(parseCsv('\uFEFFa;b;c\r\n1;"x;y";"say ""hi"""\r\n2;"two\nlines";\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x;y", 'say "hi"'],
      ["2", "two\nlines", ""],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("numbers and money in minor units, never floats", () => {
    const f = { name: "amount", label: "Amount", type: "money" as const };
    const s = { dateFormat: "YYYY-MM-DD" as const, decimalSeparator: "." as const, thousandsSeparator: "," as const };
    expect(convert(f, "1,234,567.89", s, "KES")).toEqual({ ok: true, value: 123_456_789 });
    expect(convert(f, "KES 0.10", s, "KES")).toEqual({ ok: true, value: 10 });
    expect(convert(f, "90071992547409.91", s, "KES")).toEqual({ ok: true, value: 9_007_199_254_740_991 });
    expect(convert(f, "12.345", s, "KES")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/more decimals/),
    });
    expect(convert(f, "USD 10", s, "KES")).toMatchObject({ ok: false, message: expect.stringMatching(/in USD/) });
    expect(convert(f, "(50.00)", s, "KES")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/cannot be negative/),
    });
    expect(convert({ ...f, signed: true }, "(50.00)", s, "KES")).toEqual({ ok: true, value: -5000 });
    expect(convert(f, "1500", s, "UGX")).toEqual({ ok: true, value: 1500 });
    expect(convert(f, "1500.5", s, "UGX")).toMatchObject({ ok: false });
    expect(parseDecimal("1.234.567,8", ",", ".")).toEqual({
      negative: false,
      whole: "1234567",
      fraction: "8",
      currency: null,
    });
  });

  it("dates in the chosen format; impossible dates refused; spreadsheet day numbers understood", () => {
    expect(parseDate("30/09/2026", "DD/MM/YYYY")).toBe("2026-09-30");
    expect(parseDate("09/30/2026", "MM/DD/YYYY")).toBe("2026-09-30");
    expect(parseDate("31/02/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDate("2026-09-30", "DD/MM/YYYY")).toBe("2026-09-30");
    expect(parseDate("46295", "YYYY-MM-DD")).toBe("2026-09-30");
  });

  it("enums map source wording, phones and emails are normalised", () => {
    const s = { dateFormat: "YYYY-MM-DD" as const, decimalSeparator: "." as const, thousandsSeparator: "," as const };
    const e = { name: "status", label: "Status", type: "enum" as const, values: ["in_progress", "done"] };
    expect(convert(e, "In Progress", s, "KES")).toEqual({ ok: true, value: "in_progress" });
    expect(convert(e, "Complete", s, "KES", { complete: "done" })).toEqual({ ok: true, value: "done" });
    expect(convert(e, "Lost", s, "KES")).toMatchObject({ ok: false });
    expect(convert({ name: "p", label: "Phone", type: "phone" }, "+254 (700) 000-001", s, "KES")).toEqual({
      ok: true,
      value: "+254700000001",
    });
    expect(convert({ name: "e", label: "Email", type: "email" }, " A@B.co ", s, "KES")).toEqual({
      ok: true,
      value: "a@b.co",
    });
  });
});
