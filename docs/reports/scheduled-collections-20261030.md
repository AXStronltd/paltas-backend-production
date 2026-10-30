# Scheduled collection reports — 30 October 2026

## Scope
Extend the existing collections exporter and core scheduler. Property managers can configure daily, weekly and monthly report preparation, pause/resume, archive/restore, prepare the last completed period on demand, review paginated runs and download retained snapshots. This is in-workspace reporting, not email/SMS/WhatsApp delivery or financial posting.

## Architecture and controls
- One durable core scheduler definition (`property.collection_reports`), one job per report schedule, using its saved organisation timezone and the existing cron/DST, lease, retry and deduplication engine.
- Daily: yesterday. Weekly: previous Monday–Sunday, prepared on Monday. Monthly: previous calendar month, prepared on its first day. The configured hour/minute are local to the saved timezone. A reviewed edit adopts the current organisation timezone.
- Existing `exportCollections` supplies the same authorised property snapshot and currency handling. Report content includes property and schedule names; filenames identify the property, schedule and period.
- Source balances are current at preparation time, labelled with the business date and creation timestamp; this is not reconstruction of a historic closed ledger.
- One saved snapshot per schedule/version/source window, including concurrent manual requests and scheduler retries. Edits create a new version. Old snapshots remain unchanged. A retry reuses an existing snapshot.
- Manual preparation is explicitly confirmed, including on paused schedules. Archived schedules must be restored before new preparation. Scheduling defaults to paused in the UI.
- At most 20 unarchived schedules per property, enforced across concurrent creation and restoration. Schedules and runs are paginated. Run listing reads metadata without loading file contents.
- Report preparation, changes and downloads are audited. Stored file content, dates and fingerprints are immutable; download verifies SHA-256 before serving content.
- Current role and property authorisation is enforced on all endpoints. Delegated managers also need financial-history permission. Schedule changes/preparation require both report-read and billing authority. The scheduler rechecks the last editor's current membership, active user, property delegation, financial permissions, organisation status and finance subscription before preparation.
- No tenant portal identity or external recipient is created. Financial journal entries and customer messages are unchanged.

## Client workflow
Collections overview → Scheduled reports → choose property → Add report schedule → review records/format/frequency/local time/status → Save reviewed schedule.
Manage supports repeated edits and lifecycle changes with a required reason. Prepared reports displays period, preparation date, schedule version, trigger, record count, fingerprint and a working download/print action. Scheduler result/error text is displayed rather than presenting a skipped preparation as a delivered report.

## Migration and endpoints
Additive migration 0064 creates `pm_collection_report_schedules` and immutable `pm_collection_report_runs` with scope and history indexes. Existing property, lease, financial and subscription records are preserved.

Endpoints under `/api/v1/orgs/:orgId/property/reports/schedules`: GET/POST root; PUT `/:reportScheduleId`; POST `/:reportScheduleId/run`; GET `/:reportScheduleId/runs`; GET `/runs/:reportRunId/download`.

## Verification
`server/test/property.report-schedules.test.ts` covers calendar boundaries, timezone review, persisted edits, stale versions, idempotency, concurrency, current grants and cross-property/organisation isolation, immutable downloads, archive/restore, caps, actual durable scheduler execution and revocation. Migration/live-upgrade suites cover the additive schema.
`tests/property.report-schedules.browser.test.cjs` uses real signup, isolated PostgreSQL, API and production frontend at desktop/tablet/mobile: persisted edits, activation, preparation, real receipt allocation in saved Excel, fingerprint matching, pause, archive, restore, accessibility and unchanged financial/message records. Existing export and insights journeys are rerun. Final results and deployment IDs are in task outputs.

## Operational limits
The server's existing scheduler worker must be enabled; production defaults to enabled, while isolated browser tests disable it and scheduler integration tests invoke its durable execution explicitly. Report files remain within the organisation. No automatic report email or new notification/provider integration is enabled. Reports remain bounded at 10,000 source rows; larger runs fail clearly and use the core retry/error trail. Narrower report windows or future background large-export support are required for larger output. No report retention purge is introduced; saved snapshots remain available according to current access. This does not certify enterprise scale, global tax compliance or completion of the entire platform specification.

## Recovery
Application rollback can disable new preparation without dropping the additive tables. Pause schedules if necessary and preserve all prepared reports/audit records. Do not delete financial history or drop customer tables as a rollback step.
