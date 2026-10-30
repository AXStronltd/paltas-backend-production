# Published subscription offers — 30 October 2026

## Implemented

Migration0065 adds fifteen versioned offers: Standard USD49, Pro USD69 and Enterprise USD99 per month for Property Management, Agency/Hosts, Development, Hotels and Security. Existing catalogue rows, organisations, subscription identifiers, agreements and issued invoices are untouched. Modules and capacity reuse the existing tier definitions; for products without an Enterprise template, Pro capacity is retained with the existing automation module. No unlimited capacity is invented.

Production signup and self-service plan selection now offer the published plans; legacy development fixtures remain available in development. Priced Enterprise can be chosen without the old mandatory quote path. Existing active subscriptions remain on their agreements. Existing Stripe-managed subscriptions retain their existing billing-management safeguards.

Subscription invoices use the selected offer currency, separately from the business operating currency. Renewals for these offers calculate in USD. Outstanding balances are separated by currency; the legacy single outstanding amount follows the subscription billing currency. Plan/product orders wait for confirmed payment even if a development simulation setting was left on. Invoice creation does not activate access.

The existing account-pinned Stripe checkout can resolve the already provisioned approved prices by exact lookup key, amount, currency, recurring interval, live/test mode and account/product/tier metadata. It never creates or overwrites a Stripe product or price. Existing explicit mappings retain support. Checkout remains subject to the existing runtime enablement flag and verified payment events; returning from checkout is not payment confirmation.

Frontend shows three clearly labelled choices, real included modules and property allowance, explicit USD currency, selectable enabled payment methods and provider invoice instructions. Registration omits the duplicate Enterprise quote card when a priced Enterprise plan is present. SaaS subscriptions remain separate from tenant collection accounts.

## Verification

- Final backend regression: 163 suites / 1,071 tests passed with four workers.
- 14 real HTTP/PostgreSQL/browser checks passed on desktop and mobile.
- Type checks, ESLint, generated API consistency and production frontend build verified.
- Existing card billing, account scope, redirect guards and locale checks passed.
- Initial broad run suffered local resource timeouts and old production fixtures expected legacy IDs; corrected fixtures and final bounded run passed. One duplicate-event assertion was corrected to verify a single persistent receipt rather than assuming a different cached response string.
- Production read-only Stripe check verified all fifteen live prices in the existing PALTAS account. No charge, subscription, customer or payout was created for verification.

## Production payment configuration / limits

Read-only runtime verification found STRIPE_ENABLED=false and zero explicit subscription price mappings. A subscription signing-secret variable exists. Signed-in Stripe dashboard verification found active destination “PALTAS Live Subscription Billing” at https://paltas.io/api/v1/webhooks/stripe with invoice.paid, invoice.payment_failed, checkout.session.completed and subscription lifecycle events; it currently shows no delivered events. Restricted-key webhook listing is denied. No credentials or permissions were changed. Do not describe online checkout as enabled, payment acceptance as verified, or tax automation as configured by this release. Local-currency estimates are not invented; the charge currency is USD. Activation still requires verified payment.
