# PALTAS shared product activity — phase 1

25 October 2026

## Objective and architecture

Extend the existing organisation contact store and activity timeline. Do not introduce another CRM, in-memory customer database, financial engine or autonomous physical-access system.

This phase adds verified internal activity provenance for three existing workflows:

- Property Management: lease activation.
- Property Management: payment recording (a record is not evidence that a provider transferred or settled funds).
- Agent / Host: completed short-stay checkout.

Existing product IDs (`property`, `agency`, `developer`, `hotel`, `security`) remain authoritative. Short stays belongs to Agency / Host; property maintenance remains a product workflow, not an invented separately authorised product.

## Implementation

Migration `0039_contact_product_activity` adds nullable `source_product`, `event_type`, `event_key` columns to the existing contact activities table, with complete-provenance constraints and a unique organisation/product/event identity. Legacy entries are not relabelled or guessed.

The internal `core.contacts.productActivity` projector:

1. Accepts only an explicit, typed allowlist of event types.
2. Derives product, activity kind and reference type from that allowlist.
3. Checks the source record's organisation, associated contact and completed business state.
4. Validates the summary length.
5. Serialises concurrent deliveries and records the event once.
6. Preserves the original author, summary and time on replay.
7. Writes within the caller's business transaction.

The activity and business result either commit together or both roll back. Lease activation previews therefore leave no false activation activity. Existing activation and payment timeline entries are enhanced rather than duplicated. Checkout adds an internal activity, not a communication delivery record.

There is no public generic event-dispatch API. Public note creation cannot set verified product provenance. No caller-supplied origin string is accepted as authority.

## Read permissions

The contact-detail API rechecks active membership, product-specific roles and product read capability on every request. New attributed entries from a product the viewer cannot read are omitted. Existing sessions do not cache the grant decision.

Property-scoped managers see new lease events only for assigned properties. New aggregate payment events and other-product events are hidden from scoped managers; approved financial screens retain their own permissions. Legacy unattributed activities keep their existing shared-contact behaviour. This release does not claim a retroactive reclassification or privacy audit of all old timeline data.

The existing Property Management contact profile displays the product label using PALTAS's current tag styling, accessible text and layout. No replacement navigation or login system is added.

## Explicit boundaries

- No automatic resident lockout for arrears.
- No owner or biometric bypass privilege inferred from a purchase.
- No hardware access, credential revocation, lease termination or refund performed by these events.
- No automatic sales enrolment, marketing communication, lead-score change or legal/compliance classification.
- No communication labelled SMS/email/WhatsApp unless it is a corresponding message workflow.
- No profile or event shared across organisations.
- No historical event backfill.
- No external event consumers or asynchronous broker delivered in this phase. This is an atomic internal projection, not a claim of a complete cross-product event bus.

## Subsequent phases

1. Add other verified product activity producers individually with source checks, per-product visibility and regression tests.
2. Design a transactional outbox, consumer-specific delivery state, retry/backoff, dead-letter review and operator controls **before** introducing asynchronous/external consumers. Do not add infrastructure merely to asynchronously duplicate an in-database timeline write.
3. Add consent-aware, opt-in cross-product recommendations using supporting records; human review for significant decisions.
4. Integrate approved hardware providers only through scoped, booking-specific credentials, expiry, acknowledgement and authorised review. Keep physical access decisions independent from arbitrary debt/lead scores.
5. Add context links only to existing authorised product routes, preserving the existing product switcher and workspace boundaries.

## Verification

- 127 backend test files, 832 tests passing; lint, type checks, build and generated client checks passing.
- Targeted tests cover concurrent deduplication, wrong organisation/contact/source, preview rollback, recorded-payment provenance, product-grant revocation in existing sessions, assigned-property isolation, public provenance-forgery attempts and genuine agency checkout.
- Browser ownership-to-activation-to-contact journey: 21 checks, desktop and mobile origin labels, tablet/mobile correction layouts, no page overflow and no browser exceptions. Synthetic local PostgreSQL data only.
- Production build/generator verification passes. Existing financial accounting tests remain part of the full backend suite.

## Release and recovery

Deploy the additive backend migration first, then its frontend. No production leases, payments, profiles or credentials are modified for testing. Preserve product-origin filtering in any rollback or compatibility patch: an older application that ignores provenance does not enforce the new product-level visibility rule. Prefer a forward fix or a compatibility version retaining that filtering. Do not delete event history or drop provenance columns as a rollback shortcut.
