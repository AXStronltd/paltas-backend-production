/* ====================================================================== *
 * THE TWO COPIES OF THE MARKET CATALOGUE MUST AGREE.
 *
 * `src/domain/market.js` does not reimplement the market rules — it LOADS
 * the frontend's own module from `contract/market-config.js` and serves it.
 * Its header states the reason plainly:
 *
 *     "So the rule lives once and this serves it. When a provider is
 *      switched off, one table changes and both sides change together."
 *
 * That sentence was true of the design and false of the repository. The
 * contract copy is a COPY, made by hand, and nothing anywhere noticed when
 * it fell behind. It had: the frontend's file was ten kilobytes further on,
 * and the two had been out of step across several commits.
 *
 * ── WHY THIS COMPARES ANSWERS, NOT BYTES ───────────────────────────────
 *
 * A byte-for-byte check would have failed on all of that drift, and all of
 * it was harmless: an IANA timezone table, the /kenya URL-slug layer, and a
 * path rename inside the client's own `Api` object. None of it is reachable
 * from this service — the server stubs `location`, has no `history`, and
 * never calls its own Api. A test that cries drift over code the server
 * cannot execute is a test people learn to re-run and ignore.
 *
 * What matters is narrower and much more serious: THE ANSWERS THIS SERVICE
 * SERVES MUST BE THE ANSWERS THE BROWSER WOULD HAVE COMPUTED. A customer in
 * Nairobi being offered M-Pesa by the page and refused it by the API is the
 * failure this prevents — and the same drift in the fee table is a price
 * shown that is not the price charged.
 *
 * So both modules are loaded, side by side, and asked the same questions:
 * every country, every rail, every fee, every capability, every language.
 * The frontend is the author of these rules; where they differ, this
 * service is the one that is stale, and the fix is to re-copy the file.
 *
 * WHERE IS THE FRONTEND? Set PALTAS_FRONTEND, or keep it beside this repo
 * as `../paltas-frontend 2` — the same convention frontend-contract.test.js
 * uses. When it is not there this skips: a backend checkout on its own is
 * not a backend that has drifted.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Wire } from "./wire.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");

const FE_FILE = join(FE, "assets", "market-config.js");

const skip = existsSync(FE_FILE)
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/**
 * The frontend's module, under the same minimal browser this service gives
 * it in `src/domain/market.js` — deliberately the same shape, so that a file
 * which loads there loads here and a file which breaks breaks in both.
 *
 * `hostname: "server"` matters for the same reason it does there: it is not
 * localhost, so the file's own API-base default resolves to "/api" rather
 * than "", which is the branch the deployed browser takes too.
 */
function loadFrontendCatalogue() {
  const src = readFileSync(FE_FILE, "utf8");

  const root = {
    location: { hostname: "server", origin: "", pathname: "/" },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const doc = { documentElement: {}, addEventListener() {} };

  /* A catalogue that reaches the network at load time is a catalogue this
     service would quietly depend on itself for. Fail loudly instead. */
  const noFetch = () => Promise.reject(new Error("market catalogue must not make network calls"));

  new Function("root", "window", "document", "CustomEvent", "sessionStorage", "fetch", src)(
    root, root, doc, class {}, root.sessionStorage, noFetch);

  const MC = root.PALTAS && root.PALTAS.Market;
  assert.ok(MC && typeof MC.countries === "function",
    "the frontend's market-config.js did not expose PALTAS.Market — has it been restructured?");
  return MC;
}

/* Both sides, loaded once. */
const FRONTEND = skip ? null : loadFrontendCatalogue();
const SERVER = skip ? null : await import("../src/domain/market.ts");

/** The instruction that is always the same, so it is written once. */
const REMEDY =
  "\n\n  contract/market-config.js is a copy of the frontend's " +
  "assets/market-config.js and has fallen behind it.\n" +
  "  Re-copy it:\n\n" +
  "      cp \"$PALTAS_FRONTEND/assets/market-config.js\" contract/market-config.js\n";

test("every country the browser knows, this service knows too", { skip }, () => {
  const mine = SERVER.countries().map((c) => c.code).sort();
  const theirs = FRONTEND.countries().map((c: Wire) => c.code).sort();

  const missing = theirs.filter((c: Wire) => !mine.includes(c));
  const extra = mine.filter((c) => !theirs.includes(c));

  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    `the two catalogues list different countries. ` +
    `This service is missing [${missing}] and serves [${extra}] that the browser does not.` + REMEDY);
});

test("a country's money, language and region read the same on both sides", { skip }, () => {
  const theirs = FRONTEND.countries();

  /*
   * The fields a wrong answer is actually expensive in. `perUsd` and `base`
   * are here because they are what a price is CONVERTED with — a stale rate
   * is a number shown to a customer that is not the number charged, and it
   * is the one kind of drift that looks completely normal on screen.
   */
  const FIELDS = ["code", "name", "currency", "locale", "region", "dial", "perUsd", "base"];

  for (const t of theirs) {
    const m = SERVER.country(t.code);
    assert.ok(m, `this service does not know ${t.code}` + REMEDY);
    for (const f of FIELDS) {
      assert.deepEqual(m[f], t[f],
        `${t.code}.${f} differs: this service says ${JSON.stringify(m[f])}, ` +
        `the browser says ${JSON.stringify(t[f])}.` + REMEDY);
    }
    assert.deepEqual(m.langs, t.langs,
      `${t.code} is shown in different languages by each side.` + REMEDY);
  }
});

test("the same payment rails are offered, market by market", { skip }, () => {
  /*
   * THE TEST THIS FILE EXISTS FOR.
   *
   * Asked without an amount, so it compares which rails a market HAS rather
   * than which survive one particular basket — the eligibility arithmetic is
   * the same code on both sides, and it is the tables underneath it that
   * drift.
   */
  for (const c of FRONTEND.countries()) {
    const theirs = FRONTEND.availablePaymentMethods({ country: c.code });
    const mine = SERVER.paymentMethods({ country: c.code });

    assert.deepEqual(
      mine.map((m) => m.id).sort(),
      theirs.map((m: Wire) => m.id).sort(),
      `${c.code} (${c.name}) is offered different payment methods by each side. ` +
      `This service: [${mine.map((m) => m.id).sort()}]. ` +
      `The browser: [${ theirs.map((m: Wire) => m.id).sort() }: { theirs.map((m: Wire)?: Wire }].` + REMEDY);
  }
});

test("a rail costs the same on both sides", { skip }, () => {
  /*
   * A fee that differs is a price quoted that is not the price taken. It
   * cannot be seen on screen and it reconciles wrong at the end of the month,
   * which is the worst combination a defect can have.
   */
  for (const c of FRONTEND.countries()) {
    const theirs = FRONTEND.availablePaymentMethods({ country: c.code });
    const mine = SERVER.paymentMethods({ country: c.code });
    const byId = new Map(mine.map((m) => [m.id, m]));

    for (const t of theirs) {
      const m = byId.get(t.id);
      if (!m) continue;   /* already reported by the test above */
      for (const f of ["feePct", "feeFlat", "feeFlatCurrency", "feeLabel", "currency", "provider", "type"]) {
        assert.deepEqual(m[f], t[f],
          `${c.code}/${t.id}.${f} differs: this service says ${JSON.stringify(m[f])}, ` +
          `the browser says ${JSON.stringify(t[f])}.` + REMEDY);
      }
    }
  }
});

test("a market's capabilities are the same on both sides", { skip }, () => {
  for (const c of FRONTEND.countries()) {
    const theirs = FRONTEND.capabilities(c.code);
    const mine = SERVER.services(c.code);

    assert.deepEqual(mine.services.slice().sort(), (theirs.services || []).slice().sort(),
      `${c.code} can do different things on each side.` + REMEDY);

    for (const f of ["products", "features"]) {
      assert.deepEqual(
        (mine.capabilities[f] || []).slice().sort(),
        (theirs[f] || []).slice().sort(),
        `${c.code}.${f} differs between the two sides.` + REMEDY);
    }
  }
});

test("the language packs and their coverage match", { skip }, () => {
  const theirs = FRONTEND.languages();
  const mine = SERVER.localization(null);

  assert.deepEqual(mine.available.slice().sort(), Object.keys(theirs).sort(),
    `the two sides ship different languages.` + REMEDY);

  /*
   * Coverage is a PERCENTAGE OF A PACK THAT IS TRANSLATED, and the frontend
   * shows it. Serving a number computed from a different pack tells a
   * customer a language is more finished than it is.
   */
  assert.deepEqual(mine.coverage, FRONTEND.coverage(),
    `the two sides disagree about how complete the translations are.` + REMEDY);

  for (const c of FRONTEND.countries()) {
    assert.deepEqual(SERVER.localization(c.code).languages, c.langs,
      `${c.code} is offered different languages by each side.` + REMEDY);
  }
});

/* ====================================================================== *
 * AND THE FILE ITSELF.
 *
 * The tests above compare what the two sides ANSWER, which is what matters
 * and is where the value is. This last one compares the bytes — not to fail
 * the build over a comment, but because when one of the above does fail, the
 * first question is always "how far behind is the copy?" and this answers it
 * in the same run.
 *
 * It is deliberately a DIAGNOSTIC and not an assertion: client-only code
 * legitimately diverges, and the answer tests are the ones that decide.
 * ====================================================================== */
test("how far behind the contract copy is, for the record", { skip }, () => {
  const mineSrc = readFileSync(join(process.cwd(), "contract", "market-config.js"), "utf8");
  const theirsSrc = readFileSync(FE_FILE, "utf8");

  if (mineSrc === theirsSrc) {
    console.log("\n  contract/market-config.js is byte-identical to the frontend's.\n");
    return;
  }

  const d = theirsSrc.length - mineSrc.length;
  console.log(
    `\n  NOTE: contract/market-config.js is not byte-identical to the frontend's ` +
    `(${d > 0 ? "+" : ""}${d} bytes).\n` +
    `  Every answer above still matches, so nothing this service SERVES has drifted.\n` +
    `  Re-copy the file to clear this notice.\n`);
});
