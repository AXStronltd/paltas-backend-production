# The PALTAS API

**150 endpoints.** 140 of them are not written by hand — they are built from
28 resource declarations in `src/domain/registry.js`, which is why they are
all scoped, permission-checked and audited the same way. The other 10 are the
ones that could not be generic, and each is listed at the bottom with the
reason.

---

## The five endpoints every resource has

```
GET    /<resource>          list, scoped to your company
GET    /<resource>/:id      one row, or 404 if it is not yours
POST   /<resource>          create
PATCH  /<resource>/:id      change some fields
DELETE /<resource>/:id      remove
```

**Listing** takes `?q=` (text search), `?status=`, `?limit=` (max 100),
`?cursor=` (from the previous response's `nextCursor`), and a filter on any
id field the resource has — `?siteId=`, `?listingId=`.

```jsonc
// GET /units?status=vacant&limit=2
{
  "units": [ { "id": "...", "ref": "A-101", "status": "VACANT", ... } ],
  "nextCursor": "clx…"          // null when there is no more
}
```

A single row comes back under its own name: `{ "unit": { … } }`.

---

## The 28 resources

| Path | Needs the product | Area |
|---|---|---|
| `/sites` | — | property |
| `/buildings` `/units` `/leases` `/projects` `/assets` | Property Management | property |
| `/work-orders` | — | maintenance |
| `/parties` | — | people |
| `/documents` | — | documents |
| `/rooms` `/reservations` `/services` | Hotel Management | hotel |
| `/listings` `/leads` `/viewings` `/deals` | Agent & Host | agent |
| `/zones` `/visits` `/passes` `/vehicles` `/incidents` `/shifts` `/patrols` `/deliveries` | Security Management | security |
| `/invoices` `/payments` `/expenses` `/payouts` | — | finance |

`/sites`, `/parties`, `/documents`, `/work-orders` and the four money
resources need no particular product: every company has contacts, paperwork,
things that break and money.

---

## What every one of them does before it does anything

In this order, with no exceptions and no way round:

1. **A session, a company and an open subscription.** `CANCELED` and
   `EXPIRED` close the door. `PAST_DUE` does not — a late invoice is a
   conversation, not a lockout.
2. **The company owns the product.** A company without Hotel Management has
   no rooms, whatever role the person holds.
3. **The role may do this verb in this area** — `src/domain/access.js`.
4. **The query is scoped to that company.** `where` starts as
   `{ orgId: actor.orgId }`, taken from the session row. An `orgId` in a
   request body is ignored, always.
5. **Only declared fields are written.** `orgId`, `id`, `ref`, `total`,
   `paid`, `net` and the void columns are not in any declaration, so no
   request can set them.
6. **An id in the body must name a row in your own company** — otherwise the
   row lands in the right company but joined to a stranger's.
7. **The write is recorded** in `AuditEvent`, with who did it.

---

## Roles

Nineteen roles, eight areas, four levels — `none`, `read`, `write`,
`manage`. `manage` is separated from `write` only to control **deletion**.

| Role | Reaches |
|---|---|
| `OWNER` `MANAGER` | everything, including deletion |
| `GM` | the hotel and its building; reads security |
| `OPERATIONS` | property, maintenance, people, documents |
| `FINANCE` | **reads everything, writes only money** |
| `LEASING` | agent, property, people, documents |
| `HOST` | listings and stays. No finance, no security |
| `FRONT_DESK` | hotel, people |
| `HOUSEKEEPING` | rooms and maintenance |
| `ENGINEERING` | maintenance |
| `FNB` | guest services |
| `RECEPTIONIST` | the front of house of a building |
| `SECURITY_MANAGER` | all of security, including deletion |
| `GUARD` | **writes the security log, deletes none of it** |
| `GUEST` `MARKETING` `COMPLIANCE` `PUBLISHER` `PROMO_CONTRIBUTOR` | nothing here |

> **This table is a proposal, not a transcription.** The frontend's
> `backend.md` sets out the role table for *promotions* only; for the six
> products it decides what a person sees by hiding console sections, and
> hiding a section is not a permission. The table was derived from what each
> role means in the business. Two entries are judgement calls worth arguing
> about, and both are marked in bold above. `src/domain/access.js` is the
> only place to change either.

---

## The ten that could not be generic

### Money the server has to compute

| | |
|---|---|
| `POST /invoices/:id/lines` | Add a line. The **total is recomputed** from every line plus its tax. |
| `DELETE /invoices/:id/lines/:lineId` | Remove one. Same recompute. |

`total` and `paid` are columns but no request can write them. A client that
can name its own total can name zero. Tax is **basis points** — 16% is
`1600` — so the arithmetic stays in integers all the way down.

### Money that must not disappear

| | |
|---|---|
| `POST /payments` | Record a receipt. `@@unique([orgId, method, reference])` means the same M-Pesa code cannot be banked twice — which is what a double-submit on a bad signal looks like. |
| `POST /payments/:id/void` | **Requires a reason.** The row stays, voided, forever. `DELETE /payments/:id` is refused for everybody. |

### A bill that belongs to a stay

| | |
|---|---|
| `GET /reservations/:id/folio` | Opens one on first look, so a folio always exists when somebody goes to charge to it. |
| `POST /reservations/:id/folio/lines` | A charge. **Negative is allowed here and only here** — a payment on a hotel bill is a line with the sign reversed. |
| `POST /reservations/:id/folio/close` | Refuses to close out of balance unless you send `force: true`, which leaves the difference on the record. |

### Decisions, not edits

| | |
|---|---|
| `POST /visits/:id/decide` | `{ decision: "approved" \| "refused" }`. Refusing somebody entry **requires a reason**. |
| `POST /visits/:id/leave` | Signs a visitor out. |

### One request instead of nine

`GET /summary` returns the counts a console opens on — arrivals today, rooms
to clean, visitors waiting, unpaid invoices — and **only the ones the role
may see**. A guard's summary carries the gate queue and not how much the
company is owed, because that number is itself information.

---

## Errors

Every error has a code a program can read and a sentence a person can act on.

| | |
|---|---|
| `400 bad_request` | `message` names the first problem, `details` lists all of them |
| `401 unauthorized` | no session |
| `403 forbidden` | the message says which role, and who can |
| `404 not_found` | **including somebody else's row.** A 403 would confirm it exists |
| `409 conflict` | a duplicate reference, a closed folio, a paid invoice |
| `500 internal` | a bug here. `reference` is the code to quote |

---

## What has been proved, and what has not

**Proved here**, against a real PostgreSQL 16 and against an in-memory
Prisma stand-in, 169 passing tests:

- **every one of these endpoints has now actually run.** `test/fake-prisma.js`
  holds rows in memory so the real Express app, the real routers and the real
  guards execute here; `test/products-offline.test.js` drives 20 scenarios
  through them over real HTTP. That found three bugs on its first run — see
  the end of this file

- the migrations build exactly the schema `schema.prisma` declares — every
  column, type, nullability, index, foreign key and delete rule
- deleting a company takes all six products' rows with it, through four
  levels of cascade
- every organization-owned model cascades and is indexed
- no query in any route file or in the framework escapes its organization
- the registry and the schema agree in both directions
- `clean()` refuses what it should and normalises what it should

**Not proved.** The 35 tests that need a generated Prisma client — 18 for
promotions in `api.test.js`, 17 for the product API in
`products-api.test.js` — **have never run.** The product half of those is
now mirrored by `products-offline.test.js`, which does run and covers the
same ground above the database; what stays untested is the join between the
two: real Prisma issuing real SQL. They need a generated Prisma client, and `prisma generate`
downloads an engine from `binaries.prisma.sh`, which the environment this
was written in cannot reach.

```bash
npx prisma generate
TEST_DATABASE_URL=postgresql://…  npm test
```

Those 35 are the only tests that exercise a real route against a real
database. Everything above them is static analysis and schema checking,
which is worth a great deal and is not the same thing.

**Also run `npx prisma migrate status`** on that machine. The migrations
were hand-assembled for the same reason, following Prisma's naming
conventions exactly; it should report no drift. If it reports any, trust
Prisma.


---

## The three bugs the first run found

They are fixed. They are written down because each one is a class, and each
class now has a test that would catch the next instance.

### 1. `POST /payments` never ran — and invoices stayed unpaid

The 28 generic resource routers were mounted **before** the hand-written
endpoints. One path existed in both, and Express silently matched the first:

```
POST /payments        ← generic create (wins)
POST /payments        ← hand-written (dead code)
```

So money was recorded and **the invoice it paid was never recomputed**. A
customer could settle a bill in full and go on seeing it as outstanding. The
currency rule — take it from the invoice, so two currencies are never added
together — never ran either.

**Fixed** in the declaration rather than by reordering mounts: `payments`
sets `ownCreate`, and the framework does not register a create for a
resource that has its own. Reordering would have worked until somebody
reordered it back.

**Guarded by** `test/routing.test.js`, which compares every hand-written
route against every route the framework generates and fails on any overlap.

### 2. `POST /zones` returned 500 for a missing field

`Zone.siteId` is `NOT NULL` in the schema — a gate or a lobby is somewhere —
and the `zones` declaration did not list it as required. The request reached
the database, which refused it, and the caller got *"Something went wrong at
our end"* for a request that was one field short.

**Fixed** by requiring it, so the answer is now `400 siteId is required.`

**Guarded by** a test that walks every resource and fails on any `NOT NULL`
column with no default that the declaration does not require. The framework
also now turns a null-constraint error into a 400 naming the column, as a
net underneath.

### 3. A test that filled a reference with a label

The sweep across all 28 resources filled a required `siteId` with the string
`"A's zones"`. Not a product bug, but the kind of test failure that gets
blamed on the code — so the sweep now creates real rows and passes real ids.
