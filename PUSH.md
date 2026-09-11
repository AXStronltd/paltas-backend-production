# Pushing paltas-backend

Push puts the code in GitHub. **Nothing goes live.** No server starts, no
database is touched, nobody outside can reach it. Render is a separate
decision, later.

Everything below is one Terminal window. In VS Code: **Terminal → New
Terminal**.

---

## Before anything: two things I found

**1. There is a stale lock file.** My read-only check of your repo left
`.git/index.lock` behind and could not remove it — the bridge I use is not
allowed to delete files on your Mac. Git will refuse `git add` until it is
gone. The first line below removes it.

**2. Your repo has no remote.** Three commits exist locally and have never
been connected to GitHub. So there is a one-time step to point it at a
repository.

---

## 1. Clear the lock and see what will go

```bash
cd ~/Documents/paltas-backend
rm -f .git/index.lock
git status
```

You should see about 34 changed and new files. **No `.env`** — `.gitignore`
already excludes it, and I checked: nothing secret is staged. `.env.example`
does go, and it is safe; every secret in it is a bare name with no value.

## 2. Point it at GitHub, once

If the repository does not exist yet, make it at
**github.com/new** — owner `AXStronltd`, name `paltas-backend`,
**Private**, and do **not** tick "Add a README" (the repo already has one).

Then:

```bash
git remote add origin https://github.com/AXStronltd/paltas-backend.git
```

If you have the GitHub CLI, that whole step is one line instead:

```bash
gh repo create AXStronltd/paltas-backend --private --source=. --remote=origin
```

## 3. Commit

```bash
git add -A
git commit -F- <<'MSG'
The six products: 150 endpoints, and the console's own forms

Builds Property, Development, Hotel, Agent & Host, Security and the shared
money spine on top of the existing auth and promotions slice.

  - 45 models, 40 enums, migrations verified column by column against a
    real PostgreSQL 16
  - 140 of the 150 endpoints are generated from 28 resource declarations,
    so organization scoping, permissions, paging and audit are structural
    rather than remembered
  - all 27 console create forms in backend.md §2 are accepted, using the
    frontend's own field names — nothing in the frontend changes
  - 217 tests, 0 failing

Found and fixed along the way:

  - POST /payments was shadowed by the generated route, so the only code
    that recomputes an invoice never ran: paid invoices stayed unpaid
  - 29 enums were written on one line, which is not valid Prisma and would
    have failed at prisma generate
  - "9 Sep" parsed as the year 2001
  - four dangling id columns with no foreign key

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WpxYZLYReUnbZmDoyjP3zr
MSG
```

## 4. Push

```bash
git push -u origin main
```

If it asks to sign in, a browser opens — that is normal for the first push.

---

## After it is up

Nothing is live. To check the push worked:

```bash
git log --oneline -1
git status
```

`git status` should say "nothing to commit, working tree clean".

---

## Then, when you want the last 54 tests

Still on your machine, still not live:

```bash
npx prisma generate
npm test
```

See **RUN.md** for the database step. Going live on Render is **DEPLOY.md**,
and it is a decision for later — not part of this.
