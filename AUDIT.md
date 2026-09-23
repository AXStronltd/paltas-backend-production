# PALTAS frontend ↔ backend alignment audit

Run before any push or deploy. No commits were made.

---

> ## Addendum — 2026-09-24
>
> **This document is a snapshot, kept as written.** Several of its findings have
> since been closed, and the two below are the ones that change how the rest of
> it reads:
>
> - **§4c is built.** The table further down lists `/market/config`,
>   `/payment-methods/available`, `/localization/config` and
>   `/services/available` as *not served*. All four are served now
>   (`src/routes/market.js`), the last of them at `/market/services` rather
>   than `/services/available` — `/services` was already a tenant resource.
>   `PALTAS_API_BASE` no longer has to stay unset; the recommendation near the
>   end of this file is superseded.
>
> - **The suite is no longer partly skipped.** 844 tests, all passing, against
>   a real PostgreSQL with a real Prisma client.
>
> The two product questions at the end — the Development/Community entitlement,
> and what the Security add-on means commercially — are **still open**.

---

## The headline, first

**The gap is real and it is exactly the gap the README has described since day
one.** This backend was scoped, deliberately and with your agreement, to one
vertical slice: *auth + organizations + promotions*. You picked that from three
options when I asked. So this audit confirms a documented state rather than
uncovering a surprise.

**But "do not push" is the wrong conclusion from that right observation.**
Pushing and deploying are different acts:

| | |
|---|---|
| **Push to a private repo** | Version control. Three commits of tested code stop existing only on one laptop. Nothing about a private repo claims completeness, and the README states the scope in its third paragraph. **Safe. Recommended.** |
| **Deploy to Render and point the frontend at it** | A claim that the API serves the product. **Not yet true.** |

The risk you are guarding against is real, and it lives entirely in the second
row. Leaving the work unpushed does not reduce it — it just adds the risk of
losing the work.

---

## 1. Current architecture assessment

| Layer | State |
|---|---|
| Organization → Subscription → Entitlement → Membership → Workspace | **Aligned.** All five models exist, with the enums copied value-for-value from `assets/session.js`. |
| Roles & permissions | **Aligned for what exists.** 19 roles; `domain/rights.js` is server-authoritative; the frontend's copy decides buttons only. |
| Multi-tenant isolation | **Aligned, and now enforced by test** rather than by habit — see §10. |
| Promotion workflow | **Aligned.** 12 states, one public, approval + audit history. |
| Verification | **Register only** — status + a JSON document register. No file bytes in the database, which is what you asked for. |
| Everything else (property, hotel, security, agent, development, community) | **Missing.** |

---

## 2. Frontend surface (from the pushed repo + `backend.md`)

`index.html`, `owners.html`, `partner.html`, `auth/*` (7 pages),
`dashboard/{property,agent,hotel,security,guest,admin,index}.html`, plus
`assets/{console.js,market.js,market-config.js,session.js}`.

> **Not fully inspected this pass.** You named `~/Downloads/paltas-frontend 2`;
> access was granted but the device bridge dropped before I could read it. What
> follows is derived from the repo's own `backend.md` and `architecture.md`,
> which are the frontend's authored specification — authoritative for the
> contract, but they will not show API calls added since. Re-run §5 against
> that folder before building.

## 3. Backend routes today

`/auth` (6) · `/organizations` (2) · `/promotions` (13) · `/health` · `/`

## 4. Prisma models & enums today

**Models (11):** User, Session, Organization, Subscription, Entitlement,
Membership, Verification, Workspace, Promotion, PromotionEvent, Counter

**Enums (7):** Product, SubscriptionStatus, VerificationStatus, Role,
EntitlementStatus, OrgStatus, PromotionStatus

## 5. Frontend API calls

The frontend calls the backend through exactly **three seams**, by design:

| Seam | Status |
|---|---|
| `PALTAS.Session` → `/auth/session` | **Served** |
| `PromoAPI` → 8 promotion methods | **Served** |
| `market-config.js` → `/market/config`, `/payment-methods/available`, `/localization/config`, `/services/available` | **Not served** (§4c) |

Every other console screen still reads an in-memory array. That is *why* the
missing backend has not broken anything yet — and why connecting it naïvely
would.

## 6. Product / role / permission mismatches

| Required product | Entitlement | Console | Backend domain |
|---|---|---|---|
| Property Management | ✅ | ✅ | ❌ |
| Agent & Host | ✅ | ✅ | ❌ |
| Hotel Management | ✅ | ✅ | ❌ |
| Security Management | ✅ first-class | ✅ | ❌ |
| **Property Development** | ❌ **no enum value** | folded into Property | ❌ |
| **Community & Estate Management** | ❌ **no enum value** | folded into Property | ❌ |

**Two findings worth a decision, not a code change:**

1. **Development and Community are not separate products in the built
   frontend.** They are screens inside the Property console (`development`,
   `buildings`). Your brief calls them first-class. Making them separate
   entitlements changes what a customer buys and what `session.js` routes —
   **that is a product decision and I will not make it silently.**

2. **Security add-on capability is specified but not modelled.** Security is
   first-class today. "Also enable as an add-on to eligible products, included
   in Enterprise" needs a `Plan`/`AddOn` layer that does not exist. Your brief
   asks for `Subscriptions → Products → Plans/Add-ons → Entitlements`; the
   schema currently goes Subscription → Entitlement directly.

## 7–9. Missing domains, models, routes

`backend.md` already enumerates this precisely — **27 create endpoints (§2)**
and **45 named endpoints (§3)**, with exact field lists:

| Product | §2 forms | §3 endpoints |
|---|--:|--:|
| Security Management | 8 | 5 |
| Property Management / Development | 10 | 6 |
| Agent & Host | 7 | 2 |
| Hotel Management | 2 | 10 |
| Platform / shared | 0 | 22 |

Estimated new models: **90–140**, plus a `Plan`/`AddOn` layer and a shared
finance, document, notification and audit spine.

## 10. Security & multi-tenant risks

I audited every query by hand: **no isolation holes today.** Then I stopped
trusting that, because hand-auditing will not survive 27 more route files.

**`test/tenancy.test.js` (new, 9 tests)** now enforces it structurally:
every org-owned model cascades and is indexed; every query is scoped or
explicitly exempted *with a written reason*; nothing believes an organization
id from a request; `actorFor()` may not read the request at all.

**It found a real flaw within minutes of existing:** `Session.orgId` was a bare
string with no foreign key. Deleting an organization left live sessions
pointing at it. Not a leak — `sessionView()` re-derives from memberships — but
a dangling reference in the exact column a future route would trust. **Fixed:**
real FK, `ON DELETE SET NULL`, migration `20260911160000_session_org_fk`.

**Remaining risk, for later:** there is no row-level security in Postgres. The
isolation is application-level. At 100+ tables that is worth revisiting.

## 11. Test gaps

118 tests, 100 passing, 0 failing, 18 skipped.

- **The 18 skipped are the only end-to-end tests** and they have never run
  anywhere — this sandbox cannot reach `binaries.prisma.sh`. **Your `npx prisma
  generate && npm test` is the first time.**
- No test yet for: concurrent writes, pagination, rate-limit behaviour under
  load, or the Google callback end-to-end.

## 12. PostgreSQL `28000 / InitializeSessionUserId` — diagnosed

**Reproduced exactly.** `28000` is *invalid_authorization_specification*;
`InitializeSessionUserId` is the function that resolves the role name.

> **The role in your connection string does not exist.**
> Not a wrong password — that is `28P01`. Not a schema problem.

Two likely causes on a Mac:

1. **Homebrew and Postgres.app create a superuser named after your macOS
   account (`kaboole`), not `postgres`.** My README's example URL says
   `postgres`. If you have a native Postgres on 5432, that URL fails against a
   perfectly healthy database.
2. **Something already held 5432**, so the Docker container never started and
   you are talking to a different Postgres.

**Check and fix:**

```bash
lsof -i :5432                       # what is actually listening
psql -h 127.0.0.1 -p 5432 -l        # which roles/databases exist

# then one of:
TEST_DATABASE_URL=postgresql://kaboole@127.0.0.1:5432/postgres npm test
createuser -h 127.0.0.1 -p 5432 -s paltas
```

**Nothing in the data model was changed to make this go away.** Instead both
suites now connect *before* migrating and print the diagnosis above in plain
words, so the next person does not reach for the schema.

---

## What I recommend

**Push now.** Private repo, three commits, honest README. Get it off one laptop.

**Do not deploy and do not set `PALTAS_API_BASE`.** Use
`PALTAS_PROMOTIONS_API` only, so exactly the one working seam is connected.

**Then build in slices, not in one pass.** I could emit 120 models and 70 routes
this turn. I would be unable to run a single integration test against any of
it, and you would have no way to tell the working parts from the broken ones.
That is worth less than nothing. Suggested order, each slice ending green:

1. **Plan / AddOn layer + the Development and Community decision** — everything
   else hangs off the entitlement model, so changing it later is expensive.
2. **Security Management** — 8 forms, 5 endpoints, the most complete frontend
   spec, and the product with the clearest tenancy story.
3. **Hotel Management** — 10 §3 endpoints, and the guest portal depends on it.
4. **Property + Development + Community** — largest, most shared machinery.
5. **Agent & Host**, then the shared finance/document/notification spine.
6. **§4c market service** — last, because until it exists `PALTAS_API_BASE`
   must stay unset.

## Two questions I need answered before slice 1

1. **Are Property Development and Community & Estate Management separate
   entitlements a customer buys, or screens inside Property Management?** The
   built frontend says screens. Your brief says products. This changes the
   `Product` enum, `session.js` routing, and pricing.

2. **What does the Security add-on mean commercially?** Included free in
   Enterprise? Priced per site? Is an add-on entitlement identical in power to
   the standalone product, or reduced?

I will not guess at either. They are pricing and product decisions, and the
schema built on top of a wrong guess is expensive to unpick.

---

**No commit. No push. No deploy.** Waiting on your answer to the two questions.
