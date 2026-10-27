# Approved subscription pricing and release evidence — 27 October 2026

## Owner-approved commercial terms

The owner confirmed Axstron Holdings Ltd, United Kingdom, VAT registered. Standard USD 49/month, Pro USD 69/month and Enterprise USD 99/month apply separately to Property Management, Agency/Hosts, Development, Hotels and Security. Prices include applicable VAT. These are versioned definitions in `config/paltas-subscription-offers-2026-10-27.json`, not guessed changes to historical agreements.

The owner also requested local-currency display. This remains pending: estimates must use an actual dated rate, state that they are estimates and retain the actual charge currency; they must never change the organisation's operating currency or relabel USD amounts as local money. Stripe's subscription Adaptive Pricing eligibility must be verified separately before relying on it.

## Implemented

- `stripe-offers.ts`: account-pinned, versioned, idempotent product/price provisioning. Dry run by default; explicit apply flag required by CLI. Price identity, amount, currency, recurrence, metadata and inclusive tax behaviour are checked. Existing definitions are not overwritten. Lost responses safely resume through retained lookup keys. No customer/subscription/payment APIs are called.
- `stripe-provision-offers.ts` and `npm run stripe:offers:prepare`: repeatable operational tool. It sanitises provider errors, never prints credentials, and refuses live provisioning outside the production PALTAS origin.
- `upgrade.service.ts`: availability is now based on an eligible mapped plan, not only the global Stripe enablement flag. Unmapped, tax-review, adjusted and contact-sales-only choices are not advertised as available card checkout.

## Actual live Stripe result

The approved provisioning function was bundled without credentials, transferred to the existing PALTAS Render shell, run in dry-run mode and then explicitly applied. It authenticated the existing live PALTAS account before every resource operation. Independent read-back verified 15 saved prices, USD 49/69/99 monthly, tax behaviour inclusive, in `acct_1US4fBIaWEYyCbix`. The old USD price remains untouched. No customers, subscriptions, charges or payouts were created.

Proof: `outputs/stripe-rent-integration/approved-prices-live-verified.png` in the task workspace. A private-permissions file containing only nonsecret price-definition results is retained on the current Render instance as `.paltas-approved-offers-result.json`. The temporary `.paltas-approved-offers.mjs` contains approved code/configuration, no credentials, and reads the existing key in memory.

## Checks

38 tests passed across offer provisioning, subscription checkout, configuration and self-service upgrades. These include mock-provider account isolation, exact approved amounts, inclusive tax behaviour, rerun/lost-response safety, refusal to overwrite conflicting prices, and checkout availability. Type checks, lint, formatting and diff whitespace checks passed. The provisioning itself and independent price read-back used the actual live PALTAS API. These are not completed customer-payment acceptance tests.

## Remaining release gates — not complete

- Connect the approved offers to the application catalogue without changing existing customer agreements, issued invoices or accounting currency. Current legacy catalogue values are KES demo settings and are not silently converted.
- Correctly quote and reconcile VAT-inclusive prices by customer jurisdiction. Merely setting `tax_behavior=inclusive` does not register VAT, calculate tax or configure Stripe Tax.
- The existing production restricted key denied Tax settings/registrations and webhook-configuration reads. The owner approved adding ONLY Tax and webhook READ permissions. Those permissions have **not** yet been applied: Stripe's native dashboard key/Tax pages stayed at Loading or navigation changed before the controls were available. Do not claim tax or webhook readiness from secret-variable presence.
- Verify the webhook endpoint and signing configuration, paid-invoice/receipt reconciliation, renewal, cancellation and failed-payment handling in the real provider test environment.
- Publish the application checkout and verify desktop/mobile customer journeys; local-currency display is not implemented yet.
- Guest marketplace payments are currently recorded manually in the existing stays service; they need an authorised and verified host/company collection account, payment confirmation, clearing, fees, refunds and ledger integration. Guest funds must not be sent to the PALTAS SaaS subscription merchant by default.

Application deployment and live customer charging have not been activated by this checkpoint. Live Stripe price definitions alone do not mean clients or guests can pay through PALTAS.
