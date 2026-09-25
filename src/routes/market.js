/* ====================================================================== *
 * THE PLATFORM CATALOGUE, OVER HTTP.
 *
 * Four questions that are true of the PLATFORM, not of any one customer:
 * which countries exist, what may be charged in them, which languages they
 * read, what a person can do there. Every other route in this service is
 * scoped to one organization; these four are scoped to nobody.
 *
 * ── WHY THEY ARE PUBLIC ────────────────────────────────────────────────
 *
 * A visitor chooses a country and sees prices before they have an account,
 * and a checkout has to know which rails exist before anybody signs in. An
 * authenticated catalogue would mean no price could be shown on the
 * marketplace at all. Nothing here is tenant data and nothing here is a
 * secret — it is the same table the frontend already ships.
 *
 * ── WHY THEY MUST MOUNT BEFORE productRoutes ───────────────────────────
 *
 * `routes/products.js` does `productRoutes.use(guarded)` with NO path, and
 * server.js mounts it at "/". So anything reaching that line gets
 * requireSession() and a 401 — including paths nobody ever registered. That
 * is why these four answered 401 before they existed, instead of 404.
 *
 * Registered after it, they would be unreachable and the failure would look
 * like an auth problem. server.js mounts this router above it, and
 * test/market-api.test.js fails if the order is ever reversed.
 * ====================================================================== */

import { Router } from "express";
import { countries, localization, paymentMethods, services } from "../domain/market.ts";
import { badRequest } from "../http/errors.ts";

export const marketRoutes = Router();

/*
 * A CATALOGUE IS CACHEABLE AND SHOULD SAY SO.
 *
 * It changes when a market opens or a provider is switched off — not per
 * request, and not per visitor. Ten minutes at the edge with an hour of
 * stale-while-revalidate means a cold Render instance never makes a visitor
 * wait for a country list. `public` because there is nothing here that
 * belongs to anybody.
 */
const CACHE = "public, max-age=600, stale-while-revalidate=3600";

/** The country the caller asked about, upper-cased, or a 400 saying why. */
function wanted(req, { required }) {
  const raw = req.query.country;
  if (!raw) {
    if (!required) return null;
    throw badRequest("country is required — a two-letter ISO code, e.g. ?country=KE.");
  }
  const code = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw badRequest(`"${raw}" is not a two-letter country code.`);
  }
  return code;
}

/* ---------------------------------------------------------------- *
 * GET /market/config — every country the platform knows.
 * ---------------------------------------------------------------- */
marketRoutes.get("/market/config", (_req, res, next) => {
  try {
    const list = countries();
    res.set("Cache-Control", CACHE);
    /* `source: "server"` so a reader of the response can tell at a glance
       whether the frontend answered from its own table or asked this. */
    res.json({ countries: list, count: list.length, source: "server" });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /payment-methods/available — what may be offered, here, now.
 *
 * ?country= is REQUIRED. Without one the honest answer is not "everything"
 * — a method is only ever available somewhere — and defaulting to a country
 * the caller did not name is how a customer is shown a rail their bank has
 * never heard of.
 *
 * ?amount= is in MINOR UNITS, like every amount this API handles.
 * ---------------------------------------------------------------- */
marketRoutes.get("/payment-methods/available", (req, res, next) => {
  try {
    const code = wanted(req, { required: true });
    const methods = paymentMethods({
      country: code, currency: req.query.currency, amount: req.query.amount,
    });
    res.set("Cache-Control", CACHE);
    res.json({ country: code, methods, count: methods.length, source: "server" });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /localization/config — which languages, and how complete.
 * ---------------------------------------------------------------- */
marketRoutes.get("/localization/config", (req, res, next) => {
  try {
    const code = wanted(req, { required: false });
    res.set("Cache-Control", CACHE);
    res.json({ ...localization(code), source: "server" });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /market/services — what a customer can do in a market.
 *
 * ── NOT /services/available, AND THAT IS THE WHOLE POINT ───────────
 *
 * The frontend asked for `/services/available`, which collides with the
 * `services` RESOURCE — `GET /services/:id`, model HotelService: one
 * hotel's restaurants, spas and airport transfer, scoped to that company
 * and behind a session. Express bound `:id = "available"` and the request
 * got a 401 from a router that had no idea it had been asked a different
 * question.
 *
 * Two unrelated things wanted one path. The tenant's outlets keep
 * /services, because Hotel Management's twenty-seven console forms already
 * post there; the platform's market capabilities move here. The frontend
 * calls this path instead — one line, in one file.
 * ---------------------------------------------------------------- */
marketRoutes.get("/market/services", (req, res, next) => {
  try {
    const code = wanted(req, { required: true });
    res.set("Cache-Control", CACHE);
    res.json({ ...services(code), source: "server" });
  } catch (e) { next(e); }
});
