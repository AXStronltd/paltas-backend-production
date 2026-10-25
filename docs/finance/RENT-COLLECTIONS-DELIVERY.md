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

## Increment 2: saved multi-line charge invoice drafts

Implemented create, list/paginate, reopen, repeat edit, independent review/approval, return for edits, archive/restore, eligible draft deletion and explicit issue confirmation. Optimistic versions reject stale edits. Concurrent issue retries return the same invoice. Category configuration changes after approval require renewed review. Issued draft records are immutable in the database.

The existing charge invoice issuing function is shared by immediate invoices and saved drafts; accounting is not duplicated. The additive migration `0040_property_invoice_drafts.sql` creates operational draft records and composite organisation foreign keys. It does not recalculate or backfill customer financial transactions. Rollback the application only; retain the additive table and posted invoice history.

Two authorised users are required to approve a saved draft; existing immediate invoice creation remains unchanged. Metered charges continue through readings-based billing. Full template/attachment/recurrence/multi-currency/branding/export coverage remains incomplete. No automatic invoice email or money movement is triggered.

The owner subsequently clarified that partial implementation is not accepted. Production deployment is blocked until the complete enterprise acceptance standard is met. Do not publish individual increments as the finished product.

## Full-completion release policy

The owner's latest clarification rejects partial implementation and partial deployment. No deployment commands, publication or production migration were performed. The local `npm run release:rent-collections:check` gate is expected to fail until each tracked requirement and all 14 journeys have verification evidence and customer acceptance is recorded. It is a local release check, not a claim that hosting-provider publication controls have been changed.

`rent-collections-acceptance.json` tracks 374 individual requirements plus the 14 mandatory journeys. `implemented_subset` records existing/new functionality without promoting it to full-enterprise verification. `pending` means evidence still needs to be completed; it does not imply every underlying component is absent.

Draft approval now fingerprints payer/unit/management context as well as category settings. A change requires renewed approval. Charge quantity precision matches the existing invoice database column (three decimals). Drafts and immediate service invoices use the existing shared exact-money calculator; confirmation displays the server-calculated total. These changes do not introduce a second financial ledger.

## Increment 3: billing disputes and tenant review history

Added tenant-owned invoice queries, manager review/resolution/rejection, reopening and withdrawal with optimistic versions and immutable event history. A case may link an actual posted credit note on the same invoice, issued after the case opened; it cannot create a credit, refund, payment, lease termination or access restriction. Invoice correction reuses the existing invoice credit action. Resolution history and current balances are visible to the tenant.

Additive migration `0041_property_billing_disputes.sql` creates operational case/event records and organisation-scoped invoice/credit foreign keys. Existing invoices, readings and financial history are unchanged. Only one active query per invoice is permitted. Lists are paginated and restricted by organisation, property assignment and tenant identity.

Verification: five backend dispute tests; 43 focused backend tests including billing acceptance, operations, draft controls and additive upgrades; 18 browser checks at 1440/768/390 px exercising tenant query → manager invoice credit → linked resolution → tenant balance/history. Browser tests initially selected background invoice controls while a modal was open; selectors were scoped to the active modal and rerun successfully.

This completes a supported dispute journey, not the whole utilities/arrears specification. Meter lifecycle, estimates, shared allocation, repayment/reminder automation and other acceptance gaps remain open. No production release performed.


## Increment 4: reviewed repayment plans and promises to pay

Added balanced instalment proposals against one existing unpaid invoice. Tenants can propose, repeatedly edit and withdraw their own unapproved proposals. Authorised managers can review/approve, pause/resume tracking, cancel, complete fully settled arrangements and reopen unpaid closed arrangements as proposals. Company administrators may explicitly approve an operational tracking proposal; delegated managers cannot approve their own creation or last edit. This does not attest legal validity or change a signed contract.

Progress is derived from existing invoice allocations and credit notes, not a second ledger. Payments and credits are labelled settlement, not cash receipts. Approvals recheck the current balance; stale versions and duplicate live arrangements are rejected. Completed history remains retained after a later receipt reversal and flags the renewed debt for review. Pausing a plan does not waive fees, change the original invoice due date, stop recurring billing or restrict access.

Additive migration `0042_property_collection_plans.sql` stores plans and immutable events only. Organisation/property/tenant scopes, explicit reasons, audit entries and pagination are enforced. No real customer records were changed. No migration or release was run in production.

Verification: 21 browser checks at 1440/768/390 px exercised tenant proposal → repeated edit → manager approval → actual partial receipt → tenant instalment balance/history. The first run correctly rejected a future-dated test receipt; the fixture was corrected and all three viewport journeys passed. Backend coverage includes balancing, credits, reversals, stale edits, own-tenant and assigned-property isolation, independent manager review, immediate grant revocation and retained withdrawal history. Automated reminders, multi-invoice arrangements, legal agreement signing and scheduled communications remain separate open requirements; no whole-programme completion claim is made.

Final increment-4 verification: the broad suite passed 131 files / 859 tests before history snapshot hardening. After snapshot hardening, 26 focused tests passed across collection plans, manager controls and safe migration/upgrade checks. Immutable event snapshots preserve each previous schedule, approval status and version when proposals are edited or closed plans are reopened. Database triggers reject event changes and deletion.


## Increment 5: configurable collection reminders and honest delivery tracking

Added property-scoped reminder policies with reviewed templates, up to 12 due-date offsets, optimistic policy versions, explicit automation confirmation and opt-in scheduling. Automation defaults off. Authorised managers can preview unpaid invoices, inspect exact messages, select recipients and confirm a batch. Preview hashes bind the current amount, registered recipient, wording, policy version and eligibility. Stale confirmations fail before any batch messages are recorded.

The existing transactional notification outbox, consent checks, provider dispatch, retry handling and signed delivery reporting are reused. No second messaging system or ledger is introduced. A recorded message is not represented as sent/delivered. SMS/WhatsApp are not falsely offered as configured channels by this increment. Manual and automated reminders use the same eligibility and recording service.

Scheduled work uses the existing scheduler in the organisation's time zone, bounded batches of 100 and current finance entitlements. The authorising member's active role/property grant is rechecked at execution; revoked authority stops automation. Open billing queries and approved active/paused plans are skipped by default. Each invoice can receive at most one recorded reminder per day and one per reached stage/due date. Catch-up uses only the latest reached stage. Consent suppression, original due dates, lease states and access rights remain separate.

Additive migration `0043_property_collection_reminders.sql` creates policies and immutable outbox links with organisation/property/invoice relationships; it does not update customer invoices or financial balances. The property organisation identity index supports those foreign keys. No production migration was performed.

Verification: 58 focused backend tests across reminders, invoice emails, plans, disputes, drafts, command centre, manager controls and migration upgrades passed. Seven reminder tests include real localhost fake-provider acceptance, transactional opt-out suppression, stale and concurrent confirmations, no ledger changes, plan/dispute skips, scheduler execution after authority revocation, scope isolation and immutable history. An initial provider fixture incorrectly returned one provider-message ID for two messages; it was corrected to generate unique IDs. A scheduler fixture needed a pause reason to satisfy the existing schema; that was corrected. Both runs were rerun, not ignored.

The responsive reminder journey passed 18 browser checks at 1440/768/390 px: save policy with automation off → review a registered recipient → return with selection preserved → explicitly record selected messages → inspect actual status. No real customer email or external provider call was performed in browser tests.

Remaining scope: SMS/WhatsApp configuration-specific journeys, repayment-date reminder policies, communication preference UI coverage, escalation/legal policy adapters, enterprise throughput and failure-recovery acceptance still need verification. Broad enterprise readiness is not implied by this supported email-reminder journey.

Final increment-5 verification: **132 suites / 867 backend tests passed** after all reminder guards and concurrent confirmation tests. TypeScript, lint, generated frontend comparison, production build and 18 responsive reminder browser checks passed. This is not acceptance of the remaining enterprise requirements. No production release was performed.


## Increment 6: partial deposit settlements and residual liability

Extended the existing settlement request with an optional `settlementMinor`. Omitting it preserves the existing full-balance workflow. The requested release can include authorised arrears, deductions and a refund; the unreleased amount remains held as a deposit liability. A request snapshots the available balance and approval rechecks it. The original deposit, owner allocation and client-bank posting services are reused; no alternative ledger is introduced.

`0044_property_partial_deposit_settlements.sql` adds an optional balance snapshot and replaces the single-lifetime-settlement index with a one-pending-request index. Existing approved records, journal entries and customer data are not changed. A later request can release the remaining deposit after prior approval. Concurrent pending requests are rejected with an actionable conflict rather than a database error. The same requester cannot approve; existing finance-role restrictions remain enforced.

The manager form shows the current held balance and permits a chosen release amount. Independent approval shows the available, released, retained, deducted and refunded amounts. Settlement history labels retained amounts as historical values after that settlement, not today's current liability. Today's remaining balance still comes from the existing lease/tenant ledger calculations. Older records without snapshots continue returning their original full-release semantics.

This extends manual recorded settlement only. It does not execute a bank/M-Pesa refund, label an unverified transfer completed, implement automated provider refund retries or change existing bank-posting semantics. Provider execution and reconciliation acceptance remain outstanding. Historical leases continue avoiding automatic deposit/rent creation.

Increment-6 focused verification: 31 backend tests passed across partial deposits, the complete existing accounting acceptance journey, receipt reversals and migration/upgrade checks. Twenty-one browser checks passed at 1440/768/390 px: finance request → independent approval → retained liability → return for another release. Tests initially used the organisation administrator for an action reserved to finance; fixtures were corrected to use the existing finance roles. The browser fixture also respected the historical no-automatic-deposit rule by using a pinned local business date. A reload assertion was made to wait for the actual async screen before checking its action. These fixture corrections do not change production permissions or historical billing behaviour.

Final increment-6 backend regression: **133 suites / 871 tests passed** on the final built schema and services. TypeScript, ESLint, focused formatting checks, generated API-client consistency, frontend generated-source verification and production build passed. Production remains unreleased while the full-programme acceptance gate is open.

Final-schema browser regressions passed: collections overview 18, saved invoice drafts 15, billing disputes 18, repayment plans 24, collection reminders 18 and partial deposits 21 — **114 checks total**, each across 1440/768/390 px. Generated production artifacts match the verified sources. The enterprise acceptance gate remains open; no production deployment was performed.


## Increment 7: physical utility meters, reading revisions and estimate controls

Extended the existing utility readings and monthly charge run rather than adding a second billing engine. Physical meter serials, unit/service assignment, installation opening values, monthly coverage, actual closing values and replacement history are now recorded. Overlapping meter assignments and duplicate serials are rejected. A replacement starts at the next monthly boundary; mid-month splits/rollovers and shared-meter allocation are not represented as supported by this increment.

Unbilled readings can be repeatedly corrected with a current version and reason. Earlier values, estimation evidence, actor names and timestamps are retained in immutable event snapshots. Legacy readings remain usable; their first audited correction captures an explicitly labelled old-state snapshot. Registered-meter continuity validates opening, neighbouring readings and final values. Closing requires an actual final reading. Billed readings remain immutable through service validation and a database trigger; the UI directs correction to the posted invoice/credit/query workflow.

Estimated readings require evidence and an explicit billing-run confirmation; automated runs do not silently approve estimates. Future months cannot be entered as actual usage. Billing reuses existing exact metered/tiered pricing and double-entry postings. Invoice line snapshots retain reading ID/version/kind/evidence and physical meter identity. Existing tariff serial snapshots remain preserved when no physical registry serial exists. Registering a physical meter over unbilled legacy readings requires an explicit reading review/link before billing; no financial history is reassigned automatically.

Additive migration `0045_property_utility_meter_lifecycle.sql` creates meter/event records and reading revision metadata. Existing invoices and amounts are not recalculated. Read/modify/history access is organisation/property scoped, including delegated managers. The current registry list is paginated; full enterprise workload tests remain open.

Focused verification initially caught a tariff-serial snapshot regression and a scoped-list request perimeter omission. Both were corrected. A later test fixture attempted to enter future usage as actual; its business date must reflect the measured month without removing the guard. Complete final regression evidence is recorded after that fixture correction. Initial responsive verification passed 27 checks covering register → estimate → correct/reopen → preserved history → explicit billing approval → locked source → actual closing reading → meter closure at desktop/tablet/mobile sizes. No production migration, deployment, email or payment-provider call was performed.

The final meter UI passed 27 responsive browser checks with actor-labelled revision history and the existing design. TypeScript, lint, generated-source comparison and production build passed. The broad run at this checkpoint had 875 passes and one future-date fixture failure (876 total); the fixture was corrected to use November's business date when recording November usage. This is not reported as a fully passing broad run until rerun.

After the future-date fixture correction, all 35 focused meter/tariff/accounting/migration tests passed. The actual-reading guard remains enabled. No production changes were made.
