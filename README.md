# PALTAS backend

The PALTAS API server, written in TypeScript on PostgreSQL. Repository: `AXStronltd/paltas-backend-production`. The front end lives in `AXStronltd/paltas-frontend`.

The API is deployed at `https://paltas-api-v2.onrender.com`; the frontend's `https://paltas.io/api/*` proxy reaches it. The frontend currently uses the API for sign-in, sessions, organisation/entitlement views, and Super Admin operations. The product APIs listed in `server/src/products/README.md` are not yet integrated into their browser workspaces, so product records still need end-to-end frontend wiring and staging validation before client use.

The **shared core** that every product uses:

- sign-in, sessions and two-factor;
- organisations and members;
- roles and permissions;
- plans, modules and subscriptions;
- PALTAS billing and payment events;
- the audit trail;
- the one double-entry ledger.

Products plug in as modules (`server/src/products/README.md`). The Claude bundle adds server domains for Property, Development, Security, and Agency alongside Hotel. These APIs still need frontend integration and production provider setup before any workspace can be called client-ready.

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
  browser/          GENERATED browser copies; currently synchronized manually with the front-end shared/ folder
  server/           @paltas/server — the API
    migrations/         numbered SQL files (never edit an applied one; add a new file)
    src/app.ts          builds the server: security headers, errors, every route
    src/config.ts       every setting (from environment variables)
    src/http/           route.ts (contract-bound routes) and errors.ts (one error format)
    src/db/             PostgreSQL access, migrations runner, document numbers
    src/core/<area>/    one folder per area: identity, organisations, access, subscriptions,
                        payments, ledger, audit, catalogue, admin
    src/products/       registered product domains: Hotel, Property, Development, Security, and Agency
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

4. **Permissions.** `contracts/src/access.ts` defines the role capabilities and the server enforces them on API requests. The static pages still use legacy, browser-side role checks; these are presentation only and must not be treated as authorization. A remaining integration task is to load the contract's role map in the frontend and remove duplicated permission tables.

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
npm run bootstrap -- you@example.com ./paltas-superadmin.txt   # isolated local/test fixtures ONLY; refused in production
```

The credentials-file argument is required. The password and authenticator secret go to that new file (owner-only), never to the screen or the hosting logs. Add the
authenticator secret to your app, keep the file somewhere safe, then delete it. The catalogue's KES prices are demo
configuration: confirm them in the Super Admin portal before billing anyone.

## Check it

```bash
npm run check     # typecheck (strict) + lint + format + all tests + browser files up to date
npm test          # tests only (needs PostgreSQL: PALTAS_TEST_PG, default postgres://paltas@127.0.0.1:55432/postgres)
```

Each test file gets its own fresh database, copied from a migrated template, so tests never share state.

## Render deployment configuration

The existing API service is `https://paltas-api-v2.onrender.com`. `render.yaml` describes the service and database configuration. A deploy is not complete until the health endpoint reports the database as healthy and the deployed commit is confirmed in Render. The backend branch adds `/api/v1/ready` for migration checks. Self-service signup remains disabled in Render because its verification outbox has no connected email provider.

| Setting       | Value                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| Runtime       | Node 22 (`.node-version`, `NODE_VERSION=22`)                                          |
| Build command | `npm ci --include=dev && npm run build`                                               |
| Start command | `node server/dist/main.js`. Pending migrations are applied at start-up, under a lock. |
| Health check  | `/api/v1/health`                                                                      |
| Database      | PostgreSQL 14 or newer (Render PostgreSQL 16 in the Blueprint)                        |

Environment variables (names only; enter the values in Render, never in Git):

| Name                                                                                | Required                                                   | Value                                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                      | yes                                                        | From the Render database. For an external connection, add `?sslmode=require`.             |
| `SECRETS_KEY`                                                                       | yes (the server refuses to start without it in production) | `openssl rand -base64 32`. Store it safely: without it, two-factor secrets can't be read. |
| `NODE_ENV`                                                                          | yes                                                        | `production`                                                                              |
| `HOST`                                                                              | yes on Render                                              | `0.0.0.0`                                                                                 |
| `PORT`                                                                              | provided by Render                                         | —                                                                                         |
| `CORS_ORIGINS`                                                                      | when the front end calls the API                           | e.g. `https://paltashub.com`                                                              |
| `TRUST_PROXY`                                                                       | recommended                                                | `true` (behind Render's proxy)                                                            |
| `BILLING_MODE`                                                                      | optional                                                   | `provider` (the default; `simulated` is refused in production)                            |
| `SESSION_MINUTES`, `LOG_LEVEL`, `DATABASE_POOL_SIZE`, `LOGIN_RATE_LIMIT_PER_MINUTE` | optional                                                   | Defaults are in `server/.env.example`                                                     |
| `WEBHOOK_SECRET_<PROVIDER>`                                                         | only when a payment provider adapter exists                | none yet                                                                                  |
| `PALTAS_TODAY`                                                                      | never in production                                        | refused in production                                                                     |
| `SIGNUP_ENABLED`                                                                    | keep off until email delivery is connected                 | `false` in `render.yaml`; no email provider is connected yet                              |
| `SIGNUP_TERMS_VERSION`, `APP_BASE_URL`, `SIGNUP_PER_*`                              | signup configuration                                       | see `server/.env.example`; public signup remains disabled in Render                       |

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

## Not done yet (backend)

- **Product modules.** Property Management is next, then the rest of Development, then Security.
- **Hotel gaps.** See `docs/hotel/BACKEND-MATRIX.csv` in the front-end repository (MISSING / BLOCKED rows): e.g. revenue management, POS menus / kitchen / stock, spa and events, loyalty and reviews, payroll and budgets, invoices by e-mail, multi-currency, card pre-authorisation, and a scheduler for the automatic night audit.
- **Data migration gaps.** OCR (needs a provider); detect / validate / dry run still run inside the request (only the import is a background job); no cancel for an unfinished upload; the Property Management migration domain.
- **Wiring the HTML workspaces to this API.** They still use browser storage until you approve connecting them.
- **Real provider adapters.** M-Pesa, card and bank adapters that translate provider callbacks into the signed event format.
- **Production hosting:**
  - point-in-time recovery on the database;
  - secrets management;
  - monitoring.
- **External review.** An independent security review and penetration test.

### Multi-block and custom naming

Property Management supports custom block names and safe block archiving, with active-lease protection and unit toilet/size details. See [multi-block safety and API usage](docs/MULTI-BLOCK-SAFETY.md). This development change requires its own reviewed migration and release.

### Staff first-time authentication

See [Staff MFA enrollment and approved owner recovery](docs/STAFF-MFA-ENROLLMENT.md). Production legacy bootstrap is replaced by operator approval plus independent mailbox verification, pending QR/manual-key enrollment, first-code confirmation and hashed single-use backup codes. Deployment alone never resets an existing owner.
