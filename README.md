# PALTAS backend

The PALTAS API server, written in TypeScript on PostgreSQL. Repository: `AXStronltd/paltas-backend-production`. The front end lives in `AXStronltd/paltas-frontend`.

It is **live** on Render as the `paltas-api-v2` web service with its own `paltas-v2-db` database, deploying from
`main`; paltas.io proxies `/api/*` to it. `render.yaml` describes that set-up; see "Deploy on Render" below.

The **shared core** that every product uses:

- sign-in, sessions and two-factor;
- organisations and members;
- roles and permissions;
- plans, modules and subscriptions;
- PALTAS billing and payment events;
- the audit trail;
- the one double-entry ledger.

Products plug in as modules (`server/src/products/README.md`). Built so far: **Hotel** (full product module) and **data migration** (shared engine, with Real Estate Development as its first target). Property Management (with the one shared contact store, `core/contacts`) is built too; see its section. Every product is sold through self-service sign-up and free trials under one platform trial policy (`core/signup`).

## Where things are

```
(repository root)
  contracts/        @paltas/contracts — ONE definition shared by the server AND the front end
    src/common.ts       dates, money (minor units), errors
    src/access.ts       products, roles, capabilities: who may do what
    src/endpoint.ts     how an API call is defined
    src/api/*.ts        every endpoint, by area: identity, organisations, subscriptions, payments, ledger, admin
    src/entitlements/   the subscription rules (also generated for the browser → browser/entitlements.js)
  api-client/       @paltas/api-client — typed client the front end uses (browser copy → browser/paltas-api-client.js)
  browser/          GENERATED browser copies; the front end keeps identical copies in its shared/ folder
  server/           @paltas/server — the API
    migrations/         numbered SQL files (never edit an applied one; add a new file)
    src/app.ts          builds the server: security headers, errors, every route
    src/config.ts       every setting (from environment variables)
    src/http/           route.ts (contract-bound routes) and errors.ts (one error format)
    src/db/             PostgreSQL access, migrations runner, document numbers
    src/core/<area>/    one folder per area: identity, organisations, access, subscriptions,
                        payments, ledger, audit, catalogue, admin
    src/products/       one folder per product (hotel, property, development, security, agency)
    test/               end-to-end tests against a real PostgreSQL
  docs/openapi.json   API description, generated from the contracts (npm run openapi)
  scripts/            browser-file generator, OpenAPI writer, local PostgreSQL helper
  render.yaml         Render Blueprint (web service + PostgreSQL); .node-version pins Node 22
```

Each area folder uses the same file names, so you always know where to look:

| File                | Holds                                                                                  | Never holds         |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------- |
| `<area>.routes.ts`  | HTTP only: one `route(endpoint, handler)` per contract endpoint, plus the access check | SQL, business rules |
| `<area>.service.ts` | Business rules and transactions                                                        | HTTP details        |
| `<area>.repo.ts`    | SQL only, where an area has a lot of it                                                | Rules               |

To find something:

- **Find an endpoint:** search its path or its id (e.g. `ledger.journals.approve`) in `contracts/src/api/`. The same id is used in its route.
- **Find who may call it:** look at the `capability:` in its route, then the table in `contracts/src/access.ts`.
- **Find a database rule:** look in `server/migrations/`. Every table has comments.

## How the front end and the back end stay aligned

1. **Same endpoints.** Every endpoint is defined once in `contracts`. The server registers its handler _from_ that definition, and the client calls it _from_ the same definition. A test fails if the server serves anything the contracts do not define, or misses anything they do.
2. **Same shapes.** Requests are validated against the contract. Responses are also validated, and fields the contract does not list are dropped, so internal columns never leak.
3. **Same rules.** The entitlement rules are TypeScript in `contracts`. `npm run browser:build` generates `browser/entitlements.js` from that source. The front end keeps an identical copy in its `shared/entitlements.js`, which its pages inline. A parity test proves the generated rules give exactly the same answers as the hand-written browser file they replaced, over 4,000 random cases.

   **When the rules change:**
   1. Run `npm run browser:build` here.
   2. Copy `browser/entitlements.js` and `browser/paltas-api-client.js` into the front end's `shared/` folder.
   3. Rebuild the pages (`bash source/build.sh`).

4. **Same permissions.** `contracts/src/access.ts` maps each role to what it may do. The server enforces it, and the front end can read the same table (`roleCan`). The `frontendKey` field links the server roles to the role keys the current pages use (`pm`, `acct`, `fd`, `agent`, `aud`).

## Run it

You need Node.js 22.13+ and PostgreSQL 14+. Either:

- `docker compose up -d` (PostgreSQL 16 in Docker), or
- `scripts/local-postgres.sh start` (uses PostgreSQL already installed, port 55432).

Then:

```bash
npm install
cp server/.env.example server/.env      # set DATABASE_URL (and SECRETS_KEY: openssl rand -base64 32)
npm run setup:local                     # schema, catalogue, a Super Admin and two demo organisations; prints passwords ONCE
npm run dev                             # http://127.0.0.1:8787/api/v1/health
```

**A new production database** (once, with the server's own `DATABASE_URL` and `SECRETS_KEY`):

```bash
npm run bootstrap -- you@example.com ./paltas-superadmin.txt   # schema, catalogue, the FIRST Super Admin (only if none exists)
# the same command, other spelling (credentials printed once instead of written to a file):
npm run bootstrap:admin -- --email you@example.com --name "Your Name" [--file ./paltas-superadmin.txt]
```

With a file, the temporary password and authenticator secret go to that new file (owner-only), never to the screen or
the hosting logs. Add the authenticator secret to your app, sign in with the temporary password and code, choose a new
password (required before anything else), keep the file somewhere safe, then delete it. Once any PALTAS staff account
exists, every run is refused and audited: it never creates a second Super Admin and never resets a password or secret
(it still applies pending migrations and adds missing catalogue rows). The catalogue's KES prices are demo
configuration: confirm them in the Super Admin portal before billing anyone.

## Check it

```bash
npm run check     # typecheck (strict) + lint + format + all tests + browser files up to date
npm test          # tests only (needs PostgreSQL: PALTAS_TEST_PG, default postgres://paltas@127.0.0.1:55432/postgres)
```

Each test file gets its own fresh database, copied from a migrated template, so tests never share state.

## Deploy on Render

The live service is `paltas-api-v2` with the database `paltas-v2-db` (both named in `render.yaml`). Every push to
`main` deploys; pending migrations are applied at start-up, before the server answers. `render.yaml` holds these
settings, or you can enter them by hand:

| Setting       | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Runtime       | Node 22 (`.node-version`, `NODE_VERSION=22`)                                           |
| Build command | `npm ci --include=dev && npm run build`                                                |
| Start command | `node server/dist/main.js`. Pending migrations are applied at start-up, under a lock.  |
| Health check  | `/api/v1/health` (200 only when the database answers); `/api/v1/ready` adds migrations |
| Database      | PostgreSQL 14 or newer (Render PostgreSQL 16 in the Blueprint)                         |

Environment variables (names only; enter the values in Render, never in Git):

| Name                                                                                                                                 | Required                                                   | Value                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                       | yes                                                        | From the Render database. For an external connection, add `?sslmode=require`.                        |
| `SECRETS_KEY`                                                                                                                        | yes (the server refuses to start without it in production) | `openssl rand -base64 32`. Store it safely: without it, two-factor secrets can't be read.            |
| `NODE_ENV`                                                                                                                           | yes                                                        | `production`                                                                                         |
| `HOST`                                                                                                                               | yes on Render                                              | `0.0.0.0`                                                                                            |
| `PORT`                                                                                                                               | provided by Render                                         | —                                                                                                    |
| `CORS_ORIGINS`                                                                                                                       | when the front end calls the API                           | e.g. `https://paltashub.com`                                                                         |
| `TRUST_PROXY`                                                                                                                        | recommended                                                | `true` (behind Render's proxy)                                                                       |
| `BILLING_MODE`                                                                                                                       | optional                                                   | `provider` (the default; `simulated` is refused in production)                                       |
| `SESSION_MINUTES`, `LOG_LEVEL`, `DATABASE_POOL_SIZE`, `LOGIN_RATE_LIMIT_PER_MINUTE`                                                  | optional                                                   | Defaults are in `server/.env.example`                                                                |
| `WEBHOOK_SECRET_<PROVIDER>`                                                                                                          | only when a payment provider adapter exists                | none yet                                                                                             |
| `PALTAS_TODAY`                                                                                                                       | never in production                                        | refused in production                                                                                |
| `SCHEDULER_*`, `SENSITIVE_RATE_LIMIT_PER_MINUTE`, `WEBHOOK_RATE_LIMIT_PER_MINUTE`, `CATALOGUE_PRICE_APPROVAL`, `SHUTDOWN_TIMEOUT_MS` | optional                                                   | Defaults are in `server/.env.example`                                                                |
| `SIGNUP_ENABLED`                                                                                                                     | to open self-service sign-up                               | `true` in `render.yaml` (default `false`: `POST /api/v1/public/signup` answers 403)                  |
| `SIGNUP_PER_IP_PER_HOUR`, `SIGNUP_PER_EMAIL_PER_DAY`                                                                                 | optional                                                   | `10`, `3` (sign-ups per caller address per hour, per e-mail per day)                                 |
| `SIGNUP_TERMS_VERSION`                                                                                                               | yes when sign-up is open                                   | The version of the published PALTAS terms a sign-up must accept (default `2026-10`)                  |
| `APP_BASE_URL`                                                                                                                       | yes when sign-up is open                                   | e.g. `https://paltas.io`; links point to `<APP_BASE_URL>/verify-email` (local refused in production) |

## Rules the code follows

- **Money** is an integer number of minor units plus a currency. There are no floating-point amounts in storage.
- **No price in code.** Prices are catalogue rows that the Super Admin changes. The seed is demo configuration.
- **Payments.** Nothing is marked paid unless one of these happens:
  - a provider event arrives with a valid signature, and the amount and currency match exactly; or
  - PALTAS staff record a bank reference by hand, with a reason.
  - `BILLING_MODE=simulated` is for local demos only. Its orders say "no payment taken", and the setting is refused in production.
- **Ledger.** The database itself enforces four rules, whatever the code does:
  - posted journals balance;
  - posted journals can't be edited or deleted;
  - nothing posts into a closed month;
  - a manual journal needs a second person to approve it.
- **Audit.** The audit log is append-only at the database level.
- **Isolation.** Every request about an organisation goes through `core/access/org-access.ts`. That checks:
  - membership;
  - the role's capability;
  - the product subscription;
  - an active subscription, for changes;
  - the module.

  Another organisation's records answer "not found".

- **Secrets.** Only the hash of each session token is stored. Authenticator secrets are encrypted at rest (`SECRETS_KEY`). Temporary passwords are shown once and must be changed at first sign-in.

## Data migration (`server/src/core/migration/`)

One server-side engine moves a customer's records from spreadsheets and other software exports into PALTAS. A product makes its records a target by registering a `MigrationDomain` on its `ProductModule` (`migration:`); Real Estate Development (`products/development/`) is the first. Endpoints: `contracts/src/api/migration.ts`; tables: migration `0006`.

- **Stages:** created → uploaded → detected → mapped → validated → resolved → dry run → approved → importing → reconciled → completed (or failed / rolled back). Changing an earlier stage sends the job back and withdraws any dry run or approval.
- **Uploads** are chunked (each request stays under the 256 KB body limit), kept in PostgreSQL with their SHA-256, typed by magic bytes, and ZIPs are checked before unpacking (entries, unpacked size, paths, symlinks, compression ratio; archives inside archives are not opened). Limits: `MIGRATION_*` in `server/.env.example`; a file being uploaded counts its announced size against the migration's total (`MIGRATION_MAX_JOB_MB`), and at most `MIGRATION_MAX_OPEN_UPLOADS` (default 20) files per migration may be in progress at once. XLSX and ZIP are read with Node's own `zlib` — no new dependency.
- **The import runs in a background worker** in the server process (`MIGRATION_WORKER`), batch by batch from the `mig_batches` table, with a lease and heartbeat: a batch whose server stopped is picked up again when the lease runs out. Each batch is one transaction.
- **Idempotent:** every record keeps `source_system` + `source_record_id` (unique per organisation); running the same export again links instead of creating.
- **Money:** opening balances post once per batch through `postSystemJournal` (Development: 1170 Buyer receivables, 2400 Buyer deposits held, 3900 Opening balance equity, 2000 Accounts payable). Rolling a batch back deletes only what it created and posts the reversal.
- **Who:** `migration.read` (org admin, finance director, accountant, auditor), `migration.run` and `migration.approve` (org admin, finance director). Separation of duties (also enforced by database constraints): the person who ran the dry run, or who changed any mapping, row or document decision, cannot approve; the approver cannot sign off. A changed row after the dry run makes approval refuse until the dry run is repeated. A rollback needs a reason, which is audited.
- **Not built:** text extraction from PDFs and scans needs an OCR provider — PDFs and images are stored as documents and linked by file name or manifest only.

## Hotel (`server/src/products/hotel/`)

The Smart Hotel product (`hotel`), one `ProductModule`. Endpoints: `contracts/src/api/hotel.ts` (client group `api.hotel`); tables: migration `0005` (`hotel_*`); plans `HOTEL-STD` / `HOTEL-PRO` (demo KES prices, seeded by that migration). Report: `docs/hotel/BACKEND-REPORT.md` in the front-end repository.

- **One availability record:** `hotel_inventory` (room type × night). Rows are locked in date order before any change, and the database refuses selling beyond the rooms (`hotel_no_overbooking`); a room never holds two overlapping stays (exclusion constraint `hotel_room_not_double_booked`). Front desk, booking engine, group blocks and channels all take rooms from it.
- **Business date per hotel.** Only the night audit moves it. The audit refuses to run, with every reason, while a cashier shift is open, a guest due out is still in house, a folio is out of balance (including folio lines that differ from the guest-ledger postings), arrivals are pending, or a void is still awaiting a second person's approval. Every posting reads the business date under a share lock, so nothing can land on a day the audit has closed.
- **Money:** every folio line posts through `postSystemJournal` (source `system:hotel`) in the same transaction: 1150 guest ledger, 1160 city ledger, 2350 deposits, 2100 VAT, 2110 levies, 2120 service charge, 4100–4500 revenue, 5600 commissions, 1000 bank (payments **recorded**, never processed). `hotel_ledger_links` ties each journal to its hotel and business date; KPIs, the daily report, flash report, departmental P&L and channel report read those ledger postings.
- **Tax engine per hotel:** VAT %, service charge % by department, tourism / city levy per night or % of room revenue. No country is hard-coded.
- **Roles:** `general_manager`, `front_office_manager`, `receptionist` (no rate changes), `revenue_manager`, `housekeeping_supervisor` / `_attendant`, `outlet_staff`, `financial_controller`, `income_auditor`, `credit_controller`, `ap_clerk`, `cost_controller`, `payroll_officer`, `group_owner`, plus `org_admin`, `accountant`, `technician`, `auditor`. Capabilities `hotel.*` in `contracts/src/access.ts`. Voids, refunds and the income-audit sign-off need a second person (the person who booked a below-plan rate cannot sign it off). A member who is not org admin or group owner reaches only the hotels they are assigned to — no assignment means no hotel. Cash refunds are paid out of the approver's open cashier shift and count against that drawer.
- **Integration boundaries** (`integrations/adapters.ts`): channel manager (availability + rates queued per channel; bookings arrive on the signed webhook `POST /api/v1/webhooks/hotel/channels/:provider`, secret `WEBHOOK_SECRET_<PROVIDER>`), door locks / mobile keys, room controls / energy, messaging. Only labelled test adapters exist: every response says "Not connected — test adapter" and nothing leaves PALTAS. The concierge answers from the hotel's own FAQ and hands anything else to staff; no external AI.
- **Group views** (central availability, consolidated KPIs, management fees) answer only for organisations with two or more hotels and the `hotel.group.read` capability.
- **Extensions (migration `0011`, report `docs/backend-completion/HOTEL-EXT-REPORT.md`):** booking-engine promo codes, extras and room features; revenue management by labelled rules from the hotel's own bookings (forecast, pace vs last year, pickup, suggestions applied as one-night BAR seasons, group displacement; no external AI); corporate RFPs and production; loyalty (points liability 2400, tiers) and post-stay feedback; multi-currency at the day's rate entered by staff; comps / discounts approved by a second person; sequential tax invoices and credit notes (immutable; e-invoicing BLOCKED); collections; bank reconciliation with card fees and chargebacks; outlet menus, recipes, POS and kitchen screen; table bookings; stock with par levels, purchase orders and three-way matched supplier bills; spa and activities, events with function sheets and deposits; payroll inputs (salaries visible to `payroll_officer` only), tips and service-charge distribution; labour planning; budgets and the manager's report; fixed assets, depreciation and the FF&E reserve; housekeeping plan and productivity; sustainability from staff meter readings. Every "prepared by one, approved by another" rule is also a database constraint.
- **Automation:** the night audit runs at the hotel's set time through the PALTAS scheduler (`ProductModule.scheduledJobs`, job `hotel.night_audit`, registered with `core.scheduler.ensureJob` when switched on); the same run records pre-arrival messages and preventive-maintenance tickets once. A blocked audit (open shift, unapproved void, …) is recorded with every reason and the managers are told. Confirmations, pre-arrival, survey, invoice, statement and report messages go to the PALTAS notifications outbox (`core.notifications.record`) — recorded, never sent.

## Agent / Host and the public marketplace (`server/src/products/agency/`)

The Agent / Host product (`agency`) and the public PALTAS marketplace, one `ProductModule`. Endpoints: `contracts/src/api/agency.ts` (client group `api.agency`) and `contracts/src/api/marketplace.ts` (`api.marketplace`: public + PALTAS staff); tables: migration `0010` (`agency_*`, `mkt_business_requests`); plans `AGENCY-STD` / `AGENCY-PRO` (demo KES prices). Report: `docs/backend-completion/AGENCY-REPORT.md` in the front-end repository.

- **Listings** (sale, rent, stay) belong to an organisation (Agent / Host, or Property Management for sale and rent). Draft → submitted (needs a photo and a description) → **published only by PALTAS staff** (database check `agency_listing_published_reviewed`) → taken down by the organisation or by staff with a reason. Public or waiting listings cannot be edited. Media are metadata (name, type, size, SHA-256); the bytes go to a storage adapter — only the labelled test adapter exists ("Not connected — test adapter", no URLs).
- **Public endpoints** (`auth: "public"`, `/api/v1/public/…`): search with filters (purpose, city, text, type, price, bedrooms, guests, amenities, free dates, sort), listing detail with approved reviews, availability, quotes, enquiries / viewing requests, offers, booking requests, reviews, For Business requests. They show only published listings of organisations whose subscription is usable (`mkt_org_usable`), map every row through a public shape with no personal data, route every submission to the owning organisation only, and are limited per caller address (`MARKETPLACE_SEARCH_PER_MINUTE`, `MARKETPLACE_SUBMIT_PER_HOUR`, 429) and per person and listing (open enquiries, offers, booking requests). Buyers and guests follow an offer or booking with its reference and a private token returned once (only its SHA-256 is stored).
- **People** are the ONE contact store (`core/contacts`): enquirers, buyers and guests become prospects, sellers / landlords / owners become owners (the agency role is a tag), with consent and a timeline entry per enquiry, offer, booking and viewing.
- **Leads:** inbox → lead (one open lead per person and listing) → viewings (an agent never in two viewings within the hour: exclusion constraint `agency_agent_viewing_clash`) → offers (counter, accept; one accepted offer per listing) → won only by closing a deal, lost only with a reason. A leasing agent sees their own and unassigned leads.
- **Commissions:** per agreement (% of the deal + fixed fee, VAT, agent's share). Closing a deal raises the commission; someone else approves it (`agency_commission_second_person`) and it posts Dr 1180 / Cr 4700 + 2100 VAT (agent share Dr 5710 / Cr 2480). Receipts are recorded (Dr 1000 / Cr 1180), each bank reference once. The commission register shows the ledger's own balances beside it.
- **Short stays:** one calendar per stay listing; bookings and blocks never overlap (`agency_stay_not_double_booked`, exclusion constraint; requests hold no nights). Prices are the host's (nightly rate, dated prices, cleaning fee, service fee %, tax %). Payments and refunds are **recorded** (deposits 2460 before check-out, receivable 1190 after); check-out posts revenue (4710 own listing, or owner earnings 2470 by owner + management fees 4720) and tax 2100. Host payouts are prepared by one person and approved by another with the bank reference (Dr 2470 / Cr 1000) — never sent from PALTAS.
- **Moderation and onboarding (PALTAS staff, `/api/v1/admin/marketplace/…`):** listing review / take-down, guest review moderation (only approved reviews are public), and For Business requests — approving one runs the core onboarding (`core.admin.createOrganisation`: organisation, subscription, chart, administrator).
- **Roles:** `property_manager` is the agency manager, `leasing_agent` the agent, `accountant` / `finance_director` record money and approve, `auditor` reads; capabilities `agency.*` and `marketplace.*` in `contracts/src/access.ts`.

## Security Services (`server/src/products/security/`)

The Security Services product (`security`), one `ProductModule`. Endpoints: `contracts/src/api/security.ts` (client group `api.security`); tables: migration `0009` (`sec_*`); plans `SEC-STD` / `SEC-PRO` (demo KES prices; the plan allowance counts active sites). Report: `docs/backend-completion/SEC-REPORT.md` in the front-end repository.

- **Set-up:** clients (payment terms, income-tax and VAT withholding, credit limit, portal members), sites (in-house sites have no client; geofence; alarm-monitoring account), posts with **versioned post orders** (a guard must acknowledge the current version before clocking in), patrol checkpoints (NFC / QR tag, when each is due), contracts with service levels (monthly fee, extra-hour rate, VAT, patrol target %, response minutes; one active per site), and the sales pipeline (quote margin from the configured pay rates).
- **Roster:** open shifts per post, assigned to guards who are active, vetted, licensed through the shift and rested (`min_rest_hours`). A guard is never on two overlapping shifts (exclusion constraint `sec_guard_not_double_booked`; assignments lock the guard row first, so concurrent assignments queue). Offers and publishing are recorded; nothing is pushed to any app.
- **Attendance:** clock-in / clock-out evidence (time, position, method, device) is **recorded as submitted**; PALTAS computes only inside / outside the site geofence. Biometric verification needs a reader (test adapter). No-shows raise alarms. Corrections keep the original evidence. Whoever recorded or corrected the attendance cannot approve the timesheet (`sec_timesheet_second_person`).
- **Field and control room:** patrol rounds (on time / late / missed; a miss raises an alarm), alarms from guards (panic), the control room, the roster, patrols and monitoring providers (signed webhook `POST /api/v1/webhooks/security/alarms/:provider`, secret `WEBHOOK_SECRET_<PROVIDER>`, one alarm per provider event) — acknowledged, dispatched and resolved with response times. **The occurrence book is append-only** (UPDATE / DELETE / TRUNCATE refused; corrections are new entries pointing at the original); an incident's facts never change and its reporter cannot close it (`sec_incident_closed_by_other`).
- **PALTAS Access:** visitor pre-registration (pass code, not sent), walk-ins awaiting the host, check-in / check-out, denial with a reason, retention and purge of personal data; the watchlist (every match refused and logged); doors, access groups (daily windows), credentials (one active of each kind per person, replace lost), and the access rule a controller would apply, run in PALTAS and logged — never presented as a door event. Remote unlock is refused while no controller is connected.
- **Money:** contract billing once per contract and month (pro-rated for part months) plus approved extra cover; one-off invoices; late charges at the configured rate; receipts **recorded** with their reference (never processed); withholding certificates; bank-line import with suggestions and confirmation. Payroll inputs from approved timesheets and the organisation's own pay rates, statutory rules and tax bands; prepared by one person, approved by another (`sec_payroll_second_person`); salaries paid outside PALTAS and recorded. Accounts: 1100 receivables, 1000 bank, 2100 VAT, 1810 / 1820 tax credits, 2810 / 2820 / 2830 payroll liabilities, 4810–4840 revenue, 5810–5870 wages, contributions and direct costs. KPIs, site profitability, ageing and statements read the same ledger postings (`sec_ledger_links`).
- **Roles:** `operations_manager`, `supervisor`, `control_room_operator`, `guard` (acts only for their own guard record), `gate_officer`, `access_administrator`, `security_client` (portal: only the clients linked to them), plus `accountant` (bills, prepares payroll), `finance_director` (approves payroll, sets payroll rules), `org_admin`, `auditor`. Capabilities `security.*` in `contracts/src/access.ts`.
- **Integration boundaries** (`integrations/adapters.ts`): door controllers, CCTV, alarm monitoring, messaging (SMS / WhatsApp / push), biometrics, tax-authority invoice submission and payroll payouts — only labelled test adapters ("Not connected — test adapter").

## Real Estate Development (`server/src/products/development/`)

The Development product (`developer`), one `ProductModule`. Endpoints: `contracts/src/api/development.ts` (client group `api.development`); tables: the `dev_*` records of migration `0006` (the data-migration target) extended by migration `0008` — migrated and new records are the same records. Report: `docs/backend-completion/DEV-REPORT.md` in the front-end repository.

- **Stock and sales:** projects, phases, buildings and floors, units (the plan allowance counts projects); price lists prepared by one person and approved by another; buyers (duplicates by email, phone or ID refused; a sales agent sees only their own buyers; each buyer is linked to the one contact store, `core/contacts`); offers with approval levels from the organisation's rules (sales manager, then the CEO = organisation administrator; never the preparer or agent; an approval covers exactly the terms approved), counteroffers, expiry; reservations approved by a manager who does not own the sale, with an expiry that releases the unit; the signed sale agreement (document record required) creates the instalment schedule (deposit, monthly, balance on completion).
- **No double-selling:** the unit row is locked before it changes, and the database allows one open reservation (`dev_reservations_one_open_per_unit`) and one live contract (`dev_contracts_one_live_per_unit`) per unit.
- **Buyer money (recorded, never processed):** sales report one instalment in full, finance any amount; one use per bank / mobile-money reference (`dev_payment_reports_reference`); verification by finance, never the person who recorded it (`dev_payment_verified_by_second_person`), issues a receipt and posts. Statements of account per contract.
- **Postings (`system:development`, dimensions project / cost code / contract / supplier):** receipts Dr 1010 / Cr 1170 (billed) or 2400 (before billing); billing Dr 1170 / Cr 2400; handover Dr 2400 (+ 3900 for receipts before a migration cut-over) / Cr 4600 and cost of sale Dr 5700 / Cr WIP (by sellable area); supplier invoices Dr cost-code account + 1200 VAT / Cr 2000 + 2050 retention; payments Dr 2000 / Cr 1000 + 2200 withholding tax; retention release Dr 2050 / Cr 2000. The migration's own accounts (1170, 2400, 3900, 2000) are the same accounts.
- **Spend:** suppliers pending until someone other than the registrar approves them; bank-detail changes block payment until another person's callback and the hold (`bank_hold_hours`); cost codes mapped to accounts; budgets, transfers and change orders; requisitions, quotations (weighted score), orders and works contracts (related-party and over-budget orders need the CEO), deliveries; supplier invoices with duplicate and three-way checks (price tolerance), credit notes, disputes; payment runs prepared by AP, approved within limits by another person, executed by treasury (a bank file — no bank is connected), paid only when the statement is matched by someone other than the executor; reversals post a reversing entry.
- **Approval limits** per role and kind (`dev_approval_limits`, no row = cannot approve; the CEO has none). Every "prepared by one, approved by another" rule is also a database constraint.
- **Delivery:** milestones (one is practical completion), handover with certificate (fully paid units only), defects closed by someone other than the fixer, after-sales tasks, legal register with expiry status, document records (metadata).
- **Dashboard and approvals:** sales, collections, cost to complete, payables, cash and revenue — each money figure shown with the ledger balance it must equal; an approvals inbox applying the same limits and separation of duties.
- **Roles:** `org_admin` (CEO), `finance_director` (finance manager), `accountant`, `project_manager`, `procurement_officer`, `ap_clerk`, `treasury_officer`, `sales_manager`, `sales_agent`, `auditor`. Capabilities `developer.*` in `contracts/src/access.ts`.

## Property Management (`server/src/products/property/`) and contacts (`server/src/core/contacts/`)

The Property Management product (`property`, also the Almas Tower pilot), one `ProductModule`. Endpoints: `contracts/src/api/property.ts` (107, client group `api.property`) and `contracts/src/api/contacts.ts` (8, `api.contacts`); tables: migration `0007` (`contacts`, `contact_*`, `pm_*`). Report: `docs/backend-completion/PM-REPORT.md` in the front-end repository.

- **One contact store (`core/contacts`)** for every product: types (tenant, owner, supplier, prospect…), consent per channel, timeline, duplicates by e-mail / phone, merge (moves every reference to the kept contact). Messages are recorded; e-mail / SMS / WhatsApp go to the notifications outbox, blocked without consent — never sent from here.
- **Setup and leases:** properties (the plan allowance counts properties), buildings, units, owners' management agreements (fee %, authority, payout day; one active per property), charge types; leases draft → active (deposit invoiced) → rent review / renewal / escalation steps → notice → ended; a unit cannot be let twice for overlapping dates (`pm_unit_not_double_let`).
- **Money (recorded, never processed):** monthly rent and charges runs (one invoice per lease and month — unique indexes), charge invoices, late fees (one per overdue invoice), credit notes, payments with allocation (oldest first) and receipts, tenant credit, statements, reported payments checked against the bank, deposit settlements approved by a second person, supplier bills (enter / approve / pay by three people, owner approval above the authority, PO matching with tolerance), owner statements equal to the ledger, payouts prepared / approved / released by different people, bank lines and reconciliations. Postings `system:property` on the client-money accounts 1040, 1120, 2150, 2160, 2170, 2250, 2300, 2310, 3900, 4650, 4660, 5650; every journal is linked to its property / owner / tenant / lease (`pm_ledger_links`).
- **Automation:** `PUT …/properties/:id/automation` (billing rights) registers the scheduler jobs `property.monthly_billing` (the billing day, 06:00 local) and `property.late_fees` (daily, 06:30); both idempotent and doing nothing while switched off.
- **Operations, CRM and portals:** maintenance requests → work orders → quotes → purchase orders (approval limits, a second person, owner authority) → completion and checks; inspections; enquiries, leads, viewings, applications (screened by one person, decided by another) → leases; notices and document records; tenant and owner portals that show only their own records.
- **Migration domain:** properties, units, owners, tenants, suppliers, leases, opening invoices, deposits, bills and the trial balance from the PM templates (`FE/samples`), with checks and opening postings.
- **Roles:** `property_manager`, `leasing_agent`, `accountant`, `finance_director`, `maintenance_manager`, `technician`, `front_desk`, `auditor`, `tenant`, `owner`; capabilities `property.*` and `contacts.*`. Every second-person rule is also a database constraint.

## Platform operations (`server/src/core/scheduler/`, `core/notifications/`, `core/payments/`, `core/admin/`)

Endpoints: `contracts/src/api/ops.ts`, `notifications.ts`, `payment-providers.ts` (client groups `api.ops`, `api.notifications`, `api.paymentProviders`); tables: migration `0012`. Report: `docs/backend-completion/PLATFORM-REPORT.md` in the front-end repository.

- **First Super Admin in production:** `npm run bootstrap -- <email> <file>` or `npm run bootstrap:admin -- --email ops@… --name "…" [--file …]` — one command (`server/src/scripts/bootstrap.ts`; `node server/dist/scripts/bootstrap.js …` or `bootstrap-admin.js …` on the server). Works only while no PALTAS staff account exists; a temporary password (must be changed at first sign-in) and an authenticator secret, written to a new owner-only file or printed ONCE; audited; every later run is refused, audited and exits 1. It never turns a client account into staff, and the database refuses staff memberships and staff roles for members (`staff_never_members`).
- **Scheduler:** `sched_jobs` (cron + IANA time zone, platform-wide or per organisation and target) and `sched_runs` (one row per job and period, so a period succeeds once). A worker in the server process (`SCHEDULER_*`) claims runs with a lease and heartbeat, retries with exponential backoff, skips suspended organisations, and is stopped before the database pool closes. Platform jobs: session clean-up (hourly), trial expiry and renewal invoices (daily, `SCHEDULER_RENEWAL_LEAD_DAYS` ahead, once per period), notification dispatch (every minute). Products add jobs with `ProductModule.scheduledJobs` and create each organisation's schedule with `core.scheduler.ensureJob(t, …)` (e.g. a hotel's night audit at its audit time). Super Admin: list, run history, pause, resume, run now, reschedule — audited.
- **Notifications outbox:** every e-mail, SMS, WhatsApp and push message is recorded through `core.notifications.record(t, …)` with templates (organisation wording, else PALTAS default), per-organisation sender settings and consent rules (marketing and WhatsApp need an opt-in; an opt-out stops the channel). Status: recorded → queued (adapter) → sent / failed only from a provider's signed delivery report (`POST /api/v1/webhooks/notifications/:provider`); the database refuses "sent" without a real provider message id. Only test adapters exist ("Not connected — test adapter"); SMTP, e-mail API, SMS, WhatsApp Cloud and push are BLOCKED.
- **Payment provider adapters:** M-Pesa Daraja STK results and C2B confirmations (`POST /api/v1/webhooks/mpesa/:provider`) and a generic card PSP webhook (`/webhooks/cards/:provider`) are translated into core payment events and decided only by the signature (`WEBHOOK_SECRET_<PROVIDER>`) and the owner's exact amount and currency rules. Products say what a payment is for with `core.providers.registerReference(t, …)`; a payment matching nothing is kept and held for review. Bank statements (CSV) are imported with match suggestions, and a different person confirms each line (`payments.reconcile`; PALTAS's own statements by a second Super Admin). Live connections are BLOCKED (credentials, callback registration, the signing relay).
- **Super Admin:** organisation suspension and reactivation with a reason (members get 403, records kept, history append-only); price changes requested by one Super Admin and approved by another, with history (`CATALOGUE_PRICE_APPROVAL`, on in production, blocks direct price edits); a streamed JSON export of one organisation (no passwords, sessions, secrets or file bytes), audited with its reason; audit search with filters.
- **Hardening:** `/api/v1/health` (Render's health check: 503 when the database does not answer) and `/api/v1/ready` (database and every migration applied); rate limits on sensitive routes per person or address (`SENSITIVE_RATE_LIMIT_PER_MINUTE`, `WEBHOOK_RATE_LIMIT_PER_MINUTE`); secrets redacted from structured logs; shutdown order HTTP → workers → database pool, bounded by `SHUTDOWN_TIMEOUT_MS`.

## Sign-up and trials (`server/src/core/signup/`)

Real free trials, the same for every product (property, developer, hotel, security, agency): a business signs itself up, uses the product fully during the trial and upgrades itself. No demo account is involved. Endpoints: `contracts/src/api/signup.ts` (client group `api.signup`), plus `subscriptions.upgradeOptions` / `upgrade` / `exportData` and `admin.trialPolicy` / `updateTrialPolicy` / `listSignups` / `allowSignup` / `declineSignup` / `listUpgrades`; tables: migration `0013`. Report: `docs/backend-completion/TRIAL-REPORT.md` in the front-end repository.

- **One platform trial policy** (`trial_policy`, one row; `trial_policy_history`, append-only): trial days (30), grace days (7), reminders (T-7, T-3, T-1), the verification window (7 days) and link life (48 h), one trial per business (e-mail, phone, company name + country within 365 days), the further-product rule, and expiry (read-only, records kept, export allowed). Only a Super Admin changes it (`PUT /api/v1/admin/trial-policy`, audited, a new version each time). It is read by every path that starts a trial — self-service sign-up, staff onboarding (create organisation, add product), a further product added by the customer and the agency "For Business" approval — all through `core/signup/policy.ts` `openSubscription`. `catalogue_plans.trial_days` is no longer read: every plan shows the policy's length. A running trial keeps the days and grace it started with (`subscriptions.grace_days`, `trial_policy_version`). The rules carry the same default (`entitlements.DEFAULT_TRIAL_POLICY`, `entitlements.trialState`), so the browser files show the same numbers; a test checks the seeded row equals it.
- **Further product** (one rule for all five): `own_trial` (default) — its own trial of the policy's length, once per product per organisation; `no_trial` — paid from day one (awaiting its first invoice, read-only until paid).
- **Sign-up** (`POST /api/v1/public/signup`, public, `SIGNUP_ENABLED`): company, country, time zone, product, plan (from the catalogue; its currency becomes the organisation's), administrator name, e-mail, phone, password (core rules) and the accepted terms version (`SIGNUP_TERMS_VERSION`). One transaction: the administrator (a plain client account with the chosen password — never staff), the organisation (never demo), the `org_admin` membership, the trial, the chart of accounts, the verification message and the audit entries. The answer is identical whatever happened (created, e-mail or name already in use, held as a repeat trial). Limited per address per hour and per e-mail per day (counted in the database) and per minute (`SENSITIVE_RATE_LIMIT_PER_MINUTE`).
- **E-mail verification:** a single-use link that expires; only its SHA-256 is stored; the message is **recorded** in the notifications outbox, never claimed as sent. `POST /api/v1/public/signup/verify` and `POST /api/v1/me/email-verification` (a new link; the old one stops working). The trial is usable at once; upgrading, paying (plan change, add-on, allowance, further product) and inviting members need the verified address. A sign-up unverified after the window is suspended by the scheduler (records kept); verifying lifts it.
- **One trial per business:** a repeat inside the window is held (`org_signups.status = blocked_repeat`, the chosen password kept as a hash only until decided) for PALTAS staff to allow (with a reason, kept in `trial_registry`) or decline. Staff onboarding applies the same rule (`repeatTrialReason` to override).
- **Lifecycle:** `/api/v1/me` and the entitlements show days and grace left. The daily job `platform.trials.lifecycle` records reminders (once per organisation, administrator and day), a "trial ended" notice and the unverified suspensions; `platform.subscriptions.renewals` expires a trial only after its grace days. Expired = read-only (402 on changes), records kept, `GET /api/v1/orgs/:orgId/export` still works (organisation administrator, audited).
- **Upgrade:** `POST /api/v1/orgs/:orgId/subscription/upgrade` — the verified administrator picks a catalogue plan and the billing period the catalogue sells it with, and how to pay; an invoice is issued through the billing service and the subscription becomes active **only** when it is paid: a signed provider event (test adapter; live card / M-Pesa collection BLOCKED) or a bank transfer PALTAS staff confirm (`POST /api/v1/admin/invoices/:invoiceId/receipts` or a confirmed bank statement line). Never in `BILLING_MODE=simulated` either. Downgrades and cancellations take effect at the end of the paid period; a lapsed workspace comes back with all its records.
- **Production:** no demo or sample organisation: `setup:local` refuses `NODE_ENV=production`, the core onboarding refuses `demo` there, and no migration or seed creates an organisation or an account.

## Not done yet (backend)

- **Property Management gaps.** See `docs/backend-completion/PM-MATRIX.csv` in the front-end repository (MISSING / BLOCKED rows): e.g. delivery of messages and notices (recorded only), M-Pesa / card payments and paying online from the tenant portal, live bank feeds, document storage and OCR (BLOCKED: providers); service-charge funds, bounced-payment reversal, withholding tax on owners' rent, aged payables and recurring bills, payment reminders, guarantors / e-signature, listings, budgets and the accounting extras (MISSING).
- **Development gaps.** See `docs/backend-completion/DEV-MATRIX.csv` in the front-end repository: meetings and calendar, supplier advances, petty cash, staff claims, recurring bills, emergency-repair retro-approval, approval delegation, country tax packs, multi-company / currency consolidation, cash forecast, feasibility and land bank, buyer refunds and new contract amendments; buyer messages and M-Pesa C2B for buyers need providers (recorded only).
- **Hotel gaps.** See `docs/hotel/BACKEND-MATRIX.csv` and `docs/backend-completion/HOTEL-EXT-MATRIX.csv` in the front-end repository: providers BLOCKED — e-invoicing submission, review sites, competitor rates, an FX feed, statutory payroll deductions / net pay, kitchen printers, IoT sensors, chain loyalty, e-mail / SMS delivery (recorded only), card pre-authorisation.
- **Agent / Host gaps.** See `docs/backend-completion/AGENCY-MATRIX.csv` in the front-end repository: no media storage provider (bytes, public URLs), no portal syndication, no e-mail / SMS to enquirers (recorded only), no consumer accounts (buyers and guests use reference + token), no online payment for stays.
- **Security gaps.** See `docs/backend-completion/SEC-MATRIX.csv` in the front-end repository: no certified door-controller, CCTV, alarm-panel, biometric, messaging, tax-authority or payroll-payout adapter (test adapters only); credit notes, supplier bills and the statutory tax calendar are not security-specific (core ledger journals); late-approved timesheets for a month whose payroll is already prepared wait for a correction run; no scheduler yet for automatic no-show detection and visitor purge.
- **Data migration gaps.** OCR (needs a provider); detect / validate / dry run still run inside the request (only the import is a background job); no cancel for an unfinished upload.
- **Sign-up and trial gaps.** See `docs/backend-completion/TRIAL-MATRIX.csv` in the front-end repository: no sign-up or verification page in the front end yet (backend only; its catalogue still has its own per-plan trial days until it reads the API or `DEFAULT_TRIAL_POLICY`), e-mail delivery (recorded only), live payment collection (BLOCKED), billing periods other than the one each catalogue plan is sold with, and CAPTCHA / bot scoring (not built).
- **Wiring the HTML workspaces to this API.** They still use browser storage until you approve connecting them.
- **Live provider connections.** M-Pesa (Daraja credentials, STK push initiation, callback registration and the relay that signs callbacks), a card processor, a bank feed, and e-mail / SMS / WhatsApp / push providers: the adapters and translators exist, the live connections need credentials and contracts.
- **Production hosting:**
  - point-in-time recovery on the database;
  - secrets management;
  - monitoring.
- **External review.** An independent security review and penetration test.
