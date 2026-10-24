# Configurable property finance — 24 October 2026

## Reuse and changes

The existing property charge types, lease service assignments, shared BigInt quote calculator, invoice posting, supplier bill approvals, owner funds, manager delegation and audit store remain the financial foundation. No duplicate ledger, payment state engine or expense approval path was introduced.

### Dated utility tariffs and unit configuration

- Finance → Services & expense categories → Tariffs & unit overrides.
- Configure cumulative upper consumption boundaries and prices in the organisation's currency, plus a fixed surcharge. `*` means an open final band. Meter readings retain the existing three-decimal precision.
- Schedules have an effective month; an individual unit's applicable schedule takes precedence over the shared service schedule. Its meter serial can be recorded. Existing per-lease fixed-service price overrides remain in their current lease workflow.
- Tariffs are immutable. Add another dated schedule to change prices. Duplicate scope/service/month entries are refused. A schedule cannot be backdated over already issued recurring charge invoices.
- A unit override remains applicable until a later unit schedule replaces it. There is no automatic expiry/inherit-shared switch in this release.
- Monthly charge runs call the existing exact quote engine. Missing readings block billing; consumption beyond the last finite band causes the complete run to roll back. Zero usage still incurs an explicitly configured fixed surcharge.
- Invoice lines keep tariff ID, effective month, readings, consumption, bands, variable amount, fixed surcharge, meter serial, currency and calculation version. Subsequent configuration changes do not reprice issued invoices.
- A service's existing beneficiary, management-fee and tax rules apply to both components. A different beneficiary/tax treatment requires a separate authorised service category.
- Configuration is not a bill preview or authority to issue. Existing lease/management-authority requirements and explicit billing-run action still apply.

### Custom expense categories

- Reusable organisation categories support name, standard accounting classification, optional tax reference, active/inactive state and versioned editing.
- Category names retain users' case; duplicate names are rejected without relying on case.
- Supplier bill entry and unposted correction can select a custom category. The server selects its accounting classification; it does not trust a contradictory client classification.
- Bills snapshot the selected name and tax reference. Editing/deactivating a template does not rewrite historical bills. Retaining the same category while correcting an unposted bill also preserves that snapshot.
- Inactive categories cannot be selected for new bills; they can be restored. No permanent category deletion is exposed.
- Tax references are descriptive only; no statutory rate calculation, filing or compliance approval is inferred.
- Bills retain maker/checker, duplicate detection, permission checks and controlled posting/reversal requirements. No expense approves itself.

### Portable audit-export integrity

- An organisation-wide user with `audit.read` can download at most its latest 1,000 audit entries, including coverage/count metadata, a canonical nested-JSON hash chain and a final SHA-256 fingerprint.
- Keep the fingerprint independently from the downloaded file. Verify locally:

  `node scripts/verify-audit-export.mjs report.json RETAINED_SHA256_ROOT`

- Verification binds nested values, array/record order, count and organisation. A changed report fails against the retained root.
- This is export integrity, **not** an independently anchored full database audit chain. Someone able to replace both file and fingerprint can recompute them. It cannot prove that entries were not omitted before export. Existing database append-only protections remain in place. Independent timestamping/anchoring and historical full-database verification are not delivered by this export feature.

## Security and migration

Migration `0038_property_configurable_finance` adds configuration tables, bill category snapshot columns and invoice pricing snapshots. It does not alter existing invoices, balances, legal ownership or units. Composite foreign keys reinforce organisation boundaries. Tariff rows reject updates/deletions at database level. Template writes and billing share the existing organisation financial transaction lock.

Organisation-wide template changes require organisation-wide authority. Delegated property-scoped managers can create unit tariffs only for assigned units. Shared tariff/category reads expose reusable settings; unit override lists are filtered. Organisation-wide audit exports are unavailable to scoped managers. Access is evaluated on every request using the existing manager guard.

## Verification

- Backend: 126 test files / 825 tests passing; lint, type checks, production compilation and generated-client check passing.
- New browser journey: 34 checks at 1440, 768 and 390 px, including dark theme, persistence after refresh, repeated editing, deactivation/restoration, invalid tariff feedback, expense category submission and authorised audit downloads.
- Existing expense/payroll browser journey: 24 checks passing.
- Shared ledger, finance overview, login errors/recovery, marketplace filters and marketplace discovery regressions passing.
- Fresh migration and legacy-database upgrade tests pass; synthetic fixtures only. No live client invoices, tariffs, expenses or ownership were changed for testing.
- Visual review: desktop dark and mobile light screenshots inspected; tables scroll inside their containers without page overflow. Central navigation retains correct breadcrumbs/selected screen.

## Release and recovery

Backend is backward compatible with the previous frontend. Deploy backend first, check readiness and migration status, then publish the tested frontend. Roll back application commits if needed; retain additive configuration tables and audit/history columns. Do not run a destructive down migration or delete issued financial records. No bank/M-Pesa onboarding, payment initiation, automatic refunds or payroll transfers are activated here.
