# Tenant rent collection insights — release scope

## Existing functionality reused

Existing lease rent/due-date terms, rent billing runs, invoice effective allocations, payment credit and correction views, tenant statements, dashboard/property filters, ledger checks, role gates and PALTAS portal styling. No duplicate billing engine or financial posting service.

## Backend changes

- Optional `Dashboard.rentAnalysis` response in `contracts/src/api/property.ts`; regenerated browser client and OpenAPI.
- `products/property/reports/rent-insights.ts`: read-only rent invoice cohort totals, paid vs credit notes, collection rate on net obligation, current overdue/due-soon balances, five ageing buckets, top ten overdue tenant follow-ups.
- Existing dashboard service uses its authorised property-filtered invoices; additional analytics exclude deposits, opening balances, other charges and future-issued rent invoices.
- Dashboard route explicitly requires financial-report permission. Tenant names and balances are not made available to maintenance-only staff. Existing scoped Main Manager protection remains fail closed for the org-wide dashboard/ledger.

## Frontend changes

- Existing Management dashboard and Collections route show rent insights, previous-month cohort comparison, ageing chart and direct tenant-statement actions.
- Existing overview links to Rent insights; payment entry and reconciliation reuse existing actions with capability checks.
- Property/month filters preserved. Each month groups rent invoices by issue date, with their current allocation/credit status. This is not a historical as-of ledger reconstruction, expected-rent forecast, bank settlement report or company profit.
- Empty/unknown states distinguish unavailable data and zero. No reminders or payments sent by viewing the report.
- Scoped insight styles use existing light/dark variables. No new dependency or change to Marketplace/client product designs.

## Data and provider boundaries

No database migrations. No customer invoice/payment/lease mutations during release verification. Historical posted documents retain audited corrections/reversals. Bank and M-Pesa connections remain later onboarding work; manually recorded external payments are not represented as processed or settled by PALTAS. No money movement, credentials, provider changes or automatic tenant messages in this release.

## Checks

- Backend full suite: 123 files, 800 passed, 0 failed.
- TypeScript, lint, formatting and generated-client parity checks.
- Focused backend rent/financial tests: 33 passed, included in the full-suite count.
- Frontend render, command-center and finance overview checks.
- Existing real-server PM browser journeys: 115 passed, 0 failed.
- New local isolated browser journey checks actual lease billing/payment through the API, property filter, collection rate, tenant statement link, payment form, desktop/mobile layout, read-only behaviour and accessibility. See deployment report for final browser/release outcome.

## Rollback

Previous backend commit: `5819ee16f3436dfc900beeca0a1b21b4615c6013`.
Previous frontend commit: `93b7291019bb4401ea2a5e9ae53b5835d6a96471`.
No migration rollback required. Optional response addition preserves existing clients. Restore the pinned prior application deployments if needed; never delete accounting data.
