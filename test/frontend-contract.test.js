/* ====================================================================== *
 * THE FRONTEND, ACTUALLY LOADED.
 *
 * Every other test in this repo proves something about the backend. None of
 * them could tell you whether the 18,000-line console.js loads without
 * throwing, whether an adapter names an endpoint that exists, or whether a
 * screen declared in a connect() block is a screen at all. Those are the
 * failures that show a user a blank page or — far worse — a page full of
 * seed data that looks exactly like their own.
 *
 * This loads each page's real script tags, in the page's own order, under
 * test/dom-shim.js. It is not a browser and does not pretend to be: nothing
 * here renders, and a CSS mistake would sail straight through. It catches
 * load-time errors and contract drift between the two repositories, which is
 * what it was written for.
 *
 * IT HAS ALREADY PAID FOR ITSELF. The first run found that the entire guest
 * portal was silently disabled — dashboard/guest.html loads paltas-guest.js
 * and not paltas-hydrate.js, and the block holding the guest wiring began
 * `if (!H || !D) return;`. Every guest screen rendered the seed stay instead
 * of the guest's own booking, and it rendered perfectly.
 *
 * WHERE IS THE FRONTEND? Set PALTAS_FRONTEND, or keep it beside this repo as
 * `../paltas-frontend 2`. When it is not there these tests skip — a backend
 * checkout on its own is not a broken backend.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.js";
import { RESOURCES } from "../src/domain/registry.js";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");

const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/** The scripts a page loads, in the order it loads them. */
function scriptsOf(page) {
  const html = readFileSync(join(FE, page), "utf8");
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => !/^https?:|^\/\//.test(s))          /* local files only */
    .map((s) => s.replace(/^(\.\.\/|\.\/)+/, ""));
}

const PAGES = [
  "index.html", "dashboard/agent.html", "dashboard/property.html",
  "dashboard/hotel.html", "dashboard/security.html", "dashboard/guest.html",
  "dashboard/admin.html",
];

/**
 * Load a page. `probe` instruments the two places console.js wraps a screen,
 * so a test can count what was connected instead of trusting that it was.
 */
/*
 * Read an array back out of the page's context as a PLAIN one.
 *
 * An array created inside a vm context has that context's Array.prototype,
 * not this one's. `assert.deepEqual` is strict here, so it compares
 * prototypes and rejects two EMPTY arrays as unequal — printing `[]` on both
 * sides of the diff, which is as unhelpful as a failure gets. Array.from
 * rebuilds it in this realm. `.map()` would not: it follows the receiver.
 */
const out = (a) => Array.from(a || []);

function openPage(page, { probe = false, inlineToo = false } = {}) {
  const w = makeWindow({ href: "https://paltas.io/" + page });
  for (const src of scriptsOf(page)) {
    let code = readFileSync(join(FE, src), "utf8");
    if (probe && src.endsWith("console.js")) {
      let n = 0;
      code = code.replace(
        /if \(typeof SCREENS\[key\] !== "function"\) \{ MISNAMED\.push\(key\); return; \}/g,
        () => {
          const tag = ++n === 1 ? "connect" : "guest";
          return `(globalThis.__wrapped = globalThis.__wrapped || []).push(` +
                 `["${tag}", key, typeof SCREENS[key]]); ` +
                 `if (typeof SCREENS[key] !== "function") { MISNAMED.push(key); return; }`;
        });
      assert.equal(n, 2,
        "console.js no longer has the two screen-wrapping sites this test " +
        "instruments — it found " + n + ". The probe is stale, not the code.");
    }
      w.loadCode(code, src);
    }

  /*
   * AND THE PAGE'S OWN INLINE SCRIPTS.
   *
   * This only ever loaded `src=` files, so index.html's four inline blocks —
   * where the hero, the search box, the carousels and the card renderers
   * actually live — were never executed by any test. The page could have
   * thrown on its first line and every check here would still have passed.
   *
   * Running them found three holes in dom-shim.js rather than in the page
   * (no Image, no element scrollTo, and an element querySelector that returned
   * null while the document's returned a node) — which is the point: a harness
   * that has never run the code cannot be trusted about it.
   */
  if (inlineToo) {
    const html = readFileSync(join(FE, page), "utf8");
    const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    blocks.forEach((m, i) => w.loadCode(m[1], `${page}#inline${i}`));
  }

  return w;
}

/* ================================================================ */

test("every page's scripts load without throwing", { skip }, () => {
  for (const page of PAGES) {
    let w;
    assert.doesNotThrow(() => { w = openPage(page); },
      `${page} threw while loading its scripts. In a browser this is a blank ` +
      `page, and nothing after the throw runs.`);
    /* A throw inside a setTimeout or a promise would not surface above. */
    assert.equal(w.calls.error.filter((e) => /PALTAS:/.test(e)).length, 0,
      `${page} reported a PALTAS wiring error at load: ` + w.calls.error.join(" | "));
  }
});

test("no page reaches the network at load beyond the health probe", { skip }, () => {
  for (const page of PAGES) {
    const w = openPage(page);
    const unexpected = w.calls.fetch.filter((u) => !/\/health$/.test(u));
    assert.deepEqual(unexpected, [],
      `${page} called out at load time: ${unexpected.join(", ")}. A page should ` +
      `ask for data when a screen needs it, not while it is still parsing.`);
  }
});

test("no screen is declared that does not exist", { skip }, () => {
  /*
   * connect() reports a misnamed screen and carries on, because one
   * unconnected screen is not a reason to blank a live console. This is where
   * it becomes a failure instead — before a deploy rather than after.
   *
   * The bug this caught: `security` was declared in the security block.
   * That is an AREA name. The screens are `s_*`, so nothing answered to it
   * and that screen kept drawing seed data.
   */
  for (const page of PAGES) {
    const w = openPage(page, { probe: true });
    const misnamed = out(w.win.__wrapped).filter(([, , t]) => t !== "function");
    assert.deepEqual(misnamed.map(([site, key]) => `${site}:${key}`), [],
      `${page} declares screens that do not exist. They draw SEED DATA and look ` +
      `exactly like screens that work.`);
  }
});

test("the staff consoles connect their screens, and the guest portal connects its own",
  { skip }, () => {
  /*
   * THE REGRESSION THIS EXISTS FOR.
   *
   * guest.html loads paltas-guest.js; the staff pages load
   * paltas-hydrate.js. The block that wires both began
   * `if (!H || !D) return;`, so on the guest page it returned before reaching
   * the guest wiring and every guest screen showed the seed stay. Counting
   * what was wrapped is the only way to see that — the page loads, throws
   * nothing, and looks right.
   */
  const staff = openPage("dashboard/hotel.html", { probe: true });
  const sw = out(staff.win.__wrapped);
  assert.ok(sw.filter(([s]) => s === "connect").length > 50,
    "the staff consoles wrapped only " + sw.filter(([s]) => s === "connect").length +
    " screens — connect() is not running, and every screen is showing seed data");
  assert.equal(sw.filter(([s]) => s === "guest").length, 0,
    "a staff page ran the guest wiring");

  const guest = openPage("dashboard/guest.html", { probe: true });
  const gw = out(guest.win.__wrapped);
  assert.equal(gw.filter(([s]) => s === "guest").length, 9,
    "the guest portal wrapped " + gw.filter(([s]) => s === "guest").length +
    " of its 9 screens. If this is 0, the guest portal is showing every arriving " +
    "guest a stay that is not theirs.");
  assert.equal(gw.filter(([s]) => s === "connect").length, 0,
    "the guest page ran the staff wiring, which needs an org hydrator it has not loaded");
});

test("every adapter names an endpoint the backend actually serves", { skip }, () => {
  /*
   * A misspelt slug is not an error anywhere: the request 404s, the screen
   * shows its "could not load" state, and it looks like a backend problem.
   * This is the only place the two repositories are compared.
   */
  const slugs = new Set(Object.keys(RESOURCES));
  const paths = new Set();
  for (const f of readdirSync("src/routes")) {
    const t = readFileSync(join("src/routes", f), "utf8");
    for (const m of t.matchAll(/\.(get|post|patch|delete)\(\s*"([^"]+)"/g)) paths.add(m[2]);
  }

  const src = readFileSync(join(FE, "assets", "paltas-hydrate.js"), "utf8");
  const refs = new Set();
  for (const m of src.matchAll(/\bslug:\s*"([^"]+)"/g)) refs.add(m[1]);
  for (const m of src.matchAll(/\bpath:\s*"([^"]+)"/g)) refs.add(m[1]);
  for (const m of src.matchAll(/\bslugs:\s*\[([^\]]+)\]/g)) {
    for (const s of m[1].matchAll(/"([^"]+)"/g)) refs.add(s[1]);
  }

  assert.ok(refs.size >= 25,
    "found only " + refs.size + " adapter endpoints, so this test is no longer " +
    "reading the adapter declarations — the shape has changed");

  const missing = [...refs].filter((r) => {
    const bare = r.split("?")[0].replace(/^\//, "");
    return !slugs.has(bare) && !paths.has("/" + bare) && !paths.has(r.split("?")[0]);
  }).sort();

  assert.deepEqual(missing, [],
    "these adapters name endpoints the backend does not serve, so those screens " +
    "will 404 and blame the server: " + missing.join(", "));
});

test("the API base is never a hard-coded backend URL in page code", { skip }, () => {
  /*
   * The one mechanism is window.PALTAS_API_BASE, defaulted centrally in
   * market-config.js. A page that names the Render host directly is a page
   * that breaks when the host changes, and it also sends the session cookie
   * cross-site, which Safari drops.
   */
  const offenders = [];
  for (const page of PAGES) {
    const html = readFileSync(join(FE, page), "utf8");
    if (/onrender\.com/.test(html)) offenders.push(page);
  }
  for (const f of readdirSync(join(FE, "assets"))) {
    if (!f.endsWith(".js") || f === "market-config.js") continue;
    if (/onrender\.com/.test(readFileSync(join(FE, "assets", f), "utf8"))) {
      offenders.push("assets/" + f);
    }
  }
  assert.deepEqual(offenders, [],
    "these name the backend host directly instead of using PALTAS_API_BASE: " +
    offenders.join(", "));
});

test("every adapter reads the envelope key its endpoint actually returns",
  { skip }, () => {
  /*
   * THE GAP THAT LET A BUG THROUGH.
   *
   * The test above checks that an adapter's PATH exists. It says nothing
   * about the KEY the adapter reads out of the response, and a wrong key is
   * just as broken and far quieter: the request succeeds, `body[key]` is
   * undefined, the list is empty, and the screen shows "nothing yet" over a
   * full table. That is exactly what PLAT_AUDIT did — it read `audit` from
   * GET /platform/audit, which returns `events`.
   *
   * Only `path` adapters need this. A `slug` adapter's key IS its slug, and
   * the framework builds both from one declaration, so they cannot disagree.
   */
  const src = readFileSync(join(FE, "assets", "paltas-hydrate.js"), "utf8");

  /* Each `path: "…"` with the `key: "…"` that belongs to the same adapter. */
  const pairs = [];
  for (const m of src.matchAll(/\bpath:\s*"([^"]+)"\s*,\s*key:\s*"([^"]+)"/g)) {
    pairs.push({ path: m[1], key: m[2] });
  }
  assert.ok(pairs.length >= 3,
    "found only " + pairs.length + " path/key adapter declarations — the shape " +
    "has changed and this test is no longer checking anything");

  const routes = readdirSync("src/routes")
    .map((f) => readFileSync(join("src/routes", f), "utf8")).join("\n");

  const wrong = [];
  for (const { path, key } of pairs) {
    /* The handler for this path, up to the next route registration. */
    /* An adapter may pin a filter — `/platform/organizations?product=HOTEL…`
       — and the route is registered without it. */
    const bare = path.split("?")[0];
    const at = routes.indexOf('"' + bare + '"');
    assert.notEqual(at, -1, "no route serves " + bare);
    const rest = routes.slice(at);
    const nextRoute = rest.slice(1).search(/\.\s*(get|post|patch|delete)\(\s*"/);
    const handler = rest.slice(0, nextRoute > 0 ? nextRoute : 4000);

    /* The keys of the object handed to res.json(...). */
    const body = handler.match(/res\.json\(\{([\s\S]*?)\n\s*\}\);/);
    assert.ok(body, "could not find the res.json() for " + bare);
    const keys = [...body[1].matchAll(/^\s{0,8}("?[\w-]+"?)\s*[,:]/gm)]
      .map((k) => k[1].replace(/"/g, ""));

    if (!keys.includes(key)) {
      wrong.push(`${bare} returns {${keys.join(", ")}} but the adapter reads "${key}"`);
    }
  }

  assert.deepEqual(wrong, [],
    "these adapters read a key their endpoint does not return, so the screen " +
    "shows an empty list and blames the data:\n  " + wrong.join("\n  "));
});

test("the homepage's own inline scripts run without throwing", { skip }, () => {
  /*
   * index.html is 7,000 lines and most of its behaviour is inline: the hero
   * slideshow, the search box, the discovery carousels, the card renderers.
   * None of it was covered until this test, because the loader only read
   * `src=` files.
   */
  let w;
  assert.doesNotThrow(() => { w = openPage("index.html", { inlineToo: true }); },
    "index.html threw while running its own inline scripts. In a browser that " +
    "stops everything after the throw — the carousels, the search and the card " +
    "renderers all live in those blocks.");

  const unexpected = w.calls.fetch.filter((u) => !/\/health$/.test(u));
  assert.deepEqual(unexpected, [],
    "the homepage called out at load beyond the health probe: " + unexpected.join(", "));

  assert.ok(w.win.document.getElementById("heroWhere"),
    "the search field is gone from the homepage");
  assert.ok(w.win.PALTAS && w.win.PALTAS.discover,
    "PALTAS.discover is missing, so the public promotions feed cannot fill");
});

test("the public marketplace is not capped at the dashboard's 1280px", { skip }, () => {
  /*
   * Two different decisions that happened to share a number. The ~22 embedded
   * dashboard demos are framed at 1280px ON PURPOSE — dense tables stretched
   * across a 2560px screen are harder to read. The public marketplace was
   * simply inheriting it.
   *
   * This asserts they stay separate: the public shells expand, and the demo
   * frame survives.
   */
  const html = readFileSync(join(FE, "index.html"), "utf8");

  for (const cls of ["topbar-inner", "smartbar-inner", "hero-content", "sp-inner",
                     "flow-inner", "roles-inner", "foot-inner", "pl-wrap"]) {
    const rx = new RegExp("[.,]" + cls + "\\b[^{]*\\{[^}]*max-width: *min\\(2400px");
    assert.ok(rx.test(html) || html.includes("." + cls + ",") || html.includes("." + cls + "\n"),
      `.${cls} is not covered by the public width rule`);
  }
  assert.match(html, /max-width: min\(2400px, 100%\)/,
    "the public containers no longer expand");

  /* The demo frame is still there, and prose is still bounded. */
  assert.ok((html.match(/max-width:1280px/g) || []).length >= 8,
    "the embedded dashboard demos have lost their 1280px frame");
  for (const ch of ["34ch", "60ch"]) {
    assert.ok(html.includes("max-width:" + ch),
      `the ${ch} prose limit is gone — expanding a container must not widen running text`);
  }
});

test("every live market has the data that makes it live", { skip }, () => {
  /*
   * A country in LIVE gets its own screens, its own currency and its own
   * document list. A country absent from LIVE is billed on the nearest rail and
   * TOLD so on the form — which is honest, and was what a United Kingdom
   * company saw while PALTAS was registered in the United Kingdom.
   *
   * So this is the general form of that bug: declaring a market live without
   * the four things that make it live would produce a market with no currency,
   * no rails or no documents — worse than the honest notice it replaced.
   */
  const mk = readFileSync(join(FE, "assets", "market.js"), "utf8");

  const live = (mk.match(/const LIVE = \[([^\]]+)\]/) || [])[1];
  assert.ok(live, "LIVE is gone from market.js");
  const codes = [...live.matchAll(/"([A-Z]{2})"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 3, "LIVE has shrunk to " + codes.join(", "));

  const rails = (mk.match(/const BILLING_RAIL = \{([\s\S]*?)\n *\}/) || [])[1] || "";
  const markets = (mk.match(/const MARKETS = \{([\s\S]*?)\n\}/) || [])[1]
               || (mk.match(/MARKETS = \{([\s\S]*?)\n *\}/) || [])[1] || "";
  const docs = (mk.match(/BIZ_DOCS = \{([\s\S]*?)\n *\};/) || [])[1] || "";
  const places = (mk.match(/const PLACES = \{([\s\S]*?)\n *\};/) || [])[1] || "";
  assert.ok(rails && markets && docs && places,
    "one of BILLING_RAIL, MARKETS, BIZ_DOCS or PLACES could not be read — this " +
    "test is no longer checking anything");

  const missing = [];
  for (const c of codes) {
    /* A rail of its own, not the "us" fallback. */
    const rail = (rails.match(new RegExp(c + ':\\s*"([a-z]{2})"')) || [])[1];
    if (!rail) missing.push(`${c}: no BILLING_RAIL entry, so it bills on the US rail`);
    else if (!new RegExp("\\b" + rail + ": \\{[^}]*cur:").test(markets)) {
      missing.push(`${c}: rail "${rail}" has no MARKETS entry, so it has no currency`);
    }
    /* Its own documents, not the xx fallback. */
    if (!new RegExp("\\n\\s*" + c + ": \\[\\[").test(docs)) {
      missing.push(`${c}: no BIZ_DOCS entry, so verification asks the generic questions`);
    }
    /* And a list of places, so the location field is a menu not a text box. */
    if (!new RegExp("\\n\\s*" + c + ": \\[").test(places)) {
      missing.push(`${c}: no PLACES list, so the location field has nothing to offer`);
    }
  }
  assert.deepEqual(missing, [],
    "these markets are declared live without the data that makes them live:\n  " +
    missing.join("\n  ") +
    "\nEither add what is missing, or take the country out of LIVE — the " +
    '"billed on the nearest rail" notice is honest and a half-live market is not.');
});

test("the United Kingdom is live, in sterling", { skip }, () => {
  /* Named explicitly because the company is registered there, and because a
     London letting agent being told their own country is "not a live market
     yet" is the specific thing this fixed. */
  const mk = readFileSync(join(FE, "assets", "market.js"), "utf8");
  assert.match(mk, /const LIVE = \[[^\]]*"GB"/, "GB is not a live market");
  assert.match(mk, /GB:\s*"gb"/, "GB does not bill on its own rail");
  assert.match(mk, /gb: \{[^}]*cur: "GBP"/, "the GB rail is not in sterling");
  assert.match(mk, /\n\s*GB: \[\["/, "there are no United Kingdom documents");
  /* And PALTAS must not claim to check a register it does not check. */
  assert.doesNotMatch(mk, /we (now )?check (the )?Companies House/i,
    "do not claim to query Companies House — the documents are read, not looked up");
});
