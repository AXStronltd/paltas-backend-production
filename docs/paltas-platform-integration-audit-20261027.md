# Property, Payments and CRM integration audit — 27 October 2026

## Release assessment

**The complete master specification is not implemented or production-verified.** This report distinguishes working code and freshly executed tests from missing automation and external production evidence. It is not a certification of global readiness, a complete penetration test or a claim that every screen has been exercised.

Current audit branches:

- Backend: `codex/platform-integration-audit-20261027`.
- Frontend acceptance test: `codex/platform-crm-acceptance-20261027`.

The released marketplace navigation/design is preserved. No production credentials, financial records, payment methods, Stripe accounts or customer permissions were changed. This integration patch is not deployed.

## Architecture traced

The repository already has shared identity, organisations, entitlements, permissions, contacts, documents, notifications, ledger, scheduler, audit and migration services. Property Management delegates posting to the shared ledger rather than maintaining a second accounting engine.

Property flow:

`leases/billing → shared/money.issueInvoice → shared/posting → core ledger`

`payments.recordIn → shared/money.allocate → collection/owner/deposit postings → receipt number → contact product activity → audit`

Both use the caller's PostgreSQL transaction. Finance operations also use an organisation-scoped advisory lock. The CRM pipeline uses the canonical contact store. Product activity validates the source record, organisation and contact before projection and deduplicates by product/event/source record.

Provider flow is distinct:

`verified provider callback → core payment_events → registered product handler`

The Property Management module does not register a complete automated Stripe rent payment lifecycle. The Stripe rent directory currently contains account isolation and merchant onboarding/capability services. Those are not evidence of tenant payment initiation, mandates, collection execution, settlements, refunds or owner transfers.

## Capability gap matrix

“Partially implemented” can mean substantial working functionality exists while the whole requested acceptance requirement remains unverified. A screen or test filename alone is not counted as an operational workflow.

| Area                                              | Classification                              | Evidence and remaining work                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-property/building/unit management           | Partially implemented                       | Existing setup, ownership, unit status and block services; full worldwide/mixed-use and every edit/export journey not reverified in this audit.                                                                   |
| Ownership versus management authority             | Partially implemented                       | Existing `setup/ownership.service.ts`, agreements and lease activation; third-party/owner-managed and mixed ownership test suites exist. Full applicable approvals and jurisdictional evidence remain separate.   |
| Tenant/owner profiles and shared contact identity | Partially implemented                       | Canonical `core/contacts`; CRM, leases and payments use contact IDs. Property/agency activity access is checked on each read. Full all-product identity reconciliation remains unverified.                        |
| Lease creation, activation and first invoice      | Partially implemented                       | Focused integration tests pass for activation/rollback/first-rent and draft billing. Signature-provider/legal-country verification is not established here.                                                       |
| Renewals, termination and move-out                | Partially implemented                       | Existing lease services and tests; complete jurisdiction-specific lifecycle acceptance is not established by the focused batch.                                                                                   |
| Deposits and settlement corrections               | Partially implemented                       | Existing liability accounting and approval/reversal workflows; full refund provider execution is separate.                                                                                                        |
| Tenant and owner portals                          | Partially implemented                       | Existing contact-scoped portal services and statements; all supported device/role workflows require additional browser acceptance.                                                                                |
| Service categories, allocation and utilities      | Partially implemented                       | Existing configurable finance, utility meter lifecycle, pricing and disputes code. Do not equate category setup with verified supplier/utility reconciliation in every country.                                   |
| Invoice drafts, approval and issuance             | Partially implemented                       | Existing versioned drafts and concurrent issue/retry tests. This batch adds the missing shared CRM projection.                                                                                                    |
| Recurring rent                                    | Partially implemented                       | Existing authoritative monthly scheduler and duplicate safeguards. Weekly/custom/global schedule requirements need separate implementation and acceptance; no second Stripe schedule should be introduced.        |
| Manual payments, partial allocation and credit    | Fully operational for tested scenarios      | Current isolated tests verify recording, allocations, reversals, balances and audit. These are records of externally received money, not provider payment processing.                                             |
| Receipt number and tenant history                 | Partially implemented                       | Generated with the payment transaction. Automatic customer delivery and real provider-confirmed delivery are not established by recording a receipt.                                                              |
| Automated Stripe tenant rent/AutoPay              | Missing                                     | No complete tenant mandate, initiation, attempt/retry, return/dispute, settlement and payout chain in Property Management. Merchant onboarding is insufficient.                                                   |
| Country payment method availability               | Not production-ready                        | Explicit PALTAS account pinning and merchant capability snapshots exist. Country eligibility, mandate/notice, currency, connected account and real end-to-end evidence remain required.                           |
| SaaS subscriptions                                | Partially implemented                       | Separate from rent with existing checkout/webhook implementation. Prior currency correction is on the backend branch but has not been deployed. Do not infer working approved-price/tax checkout from this audit. |
| M-Pesa/bank integration                           | Not production-ready                        | Translators and recorded/manual reconciliation exist; live onboarding and execution are deferred and not tested here.                                                                                             |
| Provider settlement, refunds and owner transfers  | Missing for automated rent                  | Existing manual approval/accounting/owner statements do not execute a provider refund or distribute manager payouts to owners.                                                                                    |
| Manual reconciliation and owner balances          | Fully operational for tested scenarios      | Existing snapshot/reversal/report tests passed in the first batch; broader scenarios covered by the full regression run where successful.                                                                         |
| CRM leads/viewings/applications                   | Fully operational for tested scenarios      | Existing CRM integration tests passed using the canonical contact store; complete CRM automation/product breadth remains separate.                                                                                |
| Invoice-to-CRM activity                           | Broken before this patch; corrected locally | Common invoice issuance previously ended at journal linkage without a contact event. Now transactional, source-verified, idempotent and permission-filtered.                                                      |
| Tasks, vendors, maintenance and documents         | Partially implemented                       | Existing core/product services, inspection/preventive plans and document/notification code. Entire operational programme remains open in its own requirement matrix.                                              |
| Cross-product activity                            | Partially implemented                       | Property lease/payment and agency stay projection already existed; invoice projection added. A complete all-product event contract/outbox and reconciliation matrix remain unverified.                            |
| Currency and country configuration                | Partially implemented                       | Currency minor units, organisation currency, timezone and country-specific configuration exist. This is not a complete FX/multi-entity consolidation or worldwide tax system.                                     |
| Tax configuration                                 | Not production-ready globally               | Existing configuration/calculation and country rules do not establish each company's registration, live tax provider settings or country compliance. No tax registration/exemption was changed.                   |
| Notifications and reminders                       | Partially implemented                       | Shared outbox and collection-reminder code. Actual delivery requires enabled transport and provider confirmation. No real customer communication was sent.                                                        |
| Organisation/property/role isolation              | Fully operational for tested scenarios      | Scoped manager and product activity tests pass, including existing-session revocation; complete security review remains broader than these checks.                                                                |
| Auth/session security                             | Partially verified                          | Existing credential/MFA and session test coverage. This code audit did not inspect production logs or reset accounts.                                                                                             |
| Backup/restore                                    | Partially verified                          | Existing isolated dump/restore drill compares records/totals; managed production retention, PITR, restore access and RTO/RPO still require operational evidence.                                                  |
| Monitoring/retry/recovery                         | Partially implemented                       | Existing durable jobs/outbox and operational services. Production alert delivery and failure drills not verified here.                                                                                            |
| Enterprise scale                                  | Not production-ready as a claim             | No target-volume, concurrency, latency and recovery acceptance evidence established for hundreds of thousands of units.                                                                                           |
| Responsive and accessible workflows               | Partially verified                          | New real-backend desktop/mobile CRM journey passes; this is not complete tablet/mobile/accessibility certification of every product.                                                                              |

## Confirmed root cause and implemented correction

### Invoice issuance was absent from the contact timeline

`products/property/shared/money.ts::issueInvoice` created invoice lines and a balanced journal, then linked the journal and returned the invoice ID. Payments and lease activation already called `core.contacts.productActivity`, but invoice issuance did not. A manager therefore could not see the invoice issuance alongside the tenant's payment/lease activity in the same contact timeline.

The correction reuses the existing activity projector after the journal has been linked, inside the same caller transaction. It records the invoice number, currency-formatted amount, type and due date; no second contact or ledger is created. Database/source validation requires the invoice's organisation, contact and posted journal to match.

Replays keep the original author/time/text and event identity. Drafts create no issued activity. Preview/failed activation rolls back invoices, journals and the event together. Restricted managers see an invoice event only for their assigned property and with delegated financial-history permission; revocation is enforced on the existing session's next read. Existing aggregate payment events remain conservatively hidden from property-scoped activity reads.

Files changed:

1. `server/src/core/contacts/product-activity.ts`
2. `server/src/core/contacts/contacts.service.ts`
3. `server/src/products/property/shared/money.ts`
4. `server/test/contacts.product-activity.test.ts`
5. Frontend acceptance only: `tests/property.invoice-crm.browser.test.js`

No schema migration, new public endpoint, notification transport or financial posting rule is introduced.

## Additional browser findings

The real contact-profile Documents section still describes metadata-only filing and asks the user to retain the original file elsewhere. The contact Messages section also explicitly says general contact messages are recorded only; invoice email is a separate action. These are observed workflow limitations, not proof that all document storage or email services are absent: lease-document storage and invoice email have separate existing implementations. Reuse those services when completing contact-level upload/delivery, with record authorisation and configured delivery status, rather than creating another document store or silently promising delivery.

## Prioritised controlled implementation sequence

1. **Release blockers:** finish the tenant payment/merchant/mandate/attempt/provider-event/settlement lifecycle in isolated test mode; confirm PALTAS-only account, source signatures and approved funds flow. Keep live collection disabled until verified.
2. **Financial consistency:** extend transactional CRM projections to remaining invoice correction, deposit, refund/payout and product events using source validation; reconcile reports and customer statements against the shared ledger. Preserve reversals and independent approval.
3. **Billing and customer controls:** close the recurring-cycle/utility/notification delivery gaps; verify repeated edits, approval, cancel/reverse, archive/restore and reopening through actual backend journeys.
4. **CRM operations:** verify tasks, maintenance, vendor, viewing and communication links across product permissions; avoid disconnected contact stores and unauthorised cross-product activity.
5. **Global operations:** country adapters, currency boundaries, timezone scheduling and measured bulk/load behaviour; no global tax/availability claims without evidence.
6. **Production readiness:** staged regression, explicit migration review where needed, provider onboarding/monitoring/backup recovery evidence, customer acceptance and rollback plan.

## Executed evidence

- Initial code baseline: **8 integration files / 52 tests passed** for product activity, CRM, payment reversal, collection overview, manager controls, reconciliation snapshots and Stripe rent isolation/onboarding.
- Changed integration batch: **3 files / 21 tests passed**, covering invoice projection, replay, rollback, product access, scope and first-rent/draft regressions.
- New real-backend browser journey: **10 checks passed** at 1440px and 390px. Creates synthetic ownership/agreement/lease/invoice/payment, signs in through the real login form, opens the contact profile, verifies invoice/payment activity, reopens after refresh and verifies unchanged invoice balance.
- Full backend regression: **151 files / 974 tests passed**, with no failures or skipped tests reported. Typecheck, lint, repository formatting checks and generated browser-contract verification passed. Production provider readiness is not inferred from these isolated tests.

Logs and actual browser screenshots are under the task's `outputs` directory. Provider calls, delivery, production migrations and live money movement were not exercised. The historical client workbook was not available for actual-file migration acceptance.

## Decision

This batch fixes a verified integration gap without changing financial calculations or the approved design. **It does not complete the whole platform mandate and must not be advertised as a complete automated global collection system.** The missing provider lifecycle, global compliance/scale evidence and outstanding module acceptance remain release blockers for those claims.
