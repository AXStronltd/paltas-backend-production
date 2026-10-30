# Collections reporting upgrade — 30 October 2026

## Confirmed gaps
The complete collections exporter supported CSV only. Its amount formatter always divided integer minor units by 100, so zero-decimal currency exports could disagree with the shared money engine and ledger.

## Implementation
Extend the same authorised `property.exportCollections` endpoint with optional `format=csv|xlsx|print`; existing calls remain CSV. Preserve receipt-date versus current invoice balance semantics, source filters, immutable source financial records, bounded complete snapshots, the 10,000-record limit, permission checks and export audit fingerprints. Amount formatting now uses the shared `decimalsOf` rules and integer arithmetic.

Excel exports are genuine OOXML workbooks generated with Node's existing compression/CRC facilities; no new dependency or installed office application is required by the server. Untrusted strings use inline text cells, never formulas, hyperlinks or remote resources. Monetary values are numeric where Excel's 15-digit precision permits; larger exact values remain text. Frozen headings, filters, widths and amount formats are included. Archive entry names are fixed by the server. XML-invalid control characters/lone surrogates are omitted from export presentation; stored records are unchanged.

Printable reports use the same selected rows and escaped content, repeated print headings and A4 landscape styling. Period, currency, balance date and record count are shown once. Internal source IDs remain in Excel/CSV; printed records retain human invoice/receipt references. The UI opens a report window with a working Print / Save as PDF action. This uses the browser's print/PDF facility, not a new server-side PDF service. It requires report popups to be permitted.

## UI
Existing Collections overview and CSV actions remain. The additional Excel / Print reports action offers receipt/cashbook or invoice-balance selection and format. Filters are reused from the loaded report. An organisation-context change or failed request closes the pending report window instead of presenting a blank successful export.

## Verification
Backend tests cover complete exports beyond one screen page; all-format size limits; missing-row refusal; permission/organisation isolation; audit fingerprints; literal formula-like text; escaped print content; Unicode; exact large numbers; UGX versus KES scale; receipt and invoice workbooks. Real browser tests download and inspect Excel/CSV, open print reports and generate PDF at 1440/768/390px. A separate Python spreadsheet reader verifies downloaded workbooks independently of the PALTAS ZIP reader. Synthetic fixtures only; production records are not created or altered for acceptance. Final execution counts and deployment identifiers are in task outputs.

## Limits
No automatic scheduled delivery, background large-report jobs, currency conversion or new country payment/tax support is introduced. Exports above 10,000 rows require narrower filters and fail without silently truncating data. Currency scale follows the existing shared PALTAS engine; this change does not migrate historic records or certify every ISO currency or jurisdiction. Print layout/PDF depends on browser and printer settings. Excel was validated with independent readers, not with every native spreadsheet application.

## Recovery
No migration. Revert these application commits to roll back exports; retain existing report audit events and financial records.
