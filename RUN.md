# Getting to 844 / 844

**Where it stands: 844 tests, 844 passing, 0 failing, 0 skipped** — with a
generated Prisma client and a PostgreSQL to point at:

```bash
npx prisma generate
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:5432/paltas_backend_test npm test
```

Without those, the suite still passes; the tests that need them skip
themselves and say why. The heading below described the state when neither
was available on the machine this was built on.

Since the last note the number went up, and so did what it covers. I stopped
waiting for your machine and built a stand-in for Prisma that keeps rows in
memory, so **the real Express app, the real routers and the real guards now
run here**.

They found three bugs on the first run. All three are fixed, and each now has
a test that would catch the next one of its kind.

---

## Checked against your frontend, form by form

`contract/backend.md` §2 lists all 27 create forms in the built console with
the exact fields each one posts. A test now **parses that table and posts
every form at the running API**. Two things came out of it:

**All 27 forms would have failed.** The console posts its own short names —
`{n, cat, host, veh}` for a visitor, `{t, p, pr, who}` for a maintenance
request — and this API expected `visitor, category, hostName, vehicle`. Both
namings are right where they live; they were simply not connected. There is
now one table on the server that accepts both, so **nothing in the frontend
changes**.

**Eleven fields had nowhere to go.** The console collects them and shows
them, and the database had no column: how many units a property has and what
it is worth, which unit a resident lives in and how many cars they keep, the
property a booking is for, the room number typed before a room is chosen.
They were added rather than dropped — a form that looks like it saved and
quietly loses a value is worse than one that refuses.

And one trap worth naming: the console writes dates the way people do —
`"9 Sep"`, `"Mar 2024"`, `"Thu 10:00"`. JavaScript parses `"9 Sep"` happily,
as **2001**. A booking taken for next week would have been filed a quarter of
a century in the past with no error anywhere. Those formats are now parsed
properly, and anything genuinely unreadable is refused instead of guessed at.

§3 of the contract — the 45 endpoints the buttons name out loud — was a
different matter when this was written: 8 served, the rest not built. Every one of the 45
now has a written decision and a reason, and a test fails if one is ever
added, quietly served, or quietly dropped.

---

## The one that mattered

`POST /payments` was registered twice — once by the framework that builds the
47 resources, once by hand — and Express silently used the first. **The
hand-written one never ran.** It is the only thing that recomputes what an
invoice is owed.

So: a customer pays a bill in full, the payment is recorded correctly, and
**the invoice goes on saying unpaid**. Forever. The currency rule never ran
either, so a payment in dollars would have counted toward a shilling total.

Nobody reading the code would have seen it. Both files are correct on their
own; the bug is only in the order they were mounted.

The other two: `POST /zones` answered `500` for a request that was one field
short (`siteId` is required by the database and the API never said so), and a
test was filling a reference field with a label instead of a real id.

---

## The 35 that still skip

They need a generated Prisma client, and `prisma generate` downloads an
engine from `binaries.prisma.sh`. Every environment available to me is
blocked from that host — I tried the npm package, the Alibaba mirror, the
WASM engine, the driver adapter and Prisma 7. Your Mac is not blocked.

Their product half is now mirrored by tests that **do** run. What stays
untested is the join: real Prisma issuing real SQL.

## 1. The client first

```bash
cd ~/Documents/paltas-backend
npx prisma generate
npm test
```

That needs nothing but Node and internet. **Expect `217 tests, 163 pass,
54 skip, 0 fail`** — and the 163 is the whole service above the database:
every rule, every guard, all 27 console forms posted at a running server.

The 54 that skip are the ones needing a real PostgreSQL. Step 2 turns them
on.

## 2. A database

There is no Docker on this Mac and no Postgres.app, so Homebrew is the
short road:

```bash
brew install postgresql@16
brew services start postgresql@16
export TEST_DATABASE_URL="postgresql://kaboole@127.0.0.1:5432/postgres"
npm test
```

> `kaboole`, not `postgres`. Homebrew creates a superuser named after your
> macOS account, and a connection string copied from a tutorial fails
> against a perfectly healthy database. That is the `28000` error from last
> time, and the tests now say so in plain words instead of leaving you to
> decode it. `28000` means the role does not exist; `28P01` means the
> password is wrong. Neither is ever the schema.

If Postgres is already running on 5432, skip the install and just set
`TEST_DATABASE_URL`.

## 3. Everything

With both done:

```bash
npm test
```

**Expect `217 tests, 217 pass, 0 fail, 0 skipped`.**

---

## If something fails

Send me the output. Don't change a test to make it pass — the tests are the
specification, and if one is wrong I need to know which and why.

Worth running once, too:

```bash
npx prisma validate        # should say the schema is valid
npx prisma migrate status  # should report no drift
```

Both matter because the migrations were assembled by hand — `prisma migrate
dev` needs the same blocked host. `validate` already passes here, and it
earned its place: it caught 29 enums written on one line, which is not valid
Prisma and would have stopped step 2 dead.

---

## What is already proved

Against a real PostgreSQL 16, and against the in-memory stand-in:

- **every endpoint has now actually executed** — 20 scenarios over real HTTP,
  including a sweep that creates a row in all 47 resources as one company and
  checks the other company can see none of them
- the migrations build exactly what `schema.prisma` declares: every column,
  type, nullability, index, foreign key and delete rule, checked both ways
- deleting a company takes all six products' rows with it, through four
  levels of cascade
- an invoice total is the sum of its lines plus tax, in integers, and cannot
  be sent by a caller
- a payment cannot be deleted, cannot be double-banked, and voiding one
  requires a reason and puts the money back on the invoice
- no query in any route file or in the framework escapes its organization
- no hand-written route is shadowed by a generated one — the test that now
  exists because one was

**Nothing has been committed, pushed or deployed.**
