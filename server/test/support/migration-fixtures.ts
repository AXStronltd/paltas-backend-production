/*
 * Test fixtures for data migration: a tiny ZIP writer (Node's zlib only), an XLSX writer built on it, an upload
 * helper that uses the real chunked upload API, and a realistic multi-file export of a property developer
 * (CSV + XLSX + JSON + a ZIP of documents and site records) whose totals are known exactly.
 */
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import type { PaltasClient } from "@paltas/api-client";
import { loadConfig, type MigrationSettings } from "../../dist/config.js";

export interface ZipItem {
  name: string;
  data: Buffer | string;
  /** store without compression */
  stored?: boolean;
  /** lie in the headers (zip-bomb tests) */
  declaredSize?: number;
  /** unix mode in the external attributes (symlink tests) */
  mode?: number;
}

export function zip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const it of items) {
    const raw = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data, "utf8");
    const body = it.stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(it.name, "utf8");
    const size = it.declaredSize ?? raw.length;
    const crc = crc32(raw) >>> 0;
    const method = it.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((it.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export type Cell = string | number | { date: string } | null;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : col(Math.floor(i / 26) - 1) + col(i % 26));
const serial = (iso: string) => (Date.parse(iso + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86_400_000;

/** A real .xlsx: shared strings for text, numbers, and date-formatted day numbers for { date }. */
export function xlsx(sheets: { name: string; rows: Cell[][] }[]): Buffer {
  const shared: string[] = [];
  const si = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetXml = (rows: Cell[][]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((c, ci) => {
              const ref = `${col(ci)}${ri + 1}`;
              if (c === null || c === "") return "";
              if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
              if (typeof c === "object") return `<c r="${ref}" s="1"><v>${serial(c.date)}</v></c>`;
              return `<c r="${ref}" t="s"><v>${si(c)}</v></c>`;
            })
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`;
  const sheetFiles = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }));
  return zip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml" Type="worksheet"/>`)
        .join("")}</Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    ...sheetFiles,
    // written last: every string is known once the sheets are built
    {
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
        .map((s) => `<si><t>${esc(s)}</t></si>`)
        .join("")}</sst>`,
    },
  ]);
}

export const csv = (rows: (string | number)[][], delimiter = ",") =>
  rows
    .map((r) =>
      r
        .map((c) => {
          const s = String(c);
          return s.includes(delimiter) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(delimiter),
    )
    .join("\r\n") + "\r\n";

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Migration settings with test-friendly worker timings. */
export function migrationSettings(o: Partial<MigrationSettings> = {}): MigrationSettings {
  const base = loadConfig({ DATABASE_URL: "postgres://unused/unused" }).migration;
  return { ...base, workerPollMs: 50, leaseMs: 1000, ...o };
}

/** Upload through the real API: announce, send the chunks, complete. */
export async function upload(api: PaltasClient, orgId: string, jobId: string, filename: string, data: Buffer) {
  const { file, chunkBytes } = await api.migration.startUpload({
    params: { orgId, jobId },
    body: { filename, sizeBytes: data.length, sha256: sha256(data) },
  });
  for (let i = 0; i * chunkBytes < data.length; i++) {
    await api.migration.uploadChunk({
      params: { orgId, jobId, fileId: file.id, index: i },
      body: { dataBase64: data.subarray(i * chunkBytes, (i + 1) * chunkBytes).toString("base64") },
    });
  }
  return api.migration.completeUpload({ params: { orgId, jobId, fileId: file.id } });
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting; last value: ${JSON.stringify(v).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const PDF = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

/**
 * Mto Developers' export from their previous systems (cut-over 2026-09-30, KES):
 * 2 projects, 2 phases, 2 blocks, 3 floors, 5 units (+1 exact duplicate row), 4 buyers (B-004 duplicates B-001),
 * 4 reservations, 3 contracts (CTR-003's balance is wrong in the source), 1 amendment, 8 instalments,
 * 8 payments (PAY-008 points to a contract that does not exist), 6 allocations, 5 opening balances,
 * 2 suppliers, 2 contractors, 2 purchase orders, 1 work order, and in the ZIP: site records (milestones,
 * handovers, defects, disputes, correspondence, investors), a documents manifest and 7 documents.
 */
export function developmentExport() {
  const projects = csv([
    ["Project ID", "Project Name", "Code", "Location", "Status", "Start Date", "Completion Date"],
    ["P-001", "Mto Heights", "MTH", "Kilimani, Nairobi", "selling", "2025-01-15", "2027-06-30"],
    ["P-002", "Mto Gardens", "MTG", "Karen, Nairobi", "construction", "2025-06-01", "2028-03-31"],
  ]);
  const inventory = xlsx([
    {
      name: "Phases",
      rows: [
        ["Phase ID", "Project", "Phase Name", "Start Date", "End Date"],
        ["PH-1", "P-001", "Phase 1", { date: "2025-01-15" }, { date: "2026-12-31" }],
        ["PH-2", "P-002", "Phase 1", { date: "2025-06-01" }, null],
      ],
    },
    {
      name: "Blocks",
      rows: [
        ["Building ID", "Project", "Phase", "Building Name", "Floors"],
        ["BL-A", "P-001", "PH-1", "Block A", 3],
        ["BL-B", "P-002", "PH-2", "Block B", 2],
      ],
    },
    {
      name: "Floors",
      rows: [
        ["Floor ID", "Building", "Level", "Name"],
        ["F-A1", "BL-A", 1, "First floor"],
        ["F-A2", "BL-A", 2, "Second floor"],
        ["F-B1", "BL-B", 1, "First floor"],
      ],
    },
    {
      name: "Units",
      rows: [
        ["Unit ID", "Project", "Building", "Floor", "Unit Number", "Type", "Bedrooms", "Area", "List Price", "Status"],
        ["U-A101", "P-001", "BL-A", "F-A1", "A101", "2BR", 2, 85.5, 12500000, "sold"],
        ["U-A102", "P-001", "BL-A", "F-A1", "A102", "3BR", 3, 110, 15000000, "sold"],
        ["U-A201", "P-001", "BL-A", "F-A2", "A201", "2BR", 2, 85.5, 12800000, "reserved"],
        ["U-B101", "P-002", "BL-B", "F-B1", "B101", "1BR", 1, 55, 8000000, "sold"],
        ["U-B102", "P-002", "BL-B", "F-B1", "B102", "1BR", 1, 55, 8000000, "available"],
        ["U-B102", "P-002", "BL-B", "F-B1", "B102", "1BR", 1, 55, 8000000, "available"],
      ],
    },
  ]);
  const buyers = csv([
    ["Contact ID", "Full Name", "Email Address", "Mobile Phone", "ID/Passport", "Type"],
    ["B-001", "Amina Hassan", "amina@example.com", "+254700000001", "12345678", "Person"],
    ["B-002", "Brian Otieno", "brian@example.com", "+254700000002", "23456789", "Person"],
    ["B-003", "Chebet Holdings Ltd", "accounts@chebet.example.com", "+254700000003", "C-998877", "Organisation"],
    ["B-004", "Amina Hassan", "AMINA@example.com", "+254 700 000 001", "12345678", "Person"],
  ]);
  const sales = xlsx([
    {
      name: "Reservations",
      rows: [
        ["Reservation ID", "Unit", "Buyer", "Reservation Date", "Deposit", "Expiry", "Status"],
        ["R-001", "U-A101", "B-001", { date: "2025-03-01" }, "500,000.00", { date: "2025-04-01" }, "converted"],
        ["R-002", "U-A102", "B-002", { date: "2025-04-10" }, "500,000.00", { date: "2025-05-10" }, "converted"],
        ["R-003", "U-A201", "B-004", { date: "2026-09-01" }, "300,000.00", { date: "2026-10-15" }, "active"],
        ["R-004", "U-B101", "B-003", { date: "2025-08-01" }, "200,000.00", { date: "2025-09-01" }, "converted"],
      ],
    },
    {
      name: "Contracts",
      rows: [
        ["Contract ID", "Unit", "Buyer", "Reservation", "Contract No", "Contract Date", "Price", "Balance", "Status"],
        ["CTR-001", "U-A101", "B-001", "R-001", "SA-1001", { date: "2025-03-15" }, 12500000, 5000000, "active"],
        ["CTR-002", "U-A102", "B-002", "R-002", "SA-1002", { date: "2025-04-20" }, 15000000, 8100000, "active"],
        ["CTR-003", "U-B101", "B-003", "R-004", "SA-1003", { date: "2025-08-15" }, 8000000, 5100000, "active"],
      ],
    },
    {
      name: "Amendments",
      rows: [
        ["Amendment ID", "Contract", "Date", "Description", "Price Change"],
        ["AM-1", "CTR-002", { date: "2025-06-01" }, "Upgraded finishes", 500000],
      ],
    },
    {
      name: "Instalments",
      rows: [
        ["Instalment ID", "Contract", "Instalment No", "Due Date", "Amount", "Description"],
        ["I-001-1", "CTR-001", 1, { date: "2025-03-15" }, 2500000, "Deposit"],
        ["I-001-2", "CTR-001", 2, { date: "2025-09-15" }, 5000000, "Structure"],
        ["I-001-3", "CTR-001", 3, { date: "2026-09-15" }, 5000000, "Completion"],
        ["I-002-1", "CTR-002", 1, { date: "2025-04-20" }, 3500000, "Deposit"],
        ["I-002-2", "CTR-002", 2, { date: "2026-06-30" }, 6000000, "Structure"],
        ["I-002-3", "CTR-002", 3, { date: "2027-03-31" }, 6000000, "Completion"],
        ["I-003-1", "CTR-003", 1, { date: "2025-08-15" }, 2000000, "Deposit"],
        ["I-003-2", "CTR-003", 2, { date: "2026-08-15" }, 6000000, "Completion"],
      ],
    },
  ]);
  const receipts = JSON.stringify({
    payments: [
      {
        id: "PAY-001",
        contract: "CTR-001",
        buyer: "B-001",
        kind: "receipt",
        date: "2025-03-15",
        amount: "2500000.00",
        method: "bank",
        reference: "RC-9001",
      },
      {
        id: "PAY-002",
        contract: "CTR-001",
        buyer: "B-001",
        kind: "receipt",
        date: "2025-09-20",
        amount: "5000000.00",
        method: "bank",
        reference: "RC-9002",
      },
      {
        id: "PAY-003",
        contract: "CTR-002",
        buyer: "B-002",
        kind: "receipt",
        date: "2025-04-20",
        amount: "3500000.00",
        method: "mpesa",
        reference: "RC-9003",
      },
      {
        id: "PAY-004",
        contract: "CTR-002",
        buyer: "B-002",
        kind: "receipt",
        date: "2026-07-05",
        amount: "4000000.00",
        method: "bank",
        reference: "RC-9004",
      },
      {
        id: "PAY-005",
        contract: "CTR-003",
        buyer: "B-003",
        kind: "receipt",
        date: "2025-08-15",
        amount: "2000000.00",
        method: "bank",
        reference: "RC-9005",
      },
      {
        id: "PAY-006",
        contract: "CTR-003",
        buyer: "B-003",
        kind: "receipt",
        date: "2026-08-20",
        amount: "1000000.00",
        method: "bank",
        reference: "RC-9006",
      },
      {
        id: "PAY-007",
        contract: "CTR-002",
        buyer: "B-002",
        kind: "refund",
        date: "2026-07-10",
        amount: "100000.00",
        method: "bank",
        reference: "RF-0001",
      },
      {
        id: "PAY-008",
        contract: "CTR-999",
        buyer: "B-002",
        kind: "receipt",
        date: "2026-07-11",
        amount: "75000.00",
        method: "cash",
        reference: "RC-9999",
      },
    ],
    allocations: [
      { id: "AL-1", payment: "PAY-001", instalment: "I-001-1", amount: "2500000.00" },
      { id: "AL-2", payment: "PAY-002", instalment: "I-001-2", amount: "5000000.00" },
      { id: "AL-3", payment: "PAY-003", instalment: "I-002-1", amount: "3500000.00" },
      { id: "AL-4", payment: "PAY-004", instalment: "I-002-2", amount: "4000000.00" },
      { id: "AL-5", payment: "PAY-005", instalment: "I-003-1", amount: "2000000.00" },
      { id: "AL-6", payment: "PAY-006", instalment: "I-003-2", amount: "1000000.00" },
    ],
  });
  // day-first dates and decimal commas, separated by semicolons: needs its own column transforms
  const openingBalances = csv(
    [
      ["Ref", "Type", "Contract", "Reservation", "Supplier", "Balance date", "Amount", "Note"],
      ["OB-1", "buyer_receivable", "CTR-001", "", "", "30/09/2026", "5.000.000,00", "I-001-3 unpaid"],
      ["OB-2", "buyer_receivable", "CTR-002", "", "", "30/09/2026", "2.000.000,00", "I-002-2 part unpaid"],
      ["OB-3", "buyer_receivable", "CTR-003", "", "", "30/09/2026", "5.000.000,00", "I-003-2 part unpaid"],
      ["OB-4", "buyer_deposit", "", "R-003", "", "30/09/2026", "300.000,00", "Deposit on A201"],
      ["OB-5", "supplier_payable", "", "", "S-001", "30/09/2026", "450.000,00", "Cement, August"],
    ],
    ";",
  );
  const procurement = xlsx([
    {
      name: "Suppliers",
      rows: [
        ["Supplier ID", "Name", "Tax ID", "Email", "Phone", "Category"],
        ["S-001", "Kenya Cement Supplies", "P051234567X", "sales@kcs.example.com", "+254711000001", "Cement"],
        ["S-002", "Nairobi Steel", "P059876543Y", "orders@nsteel.example.com", "+254711000002", "Steel"],
      ],
    },
    {
      name: "Contractors",
      rows: [
        ["Contractor ID", "Name", "Tax ID", "Email", "Phone", "Trade"],
        ["C-001", "Mjengo Builders", "P051111111A", "site@mjengo.example.com", "+254722000001", "Civil works"],
        ["C-002", "Bright Electric", "P052222222B", "ops@bright.example.com", "+254722000002", "Electrical"],
      ],
    },
    {
      name: "Purchase Orders",
      rows: [
        ["PO ID", "Supplier", "Project", "PO Number", "Date", "Amount", "Status", "Description"],
        ["PO-1", "S-001", "P-001", "PO-501", { date: "2026-08-01" }, 450000, "open", "Cement, 900 bags"],
        ["PO-2", "S-002", "P-002", "PO-502", { date: "2026-08-15" }, 1200000, "received", "Rebar"],
      ],
    },
    {
      name: "Work Orders",
      rows: [
        ["Work Order ID", "Contractor", "Project", "Unit", "Number", "Date", "Amount", "Description", "Status"],
        ["WO-1", "C-001", "P-001", "U-A101", "WO-77", { date: "2026-07-01" }, 250000, "Kitchen snag fixes", "done"],
      ],
    },
  ]);
  const site = {
    milestones: csv([
      ["Milestone ID", "Project", "Phase", "Milestone", "Due Date", "Completed", "Progress", "Status"],
      ["M-1", "P-001", "PH-1", "Structure complete", "2025-12-31", "2025-12-20", "100", "completed"],
      ["M-2", "P-002", "PH-2", "Foundations", "2026-10-31", "", "60", "in_progress"],
    ]),
    handovers: csv([
      ["Handover ID", "Unit", "Contract", "Handover Date", "Status", "Notes"],
      ["HO-001", "U-A101", "CTR-001", "2026-09-20", "completed", "Keys handed over"],
    ]),
    defects: csv([
      ["Defect ID", "Unit", "Handover", "Contractor", "Reported", "Description", "Status"],
      ["D-1", "U-A101", "HO-001", "C-001", "2026-09-25", "Cracked tile in kitchen", "open"],
    ]),
    disputes: csv([
      ["Dispute ID", "Buyer", "Contract", "Opened", "Subject", "Status", "Amount"],
      ["DS-1", "B-002", "CTR-002", "2026-07-12", "Late handover penalty claim", "open", "150000"],
    ]),
    correspondence: csv([
      ["Correspondence ID", "Buyer", "Contract", "Dispute", "Date", "Channel", "Subject", "Summary"],
      ["CR-1", "B-002", "CTR-002", "DS-1", "2026-07-15", "email", "Response to penalty claim", "Offered a meeting"],
    ]),
    investors: csv([
      ["Investor ID", "Name", "Email", "Phone", "Project", "Commitment", "Party Type"],
      ["INV-1", "Savanna Capital", "invest@savanna.example.com", "+254733000001", "P-001", "50000000", "company"],
    ]),
    manifest: csv([
      ["File name", "Entity", "Record ID"],
      ["handover-photo.jpg", "handover", "HO-001"],
    ]),
  };
  const documents = zip([
    { name: "site/milestones.csv", data: site.milestones },
    { name: "site/handovers.csv", data: site.handovers },
    { name: "site/defects.csv", data: site.defects },
    { name: "site/disputes.csv", data: site.disputes },
    { name: "site/correspondence.csv", data: site.correspondence },
    { name: "site/investors.csv", data: site.investors },
    { name: "docs/manifest.csv", data: site.manifest },
    { name: "docs/CTR-001_signed.pdf", data: PDF("Sale agreement SA-1001") },
    { name: "docs/U-B101_floorplan.png", data: PNG, stored: true },
    { name: "docs/scan-0007.pdf", data: PDF("Scanned letter") },
    { name: "docs/B-001_B-002_joint_letter.pdf", data: PDF("Joint letter") },
    { name: "docs/handover-photo.jpg", data: JPEG, stored: true },
    { name: "docs/broken.pdf", data: "this is not a pdf" },
    { name: "docs/notes.docx", data: Buffer.from("PK\u0003\u0004 not really a document") },
    { name: "docs/old-export.zip", data: zip([{ name: "a.csv", data: "x\n1\n" }]), stored: true },
    { name: "__MACOSX/docs/._scan-0007.pdf", data: "resource fork" },
  ]);
  return {
    files: [
      { name: "projects.csv", data: Buffer.from(projects) },
      { name: "inventory.xlsx", data: inventory },
      { name: "buyers.csv", data: Buffer.from(buyers) },
      { name: "sales.xlsx", data: sales },
      { name: "receipts.json", data: Buffer.from(receipts) },
      { name: "opening-balances.csv", data: Buffer.from(openingBalances) },
      { name: "procurement.xlsx", data: procurement },
      { name: "site-and-documents.zip", data: documents },
    ],
  };
}
