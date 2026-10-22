/*
 * Data files → tables of text cells. CSV (comma, semicolon or tab; quoted fields; a byte-order mark), XLSX (every
 * sheet; shared and inline strings; date-formatted cells become YYYY-MM-DD) and JSON (an array of objects, or an
 * object whose values are arrays of objects — one table per key).
 *
 * Every cell stays text here. Turning text into dates, money and numbers is the mapping's job (transforms.ts), so
 * the person migrating sees and controls every conversion.
 */
import { readZip, type ZipLimits } from "./zip.js";

export interface ParsedTable {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  sourceRows?: number[];
  analysis?: TableAnalysis;
}

export class UnreadableFile extends Error {}

/** Unique, non-empty column names ("Column 3", "Email (2)"). */
function headerNames(cells: string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((c, i) => {
    const base = c.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export interface TableAnalysis {
  sheet: string;
  headerRow: number;
  confidence: number;
  classification: "records" | "annual_matrix" | "unknown";
  year: number | null;
  metadataRows: number[];
  excludedRows: { row: number; reason: "blank" | "repeated_header" | "total" }[];
  warnings: string[];
  mergedRanges?: string[];
  columnNumbers?: number[];
  totals?: { row: number; label: string; values: Record<string, string> }[];
}

const heading = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const MONTH =
  /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;
const HEADER =
  /^(id|name|names|tenant( name)?|owner( name)?|unit( no| number| id)?|apartment( no)?|property( name)?|building|block|date|payment date|description|reference|amount( paid)?|balance|service charge|rent|email|phone|account( code)?|debit|credit|invoice( no| number)?|source record id)$/;

/** Metadata is kept separately; no populated column is truncated. Source rows remain physical file rows. */
function toTable(
  name: string,
  grid: string[][],
  sourceRows = grid.map((_, i) => i + 1),
  headerOverride?: number,
): ParsedTable {
  const nonempty = grid.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c.trim()));
  if (!nonempty.length) return { name, headers: [], rows: [], sourceRows: [] };
  let first = nonempty[0]?.i ?? 0;
  let score = -1;
  for (const { r, i } of nonempty.slice(0, 60)) {
    const values = r.filter((c) => c.trim());
    const known = values.filter((c) => HEADER.test(heading(c)) || MONTH.test(c.trim())).length;
    const text = values.filter((c) => !/^[\d.,() +%-]+$/.test(c)).length;
    const candidate =
      known * 4 + Math.min(values.length, 8) + text / Math.max(1, values.length) - (values.length < 2 ? 10 : 0);
    if (candidate > score) {
      score = candidate;
      first = i;
    }
  }
  // Ordinary exports with unrecognised headings retain the first row; never guess a later data row.
  if (!(grid[first] ?? []).some((c) => HEADER.test(heading(c)) || MONTH.test(c.trim()))) first = nonempty[0]?.i ?? 0;
  if (headerOverride !== undefined) {
    const index = sourceRows.indexOf(headerOverride);
    if (index < 0 || !grid[index]?.some((c) => c.trim()))
      throw new UnreadableFile(`Sheet "${name}": header row ${headerOverride} is empty or does not exist`);
    first = index;
  }
  const width = grid.reduce((n, r) => Math.max(n, r.length), 0);
  const original = Array.from({ length: width }, (_, i) => (grid[first]?.[i] ?? "").trim());
  const populated = original.map((_, col) => col).filter((col) => grid.slice(first).some((r) => (r[col] ?? "").trim()));
  const headers = headerNames(populated.map((col) => original[col] || `Column ${col + 1}`));
  const rows: Record<string, string>[] = [],
    physical: number[] = [];
  const excluded: TableAnalysis["excludedRows"] = [];
  const totals: NonNullable<TableAnalysis["totals"]> = [];
  for (let i = first + 1; i < grid.length; i++) {
    const r = grid[i] ?? [],
      values = populated.map((col) => (r[col] ?? "").trim());
    let reason: "blank" | "repeated_header" | "total" | null = null;
    if (!values.some(Boolean)) reason = "blank";
    else if (values.every((v, j) => heading(v) === heading(original[populated[j] ?? j] ?? "")))
      reason = "repeated_header";
    else if (
      original.filter((c) => MONTH.test(c)).length >= 2 &&
      values.filter(Boolean).some((v) => /^(grand total|sub[ -]?total|total)(\s*[:=-])?$/i.test(v))
    )
      reason = "total";
    if (reason) {
      if (reason === "total")
        totals.push({
          row: sourceRows[i] ?? i + 1,
          label: values.find((v) => /^(grand total|sub[ -]?total|total)(\s*[:=-])?$/i.test(v)) ?? "total",
          values: Object.fromEntries(headers.map((h, j) => [h, values[j] ?? ""])),
        });
      excluded.push({ row: sourceRows[i] ?? i + 1, reason });
      continue;
    }
    rows.push(Object.fromEntries(headers.map((h, j) => [h, values[j] ?? ""])));
    physical.push(sourceRows[i] ?? i + 1);
  }
  const months = original.filter((c) => MONTH.test(c)).length;
  const yearText = [name, ...grid.slice(0, first).flat()].join(" ");
  const years = [...new Set(yearText.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  const unnamed = original.filter((c, i) => !c && populated.includes(i)).length;
  const analysis: TableAnalysis = {
    sheet: name,
    columnNumbers: populated.map((c) => c + 1),
    totals,
    headerRow: sourceRows[first] ?? first + 1,
    confidence: headerOverride
      ? 1
      : Math.min(0.98, 0.45 + original.filter((c) => HEADER.test(heading(c)) || MONTH.test(c)).length * 0.08),
    classification:
      months >= 2 ? "annual_matrix" : original.some((c) => HEADER.test(heading(c))) ? "records" : "unknown",
    year: years.length === 1 ? Number(years[0]) : null,
    metadataRows: sourceRows.slice(0, first),
    excludedRows: excluded,
    warnings: [
      ...(unnamed
        ? [
            `${unnamed} populated column(s) have no heading. Review their sample values; nothing in these columns was discarded.`,
          ]
        : []),
      ...(months >= 2
        ? [
            "Annual monthly report: confirm whether amounts are charges, payments or balances and identify units before financial import. Month headings do not establish transaction dates.",
          ]
        : []),
      ...(excluded.some((r) => r.reason === "total")
        ? ["Total/subtotal rows are retained in the original file for reconciliation, not imported as transactions."]
        : []),
    ],
  };
  return { name, headers, rows, sourceRows: physical, analysis };
}

// ------------------------------------------------------------------ CSV
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, "");
  // Titles may have no delimiter. Score delimiters across the preamble and table, ignoring quoted text.
  const counts = new Map([",", ";", "\t"].map((d) => [d, 0]));
  let quote = false;
  for (let i = 0; i < Math.min(t.length, 64_000); i++) {
    const ch = t[i] ?? "";
    if (ch === '"') {
      if (quote && t[i + 1] === '"') i++;
      else quote = !quote;
    } else if (!quote && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const delim = [",", ";", "\t"].reduce((best, d) => ((counts.get(d) ?? 0) > (counts.get(best) ?? 0) ? d : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === delim) {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (quoted) throw new UnreadableFile("A quoted value is never closed");
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------------ XLSX
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** All text inside <t> elements (rich text has several runs). */
const runs = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1] ?? "")).join("");

/** Built-in number formats that are dates (ECMA-376 18.8.30). */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId"));
    custom.set(id, xmlText(attr(m[0], "formatCode") ?? ""));
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    if (DATE_FORMAT_IDS.has(id) || /[dy]/i.test(code)) out.add(i);
  });
  return out;
}

/** Spreadsheet day number → YYYY-MM-DD (the 1900 date system). */
export function serialToDate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

function columnIndex(ref: string): number {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!match || Number(match[2]) > 1_048_576) throw new UnreadableFile(`Invalid spreadsheet cell reference: ${ref}`);
  const col = [...(match[1] ?? "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  if (col > 16_383) throw new UnreadableFile(`Spreadsheet cell ${ref} exceeds Excel's column limit`);
  return col;
}

export function parseXlsx(buf: Buffer, limits: ZipLimits, overrides: Record<string, number> = {}): ParsedTable[] {
  const files = new Map(readZip(buf, limits).map((e) => [e.name, e.data.toString("utf8")]));
  const workbook = files.get("xl/workbook.xml");
  if (!workbook) throw new UnreadableFile("Not a spreadsheet (no workbook)");
  const rels = new Map(
    [...(files.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\s[^>]*>/g)].map((m) => [
      attr(m[0], "Id") ?? "",
      (attr(m[0], "Target") ?? "").replace(/^\/?(xl\/)?/, "xl/"),
    ]),
  );
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    runs(m[1] ?? ""),
  );
  const dates = dateStyles(files.get("xl/styles.xml"));
  const date1904 = /<workbookPr\b[^>]*date1904="(?:1|true)"/.test(workbook);
  const tables: ParsedTable[] = [];
  let workbookExpandedCells = 0;
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = xmlText(attr(m[0], "name") ?? "Sheet");
    const target = rels.get(attr(m[0], "r:id") ?? "");
    const xml = target ? files.get(target) : undefined;
    if (!xml) throw new UnreadableFile(`Sheet "${name}" is missing from the spreadsheet`);
    const grid: string[][] = [];
    const sourceRows: number[] = [];
    let expandedCells = 0;
    const rowWarnings: string[] = [];
    let rowAdjustmentCount = 0;
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [],
        seenColumns = new Set<number>();
      let previousColumn = -1;
      const rowTag = r[0].slice(0, r[0].indexOf(">") + 1),
        rowAttr = attr(rowTag, "r");
      const referencedRows = [
        ...new Set([...(r[1] ?? "").matchAll(/<c\b[^>]*\sr="[A-Z]+([1-9][0-9]*)"/g)].map((m) => Number(m[1]))),
      ];
      if (referencedRows.length > 1)
        throw new UnreadableFile(
          `Sheet "${name}" mixes cell row coordinates inside one row. Correct the workbook before importing`,
        );
      const physicalRow = referencedRows[0] ?? Number(rowAttr ?? (sourceRows.at(-1) ?? 0) + 1);
      if (
        !Number.isInteger(physicalRow) ||
        physicalRow < 1 ||
        physicalRow > 1_048_576 ||
        physicalRow <= (sourceRows.at(-1) ?? 0)
      )
        throw new UnreadableFile(`Sheet "${name}" has an invalid or repeated row number`);
      if (rowAttr !== undefined && Number(rowAttr) !== physicalRow) {
        rowAdjustmentCount++;
        if (rowWarnings.length < 10)
          rowWarnings.push(
            `Row container ${rowAttr} points to cells on row ${physicalRow}. Original cell coordinates were retained; review this legacy formatting inconsistency.`,
          );
      }
      for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1] ?? "";
        const body = c[2] ?? "";
        const reference = attr(tag, "r"),
          col = reference ? columnIndex(reference) : previousColumn + 1;
        if (col > 16_383 || seenColumns.has(col))
          throw new UnreadableFile(`Sheet "${name}", row ${physicalRow}: duplicate or invalid cell column`);
        if (reference && Number(/[0-9]+$/.exec(reference)?.[0]) !== physicalRow)
          throw new UnreadableFile(`Sheet "${name}": cell ${reference} does not belong to row ${physicalRow}`);
        seenColumns.add(col);
        previousColumn = Math.max(previousColumn, col);
        const t = attr(tag, "t");
        const v = xmlText(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
        let value: string;
        if (t === "s") {
          if (v !== "" && (!/^\d+$/.test(v) || Number(v) >= shared.length))
            throw new UnreadableFile(`Sheet "${name}", row ${physicalRow}: invalid shared-text reference`);
          value = v === "" ? "" : (shared[Number(v)] ?? "");
        } else if (t === "inlineStr") value = runs(body);
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") value = v;
        else if (v !== "" && dates.has(Number(attr(tag, "s") ?? -1)))
          value = serialToDate(Number(v) + (date1904 ? 1462 : 0));
        else value = v;
        cells[col] = value;
      }
      expandedCells += Math.max(cells.length, 1);
      workbookExpandedCells += Math.max(cells.length, 1);
      if (workbookExpandedCells > 5_000_000)
        throw new UnreadableFile(
          "The workbook expands beyond 5,000,000 cells. Split the financial years into smaller files before importing",
        );
      if (expandedCells > 2_000_000)
        throw new UnreadableFile(
          `Sheet "${name}" expands beyond 2,000,000 cells. Split it into smaller worksheets before importing`,
        );
      sourceRows.push(physicalRow);
      grid.push(Array.from(cells, (x) => x ?? ""));
    }
    const table = toTable(name, grid, sourceRows, overrides[name]);
    if (table.analysis) {
      table.analysis.warnings.push(...rowWarnings);
      if (rowAdjustmentCount > 10)
        table.analysis.warnings.push(
          `${rowAdjustmentCount} row containers needed original cell coordinates; first 10 are listed above.`,
        );
      table.analysis.mergedRanges = [...xml.matchAll(/<mergeCell\s[^>]*ref="([A-Z]+\d+:[A-Z]+\d+)"[^>]*\/?>/g)].map(
        (m) => m[1] ?? "",
      );
      if (table.analysis.mergedRanges.length)
        table.analysis.warnings.push(
          "Merged cells detected. Original merge ranges are retained; review multi-row headings before confirming mappings. Data cells are not filled from neighbouring values.",
        );
      const uncached = [...xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].some(
        (m) => /<f\b/.test(m[1] ?? "") && !/<v>[^<]+<\/v>/.test(m[1] ?? ""),
      );
      if (uncached)
        throw new UnreadableFile(
          `Sheet "${name}" has formulas without saved results. Recalculate and save the workbook before importing; PALTAS does not invent formula values.`,
        );
    }
    tables.push(table);
  }
  return tables;
}

// ------------------------------------------------------------------ JSON
const cell = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

function objectsTable(name: string, items: unknown[]): ParsedTable | null {
  if (!items.length || !items.every((x) => x && typeof x === "object" && !Array.isArray(x))) return null;
  const headers = [...new Set(items.flatMap((x) => Object.keys(x as object)))];
  return {
    name,
    headers,
    rows: items.map((x) => Object.fromEntries(headers.map((h) => [h, cell((x as Record<string, unknown>)[h]).trim()]))),
  };
}

export function parseJson(text: string, filename: string): ParsedTable[] {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (Array.isArray(data)) {
    const t = objectsTable(filename.replace(/\.json$/i, ""), data);
    if (!t) throw new UnreadableFile("The JSON array must hold objects (one per record)");
    return [t];
  }
  if (data && typeof data === "object") {
    const tables = Object.entries(data)
      .map(([k, v]) => (Array.isArray(v) ? objectsTable(k, v) : null))
      .filter((t): t is ParsedTable => !!t);
    if (tables.length) return tables;
  }
  throw new UnreadableFile("The JSON must be an array of records, or an object of named record arrays");
}

export function readTables(
  type: "csv" | "xlsx" | "json",
  filename: string,
  buf: Buffer,
  limits: ZipLimits,
  overrides: Record<string, number> = {},
) {
  if (type === "xlsx") return parseXlsx(buf, limits, overrides);
  const text = buf.toString("utf8");
  if (type === "json") return parseJson(text, filename);
  return [
    toTable(
      filename.replace(/\.(csv|txt)$/i, ""),
      parseCsv(text),
      undefined,
      overrides[filename.replace(/\.(csv|txt)$/i, "")],
    ),
  ];
}
