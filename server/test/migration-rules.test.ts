// Validation rules, one problem at a time: the engine's (required, formats, ids, conflicts, broken and skipped
// references, duplicates, the plan's allowance, unmapped tables) and the Development domain's (units sold twice,
// schedules, overpayments, allocations, receivables, deposits, opening-balance dates). Each is resolved explicitly.
import type { PaltasClient } from "@paltas/api-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { development } from "../dist/products/development/index.js";
import { csv, migrationSettings, upload } from "./support/migration-fixtures.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

const files: [string, (string | number)[][]][] = [
  [
    "projects.csv",
    [
      ["Project ID", "Project Name"],
      ["P-1", "Ridge One"],
      ["P-2", "Ridge Two"],
    ],
  ],
  [
    "units.csv",
    [
      ["Unit ID", "Project", "Unit Number"],
      ["U-1", "P-1", "101"],
      ["U-2", "P-1", "102"],
      ["U-1", "P-1", "999"],
      ["U-3", "P-9", "103"],
    ],
  ],
  [
    "buyers.csv",
    [
      ["Buyer ID", "Name", "Email"],
      ["B-1", "Ann Mwangi", "ann@example.com"],
      ["B-2", "Ann Mwangi (her twin)", "ann@example.com"],
      ["B-3", "", "b3@example.com"],
      ["B-4", "Bad Email", "not-an-email"],
      ["", "No Id", "noid@example.com"],
    ],
  ],
  [
    "reservations.csv",
    [
      ["Reservation ID", "Unit", "Buyer", "Reservation Date", "Deposit"],
      ["R-1", "U-2", "B-1", "2026-01-01", "100.00"],
    ],
  ],
  [
    "contracts.csv",
    [
      ["Contract ID", "Unit", "Buyer", "Contract Date", "Price"],
      ["K-1", "U-1", "B-1", "2026-01-01", "1000.00"],
      ["K-2", "U-1", "B-2", "2026-02-01", "2000.00"],
      ["K-3", "U-2", "B-1", "2026-03-01", "3000.00"],
      ["K-4", "U-2", "B-1", "2026-03-02", "0"],
    ],
  ],
  [
    "instalments.csv",
    [
      ["Instalment ID", "Contract", "Instalment No", "Due Date", "Amount"],
      ["I-1", "K-1", 1, "2026-01-01", "1000.00"],
      ["I-3a", "K-3", 1, "2026-01-01", "1500.00"],
      ["I-3b", "K-3", 2, "2027-01-01", "1000.00"],
    ],
  ],
  [
    "payments.csv",
    [
      ["Payment ID", "Contract", "Buyer", "Date", "Amount"],
      ["PAY-1", "K-1", "B-1", "2026-01-02", "1200.00"],
      ["PAY-2", "K-3", "B-2", "2026-03-02", "500.00"],
      ["PAY-4", "K-3", "B-1", "2026-03-03", "600.00"],
    ],
  ],
  [
    "allocations.csv",
    [
      ["Allocation ID", "Payment", "Instalment", "Amount"],
      ["A-1", "PAY-1", "I-1", "1100.00"],
      ["A-2", "PAY-4", "I-3a", "700.00"],
    ],
  ],
  [
    "opening balances.csv",
    [
      ["Opening Balance ID", "Kind", "Contract", "Reservation", "As Of", "Amount"],
      ["OB-1", "buyer_receivable", "K-3", "", "2026-09-30", "900.00"],
      ["OB-2", "buyer_deposit", "", "R-1", "2026-08-31", "150.00"],
    ],
  ],
  [
    "notes.csv",
    [
      ["Foo", "Bar"],
      ["x", "y"],
    ],
  ],
];

type ResolveBody = NonNullable<Parameters<PaltasClient["migration"]["resolveRow"]>[0]>["body"];

describe("validation rules and their resolution", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let jobId: string;
  const P = () => ({ orgId, jobId });
  const row = async (entity: string, sourceRecordId: string, n = 0) =>
    (await admin.api.migration.listRows({ params: P(), query: { entity, sourceRecordId } })).rows[n]!;
  const resolve = (rowId: string, body: ResolveBody) =>
    admin.api.migration.resolveRow({ params: { ...P(), rowId }, body });

  beforeAll(async () => {
    S = await startServer({ products: [development], config: { migration: migrationSettings() } });
    // the Standard plan allows one project
    const o = await S.newOrg({ product: "developer", plan: "DEV-STD" });
    orgId = o.orgId;
    admin = o.admin;
    jobId = (
      await admin.api.migration.createJob({
        params: { orgId },
        body: { domain: "development", name: "Rules", sourceSystem: "ridge", cutoverDate: "2026-09-30" },
      })
    ).id;
    for (const [name, rows] of files) await upload(admin.api, orgId, jobId, name, Buffer.from(csv(rows)));
    await admin.api.migration.detect({ params: P() });
  });
  afterAll(() => S.close());

  it("a table that matches no entity must be mapped or ignored before validation", async () => {
    const err = await refused(admin.api.migration.validate({ params: P() }), 409);
    expect(err.message).toMatch(/Map or ignore every table first: notes\.csv/);
    const { tables } = await admin.api.migration.listTables({ params: P() });
    const notes = tables.find((t) => t.name === "notes.csv")!;
    expect(notes.entity).toBeNull();
    const t = await admin.api.migration.mapTable({
      params: { ...P(), tableId: notes.id },
      body: { ignore: true, reason: "Personal notes, not records" },
    });
    expect([t.ignored, t.unmappedColumns]).toEqual([true, []]);
  });

  it("finds every kind of problem, each on the right row", async () => {
    const v = await admin.api.migration.validate({ params: P() });
    expect(v.byCode).toEqual({
      ALLOWANCE_EXCEEDED: 1,
      CONFLICTING_RECORD: 2,
      BROKEN_REFERENCE: 1,
      DUPLICATE: 2,
      REQUIRED: 1,
      INVALID_VALUE: 2,
      MISSING_SOURCE_ID: 1,
      UNIT_SOLD_TWICE: 4,
      SCHEDULE_NOT_EQUAL_PRICE: 1,
      OVERPAID: 1,
      BUYER_MISMATCH: 1,
      OVER_ALLOCATED: 1,
      PAYMENT_OVER_ALLOCATED: 1,
      RECEIVABLE_MISMATCH: 1,
      OPENING_BALANCE_DATE: 1,
      DEPOSIT_EXCEEDS_PAID: 1,
    });
    const issues = (await admin.api.migration.listIssues({ params: P() })).issues;
    const on = (code: string) =>
      issues
        .filter((i) => i.code === code)
        .map((i) => i.sourceRecordId)
        .sort();
    expect(on("CONFLICTING_RECORD")).toEqual(["U-1", "U-1"]);
    expect(on("INVALID_VALUE")).toEqual(["B-4", "K-4"]);
    expect(issues.find((i) => i.sourceRecordId === "K-4" && i.code === "INVALID_VALUE")!.message).toMatch(
      /must be more than zero/,
    );
    expect(on("UNIT_SOLD_TWICE")).toEqual(["K-1", "K-2", "K-3", "K-4"]);
    expect(on("OVERPAID")).toEqual(["K-1"]);
    expect(on("BUYER_MISMATCH")).toEqual(["PAY-2"]);
    expect(on("OVER_ALLOCATED")).toEqual(["A-1"]);
    expect(on("PAYMENT_OVER_ALLOCATED")).toEqual(["A-2"]);
    expect(on("RECEIVABLE_MISMATCH")).toEqual(["OB-1"]);
    expect(issues.find((i) => i.code === "RECEIVABLE_MISMATCH")!.message).toContain("(80000)");
    expect(on("DEPOSIT_EXCEEDS_PAID")).toEqual(["OB-2"]);
    expect(issues.find((i) => i.code === "ALLOWANCE_EXCEEDED")!.message).toMatch(
      /adds 2 project\(s\); your plan allows 1/,
    );
    expect((await admin.api.migration.getJob({ params: P() })).status).toBe("validated");
  });

  it("explicit resolutions clear them; a skipped row is never silently referenced", async () => {
    await resolve((await row("project", "P-2")).id, { action: "skip", reason: "Second phase is not on PALTAS yet" });
    await resolve((await row("unit", "U-1", 1)).id, {
      action: "skip",
      reason: "Old copy of U-1 with the wrong number",
    });
    await resolve((await row("unit", "U-3")).id, { action: "skip", reason: "Belongs to a project we do not migrate" });
    const keep = await resolve((await row("buyer", "B-2")).id, { action: "keep", reason: "Twins sharing one email" });
    expect(keep.validation.byCode.DUPLICATE).toBeUndefined();
    expect(keep.validation.byCode.ALLOWANCE_EXCEEDED).toBeUndefined();
    expect(keep.validation.byCode.CONFLICTING_RECORD).toBeUndefined();
    expect(keep.validation.byCode.BROKEN_REFERENCE).toBeUndefined();
    const fixed = await resolve((await row("buyer", "B-4")).id, {
      action: "correct",
      values: { email: "b4@example.com" },
    });
    expect(fixed.row.status).toBe("valid");
    // skipping a payment that an allocation uses: the allocation is flagged, not dropped
    const skip = await resolve((await row("payment", "PAY-4")).id, { action: "skip", reason: "Bounced cheque" });
    expect(skip.validation.byCode.PAYMENT_OVER_ALLOCATED).toBeUndefined();
    expect(skip.validation.byCode.REFERENCE_SKIPPED).toBe(1);
    const a2 = await row("allocation", "A-2");
    expect(a2.issues.map((i) => i.code)).toEqual(["REFERENCE_SKIPPED"]);
    // undoing a decision brings the problem back
    const undo = await resolve((await row("payment", "PAY-4")).id, { action: "reset" });
    expect(undo.validation.byCode.REFERENCE_SKIPPED).toBeUndefined();
    expect(undo.validation.byCode.PAYMENT_OVER_ALLOCATED).toBe(1);
  });

  it("merges must be into a kept row of the same kind, or an existing record", async () => {
    const b1 = await row("buyer", "B-1");
    const u2 = await row("unit", "U-2");
    const p2 = await row("project", "P-2");
    const p1 = await row("project", "P-1");
    await refused(resolve(b1.id, { action: "merge", intoRowId: u2.id, reason: "Wrong kind of row" }), 400);
    await refused(resolve(p1.id, { action: "merge", intoRowId: p2.id, reason: "Into a skipped row" }), 400);
    await refused(resolve(b1.id, { action: "merge", intoTargetId: "cont_nope", reason: "Not in PALTAS" }), 400);
    await refused(resolve(b1.id, { action: "correct", values: { colour: "blue" } }), 400);
    // still blocked: no dry run while errors remain
    await refused(admin.api.migration.dryRun({ params: P() }), 409);
    // the exception file explains every row that will not be imported
    const ex = (await admin.api.migration.report({ params: P(), query: { kind: "exceptions", format: "csv" } }))
      .content;
    expect(ex).toContain('notes.csv,notes.csv,2,,,skipped,,,,,"Table ignored: Personal notes, not records"');
    expect(ex).toContain("P-2,skipped,,,,skip,Second phase is not on PALTAS yet");
    expect(ex).toMatch(/B-3,error,error,REQUIRED,Name is required/);
  });
});
