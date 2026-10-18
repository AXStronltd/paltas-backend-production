# Developer command centre and onboarding

## Scope and shared architecture

New `GET .../developer/command-center` combines four all-time figures, active-project cards, recorded sales activity and the existing permission-filtered approval inbox. Existing detailed ledger comparisons, setup checklist, project screens and migration workflows remain available.

Definitions are explicit in the UI:

- Portfolio value is current unit list prices, not recognised revenue.
- Collected is net verified instalment allocations. Unverified reported payments are excluded.
- Outstanding includes unpaid future scheduled instalments; it is not restricted to currently billed ledger receivables.
- Expenses are approved construction invoice net values minus credits, excluding draft/disputed costs and retention-release duplicates.
- Construction progress uses the project's saved percentage; sales progress counts sold/handed-over units.

Recent buyer names are subject to developer.buyers.read and assigned-agent restrictions, independently of report access.

## CRM

`PUT .../developer/buyers/:buyerId/stage` persists enquiry/contacted/site_visit with an optimistic version and audit entry. Organisation and assigned-agent checks apply. Open offers/reservations/contracts prevent unsafe manual rewinds. Reserved and Contract Signed columns derive from the actual sales records; dragging there opens the sales workflow, never fabricates a binding sale.

## Setup reminders

Migration 0023 adds private per-user alerts and a campaign eligibility boundary. Welcome is due immediately, import after one day, budget after three days, measured from the Developer subscription creation time. Completed tasks suppress their reminders; read/dismissal state is saved for each member. Budget completion requires an explicitly set original budget, not merely a generated empty budget row.

The platform scheduler checks every 15 minutes. Email uses the existing platform notification outbox/provider, respects transactional channel consent, requires verified administrator email, excludes suspended/expired trials and deduplicates by member/step. Only Developer subscriptions created after this migration receive campaign emails: existing customers are not retroactively emailed. In-app reminders remain available for incomplete existing setups. Recording an outbox message does not claim delivery.

Copy describes useful actions without claiming that importing data automatically approves construction expenses or replaces every external CRM.

## Public project enquiries

No project becomes public by default. Verified members with project-write permission and an active CRM entitlement can explicitly publish a project page. Only project name, location and construction progress are returned publicly. Unpublishing, suspension or inactive entitlement prevents public reads and submissions.

Consented enquiries use the company's shared prospect contact store, enter its real buyer pipeline, are assigned to a sales agent (administrator fallback) and create a follow-up task including the message. Duplicate simultaneous submissions do not create duplicate buyers. Existing buyer stages are preserved. IP rate limiting and a company daily cap bound intake. No reservation, contract or financial transaction is created by an enquiry.

## Import

Settings → Import Data opens the existing server migration pipeline. CSV column mapping, source IDs, validation, dry run, independent approval, server-side import and financial reconciliation are retained. Payment histories must be mapped to the correct contracts/instalments; importing is not a payment-provider transaction.

## Release order

1. Apply additive migration 0023 on isolated staging; deploy backend first.
2. Deploy matching frontend preview with the generated client pinned to the backend candidate.
3. Run permission/isolation/reminder tests, all regression tests and Chromium journeys.
4. Back up production, deploy backend, verify readiness, then merge/deploy frontend under the user's existing approval.

New customer route: /developer-dashboard. Published enquiry pages use /development-projects/:slug. Marketplace design is unchanged. No existing customer business records are deleted.
