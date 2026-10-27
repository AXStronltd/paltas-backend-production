# Subscription currency isolation — 27 October 2026

## Confirmed defect and correction

Subscription upgrade quoting used the organisation's property operating currency. Reusing the approved USD offers for an existing KES or ZAR workspace therefore could not quote a price; simply changing organisation currency would also relabel operational accounts.

The new `subscriptionPrice` helper accepts the exact approved 2026-10-27 USD offer identities and amounts (49/69/99, monthly, one matching product and tier), while preserving legacy pricing rules. Upgrade orders persist the server-selected quote currency for both purchase and invoice. Recurring calculations use the approved subscription currency without modifying organisation or property currency. No FX is inferred.

Files: `server/src/core/subscriptions/subscription-price.ts`, `billing.service.ts`, `server/src/core/signup/upgrade.service.ts`, `stripe-offers.ts` (shared manifest schema export), and two `subscription.currency*.test.ts` files.

## Verification

39 targeted tests passed, including the real isolated PostgreSQL journey: KES workspace → quote USD 49 → USD invoice and purchase → signed synthetic provider payment → subscription activation → next-period USD calculation → organisation still KES. Stripe checkout regressions passed with mock Stripe. These are not live customer payments.

The test's zero-tax catalogue row exists only in a throwaway local database; it does not establish tax treatment for any real customer. No production catalogue records, invoices, customer currencies, subscriptions or Stripe configuration changed. No migrations.

## Remaining work / release status

Not deployed. This patch is only currency isolation. It does not publish or activate the approved catalogue, enable Enterprise self-service, decouple currency selection in new registrations, implement jurisdiction-aware VAT-inclusive quotes, enable Stripe automatic tax, verify real test-mode payment confirmations/renewals, or enable local-currency estimates. Those remain necessary before claiming checkout operational.

A fresh read of PALTAS Stripe Tax on 27 October still showed 0/2 setup steps completed. The user's direction to continue the rest is not evidence of tax registration or an exemption.

## Wider regression result

The first full run passed 138 files (895 tests), with 13 suites affected by server/test-hook timeouts: 4 failures and 73 skipped. All 13 affected suites then passed with two workers (102 tests); the initial failed result is retained, not rewritten as a clean full run. No production data was used.

Final currency patch checks: type checks, lint, formatting, 39 targeted tests and generated browser-contract verification all passed after the final change. The currency override also refuses any cross-currency order unless its plan and amount exactly match the approved quote.
