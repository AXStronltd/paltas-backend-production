/* ====================================================================== *
 * MULTI-TENANT ISOLATION, AS AN INVARIANT RATHER THAN A HABIT.
 *
 * PALTAS is one database holding many companies' businesses. The single
 * worst bug this system could have is one company reading another's — a
 * hotel seeing a competitor's rates, a security firm seeing another's
 * incident log.
 *
 * Today that is safe, and I checked it by reading every query. That does not
 * scale. The frontend's own backend.md names 27 create endpoints and 45 more
 * beyond them, across six products; by the time those exist, nobody is going
 * to re-read every query by hand, and the one that gets missed will not
 * announce itself.
 *
 * So the rule is enforced here instead:
 *
 *     EVERY query against an organization-owned model must be scoped to an
 *     organization, or be named below with a reason.
 *
 * A new route that forgets is a failing test, not a support ticket from a
 * customer who saw somebody else's data.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");

/* ---------------------------------------------------------------- */

/** Every model in the schema, with its body. */
function models() {
  const out = new Map();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/*
 * OWNING AN ORGANIZATION'S DATA IS NOT THE SAME AS REFERRING TO ONE.
 *
 * A Subscription belongs to a company: delete the company and it goes too,
 * and every query for it filters by organization.
 *
 * A Session merely POINTS AT one — "which company is this browser acting
 * for". It belongs to a PERSON. Deleting a company must not delete the
 * sessions of people who also belong to other companies; it must drop the
 * pointer and leave them signed in.
 *
 * The two need different rules, so they are told apart by how they relate:
 * Cascade is ownership, SetNull is a reference.
 */
/**
 * Which rule applies is decided by the ORG RELATION LINE, not by the model.
 *
 * The first version of this looked for `onDelete: SetNull` anywhere in the
 * model body, and that was wrong in a way worth recording: a Building
 * cascades from its Organization and SetNulls from its Site, so the moment
 * Building existed it was classified as a mere reference — and silently
 * dropped out of the cascade and index checks below. Fifteen more models had
 * the same shape. The tests still passed, on nothing.
 *
 * So the org field is read specifically.
 */
function orgRule(body) {
  const m = body.match(/^\s*org\s+Organization\??\s+@relation\(([^)]*)\)/m);
  if (!m) return null;
  return /onDelete:\s*SetNull/.test(m[1]) ? "reference" : "owned";
}

function orgOwned() {
  const out = new Set();
  for (const [name, body] of models()) {
    if (!/^\s*orgId\s+String/m.test(body)) continue;
    if (orgRule(body) === "owned") out.add(name);
  }
  return out;
}

/** Models that point at an organization without being owned by one. */
function orgReferencing() {
  const out = new Set();
  for (const [name, body] of models()) {
    if (!/^\s*orgId\s+String/m.test(body)) continue;
    if (orgRule(body) === "reference") out.add(name);
  }
  return out;
}

/** `db.promotion.findMany` → "Promotion". Prisma lower-cases the first letter. */
const modelOf = (accessor) => accessor.charAt(0).toUpperCase() + accessor.slice(1);

function routeFiles() {
  const dir = join(SRC, "routes");
  return readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
}

/*
 * THE EXEMPTIONS, EACH WITH A REASON.
 *
 * An exemption is a decision, so it is written down where a reviewer will see
 * it. "It seemed fine" is not on this list and never should be.
 */
const EXEMPT = [
  {
    file: "promotions.js",
    match: /publicWhere\(today\)/,
    why: "GET /promotions/public is the public feed. It is unscoped BY DESIGN — " +
         "it is what a visitor with no session sees. Its safety comes from " +
         "PUBLIC_STATES, not from tenancy, and rules.test.js covers that " +
         "exhaustively.",
  },
  {
    file: "platform.js",
    /* Marked at EVERY query site, not once at the top of the file — a reviewer
       reading any one of these queries sees the exemption beside it, and a new
       query added without the marker fails this test rather than inheriting a
       blanket pass. */
    match: /CROSS-TENANT BY DESIGN — requirePlatform\(\) above, read-only, audited below\./,
    why: "The PALTAS staff console. It is cross-tenant BY DESIGN — supporting a " +
         "customer means being able to see them — and it is a separate file for " +
         "exactly that reason, so the organization filter in http/resource.js " +
         "stays unconditional rather than becoming an `if`. Its safety comes from " +
         "requirePlatform() (the PLATFORM entitlement AND a staff role), from " +
         "being read-only, from returning counts rather than contents, and from " +
         "auditing every read. platform-api.test.js covers all four, and asserts " +
         "this file never touches the resource framework.",
  },
];

/* ================================================================ */

test("the schema knows which models belong to an organization", () => {
  const owned = orgOwned();
  /*
   * THE FLOOR IS HIGH ON PURPOSE.
   *
   * Every other test in this file iterates over this set. If the detection
   * breaks — a rename, a formatting change, a regex that stops matching —
   * the set empties and all of them pass, on nothing, silently. That already
   * happened once: see the comment on orgRule(). A number that has to keep
   * going up is the cheapest guard against it happening again.
   */
  assert.ok(owned.size >= 30,
    `only ${owned.size} org-owned models found — the detection has probably broken, ` +
    `because the schema has ${models().size} models and almost all of them belong ` +
    `to a company`);

  /* One per product, so a whole product cannot drop out unnoticed. */
  for (const m of ["Subscription", "Entitlement", "Membership", "Workspace", "Promotion",
                   "Lease", "Reservation", "Listing", "Incident", "Invoice", "Payment"]) {
    assert.ok(owned.has(m), `${m} should be organization-owned`);
  }
});

test("a model with no organization of its own inherits one from its parent", () => {
  /*
   * The line tables — InvoiceLine, FolioLine, the three event logs — carry no
   * orgId, and that is right: an invoice line belongs to an invoice, and
   * storing the company twice is how the two copies come to disagree.
   *
   * But it means they are invisible to every check above, so the isolation
   * they DO have is checked here: each must cascade from a parent that is
   * itself organization-owned. Then deleting a company reaches them
   * transitively, and a query that joins through the parent is scoped.
   */
  const owned = orgOwned();
  /*
   * The models that belong to NOBODY, on purpose.
   *
   * A User spans companies, an Organization IS the company, a Counter is
   * per-company by its `name` rather than a column — and a Plan is PALTAS's
   * price list, the same for every customer, like a country code. Giving Plan
   * an orgId would invite exactly the bug it would then hide: a company
   * quietly editing the price it is charged.
   */
  const ROOTS = new Set(["User", "Organization", "Counter", "Plan"]);

  for (const [name, body] of models()) {
    if (owned.has(name) || orgReferencing().has(name) || ROOTS.has(name)) continue;

    const parents = [...body.matchAll(/^\s*\w+\s+(\w+)\s+@relation\(([^)]*)\)/gm)]
      .filter(([, type]) => models().has(type))
      .filter(([, , args]) => /onDelete:\s*Cascade/.test(args))
      .map(([, type]) => type);

    const rooted = parents.some((p) => owned.has(p));
    assert.ok(rooted,
      `${name} has no orgId and cascades from no organization-owned model ` +
      `(parents: ${parents.join(", ") || "none"}). It therefore belongs to nobody: ` +
      `deleting a company would leave its rows behind, and no query against it ` +
      `is scoped by anything. Give it an orgId, or a cascading parent that has one.`);
  }
});

test("every organization-owned model cascades when its organization is deleted", () => {
  for (const [name, body] of models()) {
    if (!orgOwned().has(name)) continue;
    assert.match(body, /org\s+Organization\s+@relation\([^)]*onDelete:\s*Cascade/,
      `${name} carries an orgId but does not cascade — deleting a company would ` +
      `leave its ${name} rows behind, orphaned and still readable`);
  }
});

test("every organization-owned model is indexed by organization", () => {
  for (const [name, body] of models()) {
    if (!orgOwned().has(name)) continue;
    const indexed = /@@index\(\[orgId/.test(body) ||
                    /@@unique\(\[orgId/.test(body) ||
                    /orgId\s+String\s+@unique/.test(body) ||
                    /@@unique\(\[userId, orgId\]\)/.test(body);
    assert.ok(indexed,
      `${name} has no index on orgId. Every query for it filters by organization, ` +
      `so without one every such query is a full table scan across every customer.`);
  }
});

test("a model that only REFERENCES an organization drops the pointer, never the row", () => {
  const refs = orgReferencing();
  assert.ok(refs.has("Session"),
    "Session should reference an organization rather than be owned by one — " +
    "it belongs to a person, and deleting one of their companies must not sign " +
    "them out of the others");

  for (const name of refs) {
    const body = models().get(name);
    assert.match(body, /org\s+Organization\?\s+@relation\([^)]*onDelete:\s*SetNull/,
      `${name} points at an organization without a foreign key, so nothing stops ` +
      `it referring to one that has been deleted`);
    assert.match(body, /orgId\s+String\?/,
      `${name}.orgId must be nullable — SetNull has nowhere to put the null otherwise`);
  }
});

/* ================================================================ *
 * THE ONE THAT MATTERS.
 * ================================================================ */

test("no query against an org-owned model escapes its organization", () => {
  const owned = orgOwned();
  const problems = [];

  for (const file of routeFiles()) {
    const name = file.split("/").pop();
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");

    for (const m of text.matchAll(
      /db\.(\w+)\.(findMany|findFirst|findUnique|updateMany|deleteMany|count|aggregate)\(/g)) {
      const model = modelOf(m[1]);
      if (!owned.has(model)) continue;

      const line = text.slice(0, m.index).split("\n").length;

      /*
       * The handler around the call, not just the call. A `where` is very
       * often built a few lines above — `const where = {}; if (…) where.orgId
       * = actor.orgId;` — and a window that only looks forwards reports that
       * as unscoped, which is a false alarm that teaches people to ignore
       * this test.
       */
      const from = Math.max(0, line - 30);
      const to = Math.min(lines.length, line + 20);
      const context = lines.slice(from, to).join("\n");

      const exempt = EXEMPT.find((e) => e.file === name && e.match.test(context));
      if (exempt) continue;

      /*
       * `userId` counts as a scope too, and for Membership it is the more
       * natural one: "which companies does THIS person belong to" is a
       * per-person question, and answering it by organization would be the
       * wrong query. What matters is that SOMETHING from the session narrows
       * it — never nothing.
       */
      const scoped = /orgId|organizationId|userId_orgId|userId:\s*req\.session\.userId|userId:\s*actor\.userId/
        .test(context);
      if (!scoped) {
        problems.push(`${name}:${line}  db.${m[1]}.${m[2]}()  — no organization in scope`);
      }
    }
  }

  assert.deepEqual(problems, [],
    "These queries could return another company's rows:\n  " + problems.join("\n  ") +
    "\n\nScope them to req.actor.orgId, or add an entry to EXEMPT in this file " +
    "with the reason it is safe.");
});

test("the exemption list is short, and every entry still applies", () => {
  /* An exemption list that grows is a rule being eroded one pull request at a
     time. Three is a lot; if this ever fails, the question to ask is whether
     the rule is wrong, not whether the limit should go up. */
  assert.ok(EXEMPT.length <= 3, `${EXEMPT.length} exemptions — that is too many to hold in your head`);

  for (const e of EXEMPT) {
    const text = readFileSync(join(SRC, "routes", e.file), "utf8");
    assert.ok(e.match.test(text),
      `the exemption for ${e.file} no longer matches anything — delete it`);
    assert.ok(e.why && e.why.length > 40, `the exemption for ${e.file} has no real reason`);
  }
});

/* ================================================================ */

test("a person only ever acts for an organization they belong to", () => {
  /*
   * `actorFor()` builds req.actor from the person's MEMBERSHIPS, never from
   * anything the request said. That is the load-bearing line: if an
   * organization id could arrive in a body or a header and be believed, every
   * other check in this service would be decoration.
   */
  const view = readFileSync(join(SRC, "domain", "session-view.js"), "utf8");
  assert.match(view, /db\.membership\.findMany\(\{\s*where:\s*\{\s*userId/,
    "the session is not built from the person's own memberships");

  /* And the one place an organization can be switched checks membership. */
  const auth = readFileSync(join(SRC, "routes", "auth.js"), "utf8");
  const handler = auth.match(/session\/organization[\s\S]*?\n\}\);/);
  assert.ok(handler, "the organization-switch route is gone");
  assert.match(handler[0], /db\.membership\.findUnique/,
    "switching organization does not verify membership — anybody could act for anybody");
  assert.match(handler[0], /userId:\s*req\.session\.userId/,
    "the membership check does not use the SESSION's user id");
});

test("nothing trusts an organization id sent by the caller", () => {
  /*
   * The failure this prevents: a route that reads `req.body.organizationId`
   * and queries with it. The switch route above is the single legitimate use,
   * and it checks membership before believing it.
   */
  const offenders = [];
  for (const file of routeFiles()) {
    const name = file.split("/").pop();
    /*
     * THE STAFF CONSOLE IS NOT MAKING A TRUST DECISION.
     *
     * `GET /platform/audit?organization=…` narrows a list the caller may
     * already see in full — every PLATFORM staff member can read every
     * company, so naming one is a FILTER, not an escalation. There is nothing
     * a membership check could add: the answer would be the same either way.
     *
     * Skipped here rather than given a fake membership lookup, because a
     * check that exists only to satisfy a test is worse than no check: the
     * next reader believes it does something.
     */
    if (name === "platform.js") continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/req\.(body|query|params)\??\.\w*[Oo]rg\w*/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      const context = text.split("\n").slice(Math.max(0, line - 3), line + 12).join("\n");
      /* Legitimate only when it is checked against a membership first. */
      if (/db\.membership\.findUnique|not a member/.test(context)) continue;
      offenders.push(`${name}:${line}  ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    "An organization id from the request is believed without checking membership:\n  " +
    offenders.join("\n  "));
});

test("the actor's rights come from the database, not the request", () => {
  const view = readFileSync(join(SRC, "domain", "session-view.js"), "utf8");
  const actor = view.match(/export async function actorFor[\s\S]*?\n\}/);
  assert.ok(actor, "actorFor() is gone");
  assert.ok(!/req\.|request/.test(actor[0]),
    "actorFor() reads something from the request — role and scope must come " +
    "from the session row and its memberships alone");
});

/* ================================================================ *
 * THE FRAMEWORK ITSELF.
 *
 * The scan above reads src/routes/*.js and looks for `db.<model>.<verb>`.
 * That misses the file with more queries in it than all of them put
 * together, for two reasons: http/resource.js is not in routes/, and it
 * reaches the model through `db[resource.model]`, which is not a literal.
 *
 * A dynamic accessor is exactly the shape a scanner cannot follow, so the
 * rule has to be enforced differently here: by reading the framework's own
 * code and insisting that every query it makes carries the organization,
 * and that nothing outside these two reviewed files uses that shape at all.
 * ================================================================ */

const FRAMEWORK = join(SRC, "http", "resource.js");

test("every query the resource framework makes is scoped to one company", () => {
  const text = readFileSync(FRAMEWORK, "utf8");
  const lines = text.split("\n");
  const problems = [];

  /* `model()` is the framework's accessor, and db[...] is how it and
     products.js reach a model chosen at run time. */
  /*
   * ONE EXEMPTION, AND IT IS A REAL ONE.
   *
   * appendHistory() writes a WorkOrderEvent or an IncidentEvent, and those
   * tables carry no orgId by design — they belong to their parent, and
   * storing the company twice is how the two copies come to disagree. The
   * row they attach to was loaded by an org-scoped query a few frames up,
   * so `row.id` is already this company's; there is nothing to filter by.
   * migration.test.js proves those tables cascade from an org-owned parent.
   */
  const EXEMPT_HERE = [{
    fn: "appendHistory",
    why: "writes an event row keyed by a parent id that was itself loaded scoped; " +
         "event tables carry no orgId of their own",
  }];

  for (const m of text.matchAll(
    /(?:model\(\)|db\[[^\]]+\])\.(findMany|findFirst|findUnique|updateMany|deleteMany|create|count)\(/g)) {
    const line = text.slice(0, m.index).split("\n").length;

    /* A window BACK, because `where` is very often built well above the call
       — `const where = { orgId }; if (…) where.x = …`. A window that only
       looks forward reports that as unscoped, and a test that cries wolf is
       one people learn to ignore. */
    const context = lines.slice(Math.max(0, line - 30), line + 14).join("\n");

    const exempt = EXEMPT_HERE.find((e) => context.includes("function " + e.fn));
    if (exempt) continue;

    /* A create puts orgId IN, the rest filter BY it. Both count; neither
       may be absent. */
    if (/orgId/.test(context)) continue;

    /*
     * AND IF IT IS NOT IN THE WINDOW, FOLLOW THE VARIABLE.
     *
     * A fixed lookback is the fragile part of this test: the list query
     * builds `where` and then spends thirty lines narrowing it by status,
     * id fields, search and paging, so one more line of narrowing pushes
     * `orgId` out of sight and this test fails on code that is correct.
     *
     * Widening the window would be the easy fix and the wrong one — it
     * weakens every other case to accommodate one. So instead: when the
     * call passes `where` (or `where: NAME`), find where that variable was
     * declared and look THERE. That is the actual invariant — not "orgId is
     * nearby" but "the filter this query uses was built with orgId" — and
     * it cannot be defeated by adding lines.
     */
    const call = lines.slice(line - 1, line + 12).join("\n");
    /* Either `where: NAME` or the shorthand `where,` — which is what the list
       query actually writes, and what this test missed the first time. */
    const passed = call.match(/\bwhere\s*:\s*([A-Za-z_$][\w$]*)\s*[,\n}]/)
                || call.match(/\bwhere\s*[,\n]/);
    if (passed) {
      const name = passed[1] || "where";
      /* The nearest declaration ABOVE the call wins — the same one the
         running code would have closed over. */
      const before = text.slice(0, m.index);
      const decl = [...before.matchAll(
        new RegExp("(?:const|let|var)\\s+" + name + "\\s*=\\s*\\{", "g"))].pop();
      if (decl) {
        /* From the declaration to the call — everything that built it. */
        const built = before.slice(decl.index);
        if (/orgId/.test(built)) continue;
      }
    }

    problems.push(`resource.js:${line}  .${m[1]}()  — no orgId anywhere near it, ` +
      `and no org-scoped \`where\` it could be using`);
  }

  assert.ok(problems.length === 0,
    "The framework makes a query that is not scoped to an organization. Every route " +
    "in the product API is built from this file, so one unscoped query here is " +
    "unscoped everywhere:\n  " + problems.join("\n  "));

  /*
   * And the specific thing the whole design rests on: the list `where` OPENS
   * with the session's organization.
   *
   * `\{\s*orgId` is the assertion — `{` then whitespace then orgId, so no other
   * key can precede it and nothing can be spread in ahead of it. What comes
   * AFTER is allowed to grow: site scope narrows it further in the same
   * literal, and the next thing will too. Pinning the exact characters
   * `{ orgId: req.actor.orgId }` would fail on a correct narrowing, which
   * teaches whoever hits it to loosen the regex rather than read it.
   */
  assert.match(text, /const where = \{\s*orgId: req\.actor\.orgId\b/,
    "the list endpoint no longer starts from a scoped `where` — that is what " +
    "makes every list in the product API safe");
  assert.match(text, /data: \{ \.\.\.data, orgId: req\.actor\.orgId \}/,
    "create no longer puts the session's organization LAST. Spread order is what " +
    "stops a declaration that mistakenly allowed orgId from letting a request choose it.");
});

test("nothing outside the framework reaches a model through a variable", () => {
  /*
   * `db[whatever]` cannot be checked by reading. Two files do it, both
   * reviewed, both tested above. A third would be a query nobody can audit,
   * so it is refused here rather than found later.
   */
  const ALLOWED = new Set(["resource.js", "products.js"]);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith(".js")) continue;
      if (ALLOWED.has(entry.name)) continue;
      /* Comments do not run. registry.js documents the shape in prose, and
         reporting its own documentation as a violation is the sort of false
         alarm that gets a test deleted. */
      const raw = readFileSync(p, "utf8");
      const text = raw
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const m of text.matchAll(/db\[/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${entry.name}:${line}`);
      }
    }
  };
  walk(SRC);

  assert.deepEqual(offenders, [],
    "These reach a Prisma model through a variable, so no scanner can tell which " +
    "table they touch or whether it was scoped:\n  " + offenders.join("\n  "));
});

test("the product routes read a row by id and organization together", () => {
  /*
   * `own()` is the single way routes/products.js loads one row. If it ever
   * stops filtering by organization, every hand-written endpoint in that
   * file — voiding a payment, closing a folio, admitting a visitor — starts
   * working on other companies' rows at once.
   */
  const text = readFileSync(join(SRC, "routes", "products.js"), "utf8");
  const own = text.match(/async function own\([\s\S]*?\n\}/);
  assert.ok(own, "own() is gone from products.js");
  assert.match(own[0], /where: \{ id, orgId \}/,
    "own() no longer filters by organization — every endpoint in products.js " +
    "depends on it doing so");
  assert.match(own[0], /throw hidden\(\)/,
    "own() no longer hides a row it may not return. A 403 for somebody else's " +
    "row confirms the row exists, which is how two companies enumerate each other.");

  /* And no endpoint in that file may load a row any other way. */
  const problems = [];
  const lines = text.split("\n");
  for (const m of text.matchAll(/db\.(\w+)\.(findFirst|findMany|findUnique|updateMany|deleteMany|count)\(/g)) {
    const line = text.slice(0, m.index).split("\n").length;
    const context = lines.slice(Math.max(0, line - 8), line + 12).join("\n");
    if (!/orgId|invoiceId: invoice\.id|folioId: folio\.id|where: \{ id: \w+\.id \}/.test(context)) {
      problems.push(`products.js:${line}  db.${m[1]}.${m[2]}()`);
    }
  }
  assert.deepEqual(problems, [],
    "These load rows without an organization in scope:\n  " + problems.join("\n  "));
});
