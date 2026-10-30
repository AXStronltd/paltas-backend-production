# Operational CRM extension — 29 October 2026 (Toronto)

Extends the existing Property Management CRM. Contacts, enquiries, leads, viewings, applications, lease conversion, document links and financial activity remain on their existing services.

## Delivered workflows
- Tasks/follow-ups: create against a permitted property, optionally link an existing contact, assign an eligible active colleague, choose due time/kind/priority, search/filter/page, edit repeatedly, complete/cancel/archive and reopen. Optimistic versions refuse stale updates; idempotency keys prevent duplicate creation. No financial transaction is created.
- Calendar: monthly agenda combines saved CRM work and existing property viewings. Task month selection uses the organisation's time zone; entry clearly labels the device time zone. No separate event copy or duplicate viewing is created.
- Communication log: paginated, searchable existing contact messages with consent-blocked/recorded state and actual notifications-outbox delivery state. Provider accepted is distinct from delivered; test/queued is never delivered. Read-only delivery-connection inspection reuses notifications APIs. General messages still use the existing record/consent/outbox workflow. This does not provision SMS/WhatsApp providers or silently enable outbound delivery.
- CRM insights: actual pipeline record counts, open/won/lost counts, closed win rate and recorded source counts. No fabricated lead scores, marketing costs, reviews or attribution.
- Scoped Main Managers: pipeline, viewings, applications and the new workspaces enforce current delegation/property scope. Unassigned prospect creation and idempotent enquiry replay also check contact scope. Other-property leads cannot be read or moved. Message access retains tenant-view delegation safeguards.

## Persistence and security
Migration0063 adds only pm_crm_work and immutable revision snapshots. Shared contacts and notifications are reused. Every task links to the existing organisation/property and optional contact; assignee eligibility is verified server-side. Property cannot be changed by an edit. Contact relationships outside a manager's scope do not leak through task names, lists or history. Role revocation takes effect on subsequent requests. No permanent task deletion endpoint exists.

## UI and access
Existing PALTAS styles, sidebar, forms, modal error handling and busy states are reused. New screens are Tasks & follow-ups, Calendar & meetings, Messages and CRM insights. The pipeline provides direct navigation between them. Startup access restoration keeps CRM deep links after refresh; users without CRM authority do not get those navigation entries. Tenant portal access is not required or created. The business remains responsible for end-client communication.

## Verification
Focused backend suite includes repeat saves, UTC/local month boundary, concurrency, immutable history, lifecycle transitions, eligible assignment, duplicate requests, property/organisation isolation, revoked delegation, scoped Main Manager pipeline and real outbox-state projection. Typecheck, lint, additive-upgrade tests and existing CRM tests are included. Real browser/HTTP/PostgreSQL checks use synthetic records on desktop1440, tablet768 and mobile390; test accessibility and reload persistence. Exact final full-regression results and deployment IDs are recorded in release evidence.

## Operational limits
No AI scoring/drafting, advertising integration, external-calendar synchronisation, mass marketing campaign engine or unconfigured provider is presented as live by this release. Sender connections must be genuinely configured before messages can be delivered. Calendar is an agenda, not a drag/drop external-calendar client. Task history retains every revision and currently returns the latest100 per task; message/task lists are paginated. Eligible colleague lookup is capped at500. Live customer acceptance, high-volume load tests and actual message-provider delivery remain separate from synthetic acceptance.

## Rollback
Revert application commits while retaining migration0063 and its data. Do not drop customer task/history tables to roll back UI. No existing financial data, subscriptions or payment integrations are changed.
