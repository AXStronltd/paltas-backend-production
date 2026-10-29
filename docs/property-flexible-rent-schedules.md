# Flexible rent invoicing

## Delivered scope

An authorised Property Management billing operator can open an active lease's **Rent schedule**, preview and enable weekly, monthly, quarterly, annual or custom-day (1–365 days) invoicing. The existing Rent Schedule/monthly-run page links to these lease controls. No separate ledger, payment engine or product portal is introduced.

This changes invoice frequency, not the lease's signed monthly rent. Rates and effective rent reviews continue to come from the existing lease/rent-step records. Custom weekly contract prices, rent-free periods, tax changes and other unimplemented enterprise billing rules are not implied.

## Customer workflow

1. Rent Schedule → Manage weekly or custom schedules → active lease → Rent schedule. The same control is available in Lease Details.
2. Configure cadence, first date, days after invoice issuance until due, and an authorised reason/agreement reference.
3. Review exact first interval, amount and due date. Confirm enabling. This saves the schedule, not an invoice or payment.
4. The existing shared scheduler creates due rent invoices each day at 06:00 in the organisation's timezone. An authorised operator can also preview and explicitly issue the next due interval.
5. Reopen and edit future intervals, pause automation or explicitly resume including catch-up intervals. Pausing does not waive rent, end the lease or delete invoices. Manual confirmed billing remains possible while paused.
6. Open issued invoices through existing tenant, invoice and financial workflows. Interval dates and calculation snapshots are retained.

First-time schedules start no earlier than today, at lease commencement or a month boundary. This avoids silently backdating rent or omitting a partial current month. Existing rent invoices are protected; when they cover the current month, the UI proposes the next unbilled month. Schedule changes retain the next unbilled date and apply prospectively. Completed schedules can be configured again after an authorised lease renewal provides remaining billable days.

## Calculation

For each calendar month, calculate the lease's cumulative agreed rent through the interval end and subtract the cumulative amount before the interval start. Each cumulative amount uses actual calendar days, effective rent steps and integer minor-unit arithmetic, rounded once. This partitions a month exactly: weekly invoices for the whole month sum to its agreed monthly calculation without accumulated rounding drift. Multi-month intervals retain each month's own denominator. Amounts are never summed across currencies.

Month cadences retain their anchor day (31 January → 28/29 February → 31 March). The final interval is clipped to the lease end date. Management authority must cover the entire interval without changing agreements; catch-up invoices use the agreement for the billed interval, with a current issue date. Missing authority blocks billing and records a visible error rather than advancing the cursor.

## Integrity and access

- Organisation financial transaction lock and the existing lease/invoice issuer serialise manual, scheduled, configuration and monthly-run operations.
- Monthly runs explicitly skip leases using flexible schedules, including paused/completed schedules; switching cadence is performed through the same schedule controls, not by silently restarting legacy monthly billing.
- Explicit rent interval metadata prevents overlapping invoices in the issuer. Billing-key and interval-start unique indexes defend retries. The previous calendar-month unique index remains for legacy invoices.
- Preview hashes reject stale rent, authority, date or version changes; configuration edits use optimistic versions. Unbilled future intervals cannot be issued early.
- Existing server billing capability, finance plan entitlement, organisation boundary and delegated property scopes apply. Scheduled handlers recheck subscription entitlement.
- Rent reviews/renewals cannot reprice a posted interval; use an unbilled effective date or the existing audited invoice-correction workflow.
- Schedule configuration, pause/resume, completion and invoice issuance create audit records. Existing financial entries are never deleted or rewritten.
- Background processing is bounded to 100 due schedules per property per run and 50 catch-up intervals per schedule; cursors persist between runs. Failed attempts retain the cursor and expose an actionable error. These limits are not a claim of verified enterprise throughput.

## APIs

All paths are under `/api/v1/orgs/:orgId/property/leases/:leaseId`:

| Method | Suffix                       | Purpose                                 |
| ------ | ---------------------------- | --------------------------------------- |
| GET    | `/rent-schedule`             | Current configuration                   |
| POST   | `/rent-schedule/preview`     | Non-posting configuration preview       |
| PUT    | `/rent-schedule`             | Versioned preview-confirmed enable/edit |
| POST   | `/rent-schedule/status`      | Confirmed pause/resume with reason      |
| POST   | `/rent-schedule/run-preview` | Non-posting next-interval preview       |
| POST   | `/rent-schedule/run`         | Confirm one due invoice                 |

## Migration and rollout

`0058_property_rent_schedules` adds the schedule table and optional invoice metadata/indexes. It does not change invoice amounts, journals or inventory IDs. Existing records receive null metadata; their calendar-month coverage is interpreted conservatively. Tests reconstruct the pre-0058 schema with posted rent and verify all original invoice values, journal entries/lines and unit rows survive unchanged; legacy duplicate protection remains.

Deploy backend/migration before publishing the frontend. No schedules are created or enabled automatically for existing clients. Enabling a schedule is an explicit authorised client action. Verify the production scheduler worker is enabled and monitor actual job execution; a successful synthetic scheduler test is not proof of production timer operation.

Do not roll back the schema or delete new invoices. If an application rollback is needed after customers enable this feature, first pause affected billing jobs and review legacy monthly automation: an older application does not understand new schedule configuration. Prefer a tested forward fix; preserve invoice/ledger history.

## Verification / limits

See the dated release report for exact completed test runs, commits and production evidence. Focused tests cover boundaries, rounding, cross-month amounts, preview/confirmation, actual scheduler dispatch, concurrent billing, edits, pause/resume, missing authority/recovery, interval-based authority, termination, posted-rent amendments, duplicate protection and organisation/property/role isolation. Browser journeys cover 1440, 768 and 390px, persistent edits, navigation, keyboard close, confirmation, future-issue guard and no horizontal overflow.

This feature invoices rent. It does not initiate or confirm bank, card or M-Pesa payments, settle funds, execute refunds or distribute owner payouts. Those provider-dependent capabilities remain separate open gates.
