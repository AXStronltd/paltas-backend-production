# Handoff — `claude/release`

Release branch for the PALTAS backend (live service `paltas-api-v2`, database `paltas-v2-db`). Built from `origin/main` (55acd48). Not merged and not deployed. Main auto-deploys to the live service.

## What is on this branch

1. **Codex PRs merged in stack order:** #8 (onboarding gates, `SIGNUP_PRODUCTS`), #9 (owner property workflows), #10 (contact patch preservation) and #11 (restore verification, private property document files, migration 0014).
2. **Catalogue migration `0015_catalogue_seed`.** Seeds every module and every PM/Development plan on any database (DEV-PRO is KES 150,000/month). It uses `ON CONFLICT DO NOTHING`, so a Super Admin's edits are kept. `GET /api/v1/public/signup-options` now also returns the trial days, plus each plan's tier and modules in words.
3. **Platform e-mail.** It has one design, using Codex's names: `PLATFORM_EMAIL_PROVIDER=none|smtp|resend|postmark|sendgrid`, `PLATFORM_EMAIL_FROM`, `SMTP_*`, `RESEND_API_KEY` and so on.
   - The adapter key is `platform_<provider>`. An organisation can never select it.
   - SMTP status is "sent (accepted by mail server)". It is never shown as delivered.
   - A missing password never stops the server. In that case production sign-up simply stays closed.
   - Migration: `0016_email_delivery`.
4. **Password reset.** Uses the same e-mail path. The token is in the URL fragment. Migration: `0017_password_reset`.
5. **First-run set-up.** The org_admin can finish first-run set-up alone in every product (`first-run.org-admin.test.ts`).
6. **Server messages.**
   - Module refusals name the module in words.
   - Money in messages is formatted with its currency (`formatMoney`).
7. **Hotel.**
   - `GET …/refunds?status=requested`
   - `GET …/staff`
8. **Security.**
   - The gate officer can list sites.
   - `GET …/security/me/duty`: the guard's own shifts, post orders and patrols.
   - `PUT …/security/sites/:siteId`
9. **Live-upgrade test.** A database at main's schema (0001–0013) is filled with rows, then 0014–0017 are applied. A production start follows, with SMTP chosen and no password: health and ready both pass.

## Left to do (known gaps)

- **Document store.** A PostgreSQL file store exists for **Property only** (PR #11). It still needs:
  - a storage interface;
  - wiring for the Hotel, Security, Development and Agency document endpoints.
- **PM tenant profile.** A full PM tenant profile (emergency contact and similar) and tenant-portal endpoint gaps were not reviewed in this round.
- **Lower-priority BACKEND-GAP rows.** The many rows in `docs/frontend-connection/*-MATRIX.csv` were not built. Examples: PM accounting/tax/operations pages, the Development calendar/inbox/land bank, Hotel brand standards/custom reports, Security escalation/ratings/patrol checklists.
- **Owner decisions before going live:**
  - set `SIGNUP_TERMS_URL` (https) in Render;
  - set `SIGNUP_ENABLED=true` once acceptance is done;
  - `SIGNUP_PRODUCTS` defaults to `property`. List the other products to open them.
  - Check that Render allows outbound SMTP on port 465.

## How to run the checks

```
npm ci --include=dev
bash scripts/local-postgres.sh start     # PostgreSQL at 127.0.0.1:55432 (see /var/tmp/paltas-pg/log.txt on failure)
npm run check                            # typecheck, eslint, prettier, all tests, browser files current
npm run openapi && npm run browser:build # regenerate docs/openapi.json and browser/paltas-api-client.js
```

The staging set-up from PR #11 is unchanged: `render.staging.yaml`, `scripts/verify-hosted-staging.mjs` and the Supabase CA in `server/certs/`. Do not add a second sign-in system. `core/identity` is the only authentication.
