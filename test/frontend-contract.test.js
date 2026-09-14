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
  const missing = TITLES.filter((t) => !html.includes(t));
  assert.deepEqual(missing, [], "these marketplace sections are not on the homepage: " +
    missing.join(" | "));

  assert.equal((html.match(/class="mk-sec"/g) || []).length, 9,
    "the homepage should draw exactly nine marketplace sections");
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

test("with nothing published, every section says why rather than shrugging", { skip }, async () => {
  const html = await rendered(marketplaceHome([]));

  const empties = (html.match(/class="mk-empty"/g) || []).length;
  assert.equal(empties, 8,
    "eight of the nine sections show listings, so with none published all eight " +
    "should show an empty state — found " + empties);

  assert.ok(!/class="mk-card"/.test(html.replace(/class="mk-card mk-prod"/g, "")),
    "a property card was drawn while the API returned no listings at all");

  /*
   * And each reason must be its own. Eight copies of one sentence tells a
   * visitor nothing about which part of PALTAS is empty and which is broken.
   */
  const reasons = out(html.match(/class="mk-empty"[\s\S]*?<p>([\s\S]*?)<\/p>/g) || [])
    .map((b) => (b.match(/<p>([\s\S]*?)<\/p>/) || [])[1]);
  assert.equal(new Set(reasons).size, reasons.length,
    "two sections give the same empty-state reason:\n  " + reasons.join("\n  "));
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
  for (const label of ["All", "Hotels", "Short stays", "Long stays", "Buy / Sell",
                       "Developments", "Airport transfer", "Pickup available",
                       "Drop-off available", "Free transfer", "Paid transfer"]) {
    assert.ok(html.includes(label), `the "${label}" filter chip is gone from the marketplace`);
  }

  for (const gone of ["Pickup available", "Drop-off available"]) {
    const chip = (html.match(new RegExp('<button[^>]*>' + gone + '</button>')) || [])[0] || "";
    assert.ok(/disabled/.test(chip) && /aria-disabled="true"/.test(chip),
      `"${gone}" is an active filter again, but nothing in the schema records ` +
      `transfer direction — so it can only be filtering on something invented. ` +
      `Chip: ${chip || "not found as a button"}`);
  }

  assert.ok(/mk-filter-note/.test(html),
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
