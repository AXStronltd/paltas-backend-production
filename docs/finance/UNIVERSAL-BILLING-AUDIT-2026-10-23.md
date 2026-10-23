# Universal Charges, Billing & Collections — Phase A audit

Date: 23 October 2026. Branch: `codex/universal-billing-20261023`.
Scope: repository audit and isolated automated tests; this is not a live provider/onboarding or production data audit.

## Executive finding

PALTAS already has one shared accounting ledger, event inbox, notification outbox, scheduler, contacts store and access service. Customer invoices, receipts, collections and refunds still have product-specific records and orchestration. Platform subscription invoices are a separate business concern and must remain separate.

The requested universal workspace and complete shared customer-billing lifecycle are **not yet implemented**. Existing financial functionality must be preserved through adapters and explicit migration rather than a wholesale rewrite.

## Confirmed implementation and gaps

| Area                | Existing implementation to reuse                                                                                                                     | Confirmed gap / risk                                                                                                                                                                                                              | Priority |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Ledger              | `server/src/core/ledger/ledger.service.ts`, `ledger.repo.ts`; balanced journal validation, closed periods, approval, reversals and source references | Currency comes from organisation, not individual invoice. Foreign minor units must never be posted as if base currency.                                                                                                           | Critical |
| Payment events      | `core/payments/payments.service.ts`; provider/event advisory lock, transactional event deduplication, product handler dispatch                       | Product handlers have different allocation and refund rules. Shared initiation, provider onboarding and complete refund lifecycle cannot be inferred from callback handling.                                                      | Critical |
| Providers           | `core/payments/providers.service.ts`; payment references, callback translators and bank matching                                                     | Adapter descriptions explicitly report integrations as disconnected. Code presence is not evidence of live merchant approval, settlement or refund capability.                                                                    | Critical |
| PM charges          | `products/property/billing/billing.service.ts`; rent, recurring/metered charges, invoice lines, credits                                              | Categories and invoice orchestration are PM-specific. PM reports select product-specific posting sources. Source changes without compatibility would break statements.                                                            | High     |
| PM collections      | `products/property/payments/payments.service.ts`, `shared/posting.ts`, `shared/finance-transaction.ts`                                               | Owner obligations, deposits and agency revenue use distinct accounts and collection-time recognition; must preserve these distinctions. Existing organisation finance lock must coordinate with shared operations.                | Critical |
| Stays               | `products/agency/stays/stays.service.ts`                                                                                                             | Advance guest payments are liabilities until completion; owner share and management fee separated. Current payment path refuses overpayment and restricts completed-stay refunds. Universal support needs controlled integration. | High     |
| Hotels              | `products/hotel/folios/folios.service.ts`, `billing/billing.service.ts`                                                                              | Charges are posted through folios before invoice documents are issued. Issuing another universal posting for the same document would double-charge. Cashier/shift and business-date rules must remain enforced.                   | Critical |
| Developers          | `products/development/collections/collections.service.ts`                                                                                            | Reported payment and independently verified receipt are different states; contracts, instalments and recognition cannot become immediate generic revenue. Supplier invoices remain purchase-side records.                         | Critical |
| Security            | `products/security/finance/billing.service.ts`                                                                                                       | Existing contract-period billing can later use the same service. Payroll is not a customer charge.                                                                                                                                | Medium   |
| Beneficiaries       | `products/property/setup/ownership.service.ts`, `products/property/accounts.ts`                                                                      | Universal lines need verified payer, beneficiary, collecting org, agreement and accounting-policy references; category name alone cannot authorise a charge.                                                                      | Critical |
| Notifications       | `core/notifications/notifications.service.ts`                                                                                                        | Shared outbox already distinguishes queued/sent/delivered. Additional channels require configured providers and consent; do not infer delivery from enqueue.                                                                      | High     |
| Recurrence          | `core/scheduler/types.ts` and scheduler services                                                                                                     | Job/period uniqueness does not replace per-obligation/per-period invoice uniqueness. Generic batch exception/retry UI remains missing.                                                                                            | High     |
| Product integration | `products/registry.ts`                                                                                                                               | Registry already exposes product routes, usage, payment handlers and jobs. Add an authority adapter rather than importing product internals into core.                                                                            | High     |
| Money               | `server/src/lib/money.ts`, `contracts/src/common.ts`                                                                                                 | Major/minor conversion assumes zero or two decimals; three-decimal currency support and explicit FX policy require work. Shared quotes must operate in provided minor units only.                                                 | High     |
| Workspace           | Existing PM, hotel, agency and development finance screens                                                                                           | No evidence of one cross-product Charges & Billing workspace. Do not claim that existing screens satisfy the requested universal experience.                                                                                      | High     |

## Accounting invariants

- PM invoices debit tenant receivables and credit billed/uncollected obligations. Owner payable, deposit held and agency income recognition happen through their appropriate collection flows.
- Hotel folio invoice generation must reference existing journal entries rather than reposting the folio.
- Stay advances remain guest liabilities until the relevant service/checkout recognition event.
- Platform subscriptions (`billing_invoices`) are PALTAS's own SaaS receivables, not customer rent or guest-service invoices. No sharing of Stripe merchant credentials is implied.
- An operating expense cannot itself create a customer or owner charge. Any recovery requires a separately authorised obligation.
- No old ledger entry should be edited, deleted or posted a second time during migration.

## Phase A checks

Executed 7 existing suites, all passed: 62 tests.

- `server/test/ledger.test.ts`
- `server/test/property.acceptance.test.ts`
- `server/test/hotel.billing.test.ts`
- `server/test/agency.acceptance.test.ts`
- `server/test/development.acceptance.test.ts`
- `server/test/provider-adapters.callbacks.test.ts`
- `server/test/notifications.outbox.test.ts`

These tests validate the existing baseline only; they do not certify the 25 new universal journeys, live bank rails, live refunds or the new workspace.

## Files changed in Phase A

This audit document only. No migrations, production records or provider configuration changed.

## Dependencies and limitations

Actual provider capability, merchant ownership, jurisdiction, currency, contractually permitted fees and business tax configurations must be checked during integration. Unknown authority must fail closed. No production owner/unit mapping can be inferred from building names or counts. Live readiness requires all acceptance journeys and a staging cutover/reconciliation rehearsal.
