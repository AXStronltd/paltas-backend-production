# Self-service registration email

Customers supply their own email, password, company and product through the public registration form. The backend owns account creation, password hashing, organisation membership, trial records and single-use email verification. Registration does not create staff privileges.

## Deployment configuration

Keep `SIGNUP_ENABLED=false` until the entire client release gate is satisfied.
Configure these secrets/settings directly in Render, never in Git or chat:

- `PLATFORM_EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`: a sending key for the verified PALTAS domain
- `PLATFORM_EMAIL_FROM`: an address on that verified domain
- `APP_BASE_URL=https://paltas.io`
- `SIGNUP_TERMS_URL`: the approved, published HTTPS terms page
- `SIGNUP_TERMS_VERSION`: the corresponding document version

Resend domain ownership and DNS verification must be completed by an authorised domain administrator. A configured key does not prove inbox delivery: verify a controlled signup and actual receipt before launch. Do not use the provider's demonstration sender.

## Boundaries

Only platform-origin transactional signup messages use this sender. Organisation messages and customer-configured sender identities cannot borrow it. Submission uses a fixed HTTPS endpoint, a 10-second timeout and an idempotency key based on the notification ID. Raw provider errors, credentials and verification links are not logged by the adapter.

Acceptance by the provider records `queued`, never `sent`. The existing generic delivery webhook is not a Resend-compatible webhook; do not configure Resend to call it. Delivery reporting integration remains separate work. Verification links carry their single-use token in a URL fragment, consumed by the isolated verification page.

Provider API reference: https://resend.com/docs/api-reference/emails/send-email
