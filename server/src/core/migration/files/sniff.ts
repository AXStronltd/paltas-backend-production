/*
 * What a file really is, from its first bytes ("magic bytes") — never from its name alone. A file whose name
 * says one thing and whose content says another is refused, so an executable renamed "buyers.csv" never gets in.
 */
import { readZip, ZipRefused, type ZipLimits } from "./zip.js";

export type FileType = "csv" | "xlsx" | "json" | "zip" | "pdf" | "png" | "jpeg" | "gif" | "webp" | "tiff";

/** Data files are read into tables; the others become document records. */
export const DATA_TYPES: readonly FileType[] = ["csv", "xlsx", "json"];
export const DOCUMENT_TYPES: readonly FileType[] = ["pdf", "png", "jpeg", "gif", "webp", "tiff"];

const BY_EXTENSION: Record<string, FileType> = {
  csv: "csv",
  txt: "csv",
  xlsx: "xlsx",
  json: "json",
  zip: "zip",
  pdf: "pdf",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  tif: "tiff",
  tiff: "tiff",
};

export function extensionType(filename: string): FileType | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? null;
}

const starts = (b: Buffer, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);

/** The binary type from the magic bytes, or null (then it may be text). */
function binaryType(b: Buffer): FileType | "zip-container" | null {
  if (starts(b, [0x50, 0x4b, 0x03, 0x04]) || starts(b, [0x50, 0x4b, 0x05, 0x06])) return "zip-container";
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")
    return "gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (starts(b, [0x49, 0x49, 0x2a, 0x00]) || starts(b, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  return null;
}

function utf8Text(b: Buffer): string | null {
  if (b.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

export type Sniffed = { ok: true; type: FileType } | { ok: false; reason: string };

/**
 * Decide the type of an upload. `limits` are the ZIP limits (used to look inside a ZIP to tell an .xlsx apart).
 * Corrupt documents (a .pdf that is not a PDF) are refused here too.
 */
export function sniff(filename: string, b: Buffer, limits: ZipLimits): Sniffed {
  const claimed = extensionType(filename);
  if (!claimed) return { ok: false, reason: `Files of this type are not accepted (${filename})` };
  if (!b.length) return { ok: false, reason: "The file is empty" };
  const bin = binaryType(b);
  let actual: FileType;
  if (bin === "zip-container") {
    if (claimed === "xlsx") {
      try {
        const names = new Set(readZip(b, limits).map((e) => e.name));
        actual = names.has("xl/workbook.xml") && names.has("[Content_Types].xml") ? "xlsx" : "zip";
      } catch (e) {
        if (e instanceof ZipRefused) return { ok: false, reason: `Not a readable spreadsheet: ${e.message}` };
        throw e;
      }
    } else actual = "zip";
  } else if (bin) actual = bin;
  else {
    const text = utf8Text(b);
    if (text === null) return { ok: false, reason: `The content of ${filename} is not a type PALTAS accepts` };
    if (claimed === "json") {
      try {
        JSON.parse(text.replace(/^\uFEFF/, ""));
        actual = "json";
      } catch {
        return { ok: false, reason: `${filename} is not valid JSON` };
      }
    } else if (claimed === "csv") actual = "csv";
    else return { ok: false, reason: `${filename} says it is ${claimed.toUpperCase()} but contains plain text` };
  }
  if (actual !== claimed) {
    return {
      ok: false,
      reason: `${filename} says it is ${claimed.toUpperCase()} but its content is ${actual.toUpperCase()}`,
    };
  }
  return { ok: true, type: actual };
}
