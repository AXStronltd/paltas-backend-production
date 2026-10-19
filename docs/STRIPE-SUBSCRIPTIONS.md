# Shared Stripe subscription integration — release gate

Status: development implementation; no Stripe account, price or webhook has been configured by this change. STRIPE_ENABLED defaults to false. This is PALTAS's SaaS subscription collection, not tenant rent collection or client payouts.

## Product and pricing policy

Use the existing catalogue and shared 30-day trial policy for Property, Developer, Hotel, Security and Agency. The public tier names should be Standard, PALTAS Pro and Enterprise (contract enum remains Pro). Enterprise stays contact-sales. Do not start a second 30-day trial at Checkout: the existing PALTAS trial has already started at registration. Customers choose an upgrade when ready, and hosted Checkout clearly discloses the recurring amount and billing interval.

Regional prices must be approved catalogue amounts in the company's billing currency. Map each approved plan/currency pair to a recurring Stripe Price via STRIPE_PRICE_MAP. No browser-supplied Price ID or exchange-rate calculation is accepted. Currency is confirmed through the company/plan configuration; country/IP must never grant a cheaper arbitrary price. The current registration catalogue uses the selected plan's configured currency. Automatic country-based selection and a customer-confirmed supported-currency selector still need integration before claiming global localisation is complete. Do not show unapproved converted prices.

Create recurring monthly/quarterly/yearly Prices matching the catalogue exactly. Hosted checkout currently supports simple licensed, per-unit, quantity-one plan prices, with no discounts, promotions, tax adjustments or negotiated terms. Complex invoices stay on assisted/bank-transfer billing. Do not enable automatic tax or Stripe-side price switching until PALTAS can reconcile them. Prices must be sustainable; no lowest-price marketing claim is made.

## Configuration and test rollout

1. In the isolated Render staging service, configure STRIPE_SECRET_KEY with a test key, STRIPE_WEBHOOK_SECRET from the staging webhook, and STRIPE_PRICE_MAP as an array of {planId,currency,priceId}. Keep credentials out of frontend builds and chat.
2. Keep staging pointed at its own PostgreSQL database. Apply migration 0024 through the existing staging migration workflow. No production migration has been performed.
3. Register a snapshot event destination for POST /api/v1/webhooks/stripe. Use API version 2026-09-30.endive, the version declared by the pinned Stripe SDK 23.0.0, and verify the snapshot event shapes in test mode.
4. Select checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted. payment_intent.succeeded/setup_intent.succeeded are not entitlement authorities; unsupported events are acknowledged and ignored.
5. Start an existing PALTAS upgrade to obtain an unpaid plan invoice; POST /api/v1/orgs/:orgId/subscription/stripe-checkout with {invoiceId} as a verified organisation administrator. It returns a checkout.stripe.com URL and testMode. Membership, ownership, product and price checks run on the server.
6. Pay with Stripe test instruments. Confirm return page does not activate access; only a matching signed invoice payment creates one PALTAS receipt. Verify duplicate/reordered webhooks, a failed payment/retry, renewal, cancellation and foreign-organisation invoice rejection.
7. Check rate limits, webhook monitoring/retries, reconciliation, cancellation/customer-portal experience and country/currency journey before production approval.

## Security and accounting

Raw-body Stripe signatures have a five-minute tolerance. Event IDs are recorded transactionally. Checkout creation uses a durable idempotency key and one non-terminal Stripe subscription per organisation/product. Existing PALTAS invoices/receipts remain authoritative; first payment activates through the existing purchase handler. Renewals create an invoice with the Stripe period and pass through the same exact-amount payment handler. Actual succeeded PaymentIntent and customer matching are required; an invoice manually marked paid out-of-band cannot silently count as card collection. Lifecycle events never grant paid access. Cancellation preserves all business records.

The platform renewal scheduler skips Stripe-managed subscriptions to prevent duplicate invoices. Unpaid/cancelled terminal subscriptions lose access; past_due follows Stripe retries until terminal unpaid/cancelled. Decide the commercial retry/grace policy in Stripe before launch. Expired Checkout recovery, customer billing portal, plan changes, tax and negotiated invoices remain assisted workflows until separately verified. The frontend checkout call-to-action and regional price selection are not yet released.

## Production gate

Require passing full CI plus real Stripe test-mode evidence and approved prices. Configure production keys/webhook separately only after explicit release approval. Never charge customers from fixtures or change existing trial/signup policy as a side effect.
