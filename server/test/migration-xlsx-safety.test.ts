import { describe, it, expect } from "vitest";
import { readTables } from "../dist/core/migration/files/tables.js";
import { zip } from "./support/migration-fixtures.js";
const limits = { maxEntries: 100, maxUncompressedBytes: 10_000_000 };
const inline = (r: string, t: string) => `<c r="${r}" t="inlineStr"><is><t>${t}</t></is></c>`;
function book(rows: string, extra = "", pr = "", styles = "") {
  return zip([
    { name: "xl/workbook.xml", data: `<workbook>${pr}<sheets><sheet name="2021" r:id="r1"/></sheets></workbook>` },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData>${rows}</sheetData>${extra}</worksheet>` },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/sharedStrings.xml", data: "<sst><si><t>Unrelated shared string</t></si></sst>" },
  ]);
}
const read = (buf: Buffer) => readTables("xlsx", "security.xlsx", buf, limits)[0]!;
describe("defensive XLSX structure and cached values", () => {
  it("refuses out-of-range cell references before expanding a sparse array", () => {
    expect(() => read(book(`<row r="1">${inline("XFE1", "Unit")}</row>`))).toThrow(/column limit/);
  });
  it("refuses duplicate cells rather than overwriting a financial value", () => {
    expect(() => read(book(`<row r="1">${inline("A1", "Unit")}${inline("A1", "Amount")}</row>`))).toThrow(/duplicate/);
  });
  it("refuses ambiguous mixed cell rows instead of assigning financial values to the wrong row", () => {
    expect(() => read(book(`<row r="1">${inline("A1", "Unit")}${inline("B2", "Amount")}</row>`))).toThrow(
      /mixes cell row coordinates/,
    );
  });
  it("preserves consistent cell coordinates when a legacy title row container is misnumbered", () => {
    const t = read(
      book(
        `<row r="1">${inline("B2", "Company title")}</row><row r="5">${inline("A5", "Unit")}${inline("B5", "Amount")}</row><row r="6">${inline("A6", "101")}<c r="B6"><v>25</v></c></row>`,
      ),
    );
    expect(t.analysis).toMatchObject({ headerRow: 5, metadataRows: [2] });
    expect(t.sourceRows).toEqual([6]);
    expect(t.analysis!.warnings.join(" ")).toMatch(/Row container 1 points to cells on row 2/);
  });
  it("refuses invalid shared string indices instead of converting them to blanks", () => {
    expect(() => read(book('<row r="1"><c r="A1" t="s"><v>999</v></c></row>'))).toThrow(/shared-text/);
  });
  it("understands sequential cells with omitted optional references", () => {
    const t = read(
      book(
        '<row r="1"><c t="inlineStr"><is><t>Unit</t></is></c><c t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c><v>101</v></c><c><v>25</v></c></row>',
      ),
    );
    expect(t.rows).toEqual([{ Unit: "101", Amount: "25" }]);
    expect(t.sourceRows).toEqual([2]);
  });
  it("caps expanded cells even when a small XML file names distant columns", () => {
    const rows = Array.from(
      { length: 123 },
      (_, i) => `<row r="${i + 1}">${inline("XFD" + (i + 1), "Unit")}</row>`,
    ).join("");
    expect(() => read(book(rows))).toThrow(/2,000,000 cells/);
  });
  it("caps combined expansion across many small worksheets", () => {
    // Rewrite a bounded synthetic workbook's references to the farthest valid column; total sparse expansion is still capped.
    const rawRows = Array.from(
      { length: 100 },
      (_, i) => `<row r="${i + 1}">${inline("XFD" + (i + 1), "Unit")}</row>`,
    ).join("");
    const items = [
      {
        name: "xl/workbook.xml",
        data:
          "<workbook><sheets>" +
          Array.from({ length: 4 }, (_, i) => `<sheet name="${2021 + i}" r:id="r${i}"/>`).join("") +
          "</sheets></workbook>",
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data:
          "<Relationships>" +
          Array.from({ length: 4 }, (_, i) => `<Relationship Id="r${i}" Target="worksheets/sheet${i}.xml"/>`).join("") +
          "</Relationships>",
      },
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `xl/worksheets/sheet${i}.xml`,
        data: `<worksheet><sheetData>${rawRows}</sheetData></worksheet>`,
      })),
    ];
    expect(() => read(zip(items))).toThrow(/workbook expands beyond 5,000,000/);
  });
  it("does not invent results for formulas without cached values", () => {
    expect(() =>
      read(
        book(
          `<row r="1">${inline("A1", "Unit")}${inline("B1", "Amount")}</row><row r="2">${inline("A2", "101")}<c r="B2"><f>SUM(1,2)</f></c></row>`,
        ),
      ),
    ).toThrow(/formulas without saved results/);
  });
  it("retains merged-header ranges and real physical source rows", () => {
    const t = read(
      book(
        `<row r="1">${inline("A1", "Company title")}</row><row r="3">${inline("A3", "Unit")}${inline("B3", "Amount")}</row><row r="4">${inline("A4", "101")}<c r="B4"><v>25</v></c></row>`,
        '<mergeCells><mergeCell ref="A1:C1"/></mergeCells>',
      ),
    );
    expect(t.analysis).toMatchObject({ headerRow: 3, mergedRanges: ["A1:C1"] });
    expect(t.sourceRows).toEqual([4]);
  });
  it("respects workbooks using the 1904 date system", () => {
    const t = read(
      book(
        `<row r="1">${inline("A1", "Unit")}${inline("B1", "Date")}</row><row r="2">${inline("A2", "101")}<c r="B2" s="0"><v>0</v></c></row>`,
        "",
        '<workbookPr date1904="1"/>',
        '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
      ),
    );
    expect(t.rows[0]!.Date).toBe("1904-01-01");
  });
});
