# Property finance operational completion register

Updated 28 October 2026. This register tracks unfinished work; screens/endpoints alone do not establish completion. Previous broad completion claims are not used as evidence. Bank/M-Pesa connectivity alone does not close this register.

## Current implementation slice — calendar rent accuracy

Confirmed defect: `rentLine` previously prorated only when a lease started after day one. It ignored an end date inside the month and used one rent value even when an approved rent step took effect mid-month.

Implemented:

- Clamp the billable interval to the inclusive lease start/end dates.
- Split at each effective rent step within that interval.
- Calculate each segment using actual calendar-month days.
- Accumulate exact integer minor-unit numerators with BigInt and round once for the invoice.
- Save the dates, segment rates/days and calculation method in the existing invoice-line pricing snapshot.
- Use the existing shared invoice issuer/ledger, activation preview, activation transaction and monthly scheduler. No parallel ledger or new invoice path.
- Reject periods outside the lease and calculated amounts below one supported minor unit.
- Preserve existing invoices: no retrospective rewrite, migration or backfill.

Focused tests cover unchanged full/first-month amounts, final months, short leases, one-day occupancy, leap/non-leap February, rounding, exact high-value arithmetic, rent changes, invalid periods, preview rollback, issue amount, concurrent duplicate prevention, immutable invoice data and balanced journal entries.

## Open delivery gates

| Capability                   | Remaining implementation or verification                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly/custom rent schedules | Explicit contract rate/cadence and anchor; per-lease schedule; nonoverlapping billable intervals; versioned amendments; preview; customer pause/resume; scheduler integration; uniqueness across manual/scheduled/activation paths; termination cutoff; UI and complete acceptance tests. Existing monthly rent must not be reinterpreted as weekly rent. |
| Advanced billing rules       | Configurable concessions/rent-free periods, all requested custom cycle combinations and approval rules; persisted price/tax evidence and acceptance scenarios.                                                                                                                                                                                            |
| Provider collections         | Organisation onboarding/capability gating, tenant mandates, confirmed attempts, retry/return/dispute handling, webhook authentication/dedup/order handling, clearing and settlement reconciliation.                                                                                                                                                       |
| Refunds and owner payouts    | Eligible amount/authority validation, approval, provider execution, pending/failed/completed state, idempotent recovery, journal and statement reconciliation.                                                                                                                                                                                            |
| Communications               | Verify configured email/SMS/WhatsApp delivery and callbacks, reminder deduplication/preferences and honest delivery status.                                                                                                                                                                                                                               |
| Reporting                    | Finish outstanding scheduled/export scenarios; reconcile totals/drill-downs by currency and accounting classification.                                                                                                                                                                                                                                    |
| Historical migration         | Actual customer workbook meaning/preview, duplicate prevention and opening-balance reconciliation accepted by customer; do not infer payments from charge columns.                                                                                                                                                                                        |
| Customer acceptance          | Almas opening balances, tenant/lease inventory, monthly invoice/collection/deposit/owner-statement workflow and corrections reconciled against source records.                                                                                                                                                                                            |
| Reliability/scale            | Monitored production worker execution, alert delivery, backup restore rehearsal and measured load at claimed volumes.                                                                                                                                                                                                                                     |

## Release discipline

Only verified changes may be released. Keep actual provider transactions and test-mode simulations distinct. Do not activate unavailable payment methods or claim worldwide collection coverage. Do not delete posted financial history or real tenants to make a test pass. Record exact tests/commit/deployment evidence in each delivery report.
