/* ====================================================================== *
 * THE MARKET CATALOGUE — ONE IMPLEMENTATION, SERVED.
 *
 * ── WHAT THIS ANSWERS ──────────────────────────────────────────────────
 *
 * Four questions the frontend has always asked and nothing has ever
 * answered, because there was no route behind them:
 *
 *     GET /market/config               which countries exist
 *     GET /payment-methods/available   what may be offered, here, now
 *     GET /localization/config         which languages, and how complete
 *     GET /market/services             what a customer can do in a market
 *
 * ── WHY IT LOADS THE FRONTEND'S MODULE INSTEAD OF RESTATING IT ─────────
 *
 * `contract/market-config.js` is the frontend's market service, copied in
 * beside the other contract artifacts (js43.js, homepage-intake.js) and for
 * the same reason. It already holds 50 countries, 28 payment rails with
 * per-currency ceilings and USD bounds, a fee table, market overrides,
 * capability sets and four language packs — about 1,500 lines of rules that
 * took real decisions to get right.
 *
 * Hand-porting that would produce a SECOND implementation of "is M-Pesa
 * offerable for KES 40,000 in Kenya", and the two would drift. The file
 * itself is blunt about which answer wins:
 *
 *     "The frontend never decides that a payment method is available."
 *
 * So the rule lives once and this serves it. When a provider is switched
 * off, one table changes and both sides change together.
 *
 * ── IT IS A BROWSER FILE, AND THAT IS FINE ─────────────────────────────
 *
 * It is a plain IIFE taking `root`. It touches `location`, `sessionStorage`
 * and `CustomEvent` only for client state — country selection, language
 * choice — none of which a server has or needs. Stubs below satisfy it, the
 * catalogue functions are pure, and nothing it does reaches the network or
 * the filesystem.
 *
 * Loaded ONCE per process, at import. There is no per-request cost.
 * ====================================================================== */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadCatalogue() {
  const file = join(HERE, "..", "..", "contract", "market-config.js");
  const src = readFileSync(file, "utf8");

  /*
   * A browser, as far as this module is concerned, and no more of one than
   * it needs. `hostname: "server"` matters: it is not localhost, so the
   * file's own API-base default resolves to "/api" — which this process
   * never calls, because it IS the thing behind /api. The Api object is
   * simply unused here.
   */
  const root = {
    location: { hostname: "server", origin: "" },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const doc = { documentElement: {}, addEventListener() {} };

  /* Deliberately NOT a real fetch. If some future edit to that file adds a
     call at load time, it fails loudly here rather than making the API
     quietly depend on itself. */
  const noFetch = () => Promise.reject(new Error("market catalogue must not make network calls"));

  new Function("root", "window", "document", "CustomEvent", "sessionStorage", "fetch", src)(
    root, root, doc, class {}, root.sessionStorage, noFetch);

  const MC = root.PALTAS && root.PALTAS.Market;
  if (!MC || typeof MC.countries !== "function") {
    throw new Error("contract/market-config.js did not expose PALTAS.Market — has it been restructured?");
  }
  return MC;
}

const MC = loadCatalogue();

/* ---------------------------------------------------------------- reads */

/** Every country the platform knows, in the shape the frontend already reads. */
export function countries() {
  return MC.countries();
}

/** One country, or null. */
export function country(code) {
  return code ? MC.country(String(code).toUpperCase()) : null;
}

/**
 * WHAT MAY BE OFFERED — the authoritative answer.
 *
 * `amount` is in MINOR UNITS on the wire, like every other amount this API
 * handles, and the catalogue's thresholds are in major units. Converting
 * here rather than at the edge keeps the wire consistent: a caller never has
 * to remember that this one endpoint counts differently.
 *
 * An ineligible method is ABSENT, never present-and-disabled. A greyed-out
 * rail invites a customer to wonder what they did wrong.
 */
export function paymentMethods({ country: code, currency, amount } = {}) {
  const c = country(code);
  if (!c) return [];
  const ctx = { country: c.code };
  if (currency) ctx.currency = String(currency).toUpperCase();
  if (amount !== undefined && amount !== null && amount !== "") {
    const minor = Number(amount);
    if (Number.isFinite(minor)) ctx.amount = minor / 100;
  }
  return MC.availablePaymentMethods(ctx);
}

/** Which languages a market may be shown in, and how complete each pack is. */
export function localization(code) {
  const c = country(code);
  const all = MC.languages();
  return {
    country: c ? c.code : null,
    languages: c ? c.langs.slice() : ["en"],
    available: Object.keys(all),
    directions: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.dir])),
    coverage: MC.coverage(),
    /*
     * `strings` is deliberately absent.
     *
     * The frontend merges this key into its own pack when present, so
     * sending a partial set would silently overwrite complete entries with
     * incomplete ones. Translation has not moved off the client yet; until
     * it does, saying nothing is the correct answer and the frontend keeps
     * what it has.
     */
  };
}

/**
 * WHAT A CUSTOMER CAN DO IN A MARKET.
 *
 * Served at /market/services, NOT /services/available — see the note on the
 * route. Carries products, services, features, compliance requirements and
 * the payment ids, which is everything `capabilitiesOf` computes.
 */
export function services(code) {
  const c = country(code);
  if (!c) return { country: null, services: [], capabilities: null };
  const caps = MC.capabilities(c.code);
  return { country: c.code, services: caps ? caps.services : [], capabilities: caps };
}

/** For the test that proves the catalogue actually loaded. */
export const catalogueSize = () => ({
  countries: MC.countries().length,
  methods: MC.paymentCatalogue().length,
  languages: Object.keys(MC.languages()).length,
});
