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

function toTable(name: string, grid: string[][]): ParsedTable {
  const first = grid.findIndex((r) => r.some((c) => c.trim()));
  if (first < 0) return { name, headers: [], rows: [] };
  const headers = headerNames(grid[first] ?? []);
  const rows = grid
    .slice(first + 1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { name, headers, rows };
}

// ------------------------------------------------------------------ CSV
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, "");
  const firstLine = t.slice(0, t.search(/\r?\n|$/));
  const count = (d: string) => firstLine.split(d).length - 1;
  const delim = [",", ";", "\t"].reduce((best, d) => (count(d) > count(best) ? d : best), ",");
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
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

export function parseXlsx(buf: Buffer, limits: ZipLimits): ParsedTable[] {
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
  const tables: ParsedTable[] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = xmlText(attr(m[0], "name") ?? "Sheet");
    const target = rels.get(attr(m[0], "r:id") ?? "");
    const xml = target ? files.get(target) : undefined;
    if (!xml) throw new UnreadableFile(`Sheet "${name}" is missing from the spreadsheet`);
    const grid: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1] ?? "";
        const body = c[2] ?? "";
        const t = attr(tag, "t");
        const v = xmlText(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
        let value: string;
        if (t === "s") value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") value = runs(body);
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") value = v;
        else if (v !== "" && dates.has(Number(attr(tag, "s") ?? -1))) value = serialToDate(Number(v));
        else value = v;
        cells[columnIndex(attr(tag, "r") ?? "")] = value;
      }
      grid.push(Array.from(cells, (x) => x ?? ""));
    }
    tables.push(toTable(name, grid));
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

export function readTables(type: "csv" | "xlsx" | "json", filename: string, buf: Buffer, limits: ZipLimits) {
  if (type === "xlsx") return parseXlsx(buf, limits);
  const text = buf.toString("utf8");
  if (type === "json") return parseJson(text, filename);
  return [toTable(filename.replace(/\.(csv|txt)$/i, ""), parseCsv(text))];
}
