# PALTAS Business: ownership, activation and migration corrections

## Scope and release gate

Release candidate only. No production deployment or customer financial import is authorised by this document. The production Almas property and its 100 active apartments are retained. Real owner identity, evidence, management terms and source financial meanings must be confirmed by the customer's authorised people. No tenant or property name is inferred to be the legal owner.

## Confirmed root causes

- Import used the first nonblank row as headings and limited every later row to that width. The actual workbook has real headings on row 5, and populated columns outside the old header width.
- XLSX row addresses were compressed and then reconstructed as row index + 2, losing original coordinates. The real workbook also has a legacy title-row container numbered 1 with cells referencing row 2.
- Detection depends on header aliases and source hints. Annual month matrices were being treated as ordinary record exports; no supported financial meaning could be established from the title alone.
- Mapping UI erased suggestions when changing entity and allowed empty matching submissions. Generic validation wording removed field names and constraints.
- Ownership existed only implicitly through active management agreements. Recording an agreement immediately made it active; there was no independent ownership-verification record or draft authority workflow.
- Lease activation required an agreement for every management model. Coverage lookup ignored effective dates. The UI preselected first-rent billing, including for an old start date; deposit collection was automatic.
- Correcting another record displaced the original modal. Route changes could leave a stale modal over the new screen. Users had no connected ownership-to-activation path.

## Implemented corrections

### Spreadsheet structure and matching

Header candidate scoring; explicit header-row override; populated unheaded/wider columns retained; physical source coordinates; company/report preamble separated; month matrices recognised; blank/repeated heading/explicit annual-total row dispositions; merge metadata and review warnings. Populated unnamed columns remain visible with samples. Fields and required mappings are shown; multiple sample values and aliases aid matching. Confirmed templates are reused only for exact compatible headings. Empty matching is refused locally and required fields remain validated on the server.

XLSX parsing remains server-side, without Microsoft Office. ZIP safety is preserved. New guards reject ambiguous duplicate/mixed cell coordinates, invalid shared-text indices, out-of-range Excel references and sparse expansion above 2,000,000 cells per worksheet or 5,000,000 cells per workbook. Consistent original cell coordinates are retained with a warning when a legacy row container is misnumbered. Sequential cells without optional references are supported. Accepted source bytes are retained for auditable structural parse failures; unsafe archives are refused without retention. Retained originals remain subject to upload quotas. Uncached formulas are not invented or executed; 1904 workbook date systems are respected.

### Historical monthly reference migration

The manager explicitly selects the property, financial year, apartment column, name column, whether names identify tenants or owners, currency and what monthly amounts mean. Months become monthly reference records, not invented dated transactions. Source workbook, worksheet, cell, amount and period are retained. Zero and missing amounts are distinct. Other columns remain in the original workbook with a warning to review them separately.

Where an unambiguous reported monthly total exists, preparation compares it with detected rows using exact minor-unit conversion and integer totals. Otherwise the UI requires manual source-total review. Matching targets existing units in the selected organisation/property; compact and zero-padded labels are matched only when unambiguous. Retired apartments can retain reference history without returning to active inventory. Validation uses bounded lookups rather than a database query for every monthly record. Duplicate source keys and duplicate apartment/month/meaning summaries are refused. A repeat import is recognised.

The existing validate → dry run → independent approval → import → reconcile workflow is reused. Reference imports create no invoice, receipt, allocation or ledger journal. Opening balances and actual dated financial transactions remain separate accounting workflows. The existing property trust ledger is preserved; choosing owner-managed authority does not silently convert the company chart of accounts or restate owner funds as corporate income. An accountant must review consolidation/account mappings for an owner operating its own company books. These monthly reports alone cannot establish actual payment dates or replace transaction-level evidence. Warnings, errors and source references remain auditable; CSV reports retain formula-injection protection.

### Ownership and management authority

Independent property/unit ownership records support individual/company owners and whole-property or selected-unit coverage. Evidence references and notes can be recorded. Saving does not verify ownership. Only an organisation administrator or finance director can explicitly confirm reviewed evidence.

Management authority reuses the existing agreement system, now with drafts, ownership links, effective dates, management model, operator/company, document reference and explicit activation. Owner-managed authority requires verified ownership and no separate third-party contract or management fee. Third-party/developer authority requires reviewed signed evidence and the actual signing date. Drafts can be prepared before ending current authority; activation never silently replaces an active mandate. Unit-specific ownership cannot inherit another owner's whole-property authority. Database triggers backstop organisation, property, owner and unit boundaries.

Existing active agreements remain historical records; they are not silently marked signed or converted into newly verified ownership. Legacy callers cannot create new active unsigned authority without the guided ownership relationship. Coordinate backend and frontend release, and ask clients to refresh old sessions.

### Lease activation and correction navigation

Portfolio “Complete ownership” and actual owner names open the scoped ownership record. Ownership, authority verification and draft completion are connected. Approval returns to the original lease and rechecks it through a rolled-back preview. Signing date and billing choices are preserved; automatic financial execution never occurs.

Historical activation does not automatically issue a deposit or implied backdated first-rent invoice. An unpaid rent period must be explicitly selected. Preview runs the same activation and posting rules inside a transaction that is rolled back, including audit/counters/occupancy. Final confirmation checks expected rent/deposit amounts, and existing invoice uniqueness and lease-overlap protection remain enforced. New rent uses existing proration. New invoices are not issued with a due date earlier than their issue date.

Correction drafts are bounded, organisation-scoped memory only; credentials and approval checkboxes are excluded. No alternate router, URL-based authorisation or localStorage business-token scheme is introduced. Ownership cards expose their actions on mobile without horizontal scrolling. Existing branding and themes are reused.

## Actual workbook verification

`Services Charge - 1.xlsx` was read in memory using the revised parser against the stored original, inside a read-only database transaction. The scratch parser was removed afterwards; no customer row values, names or amounts were exported.

| Worksheet | Header row | Retained populated columns | Detected data rows |
| --------- | ---------- | -------------------------- | ------------------ |
| 2021      | 5          | 15                         | 24                 |
| 2022      | 5          | 19                         | 31                 |
| 2023      | 5          | 19                         | 32                 |
| 2024      | 5          | 19                         | 37                 |
| 2025      | 5          | 19                         | 36                 |
| 2026      | 5          | 19                         | 36                 |

These are structural rows, not verified financial transaction counts. Actual monetary meaning, mapping and balances have not been approved or imported. No unambiguous labelled monthly total was detected in this workbook; accountant review remains necessary. The earlier parser showed 13/17 columns because it took the report title's width.

## Additive production migrations requiring release approval

- `0031_migration_table_analysis`: detection/review metadata on existing staged tables.
- `0032_property_ownership_authority`: ownership records; draft/verified authority metadata and boundary guards. Existing unit/property/financial IDs remain unchanged.
- `0033_property_historical_reference`: non-posting monthly history with scoped unit matching and idempotency/uniqueness safeguards.

No production bank, M-Pesa, Stripe, subscription, Marketplace design or authentication changes are included. Marketplace markup/styles outside the shared script blocks were compared byte-for-byte and remain unchanged.

## Verification evidence and limits

Final command results and screenshots are recorded in the accompanying release report. Tests use isolated local PostgreSQL and real Chrome, synthetic contacts and units, explicit approvals and persisted outcomes. The actual uploaded workbook was tested only for read-only structure detection, not a financial import.

Remaining limits: binary XLS is not supported; use XLSX/CSV. Merge/multirow headings have visible review metadata and header override, not speculative automatic interpretation. Exact payment dates cannot be inferred from annual month totals. Ownership evidence verification is a human review, not an automated land-registry/KYC service. Unsaved correction choices are memory-only; refreshing reloads the saved draft lease rather than persisting private form contents on a shared device. Intentionally unavailable provider/tax workflows remain labelled; this release does not assert complete QuickBooks parity or bank connectivity.

## Review and production verification plan

1. Review and approve the coordinated backend/frontend release and the three additive migrations above.
2. Back up production; run migrations once through the normal deployment process. Check API readiness and migration status before releasing the frontend.
3. Confirm Almas still has 100 active units (West 48; East 52 including four external units), unchanged property/unit IDs and unchanged historical invoice/payment counts.
4. An authorised client representative selects the actual registered legal owner and records evidence. An organisation administrator or finance director reviews it. No owner identity is filled from the property/tenant label.
5. Complete the appropriate authority model and actual supporting signatures/effective dates. Review before activation.
6. Open the saved Unit 103 E lease, follow the correction return path, preview the selected unpaid period and confirm only the intended new posting. A historical lease may be activated without invoices.
7. For the original workbook, explicitly confirm monthly meaning/name identity/currency and reconcile source totals before any import. The reference-only mode does not replace an accounting opening-balance cutover.
8. Monitor scoped errors and audit entries; retain backups. No live charge or payout is part of this verification.
