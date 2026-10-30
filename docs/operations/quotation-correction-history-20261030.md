# Supplier quotation correction history — 30 October 2026

## Confirmed gap
`maintenanceService.addQuote` upserted the supplier quotation and logged a short description. Earlier quotation amount, lead time and document reference were not retained in that audit entry. Correcting a quotation therefore left incomplete evidence of what changed.

## Correction
Reuse existing work-order transaction, row lock, quotation table and audit history. Before the upsert, capture the previous quotation. Record original and replacement amount, estimated days, document reference and recording identity in the audit entry. Keep one current quotation per supplier. The existing work-order history displays the correction, formats monetary amounts using organisation currency and omits internal identity references from the customer-facing summary. No new financial engine, schema migration or invoice posting.

## Verification
`server/test/property.work-order-controls.test.ts` verifies a quotation correction from 120000 to 12000 minor units preserves both values and terms, retains one current quotation, and creates no journal entry. Existing tests cover property/organisation permissions, stale edits, terminal states and immutable completion evidence. `tests/property.work-order-controls.browser.test.js` verifies before/after document references and currency-formatted values at desktop, tablet and mobile sizes. Final execution logs and deployment identifiers are in task outputs.

## Limits
Values overwritten before this release cannot be reconstructed by the correction. This is a maintenance control improvement, not acceptance of the entire enterprise operations specification. Approval and billing workflows retain their existing rules.
