import { describe, it, expect } from "vitest";
import { readTables } from "../dist/core/migration/files/tables.js";
import { xlsx } from "./support/migration-fixtures.js";
const limits = { maxEntries: 100, maxUncompressedBytes: 10_000_000 };
const csv = (s: string, override?: number) =>
  readTables("csv", "report.csv", Buffer.from(s), limits, override ? { report: override } : {})[0]!;
describe("spreadsheet structure detection and source coordinates", () => {
  it("recognises annual reports after title rows without inventing financial meaning", () => {
    const sheets = [
      {
        name: "2021",
        rows: [
          ["AL-MAS TOWERS LIMITED"],
          ["SERVICE CHARGES"],
          [],
          ["NAMES", "April", "May", "JUNE"],
          ["Example resident", 100, 0, 200],
          ["TOTAL", 100, 0, 200],
        ],
      },
      {
        name: "2022",
        rows: [
          ["AL-MAS TOWERS LIMITED"],
          ["SERVICE CHARGES"],
          [],
          ["NAMES", "Jan", "Feb", "March", "April"],
          ["Example resident", 0, 200, 100, 300],
        ],
      },
    ];
    const ts = readTables("xlsx", "Services Charge - 1.xlsx", xlsx(sheets), limits);
    expect(ts.map((t) => t.headers)).toEqual([
      ["NAMES", "April", "May", "JUNE"],
      ["NAMES", "Jan", "Feb", "March", "April"],
    ]);
    expect(ts[0]!.analysis).toMatchObject({
      headerRow: 4,
      classification: "annual_matrix",
      year: 2021,
      excludedRows: [{ row: 6, reason: "total" }],
    });
    expect(ts[0]!.rows[0]!.May).toBe("0");
    expect(ts[0]!.sourceRows).toEqual([5]);
  });
  it("recognises tab and semicolon tables below delimiter-free titles", () => {
    expect(csv("COMPANY LIMITED\nReport\nUnit;Amount\n101;10").headers).toEqual(["Unit", "Amount"]);
    expect(csv("COMPANY LIMITED\nReport\nUnit\tAmount\n101\t10").headers).toEqual(["Unit", "Amount"]);
  });
  it("keeps populated unheaded and wider data columns", () => {
    const t = csv("Company report\n\nUnit No,Tenant Name\n804 E,Example,,123\n");
    expect(t.headers).toEqual(["Unit No", "Tenant Name", "Column 4"]);
    expect(t.rows[0]!["Column 4"]).toBe("123");
    expect(t.sourceRows).toEqual([4]);
  });
  it("reports blank, repeated and total row dispositions without importing them", () => {
    const t = csv("Unit,Amount\n101,10\n\nUnit,Amount\n102,20\nGrand total,30");
    expect(t.rows).toHaveLength(3);
    expect(t.sourceRows).toEqual([2, 5, 6]);
    expect(t.analysis!.excludedRows).toEqual([
      { row: 3, reason: "blank" },
      { row: 4, reason: "repeated_header" },
    ]);
  });
  it("allows explicit physical header overrides", () => {
    const t = csv("Report\nUnit,Amount\n101,10\nOther,Value\n201,20", 4);
    expect(t.headers).toEqual(["Other", "Value"]);
    expect(t.sourceRows).toEqual([5]);
    expect(t.analysis!.headerRow).toBe(4);
    expect(() => csv("Report\n\nUnit,Amount", 2)).toThrow(/empty/);
  });
  it("preserves unrecognised exports and duplicate headings", () => {
    expect(csv("Alpha,Alpha\nx,y").headers).toEqual(["Alpha", "Alpha (2)"]);
  });
  it("does not treat a resident called Total Smith as a subtotal", () => {
    const t = csv("Tenant Name,Amount\nTotal Smith,10\nSubtotal Jones,20");
    expect(t.rows).toHaveLength(2);
  });
  it("reads a large export without losing row provenance", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `${i + 1},Resident ${i + 1},${i}`);
    const t = csv("COMPANY LIMITED\nExport\nUnit,Tenant Name,Amount\n" + rows.join("\n"));
    expect(t.rows).toHaveLength(10_000);
    expect(t.sourceRows?.at(-1)).toBe(10_003);
    expect(t.rows.at(-1)?.Amount).toBe("9999");
  });
  it("never discards a zero or assumes a blank means zero", () => {
    const t = csv("Unit,Amount\n101,0\n102,");
    expect(t.rows.map((r) => r.Amount)).toEqual(["0", ""]);
  });
});

import { guessEntity } from "../dist/core/migration/detect.js";
import { propertyMigration } from "../dist/products/property/migration-domain.js";
import { ProfileConfig } from "@paltas/contracts";
describe("confirmed matching templates", () => {
  it("reuses only exact compatible headings and valid target fields", () => {
    const profile = ProfileConfig.parse({
      templates: [
        {
          headers: ["LegacyKey", "EstateLabel"],
          entity: "property",
          columns: [
            { source: "LegacyKey", field: "source_record_id" },
            { source: "EstateLabel", field: "name" },
          ],
        },
      ],
    });
    expect(guessEntity(propertyMigration, "Export", "export.csv", ["LegacyKey", "EstateLabel"], profile)).toMatchObject(
      { entity: "property", confidence: 1 },
    );
    expect(
      guessEntity(propertyMigration, "Export", "export.csv", ["LegacyKey", "DifferentLabel"], profile).confidence,
    ).not.toBe(1);
    const invalid = ProfileConfig.parse({
      templates: [
        { headers: ["LegacyKey"], entity: "property", columns: [{ source: "LegacyKey", field: "not_a_field" }] },
      ],
    });
    expect(guessEntity(propertyMigration, "Export", "export.csv", ["LegacyKey"], invalid).confidence).not.toBe(1);
  });
});
