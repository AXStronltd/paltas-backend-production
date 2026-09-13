/* ====================================================================== *
 * BOOKING A SUPPLIER'S ROOM.
 *
 * The marketplace can show a licensed wholesaler's hotels. These are the routes
 * that let somebody actually take one:
 *
 *     rooms  ->  hold  ->  book  ->  retrieve  ->  cancel
 *
 * ── WHY THESE ARE SEPARATE FROM EVERY OTHER ROUTE IN THE SERVICE ─────────
 *
 * Nothing here touches a PALTAS listing, a Reservation, a Folio or an
 * Organization. A supplier booking is a different animal: the hotel is not a
 * PALTAS company, the room is not a PALTAS Room, and the booking belongs to the
 * GUEST rather than to an operator. Writing one into `Reservation` would need an
 * invented orgId and would drop bookings at other people's hotels into a
 * PALTAS hotelier's own arrivals list.
 *
 * ── WHAT IS NOT BUILT, AND WHY IT GATES PRODUCTION ──────────────────────
 *
 * A supplier booking is NOT PERSISTED. There is no model for one, and adding it
 * is a schema migration nobody has authorised.
 *
 * That absence has a direct security consequence, and it is the reason the
 * booking routes below are sandbox-only:
 *
 *   With no stored booking there is no record of WHOSE it is. So a `GET` or a
 *   cancel by booking id cannot be checked against an owner — anybody holding
 *   an id could read a stranger's booking or cancel their holiday.
 *
 * A session is required, which narrows it to signed-in people, but a session is
 * not ownership. The honest fix is a Booking row with a userId, checked on every
 * read and every cancel. Until that exists these routes refuse whenever the
 * supplier is not a sandbox — see `sandboxOnly` below. The adapter refuses a
 * live booking too, so the restriction is enforced twice, deliberately.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────
 *
 * No payment is taken anywhere here. In sandbox LiteAPI settles with
 * ACC_CREDIT_CARD, which simulates a booking without a charge. Production needs
 * a payment provider, and PALTAS has none connected.
 * ====================================================================== */

import { Router } from "express";
import { badRequest, unavailable, notFound } from "../http/errors.js";
import { rateLimit } from "../http/rate-limit.js";
import { requireSession } from "../http/session.js";
import { supplier, isConnected, status as supplyStatus } from "../domain/supply.js";

export const stayRoutes = Router();

/** The supplier, or a 503 that says why there isn't one. */
function live() {
  if (!isConnected()) {
    throw unavailable(
      "No accommodation supplier is connected, so there is nothing to book. " +
      "PALTAS's own listings are unaffected.");
  }
  return supplier();
}

/**
 * Refuse the booking routes unless the supplier is a sandbox.
 *
 * Not belt-and-braces — the two guards stop different things. The adapter
 * refuses to SEND a live booking because there is no payment provider. This
 * refuses to EXPOSE booking management at all, because without a persisted
 * booking there is no owner to check a reader or a canceller against.
 */
function sandboxOnly(s) {
  if (!s.sandbox) {
    throw unavailable(
      "Booking management is available only while the supplier is in sandbox. " +
      "A live booking has to be recorded against the person who made it before " +
      "it can be read or cancelled by id, and PALTAS does not store supplier " +
      "bookings yet.");
  }
}

/** Dates, or a 400 that names what is wrong rather than just refusing. */
function stayOf(q) {
  const checkIn = String(q.checkIn || q.checkin || "").trim();
  const checkOut = String(q.checkOut || q.checkout || "").trim();
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a)) throw badRequest("checkIn must be a date, as YYYY-MM-DD.");
  if (!Number.isFinite(b)) throw badRequest("checkOut must be a date, as YYYY-MM-DD.");
  if (b <= a) throw badRequest("checkOut must be after checkIn.");
  const guests = Math.min(10, Math.max(1, Number(q.guests) || 2));
  return { checkIn, checkOut, guests };
}

/* ---------------------------------------------------------------- 1
 * THE ROOMS AT ONE HOTEL.
 *
 * A public read. The marketplace card shows the cheapest offer; this is what a
 * visitor sees when they want to know what else is available and on what terms.
 * No session, because choosing a room is browsing.
 * ---------------------------------------------------------------- */
stayRoutes.get("/marketplace/hotels/:hotelId/rooms",
  rateLimit({ windowMs: 60_000, max: 120 }),
  async (req, res, next) => {
    try {
      const s = live();
      if (typeof s.rooms !== "function") {
        throw unavailable(`${supplyStatus().label} cannot list rooms for a hotel.`);
      }
      const stay = stayOf(req.query);
      const out = await s.rooms({ hotelId: String(req.params.hotelId), ...stay });

      /* A wholesale quote is live and its terms restrict storing it. */
      res.set("Cache-Control", "no-store");
      res.json({
        hotelId: out.hotelId,
        nights: out.nights,
        offers: out.offers,
        count: out.offers.length,
        supplier: supplyStatus(),
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 2
 * HOLD A RATE.
 *
 * Public, because it takes no personal data and moves no money — it asks the
 * supplier to stand behind a price for a moment and tell us the real one.
 *
 * `priceDifferencePercent` is passed straight through. A caller that ignores it
 * and books anyway will charge a guest a figure they never saw.
 * ---------------------------------------------------------------- */
stayRoutes.post("/marketplace/stays/hold",
  rateLimit({ windowMs: 60_000, max: 60 }),
  async (req, res, next) => {
    try {
      const s = live();
      if (typeof s.prebook !== "function") {
        throw unavailable(`${supplyStatus().label} cannot hold a rate.`);
      }
      const offerId = String((req.body && req.body.offerId) || "").trim();
      if (!offerId) throw badRequest("offerId is required — take it from a room offer.");

      const held = await s.prebook({ offerId });
      res.set("Cache-Control", "no-store");
      res.json({
        hold: held,
        /* Said out loud rather than left for a client to infer from a number. */
        priceChanged: held.priceDifferencePercent !== 0,
        supplier: supplyStatus(),
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 3
 * TAKE IT.
 *
 * Signed in, and sandbox only. See the note at the top of this file for why a
 * session is necessary and still not sufficient.
 * ---------------------------------------------------------------- */
stayRoutes.post("/marketplace/stays/book",
  rateLimit({ windowMs: 60_000, max: 20 }),
  requireSession(),
  async (req, res, next) => {
    try {
      const s = live();
      sandboxOnly(s);
      if (typeof s.book !== "function") {
        throw unavailable(`${supplyStatus().label} cannot complete a booking.`);
      }
      const b = req.body || {};
      const prebookId = String(b.prebookId || "").trim();
      if (!prebookId) throw badRequest("prebookId is required — hold the rate first.");

      const holder = b.holder || {};
      for (const f of ["firstName", "lastName", "email"]) {
        if (!String(holder[f] || "").trim()) {
          throw badRequest(`holder.${f} is required — the hotel needs a name to check in.`);
        }
      }

      const booking = await s.book({
        prebookId,
        holder,
        guests: Array.isArray(b.guests) ? b.guests : [],
        /* The adapter generates one when absent. LiteAPI refuses a repeat, which
           is what stops a retried request becoming two bookings. */
        clientReference: b.clientReference ? String(b.clientReference) : "",
      });

      res.set("Cache-Control", "no-store");
      res.status(201).json({
        booking,
        /*
         * Said on the response, not only in a log. A sandbox booking is not a
         * booking — nobody is arriving — and a client that renders one as
         * confirmed travel has misled somebody.
         */
        sandbox: true,
        notice: "This is a SANDBOX booking. No room is reserved, nobody has been " +
                "charged, and no guest should be told to travel on it.",
        supplier: supplyStatus(),
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 4
 * READ ONE.
 * ---------------------------------------------------------------- */
stayRoutes.get("/marketplace/stays/:bookingId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireSession(),
  async (req, res, next) => {
    try {
      const s = live();
      sandboxOnly(s);
      if (typeof s.booking !== "function") {
        throw unavailable(`${supplyStatus().label} cannot retrieve a booking.`);
      }
      let booking;
      try {
        booking = await s.booking({ bookingId: String(req.params.bookingId) });
      } catch (e) {
        /* A supplier 404 is a 404 here, not a 503 — the booking is the thing
           that does not exist, and the supplier is fine. */
        if (/404|not found/i.test(String(e && e.message))) throw notFound("No such booking.");
        throw e;
      }
      res.set("Cache-Control", "no-store");
      res.json({ booking, sandbox: true, supplier: supplyStatus() });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 5
 * CANCEL.
 *
 * The response distinguishes "cancelled" from "cancelled and charged anyway",
 * because a non-refundable booking does the second and flattening the two would
 * tell somebody they had their money back when they did not.
 * ---------------------------------------------------------------- */
stayRoutes.delete("/marketplace/stays/:bookingId",
  rateLimit({ windowMs: 60_000, max: 20 }),
  requireSession(),
  async (req, res, next) => {
    try {
      const s = live();
      sandboxOnly(s);
      if (typeof s.cancel !== "function") {
        throw unavailable(`${supplyStatus().label} cannot cancel a booking.`);
      }
      const result = await s.cancel({ bookingId: String(req.params.bookingId) });
      res.set("Cache-Control", "no-store");
      res.json({
        cancellation: result,
        /* The distinction, named. */
        charged: result.charged,
        sandbox: true,
        supplier: supplyStatus(),
      });
    } catch (e) { next(e); }
  });
