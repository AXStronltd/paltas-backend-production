# Bank and M-Pesa connection readiness

## Architecture

Continue using the existing signed-event payments service, provider adapters, payment references and accounting services. Do not introduce another ledger or treat provider credentials as proof of operational readiness. Keep PALTAS subscription billing separate from organisation rent collections.

### Existing internal interfaces

- Signed generic events: `POST /api/v1/webhooks/payments/:provider`.
- M-Pesa relay callbacks: `POST /api/v1/webhooks/mpesa/:provider`.
- Generic PSP callbacks: `POST /api/v1/webhooks/cards/:provider`.
- Existing bank statement import, suggested matches and independent match confirmation.
- Provider events use explicit currency and integer minor units. Never infer a successful amount from an invoice when the provider did not supply it.
- Event identifiers distinguish pending and confirmed events; retries of the same provider event retain the same identifier.
- Success is not settlement or available owner cash. A provider payout to a manager is not an owner distribution.

## Hardened intake

Confirmed/refunded callbacks must state a positive exact amount and nonblank transaction identifiers. Invalid facts and cancelled references are retained for review without posting. Generic processing/pending events translate to pending. Unknown event types remain ignored. Existing signature verification, transactions and event deduplication remain authoritative.

## Connection handoff (still required)

1. Choose the actual bank API/funds flow and the organisation merchant mapping. Banks have different authentication, event schemas and settlement contracts.
2. M-Pesa: implement the provider-authenticated relay and initiation client against the approved Daraja environment. The internal PALTAS HMAC endpoint is not a public unauthenticated Daraja receiver.
3. Add scoped organisation/property merchant authority and register Property Management invoice references with a real product handler. The existing generic fixture handler is not the production tenant-rent handler.
4. Apply confirmed events through the existing PM financial transaction/allocation services; never route rent to subscription invoice handling.
5. Verify provider confirmations independently where required; never trust browser return URLs or an unauthenticated relay.
6. Complete provider clearing, processing fees, settlement ingestion and accounting reconciliation.
7. Implement provider-specific pending/failed/returned/refunded/disputed transitions, safe retries and out-of-order-event handling.
8. Verify real provider sandbox journeys and financial tie-outs before live activation. Configure credentials privately, enable methods only for eligible organisations and currencies, and verify monitoring/recovery.

Steps 1–8 are not certified complete by generic adapter tests. This phase improves the existing intake boundary; it does not make all bank integrations a credentials-only activation.

## Verification

Unit tests cover precise money, missing identifiers, pending translation, unknown events and invalid M-Pesa confirmations. Isolated PostgreSQL/HTTP tests cover signed callbacks, stale/bad signatures, duplicate delivery, pending-to-confirmed progression, cancelled references, zero confirmations and manual bank reconciliation. Payloads and provider responses are synthetic, not actual bank or Daraja acceptance.

No migration, credential change, live connection, money movement or production deployment is included.

### Local results — 29 October 2026

- Three focused suites: **19 tests passed** against isolated PostgreSQL, including synthetic signed HTTP callbacks and statement matching.
- TypeScript workspace/test checks passed.
- Targeted ESLint checks passed; changed files formatted with Prettier.
- An initial new test failed because it used `payment_event_id` rather than the existing receipt column `event_id`; corrected before the final passing run.
- Reference rows are locked during callback resolution so cancellation updates cannot race the state check inside the callback transaction.
- No full regression, real-provider acceptance or production deployment is claimed for this local candidate.

## KulmiPay candidate verification update — 29 October 2026

The client-owned KulmiPay bridge now includes verified receipt posting, explicit gross/fee/net accounting and independently reviewed manual bank settlement. See `kulmipay-client-owned-connector.md` for current scope and gates. The final candidate passed 1,025 backend tests, 30 tenant and 14 manager browser checks, plus 16 connector browser checks. Provider responses remain simulated; no live provider acceptance or production deployment is implied. Earlier checkpoint limitations above describe the generic intake phase.
