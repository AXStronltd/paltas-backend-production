# PALTAS — what the backend has to provide

This is not a wish list. Every line below is named by something in the built
frontend: a form that has fields, a button that names an endpoint, or a state
field the routing already reads. If you build exactly this, the frontend needs
no changes to start talking to it.

The frontend holds **no** business logic that the server should own. It reads a
session, renders from arrays, and writes back into those arrays. Replacing the
arrays with fetch calls is the whole integration.

---

## 1. The session — the one thing that must exist first

`assets/session.js` is the single source of truth for who is signed in and what
opens. The server returns this object; nothing else in the frontend needs to
change.

```json
{
  "user":         { "id", "name", "email", "phone" },
  "organization": { "id", "name", "country", "city", "size", "status" },
  "subscription": { "status", "plan", "planKey", "trialDays", "seats" },
  "entitlements": [ { "product", "status", "since" } ],
  "verification": { "status", "documents": [] },
  "memberships":  [ { "organization", "role", "scope" } ],
  "workspace":    { "status", "preferred" }
}
```

| Field | Allowed values |
|---|---|
| `subscription.status` | `TRIALING` · `ACTIVE` · `PAST_DUE` · `CANCELED` · `EXPIRED` |
| `entitlements[].product` | `PROPERTY_MANAGEMENT` · `AGENT_HOST` · `HOTEL_MANAGEMENT` · `SECURITY_MANAGEMENT` · `PLATFORM` |
| `verification.status` | `NOT_STARTED` · `PENDING` · `ADDITIONAL_INFORMATION_REQUIRED` · `REJECTED` · `COMPLETE` |
| `memberships[].role` | `OWNER` · `MANAGER` · `OPERATIONS` · `LEASING` · `FINANCE` · `RECEPTIONIST` · `SECURITY_MANAGER` · `GUARD` |

Three rules the server must honour, because the frontend already does:

1. **Verification never closes a console.** It restricts `publish` and `payout`
   and nothing else.
2. **`PAST_DUE` still opens the console.** The wall is `CANCELED` and `EXPIRED`.
3. **A product is not a role.** Entitlement decides which console exists; role
   decides what is inside it.

Endpoints:

| Method | Path | Returns |
|---|---|---|
| `POST` | `/auth/sessions` | the session object above |
| `DELETE` | `/auth/sessions` | signs out |
| `GET` | `/auth/session` | the current session, or 401 |
| `POST` | `/organizations` | creates USER + ORGANIZATION + SUBSCRIPTION + ENTITLEMENT + MEMBERSHIP + WORKSPACE in one transaction, and returns the session |

---

## 2. Create endpoints — every form in the product

Each row is a form that exists, with the exact fields it collects. The request
body is those fields; the response is the created record.

| Console screen | Button | POST body |
|---|---|---|
| `ag_bookings` | ＋ New booking | `guest:text, prop:text, inn:text, nights:num, total:num` |
| `ag_clients` | ＋ Add a client | `n:text, type:enum(Owner|Buyer|Tenant|Guest), since:text, note:text` |
| `ag_deals` | ＋ New deal | `n:text, value:num, fee:num, stage:enum(Offer|Reserved|Contracts|Completed), close:text` |
| `ag_leads` | ＋ Add a lead | `n:text, want:text, budget:num, stage:enum(New|Viewing|Offer|Closed), src:enum(PALTAS|Referral|Walk-in|Portal|Social)` |
| `ag_listings` | ＋ New listing | `n:text, ch:enum(PALTAS|PALTAS · Airbnb|PALTAS · Booking.com|PALTAS · all channels)` |
| `ag_props` | ＋ Add a property | `n:text, owner:text, kind:enum(Short stay|Long let|For sale), rate:num, mandate:text` |
| `ag_viewings` | ＋ Book a viewing | `who:text, prop:text, when:text, note:text` |
| `buildings` | ＋ Add a building | `site:id(site), n:text, city:text, floors:num, units:num, built:num, cond:enum(Good|Fair|Needs work)` |
| `development` | ＋ New project | `name:text, city:text, units:num, due:text` |
| `documents` | ＋ Upload | `n:text, kind:enum(Ownership|Lease|Compliance|Insurance|Tax|Other), who:text, exp:text` |
| `h_reservations` | ＋ New reservation | `g:text, r:text, t:enum(Standard|Deluxe|Marina Suite|Family), n:num, eta:text` |
| `h_services` | ＋ Add a service | `n:text, kind:enum(Restaurant|Bar|Spa|Gym|Laundry|Room service|Events), open:text, cap:num` |
| `maintenance` | ＋ Raise request | `t:text, p:text, pr:enum(Urgent|High|Normal|Low), who:text` |
| `pm_issues` | ＋ Log a report | `t:text, b:text, kind:enum(Water|Power|Lift|Security|Cleaning|Noise|Other), pr:enum(Urgent|High|Normal)` |
| `pm_market` | ＋ New listing | `u:text, ask:num, note:text` |
| `portfolio` | ＋ Add property | `name:text, city:text, kind:enum(Residential|Commercial|Mixed use|Land), units:num, val:num` |
| `rentals` | ＋ New lease | `n:text, u:text, rent:num, since:text, day:num, billing:enum(MONTHLY|QUARTERLY|YEARLY)` |
| `s_deliveries` | ＋ Log a delivery | `who:text, what:text, forWhom:text` |
| `s_guards` | ＋ Assign shift | `n:text, post:text, shift:text` |
| `s_incidents` | ＋ Report incident | `t:text, p:text, sev:enum(Critical|High|Medium|Low)` |
| `s_passes` | ＋ Issue a pass | `who:text, kind:enum(One visit|Recurring|Stay pass), valid:text, forWhom:text` |
| `s_patrols` | ＋ Schedule a round | `route:text, guard:text, due:text, points:num` |
| `s_residents` | ＋ Add a resident | `n:text, unit:text, phone:text, since:text, cars:num` |
| `s_vehicles` | ＋ Register a vehicle | `plate:text, make:text, owner:text, kind:enum(Resident|Staff|Visitor|Contractor), bay:text` |
| `s_visitors` | ＋ Register visitor | `n:text, cat:enum(Guest|Contractor|Delivery|Staff|Viewing), host:text, veh:text` |
| `sales` | ＋ Add lead | `n:text, p:text, b:num, s:enum(Enquiry|Viewing|Offer|Reserved|Closed)` |
| `units` | ＋ Add a unit | `site:id(site), building:id(building), id:text, b:text, type:enum(Studio|1 bed|2 bed|3 bed|4 bed|Shop|Office), sqm:num, rent:num` |

---

## 3. Endpoints named by buttons in the product

Every one of these is spoken aloud by the interface when clicked, so the
frontend and the backlog cannot drift apart.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/{system}/{screen}/export?format=csv` | The server builds the file from the same query this table ran, and streams it back. |
| `GET` | `/finance/ledger/export?format=xlsx` | Every posting in the period, with the running balance. |
| `POST` | `/{system}/reports` | The report is queued and appears under Reports when it is done. |
| `POST` | `/{system}/{screen}/import` | A CSV is validated row by row and rejected rows come back with reasons. |
| `GET` | `/{system}/reports/daily` | Yesterday, closed off at midnight in the property's own timezone. |
| `GET` | `/hotel/reports/night-audit` | The audit as it stood when the night ran. |
| `POST` | `/hotel/finance/post` | Posts the day's revenue to the accounting integration. |
| `POST` | `/property/payments/reconcile` | Matches bank lines to invoices and lists what will not match. |
| `POST` | `/property/payments` | Writes a receipt against a lease and updates the arrears position. |
| `POST` | `/property/payments/requests` | Sends the tenant a payment link on their channel. |
| `POST` | `/property/investors/reports` | Per-investor statement of contributions and distributions. |
| `POST` | `/notifications/test` | Sends one message to you on the channel selected. |
| `PUT` | `/{system}/settings` | Validated, versioned, and written to the audit log. |
| `GET` | `https://paltas.io` | The public marketplace, in a new tab. |
| `GET` | `/listings/{id}/preview` | The listing exactly as a visitor will see it. |
| `GET` | `/agents/{id}` | Your public page on the marketplace. |
| `POST` | `/security/passes/scan` | The guard app reads the code; this is the desk fallback. |
| `POST` | `/hotel/rooms/{id}/block` | Takes the room out of sale for a date range, with a reason. |
| `POST` | `/listings/{id}/calendar/block` | Closes the dates on every channel at once. |
| `GET` | `/hotel/lost-found` | Items logged against rooms and guests. |
| `POST` | `/hotel/reservations?source=walk-in` | A reservation and a check-in in one step. |
| `POST` | `/property/rent-runs` | Raises this month's invoice against every live lease, in one pass, and reports what it could not raise. |
| `POST` | `/property/units/{id}/short-stay` | Moves a unit from long let to nightly: rates, calendar and channels are created for it. |
| `POST` | `/hotel/stays/{id}/check-out` | Closes the folio, releases the room, and starts housekeeping. |
| `POST` | `/hotel/stays/{id}/check-in` | Assigns the room, takes the balance, and issues the key. |
| `PUT` | `/listings/{id}/price` | Repriced on every channel at once, with the old price kept. |
| `POST` | `/hotel/rooms` | A room, its type, and the rate plan it belongs to. |
| `POST` | `/hotel/groups/enquiries` | A group or event enquiry, held against dates. |
| `POST` | `/security/access/cards` | An access card bound to a person and the doors they may open. |
| `POST` | `/security/approvals` | Records who called and which resident answered. |
| `POST` | `/security/shifts/cover` | Fills a shift somebody cannot work, and tells both guards. |
| `POST` | `/organizations/{id}/invitations` | An email invitation carrying the role you chose. |
| `POST` | `/platform/companies/invitations` | Invites a company to onboard onto PALTAS. |
| `POST` | `/platform/hotels` | Creates the organization, subscription and entitlement in one step. |
| `POST` | `/platform/security-firms` | Creates the organization, subscription and entitlement in one step. |
| `POST` | `/platform/plans` | A new subscription plan, its price per market, and what it includes. |
| `POST` | `/platform/compliance/cases` | A compliance case against a company, with an owner and a due date. |
| `POST` | `/{system}/pricing/rules` | A rate rule: the condition, the adjustment, and the dates it applies. |
| `POST` | `/messages` | Sends on the channel the client prefers and keeps the thread. |
| `POST` | `/operations/tasks` | A cleaning or turnover task, assigned and timed. |
| `POST` | `/hotel/reservations` | A reservation, held against inventory and a rate. |
| `POST` | `/agent/clients` | A client record and the properties they are attached to. |
| `POST` | `/security/control-room/events` | A control-room note, timestamped against the operator on duty. |
| `PUT` | `/{system}/{screen}` | Opens the record for editing, with a version kept. |
| `GET` | `/onboarding/next` | Picks up wherever the setup was left. |

---

## 4. What is already complete, and what is not

| | State |
|---|---|
| Routing, entitlement and role resolution | **Complete.** One module, tested, 49 acceptance checks. |
| Onboarding, both doors, workspace choice | **Complete.** Every product's signup lands in its own console. |
| The guard workspace and role-based navigation | **Complete.** 7 sections for a guard, 16 for the owner. |
| 84 console sections rendering real figures | **Complete**, on sample data. |
| Every button doing something | **Complete.** 158 header buttons: 32 open forms, 14 navigate, 112 name their endpoint. 0 dead. |
| Create forms writing records | **Complete in the browser.** They write to arrays; the arrays become the API. |
| Country configuration layer | **Not built.** Markets are three fixed entries, not a config table. |
| Location hierarchy (region / city / locality, coordinates) | **Not built.** Addresses are free text. |
| Multi-site scoping inside one organization | **Partly.** Membership carries a scope; nothing enforces it per site yet. |
| Payments, documents, notifications, exports | **Named, not built.** Section 3 is the list. |
| Promotions: workflow, review, publishing | **Complete in the browser, and written against an API.** See §4b — `PromoAPI` is the whole seam. |
| A language model behind "PALTAS AI" | **Not connected, and the product says so.** See §4b. |
| Anything resembling security | **Not built, and cannot be.** The gate reads a key in the visitor's own browser. Real authorization is a server checking a signed session on every request. |

---

## 4b. Promotions — the one part written against an API that does not exist yet

Every other screen in this build reads an array directly. The promotions
workflow does not: it reads `PromoAPI`, a promise-returning service in
`assets/console.js` whose eight methods already have the shapes a REST backend
would return. Replacing the mock store is rewriting the inside of those eight
functions; **no screen changes**, because no screen knows where a promotion
came from.

| Method | The endpoint it stands in for |
|---|---|
| `list({scope, status, queue, finalQueue})` | `GET /promotions?scope=mine\|all&status=…` |
| `get(id)` | `GET /promotions/:id` |
| `create(data)` | `POST /promotions` |
| `update(id, data)` | `PATCH /promotions/:id` |
| `submit(id)` | `POST /promotions/:id/submit` |
| `review(id, decision, message)` | `POST /promotions/:id/review` — PALTAS Marketing |
| `publish(id, action, message)` | `POST /promotions/:id/publish` — PALTAS Publisher |
| `publicFeed(today)` | `GET /promotions/public` — no auth, the homepage reads it |

### The one rule the server has to enforce again

The frontend decides which buttons a person is offered. It decides nothing
about what is allowed, because there is no server. When there is one, it
re-checks this table and its answer is the one that counts:

| Role | May |
|---|---|
| `PROMO_CONTRIBUTOR` | create, edit own, submit |
| `OWNER` / `MANAGER` / `GM` / `LEASING` / `HOST` | the above, plus the company's other promotions |
| `MARKETING` | read the queue, request changes, approve for final review — **never publish** |
| `COMPLIANCE` | read the queue, request changes, flag — **never approve, never publish** |
| `PUBLISHER` | approve, publish, schedule, pause |

And the rule the whole workflow exists for, which belongs in the server and not
only in the browser:

> A promotion is visible to the public **only** when its status is `PUBLISHED`,
> today is inside `startDate`–`endDate`, and it has a headline and a call to
> action. `SCHEDULED`, `MARKETING_APPROVED` and `FINAL_APPROVED` are **not**
> public. `GET /promotions/public` must apply all three conditions itself and
> must never take a client's word for any of them.

### Where the homepage picks them up

`index.html` has one intake point and no other route in:

```js
window.PALTAS.discover.feed(rows)   // rows from GET /promotions/public
```

It re-applies the public rule to everything it is handed and returns how many
rows it accepted. Until the endpoint exists nothing calls it, and the carousel
shows PALTAS's own campaigns alone.

### "PALTAS AI" is not a language model

`AI_PROVIDER.configured` is `false` and the screen says so every time it is
opened. What the build ships is a deterministic drafter that can only
recombine the words the customer typed — it has no list of adjectives about
hotels and no idea what a room costs, so it cannot invent a price, a rating or
a guarantee. When a real model is connected it takes over through
`aiProvider()`, and the rule that applies to its output is the same one:
anything it produces that does not trace back to a supplied field is flagged
for a person, not published.

The content check (ten rules) and the creative check (seven) are rules, not
judgement, and neither approves anything — the strongest thing either can say
is PASS, and a screen full of PASS still goes to a human reviewer.

---

## 4c. Markets, currency, language and payment availability

`assets/market-config.js` is the platform's one answer to every country
question: which currency to price in, which language to speak, which payment
methods may be offered, which services exist, and which promotions belong on
the screen. Every page loads it before anything else, and nothing else in the
build holds a country list.

Today it answers from a local table. Set `window.PALTAS_API_BASE` and it asks
the server instead — the same four questions, the same shapes, no change above
the service.

### The four endpoints

| Method | Path | Query | Returns |
|---|---|---|---|
| `GET` | `/market/config` | — | `{ countries: [ … ] }` — the catalogue |
| `GET` | `/payment-methods/available` | `country`, `currency`, `amount` | `{ methods: [ … ] }` |
| `GET` | `/localization/config` | `country` | `{ languages, strings }` |
| `GET` | `/services/available` | `country` | `{ services, capabilities }` |

**A country in `/market/config`:**

```json
{
  "code":     "SE",
  "name":     "Sweden",
  "flag":     "🇸🇪",
  "currency": "SEK",
  "locale":   "sv-SE",
  "langs":    ["sv", "en"],
  "region":   "europe",
  "dial":     "+46",
  "perUsd":   10.6,
  "base":     1500,
  "cities":   ["Stockholm", "Gothenburg", "…"]
}
```

Returning a different list is the supported way to open or close a market. No
redeploy, no code change.

**A payment method in `/payment-methods/available`:**

```json
{
  "id":        "swish",
  "name":      "Swish",
  "type":      "mobile_payment",
  "provider":  "swish",
  "enabled":   true,
  "blurb":     "Instant payment from your Swedish bank",
  "currency":  "SEK",
  "feePct":    0,
  "feeFlat":   0,
  "feeLabel":  "No fee",
  "eligible":  true
}
```

`type` is what the checkout renders the form from — `card`, `mobile_money`,
`mobile_payment`, `bank_transfer`, `bank_redirect`, `wallet`, `bnpl`,
`voucher`. An unrecognised type still renders a sensible screen, so adding a
method is a row on the server and nothing here.

### The three rules the server has to enforce, because the frontend already does

1. **The server is the only authority on payment availability.** When
   `/payment-methods/available` answers, its answer REPLACES the local table
   for that transaction — it is not merged with it. A frontend that adds a
   method the server did not return has invented one.

2. **A failed call is not permission to guess.** If the endpoint errors the
   frontend offers *nothing* and says it could not load. It must not fall back
   to a table that may be a release behind the provider configuration.

3. **Eligibility is per transaction, not per country.** The call carries
   `amount` and `currency` because M-Pesa above its per-transaction ceiling is
   not a payment method — it is a failure four screens later. The frontend
   re-asks whenever any of the three moves.

### What the server still owns that the frontend cannot fake

| Thing | Why the frontend cannot own it |
|---|---|
| **Provider configuration** | Whether a merchant account exists in a country, and whether it is live, is an operational fact. The local table is a stand-in for being told. |
| **Real FX rates** | `perUsd` is an indicative rate frozen at authoring time, used only to SHOW a price in a visitor's own currency. Every figure derived from it is labelled approximate. The charge must be settled at a real rate the server quotes. |
| **Per-method limits and fees** | The ceilings and percentages in the table are the published ones; the contracted ones come from the provider agreement. |
| **Listing currency** | Every listing must carry the currency it is priced in. The marketplace currently assumes one (`PRICE_CCY` in `index.html`) because the mock inventory is single-market; the display path already takes a per-listing currency and needs only the field. |
| **Compliance requirements** | Which documents a country asks for before publishing. The table has them for the markets PALTAS has researched; the rest get a generic set and the form says so. |
| **Translation** | The four packs cover the repeated interface terms only. `/localization/config` may return `strings` and they are merged over the local packs. |
| **Promotion targeting** | The frontend filters what it is given. Which campaigns a market is *entitled* to see is a server decision. |

### Localization coverage, honestly

`PALTAS.Market.coverage()` reports the real figure rather than implying the
product is translated. At the time of writing: English 100%, Swedish 71%,
Arabic 65%, Swahili 63% of the shared key set. A missing key falls back to
English — never to a key name and never to a blank — so a partial pack is safe
to ship and improves without a code change. Nothing was machine-translated to
pad the numbers.

---

## 5. The order I would build it in

1. `POST /auth/sessions` and `GET /auth/session`, returning the object in §1.
   The whole frontend works the moment this is real — nothing else is needed to
   sign a real company in and land them in the right console.
2. `POST /organizations`, so a real company can be created by the onboarding
   that already exists.
3. The create endpoints in §2, one console at a time. Property first: it is the
   largest and the others reuse its patterns.
4. Read endpoints to replace the arrays, one screen at a time. The frontend
   never has to change shape — a screen reads a list and renders it.
5. Everything in §3, which is the long tail and none of which blocks a
   customer from using the product.

Nothing in steps 3–5 blocks step 1. A real subscription, a real login and a real
console can be live before a single create endpoint exists.
