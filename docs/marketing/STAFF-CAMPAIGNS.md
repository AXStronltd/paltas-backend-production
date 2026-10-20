# PALTAS staff campaign manager

Super Admin → Marketing → Social campaigns. Draft captions for Facebook, Instagram, LinkedIn, X, TikTok and YouTube. Save drafts on the PALTAS backend, send for independent review, approve as a different administrator, export captions and schedule a staff handoff. No social account is connected and no post is automatically published by this release.

Uses existing MFA staff authentication. Customers cannot access these APIs. Existing super administrators can write; support accounts can read the API but this release retains the existing Super Admin portal access policy. No new staff roles or permissions are granted. The creator and last editor cannot approve their own draft. Any content edit clears approval and schedule. Concurrent changes require a reload. Cancellation keeps history. Every write is audited.

Only public https://paltas.io destinations are accepted. Staff must check factual claims, image licences, channel-specific content policies and consent before publication. Caption starters only combine the staff-entered title, goal and link; they are not AI. No provider credentials are requested or stored in this module. Scheduled handoffs are labelled Awaiting account connection and are not publishing jobs.

Before automatic publication: choose the PALTAS-owned accounts, configure official provider applications and OAuth credentials outside chat, implement provider-specific media/permissions/review requirements, secure encrypted token lifecycle, idempotent delivery/retries and per-channel receipts, test in provider-approved test environments, and approve the public posting policy. Appra and other Axstron products must not be connected.

Release order: backend migration 0027 and API first; then frontend with the identical generated API client. Production database changes require release approval. Frontend CI pins the backend implementation. Do not publish the frontend before the new backend is available.

Verification: backend marketing API tests and database-upgrade tests; frontend real-backend browser test with two synthetic MFA administrators, saved drafts, independent approval, UTC handoff and mobile layout. Tests use disposable local databases only. No live social posts or customer data were touched.
