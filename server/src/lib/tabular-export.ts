/** Bounded, dependency-free OOXML and printable table exports. No formulas or remote resources. */
import { crc32, deflateRawSync } from "node:zlib";
export type ReportCell = string | { decimal: string };
// XML 1.0 allows tabs, line breaks and valid Unicode scalar values, not NUL/lone surrogates.
const text = (x: string) =>
  Array.from(x)
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return (
        n === 9 ||
        n === 10 ||
        n === 13 ||
        (n >= 0x20 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff)
      );
    })
    .join("");
export const exportXml = (x: string): string =>
  text(x)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const raw = (v: ReportCell) => (typeof v === "string" ? v : v.decimal);
/** Only server-authored OOXML entry names are accepted; never archives user files. */
function archive(files: Record<string, string>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [key, value] of Object.entries(files)) {
    const name = Buffer.from(key),
      data = Buffer.from(value),
      body = deflateRawSync(data),
      crc = crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(33, 12); // ZIP minimum DOS date: 1980-01-01; deterministic report bytes.
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    local.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22),
    count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
const col = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : col(Math.floor(n / 26) - 1) + col(n % 26));
export function reportXlsx(headers: string[], rows: ReportCell[][]): Buffer {
  if (
    headers.length === 0 ||
    rows.length > 10000 ||
    headers.length > 50 ||
    rows.some((r) => r.length !== headers.length)
  )
    throw new Error("Invalid bounded report dimensions");
  const sheet = [headers, ...rows]
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r
          .map((v, j) => {
            const ref = col(j) + (i + 1),
              s = raw(v);
            // Excel preserves only 15 significant numeric digits. Keep larger exact values as text.
            if (
              typeof v !== "string" &&
              /^(0|[1-9]\d*)(\.\d+)?$/.test(s) &&
              s.replace(/\D/g, "").replace(/^0+/, "").length <= 15
            )
              return `<c r="${ref}" s="${s.includes(".") ? 2 : 3}"><v>${s}</v></c>`;
            return `<c r="${ref}"${i === 0 ? ' s="1"' : ""} t="inlineStr"><is><t xml:space="preserve">${exportXml(s)}</t></is></c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  return archive({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Collections" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF071D3A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${headers.length}" width="24" customWidth="1"/></cols><sheetData>${sheet}</sheetData><autoFilter ref="A1:${col(headers.length - 1)}${rows.length + 1}"/></worksheet>`,
  });
}
export function reportPrint(title: string, subtitle: string, headers: string[], rows: ReportCell[][]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${exportXml(title)}</title><style>body{font:12px system-ui,sans-serif;color:#071d3a;margin:24px}h1{font-size:22px}p{line-height:1.6}table{border-collapse:collapse;width:100%;font-size:10px}td,th{padding:7px;border:1px solid #e2e8f0;text-align:left;overflow-wrap:anywhere}th{background:#f8fafc;white-space:nowrap}button{background:#004d52;color:#fff;border:0;border-radius:6px;padding:10px 16px;font:inherit;cursor:pointer}thead{display:table-header-group}tr{break-inside:avoid}@page{size:A4 landscape;margin:12mm}@media print{.instructions{display:none}body{margin:0}}</style></head><body><h1>${exportXml(title)}</h1><p>${exportXml(subtitle)}</p><p class="instructions">Use your browser’s Print command and choose Save as PDF, or print a paper copy.</p><table><thead><tr>${headers.map((h) => `<th scope="col">${exportXml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${exportXml(raw(c))}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
}
