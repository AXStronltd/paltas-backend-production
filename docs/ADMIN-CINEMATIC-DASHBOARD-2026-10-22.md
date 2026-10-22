# PALTAS Super Admin — cinematic dashboard

## Audit

The previous production portal contained secure staff MFA, role-gated mutations, organisation management, team, subscriptions, catalogue, approvals, support, jobs, audit and social campaigns. Its plain overview had totals and queues but no historical chart or platform metadata browser. The new composition reuses all existing workflows and route hashes, adding focused read-only admin views.

## UI and integration

- Cinematic architectural hero with a decorative globe, original PALTAS logo and established navy/turquoise/cyan palette.
- Global search across authorised organisations, people, property/project/site metadata, bookings and documents; explicit submission and bounded results.
- KPI cards from live totals: organisations, PM properties, current PM units excluding archived blocks, client accounts and recorded bookings.
- Real UTC daily creation series over 7–90 days, with interactive organisation/user/booking selection and accessible data tables. No invented percentage growth or revenue.
- Product subscription distribution and product tiles linked to filtered subscription management. Counts include all subscription statuses, explicitly labelled.
- Recent organisations, recent audit activity, existing decision queues, current subscription finance by original currency, quick actions and real API/database readiness.
- Properties, Bookings and Documents metadata browsers with filters, search, pagination and links to existing company controls.
- System Settings links to six existing audited workflows; old trial policy, invoices, prices, jobs, moderation, sign-ups, team and marketing remain accessible.
- Responsive original glass theme, persisted dark/light/system choice, reduced-motion and reduced-transparency fallbacks, accessible controls and keyboard account menu.

## Backend integrity

Two GET endpoints under existing staff authentication: /api/v1/admin/dashboard-insights and /api/v1/admin/platform-records. Existing staff read policy applies; customer/anonymous requests are rejected. Query ranges and page sizes are bounded. SQL sources are fixed allowlists; all filters use parameters. Responses expose metadata only, not file bytes, guest private codes, bank credentials or document contents. No database migration or production record mutation is required.

Client portal UI source and Marketplace functionality are unchanged. The shared generated API client and its embedded copies update mechanically for the two new endpoint contracts. No client route, design, subscription configuration, Stripe account, payment rail or permission is changed.

## Honest limitations

- Platform-admin AI document processing is not configured. Documents & AI presents metadata and explains that no files are sent to an AI service.
- Payment-provider and AI-service health are not monitored by these APIs and are labelled Not monitored. API/database readiness is a point-in-time check, not an uptime guarantee.
- Booking metadata combines Agency booking records and Hotel reservations. It does not present all bookings as confirmed or paid.
- Growth measures UTC creation events, not product engagement or net recurring revenue. Monetary totals are subscription invoices only, in separate currencies.
- No additional packages, paid services, credit purchases, GitHub Actions runs or bank/payment configuration are requested.

## Checks

Results and exact deployment identities are recorded in the final release report. Browser screenshots use synthetic isolated data and do not represent real customer inventory.

## Final local verification

- Backend full regression: 751 tests, 118 files passed.
- New dashboard service tests: 6 passed (included in full regression): staff/customer isolation, actual counts and dates, archived units, safe metadata, filters and paging, bounds and no mutation.
- Cinematic browser journey: 27 checks passed, including all 23 sidebar destinations, date range/metric controls, property/product filters, global search, existing organisation form, settings links, desktop/tablet/mobile, dark/light contrast and unavailable-source recovery.
- Existing admin console: 29 checks passed. Existing marketing: 7 checks passed.
- Staff sign-in security/UI checks and 28 shared-glass checks passed.
- TypeScript, backend ESLint, Prettier, generated client parity, frontend admin lint, JavaScript syntax, generated-page parity and production build passed.
- Production dependency audit: zero known vulnerabilities at check time.

## Review outcome

Ready for coordinated deployment of the dedicated admin APIs before the frontend. No migrations or production data edits are required. Keep the tested release branches/commits pinned while GitHub source integration is pending. Actual deployment IDs and live verification belong in the final release report; do not infer that publication happened from these local checks.
