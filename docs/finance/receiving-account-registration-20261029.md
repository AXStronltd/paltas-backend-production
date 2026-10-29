# Receiving account registration — 29 October 2026

## Delivered technical scope
Company owners can register Kenyan KES bank, M-Pesa mobile, PayBill or Till receiving details inside PALTAS. The API validates the selected type, encrypts all stored destination details using the existing AES-256-GCM SecretBox, returns masked references, allows repeated edits with revision conflict protection, and preserves an append-only history. Sensitive writes are rate-limited and owner-authorised server-side. Pausing saves another version; it does not erase records or cancel existing payments. A paused record can be resubmitted through edit for verification.

The UI uses Connect your account. It shows saved destination verification separately from the existing payment-provider connection. Account numbers and PayBill references are not included in correction drafts. The installation widget is hidden while a PM modal is open so it cannot obscure financial status or controls.

## Explicit boundary
This feature registers receiving details only. Its API always returns automaticSettlementEnabled=false and saved records remain verification_pending or paused. It never creates a merchant, marks a destination verified, sends a bank payout, creates a payment link, or initiates collection. There is no secret-key exchange in the ordinary client form. The existing advanced client-owned merchant connector is retained.

Requested next capabilities: invoice-specific payment links, provider-supported payment choices, verified beneficiary registration and automatic settlement. They are not claimed complete by this receiving-details release. Public KulmiPay documents describe payments from an existing merchant wallet, not a platform/submerchant onboarding endpoint. PALTAS must not assume a working wallet under one merchant establishes legally separate client merchants.

## Provider account observations
Safari was signed in to Paltas Live. The verification page showed personal documents In review, business documents Not started, and the setup guide explicitly identified business verification as the next step to accept live payments. The user reports a direct live arrangement. These conflicting readiness signals need an authoritative provider capability/onboarding response; software must not invent a verified status. The previously shared live key was not used or stored.

## Verification
- TypeScript and lint passed.
- Generated browser client and OpenAPI: 904 endpoints.
- Focused backend: 5 suites / 34 tests passed.
- Full backend: 158 suites / 1,032 tests passed.
- Connector UI: 52 checks passed with synthetic API replies.
- Real browser + HTTP + isolated PostgreSQL: 16 checks passed (save, reopen, edit, refresh, masking, mobile, pause, encrypted history and no financial side effects).
- Frontend production build and generated page verification passed.
- Provider responses are simulated; no real bank, M-Pesa collection or payout was performed.

## Migration and rollback
0061_property_receiving_accounts is additive. Existing units, owners, tenants, leases and financial amounts are unchanged. Retain encrypted receiving-account history on rollback; do not drop customer records. Previous compatible backend application commit is 5bf7c9035a6bc8d5bb5fee41c2e1fb08dbc7204a and frontend 7b26a1530abe5f05a499f252155d5596bd1cd5ac.
