# KulmiPay client-owned collections — 29 October 2026

**Status: code deployed to production on 29 October 2026. Live collection remains gated; real-provider acceptance is not yet verified.**

## Approved funds model

The user confirmed each client's own KulmiPay account. Tenant rent is never routed into a PALTAS-owned wallet. The PALTAS publishable key supplied in chat was not used for tenant collections. Existing Stripe subscription billing is unchanged.

Target: tenant → client's KulmiPay merchant/wallet → client's bank, under the provider's approved settlement arrangement. PALTAS records and reconciles these events. The public KulmiPay documents describe settlement wallets and separate bank payouts; they do not establish an OAuth/Connect merchant-onboarding contract or automatic direct-to-bank settlement. Those require provider confirmation. Access to a wallet using a key proves API access, not legal ownership or KYC approval.

## Implemented

- Owner-authorised, per-organisation merchant setup. Keys and webhook challenges are AES-256-GCM encrypted using the existing SecretBox. Credentials are never returned in API responses, audits or frontend configuration. Secret fields are excluded from form drafts and cleared on close/navigation.
- Credential/environment checks, fixed HTTPS provider hosts, redirect refusal, timeout, response-size limits and sanitised errors. Client wallet verification and key rotation preserve history; cross-workspace merchant reuse is refused.
- Durable, invoice-linked M-Pesa requests with explicit amount confirmation. PALTAS refuses fractional-shilling STK amounts rather than allowing the provider's documented upward rounding. Customer-paid surcharges are not introduced.
- PesaLink transport is implemented and unit-tested, but customer bank collection remains disabled until actual checkout/payment instructions have been accepted. Existing manual bank recording remains available.
- Challenge verification followed by authenticated server-side status retrieval. Incoming notification state, amounts and fees are not trusted. Currency, invoice alias, internal reference, method, gross, fees and net are checked.
- Idempotent receipt/ledger posting on verified completion. The existing PM receipt, allocation, owner-fund, commission and deposit services are reused. The full gross payment credits the tenant. Fees are company expenses; net funds debit provider clearing account 1186, not client bank 1040.
- Only the original invoice is allocated. If its balance falls while collection is pending, excess is tenant credit; unrelated rent is not silently paid. Explicit empty allocations now mean no allocations, rather than falling back to oldest-first.
- Provider timestamps are preserved as the receipt's UTC booking date. Missing breakdowns/timestamps, closed periods and conflicting manual receipts remain visible finance exceptions with safe retry. Failed postings roll back receipt, allocations and journals atomically.
- Duplicate M-Pesa receipt references across provider invoice aliases are refused. Repeated callbacks and refreshes cannot duplicate payments. Posted facts are not silently rewritten if the provider reports a fee change or return; finance review is flagged.
- Verified provider receipts cannot be erased via the generic manual receipt reversal. Provider-linked refund/return accounting still needs its own verified workflow; no refund or payout execution is implemented here.
- Batched manual bank settlement: select posted net collections and an actual imported client-bank receipt; prepare; independent approval; post clearing → bank once. Source snapshots reject changed amounts/references. Approval requires someone other than the preparer and statement importer. Reject/reprepare retains history.
- Existing bank reconciliation excludes provider-held receipts from bank-cash reconciling items and includes approved provider settlements. Client Money shows clearing separately. Bank-linked receipt totals are gross; actual bank settlements are net of company processing fees.
- Tenant and manager receipt views use the same stored receipt and allocations. All request/property/organisation permissions remain server-enforced. Company-wide settlement requires unrestricted finance authority.

## Safeguards and activation

`KULMIPAY_ENABLED=false` and `KULMIPAY_LIVE_APPROVED=false` by default. Production account setup was enabled with `KULMIPAY_ENABLED=true`; live approval was not enabled. Live collection requires explicit production configuration after real provider/merchant acceptance. Sandbox confirmations cannot create financial records in a real production workspace; use a dedicated demo/acceptance organisation.

Clients privately enter their own credentials in the authenticated workspace. Webhook URL:
`https://paltas.io/api/v1/orgs/<organisation-id>/property/kulmipay/webhook`
Subscribe to collection notifications with the same private challenge. Do not regenerate an existing key merely to connect, and do not share Stripe secrets or other products' credentials.

Bank matching records an independently reviewed statement, not an automatic payout or a verified live bank feed. This integration makes no Send Money, refund or owner-distribution execution calls. Actual provider onboarding, automatic settlement, refund/return accounting and live acceptance remain release gates. No country is certified operational by synthetic tests.

## Database and API

- 0059: encrypted connections and durable requests.
- 0060: receipt links, posting exceptions, duplicate-receipt protection and audited settlement reviews. Both are additive; no historical customer amounts are rewritten.
- Existing shared chart adds 1186 provider funds and 5686 company processing fees.
- API prefix `/api/v1/orgs/:orgId/property/kulmipay`: connection, pause, requests, refresh, webhook, settlement list/prepare/approve/reject.
- Generated API client/OpenAPI updated. Existing marketplace, subscriptions and other product designs are unchanged.

## Verification

Focused local run: **5 suites / 30 tests passed** covering connector, ledger/settlements, reconciliation snapshots and migration upgrades. Expanded scenarios include partial manual payment during a pending collection, deposits, tenant credit, batched settlement, independent approval, stale/rejected review recovery, closed-period rollback/retry and duplicate provider receipts.

Provider replies are simulated. Real isolated PostgreSQL and HTTP APIs are used for financial workflows; they are not actual KulmiPay sandbox/live transactions. Final checks: TypeScript, lint, browser-client generation and OpenAPI generation passed; **157 backend suites / 1,025 tests passed**. Tenant portal browser regression: **30 passed, 0 failed**. Manager/lease browser regression: **14 passed, 0 failed**. Connector component browser checks: **16 passed** at desktop/mobile sizes. Frontend production build and generated-file consistency passed.

The earlier full run had two stale migration-version expectations, which were corrected and targeted upgrade tests passed. A later broad run was cancelled after TypeScript identified an optional demo-flag boolean; it is not counted as a passing run. The corrected candidate passed the final full regression above.

## Primary documentation

- https://developers.kulmipay.com/authentication
- https://developers.kulmipay.com/collections/mpesa-stk-push
- https://developers.kulmipay.com/collections/pesalink-bank-payments
- https://developers.kulmipay.com/collections/checkout
- https://developers.kulmipay.com/webhooks/setup
- https://developers.kulmipay.com/webhooks/payment-collection-events
- https://developers.kulmipay.com/wallets/introduction
- https://developers.kulmipay.com/send-money/bank-payouts

## Production release evidence

- Backend commit `5bf7c9035a6bc8d5bb5fee41c2e1fb08dbc7204a`, Render deployment `dep-dbhp0q88v5cc7392927g`: live. Service restart after saving the setup flag succeeded.
- Frontend commit `5e0ffb5a484b78569cdeffebecd1fa0c9632dc9b`, Netlify deployment `6ae390c8b5a7605d063e3e28`: published and locked.
- Production health and readiness returned HTTP 200, database up, 60 migrations applied, none pending. Production `pm.html` SHA-256 matched the tested production bundle.
- Anonymous access to the connector endpoint returned HTTP 401. No production customer/payment test records were created.
- Provider verification remains simulated. Client-owned credentials, webhook setup, actual provider acceptance and the external payout arrangement remain necessary before live collection. PesaLink customer checkout, provider refund/return execution and automated bank payout remain unavailable.
