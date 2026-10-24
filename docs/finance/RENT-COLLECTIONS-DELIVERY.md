# Rent & Collections enterprise delivery gate

25 October 2026. **Not complete; not approved for production deployment.**

The approved specification is the acceptance standard. This implementation extends existing services. No existing navigation section is removed or renamed. Existing generated browser client metadata appears in other generated pages; their product workflows are unchanged.

## Increment 1: collections command centre

- New read-only, permission-checked collections report API.
- Receipt-date cashbook, current billed/open/overdue/due-today amounts, invoice cohort collection rate and distinct tenant status.
- Separate credits, bank matching and recorded receipts; no claim that bank matching equals settlement, profit or available cash.
- Today/yesterday/week/month/quarter/year/custom dates and property/building/unit/owner/tenant filters.
- Property-filtered cash includes direct payment allocations only. Unallocated funds and later credit applications cannot be safely attributed to a unit from existing records and are excluded with an explicit UI explanation.
- Paginated receipt and invoice records with existing detail workflows.
- Snapshot reads; no new ledger, no financial posting and no migration.
- Approval reversal removes the receipt from effective current report and restores balances. Historical reconstructions as of past dates remain a separate requirement.
- Reports use the organisation's existing PM currency; no multi-currency PM issuance is introduced.

## Mandatory programme gates — no item declared done merely because a screen exists

| Specification area | State after this increment |
|---|---|
| 1 Preserve existing product | Existing services reused; regression verification required for each increment |
| 2 Rent and billing engine | Partial: monthly terms/runs exist; flexible cycles, concessions, shared tenancies, commercial rules, multi-currency and draft lifecycle still required |
| 3 Invoices/receipts | Partial: issue/allocate/credit/email exists; full draft/template/attachment/download/archive/export controls remain |
| 4 Service charges | Partial: configurable customer charge types and tariffs; building assessments, mixed payer/share/exemption rules remain |
| 5 Utilities | Partial: readings/tariffs/billing; meter lifecycle, estimates, disputes, shared allocation, analytics and supplier reconciliation remain |
| 6 Payments | Partial: recording/allocation/reversal; unified initiation/status/investigation/provider lifecycle remains |
| 7 Clearing/reconciliation | Partial: manual import/matching/sign-off; grouped matching, fees and settlement exception workflows remain |
| 8 Arrears | Partial: ageing/late fees; reminder policies, plans/promises/disputes/escalation remain |
| 9 Deposits/refunds | Partial: existing settlement; partial residual liability and execution/failure tracking remain |
| 10 Multi-owner | Partial: existing statements/fees/payouts; ownership shares, execution tracking, scoped profitability/self-service gaps remain |
| 11 Financial command centre | Implemented first increment; pending alerts, pending-provider amounts, fees, account filter, scheduled reports and export coverage |
| 12 Customer self-service | Partial: repeat edits/corrections retained; full per-lifecycle control coverage not complete |
| 13 Tenant portal | Existing records reused; plans/disputes/settlement requests/download/payment capability gaps remain |
| 14 Owner portal | Existing records reused; full reports, permissions and profitability coverage remain |
| 15 Migration | Existing approved migration framework; competitor-specific fixtures, supported-domain coverage and reconciled journeys remain |
| 16 Accounting | Existing shared engine preserved; each added workflow requires balanced posting/reversal tests |
| 17 Scale | No claim of hundred-thousand-unit readiness; realistic workload/SLO/index/export/job tests remain |
| 18 Security/reliability | Existing isolation/approval/locking retained; full threat, recovery, monitoring and DR evidence remains |
| 19 UX | Existing branding/navigation retained; responsive first-increment review is not whole-product acceptance |
| 20 E2E scenarios | Current supported journeys tested separately; all 14 mandated scenarios must pass before release readiness |
| 21 Execution | Follow controlled increments; production deployment explicitly withheld |
| 22 Definition of done | OPEN: customer acceptance, full workflows, scale, integrations, monitoring and recovery gates not closed |

Provider-dependent methods stay unavailable until independently configured and verified. SMS/WhatsApp/bank/M-Pesa integrations are not represented as live by this change. No customer financial data is modified for testing. No market-ready claim is justified yet.

## Release and rollback notes

This is an unreleased development increment. Deploy neither repository until explicit production approval. Release the matching contracts/API and generated frontend together; an older backend does not provide the new report endpoint. No schema or data rollback is necessary for this read-only increment. Existing invoice, receipt and payment details are reused. Delegated managers require both reporting and tenant financial-history permission plus an assigned property.

Dates use the existing PALTAS business-date scope. This increment does not change the platform-wide clock or reconstruct historic as-of financial state. Reports describe current effective records and exclude approved reversals. The cashbook must not be used as proof of physical cash availability.

Known scale limitation: aggregates read the full selected invoice population; only detail lists are paginated. Enterprise workload tests, query-plan tuning and large export jobs remain mandatory before an enterprise-scale claim.
