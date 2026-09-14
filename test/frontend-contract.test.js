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

/**
 * Every script a page runs, IN DOCUMENT ORDER, inline and external together.
 *
 * This used to return only `src=` files, and openPage() ran them all before any
 * inline block. A browser does not: it runs them in the order they appear. The
 * difference is not academic — auth/login.html sets window.PALTAS_PAGE in an
 * inline script ABOVE market.js, so loading market.js first made it render the
 * home page and the test concluded the sign-in page had no Google button on it.
 * The page was correct and the harness was wrong.
 */
function scriptsOf(page) {
  const html = readFileSync(join(FE, page), "utf8");
  const out = [];
  const rx = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const src = (m[1].match(/\ssrc="([^"]+)"/) || [])[1];
    if (src) {
      if (/^https?:|^\/\//.test(src)) continue;            /* local files only */
      out.push({ src: src.replace(/^(\.\.\/|\.\/)+/, "") });
    } else if (m[2].trim()) {
      out.push({ code: m[2], label: page + "#inline" });
    }
  }
  return out;
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

function openPage(page, { probe = false, inlineToo = true } = {}) {
  const w = makeWindow({ href: "https://paltas.io/" + page });

  for (const step of scriptsOf(page)) {
    if (step.code) {
      /* Inline blocks are what `inlineToo` used to gate. They are on by default
         now, because a page whose own code has never run is a page no test has
         actually opened. */
      if (inlineToo) w.loadCode(step.code, step.label);
      continue;
    }
    let code = readFileSync(join(FE, step.src), "utf8");
    if (probe && step.src.endsWith("console.js")) {
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
    w.loadCode(code, step.src);
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

/*
 * Two calls are allowed at load, and only two.
 *
 *   /health                 the market service's one silent reachability probe
 *   /marketplace/listings   the public marketplace read
 *
 * The second one is new, and it is the exception that proves the rule. The
 * homepage's nine discovery sections ARE the screen — a visitor arriving at
 * paltas.io has already asked for them by arriving — so deferring that request
 * would mean an empty page until something was clicked. Everything else still
 * has to wait until a screen needs it.
 */
const ALLOWED_AT_LOAD = /\/health$|\/marketplace\/listings(\?|$)/;

test("no page reaches the network at load beyond the health probe", { skip }, () => {
  for (const page of PAGES) {
    const w = openPage(page);
    const unexpected = w.calls.fetch.filter((u) => !ALLOWED_AT_LOAD.test(u));
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

  const unexpected = w.calls.fetch.filter((u) => !ALLOWED_AT_LOAD.test(u));
  assert.deepEqual(unexpected, [],
    "the homepage called out at load beyond the health probe: " + unexpected.join(", "));

  /*
   * And it MUST make that one call. If the marketplace read is missing, the
   * nine sections are empty for a reason that has nothing to do with whether
   * anything is published — which is the failure this whole design exists to
   * avoid, and it would look identical to the honest empty state.
   */
  assert.ok(w.calls.fetch.some((u) => /\/marketplace\/listings/.test(u)),
    "the homepage did not ask for /marketplace/listings at load, so its nine " +
    "sections cannot fill even when listings exist. Fetched: " +
    (w.calls.fetch.join(", ") || "nothing"));

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

/* ====================================================================== *
 * PUBLIC AUTHENTICATION.
 *
 * The public site had no working way in. login.html, work.html and
 * business.html were linked from twenty places and all three returned 404, so
 * "Sign in" and "Get started" were dead. The only signup that existed ran in
 * the browser: it wrote to sessionStorage, accepted ANY six digits as an email
 * code, and its sign-in looked an email up in a list and never read the
 * password field at all.
 * ====================================================================== */

/*
 * The sign-in and onboarding pages live in auth/, not at the root.
 *
 * I got this wrong first time: I tested https://paltas.io/login.html, got a 404
 * and concluded the site had no way to sign in. It has — at /auth/login.html,
 * which is what the ${A} prefix in market.js resolves to and what was live all
 * along. The demo sign-in was therefore REACHABLE in production, which is worse
 * than missing, and these paths are the ones that matter.
 */
const PUBLIC_PAGES = ["index.html", "partner.html", "owners.html",
                      "auth/login.html", "auth/work.html", "auth/business.html",
                      "auth/start.html", "auth/index.html"];

test("every page the public site links to exists", { skip }, () => {
  /*
   * The failure this catches is a dead "Sign in" button, which is invisible to
   * every other test here: the page that links to it loads perfectly.
   */
  const missing = [];
  for (const page of PUBLIC_PAGES) {
    if (!existsSync(join(FE, page))) missing.push(page + " (linked, absent)");
  }
  /*
   * And whatever market.js links to. ${A} is "auth/" from a root page and ""
   * from inside auth/, so a bare name resolves in BOTH places — a link is only
   * broken when neither exists.
   */
  const mk = readFileSync(join(FE, "assets", "market.js"), "utf8");
  for (const m of mk.matchAll(/href="\$\{([AB])\}([a-z0-9_-]+\.html)/g)) {
    const target = m[2];
    const atRoot = existsSync(join(FE, target));
    const inAuth = existsSync(join(FE, "auth", target));
    if (!atRoot && !inAuth) missing.push(target + " (linked from market.js, absent)");
  }
  assert.deepEqual([...new Set(missing)], [],
    "these are linked from the public site and do not exist, so the link is a 404:\n  " +
    [...new Set(missing)].join("\n  "));
});

test("the public site offers a real Continue with Google", { skip }, () => {
  /* The button is rendered by market.js, so the test RENDERS it rather than
     grepping a page — that is the only way to know a visitor sees it. */
  for (const page of ["auth/login.html", "auth/work.html"]) {
    const html = readFileSync(join(FE, page), "utf8");
    assert.match(html, /paltas-auth\.js/, `${page} does not load the auth module`);
    assert.match(html, /paltas-data\.js/,
      `${page} does not load the API client, so signInUrl cannot be built`);

    const w = openPage(page);
    w.loadCode("globalThis.__render = (typeof render === 'function') && (render(), true);", "re");
    const body = w.win.document.body.innerHTML || "";
    assert.ok(body.includes("Continue with Google"),
      `${page} renders no Continue with Google button — a visitor cannot sign in`);
    const href = (body.match(/class="g-btn" href="([^"]+)"/) || [])[1];
    assert.ok(href, `${page} renders the button with no href`);
    assert.match(href, /\/auth\/google/,
      `the button points at ${href} instead of the backend's /auth/google`);
    assert.doesNotMatch(body, /accounts\.google\.com\/o\/oauth2/,
      `${page} sends the browser straight to Google instead of through the backend`);
    assert.doesNotMatch(body, /client_id=/,
      `${page} puts a client_id in the page — the browser never needs one`);
  }

  const auth = readFileSync(join(FE, "assets", "paltas-auth.js"), "utf8");
  assert.match(auth, /Session\.signInUrl\(\)/,
    "the auth module builds its own URL instead of asking the API client");
  assert.doesNotMatch(auth, /GOOGLE_CLIENT_SECRET|SESSION_SECRET|client_secret/,
    "a secret is named in frontend code");
});

test("no production path can authenticate through a bypass", { skip }, () => {
  const mk = readFileSync(join(FE, "assets", "market.js"), "utf8");

  /* The six-digit bypass, gone entirely. */
  assert.doesNotMatch(mk, /any six digits are accepted/,
    "the 'any six digits are accepted' field is still rendered");

  /* DEMO_DOORS may only ever be true on a development machine. A query
     parameter or a global would let the public switch it on. */
  /*
   * COMMENTS STRIPPED FIRST.
   *
   * The first version of this assertion failed on the comment that explains why
   * window.PALTAS_DEMO was removed — the words were in the file, so the test
   * said the bypass was still there. A test that cannot tell an explanation
   * from the thing it explains will be switched off by whoever hits it.
   */
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const doors = (code(mk).match(/const DEMO_DOORS = \(\(\) => \{[\s\S]*?\}\)\(\);/) || [])[0] || "";
  assert.ok(doors, "DEMO_DOORS is gone from market.js — if that is deliberate, update this test");
  assert.doesNotMatch(doors, /params\.get\("demo"\)/,
    "?demo=1 still switches the demo doors on, which the public can do on paltas.io");
  assert.doesNotMatch(doors, /window\.PALTAS_DEMO/,
    "window.PALTAS_DEMO still switches the demo doors on, which a console can do");
  assert.match(doors, /localhost/,
    "DEMO_DOORS no longer restricts itself to a development machine");

  /* The password-free sign-in must route to the real door. */
  const signin = (mk.match(/if \(a === "signin"\) \{[\s\S]*?\n  \}/) || [])[0] || "";
  assert.ok(signin, "the signin handler could not be read");
  assert.match(signin, /login\.html/,
    "the signin handler does not send people to the real sign-in page");

  /* And no user-visible copy may still promise a demo. */
  const noComments = mk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const phrase of ["any password works", "Demo build", "no real money"]) {
    assert.ok(!noComments.includes(phrase),
      `"${phrase}" is still in code a visitor can reach`);
  }
});

test("signed-in state comes from the server, never from storage", { skip }, () => {
  const auth = readFileSync(join(FE, "assets", "paltas-auth.js"), "utf8");
  /* status() must ask the session endpoint and nothing else. */
  assert.match(auth, /request\("\/auth\/session"\)/,
    "status() does not ask the backend who the caller is");
  assert.doesNotMatch(auth, /(localStorage|sessionStorage)\.(get|set)Item\(\s*["'][^"']*(signed|auth|session|user)/i,
    "authentication state is being read from or written to browser storage");
  /* Sign-out must destroy the row, not a flag. */
  assert.match(auth, /Session\.signOut\(\)/,
    "signOut() does not call the endpoint that deletes the session row");
});

test("the sign-in page reads the failure parameter the backend actually sends",
  { skip }, () => {
  /*
   * The backend redirects a cancelled or failed sign-in to
   * /login.html?signin=cancelled|failed. The first version of the auth module
   * read ?error= — Google's parameter, not ours — so a cancelled sign-in would
   * have shown no message whatsoever.
   */
  const auth = readFileSync(join(FE, "assets", "paltas-auth.js"), "utf8");
  assert.match(auth, /q\.get\("signin"\)/,
    "the page does not read ?signin=, which is what the backend sends");
  for (const v of ["cancelled", "failed"]) {
    assert.ok(new RegExp(v + ":").test(auth), `no message for signin=${v}`);
  }

  const routes = readFileSync("src/routes/auth.js", "utf8");
  const targets = [...routes.matchAll(/appUrl\}(\/[a-z0-9_\-./]*\.html)/g)].map((m) => m[1]);
  assert.ok(targets.length >= 1, "the callback no longer redirects failures to a page");
  for (const t of targets) {
    assert.ok(existsSync(join(FE, t.replace(/^\//, ""))),
      `the backend sends failed sign-ins to ${t} and no such page exists`);
  }
});

test("onboarding creates the company through the real endpoint", { skip }, () => {
  const biz = readFileSync(join(FE, "auth", "business.html"), "utf8");
  assert.match(biz, /createOrganization/,
    "business.html collects a company and never creates one");
  const auth = readFileSync(join(FE, "assets", "paltas-auth.js"), "utf8");
  assert.match(auth, /request\("\/organizations", \{\s*method: "POST"/,
    "createOrganization does not POST to the real organizations endpoint");
  /* It must not invent a subscription or entitlements — the server does that.
     Comments stripped, for the same reason as the bypass test above. */
  const authCode = auth.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(authCode, /TRIALING|entitlement/i,
    "the frontend is deciding subscription or entitlement state, which is the server's job");
});

/* ====================================================================== *
 * THE PUBLIC MARKETPLACE ON THE HOMEPAGE
 *
 * The nine discovery sections are the homepage now, and the one property that
 * matters about them cannot be checked by reading the source: that they show
 * what the API returned and NOTHING ELSE. So these open the real page, answer
 * its one request with a known set of listings, and read the rendered DOM back.
 *
 * The homepage used to build its rows from a country's indicative price level —
 * "Homes for sale in Mombasa" at a figure derived from `base`. It looked like
 * inventory and was not, and that is exactly what a stranger cannot tell by
 * looking. These tests are the reason it cannot come back.
 * ====================================================================== */

/** The shape the public endpoint actually returns. Nothing here is invented:
    every field is one `GET /marketplace/listings` selects. */
const SAMPLE = [
  { id: "l1", title: "Two-bedroom apartment, Nyali", kind: "SHORT_STAY", price: 850000,
    currency: "KES", city: "Mombasa", country: "Kenya", place: "Nyali Court",
    unitKind: "TWO_BED", sqm: 96, offeredBy: "Coast Lettings Ltd", transfer: true,
    transferFree: false, hotel: false },
  { id: "l2", title: "Studio off Ngong Road", kind: "LONG_LET", price: 4500000,
    currency: "KES", city: "Nairobi", country: "Kenya", place: "Jacaranda Place",
    unitKind: "STUDIO", sqm: 38, offeredBy: "Ngong Road Properties", transfer: false,
    transferFree: null, hotel: false },
  { id: "l3", title: "Deluxe room, ocean wing", kind: "SHORT_STAY", price: 1800000,
    currency: "KES", city: "Diani", country: "Kenya", place: "Ocean Wing",
    unitKind: "ONE_BED", sqm: 44, offeredBy: "Diani Hotels Group", transfer: true,
    transferFree: true, hotel: true },
  { id: "l4", title: "Four-bedroom house, Karen", kind: "FOR_SALE", price: 48000000,
    currency: "KES", city: "Nairobi", country: "Kenya", place: "Karen Ridge",
    unitKind: "FOUR_BED", sqm: 310, offeredBy: "Karen Ridge Agents", transfer: false,
    transferFree: null, hotel: false },
];

/**
 * Open the homepage and answer its marketplace request with `listings`.
 *
 * The shim rejects every fetch by design, so the module's failure path is what
 * runs on a plain openPage(). Replacing fetch and calling load() again is how a
 * test sees the path a visitor sees.
 */
function marketplaceHome(listings) {
  const w = openPage("index.html", { inlineToo: true });
  w.win.fetch = (u) => {
    if (!/marketplace\/listings/.test(String(u))) return Promise.reject(new Error("unrelated"));
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: () => Promise.resolve({ listings, count: listings.length, source: "live-listings" }),
      text: () => Promise.resolve(JSON.stringify({ listings })),
    });
  };
  w.win.PALTAS.Marketplace.load();
  return w;
}

/** The product names the closing section offers, read from the page itself. */
function productTitles() {
  const js = readFileSync(join(FE, "assets", "paltas-market.js"), "utf8");
  const start = js.indexOf("var PRODUCTS = [");
  const block = js.slice(start, js.indexOf("];", start));
  return [...block.matchAll(/\["([^"]+)"/g)].map((m) => m[1].replace(/&/g, "&amp;"));
}

/** The rendered marketplace, after the promise chain has settled. */
async function rendered(w) {
  await new Promise((r) => setTimeout(r, 40));
  const host = w.win.document.getElementById("paltas-marketplace");
  assert.ok(host, "#paltas-marketplace is gone from the homepage");
  return host.innerHTML;
}

test("the homepage draws nine marketplace sections, by their own names", { skip }, async () => {
  const html = await rendered(marketplaceHome(SAMPLE));

  /* The titles are the product's, not this test's — they are what a visitor
     reads, and renaming one silently is a content change nobody reviewed. */
  const TITLES = [
    "Available today", "Popular near you", "Arrive with ease", "Trending stays",
    "Hotels worth checking in to", "Homes for a few nights",
    "Buy, sell and discover property", "New developments",
    "One platform. Every property journey.",
  ];
  /*
   * All nine are still DEFINED — renaming or deleting one is a content change
   * and has to be seen. Read from the module rather than the render, because a
   * section now removes itself when it is empty and "not on the page" and "no
   * longer exists" are different failures.
   */
  const mod = readFileSync(join(FE, "assets/paltas-market.js"), "utf8");
  const undefined_ = TITLES.filter((t) => !mod.includes(t));
  assert.deepEqual(undefined_, [], "these marketplace sections no longer exist: " +
    undefined_.join(" | "));

  /*
   * And eight of the nine DRAW, because SAMPLE has something for each of them.
   * The ninth is New developments: nothing in the fixture is a development,
   * nothing in PALTAS ever publishes one, and a section with nothing in it is
   * no longer given a heading and a dead row. Its absence here IS the rule
   * working, so it is asserted rather than tolerated.
   */
  /*
   * And all nine DRAW, because the page around them is not empty. New
   * developments has nothing in the fixture and nothing ever publishes one, so
   * it keeps its heading and carries ONE COMPACT LINE saying so — not the 56px
   * dashed panel it used to get, which competed with the real inventory beside
   * it and made a stocked page look bare.
   */
  assert.deepEqual(TITLES.filter((t) => !html.includes(t)), [],
    "a marketplace section did not draw at all");

  const dev = (html.match(/id="mk-developments"[\s\S]*?<\/section>/) || [""])[0];
  assert.ok(/mk-empty-slim/.test(dev),
    "New developments is empty but does not use the compact state");
  assert.ok(!/class="mk-rail"/.test(dev), "New developments drew a rail with nothing in it");

  assert.equal((html.match(/class="mk-sec"/g) || []).length, 9,
    "all nine sections draw when the page has inventory in it");
});

test("every card on the homepage comes from the API and nothing else", { skip }, async () => {
  const html = await rendered(marketplaceHome(SAMPLE));

  /* Every title rendered must be one the endpoint returned. A card with any
     other title was built by the page, which is the whole failure mode. */
  const titles = out((html.match(/class="mk-title">([^<]*)</g) || [])).map(
    (m) => m.replace(/class="mk-title">/, "").replace(/<$/, ""));
  const known = new Set(SAMPLE.map((l) => l.title)
    /*
     * The closing section names PALTAS PRODUCTS, not properties. Read from the
     * page's own list rather than repeated here, so adding a product does not
     * fail this test for the wrong reason — and so a product added ONLY here,
     * with nothing behind it, still fails the test that checks the list against
     * the Product enum.
     */
    .concat(productTitles()));
  const invented = titles.filter((t) => !known.has(t));
  assert.deepEqual(invented, [],
    "the homepage rendered a card the API never sent: " + invented.join(" | "));
});

test("the homepage invents no rating, no photograph and no review", { skip }, async () => {
  const html = await rendered(marketplaceHome(SAMPLE));

  /*
   * A Listing has no rating, no image and no review anywhere in the schema —
   * confirmed against prisma/schema.prisma, where `image` belongs to Promotion.
   * So any of the three appearing on a card was made up, and a visitor would
   * read it as something a previous guest left.
   */
  const fabrications = [];
  if (/class="mk-card"[\s\S]{0,600}?(★|&#9733;|\bstars?\b|\brating\b)/i.test(html))
    fabrications.push("a star or a rating appears on a card");
  if (/class="mk-card"[\s\S]{0,600}?<img/i.test(html))
    fabrications.push("a card carries an <img>, and listings have no photograph");
  if (/\d+\s*reviews?\b/i.test(html))
    fabrications.push("a review count appears");
  if (/\bsuperhost\b|\bguest favourite\b|\bbestseller\b/i.test(html))
    fabrications.push("an earned badge appears, and none is computed anywhere");
  assert.deepEqual(fabrications, [], fabrications.join("; "));
});

test("with nothing published, the page says so once instead of nine times", { skip }, async () => {
  const html = await rendered(marketplaceHome([]));

  /*
   * NINE BARE SHELVES WERE NINE APOLOGIES.
   *
   * Every section used to keep its heading and hang an empty state under it, so
   * a marketplace with nothing in it rendered as "Arrive with ease / Nothing
   * here yet", eight times over. That reads as a broken site rather than a new
   * one, and it costs a visitor eight headings to learn a single fact.
   *
   * An empty section is now absent. Emptiness is answered ONCE, at page level,
   * where it can be said properly and carry the one useful action.
   */
  assert.ok(!/class="mk-empty"[^]*?Arrive with ease|Arrive with ease[^]*?class="mk-empty"/.test(html),
    "an empty section still draws its heading");
  for (const gone of ["Arrive with ease", "Trending stays", "Hotels worth checking in to"]) {
    assert.ok(!html.includes(gone), `"${gone}" has nothing in it but still has a heading`);
  }

  const page = (html.match(/class="mk-empty mk-empty-page"/g) || []).length;
  assert.equal(page, 1,
    "a marketplace with nothing in it must say so exactly once — found " + page);

  /*
   * And it must never be silent. A page that hides its empty sections and says
   * nothing is indistinguishable from a page that failed to load, which is the
   * one thing this rule could have made worse.
   */
  assert.ok(/Nothing is published here yet/.test(html),
    "every section vanished and the page said nothing at all");
  assert.ok(/partner\.html/.test(html),
    "the page is empty and offers no way to put something in it");

  assert.ok(!/class="mk-card"/.test(html.replace(/class="mk-card mk-prod"/g, "")),
    "a property card was drawn while the API returned no listings at all");
});

test("an empty PALTAS category says so compactly, and fills itself when published", { skip }, async () => {
  /*
   * THE RULE, BOTH WAYS.
   *
   * A category PALTAS cannot fill, on a page that is otherwise full, is worth
   * exactly one line and a way to fix it. It is NOT worth a giant panel — that
   * is how a marketplace with real hotels in it reads as empty — and it is not
   * worth hiding either, because then nobody learns the category exists or that
   * they could be the one to stock it.
   *
   * And nothing about it is configured. The line is there BECAUSE the shelf is
   * empty and gone BECAUSE it is not, so publishing one property is the whole
   * mechanism. Two renders differing by a single listing prove it.
   */
  const withTransfer = SAMPLE.filter((l) => l.transfer);
  assert.ok(withTransfer.length, "the fixture has no transfer listing to prove this with");

  const without = await rendered(marketplaceHome(SAMPLE.filter((l) => !l.transfer)));
  const off = (without.match(/id="mk-with-transfer"[\s\S]*?<\/section>/) || [""])[0];
  assert.ok(off, "the transfer section vanished entirely instead of saying it is empty");
  assert.ok(/mk-empty-slim/.test(off), "an empty category did not use the compact state");
  assert.ok(/No PALTAS property offers an airport transfer yet/.test(off),
    "the compact line does not say whose shelf is empty");
  assert.ok(/partner\.html/.test(off), "the compact state offers no way to stock it");
  assert.ok(!/class="mk-rail"/.test(off), "an empty category drew a rail");

  const on = await rendered(marketplaceHome(SAMPLE));
  const lit = (on.match(/id="mk-with-transfer"[\s\S]*?<\/section>/) || [""])[0];
  assert.ok(/class="mk-rail"/.test(lit),
    "a property with an airport transfer is published and the shelf did not fill");
  assert.ok(!/mk-empty-slim/.test(lit), "a filled shelf still apologises for being empty");
});

test("a failed request empties the page instead of filling it", { skip }, async () => {
  /* openPage's fetch rejects, which IS the unreachable-backend case. */
  const w = openPage("index.html", { inlineToo: true });
  const html = await rendered(w);

  assert.ok(/class="mk-notice"/.test(html),
    "the marketplace did not say the listings failed to load, so an empty page " +
    "is indistinguishable from nothing being published");
  assert.ok(!/class="mk-card"(?! mk-prod)/.test(html),
    "a property card was drawn after the request failed — a fallback to examples " +
    "is the one thing this must never do");
  assert.equal((html.match(/class="mk-notice"/g) || []).length, 1,
    "the failure is reported more than once; eight copies of it reads as eight faults");
});

test("the homepage's generated inventory is gone for good", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");

  /*
   * renderRows() built nine rows of stays out of a country's `base` price and
   * wrote them into #homeRows. The arrays and gen() are still there as a record
   * of what a row looked like, but they must never be rendered again.
   */
  assert.ok(!/wrap\.innerHTML\s*=\s*rows\.map/.test(html),
    "the homepage is writing generated rows into #homeRows again. Those are not " +
    "listings — they are titles and prices computed from a country's indicative " +
    "price level, and a visitor cannot tell them from real inventory.");

  assert.ok(/id="paltas-marketplace"/.test(html),
    "the marketplace container is gone, so the real listings have nowhere to go");
});

test("no development-only wording is shown to the public", { skip }, () => {
  for (const page of ["index.html", "partner.html", "owners.html"]) {
    const html = readFileSync(join(FE, page), "utf8")
      /* comments explain the code to us, not the product to a visitor */
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const found = ["PALTAS · dev", "for this preview", "lorem ipsum", "TODO:", "FIXME",
                   "coming soon to this demo", "demo only"]
      .filter((s) => html.toLowerCase().includes(s.toLowerCase()));
    assert.deepEqual(found, [],
      `${page} shows development-only wording to the public: ${found.join(", ")}`);
  }
});

test("the filter bar keeps every airport-transfer chip the page had", { skip }, async () => {
  const html = await rendered(marketplaceHome(SAMPLE));

  /*
   * The five transfer chips existed before this redesign and must survive it.
   * What changed is honesty, not the set: three read the API, and the two that
   * ask about DIRECTION are disabled, because HotelService records a name, a
   * kind and a chargeable flag and nothing that says which way a car goes.
   *
   * They used to filter on a hard-coded table of three property names with a
   * direction typed beside each, which is why this test checks they are OFF
   * rather than just present.
   */
  /*
   * At rest the homepage shows the property types and ONE airport-transfer
   * chip. The four refinements live behind it — the page's job is to show
   * property, and seven filter controls plus a heading above the fold is not
   * that. What matters is that none of them was DROPPED, so each is checked
   * where it now lives.
   */
  for (const label of ["All", "Hotels", "Short stays", "Long stays", "Buy / Sell",
                       "Developments", "Airport transfer"]) {
    assert.ok(html.includes(label), `the "${label}" filter chip is gone from the marketplace`);
  }

  const w2 = marketplaceWithSupply(SAMPLE, SUPPLY);
  await rendered(w2);
  w2.win.PALTAS.Marketplace.setFilter("transfer");
  await new Promise((r) => setTimeout(r, 30));
  const opened = w2.win.document.getElementById("paltas-marketplace").innerHTML;
  for (const label of ["Pickup available", "Drop-off available",
                       "Free transfer", "Paid transfer"]) {
    assert.ok(opened.includes(label),
      `the "${label}" filter is not reachable even after choosing airport transfer`);
  }

  for (const gone of ["Pickup available", "Drop-off available"]) {
    const chip = (opened.match(new RegExp('<button[^>]*>' + gone + '</button>')) || [])[0] || "";
    assert.ok(/disabled/.test(chip) && /aria-disabled="true"/.test(chip),
      `"${gone}" is an active filter again, but nothing in the schema records ` +
      `transfer direction — so it can only be filtering on something invented. ` +
      `Chip: ${chip || "not found as a button"}`);
  }

  assert.ok(/mk-filter-note/.test(opened),
    "the two disabled chips give no reason, so they read as a bug rather than a gap");

  /* And the three that DO work must actually narrow. */
  const w = marketplaceHome(SAMPLE);
  await rendered(w);
  w.win.PALTAS.Marketplace.setFilter("transfer-free");
  const free = w.win.document.getElementById("paltas-marketplace").innerHTML;
  assert.ok(free.includes("Deluxe room, ocean wing"),
    "Free transfer dropped the one listing whose transfer service is not chargeable");
  assert.ok(!free.includes("Two-bedroom apartment, Nyali"),
    "Free transfer kept a listing whose transfer service charges");
});

test("only one airport-transfer filter bar is built on the homepage", { skip }, () => {
  /*
   * Checked in the source, not the DOM, and deliberately.
   *
   * dom-shim's getElementById never returns null — it auto-creates a node for any
   * id asked for, so that `getElementById(x).addEventListener(...)` does not
   * crash a page that works. That makes "is #atxFilter absent?" unanswerable
   * here: the answer is always "no", whatever the page does. An earlier version
   * of this test asserted it anyway and was measuring the harness.
   *
   * What IS checkable is that bar() still stands down when the real marketplace
   * is present. The old bar narrowed `#homeRows article`, which the marketplace
   * no longer fills, so without this guard the homepage grows a second filter bar
   * that changes nothing.
   */
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const fn = (html.match(/function bar\(\)\s*\{[\s\S]*?\n  \}/) || [])[0];
  assert.ok(fn, "the #atxFilter bar() function is gone — this test is stale, not the page");
  assert.ok(/getElementById\("paltas-marketplace"\)\)\s*return/.test(fn),
    "bar() no longer stands down for the real marketplace, so the homepage builds " +
    "two airport-transfer filter bars and only one of them narrows anything.");
});

/* ====================================================================== *
 * A LICENSED WHOLESALER ON THE PUBLIC PAGE.
 *
 * The marketplace can show somebody else's hotel rooms next to PALTAS's own
 * listings. Every test here is a version of one question: can a visitor tell
 * which is which?
 *
 * It matters more than it sounds. A PALTAS listing carries an assurance — an
 * identified company with an account here published it and you deal with them.
 * That assurance is false for a wholesaler's room, so a page that blurs the two
 * extends a guarantee PALTAS cannot honour across inventory it does not hold.
 * ====================================================================== */

const SUPPLY = [
  { id: "expedia-rapid:111", supplierRef: "111", title: "Nyali Beach Hotel",
    city: "Mombasa", country: "KE", place: "Mombasa Road, Mombasa",
    price: 70000, currency: "USD", nights: 7, priceBasis: "stay", perNight: 10000,
    refundable: true, rating: 8.6, ratingCount: 1423,
    image: "https://images.example/111.jpg", deepLink: null,
    source: "expedia-rapid", supplier: { name: "expedia-rapid", sandbox: false },
    paltasOwned: false },
];

/** The homepage, answered with PALTAS listings and a wholesaler's rooms. */
function marketplaceWithSupply(listings, supply, suppliers) {
  const w = openPage("index.html", { inlineToo: true });
  w.win.fetch = (u) => {
    /*
     * Recorded, because the shim only records ITS own fetch. Replacing fetch
     * after boot made every later request invisible — an assertion counting
     * them saw only the one made while the scripts were still loading, and a
     * test of "did this trigger a reload" could never pass.
     */
    w.calls.fetch.push(String(u));
    if (!/marketplace\/listings/.test(String(u))) return Promise.reject(new Error("unrelated"));
    const body = {
      listings, count: listings.length, source: "live-listings",
      supply, supplyCount: supply.length,
      suppliers: suppliers || {
        connected: supply.length > 0, name: "expedia-rapid", sandbox: false,
        failed: false, why: "", capabilities: ["search"],
      },
    };
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
    });
  };
  w.win.PALTAS.Marketplace.load();
  return w;
}

test("a wholesaler's room is never drawn as a PALTAS listing", { skip }, async () => {
  const html = await rendered(marketplaceWithSupply(SAMPLE, SUPPLY));

  /* Its own class, so it cannot inherit a PALTAS card's styling by accident. */
  assert.ok(/class="mk-card mk-supply"/.test(html),
    "the supplier's room is not drawn as supplier inventory");

  /* The attribution both suppliers' licences require, and the sentence that
     tells a visitor what they are looking at. */
  assert.ok(/Supplied by expedia-rapid/.test(html),
    "a supplier's room carries no attribution, which breaches the supplier's " +
    "terms and misleads the visitor at the same time");
  assert.ok(/These are not PALTAS listings/.test(html),
    "no shelf mixing the two says which is which");

  /*
   * And no PALTAS card may have picked any of it up.
   *
   * Both the supplier cards AND the shelf's attribution paragraph are removed
   * first — the attribution legitimately says "Supplied by", and leaving it in
   * made this assertion fire on the licence line rather than on a mislabelled
   * PALTAS card, which is the thing it is actually for.
   */
  const paltasCards = html
    .replace(/<article class="mk-card mk-supply"[\s\S]*?<\/article>/g, "")
    .replace(/<p class="mk-attrib[^"]*">[\s\S]*?<\/p>/g, "");
  assert.ok(!/Supplied by/.test(paltasCards),
    "a PALTAS listing is labelled as supplied by a wholesaler");
  assert.ok(!/mk-rating/.test(paltasCards),
    "a PALTAS listing is showing a rating. Nothing in the schema holds one, so " +
    "it can only have come from the supplier's data or from nowhere.");
});

test("a stay total is never labelled per night on the page", { skip }, async () => {
  const html = await rendered(marketplaceWithSupply(SAMPLE, SUPPLY));
  const card = (html.match(/<article class="mk-card mk-supply"[\s\S]*?<\/article>/) || [])[0] || "";
  assert.ok(card, "no supplier card was drawn");

  /*
   * The factor-of-seven error. A wholesaler quotes the whole stay; the PALTAS
   * short-let beside it quotes one night. Under one label the hotel looks like
   * the bargain of the year.
   */
  assert.ok(/7 nights total/.test(card),
    "the supplier's price does not say what period it covers: " + card.slice(0, 400));
  assert.ok(!/per night<\/span>/.test(card),
    "a supplier's stay total is labelled 'per night'");
  assert.ok(/worked out from the total/.test(card),
    "the per-night figure is shown without saying it was derived");
});

test("a sandbox rate is marked unbookable on every card", { skip }, async () => {
  const sandboxed = SUPPLY.map((o) => ({ ...o, supplier: { name: "expedia-rapid", sandbox: true } }));
  const html = await rendered(marketplaceWithSupply(SAMPLE, sandboxed, {
    connected: true, name: "expedia-rapid", sandbox: true, failed: false, why: "",
    capabilities: ["search"],
  }));

  const cards = html.match(/<article class="mk-card mk-supply"[\s\S]*?<\/article>/g) || [];
  assert.ok(cards.length, "no supplier card was drawn");
  for (const c of cards) {
    /* Case-insensitive: the badge is set in capitals, and this test is about
       whether the warning is present, not how it is typeset. */
    assert.ok(/not bookable/i.test(c),
      "a SANDBOX test rate is presented as if it could be booked, which is the " +
      "worst failure this integration can have");
  }
  /*
   * The guarantee, not the wording: the shelf says the rooms cannot be booked,
   * and it says it with the weight of a warning rather than as small print.
   * Asserting the old sentence verbatim made this fail when the copy improved.
   */
  assert.ok(/cannot be booked/.test(html),
    "the shelf does not warn that its rates cannot be booked");
  assert.ok(/mk-attrib-warn/.test(html),
    "the shelf's warning is styled as an ordinary footnote");
});

test("supplier rooms never push a PALTAS listing off a shelf", { skip }, async () => {
  /*
   * Ordering is the visible form of the same rule the two arrays encode: PALTAS
   * renders its own inventory first and the supplier fills what is left. A
   * wholesaler cannot displace a listing an agent here published.
   */
  const many = Array.from({ length: 6 }, (_, i) => ({
    ...SUPPLY[0], id: "expedia-rapid:" + i, supplierRef: String(i),
    title: "Supplier hotel " + i,
  }));
  const html = await rendered(marketplaceWithSupply(SAMPLE, many));

  for (const m of html.matchAll(/id="mk-([a-z-]+)"([\s\S]*?)(?=<section class="mk-sec"|$)/g)) {
    const body = m[2];
    if (!/mk-supply/.test(body)) continue;
    assert.ok(!/class="mk-card mk-supply"[\s\S]*?class="mk-card"[^ ]/.test(body),
      `in section "${m[1]}" a supplier room is rendered before a PALTAS listing`);
  }
});

test("sections where a hotel room is not the answer show none", { skip }, async () => {
  const html = await rendered(marketplaceWithSupply(SAMPLE, SUPPLY));
  const section = (id) =>
    (html.match(new RegExp('id="mk-' + id + '"([\\s\\S]*?)(?=<section class="mk-sec"|$)')) || [])[1] || "";

  /* Buying a building through an accommodation wholesaler is not a thing. */
  assert.ok(!/mk-supply/.test(section("buy-sell")),
    "a hotel room appears under Buy, sell and discover property");
  assert.ok(!/mk-supply/.test(section("developments")),
    "a hotel room appears under New developments");
  /*
   * And airport transfer is a fact about a PALTAS company's own HotelService.
   * A wholesaler's room says nothing about whether anybody will collect you, so
   * putting one here would make the section's own claim false.
   */
  assert.ok(!/mk-supply/.test(section("with-transfer")),
    "a wholesaler's room appears under Arrive with ease, which claims an " +
    "airport transfer service that nothing in the supplier's data reports");
});

test("with no supplier connected the page is exactly what it was", { skip }, async () => {
  /*
   * The preservation test, on the rendering side. This is production today.
   */
  const html = await rendered(marketplaceWithSupply(SAMPLE, [], {
    connected: false, name: "", sandbox: false, failed: false,
    why: "No accommodation supplier is connected to this installation.",
    capabilities: [],
  }));
  for (const trace of ["mk-supply", "Supplied by", "mk-attrib", "mk-rating", "Hotel rates"]) {
    assert.ok(!html.includes(trace),
      `the page shows supplier furniture ("${trace}") with no supplier connected`);
  }
  /* And PALTAS's own listings are all still there. */
  for (const l of SAMPLE) {
    assert.ok(html.includes(l.title), `PALTAS listing "${l.title}" vanished`);
  }
});

test("a supplier image is lazy and never re-hosted", { skip }, async () => {
  const html = await rendered(marketplaceWithSupply(SAMPLE, SUPPLY));
  const img = (html.match(/<img[^>]*images\.example[^>]*>/) || [])[0] || "";
  assert.ok(img, "the supplier's image was not rendered");
  assert.ok(/loading="lazy"/.test(img), "a supplier image loads eagerly");
  assert.ok(/src="https:\/\/images\.example/.test(img),
    "the image is not served from the supplier's own host — their terms do not " +
    "permit re-hosting it");
});

test("a default date window is allowed, but never undisclosed", { skip }, () => {
  /*
   * This replaces a test that asserted the page sends NO dates until the visitor
   * picks some. That was the wrong guarantee: every real supplier prices a stay,
   * so no dates meant no rooms, and a visitor arriving at a marketplace saw an
   * empty page with nothing to suggest that choosing dates would fill it.
   *
   * The honest rule is not "never default" — it is "never show a price without
   * saying which nights it covers". So the page defaults to a window, flags that
   * the window is ITS OWN rather than the visitor's, and says so above the
   * prices.
   */
  const js = readFileSync(join(FE, "assets", "paltas-market.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(/function defaultStay\(/.test(js),
    "there is no default window, so a visitor arriving without dates sees no " +
    "supplier rooms and no hint that dates would produce any");

  /* The flag that distinguishes our window from theirs. */
  assert.ok(/stayDefaulted/.test(js),
    "nothing tracks whether the dates are the visitor's own, so a default " +
    "cannot be labelled as one");

  /* And the line that actually tells them. */
  assert.ok(/not a search you made/.test(js),
    "the default window is never disclosed to the visitor");
  assert.ok(/function stayLine\(/.test(js), "there is no disclosure line");

  /* Choosing dates must clear the flag, or the page keeps apologising for a
     search the visitor did make. */
  assert.ok(/STATE\.stayDefaulted\s*=\s*!\(checkIn && checkOut\)/.test(js),
    "picking dates does not clear the defaulted flag");

  assert.ok(/setStay/.test(js), "there is no way for chosen dates to reach the request");
});

test("sample inventory is unmistakable on the page", { skip }, async () => {
  /*
   * The sample catalogue exists so the marketplace can be shown populated before
   * real inventory arrives. That is a genuinely dangerous thing to put on a
   * public site, and its only defence is that a visitor cannot mistake it for
   * something bookable. This test is that defence.
   */
  const samples = [{
    id: "paltas-sample:sample-1", supplierRef: "sample-1",
    title: "Beachfront apartment, Mombasa (sample)",
    city: "Mombasa", country: "KE", place: "Sample location",
    price: 18000, currency: "USD", nights: 1, priceBasis: "stay", perNight: 18000,
    refundable: null, rating: 8.6, ratingCount: 214, image: null, deepLink: null,
    source: "paltas-sample",
    supplier: {
      name: "paltas-sample",
      label: "PALTAS sample catalogue (not real inventory)",
      sandbox: true,
      disclosure: "This is sample content used to demonstrate the PALTAS marketplace. " +
        "It is not a real property, the price is not a real rate, and it cannot be booked.",
    },
    paltasOwned: false,
  }];

  const html = await rendered(marketplaceWithSupply([], samples, {
    connected: true, name: "paltas-sample",
    label: "PALTAS sample catalogue (not real inventory)",
    sandbox: true, failed: false, why: "", capabilities: ["search"],
  }));

  const cards = html.match(/<article class="mk-card mk-supply"[\s\S]*?<\/article>/g) || [];
  assert.ok(cards.length, "no sample card was drawn");

  for (const c of cards) {
    /* In the title, so it survives a screenshot that crops every badge off. */
    assert.ok(/\(sample\)/.test(c), "a sample card's title does not say it is a sample");
    assert.ok(/NOT BOOKABLE/.test(c), "a sample card does not say it cannot be booked");
    assert.ok(/not a real property/.test(c),
      "the disclosure is not on the card, so a client that ignored the envelope " +
      "would render sample inventory with nothing to say it is not real");
    assert.ok(/mk-kind-sample/.test(c), "the sample badge is styled as ordinary supplier stock");
  }

  /* The shelf warning is a warning, not small print. */
  assert.ok(/mk-attrib-warn/.test(html),
    "a shelf of unbookable inventory carries only a normal-weight footnote");
  assert.ok(/cannot be booked/.test(html));

  /*
   * And PALTAS's own array must still be honestly empty. The sample is a
   * SUPPLIER: it can only ever reach `supply`, so an empty marketplace still
   * reports as empty rather than being quietly padded out.
   */
  assert.ok(!/class="mk-card"(?! mk-supply)/.test(html),
    "a sample was drawn as one of PALTAS's own listings");
});

test("the supplier attribution reads as a brand, not an adapter name", { skip }, async () => {
  /* "Supplied by booking-demand" is an internal identifier leaking onto a public
     page, and both suppliers' licences name the brand to attribute. */
  const booking = [{
    ...SUPPLY[0], id: "booking-demand:111", source: "booking-demand",
    supplier: { name: "booking-demand", label: "Booking.com", sandbox: false, disclosure: "" },
  }];
  const html = await rendered(marketplaceWithSupply(SAMPLE, booking, {
    connected: true, name: "booking-demand", label: "Booking.com",
    sandbox: false, failed: false, why: "", capabilities: ["search"],
  }));
  assert.ok(/Supplied by Booking\.com/.test(html), "the brand name is not attributed");
  assert.ok(!/Supplied by booking-demand/.test(html),
    "the internal adapter name is printed on the public page");
});

/* ====================================================================== *
 * THE HOTEL CHECKOUT.
 *
 * The instruction was explicit: do not build a second payment system. These
 * are the checks that one was not built by accident.
 * ====================================================================== */

test("the checkout is not a second payment system", { skip }, () => {
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8");
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "");

  /*
   * LiteAPI owns the Stripe account: "you never need your own Stripe account or
   * your own server-side Stripe integration — the PaymentIntent is created on
   * LiteAPI's Stripe platform when you call the prebook endpoint."
   *
   * So this file may MOUNT an Element against LiteAPI's PaymentIntent using
   * LiteAPI's publishable key. It must not create a PaymentIntent, a customer or
   * a charge, and it must not carry a key of its own.
   */
  assert.ok(!/pk_live_[A-Za-z0-9]|pk_test_[A-Za-z0-9]/.test(code),
    "a Stripe publishable key is hard-coded. It belongs in configuration — it is " +
    "LiteAPI's to rotate and it differs per environment.");
  assert.ok(!/sk_live_|sk_test_/.test(code), "a Stripe SECRET key appears in browser code");
  assert.ok(!/paymentIntents\.create|createPaymentIntent|customers\.create/.test(code),
    "the checkout is creating Stripe objects — LiteAPI already created the " +
    "PaymentIntent, and a second one would charge twice");

  /* The publishable key must arrive from the backend, per environment. */
  assert.ok(/publishableKey/.test(code), "the checkout does not read a publishable key at all");
  assert.ok(/Stripe\(\s*p\.publishableKey|Stripe\(p\.publishableKey/.test(code),
    "Stripe is not initialised from the key the backend supplied");
});

test("Stripe.js is not loaded until somebody reaches payment", { skip }, async () => {
  /*
   * A visitor reading the homepage has not asked to be introduced to a payment
   * processor. A third-party script on every page view is a performance cost and
   * a privacy one.
   */
  const w = openPage("index.html", { inlineToo: true });
  await new Promise((r) => setTimeout(r, 40));
  const loaded = (w.win.document.head.children || [])
    .filter((e) => /js\.stripe\.com/.test(e.src || ""));
  assert.equal(loaded.length, 0, "Stripe.js is loaded on page view");

  const html = readFileSync(join(FE, "index.html"), "utf8");
  assert.ok(!/js\.stripe\.com/.test(html),
    "Stripe.js is hard-linked in the page rather than loaded at the payment step");
});

test("the checkout refuses rather than offering a payment it cannot take", { skip }, () => {
  /*
   * LiteAPI issues publishable keys through an account manager, not their
   * dashboard — so a working API key with no payment key is a legitimate state.
   * Offering a pay button then walks somebody through a form to a dead end.
   */
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8");
  assert.ok(/if \(!p\.publishableKey\)/.test(js),
    "the checkout does not check for a publishable key before taking somebody to payment");
  assert.ok(/cannot be paid for yet/.test(js), "there is no honest refusal state");
  assert.ok(/Nothing has been charged/.test(js),
    "a failure path does not reassure the guest that nothing was charged");
});

test("the pair is saved before payment, never only in the URL", { skip }, () => {
  /*
   * LiteAPI: "Save transactionId and prebookId together, immediately. Each
   * prebook call generates a new pair, and they cannot be retrieved later."
   * Losing one means a guest who paid for a room that was never booked and
   * cannot be found.
   */
  /* Comments stripped first. The header explains this rule in prose, and an
     earlier version of this test found the word there instead of in the code —
     asserting my own documentation rather than my own behaviour. */
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const confirm = js.indexOf("confirmPayment");
  const saveBefore = js.lastIndexOf("save()", confirm);
  assert.ok(confirm > 0 && saveBefore > 0 && saveBefore < confirm,
    "the journey is not persisted before confirmPayment, so a 3D Secure redirect " +
    "would lose the transaction");
  assert.ok(/sessionStorage/.test(js), "nothing survives the redirect");
  /* And a pasted return URL must not try to book anything. */
  assert.ok(/!saved\.prebookId \|\| !saved\.transactionId/.test(js),
    "the return handler does not verify it has a real journey to finish");
});

test("a customer never settles a hotel booking with ACC_CREDIT_CARD", { skip }, () => {
  /*
   * It charges the PARTNER's card in production — "the partner bears full
   * financial responsibility for the transaction" — so used for customer
   * bookings it bills PALTAS for every room a visitor takes.
   */
  /* Comments stripped: the code explains in prose why the other path exists and
     that explanation is not a use of it. */
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/ACC_CREDIT_CARD/.test(js),
    "the checkout SENDS ACC_CREDIT_CARD, which would bill PALTAS rather than the guest");
});

test("no public control can open the demo search", { skip }, () => {
  /*
   * #bookFlow is a search-and-book experience backed by `LISTINGS` — nine
   * invented properties with invented names, prices and ratings — plus invented
   * collections ("Cliffside villas", "Lakeside cottages").
   *
   * It was reachable from twenty-one places: the Hotels chip, the hero Search,
   * every generated row card, the wishlist button, two footers, the inspiration
   * grid. A customer selecting Hotels on the live site was shown fake hotels.
   *
   * The gate is at openFlow(), the single function all of them call, because
   * twenty-one separate fixes would have missed one — and the one missed is the
   * one somebody finds.
   */
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const fn = html.slice(html.indexOf("window.openFlow=function"),
                        html.indexOf("window.__demoBookFlow=function"));
  assert.ok(fn.includes("PALTAS_SEARCH"),
    "openFlow no longer routes to the real marketplace — the demo search is " +
    "reachable from every public control again");
  assert.ok(!/flow\.classList\.add/.test(fn),
    "openFlow opens the demo modal directly");

  /* And the two controls a customer actually used. */
  const setStay = html.slice(html.indexOf("window.setStayType=function"),
                             html.indexOf("window.setStayType=function") + 1400);
  assert.ok(setStay.includes("PALTAS_SEARCH"), "the category chips open the demo flow again");
  assert.ok(!/window\.openFlow\(\)/.test(setStay), "setStayType still calls openFlow");
});

test("the search sends what the visitor chose, not a substitute", { skip }, () => {
  /*
   * "Do not silently replace dates with demo/default dates." The page may
   * DEFAULT a window when none is chosen — and says so — but once somebody
   * picks a destination, dates or occupancy, those must be what reaches the
   * supplier.
   */
  const js = readFileSync(join(FE, "assets", "paltas-market.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/stayCity=/.test(js), "the typed destination is never sent to the supplier");
  assert.ok(/function searchFor\(/.test(js), "there is no single entry point for a real search");
  assert.ok(/STATE\.stayDefaulted\s*=\s*false/.test(js),
    "a real search does not clear the defaulted flag, so the page would keep " +
    "calling the visitor's own dates a default");

  const html = readFileSync(join(FE, "index.html"), "utf8");
  const hero = html.slice(html.indexOf("window.heroSearch=function"),
                          html.indexOf("window.heroSearch=function") + 1600);
  for (const part of ["heroIn", "heroOut", "heroType", "guests: total"]) {
    assert.ok(hero.includes(part), `the hero search drops ${part} before calling the API`);
  }
});

test("a category decides which real inventory is shown", { skip }, () => {
  /* Hotels -> a licensed supplier. Everything else -> PALTAS's own published
     inventory. Nothing maps to a local array. */
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const map = html.slice(html.indexOf("const MAP={ all:"), html.indexOf("const MAP={ all:") + 260);
  for (const [chip, filter] of [["hotel", "hotels"], ["stays", "short"],
                                ["rent", "long"], ["buy", "sale"],
                                ["projects", "developments"]]) {
    assert.ok(new RegExp(`${chip}\\s*:\\s*'${filter}'`).test(map),
      `the "${chip}" category does not map to the "${filter}" inventory`);
  }
});

test("the products on the homepage are ones PALTAS can actually deliver", { skip }, async () => {
  /*
   * A product card is a promise a visitor can click. A product that does not
   * exist is the same fabrication as an invented listing — told about the
   * company rather than about a property — and it is the easier one to ship by
   * accident, because nobody checks a marketing section against the schema.
   *
   * So this checks BOTH directions against the Product enum: nothing advertised
   * that is not built, and nothing built quietly left off.
   */
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const block = schema.slice(schema.indexOf("enum Product {"));
  const products = block.slice(0, block.indexOf("}"))
    .split("\n").map((l) => l.trim())
    .filter((l) => /^[A-Z_]+$/.test(l));

  const html = await rendered(marketplaceHome(SAMPLE));

  /* PLATFORM is PALTAS's own staff console — not for sale, so not on the page. */
  const forSale = products.filter((p) => p !== "PLATFORM");
  const shown = {
    PROPERTY_MANAGEMENT: "Property Management",
    AGENT_HOST: "Agent &amp; Host",
    HOTEL_MANAGEMENT: "Hotel Management",
    SECURITY_MANAGEMENT: "Security Management",
    GUEST_PORTAL: "Guest Portal",
  };

  const missing = forSale.filter((p) => !html.includes(shown[p]));
  assert.deepEqual(missing, [],
    "these products exist in the schema but are not offered on the homepage: " +
    missing.join(", "));

  assert.ok(!/\bFlights?\b|\bAir travel\b/.test(html),
    "a flights product is advertised. PALTAS has no flights code, no flights " +
    "data, and LiteAPI returns 404 for flights on this account — so the card " +
    "would lead a visitor nowhere.");
  assert.ok(!html.includes("PALTAS Platform</h3>"),
    "the internal staff console is being offered to customers");
});

test("a guest is asked to sign in BEFORE typing their details", { skip }, () => {
  /*
   * Reported from the live site: the guest chose a room, reviewed it, filled in
   * their name, email and phone, pressed continue — and was bounced to sign in,
   * losing the lot. The session is needed to HOLD a rate, and the hold happens
   * after the form, so it was discovered at the last possible moment.
   */
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const details = js.indexOf("function details(");
  const render = js.indexOf("function renderDetails(");
  assert.ok(details > 0 && render > details,
    "details() no longer gates before rendering the form");
  const gate = js.slice(details, render);
  assert.ok(/whoAmI\(\)/.test(gate), "the session is not checked before the form is drawn");
  assert.ok(/askToSignIn/.test(gate), "there is no sign-in step before the form");

  /*
   * And the check must use what index.html ACTUALLY loads. An earlier version
   * reached for PALTAS.Auth — which that page does not load — found nothing,
   * assumed signed-in, and showed the form to everybody, which is the bug it
   * was written to prevent.
   */
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const loads = (name) => html.includes(`src="assets/${name}"`);
  const usesAuthModule = /PALTAS\.Auth\.status/.test(js);
  assert.ok(!usesAuthModule || loads("paltas-auth.js"),
    "the checkout asks PALTAS.Auth for the session, but index.html does not " +
    "load paltas-auth.js — so the check silently answers 'signed in' for everyone");
});

test("signing in to book never routes through the business onboarding", { skip }, () => {
  /*
   * The sign-in PAGE puts a new account through a wizard whose first question is
   * "Do you also do business on PALTAS?" — the right question for a letting
   * agent, and completely the wrong one for somebody booking four nights. A
   * guest reported landing there mid-booking.
   */
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const fn = js.slice(js.indexOf("function signInHref("));
  const body = fn.slice(0, fn.indexOf("\n  }"));

  assert.ok(!/login\.html/.test(body),
    "the booking sign-in goes via login.html, which opens the business wizard");
  assert.ok(/auth\/google/.test(body), "it does not go straight to Google");
  assert.ok(/next=/.test(body), "it carries no next=, so the guest lands on the homepage");
  assert.ok(/paltas_booking=resume/.test(body),
    "nothing marks the return, so the journey restarts instead of resuming");

  /* And the journey must actually resume rather than just return. */
  assert.ok(/paltas_booking=resume/.test(js.slice(js.indexOf("function resumeIfReturning"))),
    "the return marker is never handled");
});

test("a confirmed booking leads somewhere, and that place is real", { skip }, () => {
  /* A confirmation with no way onward is a dead end: the booking exists and
     nothing on screen says where to find it again. */
  const js = readFileSync(join(FE, "assets", "paltas-checkout.js"), "utf8");
  assert.ok(/data-pc="stays"/.test(js), "the confirmation offers no next step");
  assert.ok(/D\.request\("\/marketplace\/stays"\)/.test(js),
    "My bookings does not read PALTAS's own record");
  assert.ok(/data-pc="cancel"/.test(js), "a stay cannot be cancelled from the list");
  /* Non-refundable cancellations charge anyway; saying only "cancelled" would
     tell somebody they had their money back. */
  assert.ok(/body\.charged/.test(js),
    "the cancellation outcome does not distinguish charged from refunded");
});

test("a star classification is never invented", { skip }, async () => {
  /*
   * Stars are an official classification awarded to a building. A guest score is
   * an average of opinions. A hotel can be 3-star and score 9.4; a 5-star can
   * score 7.1. Showing one as the other misrepresents both — and inventing
   * stars for a hotel that has none is the same fabrication as an invented
   * price.
   *
   * In a live Nairobi search, 47 of 48 hotels carried a classification. The
   * 48th must show nothing.
   */
  const withStars = { ...SUPPLY[0], stars: 4, rating: 9, ratingCount: 279 };
  const noStars = { ...SUPPLY[0], id: "x:2", supplierRef: "2", title: "Unclassified Inn",
                    stars: null, rating: 8.1, ratingCount: 44 };
  const noScore = { ...SUPPLY[0], id: "x:3", supplierRef: "3", title: "No Reviews Yet",
                    stars: 3, rating: null, ratingCount: null };

  const html = await rendered(marketplaceWithSupply([], [withStars, noStars, noScore]));
  const cardFor = (title) =>
    (html.match(new RegExp('<article class="mk-card mk-supply">(?:(?!</article>)[\\s\\S])*?' +
      title + '[\\s\\S]*?</article>')) || [""])[0];

  const classified = cardFor("Nyali Beach Hotel");
  assert.ok(/mk-stars/.test(classified), "a classified hotel shows no stars");
  assert.ok(/aria-label="4-star hotel"/.test(classified),
    "the stars do not announce themselves as a classification");
  /* Four filled of five — not four glyphs, which would read as a 4-star scale. */
  /* Four filled of five — not four glyphs, which would read as a 4-star scale. */
  assert.equal((classified.match(/mk-pip on/g) || []).length, 4);
  assert.equal((classified.match(/class="mk-pip/g) || []).length, 5);

  const unclassified = cardFor("Unclassified Inn");
  assert.ok(unclassified, "the unclassified hotel was not drawn at all");
  assert.ok(!/mk-stars/.test(unclassified),
    "stars were invented for a hotel the supplier gave no classification for");
  /* It still has a guest score, and that must still show. */
  assert.ok(/mk-score/.test(unclassified), "its guest score was dropped along with the stars");

  const unreviewed = cardFor("No Reviews Yet");
  assert.ok(/mk-stars/.test(unreviewed), "a hotel with stars but no reviews lost its stars");
  assert.ok(!/mk-score/.test(unreviewed),
    "a guest score was shown for a hotel nobody has reviewed");
});

test("classification and guest score are rendered as different things", { skip }, async () => {
  const o = { ...SUPPLY[0], stars: 3, rating: 9.4, ratingCount: 1401 };
  const html = await rendered(marketplaceWithSupply([], [o]));
  const card = (html.match(/<article class="mk-card mk-supply">[\s\S]*?<\/article>/) || [""])[0];

  /* A 3-star scoring 9.4 is the case that proves they are not the same value. */
  assert.ok(/aria-label="3-star hotel"/.test(card));
  assert.ok(/9\.4/.test(card) && /1401/.test(card), "the guest score or its count is missing");
  assert.ok(!/aria-label="9-star|9\.4-star/.test(card),
    "the guest score is being rendered as a star classification");
  assert.ok(card.indexOf("mk-stars") < card.indexOf("mk-score"),
    "the score appears above the classification, which invites reading one as the other");
});

test("every primary CTA uses the one brand token, and is readable on it", { skip }, () => {
  /*
   * This used to assert four specific hex values. That made it a test of
   * FASHION — it failed the moment the brand changed, which is a decision, not
   * a defect, and it said nothing about whether the result could be read.
   *
   * What matters is the property underneath: whatever colour the brand is, the
   * text sitting on it has to pass WCAG AA. The brand has now been a deep teal
   * and a bright turquoise; the arithmetic below holds for both, and for the
   * next one.
   *
   * It is not academic. White on the current brand measures 2.09:1 — which is
   * why the text on it is charcoal.
   */
  const css = readFileSync(join(FE, "index.html"), "utf8");

  const token = (name) => {
    const m = css.match(new RegExp("--" + name + ":\\s*(#[0-9A-Fa-f]{6})"));
    assert.ok(m, `the --${name} token is missing`);
    return m[1];
  };

  /* Relative luminance and contrast, per WCAG 2.x. */
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  const accent = token("mk-accent");
  const deep = token("mk-deep");
  const pressed = token("mk-pressed");
  const onAccent = token("mk-on-accent");
  const brandInk = token("mk-brand-ink");

  /* Text on the button, in all three states. */
  for (const [state, fill] of [["rest", accent], ["hover", deep], ["pressed", pressed]]) {
    const r = ratio(onAccent, fill);
    assert.ok(r >= 4.5,
      `text on the ${state} CTA is ${r.toFixed(2)}:1 — below the 4.5:1 AA asks for. ` +
      `A CTA nobody can read is not a CTA.`);
  }

  /* The brand used as TEXT, on the two grounds the site actually has. */
  for (const [where, bg] of [["white", "#ffffff"], ["the tinted section ground", "#f7f8fa"]]) {
    const r = ratio(brandInk, bg);
    assert.ok(r >= 4.5,
      `brand text on ${where} is ${r.toFixed(2)}:1 — below AA`);
  }

  /*
   * And the bright fill must never BE the text. That is the specific mistake
   * this guards: a brand chosen for a button, then reused for a link.
   */
  assert.ok(!/[^-]color:var\(--mk-accent\)/.test(css),
    "the brand fill is being used as text somewhere. It is chosen to sit " +
    "behind letters, not to be them.");

  /* Every primary CTA resolves to the token rather than its own colour. */
  for (const cta of ["hs-search", "promo-btn"]) {
    const rule = (css.match(new RegExp("^\\." + cta + "\\{[^}]*", "m")) || [""])[0];
    assert.ok(!/var\(--grad\)/.test(rule), `.${cta} uses a gradient instead of the brand token`);
    assert.ok(/var\(--mk-accent\)/.test(rule), `.${cta} does not use the brand token`);
  }
  for (const link of ["rb-switch", "view-all-link"]) {
    const rule = (css.match(new RegExp("^\\." + link + "\\{[^}]*", "m")) || [""])[0];
    assert.ok(!/--teal-ink/.test(rule), `.${link} uses --teal-ink, which is 4.28:1 and fails AA`);
  }

  /* The embedded demos keep their own palette — a separate surface. */
  assert.ok(/\.portal-app :root/.test(css), "the embedded demos no longer scope their own tokens");
});

test("switching country re-asks the supplier, every time", { skip }, async () => {
  /*
   * Reported from the live site: changing country repainted the header, the
   * currency label and the hero copy, and left the marketplace showing the
   * previous country's hotels. The page said "Sweden, SEK" above a shelf of
   * Nairobi rooms priced in dollars, and nothing said it was stale.
   *
   * `stayCountry` is what the supplier prices against, so changing it has to
   * re-ask. The old answer is not an approximation of the new one — it is a
   * different country.
   */
  const w = marketplaceWithSupply(SAMPLE, SUPPLY);
  await rendered(w);

  const asked = () => w.calls.fetch.filter((u) => /marketplace\/listings/.test(u));
  const before = asked().length;
  assert.ok(before > 0, "the marketplace never asked for anything");

  const MK = w.win.PALTAS && w.win.PALTAS.Market;
  assert.ok(MK && MK.setCountry, "the market service is not on the page");

  MK.setCountry("AE", "chosen");
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(asked().length > before,
    "changing country did not re-ask the supplier — the shelf keeps the previous " +
    "country's hotels while the header says somewhere else");
  assert.match(asked().slice(-1)[0], /stayCountry=AE/,
    "the new country is not what the supplier was asked for");

  /* Every switch, not only the first. */
  const second = asked().length;
  MK.setCountry("GB", "chosen");
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(asked().length > second, "the second switch did nothing");
  assert.match(asked().slice(-1)[0], /stayCountry=GB/);

  /*
   * And a typed destination does not travel. A city belongs to the market it
   * was typed in — carrying "Mombasa" into Sweden asks for a place that is not
   * there, and the empty shelf that comes back looks like a fault.
   */
  w.win.PALTAS_SEARCH({ category: "hotels", city: "London" });
  await new Promise((r) => setTimeout(r, 40));
  assert.match(asked().slice(-1)[0], /stayCity=London/);
  MK.setCountry("KE", "chosen");
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!/stayCity=London/.test(asked().slice(-1)[0]),
    "a London search was carried into Kenya");

  /*
   * But only the market. Language, residence and destination also emit, and
   * none of them changes which country is being priced — reloading on each
   * would be needless round trips to a wholesaler.
   */
  const quiet = asked().length;
  MK.setLanguage("sw");
  MK.setDestination("Diani");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(asked().length, quiet,
    "a language or destination change re-asked the supplier for no reason");
});

test("a card row can be scrolled, not just wrapped", { skip }, async () => {
  /*
   * The rows were a wrapped CSS grid: four across, then a second row, with
   * nothing to drag. A visitor could only reach the first handful of what a
   * search returned, and on a phone got one column and a very long page.
   */
  const many = Array.from({ length: 14 }, (_, i) => ({
    ...SUPPLY[0], id: "x:" + i, supplierRef: String(i), title: "Hotel " + i,
  }));
  const html = await rendered(marketplaceWithSupply([], many));

  assert.ok(/class="mk-rail"/.test(html), "the rows are not scrollable rails");
  assert.ok(/class="mk-arrow"/.test(html), "there is no way to move a rail with a pointer");
  /* A rail must be reachable and announced, or it is a mouse-only feature. */
  assert.ok(/tabindex="0"/.test(html), "the rail cannot be reached by keyboard");
  assert.ok(/role="group" aria-label="[^"]*scrollable"/.test(html),
    "the rail does not tell a screen reader it scrolls");

  /* More than the eight a wrapped grid could justify — sideways space is cheap. */
  const inFirst = (html.match(/id="mk-available-today"[\s\S]*?(?=<section class="mk-sec"|$)/) || [""])[0];
  assert.ok((inFirst.match(/class="mk-card mk-supply"/g) || []).length > 8,
    "a rail still shows only a wrapped grid's worth of cards");

  const css = readFileSync(join(FE, "index.html"), "utf8");
  assert.ok(/\.mk-rail\{[\s\S]*?overflow-x:auto/.test(css), "the rail does not scroll");
  assert.ok(/scroll-snap-type:x/.test(css), "no snapping — a swipe lands between cards");
  /*
   * The peek. A row ending flush at the screen edge looks finished, and nobody
   * swipes a row they believe has ended.
   */
  /*
   * On a phone a card must be NARROWER than the rail, so the next one shows at
   * the edge. A row ending flush looks finished, and nobody swipes a row they
   * believe has ended.
   *
   * Checked as behaviour rather than by token name: this was `--mk-peek:44px`
   * until the arithmetic was rewritten to keep var() out of calc's multiplier
   * and divisor, which is the shape older Safari mis-evaluates.
   */
  const phone = (css.match(/@media \(max-width:620px\)\{[\s\S]*?\n\}/) || [""])[0];
  assert.ok(/flex-basis:calc\(100% - \d+px\)/.test(phone),
    "on a phone the card fills the whole rail, so the row looks complete and " +
    "nobody swipes it");

  /* And no var() in a calc multiplier or divisor, anywhere in the rail rules. */
  assert.ok(!/\/ var\(--mk-per\)/.test(css),
    "a calc() still divides by a custom property — the construct older Safari " +
    "mis-evaluates, which silently gives a card no width");
});

test("an empty or product row gets no arrows", { skip }, async () => {
  /* An arrow above something that cannot move is furniture. */
  const html = await rendered(marketplaceWithSupply([], []));

  /* An empty section is no longer an empty state with no arrows — it is not
     there at all, which is the same promise kept more thoroughly. */
  assert.ok(!/id="mk-buy-sell"/.test(html),
    "nothing is for sale, yet the section still occupies the page");
  assert.ok(!/mk-arrow/.test(html),
    "arrows were drawn above a page with no rail on it");

  const discover = (html.match(/id="mk-discover"[\s\S]*$/) || [""])[0];
  assert.ok(!/mk-arrow/.test(discover), "the product cards have scroll arrows");
});

test("the discovery rail is endless, touch-first and has no arrows", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");

  /*
   * THE ARROWS ARE GONE — markup, styles and handlers.
   *
   * Leaving any one of the three behind is how a control comes back: a rule
   * still matching, a listener still bound to an element that no longer exists.
   */
  for (const ghost of ["pdiscPrev", "pdiscNext", "pdisc-arrow"]) {
    assert.equal((html.match(new RegExp(ghost, "g")) || []).length, 0,
      `${ghost} survives somewhere — the arrows are only half removed`);
  }

  /*
   * ENDLESS means a second identical copy of the slides and a silent correction
   * once motion has settled. Both halves are load-bearing: without the copy the
   * rail hits a wall, and without the correction it runs off the end.
   */
  assert.ok(/live\.map\(function \(p, i\) \{ return cardHTML\(p, i, true\); \}\)/.test(html),
    "the rail renders only one copy of the slides, so forward motion hits a wall");
  assert.ok(/function normalise\(\)/.test(html) && /scrollLeft - w/.test(html),
    "nothing pulls the rail back a copy's width, so it runs off the end");
  assert.ok(/aria-hidden="true" tabindex="-1"/.test(html),
    "the duplicated slides are announced and focusable, so everything is heard twice");

  /*
   * THE ONE THAT WOULD HAVE BEEN INVISIBLE UNTIL SOMEBODY WATCHED IT.
   *
   * With `scroll-behavior:smooth` in the stylesheet, EVERY scrollLeft change
   * animates — including the correction that is supposed to be imperceptible.
   * The loop would have rewound in full view. Smoothness is asked for per call
   * in JS instead, which is also how reduced-motion gets to decline it.
   */
  const rail = (html.match(/\.pdisc-rail\{[^}]*\}/) || [""])[0];
  assert.ok(/scroll-behavior:auto/.test(rail),
    "the rail is smooth-scrolling in CSS, which makes the endless wrap a visible rewind");

  /* Touch scrolls it natively; a mouse cannot, so a mouse may drag it. */
  assert.ok(/e\.pointerType !== "mouse"/.test(html),
    "drag is bound to touch as well, replacing the browser's own scrolling with an imitation");
  assert.ok(/pdisc-rail\.dragging\{[^}]*scroll-snap-type:none/.test(html),
    "snapping stays on during a drag and fights the cursor");

  /* 4-5 seconds, and it comes back after being left alone. */
  const auto = html.slice(html.indexOf("function startAuto()"), html.indexOf("var settle"));
  assert.ok(/\}, 4500\);/.test(auto), "auto-advance is not in the 4-5s the brief asks for");
  assert.ok(/if \(reduced \|\| paused \|\| timer\) return;/.test(auto),
    "a visitor who asked for less motion still gets a slideshow");

  const stopFn = html.slice(html.indexOf("function stop(forever)"), html.indexOf("function startAuto()"));
  assert.ok(/setTimeout/.test(stopFn), "a paused rail never resumes");
  assert.ok(/forever === true/.test(stopFn), "a deliberate choice does not stop it for good");
});

test("the transfer options do not clutter the homepage at rest", { skip }, async () => {
  /*
   * There were two permanent rows: property types, then a labelled "AIRPORT
   * TRANSFER" row of five more chips — two of which are disabled forever,
   * because nothing in the schema records which direction a transfer runs in.
   * Seven controls and a heading above the fold, on a page whose job is to show
   * property.
   */
  const w = marketplaceWithSupply(SAMPLE, SUPPLY);
  const html = await rendered(w);
  const bar = (html.match(/<div class="mk-filters">[\s\S]*?(?=<section)/) || [""])[0];

  assert.equal((bar.match(/class="mk-filter-row/g) || []).length, 1,
    "the filter bar still has two permanent rows");
  assert.ok(!/mk-filter-label/.test(bar),
    "the always-on AIRPORT TRANSFER heading is back");
  assert.equal((bar.match(/mk-chip-off/g) || []).length, 0,
    "permanently-disabled chips are on show before anybody asked about transfers");
  assert.ok(!/mk-filter-note/.test(bar),
    "the explanation of why two chips are dead is shown to everyone");
  /* But the way in is still there. */
  assert.ok(/mk-chip-transfer/.test(bar), "airport transfer is not reachable at all");
});

test("choosing airport transfer reveals its options, and they are all still there", { skip }, async () => {
  /*
   * The disabled pair is preserved deliberately — an earlier decision was that
   * these five filters must survive. They now live where somebody has actually
   * asked about transfers, next to the sentence explaining why two cannot work,
   * rather than in front of everyone browsing hotels.
   */
  const w = marketplaceWithSupply(SAMPLE, SUPPLY);
  await rendered(w);
  w.win.PALTAS.Marketplace.setFilter("transfer");
  await new Promise((r) => setTimeout(r, 30));

  const open = w.win.document.getElementById("paltas-marketplace").innerHTML;
  assert.ok(/mk-refine/.test(open), "nothing was revealed");
  for (const label of ["Free transfer", "Paid transfer", "Pickup available", "Drop-off available"]) {
    assert.ok(open.includes(label), `"${label}" was dropped rather than moved`);
  }
  assert.ok(/aria-expanded="true"/.test(open),
    "the parent chip does not tell a screen reader it opened something");
  assert.ok(/mk-filter-note/.test(open),
    "the two greyed options are shown with no reason given");

  /* And it folds away again. */
  w.win.PALTAS.Marketplace.setFilter("all");
  await new Promise((r) => setTimeout(r, 30));
  const closed = w.win.document.getElementById("paltas-marketplace").innerHTML;
  assert.ok(!/mk-refine/.test(closed), "the options stay open after moving off transfer");
  assert.equal((closed.match(/mk-chip-off/g) || []).length, 0,
    "the disabled chips remain on the homepage");
});

test("every stylesheet parses, and nothing collapses a card to nothing", { skip }, () => {
  /*
   * A page reported blank on a phone while the headings rendered. That signature
   * — markup present, contents invisible — is CSS, not data, so these are the
   * three things found while chasing it.
   *
   * ONE: an unbalanced stylesheet. index.html carried a stray `}` that closed
   * nothing. Browsers recover from a top-level parse error, but they are not
   * obliged to recover IDENTICALLY, and a stray brace one line higher would
   * have closed a media query early and leaked its rules everywhere.
   */
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.ok(blocks.length, "the page has no stylesheet at all");

  blocks.forEach((css, i) => {
    /* Counted outside comments and strings, or a brace in either would lie. */
    let depth = 0, at = 0;
    while (at < css.length) {
      if (css.startsWith("/*", at)) { const e = css.indexOf("*/", at + 2); at = e < 0 ? css.length : e + 2; continue; }
      const ch = css[at];
      if (ch === '"' || ch === "'") {
        let j = at + 1;
        while (j < css.length && css[j] !== ch) { if (css[j] === "\\") j++; j++; }
        at = j + 1; continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        assert.ok(depth >= 0, `stylesheet ${i} has a stray closing brace — it closes nothing, and one line higher it would close a media query early`);
      }
      at++;
    }
    assert.equal(depth, 0, `stylesheet ${i} leaves ${depth} rule(s) unclosed`);
  });

  /*
   * TWO: aspect-ratio is Safari 15+. Before that it is ignored, and a box whose
   * only child is an image at height:100% collapses to nothing — an image area
   * with no height, on the one platform hardest to debug.
   */
  assert.ok(/padding-top:66\.667%/.test(html),
    "the card image has no pre-aspect-ratio fallback, so it collapses on older Safari");
  assert.ok(/@supports \(aspect-ratio/.test(html),
    "the fallback is never overridden, so modern browsers keep the padding hack");

  /*
   * THREE: a floor under the card. An invisible card and an absent one look
   * identical to somebody on a phone, so no arithmetic may produce either.
   */
  const cardRule = (html.match(/\.mk-rail > \.mk-card\{[\s\S]*?\}/) || [""])[0];
  assert.ok(/min-width:\s*\d+px/.test(cardRule), "a card can be squeezed to nothing");
  assert.ok(/min-height:\s*\d+px/.test(cardRule), "a card can collapse to no height");
});

test("the hero gained pilgrimage photography and lost none of its own", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");

  /*
   * ADDED TO, NOT SWAPPED.
   *
   * The embedded luxury villa is the first frame of every rotation: it is a
   * data: URI, so it paints before any network request and the hero is never
   * briefly empty. It must survive untouched, and so must all five global
   * slides — "add pilgrimage imagery" is not licence to quietly re-shoot the
   * homepage.
   */
  assert.ok(/const PALTAS_HERO = "data:image\/jpeg;base64,/.test(html),
    "the embedded luxury hero is gone, so the hero is blank until a photo lands");
  assert.ok(/const slideList = \[PALTAS_HERO\]\.concat\(/.test(html),
    "the embedded hero is no longer the first frame");

  for (const id of ["1507525428034", "1533105079780", "1512453979798",
                    "1602002418082", "1520250497591"]) {
    assert.ok(html.includes("photo-" + id), `an existing global hero slide was removed: ${id}`);
  }

  /*
   * A PORTRAIT ORIGINAL NEEDS AN EXPLICIT HEIGHT.
   *
   * photo-1513072064285 is 1200x2133. Asked for `w=1920` alone, Unsplash
   * returns it still portrait, and background-size:cover in a 560px hero then
   * shows a vertical slice — sky, and none of the subject. `h=` makes the crop
   * happen at Unsplash, around the subject, instead of at the viewport edge.
   */
  const haram = (html.match(/haram:\s*'([^']+)'/) || [])[1];
  assert.ok(haram, "the Masjid al-Haram slide is not defined");
  assert.ok(/[?&]w=\d+&h=\d+/.test(haram),
    "the portrait original is requested without a height, so it is cropped to a slice of sky");

  /* All three reach the same CDN the rest of the hero uses — a stray host would
     be blocked outright by the page's connect policy. */
  const pil = (html.match(/const PILGRIMAGE = \{[\s\S]*?\n\};/) || [""])[0];
  const urls = out(pil.match(/'(https:\/\/[^']+)'/g) || []);
  assert.equal(urls.length, 4, "expected four pilgrimage photographs, found " + urls.length);
  assert.ok(urls.every((u) => u.includes("images.unsplash.com")),
    "a pilgrimage slide points somewhere other than the CDN the hero already uses");

  /*
   * MENA HAD NO PHOTOGRAPHY OF ITS OWN and was mapped to the neutral set, so a
   * visitor in Jeddah was shown Santorini. It now has its own.
   */
  assert.ok(/mena:'mena'/.test(html), "MENA is still borrowing the neutral region's pictures");
  assert.ok(/\n  mena:\{/.test(html), "REGIONS has no mena entry to borrow from");
});

test("the Muslim Travel slide leads, and is backed by hotels that exist", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const slide = (html.match(/id: "muslim-travel"[\s\S]*?\n    \},/) || [""])[0];
  assert.ok(slide, "there is no Muslim Travel slide");

  /* The copy, as asked for, and the highest priority so it leads the rail. */
  assert.ok(/title: "Your journey begins in Makkah\."/.test(slide), "the headline is not the one asked for");
  assert.ok(/badge: "MUSLIM TRAVEL"/.test(slide), "the slide is not labelled MUSLIM TRAVEL");
  assert.ok(/ctaLabel: "Explore Muslim Travel"/.test(slide), "the CTA is not the one asked for");
  assert.ok(/priority: 100/.test(slide), "something else outranks the lead slide");
  assert.ok(/image: PILGRIMAGE\.makkah/.test(slide), "the lead slide has no photograph");

  /*
   * THE GATE IS GONE, AND THAT HAD TO BE EARNED.
   *
   * `requiresService: "hajj_umrah"` showed this only where PALTAS runs a
   * pilgrimage service — SA, EG, JO, MA, TR, PK, BD, ID. That was RIGHT while
   * the card said "Planning Hajj or Umrah?", which reads as PALTAS operating
   * the pilgrimage. It now offers hotels in Makkah, which LiteAPI sells to
   * anyone: 48 properties in Makkah and 35 in Madinah, by name, with live
   * rates. Hiding real bookable rooms from a traveller in London because PALTAS
   * runs no Hajj service in the United Kingdom helps nobody.
   */
  assert.ok(!/requiresService/.test(slide),
    "the lead slide is still gated on a service, so most visitors never see it");

  /* "Mecca" returns 0 hotels from the supplier and "Makkah" returns 48. */
  assert.ok(/openStays\("Makkah"\)/.test(slide), "the CTA searches a spelling the supplier does not know");
  assert.ok(!/Mecca/.test(slide), "the slide uses a spelling that returns no hotels");
});

test("a category slide appears only when that category has something in it", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");

  /*
   * A card promising short stays, above a shelf with no short stay on it, is
   * the same lie told twice. Inventory-backed slides are gated on what the
   * marketplace actually loaded; product introductions never are, because
   * "PALTAS runs hotels for you" is true whether or not anybody published a
   * flat today.
   */
  assert.ok(/needsInventory: "hotels"/.test(html), "the Hotels slide is not gated on having hotels");
  for (const cat of ["short", "long", "sale"]) {
    assert.ok(new RegExp(`needsInventory: "${cat}"`).test(html),
      `the ${cat} slide is not gated on having any`);
  }

  /*
   * `null` before the first load is the important state: "we have not looked
   * yet" is not "there is nothing", and treating them the same makes the rail
   * flicker down to a smaller set a second after the page paints.
   */
  assert.ok(/if \(!INVENTORY\) return true;/.test(html),
    "an unanswered marketplace is treated as an empty one, so the rail flickers");
  assert.ok(/if \(!p\.needsInventory\) return true;/.test(html),
    "product introductions are gated on inventory they never claimed to have");

  /* And the marketplace has to actually send the counts. */
  const mod = readFileSync(join(FE, "assets/paltas-market.js"), "utf8");
  assert.ok(/D2\.inventory\(\{/.test(mod), "the marketplace never tells the rail what it found");
  assert.ok(!/title|price/.test((mod.match(/D2\.inventory\(\{[\s\S]*?\}\);/) || [""])[0]),
    "the rail is being sent rows rather than counts");
});

test("no discovery slide invents an opportunity, a return or an asset", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const promos = html.slice(html.indexOf("var PALTAS_PROMOS"), html.indexOf("var PALTAS_APPROVED"));

  /*
   * PALTAS publishes no development to invest in and no tokenised asset to
   * browse — no tokenisation provider is connected by default, so units cannot
   * be issued at all. A promotional card is exactly where an invented number
   * would do the most damage, so there are none.
   */
  const copy = out(promos.match(/(?:title|desc|badge|ctaLabel): "([^"]*)"/g) || []);
  const invented = [];
  if (/\b\d+(\.\d+)?\s*%/.test(copy.join(" "))) invented.push("a percentage appears");
  if (/\b(yield|return on|guaranteed|profit|APY|ROI)\b/i.test(copy.join(" ")))
    invented.push("a financial claim appears");
  /* Read the COPY, not the source around it — the comments beside these slides
     quote the very phrases being banned, to record why they were not used. */
  if (/discover real-world assets/i.test(copy.join(" ")))
    invented.push("tokenisation offers assets to browse, and none can be issued");
  if (/discover real estate opportunit/i.test(copy.join(" ")))
    invented.push("investment offers opportunities to browse, and PALTAS lists none");
  if (/\b(only \d+ left|selling fast|hurry|limited time)\b/i.test(copy.join(" ")))
    invented.push("fake urgency or scarcity appears");
  assert.deepEqual(invented, [], invented.join("; "));

  /* Every CTA must land on a page that exists — there are four. */
  const hrefs = out(promos.match(/ctaHref: "([^"]*)"/g) || [])
    .map((m) => m.replace(/ctaHref: "/, "").replace(/"$/, "").split(/[?#]/)[0])
    .filter(Boolean);
  const pages = new Set(readdirSync(FE).filter((f) => f.endsWith(".html")));
  const dead = hrefs.filter((h) => !pages.has(h));
  assert.deepEqual(dead, [], "a promotion points at a page that does not exist: " + dead.join(" | "));
});

test("every discovery CTA uses the one brand token", { skip }, () => {
  const html = readFileSync(join(FE, "index.html"), "utf8");
  const cta = (html.match(/\.pdisc-cta\{[^}]*\}/) || [""])[0];
  assert.ok(/var\(--mk-accent/.test(cta),
    "the discovery CTA paints itself rather than using the global brand token");
  const hover = (html.match(/\.pdisc-card:hover \.pdisc-cta\{[^}]*\}/) || [""])[0];
  assert.ok(/var\(--mk-deep/.test(hover), "the hover state is not the brand hover");
  /* One turquoise, defined once, at :root. */
  assert.equal((html.match(/--mk-accent:#12C6D4/g) || []).length, 1,
    "the brand turquoise is declared more than once");
});
