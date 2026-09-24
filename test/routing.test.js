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
/* Source is read through one helper, so a file renamed to .ts does not make
   this scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES } from "../src/domain/registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const products = sourceText("routes", "products.js");
const framework = sourceText("http", "resource.js");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");

/* ---------------------------------------------------------------- */

/**
 * Every hand-written endpoint, in every router that has any.
 *
 * It read products.js alone until a resource kept its own create in a
 * DIFFERENT file — the site diary, whose create and update live in site.js
 * because three of its rules are about which day an entry is for. The test
 * then reported that POST /site-diary did not exist, which was wrong and was
 * also the correct shape of alarm: a resource told the framework not to build
 * one, so if nothing else does, the path really is gone.
 *
 * So it reads all of them. `guarded.` in products.js, `<name>Routes.` in the
 * routers mounted above it — which is the convention every one of them
 * follows.
 */
const HAND_WRITTEN_FILES = [
  "products.js", "offers.js", "workflow.js", "comms.js", "site.js",
  "ledger.js", "company.js", "investments.js", "dna.js",
  "procurement.js", "predevelopment.js", "handover.js", "reports.js",
];

function handWritten() {
  const out = [];
  for (const file of HAND_WRITTEN_FILES) {
    let text;
    try { text = sourceText("routes", file); }
    catch { continue; }                  /* a router that has been renamed */
    for (const m of text.matchAll(/^\s*(?:guarded|\w+Routes)\.(get|post|patch|delete)\(\s*"([^"]+)"/gm)) {
      out.push({ verb: m[1].toUpperCase(), path: m[2], file });
    }
  }
  return out;
}

/** What the framework registers for a resource, as verb + path pattern. */
function generic(slug) {
  const r = RESOURCES[slug];
  const out = [
    { verb: "GET", path: `/${slug}` },
    { verb: "GET", path: `/${slug}/:id` },
    { verb: "DELETE", path: `/${slug}/:id` },
  ];
  if (!r.ownCreate) out.push({ verb: "POST", path: `/${slug}` });
  if (!r.ownUpdate) out.push({ verb: "PATCH", path: `/${slug}/:id` });
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

/**
 * Where a hand-written route is mounted decides whether it runs at all, and
 * there are two arrangements in this service:
 *
 *   IN products.js, beside the generated routers. The generated ones are
 *   registered first, so `GET /payments/history` never runs — `/payments/:id`
 *   claims it and answers with a payment called "history". These are
 *   collisions, and the fix is in the DECLARATION.
 *
 *   IN ITS OWN ROUTER, mounted above productRoutes in server.js. Then the
 *   hand-written one wins, which is the whole point of putting it there. The
 *   risk moves: it is no longer collision, it is somebody moving the mount.
 *
 * So the same path is checked two different ways depending on where it lives,
 * and the second check reads server.js rather than trusting a comment in it.
 */
const ABOVE_PRODUCTS = sourceText("server.js");

function mountedAboveProducts(file) {
  /*
   * The router's name is READ FROM THE FILE, never guessed from its name.
   * Guessing gave `offersRoutes` for offers.js, which exports `offerRoutes` —
   * so the search found nothing and the test reported a correctly-mounted
   * router as missing. A test that is wrong about where something is mounted
   * is worse than no test, because the next person fixes the code.
   */
  let text;
  try { text = sourceText("routes", file); }
  catch { return false; }
  const named = text.match(/export const (\w+) = Router\(\)/);
  if (!named) return false;

  const mine = ABOVE_PRODUCTS.search(new RegExp(`app\\.use\\(\\s*${named[1]}\\s*\\)`));
  const products = ABOVE_PRODUCTS.search(/app\.use\("\/",\s*productRoutes\)/);
  return mine >= 0 && products >= 0 && mine < products;
}

test("no hand-written endpoint is shadowed by a generated one", () => {
  const collisions = [];
  const unmounted = [];

  for (const own of handWritten()) {
    for (const slug of Object.keys(RESOURCES)) {
      for (const gen of generic(slug)) {
        if (gen.verb !== own.verb) continue;
        if (!sameShape(gen.path, own.path)) continue;

        /*
         * A router of its own, mounted first, is the arrangement that works —
         * so the only thing to check is that it really IS mounted first. A
         * comment saying so is not evidence; server.js is.
         */
        if (own.file !== "products.js") {
          if (!mountedAboveProducts(own.file)) {
            unmounted.push(
              `${own.verb} ${own.path} lives in routes/${own.file}, which server.js does ` +
              `NOT mount above productRoutes. The framework's ${gen.verb} ${gen.path} ` +
              `claims it first, so this endpoint never runs.`);
          }
          continue;
        }

        collisions.push(
          `${own.verb} ${own.path} (routes/${own.file}) is also registered by the ` +
          `framework as ${gen.verb} ${gen.path}. The resource routers are mounted ` +
          `FIRST inside this file, so the generated one wins and the hand-written ` +
          `one never runs.`);
      }
    }
  }

  assert.deepEqual(unmounted, [],
    "Endpoints in a router that is mounted too late:\n    " + unmounted.join("\n    ") +
    "\n\n  Move the app.use() for that router above app.use(\"/\", productRoutes) in server.js.");

  assert.deepEqual(collisions, [],
    "Two routes claim one path:\n    " + collisions.join("\n    ") +
    "\n\n  Fix it in the DECLARATION, not by reordering mounts: set `ownCreate` " +
    "(or the matching flag) on the resource in domain/registry.js so the framework " +
    "does not register that verb at all. Reordering works until somebody reorders it back.");
});

test("a resource that keeps its own create has one, and the framework skips it", () => {
  /* Both halves, because either alone is a broken endpoint: a declaration
     that opts out with nothing to fall through to is a 404 on a path the
     documentation promises. */
  assert.match(framework, /if \(!resource\.ownCreate && !resource\.noCreate\) \{/,
    "the framework no longer honours `ownCreate`/`noCreate` — every hand-written " +
    "create is shadowed again, and a resource staff must not create would gain " +
    "a create endpoint");

  const own = handWritten();

  /*
   * `noCreate` is the other half. `ownCreate` means "written by hand elsewhere
   * in this service"; `noCreate` means "written by somebody who is not staff".
   * So unlike ownCreate there must be NO route — a POST for it would be the
   * very endpoint the declaration exists to prevent.
   */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    if (!r.noCreate) continue;
    assert.ok(typeof r.noCreate === "string" && r.noCreate.length > 30,
      `${slug}.noCreate must say WHY, in a sentence a reviewer can check`);
    assert.ok(
      !own.some((o) => o.verb === "POST" && o.path === `/${slug}`),
      `${slug} declares noCreate, and routes/products.js has a POST /${slug} anyway`);
  }

  for (const [slug, r] of Object.entries(RESOURCES)) {
    if (!r.ownCreate) continue;
    assert.ok(typeof r.ownCreate === "string" && r.ownCreate.length > 30,
      `${slug}.ownCreate must say WHY, in a sentence a reviewer can check`);
    assert.ok(
      own.some((o) => o.verb === "POST" && o.path === `/${slug}`),
      `${slug} declares ownCreate, and no router writes a POST /${slug}. ` +
      `The framework has been told not to build one, so that path now 404s.`);
  }

  /* `ownUpdate` is the same bargain for edits, and carries the same risk: a
     resource that opts out of the generated PATCH and then never writes one
     has quietly become read-only, which nothing else would notice. */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    if (!r.ownUpdate) continue;
    assert.ok(typeof r.ownUpdate === "string" && r.ownUpdate.length > 30,
      `${slug}.ownUpdate must say WHY, in a sentence a reviewer can check`);
    assert.ok(
      own.some((o) => o.verb === "PATCH" && sameShape(o.path, `/${slug}/:id`)),
      `${slug} declares ownUpdate, and no router writes a PATCH /${slug}/:id. ` +
      `It has silently become read-only.`);
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
    /* A resource nothing creates through this API has no create to get wrong.
       `guest-requests` is made by the guest, where the stay and the party come
       from their session rather than from a body. */
    if (r.noCreate) continue;
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
