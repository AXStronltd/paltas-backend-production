# Universal Billing — Phase B architecture and release boundaries

Status: proposed integration architecture; initial pure pricing foundation implemented locally. Not deployed.

## One service, existing product authority

Add `core/billing` to CoreServices after approval of the integration boundary. It owns reusable categories, deterministic quotes, invoice snapshots, allocations, receipts, credits/refunds, recurrence, batch execution and reporting projections. It always calls the existing ledger, payment inbox, scheduler and notification outbox.

Extend ProductRegistry with a billing authority adapter per product. The adapter must resolve and validate organisation membership, entitlement, action permission, native property/building/customer/booking/lease/contract scope, liable payer, beneficiary, effective authority, business date and recognition policy. Client-submitted references never grant authority. Revalidate on issue, allocation, credit/refund approval and recurring execution, not merely when a draft was created.

No generic default that credits company revenue for every charge is permitted. Initial policies must be named and tested: owner receivable, company service revenue, deposit liability, shared-building assessment, hotel folio document, stay advance/completion and developer contract advance/recognition. Policies reference existing product accounts and posting services until staged compatibility is verified.

## Proposed additive schema (not applied)

All records carry `org_id`, scoped product/context references, audit metadata and appropriate composite foreign keys/indexes. Native context validation remains server-side.

| Record                                | Purpose / constraints                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| charge_categories + versions          | Org-scoped templates, applicable products, group/icon, tax/account defaults, active status, limits. Versioned immutable configuration for issued use.                                                            |
| billing_drafts + draft_lines          | Mutable before issuance; optimistic version/concurrency check; no ledger effect.                                                                                                                                 |
| customer_invoices + invoice_lines     | Distinct from platform `billing_invoices`; immutable issued price/tax/calculation snapshots, payer and per-line beneficiary/collector/agreement/accounting policy.                                               |
| billing_source_links                  | Unique `(org, product, source_type, source_id)` links legacy records and journals. Explicit document-only vs posting ownership; never duplicate receivable.                                                      |
| customer_payments + allocations       | Provider/manual verification, clearing/settlement status; allocation by invoice line and beneficiary. Verified allocation never exceeds remaining available funds.                                               |
| customer_receipts                     | Numbered verified-payment records with immutable originals and correction/reversal links.                                                                                                                        |
| billing_credits + refund_requests     | Obligation credit separate from funds returned; available refund balance calculated under lock including in-flight reservations. Independent delegated approval; provider idempotency and callback finalisation. |
| billing_schedules + occurrences       | Unique org/obligation/period/version source, next local billing date, pause/cancel/proration; repeat execution cannot duplicate charges.                                                                         |
| billing_batches + items               | Immutable reviewed preview fingerprint, explicit confirmation, resumable per-item transactions, failures visible, no blind full-batch reissue.                                                                   |
| billing_disputes + audit/outbox links | Customer-scoped disputes, operational review and existing delivery audit references.                                                                                                                             |

No SQL migration is supplied or run at this stage. Existing tables and ledger sources remain authoritative until compatibility adapters are reviewed and tested.

## Transaction and provider rules

1. Resolve authority and current resource ownership in the organisation transaction.
2. Lock obligations, payments/refund reservations and relevant finance scope in a documented stable order; coordinate legacy finance lock namespaces during coexistence.
3. Validate immutable preview version, amounts, billing period, account classifications and open business period.
4. Allocate an org-scoped idempotency key tied to a canonical request fingerprint. Same key/different payload is a conflict, never a false success.
5. Persist document plus journal through existing ledger within the transaction. Hotel legacy document-only adapters link existing postings.
6. Enqueue notifications through the existing outbox after confirmation. Provider requests use a durable dispatch record and stable provider key, never a network call held inside a DB lock.
7. Verify provider signature/account/merchant/currency/amount/reference, deduplicate event and transition atomically. Pending/failed events do not produce paid receipts.
8. Distinguish verification, clearing, settlement and bank reconciliation; provider fees are separate entries. Refund completion requires verified outcome, not approval alone.

## Money and snapshots

Use integer currency minor units and exact rational intermediate calculations. Reject mixed-currency quote lines. No visitor-location tax assumptions, automatic exchange rates or cross-currency totals.

The initial calculator uses explicit exclusive/inclusive additive tax components, percentage/amount discounts, bounds before discount/tax, half-up line rounding and deterministic largest-remainder tax allocation. It supports fixed/custom, quantity (night/guest/booking/hour/day/month/square metre/unit), metered differences, graduated tiers and explicit-base percentages. Unsupported compound taxes, tier styles or FX require explicit additional policy, not guessed calculations.

Price snapshots are detached from input/template changes. Issued snapshots must subsequently be immutable in storage. Zero-price quotes are permitted for review; issuance must independently enforce the appropriate zero/positive obligation policy.

Three-decimal and zero-decimal presentation requires a validated currency registry before broad currency activation. A quote never converts major to minor units. Foreign-currency ledger posting is blocked until an approved FX snapshot, realised gain/loss and reconciliation policy exists.

## Shared workspace and rollout

Finance → Charges & Billing uses the existing product shell and route conventions. A common component/service supplies Overview, Create Charge, Categories, Invoices, Collections, Receipts, Recurrence, Service Charges, Refunds/Credits, Outstanding, Reconciliation, Reports and Permissions. Each product supplies permitted contexts/categories and native actions; no parallel portal architecture.

Dashboard queries are authorised before aggregation and grouped by currency. No dummy statistics or green health indicators. Customer portals query only payer-authorised records; owners see their own beneficiary statements, not other owners' private transactions.

Rollout order:

1. Pure shared pricing contracts/calculator and isolated tests (current local foundation).
2. Reviewed additive category/draft/invoice schema and server permission adapters; legacy document views are read-only links.
3. Staging PM service-charge pilot with native owner/deposit accounting and source reconciliation. Explicit confirmed posting only.
4. Hotel folio, stays, developer and agent adapters, each with pre/post balances reconciled.
5. Recurrence/bulk jobs, credits/refunds, receipt/customer portal and report projections.
6. Enabled provider integrations only after merchant/currency/jurisdiction/callback/settlement/refund verification. Manual verified payment remains clearly labelled external.
7. Complete staging acceptance and controlled production release with monitoring/rollback plan.

## Test and release gates

Run the user's 25 journeys, with actual ledger outcomes and tenant/property isolation; include tax rounding, overflow, boundaries, concurrent duplicate issuance/refunds, permission revocation, failure/retry and partial batch recovery. Compare native PM owner statements, hotel folios, stay deposits and developer contract balances before/after. Test mobile, keyboard access, expired sessions, provider callbacks and outbox delivery states.

A database rollback cannot undo external money movement. Release rollback disables new issuance/dispatch first, preserves event processing and financial records, restores compatible application version and uses audited compensating entries where necessary. Never delete production journals to roll back.

The user's earlier release rule requires approval before major architectural replacement, production database/financial modifications or production deployment. This proposal makes that boundary reviewable. Existing deployment approval covered Manager/Lease upgrades, not a replacement of cross-product posting paths. Safe pure code groundwork can proceed; no live financial cutover is authorised here.

## Current delivery boundary

- Reused: contracts package and integer-minor-unit convention; no new dependency.
- Changed: `contracts/src/universal-billing.ts`, namespace export in `contracts/src/index.ts`, `server/src/core/billing/pricing.ts`, `server/test/universal-billing.pricing.test.ts`, these two documents.
- Migrations: none.
- Not complete: persisted categories, universal APIs/workspace, product adapters/cutover, schedules/batches, full refund lifecycle, new provider connections, complete acceptance suite.
- Production readiness: **not ready to activate the universal engine**. Existing production finance paths are untouched.

## Foundation verification

Final local checks on 23 October 2026:

- TypeScript production build plus contract/client/server test type checks: passed (`npm run typecheck`).
- Repository lint: passed (`npm run lint`).
- Repository formatting: passed (`npm run format:check`).
- Focused tests: 8 files, 88 passed, 0 failed (26 new pricing tests plus 62 existing financial regression tests).
- Whitespace diff check: passed.

The new tests include all quantity units, metered backwards readings, malformed tiers, discounts/bounds, inclusive/exclusive tax rounding, 500 varied tax calculations, currency mismatch, expense rejection, integer overflow, unsafe quantity strings and detached snapshots. These are calculator and existing regression tests, not the unimplemented universal UI/provider acceptance journeys. No browser test is claimed for the new engine because no new UI exists yet.
