# Business-first registration release

This change collects company registration information and the registering administrator's details. It does not verify legal ownership of the company.

## Coordinated rollout

1. Deploy backend migration 0019 and API first. Migration 0018 is reserved by the separate contact-fields PR; 0019 has no dependency on it.
2. Deploy matching frontend and shared browser client.
3. Enable SIGNUP_REQUIRE_PROFILE=true on staging and test fresh registration. The default false permits existing cached frontend clients during rollout.
4. Only configure SIGNUP_PRODUCTS for products whose hosted registration and workspace checks pass. The current production default remains property. Other business choices are visible but unavailable until configured.
5. After the frontend rollout and hosted verification, enable SIGNUP_REQUIRE_PROFILE=true in production.

Keep the existing Resend provider, verified sender, API key, legal policy version and HTTPS URLs. No new email credential is needed.

## Data and permissions

Company profiles are saved atomically in org_signups and organisations. Organisation membership gates the profile endpoint. New customers receive org_admin membership within their own company; no platform staff access.

Standard and Pro use the actual server catalogue. Enterprise records a quote request and starts the explicitly disclosed available trial plan; it does not activate Enterprise or charge a customer.

## Verification

Local dedicated PostgreSQL only; no production database used for tests. Backend suite passed 568 tests before adding the further cross-company profile isolation case; the final focused profile suite passed all 5 cases. Hosted verification remains required before enabling additional production products.
