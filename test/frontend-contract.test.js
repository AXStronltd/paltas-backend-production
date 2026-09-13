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
