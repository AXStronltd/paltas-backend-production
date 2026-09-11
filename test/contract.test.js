/* ====================================================================== *
 * THE CONTRACT, CHECKED AGAINST THE FRONTEND'S OWN DOCUMENT.
 *
 * `backend.md` in the paltas-frontend repository is not a description of this
 * service — it is the specification this service was built to, written before
 * it existed. So this file does not restate the contract. It READS that
 * document, extracts what it promises, and checks the code against it.
 *
 * Which means the day somebody edits backend.md, this suite tells them what in
 * the API no longer matches — instead of the two drifting apart quietly and
 * being discovered by a console that opens empty.
 *
 * Point it at the real file:
 *     BACKEND_MD=../paltas-frontend/backend.md npm test
 * Without it, it uses the copy in `contract/` and says so.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* Same reasoning as INDEX_PATH below: the committed copy, or one named
   explicitly. Never a sibling folder picked up by accident. */
const CANDIDATES = [
  process.env.BACKEND_MD,
  join(HERE, "..", "contract", "backend.md"),
].filter(Boolean);

const MD_PATH = CANDIDATES.find((p) => existsSync(p));
const skip = MD_PATH ? false : "backend.md not found — set BACKEND_MD to the frontend's copy";
const md = MD_PATH ? readFileSync(MD_PATH, "utf8") : "";

const src = (rel) => readFileSync(join(HERE, "..", "src", rel), "utf8");

/* ================================================================ *
 * §1 — the session object.
 * ================================================================ */

test("every field §1 names is in the session this API returns", { skip }, async () => {
  /* The JSON block in §1, read from the document rather than copied. */
  const block = md.match(/```json\s*\n\{\s*\n(\s*"user"[\s\S]*?)\n```/);
  assert.ok(block, "§1's session block is not where it was — has backend.md been restructured?");

  const promised = [...block[1].matchAll(/^\s*"(\w+)":/gm)].map((m) => m[1]);
  assert.ok(promised.length >= 7, `only found ${promised.length} fields in §1`);

  const view = src("lib/session-view.js");
  for (const field of promised) {
    assert.match(view, new RegExp(`\\b${field}\\s*:`),
      `§1 promises \`${field}\` and sessionView() does not build it`);
  }
});

test("every enum value §1 allows is one the database can hold", { skip }, async () => {
  const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");

  /* The "Allowed values" table in §1, parsed out of the document. */
  const rows = [...md.matchAll(/^\| `([\w.\[\]]+)` \| (.+?) \|$/gm)]
    .filter(([, field]) => /^(subscription\.status|entitlements\[\]\.product|verification\.status|memberships\[\]\.role)$/.test(field));

  assert.ok(rows.length >= 4, `found ${rows.length} of the 4 enum rows in §1`);

  for (const [, field, values] of rows) {
    const allowed = [...values.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    assert.ok(allowed.length, `no values parsed for ${field}`);
    for (const v of allowed) {
      assert.match(schema, new RegExp(`^\\s*${v}\\s*$`, "m"),
        `§1 allows ${field} = ${v}, and the Prisma schema has no such enum member`);
    }
  }
});

test("§1's three rules are the three the code actually implements", { skip }, async () => {
  const rights = src("lib/rights.js");

  /* 1 — verification restricts publish and payout, and nothing else. */
  assert.match(md, /Verification never closes a console/i);
  const restricts = rights.match(/VERIFICATION_RESTRICTS = \{([\s\S]*?)\n\};/);
  assert.ok(restricts, "VERIFICATION_RESTRICTS is gone");
  const acts = new Set([...restricts[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));
  for (const a of acts) {
    assert.ok(["publish", "payout"].includes(a),
      `verification restricts "${a}", and §1 says it restricts only publish and payout`);
  }

  /* 2 — PAST_DUE still opens the console. */
  assert.match(md, /`PAST_DUE` still opens the console/i);
  const open = rights.match(/OPEN_SUBSCRIPTIONS = new Set\(\[([^\]]*)\]/);
  assert.ok(open, "OPEN_SUBSCRIPTIONS is gone");
  assert.match(open[1], /"PAST_DUE"/, "PAST_DUE does not open the console");
  assert.ok(!/"CANCELED"/.test(open[1]), "CANCELED opens the console");
  assert.ok(!/"EXPIRED"/.test(open[1]), "EXPIRED opens the console");

  /* 3 — a product is not a role. Two tables, two questions. */
  assert.match(md, /A product is not a role/i);
  const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /model Entitlement \{[\s\S]*?product\s+Product/,
    "entitlements do not carry a product");
  assert.match(schema, /model Membership \{[\s\S]*?role\s+Role/,
    "memberships do not carry a role");
});

test("every endpoint §1 names exists in the routes", { skip }, async () => {
  const auth = src("routes/auth.js");
  const orgs = src("routes/organizations.js");

  /* §1's endpoint table. */
  const rows = [...md.matchAll(/^\| `(GET|POST|DELETE|PATCH)` \| `(\/[\w/:.-]+)` \| (.+?) \|$/gm)]
    .filter(([, , path]) => path.startsWith("/auth") || path.startsWith("/organizations"));

  assert.ok(rows.length >= 4, `found ${rows.length} of §1's endpoints`);

  for (const [, method, path] of rows) {
    const verb = method.toLowerCase();
    const tail = path.replace(/^\/auth/, "").replace(/^\/organizations/, "") || "/";
    const file = path.startsWith("/auth") ? auth : orgs;
    assert.match(file, new RegExp(`Routes\\.${verb}\\(\\s*"${tail.replace(/\//g, "\\/")}"`),
      `§1 names ${method} ${path} and no route handles it`);
  }
});

/* ================================================================ *
 * §4b — promotions.
 * ================================================================ */

test("every PromoAPI method §4b names has an endpoint behind it", { skip }, async () => {
  const routes = src("routes/promotions.js");

  /* §4b's method table: | `list({…})` | `GET /promotions?…` | */
  const rows = [...md.matchAll(/^\| `(\w+)\([^`]*\)` \| `(GET|POST|PATCH) ([^`]+?)`/gm)];
  assert.ok(rows.length >= 8, `§4b should name eight methods; found ${rows.length}`);

  const named = new Set(rows.map(([, m]) => m));
  for (const m of ["list", "get", "create", "update", "submit", "review", "publish", "publicFeed"]) {
    assert.ok(named.has(m), `§4b no longer names ${m}() — has the contract changed?`);
  }

  /* Each one has a route. `review` and `publish` fan out to several, because
     they are several different rights; the rest are one each. */
  assert.match(routes, /promotionRoutes\.get\("\/public"/, "no GET /promotions/public");
  assert.match(routes, /promotionRoutes\.get\("\/"/, "no GET /promotions");
  assert.match(routes, /promotionRoutes\.get\("\/:ref"/, "no GET /promotions/:ref");
  assert.match(routes, /promotionRoutes\.post\("\/"/, "no POST /promotions");
  assert.match(routes, /promotionRoutes\.patch\("\/:ref"/, "no PATCH /promotions/:ref");
  for (const p of ["submit", "review/approve", "review/changes", "review/reject",
                   "publish", "schedule", "pause"]) {
    assert.ok(routes.includes(`"${p}"`), `no route for ${p}`);
  }
});

test("§4b's permission table is the table the server enforces", { skip }, async () => {
  const rights = src("lib/rights.js");
  const table = md.match(/\| Role \| May \|\n\|[-\s|]+\n([\s\S]*?)\n\n/);
  assert.ok(table, "§4b's role table is not where it was");

  const says = table[1];

  /* The three claims that matter, read from the document. */
  assert.match(says, /`MARKETING`[^\n]*never publish/i,
    "§4b no longer says MARKETING may never publish");
  assert.match(says, /`COMPLIANCE`[^\n]*never approve, never publish/i,
    "§4b no longer says COMPLIANCE may never approve or publish");

  /* And the code. */
  const rightsOf = (role) => {
    const m = rights.match(new RegExp(`\\b${role}: \\{([^}]*)\\}`));
    assert.ok(m, `${role} is missing from PROMOTION_RIGHTS`);
    return m[1];
  };
  assert.ok(!/publish/.test(rightsOf("MARKETING")), "MARKETING can publish");
  assert.ok(!/approveFinal/.test(rightsOf("MARKETING")), "MARKETING can give final approval");
  assert.ok(!/publish/.test(rightsOf("COMPLIANCE")), "COMPLIANCE can publish");
  assert.ok(!/approve/.test(rightsOf("COMPLIANCE")), "COMPLIANCE can approve");
  assert.match(rightsOf("PUBLISHER"), /publish: true/, "PUBLISHER cannot publish");
});

test("§4b's public rule is the rule the server applies", { skip }, async () => {
  const promo = src("lib/promotions.js");

  /* The blockquote in §4b that states the rule. */
  const rule = md.match(/> A promotion is visible to the public \*\*only\*\*([\s\S]*?)\n\n/);
  assert.ok(rule, "§4b's public rule blockquote is gone");
  const text = rule[1];

  assert.match(text, /`PUBLISHED`/, "the rule no longer names PUBLISHED");
  assert.match(text, /`SCHEDULED`, `MARKETING_APPROVED` and `FINAL_APPROVED` are \*\*not\*\*\s*\n?> public/,
    "§4b no longer says SCHEDULED / MARKETING_APPROVED / FINAL_APPROVED are not public");

  /* One Set, one member. */
  const set = promo.match(/PUBLIC_STATES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, "PUBLIC_STATES is gone");
  const members = [...set[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(members, ["PUBLISHED"],
    `PUBLIC_STATES holds ${JSON.stringify(members)} and the contract allows only PUBLISHED`);

  /* And all three conditions are applied by the server itself, not taken on
     the client's word — §4b says so in as many words. */
  assert.match(text, /must apply all three conditions itself/i);
  assert.match(promo, /function isPubliclyVisible[\s\S]*?startDate[\s\S]*?endDate[\s\S]*?headline[\s\S]*?ctaLabel/,
    "isPubliclyVisible does not check all three conditions");
});

test("the intake §4b names is the one the pushed homepage exposes", { skip }, async () => {
  assert.match(md, /window\.PALTAS\.discover\.feed\(rows\)/,
    "§4b no longer names the homepage intake point");
});

/* ================================================================ *
 * §4c — the market service. NOT BUILT YET, and this is the test that
 * stops that being discovered the hard way.
 * ================================================================ */

test("§4c's endpoints are either all served or all absent — never half", { skip }, async () => {
  const serverSrc = src("server.js");

  const wanted = [...md.matchAll(/^\| `GET` \| `(\/(?:market|payment-methods|localization|services)\/[\w-]+)`/gm)]
    .map((m) => m[1]);

  if (!wanted.length) return;   /* §4c has gone away; nothing to check */

  const served = wanted.filter((p) => serverSrc.includes(`"${p.split("/").slice(0, 2).join("/")}"`));

  /*
   * THE POINT OF THIS TEST.
   *
   * `assets/market-config.js` calls all four the moment PALTAS_API_BASE is
   * set, and §4c rule 2 says a failed call offers NOTHING rather than falling
   * back to the local table. So a backend that serves some of them and not
   * others is worse than one that serves none: it half-breaks payment
   * selection in a way nobody notices until a customer cannot check out.
   */
  assert.ok(served.length === 0 || served.length === wanted.length,
    `§4c has ${wanted.length} endpoints and this service serves ${served.length} of them. ` +
    `Serve all four or none — a partial answer breaks payment selection silently.`);
});

test("the promotions transport does not borrow the market service's switch", { skip }, async () => {
  /*
   * Guards the fix for a real conflict: `PALTAS_API_BASE` belongs to the
   * market service. While §4c is unbuilt, promotions must have its own switch,
   * or turning promotions on turns payment selection off.
   *
   * Checked here rather than in the frontend repo because THIS service is what
   * makes it true — the day it serves §4c, this test is the reminder that the
   * separate switch can go.
   */
  const js43 = join(HERE, "..", "contract", "js43.js");
  if (!existsSync(js43)) return;
  const t = readFileSync(js43, "utf8");
  assert.match(t, /PALTAS_PROMOTIONS_API/,
    "js43.js has no promotions-specific switch, so it will hijack PALTAS_API_BASE");
  assert.match(t, /window\.PALTAS_PROMOTIONS_API \|\| window\.PALTAS_API_BASE/,
    "the promotions switch should fall back to the shared base, not replace it");
});

test.after(() => {
  if (MD_PATH) console.log(`\n  contract read from: ${MD_PATH}\n`);
});

/* ================================================================ *
 * THE PUSHED HOMEPAGE.
 *
 * Not the documentation this time — the actual `index.html` that is on
 * GitHub. It contains `fromPromotion()`, the one function that turns a row
 * from this API into a card on the carousel, and it reads specific field
 * names off that row. Anything it reads and this API does not send is a
 * feature a customer cannot use; anything it reads and this API sends WRONG
 * is a promotion that silently disappears.
 * ================================================================ */

/*
 * The live page if it is to hand, otherwise the fixture in `contract/` — which
 * holds only `fromPromotion()` and the targeting rules, copied verbatim, rather
 * than a 1.4 MB duplicate of a page that would be stale within a week.
 */
/*
 * THE COMMITTED FIXTURE FIRST, A SIBLING FOLDER ONLY WHEN ASKED FOR.
 *
 * A `../paltas-frontend` on somebody's disk is not necessarily the frontend
 * that is on GitHub — it can easily be an older copy somebody unzipped weeks
 * ago. Picking it up automatically means this suite silently checks the API
 * against the wrong contract and fails with something that looks like a bug in
 * the API. So the sibling is opt-in and explicit:
 *
 *     FRONTEND_INDEX=../paltas-frontend/index.html npm test
 */
const INDEX_PATH = [
  process.env.FRONTEND_INDEX,
  join(HERE, "..", "contract", "homepage-intake.js"),
].filter(Boolean).find((p) => existsSync(p));

const skipIndex = INDEX_PATH ? false : "no homepage copy — set FRONTEND_INDEX";
const indexHtml = INDEX_PATH ? readFileSync(INDEX_PATH, "utf8") : "";

/** Every `p.<field>` the homepage reads off a promotion from this API. */
function fieldsTheHomepageReads() {
  const fn = indexHtml.match(/function fromPromotion\(p\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "fromPromotion() is not in the pushed index.html");
  return new Set([...fn[1].matchAll(/\bp\.(\w+)/g)].map((m) => m[1]));
}

test("this API sends every field the pushed homepage reads", { skip: skipIndex }, async () => {
  const wanted = fieldsTheHomepageReads();
  const promo = src("lib/promotions.js");
  const wire = promo.match(/export function toPublicWire\(p\) \{([\s\S]*?)\n\}/);
  assert.ok(wire, "toPublicWire is gone");

  /*
   * Fields the public wire builds, directly or through targeting().
   *
   * Matched anywhere on a line, not just at its start: several are written
   * two to a line (`type: p.type, offer: p.offer,`) and an anchored pattern
   * silently misses the second one — which is a test reporting a bug that is
   * not there, and the most expensive kind.
   */
  const targeting = promo.match(/function targeting\(p\) \{([\s\S]*?)\n\}/);
  const keys = (s) => [
    /* Comments first — this file explains at length why one field is
       deliberately absent, and a key-shaped phrase inside that explanation
       must not count as the field being present. */
    ...String(s).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|[{,])\s*(\w+)\s*:/gm),
  ].map((m) => m[1]);
  const sends = new Set([...keys(wire[1]), ...keys(targeting ? targeting[1] : "")]);

  /* `audience` is deliberately withheld — see the comment in toPublicWire. */
  const withheld = new Set(["audience"]);

  const missing = [...wanted].filter((f) => !sends.has(f) && !withheld.has(f));
  assert.deepEqual(missing, [],
    `the homepage reads ${JSON.stringify(missing)} and the public feed does not send it`);
});

test("the nine targeting fields the carousel documents are all carried", { skip: skipIndex }, async () => {
  /* Read the names out of the homepage's own comment block rather than
     trusting a list retyped here. */
  const block = indexHtml.match(/The fields a campaign may carry[\s\S]*?\*\//);
  assert.ok(block, "the targeting comment block is gone from index.html");
  const documented = [...block[0].matchAll(/^\s*\*\s{5}(\w+)\s{2,}/gm)].map((m) => m[1]);
  assert.ok(documented.length >= 8, `parsed only ${documented.length} targeting fields`);

  const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");
  const withheld = new Set(["audience"]);
  for (const f of documented) {
    if (withheld.has(f)) continue;
    assert.match(schema, new RegExp(`^\\s{2}${f}\\s`, "m"),
      `the carousel targets on \`${f}\` and the Promotion table has no such column`);
  }
});

test("an empty targeting list never reaches the carousel as a filter", { skip: skipIndex }, async () => {
  /*
   * The difference between null and [] here is the difference between a
   * promotion that runs everywhere and one that runs nowhere. The carousel
   * reads `p.countries || null`, so [] would survive as a filter matching no
   * market — and the customer would see an approved, published promotion
   * appear on no page, with nothing to explain it.
   */
  const promo = src("lib/promotions.js");
  const t = promo.match(/function targeting\(p\) \{([\s\S]*?)\n\}/);
  assert.ok(t, "targeting() is gone");
  for (const f of ["countries", "excludeCountries", "regions", "cities", "currencies", "languages"]) {
    assert.match(t[1], new RegExp(`${f}: p\\.${f} && p\\.${f}\\.length \\? p\\.${f} : null`),
      `${f} could reach the carousel as an empty array`);
  }
});

test("the homepage re-applies the public rule to whatever it is handed", { skip: skipIndex }, async () => {
  /* Defence in depth, and worth asserting: even if this API were wrong, the
     page would refuse a row that is not PUBLISHED and in date. */
  const fn = indexHtml.match(/function fromPromotion\(p\) \{([\s\S]*?)\n  \}/)[1];
  assert.match(fn, /p\.status !== "PUBLISHED"/, "the homepage stopped checking the state");
  assert.match(fn, /today < p\.startDate/, "the homepage stopped checking the start date");
  assert.match(fn, /today > p\.endDate/, "the homepage stopped checking the end date");
  assert.match(fn, /!p\.headline \|\| !p\.ctaLabel/, "the homepage stopped checking there is something to show");
});
