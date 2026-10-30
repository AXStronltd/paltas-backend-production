import { createHash } from "node:crypto";
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { decimalsOf } from "../../../lib/money.js";
import { reportXlsx, reportPrint, type ReportCell } from "../../../lib/tabular-export.js";
import { fail } from "../../../http/errors.js";
import { collectionsOverview } from "./collections-overview.js";

const MAX_ROWS = 10_000;
/** Quote every cell; prevent spreadsheet formula execution, including leading whitespace/control characters. */
export function collectionCsvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  let first = 0;
  while (first < raw.length && (raw.charCodeAt(first) <= 32 || raw.charAt(first).trim() === "")) first++;
  const text = /^[=+\-@]/.test(raw.slice(first)) ? `'${raw}` : raw;
  return `"${text.replace(/"/g, '""')}"`;
}
export const collectionDecimal = (minor: number, currency: string) => {
  if (!Number.isSafeInteger(minor) || minor < 0) throw fail.conflict("Report amount is outside the safe export range");
  const n = BigInt(minor);
  const digits = decimalsOf(currency),
    scale = 10n ** BigInt(digits);
  return digits ? `${n / scale}.${String(n % scale).padStart(digits, "0")}` : String(n);
};

export async function exportCollections(db: Db, s: OrgScope, q: P.CollectionsExportQuery) {
  // One repeatable-read snapshot, not repeated pagination over changing records.
  const r = await collectionsOverview(db, s, { ...q, limit: MAX_ROWS, offset: 0, invoiceOffset: 0 });
  const total = q.kind === "receipts" ? r.total : r.invoiceTotal;
  if (total > MAX_ROWS)
    throw fail.invalid(
      `This export matches ${total} records. Narrow the date, property or tenant filters to 10000 records or fewer. Nothing has been downloaded.`,
    );
  const headers =
    q.kind === "receipts"
      ? [
          "Receipt ID",
          "Receipt",
          "Receipt date",
          "Tenant ID",
          "Tenant",
          "Method",
          "Reference",
          "Currency",
          "Amount",
          "Bank matched",
          "Amount scope",
          "From",
          "To",
          "Balances as of",
        ]
      : [
          "Invoice ID",
          "Invoice",
          "Tenant",
          "Unit",
          "Due date",
          "Currency",
          "Invoice amount",
          "Current outstanding",
          "Selection",
          "From",
          "To",
          "Balances as of",
        ];
  const rows: ReportCell[][] =
    q.kind === "receipts"
      ? r.rows.map((x) => [
          x.id,
          x.receiptNumber,
          x.date,
          x.tenantId,
          x.tenantName,
          x.method,
          x.reference,
          r.currency,
          { decimal: collectionDecimal(x.amountMinor, r.currency) },
          x.bankMatched ? "Yes (not settlement confirmation)" : "No",
          r.scopedAllocations
            ? "Direct allocations to selected assets only; excludes unallocated credit"
            : "Full receipt including unallocated credit",
          r.from,
          r.to,
          r.asOf,
        ])
      : r.invoices.map((x) => [
          x.id,
          x.number,
          x.tenantName,
          x.unitNo ?? "",
          x.dueDate,
          r.currency,
          { decimal: collectionDecimal(x.amountMinor, r.currency) },
          { decimal: collectionDecimal(x.balanceMinor, r.currency) },
          q.invoiceStatus,
          r.from,
          r.to,
          r.asOf,
        ]);
  if (rows.length !== total) throw fail.conflict("The complete report could not be read. Try a narrower selection.");
  const format = q.format ?? "csv";
  const csvCell = (x: ReportCell) => collectionCsvCell(typeof x === "string" ? x : x.decimal);
  // Print keeps human document references; repeated period metadata belongs in the page heading.
  // Internal source IDs remain in the Excel/CSV extracts for reconciliation.
  const printColumns = headers
    .map((name, i) => ({ name, i }))
    .filter((x) => !["Receipt ID", "Tenant ID", "Invoice ID", "From", "To", "Balances as of"].includes(x.name));
  const bytes =
    format === "xlsx"
      ? reportXlsx(headers, rows)
      : Buffer.from(
          format === "print"
            ? reportPrint(
                `PALTAS ${q.kind === "receipts" ? "Collections cashbook" : "Invoice balances"}`,
                `${r.currency} · ${r.from} to ${r.to} · Current balances as of ${r.asOf} · ${rows.length} records. Bank matching is not settlement confirmation.`,
                printColumns.map((x) => x.name),
                rows.map((row) => printColumns.map((x) => row[x.i] ?? "")),
              )
            : "\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
        );
  const content = bytes.toString(format === "xlsx" ? "base64" : "utf8");
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  await recordAudit(db, {
    actor: s.actor,
    orgId: s.orgId,
    action: "Collections report exported",
    target: q.propertyId ?? s.orgId,
    after: { format, filters: q, rowCount: rows.length, fingerprint, asOf: r.asOf, currency: r.currency },
  });
  return {
    filename: `paltas-${q.kind}-${r.from}-${r.to}.${format === "print" ? "html" : format}`,
    content,
    encoding: format === "xlsx" ? ("base64" as const) : ("utf8" as const),
    contentType:
      format === "xlsx"
        ? ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const)
        : format === "print"
          ? ("text/html" as const)
          : ("text/csv" as const),
    rowCount: rows.length,
    fingerprint,
  };
}
