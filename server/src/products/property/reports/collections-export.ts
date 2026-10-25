import { createHash } from "node:crypto";
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
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
const decimal = (minor: number) => {
  if (!Number.isSafeInteger(minor) || minor < 0) throw fail.conflict("Report amount is outside the safe export range");
  const n = BigInt(minor);
  return `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
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
  const rows =
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
          decimal(x.amountMinor),
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
          x.unitNo,
          x.dueDate,
          r.currency,
          decimal(x.amountMinor),
          decimal(x.balanceMinor),
          q.invoiceStatus,
          r.from,
          r.to,
          r.asOf,
        ]);
  if (rows.length !== total) throw fail.conflict("The complete report could not be read. Try a narrower selection.");
  // UTF-8 BOM keeps names readable in common spreadsheet applications; no local office installation is needed.
  const content =
    "\ufeff" + [headers, ...rows].map((row) => row.map(collectionCsvCell).join(",")).join("\r\n") + "\r\n";
  const fingerprint = createHash("sha256").update(content).digest("hex");
  await recordAudit(db, {
    actor: s.actor,
    orgId: s.orgId,
    action: "Collections report exported",
    target: q.propertyId ?? s.orgId,
    after: { filters: q, rowCount: rows.length, fingerprint, asOf: r.asOf, currency: r.currency },
  });
  return {
    filename: `paltas-${q.kind}-${r.from}-${r.to}.csv`,
    content,
    contentType: "text/csv" as const,
    rowCount: rows.length,
    fingerprint,
  };
}
