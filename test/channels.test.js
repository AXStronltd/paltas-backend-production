/* ====================================================================== *
 * PALTAS CONNECT — THE CHANNEL MANAGER SEAM.
 *
 * No credentials exist for Booking.com, Expedia or Airbnb distribution, and
 * none can be obtained without a signed agreement. So what is tested here is
 * the part that is verifiable without an account — and in this integration
 * that part is almost entirely THE REFUSAL, because the failure this replaces
 * was not a crash. It was a button that reported success.
 *
 * The console's "Sync now" set a local field and raised a toast reading
 * "12 channels synced against tonight's inventory." Nothing was pushed to any
 * channel. An operator who believes an OTA is holding their last four rooms,
 * and stops checking, overbooks — so "says it worked when it did not" is the
 * specific defect these tests exist to keep out.
 *
 * What is NOT covered, and cannot be until somebody holds credentials: that a
 * real channel manager accepts these calls, and that its reservation pull maps
 * onto Reservation as assumed.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ChannelUnavailable, clear, isConnected, manager, notConnected,
  register, status, sync,
} from "../src/domain/channels.ts";

const products = sourceText("routes", "products.js");

test.afterEach(() => clear());

/* ---------------------------------------------------------------- *
 * THE REFUSAL.
 * ---------------------------------------------------------------- */

test("with nothing attached, a sync refuses — it does not report success", async () => {
  clear();
  await assert.rejects(
    () => sync({ id: "c1", name: "Booking.com" }),
    (e) => {
      assert.ok(e instanceof ChannelUnavailable, "must be the typed refusal");
      assert.equal(e.status, 503, "a missing capability is 503, not 500");
      return true;
    },
    "a sync with no channel manager attached must throw, not resolve");
});

test("the refusal reaches the operator instead of becoming a generic 500", () => {
  /*
   * http/errors.js only passes a non-ApiError's message through when it is
   * marked `expose` AND carries a client-safe status. An earlier draft of this
   * class set `expected` instead, and the operator would have been told
   * "Something went wrong at our end" — which is the one thing that is NOT
   * true here. Nothing is wrong; nothing is connected.
   */
  const e = new ChannelUnavailable("no manager");
  assert.equal(e.expose, true, "without `expose` the real message is swallowed");
  assert.equal(e.status, 503);

  /*
   * AND THE HANDLER REALLY DOES PASS IT THROUGH.
   *
   * This used to grep http/errors for `err.expose === true`, which tested the
   * spelling rather than the behaviour — and broke the moment that check moved
   * into a type guard, while doing exactly the same thing. Calling the handler
   * cannot drift like that: it either says "no manager" or it says something
   * went wrong at our end, and only one of those is true here.
   */
  const said = throughHandler(e);
  assert.equal(said.status, 503, "the refusal became a different status");
  assert.equal(said.body.message, "no manager",
    "the operator was told something went wrong at our end — the one thing that " +
    "is NOT true here. Nothing is wrong; nothing is connected.");
  assert.notEqual(said.body.error, "internal", "the refusal was swallowed as a generic 500");

  /* A lookalike without the flag must NOT get through. */
  const sneaky = Object.assign(new Error("internal detail"), { status: 503 });
  assert.equal(throughHandler(sneaky).body.error, "internal",
    "an error that merely has a status talked its way into a response body");
});

/** Run one thrown value through the real error handler and report what a caller sees. */
function throughHandler(err) {
  let status = 0;
  let body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  errorHandler({ error() {} })(err, { method: "GET", originalUrl: "/x" }, res, () => {});
  return { status, body };
}

test("the refusal says what is missing and what it would take to fix", async () => {
  clear();
  const why = await sync({ name: "Expedia" }).then(() => "", (e) => e.message);
  for (const phrase of ["channel manager", "credentials"]) {
    assert.ok(why.toLowerCase().includes(phrase),
      `the refusal should mention "${phrase}" — an operator needs to know it is ` +
      `a commercial gap, not an outage. Got: ${why}`);
  }
});

test("notConnected refuses rather than returning a believable zero", async () => {
  /*
   * Deliberately UNLIKE the supplier seam, whose search() returns no offers and
   * no error. "Nothing is available" is a true answer to "what is available".
   * "Nothing happened" is not an acceptable answer to "sync now" delivered as
   * a success, because the operator cannot tell it apart from a sync that ran.
   */
  await assert.rejects(() => notConnected.sync({ name: "X" }), ChannelUnavailable);
  assert.equal(typeof notConnected.sync, "function");
});

/* ---------------------------------------------------------------- *
 * THE REGISTRY.
 * ---------------------------------------------------------------- */

test("a channel manager must be able to sync, and must be named", () => {
  assert.throws(() => register({}), /sync\(\)/,
    "anything without sync() is not a channel manager");
  assert.throws(() => register({ sync: async () => ({}) }), /name/,
    "an unnamed manager cannot be recorded against the syncs it performs");
});

test("a registered manager is used, and clear() puts it back", async () => {
  assert.equal(isConnected(), false);

  register({
    name: "test-manager",
    async sync() { return { pushed: 12, pulled: 3 }; },
  });
  assert.equal(isConnected(), true);
  assert.equal(manager().name, "test-manager");

  const out = await sync({ name: "Booking.com" });
  assert.equal(out.pushed, 12);
  assert.equal(out.pulled, 3);
  assert.equal(out.manager, "test-manager");
  assert.equal(out.channel, "Booking.com");
  assert.ok(out.at instanceof Date, "a sync must be stamped with when it ran");

  clear();
  assert.equal(isConnected(), false);
  await assert.rejects(() => sync({ name: "Booking.com" }), ChannelUnavailable);
});

test("counts come from the manager, never from the seam", async () => {
  /* A manager that reports nothing must produce zeroes, not plausible ones. */
  register({ name: "quiet", async sync() { return {}; } });
  const out = await sync({ name: "Airbnb" });
  assert.equal(out.pushed, 0);
  assert.equal(out.pulled, 0);
});

/* ---------------------------------------------------------------- *
 * STATUS CARRIES NO SECRET.
 * ---------------------------------------------------------------- */

test("status() reports the gap and never returns a credential", () => {
  clear();
  const s = status();
  assert.equal(s.connected, false);
  assert.ok(s.why.length > 40, "an unconnected status must explain itself");

  register({
    name: "leaky",
    describe: () => ({
      name: "leaky", label: "Leaky", connected: true, capabilities: ["push"],
      /* A describe() that hands back configuration must not widen the shape. */
      apiKey: "sk_live_must_never_travel", secret: "nope",
    }),
    async sync() { return {}; },
  });

  const wire = JSON.stringify(status());
  assert.ok(!wire.includes("sk_live_must_never_travel"),
    "status() passed a credential through to the browser");
  assert.ok(!wire.includes("nope"));
  assert.deepEqual(Object.keys(status()).sort(),
    ["capabilities", "connected", "label", "name", "why"],
    "the status shape grew a field — check it cannot carry a secret");
});

test("status() never throws, whatever the manager does", () => {
  register({
    name: "broken",
    describe() { throw new Error("boom"); },
    async sync() { return {}; },
  });
  const s = status();
  assert.equal(s.connected, false);
  assert.ok(s.why.length > 0, "a broken manager still owes the screen a reason");
});

/* ---------------------------------------------------------------- *
 * THE ROUTES.
 * ---------------------------------------------------------------- */

test("the sync route does not swallow the refusal", () => {
  const route = products.slice(products.indexOf('guarded.post("/channels/:id/sync"'));
  const body = route.slice(0, route.indexOf("\n});"));

  assert.match(body, /await syncChannel\(channel\)/,
    "the route must go through the seam");
  assert.ok(!/catch\s*\(\s*\w*\s*\)\s*\{[^}]*res\.json/.test(body),
    "the route catches the refusal and answers 200 — that is the fake success again");
  assert.ok(body.indexOf("syncChannel") < body.indexOf("db.channel.update"),
    "lastSyncAt must only be written AFTER a sync actually happened");
});

test("a paused channel is not handed inventory", () => {
  const route = products.slice(products.indexOf('guarded.post("/channels/:id/sync"'));
  assert.match(route.slice(0, 900), /status === "PAUSED"/,
    "syncing a paused channel would push rooms it is meant to have stopped selling");
});

test("syncing all channels reports each one, not a single cheerful number", () => {
  const route = products.slice(products.indexOf('guarded.post("/channels/sync"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.match(body, /results\.push\(/,
    "a per-channel result is the whole point — '12 synced' hid twelve outcomes");
  assert.match(body, /ok: false/, "a failed channel must be reported as failed");
  assert.match(body, /status: "ERROR"/, "a channel that refused must not still read LIVE");
});

test("the roll-up counts only stays that happened", () => {
  const route = products.slice(products.indexOf('guarded.get("/connect/rollup"'));
  const body = route.slice(0, route.indexOf("\n});"));

  assert.match(body, /CANCELLED/, "a cancelled stay would overstate channel revenue");
  assert.match(body, /NO_SHOW/, "a no-show earns the channel no commission");
  assert.match(body, /by: \["channelId"\]/,
    "the roll-up must group by the foreign key, not by matching `source` text");
  assert.match(body, /unattributed/,
    "reservations with no channel must be reported, not spread across channels");
  assert.ok(!/source:/.test(body),
    "grouping by the free-text `source` is the inference channelId replaces");
});

test("commission is taken from the integer, in minor units", () => {
  const route = products.slice(products.indexOf('guarded.get("/connect/rollup"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.match(body, /10_000/,
    "basis points are ten-thousandths: revenue * bps / 10000, not / 100");
  assert.match(body, /revenueMinor/, "the wire must say the unit it is in");
  assert.ok(!/\/ 100\b/.test(body),
    "dividing for display inside the roll-up loses the integer the commission needs");
});

test("a reservation can only be attributed to a channel of the same company", () => {
  const registry = sourceText("domain", "registry.js");
  const res = registry.slice(registry.indexOf("reservations: {"));
  assert.match(res.slice(0, res.indexOf("\n  },")), /channelId: "id:channel"/,
    'channelId must be declared `id:channel` — a plain "string" would let a ' +
    "request attach a reservation to another company's channel by guessing an id");
});

/* ====================================================================== *
 * THE CONSOLE SIDE.
 *
 * Same frontend location rule as frontend-contract.test.js: beside this repo,
 * or PALTAS_FRONTEND. Skips rather than fails when it is not there.
 * ====================================================================== */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.ts";
import { errorHandler } from "../src/http/errors.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const hasFE = existsSync(resolve(FE, "assets/console.js"));
const why = hasFE ? undefined : `no frontend at ${FE}`;

const read = (f) => readFileSync(resolve(FE, f), "utf8");

test("the console no longer fakes a sync", { skip: why }, () => {
  const console_ = read("assets/console.js");
  const from = console_.indexOf("ACTIONS.syncChannel");
  const to = console_.indexOf("ACTIONS.toggleRule");
  assert.ok(from > 0 && to > from, "the sync actions moved — re-point this test");
  const actions = console_.slice(from, to);

  assert.ok(!/c\.sync = "just now"/.test(actions),
    'the action still writes `sync = "just now"` locally. That is the fake ' +
    "success: the row reads as synced when nothing left the browser.");
  assert.match(actions, /D\.request\(/,
    "a sync must ask the server — a local mutation is not an integration");
  assert.match(actions, /\/channels\/\$\{encodeURIComponent\(c\.id\)\}\/sync/,
    "the single-channel sync must address the channel by id");
  assert.match(actions, /"\/channels\/sync"/, "sync-all must call the batch endpoint");
});

test("a failed sync is shown to the operator, not swallowed", { skip: why }, () => {
  const console_ = read("assets/console.js");
  const actions = console_.slice(
    console_.indexOf("ACTIONS.syncChannel"), console_.indexOf("ACTIONS.toggleRule"));

  assert.match(actions, /catch \(e\) \{[\s\S]*?toast\([\s\S]*?"warn"\)/,
    "a refusal must reach the screen as a warning toast");
  assert.match(actions, /e && e\.message/,
    "the server's reason must be printed rather than replaced with a friendlier one");
  /*
   * The property that matters is ORDER, not proximity: the success toast must
   * sit after the awaited request, so it cannot fire for a call that threw.
   * An earlier version of this test matched on how close the toast was to the
   * `catch`, which is a fact about formatting and said nothing about when the
   * toast runs.
   */
  const one = actions.slice(0, actions.indexOf("ACTIONS.syncAll"));
  assert.ok(one.indexOf("await D.request(") < one.indexOf("synced —"),
    "the success toast is raised before the request is awaited, so it fires " +
    "whatever the server answers");
});

test("sync-all names the channels that failed", { skip: why }, () => {
  const console_ = read("assets/console.js");
  const actions = console_.slice(
    console_.indexOf("ACTIONS.syncAll"), console_.indexOf("ACTIONS.toggleRule"));
  assert.match(actions, /failed\.map\(/,
    '"12 channels synced" flattened twelve outcomes — the failures must be named');
});

test("the channels screen invents no figures", { skip: why }, () => {
  const console_ = read("assets/console.js");
  const from = console_.indexOf("SCREENS.h_channels");
  const screen = console_.slice(from, console_.indexOf("SCREENS.", from + 10));

  assert.ok(!/d:"\+14%"/.test(screen),
    "the reservations KPI carried a hard-coded +14% delta next to a real count");
  assert.ok(!/d:"[+−-][\d.]+%"/.test(screen),
    "a KPI in this screen still carries a hard-coded percentage delta");
  assert.match(screen, /x\.commission \|\| 0/,
    "commission must come from the server, which has the integer minor units");
  assert.ok(!/Math\.round\(\(x\.rev \* x\.comm\) \/ 100\)/.test(screen),
    "recomputing commission from rounded major units disagreed with the server");
});

test("the channels adapter reads the roll-up, and zero is no longer a literal",
  { skip: why }, () => {
    const hyd = read("assets/paltas-hydrate.js");
    const from = hyd.indexOf("CHANNELS: {");
    const entry = hyd.slice(from, hyd.indexOf("RATE_RULES:", from));

    assert.match(entry, /path: "\/connect\/rollup"/,
      "the channels screen needs the roll-up, which the resource endpoint cannot give");
    assert.match(entry, /key: "channels"/, "the envelope key must be named");
    assert.ok(!/res: 0, rev: 0/.test(entry),
      "reservations and revenue are hard-coded to zero again");
    assert.match(entry, /res: r\.reservations/, "reservations must come from the API");
    assert.match(entry, /rev: major\(r\.revenueMinor\)/,
      "revenue arrives in minor units and the console formats major — it must be converted");
    assert.match(entry, /id: r\.id/,
      "without the id the sync action cannot address the channel");
  });
