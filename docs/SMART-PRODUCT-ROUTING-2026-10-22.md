# PALTAS product routing and Super Admin access — 22 October 2026

## Changes

- Customer sign-in loads fresh active organisation memberships and backend-verified product roles. One usable product opens directly; multiple products show a product chooser. Multiple organisations have a separate workspace selector.
- Existing PM, Developer, Hotel, Security and Agent portals keep their existing routes. The account menu provides Switch Product, workspace switching and sign-out.
- Customer sign-in now includes a clear Super Admin sign in link to admin.html. Staff authentication remains separate and requires existing MFA. This release does not enroll, reset or promote any production account.
- Safe intended destinations reject external URLs, ambiguous organisations and unauthorised products. Expired sessions and revoked access are rechecked on the server.
- The existing Team form can assign distinct product roles. Organisation administration requires the base organisation-administrator role; a product administrator is not silently promoted to organisation administrator.
- Work assignment and automated audiences use the same effective product roles as API authorisation.

## Root causes

Post-login routing previously selected the first subscribed product. Memberships contained one organisation-wide role, so product-specific permissions could not be represented. Explicit organisation selection could fall back to another workspace. The customer sign-in footer did not expose the separate staff sign-in path.

## Migration and compatibility

0034_membership_product_roles.sql adds one nullable JSONB column with an object constraint. NULL preserves compatible legacy roles; an explicit object is an allowlist and missing keys mean no access. An empty object grants no products. No existing memberships or financial/property records are rewritten. Actual Almas user roles are not changed by deployment; an authorised organisation administrator can assign them through Team.

Deploy backend before frontend. Once explicit product grants have been used, do not blindly roll back to an older backend that ignores them: its legacy role could restore broader access. Use a forward fix or an explicitly reviewed access-preserving recovery. Keep the migration in place.

## Release method

Use the existing PALTAS Render service and Netlify production context. Do not promote a staging-connected preview. GitHub Actions are not requested or used for this release; local checks are recorded separately. Remote CodeQL is not claimed to have passed. No Appra, Stripe, banking, Marketplace design or brand changes are included.

## Verification

Results and production commit/deployment IDs are appended after verification.

### Local release checks

- TypeScript, ESLint and Prettier: passed.
- API browser-client parity and frontend generated-page parity: passed.
- Production build: passed (18 allowlisted files).
- Redirect and routing security unit checks: passed.
- Real API/PostgreSQL/Chrome account journeys: 18 passed, 0 failed, including distinct roles, switching, revoked access, multiple organisations, safe intended destinations and the actual Team role-edit form.
- Property Management browser regression: 113 passed, 0 failed.
- Production dependency audit: 0 known vulnerabilities at check time.
- Full backend suite: result recorded in final deployment report.

The Team journey exposed an incorrect browser API method name (organisations.getOrganisation instead of the existing organisations.get). This was corrected and the complete 18-check browser journey then passed.
