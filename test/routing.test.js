/* ====================================================================== *
 * TWO ROUTES FOR ONE PATH IS NOT A TIE.
 *
 * ── THE BUG THIS FILE WAS WRITTEN FOR ──────────────────────────────────
 *
 * `routes/products.js` mounted the 28 generic resource routers first, and
 * its own hand-written endpoints second. One path existed in both:
 *
 *     POST /payments
 *
 * Express does not warn about that. It matches the first one and never
 * reaches the second, so the hand-written endpoint — the one that takes the
 * currency FROM the invoice, recomputes what is owed, and explains a
 * duplicate M-Pesa code as a double submit — became dead code that still
 * read as correct.
 *
 * The consequence was not cosmetic. Payments were recorded; the invoices
 * they paid stayed unpaid, because the only thing that recomputes a total
 * never ran. A customer would have settled their bill in full and gone on
 * seeing it as outstanding.
 *
 * It was found by running the routes rather than reading them. This file
 * makes sure reading is enough next time.
 *
 * ── THE SECOND BUG ─────────────────────────────────────────────────────
 *
 * `Zone.siteId` is NOT NULL in the schema, and `zones` did not list it as
 * required. `POST /zones {name}` therefore reached the database, which
 * refused it, and the caller got a 500 for a request that was one field
 * short. The last test here is the general form of that.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES } from "../src/domain/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const products = readFileSync(join(ROOT, "src", "routes", "products.js"), "utf8");
const framework = readFileSync(join(ROOT, "src", "http", "resource.js"), "utf8");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");

/* ---------------------------------------------------------------- */

/** Every hand-written endpoint: `guarded.post("/payments", …)`. */
function handWritten() {
  return [...products.matchAll(/^guarded\.(get|post|patch|delete)\("([^"]+)"/gm)]
    .map((m) => ({ verb: m[1].toUpperCase(), path: m[2] }));
}

/** What the framework registers for a resource, as verb + path pattern. */
function generic(slug) {
  const r = RESOURCES[slug];
  const out = [
    { verb: "GET", path: `/${slug}` },
    { verb: "GET", path: `/${slug}/:id` },
    { verb: "PATCH", path: `/${slug}/:id` },
    { verb: "DELETE", path: `/${slug}/:id` },
  ];
  if (!r.ownCreate) out.push({ verb: "POST", path: `/${slug}` });
  return out;
}

/**
 * Would Express match this request path against this pattern?
 *
 * Segment by segment, because that is how Express does it: `/:id` matches
 * exactly one segment and `/:id/folio` is a different, longer path that
 * `/:id` never claims.
 */
function sameShape(a, b) {
  const x = a.split("/").filter(Boolean);
  const y = b.split("/").filter(Boolean);
  if (x.length !== y.length) return false;
  return x.every((seg, i) =>
    seg.startsWith(":") || y[i].startsWith(":") || seg === y[i]);
}

/* ================================================================ */

test("no hand-written endpoint is shadowed by a generated one", () => {
  const collisions = [];

  for (const own of handWritten()) {
    for (const slug of Object.keys(RESOURCES)) {
      for (const gen of generic(slug)) {
        if (gen.verb !== own.verb) continue;
        if (!sameShape(gen.path, own.path)) continue;
        collisions.push(
          `${own.verb} ${own.path} (routes/products.js) is also registered by the ` +
          `framework as ${gen.verb} ${gen.path}. The resource routers are mounted ` +
          `FIRST, so the generated one wins and the hand-written one never runs.`);
      }
    }
  }

  assert.deepEqual(collisions, [],
    "Two routes claim one path:\n  " + collisions.join("\n  ") +
    "\n\nFix it in the DECLARATION, not by reordering mounts: set `ownCreate` " +
    "(or the matching flag) on the resource in domain/registry.js so the " +
    "framework does not register that verb at all. Reordering works until " +
    "somebody reorders it back.");
});

test("a resource that keeps its own create has one, and the framework skips it", () => {
  /* Both halves, because either alone is a broken endpoint: a declaration
     that opts out with nothing to fall through to is a 404 on a path the
     documentation promises. */
  assert.match(framework, /if \(!resource\.ownCreate\) \{/,
    "the framework no longer honours `ownCreate` — every hand-written create is " +
    "shadowed again");

  const own = handWritten();
  for (const [slug, r] of Object.entries(RESOURCES)) {
    if (!r.ownCreate) continue;
    assert.ok(typeof r.ownCreate === "string" && r.ownCreate.length > 30,
      `${slug}.ownCreate must say WHY, in a sentence a reviewer can check`);
    assert.ok(
      own.some((o) => o.verb === "POST" && o.path === `/${slug}`),
      `${slug} declares ownCreate, but routes/products.js has no POST /${slug}. ` +
      `The framework has been told not to build one, so that path now 404s.`);
  }
});

test("every hand-written endpoint checks permission before it does anything", () => {
  /*
   * The framework does this for its 140. These ten are outside it, so they
   * are the ten that can forget — and a money endpoint that forgets is one
   * anybody signed in can call.
   */
  const bodies = products.split(/^guarded\./m).slice(1);
  const missing = [];

  for (const chunk of bodies) {
    const head = chunk.match(/^(\w+)\("([^"]+)"/);
    if (!head) continue;
    const [, verb, path] = head;

    /* /summary decides per area inside itself — it returns a different set
       of counts per role rather than refusing outright. */
    if (path === "/summary") {
      assert.match(chunk, /allows\(req\.actor/,
        "/summary no longer filters its counts by what the role may see");
      continue;
    }
    if (!/\bneed\(req,/.test(chunk)) missing.push(`${verb.toUpperCase()} ${path}`);
  }

  assert.deepEqual(missing, [],
    "These endpoints never check the caller's role:\n  " + missing.join("\n  "));
});

test("a column the database insists on is a field the API insists on", () => {
  /*
   * THE GENERAL FORM OF THE ZONE BUG.
   *
   * A NOT NULL column with no default, that the registry does not list as
   * required, is a 500 waiting for the first person who leaves that field
   * blank — and a 500 tells them nothing about which field it was.
   */
  const models = new Map(
    [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]));

  const problems = [];
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const name = r.model.charAt(0).toUpperCase() + r.model.slice(1);
    const body = models.get(name) || "";

    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("@@") || line.startsWith("//")) continue;
      const f = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
      if (!f) continue;
      const [, field, type, mod = "", rest = ""] = f;

      if (mod === "?" || mod === "[]") continue;          // nullable, or a list
      if (models.has(type)) continue;                     // a relation object
      if (/@default\(|@updatedAt|@id\b/.test(rest)) continue;
      if (field === "orgId") continue;                    // from the session
      if (r.numbered === field) continue;                 // allocated by the framework

      if (!(r.required || []).includes(field)) {
        problems.push(
          `${slug}: ${name}.${field} is NOT NULL with no default, and "${field}" is ` +
          `not in this resource's \`required\` list. A create without it reaches the ` +
          `database, which refuses it, and the caller gets a 500 instead of being ` +
          `told which field was missing.`);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join("\n  "));
});

test("everything a resource requires is something a caller can send", () => {
  /* The mirror image: requiring a field that is not declared writable would
     make every create impossible, and the message would name a field the
     caller has no way to supply. */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    for (const key of r.required || []) {
      assert.ok(r.fields[key],
        `${slug} requires "${key}" but does not declare it as a writable field, ` +
        `so no request can ever satisfy it`);
    }
  }
});
