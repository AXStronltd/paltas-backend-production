/* ====================================================================== *
 * THE CONSOLE'S SESSION MUST MATCH THE SERVER'S.
 *
 * There were two session systems in this build that had never been introduced:
 * the real one (an httpOnly cookie, readable only by asking GET /auth/session)
 * and console.js's own PALTAS.Session in sessionStorage, whose `write` had no
 * caller anywhere. paintShell() asked the console's copy, got null, and fell
 * through to the sample identity — so every dashboard greeted a real signed-in
 * person as "Alma Real Estate / Group Managing Director".
 *
 * assets/paltas-session-bridge.js is the missing write. What is tested here is
 * the CONTRACT it sits on, because both ends of it are easy to break quietly:
 *
 *   the server's session view, which supplies the shape
 *   console.js's products()/role(), which consume it
 *
 * The entitlement shape is the sharp edge. products() skips anything whose
 * status is not "ACTIVE" and looks the product up by `.product` — so a bridge
 * that flattens entitlements to strings opens NO product for ANYBODY, on every
 * dashboard, with no error anywhere.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const BRIDGE = join(FE, "assets/paltas-session-bridge.js");
const skip = existsSync(BRIDGE) ? undefined : `no frontend at ${FE}`;

/** Load the bridge with just enough of a window for it to attach. */
function loadBridge({ session, blank }) {
  const win = {
    PALTAS: {
      Data: {
        configured: () => true,
        Session: { read: () => Promise.resolve(session) },
      },
      Session: { blank, write: (s) => { win.__written = s; return s; } },
    },
    console: { error() {} },
  };
  const src = readFileSync(BRIDGE, "utf8");
  new Function("window", src + "\n;(function(){ }());")(win);
  return win;
}

/* console.js's blank(), copied here so the test states the shape it relies on
   rather than importing 1MB of console to get it. */
const blank = () => ({
  v: 4, signedIn: false,
  user: { id: "", name: "", email: "", phone: "" },
  organization: { id: "", name: "", country: "ke", city: "", size: "", status: "ACTIVE" },
  subscription: { status: "TRIALING", plan: "", planKey: "", trialDays: 30, seats: 1 },
  entitlements: [], verification: { status: "NOT_STARTED", documents: [] },
  memberships: [], workspace: { status: "ACTIVE", preferred: "" }, consumer: false,
});

/* Exactly what src/domain/session-view.js returns for an estate agent. */
const AGENT_VIEW = {
  signedIn: true,
  user: { id: "u1", name: "Ahmed Akboole", email: "a@example.com", phone: "" },
  organization: { id: "o1", name: "Alma Real Estate", country: "ke", city: "Nairobi", size: "1-10", status: "ACTIVE" },
  subscription: { status: "TRIALING", plan: "", planKey: "", trialDays: 30, seats: 1 },
  entitlements: [{ product: "AGENT_HOST", status: "ACTIVE", since: "2026-09-16" }],
  memberships: [{ organization: "o1", organizationName: "Alma Real Estate", role: "OWNER", scope: { all: true } }],
  verification: { status: "COMPLETE", documents: [] },
  workspace: { status: "ACTIVE", preferred: "AGENT_HOST" },
  consumer: false,
};

/* And for somebody who signed in a minute ago and has no company yet. */
const NO_COMPANY_VIEW = {
  signedIn: true,
  user: { id: "u2", name: "New Person", email: "new@example.com", phone: "" },
  organization: null,
  subscription: null,
  entitlements: [],
  memberships: [],
  verification: { status: "NOT_STARTED", documents: [] },
  workspace: { status: "ACTIVE", preferred: "" },
  consumer: true,
};

test("entitlements reach the console in the shape products() reads", { skip }, () => {
  const win = loadBridge({ session: AGENT_VIEW, blank });
  const s = win.PALTAS.SessionBridge.map(AGENT_VIEW);

  assert.ok(Array.isArray(s.entitlements));
  assert.equal(s.entitlements.length, 1);
  /*
   * OBJECTS, NOT STRINGS. console.js:
   *     if (e.status !== "ACTIVE") continue;
   *     var pr = PRODUCTS[e.product];
   * A string fails both lines, silently, for every product on every dashboard.
   */
  assert.equal(typeof s.entitlements[0], "object",
    "entitlements were flattened — no product will open for anyone");
  assert.equal(s.entitlements[0].product, "AGENT_HOST");
  assert.equal(s.entitlements[0].status, "ACTIVE");
});

test("an entitlement that is not ACTIVE does not open a product", { skip }, () => {
  const view = {
    ...AGENT_VIEW,
    entitlements: [
      { product: "AGENT_HOST", status: "ACTIVE", since: "x" },
      { product: "HOTEL_MANAGEMENT", status: "SUSPENDED", since: "x" },
    ],
  };
  const win = loadBridge({ session: view, blank });
  const s = win.PALTAS.SessionBridge.map(view);
  assert.deepEqual(s.entitlements.map((e) => e.product), ["AGENT_HOST"],
    "a suspended entitlement would open a product the company cannot use");
});

test("the real identity replaces the sample one", { skip }, () => {
  const win = loadBridge({ session: AGENT_VIEW, blank });
  const s = win.PALTAS.SessionBridge.map(AGENT_VIEW);

  assert.equal(s.signedIn, true);
  assert.equal(s.user.name, "Ahmed Akboole");
  assert.equal(s.user.email, "a@example.com");
  assert.equal(s.organization.name, "Alma Real Estate");
  assert.equal(s.organization.city, "Nairobi");
});

test("role survives, because it decides what opens", { skip }, () => {
  const win = loadBridge({ session: AGENT_VIEW, blank });
  const s = win.PALTAS.SessionBridge.map(AGENT_VIEW);
  /* console.js: role(s) reads s.memberships[0].role and looks it up in ROLES. */
  assert.equal(s.memberships[0].role, "OWNER",
    "memberships were reshaped — role() falls back to OWNER for everyone");
});

test("signed in with no company never yields a company", { skip }, () => {
  const win = loadBridge({ session: NO_COMPANY_VIEW, blank });
  const s = win.PALTAS.SessionBridge.map(NO_COMPANY_VIEW);

  assert.equal(s.signedIn, true);
  assert.equal(s.user.name, "New Person");
  /*
   * The server sends organization: null. blank() carries an empty OBJECT
   * rather than null, which is what stops console.js's
   *     LIVE.organization.name
   * from throwing. The object must survive, and it must stay empty.
   */
  assert.equal(typeof s.organization, "object");
  assert.notEqual(s.organization, null,
    "a null organization throws in paintShell() on LIVE.organization.name");
  assert.equal(s.organization.name, "",
    "somebody with no company was given one — the bug this file exists to end");
  assert.ok(!/Alma|Marina|Sample/.test(JSON.stringify(s)),
    "sample data leaked into a real person's session");
  assert.deepEqual(s.entitlements, []);
});

test("the bridge writes and repaints once the session arrives", { skip }, async () => {
  let painted = 0;
  const win = loadBridge({ session: AGENT_VIEW, blank });
  win.render = () => { painted++; };

  /* The bridge fires its own read() on load; give the promise a turn. */
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(win.__written, "the session was never written — paintShell still reads null");
  assert.equal(win.__written.organization.name, "Alma Real Estate");
});

test("a signed-out visitor is left alone", { skip }, async () => {
  const win = loadBridge({ session: { signedIn: false }, blank });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(win.__written, undefined,
    "a signed-out visitor had a session written for them");
});

test("the bridge is on every dashboard, after console.js", { skip }, () => {
  const pages = ["admin", "agent", "guest", "hotel", "index", "property", "security"];
  for (const p of pages) {
    const html = readFileSync(join(FE, `dashboard/${p}.html`), "utf8");
    const bridge = html.indexOf("paltas-session-bridge.js");
    const console_ = html.indexOf("assets/console.js");
    assert.ok(bridge > 0, `${p}.html does not load the session bridge`);
    assert.ok(bridge > console_,
      `${p}.html loads the bridge before console.js, so PALTAS.Session does not exist yet`);
  }
});

test("no dashboard ships a company name in its HTML", { skip }, () => {
  /*
   * The shell used to be served with "Alma Real Estate / Ahmed Akboole /
   * Group Managing Director" written into it. paintShell() overwrites those
   * from the session — but only once the session arrives, and only if it
   * arrives. Until then, and forever if the API is unreachable, a real visitor
   * was being shown a company that is not theirs and told it is.
   *
   * A brand word is fine. A company, a person and a job title are not.
   */
  for (const p of ["admin", "agent", "guest", "hotel", "index", "property", "security"]) {
    const html = readFileSync(join(FE, `dashboard/${p}.html`), "utf8");
    const shell = (id) => (html.match(new RegExp(`id="${id}">([^<]*)<`)) || [, ""])[1];

    assert.equal(shell("bname"), "PALTAS", `${p}.html names a company before it knows one`);
    assert.equal(shell("uname"), "", `${p}.html names a person before it knows one`);
    assert.equal(shell("urole"), "", `${p}.html gives a job title before it knows one`);
    assert.equal(shell("bsub"), "", `${p}.html states a line of business before it knows one`);

    for (const ghost of ["Alma Real Estate", "Marina Vista", "Ahmed Akboole", "Esther Mumbi", "Layla Hassan"]) {
      assert.ok(!html.includes(ghost),
        `${p}.html still ships "${ghost}" in its markup`);
    }
  }
});

/* ====================================================================== *
 * A CONSOLE THAT IS NOT YOURS.
 *
 * Every console page declares what it is in PALTAS_BOOT.system, and nothing
 * checked it against what the company holds. Opening /dashboard/property.html
 * with only Agent & Host rendered the property console in full, then every
 * hydrate call came back 403 and every screen drew empty — which reads as a
 * broken product rather than somebody else's product.
 * ====================================================================== */

const HELD = (products) => ({
  signedIn: true,
  user: { id: "u1", name: "A", email: "a@example.com", phone: "" },
  organization: { id: "o1", name: "Kabole LTD", country: "ke", city: "", size: "", status: "ACTIVE" },
  subscription: { status: "TRIALING", plan: "", planKey: "", trialDays: 30, seats: 1 },
  entitlements: products.map((p) => ({ product: p, status: "ACTIVE", since: "x" })),
  memberships: [{ organization: "o1", organizationName: "Kabole LTD", role: "OWNER", scope: { all: true } }],
  verification: { status: "NOT_STARTED", documents: [] },
  workspace: { status: "ACTIVE", preferred: products[0] || "" },
  consumer: false,
});

/** The bridge, with just enough console.Session to exercise the gate. */
function gateRig({ page, system, products, openKeys, search }) {
  let replaced = null;
  const session = HELD(products);
  const win = {
    PALTAS_BOOT: { system },
    location: { pathname: `/dashboard/${page}`, search: search || "", replace: (u) => { replaced = u; } },
    history: { replaceState() {} },
    toast: (msg, tone) => { win.__toast = { msg, tone }; },
    PALTAS: {
      Data: { configured: () => true, Session: { read: () => Promise.resolve(session) } },
      Session: {
        blank, write: (s) => { win.__written = s; return s; }, read: () => win.__written,
        /*
         * SHAPED LIKE THE REAL PRODUCTS TABLE, because the first version of
         * this rig returned { key: "agent" } and the gate compared that to
         * PALTAS_BOOT.system. It matched, the test passed — and the real
         * console returns key: "AGENT_HOST" with legacy: "agent", so the gate
         * never matched in production and redirected companies away from
         * their own dashboards. A rig that agrees with the assumption instead
         * of the data is worse than no rig.
         */
        openable: () => openKeys.map((k) => ({
          key: k.toUpperCase() === "AGENT" ? "AGENT_HOST" : k.toUpperCase() + "_MANAGEMENT",
          legacy: k,
          home: "dashboard/" + k + ".html",
        })),
        destination: (_s, base) => (base || "") + "dashboard/" + openKeys[0] + ".html",
      },
    },
    console: { error() {} },
  };
  const src = readFileSync(BRIDGE, "utf8");
  new Function("window", src)(win);
  return { win, went: () => replaced };
}

test("a console the company does not hold sends them to one it does", { skip }, async () => {
  const { went } = gateRig({
    page: "property.html", system: "property",
    products: ["AGENT_HOST"], openKeys: ["agent"],
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.match(String(went()), /agent\.html\?need=property$/,
    "an agent-only company opening the property console was left on an empty page, " +
    "or was bounced without the reason travelling with them");
});

test("a console the company does hold is left alone", { skip }, async () => {
  const { went } = gateRig({
    page: "agent.html", system: "agent",
    products: ["AGENT_HOST"], openKeys: ["agent"],
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(went(), null, "the company was redirected away from its own console");
});

test("the gate never redirects a page to itself", { skip }, async () => {
  /*
   * destination() can resolve to the page already being viewed — a company
   * whose only product IS this one, reached by a path that does not match
   * what openable() reports. A redirect to where you already are is an
   * infinite reload, which is worse than the empty screen it replaced.
   */
  const { went } = gateRig({
    page: "agent.html", system: "property",
    products: ["AGENT_HOST"], openKeys: ["agent"],
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(went(), null, "the gate redirected agent.html to agent.html");
});

test("the guest portal and the staff console are not gated", { skip }, async () => {
  for (const system of ["guest", "platform"]) {
    const { went } = gateRig({
      page: `${system}.html`, system,
      products: ["AGENT_HOST"], openKeys: ["agent"],
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(went(), null, `${system} was gated by a product entitlement it does not use`);
  }
});

test("the console that receives them says why they are there", { skip }, async () => {
  const { win } = gateRig({
    page: "agent.html", system: "agent", products: ["AGENT_HOST"],
    openKeys: ["agent"], search: "?need=property",
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(win.__toast, "they arrived with no account of why they were moved");
  assert.match(win.__toast.msg, /Property Management/,
    "the message does not name the product they asked for");
  assert.equal(win.__toast.tone, "warn");
});

test("an ordinary visit explains nothing", { skip }, async () => {
  const { win } = gateRig({
    page: "agent.html", system: "agent", products: ["AGENT_HOST"], openKeys: ["agent"],
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(win.__toast, undefined,
    "every load of the console now raises a message about a redirect that did not happen");
});

test("the gate matches the console's own product table, not the boot name", { skip }, () => {
  /*
   * PALTAS_BOOT.system is "property". PRODUCTS keys are "PROPERTY_MANAGEMENT".
   * Comparing those two is always false, which is what made the gate redirect
   * a company away from the console it had just been given.
   *
   * Asserted against the source so the rig above cannot drift from it again.
   */
  const bridge = readFileSync(BRIDGE, "utf8");
  assert.match(bridge, /p\.legacy === boot\.system/,
    "the gate no longer matches on PRODUCTS.legacy, which is the field that " +
    "carries the boot name");
  assert.ok(!/p\.key === boot\.system/.test(bridge),
    "the gate compares PRODUCTS.key to the boot system again; those never match");

  const console_ = readFileSync(join(FE, "assets/console.js"), "utf8");
  for (const [code, legacy] of [["PROPERTY_MANAGEMENT", "property"], ["AGENT_HOST", "agent"],
                                ["HOTEL_MANAGEMENT", "hotel"], ["SECURITY_MANAGEMENT", "security"]]) {
    const at = console_.indexOf(code + ": {");
    assert.ok(at > 0, `${code} is not in PRODUCTS`);
    assert.match(console_.slice(at, at + 200), new RegExp(`legacy: "${legacy}"`),
      `${code} no longer carries legacy: "${legacy}", which the gate matches on`);
  }
});

test("a real company's demo security estate is emptied", { skip }, () => {
  /*
   * console.js seeds EVENTS, GATES and DEVICES with a demonstration estate and
   * decides whether to by reading its own sessionStorage copy — which, on the
   * first load after signing in, this bridge has not written yet. The seed
   * wins that race, so the security command centre reported a demonstration
   * estate's people as inside the customer's property.
   */
  const bridge = readFileSync(BRIDGE, "utf8");
  const console_ = readFileSync(join(FE, "assets/console.js"), "utf8");

  assert.match(bridge, /dropDemoSecurity\(live\);/, "the bridge no longer clears the demo estate");
  assert.match(bridge, /root\.PALTAS_DROP_DEMO_SECURITY\(\)/, "it does not call the hook");
  assert.match(console_, /window\.PALTAS_DROP_DEMO_SECURITY = function/,
    "console.js no longer exposes the hook — EVENTS, GATES and DEVICES are " +
    "top-level consts and cannot be reached from the bridge without it");
  assert.match(console_, /if \(!\(_live && _live\.signedIn && _live\.organization/,
    "seedSecurity() runs unconditionally again");
});
