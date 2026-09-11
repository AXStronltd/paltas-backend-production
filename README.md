# paltas-backend

The PALTAS API. Sessions, organizations and the promotion workflow — the first
slice of the contract written down in `backend.md` in the frontend repository.

It is a separate service from the frontend on purpose. The frontend is a static
site with no build step; this is a small Express app with a database. Neither
needs to know how the other is deployed.

```
Google  ──sign in──▶  paltas-backend  ──▶  Postgres
                            ▲
                            │  fetch(), credentials: include
                            │
                      paltas-frontend  (static, on any host)
```

---

## What it does today

| | |
|---|---|
| **Sign in** | Google OAuth, authorization code + PKCE. No passwords exist anywhere in this system. |
| **Sessions** | A row in the database, referenced by an httpOnly cookie. Signing out is real. |
| **Organizations** | `POST /organizations` creates the whole chain in one transaction and returns the session. |
| **Promotions** | The full workflow: write, submit, review, approve, publish, pause — with the roles enforced server-side. |
| **The public feed** | `GET /promotions/public`, the only endpoint an anonymous visitor can reach. |

What it does **not** do yet: the create endpoints in `backend.md` §2 (every
console form), the named endpoints in §3, and the market service in §4c. Those
are the next slices and none of them blocks this one.

---

## The rules this service exists to enforce

These are in the browser too, where they decide which buttons somebody is
offered. That is a courtesy. These are the copies that decide.

**1. Exactly one state is public.**
`PUBLIC_STATES` in `src/lib/promotions.js` holds `PUBLISHED` and nothing else.
`MARKETING_APPROVED` is not public. `FINAL_APPROVED` is not public.
`SCHEDULED` is not public. A promotion reaches the homepage when its state is
`PUBLISHED`, **and** today is inside its dates, **and** it has a headline and a
button — all three, checked in the query and then again in memory.

**2. The person who writes cannot approve; the person who approves cannot publish.**

| Role | Writes | Approves | Publishes |
|---|:--:|:--:|:--:|
| `PROMO_CONTRIBUTOR`, `OWNER`, `MANAGER`, `GM`, `LEASING`, `HOST` | ✓ | | |
| `MARKETING` | | ✓ | |
| `COMPLIANCE` | | | |
| `PUBLISHER` | | ✓ | ✓ |

`COMPLIANCE` can send anything back and approve nothing. That is the whole
reason it is a separate role.

**3. Owning your company grants nothing on ours.** An `OWNER` is elevated to
publisher rights only when their organization holds the `PLATFORM`
entitlement — and `PLATFORM` cannot be requested at signup, at any price. It is
granted by PALTAS, by hand, and there is deliberately no endpoint for it.

**4. Verification never closes a console.** It restricts `publish` and `payout`
and nothing else. An unverified company runs its entire business.

**5. `PAST_DUE` still opens the console.** The wall is `CANCELED` and
`EXPIRED`, and even then nothing is deleted.

---

## Running it

```bash
npm install
cp .env.example .env        # then fill it in — see the comments in that file
npx prisma generate
npx prisma migrate deploy
npm run dev
```

You need a Postgres. Anything will do locally:

```bash
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev --name paltas-pg postgres:16
# DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/postgres
```

### Testing

```bash
npm test                                     # the rules, the config, Google sign-in
TEST_DATABASE_URL=postgresql://…  npm test   # …plus the schema and the whole API
```

`test/api.test.js` **skips** rather than fails when there is no database or no
generated Prisma client, so `npm test` is useful anywhere. It says which.

---

## Deploying to Render

`render.yaml` is a blueprint. It creates the service **and a new database**.

> **It deliberately does not use `paltas-db`.** `npm start` runs
> `prisma migrate deploy`, and the seed data in that database has an unresolved
> provenance question. Nothing here may migrate it until that is settled.

Two things about this deployment are lessons already paid for on this project:

- **Migrations run in the start command, never at build.** On Render the
  database is reachable at runtime and not at build time. Running
  `prisma migrate deploy` during the build is exactly how this project met
  Prisma's `P1001` the first time.
- **Render builds the Dockerfile from source**, rather than pulling a
  pre-built private image from GHCR. A private image needs an explicit access
  grant for the deployment platform, and when it is missing the failure is an
  opaque "could not pull image".

### Google Cloud, once

Credentials → Create credentials → OAuth client ID → Web application.
Under **Authorised redirect URIs** add, exactly, with no trailing slash:

```
https://<your PUBLIC_URL>/auth/google/callback
```

Google compares that string character for character. A mismatch gives
`redirect_uri_mismatch`, and it is far and away the most common reason a first
deployment cannot sign anybody in. (This service recognises that error and says
so in its own message rather than making you go and look it up.)

### Secrets

Every secret is entered in Render's dashboard. None is in this repository, and
`.env.example` carries names and instructions, and **no secret in it has a
value** — the only filled-in lines are public URLs and a number of days. So
copying it cannot leak anything, and the CI job in `.github/workflows/test.yml`
fails the build if a `.env` or anything credential-shaped is ever committed.

**No secret may be named `NEXT_PUBLIC_…`** — that prefix means "compile this
into the JavaScript every visitor downloads". The service **refuses to start**
if it finds one. See `src/config.js`.

---

## Connecting the frontend

### Use `PALTAS_PROMOTIONS_API`, not `PALTAS_API_BASE` — for now

```html
<script>window.PALTAS_PROMOTIONS_API = "https://api.paltas.io";</script>
```

**Do not set `window.PALTAS_API_BASE` yet.** It belongs to the market service
(`assets/market-config.js`, `backend.md` §4c). Setting it makes that service
stop using its local table and call four endpoints this API does not serve yet:
`/market/config`, `/payment-methods/available`, `/localization/config` and
`/services/available`.

And §4c is explicit that a failed availability call is **not** permission to
guess — the frontend then offers *no payment methods at all* rather than
falling back to a table that may be a release behind. So setting the shared
switch today would turn promotions on and payment selection off, across the
whole marketplace, with nothing on screen to connect the two.

One switch, two services, one of them not built. So promotions has its own
until §4c ships:

| Switch | Turns on | Set it? |
|---|---|---|
| `window.PALTAS_PROMOTIONS_API` | Promotions only | **Yes — now** |
| `window.PALTAS_API_BASE` | Promotions **and** the market service | Once §4c is built |

`js43.js` reads the promotions switch first and falls back to the shared one,
so the day this service serves §4c you set `PALTAS_API_BASE` alone and the
separate switch can be deleted. `test/contract.test.js` fails if this API ever
starts serving *some* of §4c's four endpoints and not all four.

With either set, the frontend's `PromoAPI` talks to this service; with neither,
the frontend keeps its in-memory mock and the offline demo still works. **No
screen changes either way** — that is what putting a service in front of the
array bought.

### The homepage carousel

The pushed `index.html` has the intake point and nothing calls it yet — its own
comment says so. `contract/homepage-feed.html` is the one call it needs; paste
it before `</body>`. It sends no credentials, falls back to nothing, and does
not block the page.

Add the frontend's origin to `APP_URL` / `ALLOWED_ORIGINS` so the browser is
allowed to send the session cookie. The allow-list is never `*`: a wildcard
origin with credentials is the browser handing your session to whoever asks.

---

## Staying aligned with the frontend

`test/contract.test.js` does not restate the contract — it **reads**
`backend.md` and `index.html` from the frontend repository and checks this code
against them. Point it at the real files:

```bash
BACKEND_MD=../paltas-frontend/backend.md \
FRONTEND_INDEX=../paltas-frontend/index.html \
npm test
```

Copies live in `contract/` and are what the suite uses by default. It does
**not** pick up a `../paltas-frontend` on its own: a folder of that name on
somebody's disk is not necessarily the frontend that is on GitHub, and checking
against an older copy by accident fails in a way that looks like a bug in the
API. Name it explicitly when you want it. It checks, among other things:

- every field and enum value §1 promises exists in the session and the schema
- every endpoint §1 and §4b name has a route behind it
- §4b's permission table is the table `rights.js` enforces
- `PUBLIC_STATES` holds exactly what §4b's blockquote allows
- **every field `fromPromotion()` in the pushed `index.html` reads is a field
  this API sends** — including the nine market-targeting fields
- an empty targeting array can never reach the carousel as a filter
- §4c's four endpoints are all served or all absent, never half

When somebody edits `backend.md`, this suite says what no longer matches —
instead of the two drifting apart quietly and being found by a console that
opens empty.

---

## The endpoints

### Sessions

| | | |
|---|---|---|
| `GET` | `/auth/google` | Redirects to Google. Point a link at it. |
| `GET` | `/auth/google/callback` | Google returns here. Redirects to the app. |
| `GET` | `/auth/session` | The session object, or 401. |
| `DELETE` | `/auth/sessions` | Signs out — the row is deleted. |
| `POST` | `/auth/session/organization` | Act for a different company you belong to. |

### Organizations

| | | |
|---|---|---|
| `POST` | `/organizations` | Creates the whole chain; returns the session. |
| `GET` | `/organizations/me` | The current company. |

### Promotions

| | | |
|---|---|---|
| `GET` | `/promotions/public` | **No session needed.** What the homepage may show. |
| `GET` | `/promotions` | `?scope=mine\|all&status=&queue=&finalQueue=` |
| `GET` | `/promotions/:ref` | One promotion, with its full history. |
| `GET` | `/promotions/:ref/checks` | The content and creative checks. |
| `POST` | `/promotions` | Always creates a `DRAFT`. |
| `PATCH` | `/promotions/:ref` | Only while it is yours to edit. |
| `POST` | `/promotions/:ref/submit` | → `SUBMITTED`, or `RESUBMITTED` if it is coming back. |
| `POST` | `/promotions/:ref/review/claim` | → `UNDER_REVIEW` |
| `POST` | `/promotions/:ref/review/approve` | → `MARKETING_APPROVED` — **not** published |
| `POST` | `/promotions/:ref/review/changes` | → `CHANGES_REQUESTED`, message required |
| `POST` | `/promotions/:ref/review/reject` | → `REJECTED`, message required |
| `POST` | `/promotions/:ref/publish` | → `PUBLISHED` — publisher only |
| `POST` | `/promotions/:ref/schedule` | → `SCHEDULED` |
| `POST` | `/promotions/:ref/pause` | → `PAUSED`, message required |

A refusal always says what to do about it, in a sentence. Sending a promotion
back without a message is refused, because the customer's screen shows that
message and nothing else.

---

## How it is put together

```
src/
  config.js              every setting, read once, checked at boot
  db.js                  one Prisma client for the process
  server.js              the app, the middleware order, graceful shutdown
  auth/
    google.js            OAuth + PKCE, ID token verification
    sessions.js          session rows, cookies
  lib/
    rights.js            WHO MAY DO WHAT — the copy that counts
    promotions.js        the public gate, the state machine, the checks
    session-view.js      the object the frontend reads, assembled
    middleware.js        session, CORS, rate limit, headers
    errors.js            refusals a person can act on
  routes/
    auth.js  organizations.js  promotions.js
```

Every decision that matters is a **pure function** in `lib/`, so it can be
tested exhaustively without a database, a session or a network — and it is.
A route that forgets to call one is a wiring mistake; a rule that is wrong is
somebody's draft on the homepage.
