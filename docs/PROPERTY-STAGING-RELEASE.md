# Property Management staging release

This development candidate is not production approval. Do not merge main, deploy production, enable public signup or change production data without explicit approval.

## Isolation before deployment

`render.staging.yaml` proposes a separate free Render web service with manual deployments. Supply a newly provisioned staging PostgreSQL database and a newly generated secrets key directly in the hosting dashboard. Never copy the production database URL, signing secrets, staff accounts or customer records. No database resource is provisioned by this file; any paid resource needs a concrete cost review first.

Use a dedicated Netlify staging site or preview configured to proxy `/api/*` to that staging service. The current production proxy must not be used for staging account creation. Set APP_BASE_URL and CORS_ORIGINS to the actual staging frontend origin. Staging signup remains off until the email adapter, test recipient arrangements and staging terms have been configured. The blueprint disables schedulers by default; scheduler tests require a controlled explicit staging configuration.

## Candidate behaviour

- SIGNUP_PRODUCTS controls which products may self-register; default `property`.
- Public signup metadata lists only the allowed products' plans.
- Direct API requests for other products are refused before account creation.
- An empty list closes registration even when SIGNUP_ENABLED is true.
- This list controls new signup only. It does not grant membership, alter subscriptions, or replace product entitlement checks.
- Trial duration remains the server-managed trial policy; verify it is 30 days on the isolated staging database before acceptance testing.

## Required workflow evidence

Use synthetic company records and controlled recipient addresses, not copied production data. Verify signup and actual email receipt; a single-use verification link; company/product assignment; fresh-login persistence of property, units and contacts; permissions and cross-company refusal; then owner mandate, tenant lease, rent/deposit invoicing, recorded payments, accounting and trial expiry/read-only behaviour. A queued email receipt is not evidence of inbox delivery. Property setup and contact pilot pages do not constitute the complete Property Management product.

The backend product-release regression tests run in PostgreSQL CI. Local type checking/linting do not replace those tests or live staging acceptance. Prepare a production approval request only with the exact tested commit, successful CI, staging evidence, remaining limitations, rollout and rollback steps.
