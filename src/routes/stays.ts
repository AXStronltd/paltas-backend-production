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
 * ── OWNERSHIP ───────────────────────────────────────────────────────────
 *
 * Every booking made here is recorded as a `SupplierBooking` against the person
 * who made it, and reading or cancelling one is checked against that row rather
 * than against "is anybody signed in".
 *
 * That distinction is the reason the table exists. A session proves somebody is
 * a PALTAS user; it says nothing about whether THIS booking is theirs. Without
 * the row, an id was enough to open a stranger's booking or cancel their
 * holiday — so these routes were sandbox-only until it existed.
 *
 * The record is PALTAS's own: who booked, what they paid, and the references
 * they need to arrive. It is NOT a cache of supplier content — hotel names,
 * rates and photographs stay unstored, and nothing here is ever read to decide
 * what a room costs. The supplier is always asked, and if the two disagree the
 * supplier is right.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────
 *
 * No payment is taken anywhere here. In sandbox LiteAPI settles with
 * ACC_CREDIT_CARD, which simulates a booking without a charge. Production needs
 * a payment provider, and PALTAS has none connected.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import type { AccommodationSupplier } from "../domain/supply.ts";
import type { SessionWithUser } from "../auth/sessions.ts";

/** A supplier booking PALTAS recorded, as this file reads one back. */
type SupplierBookingRow =
  NonNullable<Awaited<ReturnType<typeof db.supplierBooking.findFirst>>>;
import type { Request, RequestHandler, Response } from "express";
import type { Prisma } from "@prisma/client";
import type { Act } from "../domain/access.ts";
import { messageOf } from "../http/errors.ts";
import { actorOf, sessionOf } from "../http/request.ts";
import { badRequest, unavailable, notFound } from "../http/errors.ts";
import { rateLimit } from "../http/rate-limit.ts";
import { requireSession } from "../http/session.ts";
import { supplier, isConnected, status as supplyStatus, publicStatus } from "../domain/supply.ts";
import { comparePrices, compareStatus, findHomes } from "../domain/compare.ts";

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
function sandboxOnly(s: AccommodationSupplier): void {
  if (!s.sandbox) {
    throw unavailable(
      "This booking cannot be completed against a live supplier without payment. " +
      "Hold the rate for payment first, let the guest pay, and pass the " +
      "transaction back.");
  }
}

/**
 * The caller's own booking, or 404.
 *
 * Deliberately NOT 403. Telling somebody "that exists but is not yours" confirms
 * a booking id is real, which is a small oracle worth not handing out. To
 * anybody who is not the owner, it simply does not exist.
 */
async function ownedBy(session: SessionWithUser, bookingId: unknown) {
  const row = await db.supplierBooking.findFirst({
    where: { bookingId: String(bookingId), userId: session.userId },
  });
  if (!row) throw notFound("No such booking.");
  return row;
}

/** Dates, or a 400 that names what is wrong rather than just refusing. */
function stayOf(q: Record<string, unknown>) {
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
        throw unavailable("Rooms for this hotel cannot be listed right now.");
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
        supplier: publicStatus(),
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 1b
 * WHAT THIS HOTEL COSTS ELSEWHERE.
 *
 * A public read, and the most expensive endpoint PALTAS has: every miss is a
 * 30-credit call to StayingAPI against a metered account. So three things
 * guard it, and none of them is optional.
 *
 * THE HOTEL MUST BE ONE PALTAS ALREADY SELLS. The request supplies an id and a
 * country, never a property name — the name asked about comes from LiteAPI's
 * own content for that id. A route that took a name would let anyone price any
 * hotel on earth at PALTAS's expense.
 *
 * THE ANSWER IS CACHED. What Booking.com charges for a stay in three weeks does
 * not move minute to minute, and a visitor opening the same hotel twice must
 * not cost twice.
 *
 * THE RATE LIMIT IS TIGHT — 20 a minute rather than the 120 the rooms list
 * gets, because the rooms list costs nothing and this costs money.
 * ---------------------------------------------------------------- */
stayRoutes.get("/marketplace/hotels/:hotelId/compare",
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    try {
      const stay = stayOf(req.query);
      const country = String(req.query.country || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) {
        throw badRequest("A two-letter country code is needed to identify the hotel.");
      }
      const currency = String(req.query.currency || "").toUpperCase();
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        throw badRequest("currency must be a three-letter ISO-4217 code.");
      }

      const out = await comparePrices({
        supplier: live(),
        hotelId: String(req.params.hotelId),
        country, currency, ...stay,
      });

      /* A scraped third-party price is a snapshot, not a quote PALTAS stands
         behind, so a browser may hold it briefly and nothing else may. */
      res.set("Cache-Control", "private, max-age=600");
      res.json(out);
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 1c
 * WHOLE HOMES FROM OTHER SITES.
 *
 * PALTAS owns no short-stay homes and LiteAPI sells hotel rooms, so the
 * "Homes for a few nights" shelf is empty. Airbnb and Vrbo are the gap.
 *
 * NONE OF THESE IS BOOKABLE HERE, and the route says so in every row it
 * returns. StayingAPI has no booking endpoint at all — see the long note at the
 * top of src/suppliers/stayingapi.js.
 *
 * A CITY IS REQUIRED, and that is the cost control rather than a convenience.
 * This search bills per result per platform, and PALTAS's homepage loads
 * inventory on every visit — so without a named destination it must never run,
 * or every bot and every bounce is billed for.
 * ---------------------------------------------------------------- */
stayRoutes.get("/marketplace/homes",
  rateLimit({ windowMs: 60_000, max: 30 }),
  async (req, res, next) => {
    try {
      const city = String(req.query.city || "").trim();
      if (!city) throw badRequest("A destination is needed. Homes are not searched without one.");
      if (city.length > 120) throw badRequest("That destination is too long.");

      const stay = stayOf(req.query);
      const currency = String(req.query.currency || "").toUpperCase();
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        throw badRequest("currency must be a three-letter ISO-4217 code.");
      }

      const out = await findHomes({ city, currency, ...stay });

      /* Somebody else's listing and somebody else's price — a browser may hold
         it briefly and no shared cache may. */
      res.set("Cache-Control", "private, max-age=600");
      res.json(out);
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
  /*
   * SIGNED IN, and this is a change from when holding was anonymous.
   *
   * LiteAPI says the prebook pair "cannot be retrieved later", so it has to be
   * persisted the moment it exists — and a row with no owner is a row nobody
   * can be shown afterwards. A guest who paid and then closed the tab needs
   * PALTAS to be able to find their booking, which means knowing whose it is
   * before the money moves rather than after.
   */
  requireSession(),
  async (req, res, next) => {
    try {
      const s = live();
      if (typeof s.prebook !== "function") {
        throw unavailable("This rate cannot be held right now.");
      }
      const offerId = String((req.body && req.body.offerId) || "").trim();
      if (!offerId) throw badRequest("offerId is required — take it from a room offer.");

      /*
       * WHO IS GOING TO PAY.
       *
       * `pay: true` asks LiteAPI for a payment session so the GUEST can pay with
       * their own card in LiteAPI's hosted form. That is the only way a live
       * booking completes here, because the alternative — ACC_CREDIT_CARD —
       * charges PALTAS's own card in production.
       *
       * Defaulted to true whenever the supplier is live, so the dangerous path
       * cannot be taken by leaving a flag out.
       */
      const pay = req.body && req.body.pay !== undefined
        ? Boolean(req.body.pay)
        : !s.sandbox;

      const held = await s.prebook({ offerId, usePaymentSdk: pay });

      /*
       * PERSISTED IMMEDIATELY, before the client is told anything.
       *
       * This row is the PALTAS booking. It exists from the moment a rate is
       * held, carries the prebook pair, and is the only thing that can connect
       * a Stripe payment back to a reservation if the browser never returns.
       *
       * The Stripe CLIENT SECRET is deliberately NOT stored. It is a
       * credential for one payment, it goes to the payment UI and nowhere
       * else, and a copy at rest is a copy that can leak.
       */
      const supplierName = supplyStatus().name || "";
      let record = null;
      try {
        record = await db.supplierBooking.upsert({
          /* Keyed on the prebook, so a repeated hold of the same offer updates
             rather than multiplying rows. */
          where: { supplier_prebookId: { supplier: supplierName, prebookId: held.prebookId } },
          create: {
            userId: sessionOf(req, "a stays route").userId,
            supplier: supplierName,
            prebookId: held.prebookId,
            transactionId: held.payment ? (held.payment.transactionId || "") : "",
            paymentStatus: held.payment ? "PENDING" : "NOT_REQUIRED",
            hotelId: held.hotelId || "",
            checkIn: held.checkIn ? new Date(held.checkIn) : null,
            checkOut: held.checkOut ? new Date(held.checkOut) : null,
            price: BigInt(held.price == null ? 0 : held.price),
            currency: held.currency || "USD",
            status: "HELD",
            sandbox: Boolean(held.sandbox),
          },
          update: {
            transactionId: held.payment ? (held.payment.transactionId || "") : "",
            price: BigInt(held.price == null ? 0 : held.price),
            currency: held.currency || "USD",
          },
        });
      } catch (e) {
        /*
         * A hold that cannot be recorded must NOT proceed to payment. Taking
         * money against a reservation PALTAS has no record of is the failure
         * this whole row exists to prevent.
         */
        console.error("prebook not recorded:", e && messageOf(e));
        throw unavailable(
          "The booking could not be prepared. Nothing has been charged and no " +
          "rate is held against your name.");
      }
      res.set("Cache-Control", "no-store");
      res.json({
        hold: held,
        /* The PALTAS booking this payment belongs to. */
        paltasBookingId: record.id,
        /* Said out loud rather than left for a client to infer from a number. */
        priceChanged: held.priceDifferencePercent !== 0,
        /* Whether the guest now has to pay before this can be booked. */
        paymentRequired: Boolean(held.payment),
        supplier: publicStatus(),
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
      if (typeof s.book !== "function") {
        throw unavailable("This booking cannot be completed right now.");
      }
      const b = req.body || {};
      const prebookId = String(b.prebookId || "").trim();
      if (!prebookId) throw badRequest("prebookId is required — hold the rate first.");
      const supplierName = supplyStatus().name || "";

      /*
       * THE HELD RATE, AND WHOSE IT IS.
       *
       * Looked up before anything else. It carries the transactionId from the
       * SAME prebook — which is what LiteAPI requires and what a client must
       * never be trusted to supply, because a transactionId from a different
       * prebook would settle the wrong payment against this reservation.
       */
      const held = await db.supplierBooking.findUnique({
        where: { supplier_prebookId: { supplier: supplierName, prebookId } },
      });
      if (!held) {
        throw notFound(
          "That held rate is not one PALTAS is holding. Nothing has been charged.");
      }
      if (held.userId !== sessionOf(req, "a stays route").userId) {
        /* Somebody else's hold. 404 rather than 403 — see ownedBy. */
        throw notFound("That held rate is not one PALTAS is holding.");
      }

      /*
       * IDEMPOTENT. A retried book — a double-click, a flaky connection, a
       * client that did not see the first response — returns the booking that
       * already exists instead of reserving a second room the guest paid for
       * once and would be charged for twice.
       */
      if (held.bookingId) {
        res.set("Cache-Control", "no-store");
        return res.status(200).json({
          booking: fromRecord(held),
          recorded: true,
          idempotent: true,
          sandbox: held.sandbox,
          notice: "This rate was already booked. You have not been charged again.",
          supplier: publicStatus(),
        });
      }

      /* From OUR record, never from the request. */
      const transactionId = String(held.transactionId || "").trim();

      /*
       * A PAID booking may proceed on a live key; an unpaid one may not.
       *
       * The adapter enforces the money side — no transaction and no sandbox
       * means it refuses. This enforces the RECORD side, which is a different
       * problem: PALTAS does not store supplier bookings, so there is nothing
       * tying one to the person who made it. Without a transaction we are in
       * sandbox and that is tolerable for testing. With a real paid booking it
       * is not, so the guest is told plainly to keep their reference.
       */
      if (!transactionId) sandboxOnly(s);

      const holder = b.holder || {};
      for (const f of ["firstName", "lastName", "email"]) {
        if (!String(holder[f] || "").trim()) {
          throw badRequest(`holder.${f} is required — the hotel needs a name to check in.`);
        }
      }

      const booking = await s.book({
        prebookId,
        holder,
        transactionId,
        guests: Array.isArray(b.guests) ? b.guests : [],
        /* The adapter generates one when absent. LiteAPI refuses a repeat, which
           is what stops a retried request becoming two bookings. */
        clientReference: b.clientReference ? String(b.clientReference) : "",
      });

      /*
       * RECORDED BEFORE IT IS RETURNED.
       *
       * The guest has paid by this point, so a row that fails to write is a
       * booking PALTAS cannot show them later — but it is NOT a reason to hide
       * the booking or imply it failed. So the write is attempted, a failure is
       * logged and swallowed, and the guest still gets their reference. A
       * missing row is recoverable from the supplier; a guest who was told
       * their paid booking failed is not.
       */
      /*
       * The outcome lands on the row that has existed since the rate was held,
       * so there is exactly one record of this reservation from first hold to
       * final status.
       */
      let recorded = true;
      try {
        await db.supplierBooking.update({
          where: { id: held.id },
          data: {
            bookingId: booking.bookingId,
            clientReference: booking.clientReference || "",
            supplierBookingId: booking.supplierBookingId || "",
            hotelConfirmationCode: booking.hotelConfirmationCode || "",
            hotelName: booking.hotelName || "",
            checkIn: booking.checkIn ? new Date(booking.checkIn) : held.checkIn,
            checkOut: booking.checkOut ? new Date(booking.checkOut) : held.checkOut,
            price: BigInt(booking.price == null ? Number(held.price) : booking.price),
            currency: booking.currency || held.currency,
            status: booking.status || "CONFIRMED",
            refundable: booking.refundable,
            /* Paid AND confirmed. Until the supplier said yes it was only paid. */
            paymentStatus: transactionId ? "CONFIRMED" : "NOT_REQUIRED",
            holderName: [holder.firstName, holder.lastName].filter(Boolean).join(" "),
            holderEmail: String(holder.email || ""),
          },
        });
      } catch (e) {
        recorded = false;
        console.error("supplier booking not recorded:", e && messageOf(e));
      }

      res.set("Cache-Control", "no-store");
      res.status(201).json({
        booking,
        /* Said out loud: if this is false the guest's own list will not show it
           and the reference is the only way back to it. */
        recorded,
        /*
         * Said on the response, not only in a log. A sandbox booking is not a
         * booking — nobody is arriving — and a client that renders one as
         * confirmed travel has misled somebody.
         */
        sandbox: booking.sandbox,
        notice: booking.sandbox
          ? "This is a SANDBOX booking. No room is reserved, nobody has been " +
            "charged, and no guest should be told to travel on it."
          : /*
             * A real booking, and PALTAS cannot look it up for them later: there
             * is no stored record, so the reference IS the booking as far as this
             * platform is concerned. Saying so is the difference between a guest
             * keeping it and losing it.
             */
            "Keep your booking reference and confirmation code. PALTAS does not " +
            "yet store supplier bookings, so this reference is how you or the " +
            "hotel find this reservation.",
        supplier: publicStatus(),
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
      if (typeof s.booking !== "function") {
        throw unavailable("This booking cannot be looked up right now.");
      }
      /* Theirs, or it does not exist. Checked BEFORE the supplier is asked, so a
         stranger's id cannot even be used to probe whether it is real. */
      const own = await ownedBy(sessionOf(req, "a stays route"), req.params.bookingId);

      let booking;
      try {
        booking = await s.booking({ bookingId: String(req.params.bookingId) });
      } catch (e) {
        /* A supplier 404 is a 404 here, not a 503 — the booking is the thing
           that does not exist, and the supplier is fine. */
        if (/404|not found/i.test(String(e && messageOf(e)))) throw notFound("No such booking.");
        throw e;
      }
      res.set("Cache-Control", "no-store");
      /* The supplier is authoritative on status and money; PALTAS's row is
         authoritative on whose it is and what was shown at the time. */
      res.json({ booking, sandbox: own.sandbox, bookedAt: own.createdAt,
                 supplier: publicStatus() });
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
      if (typeof s.cancel !== "function") {
        throw unavailable("This booking cannot be cancelled right now.");
      }
      /* Cancelling somebody else's holiday is the worst thing these routes could
         allow, so ownership is established before anything is sent. */
      await ownedBy(sessionOf(req, "a stays route"), req.params.bookingId);

      const result = await s.cancel({ bookingId: String(req.params.bookingId) });

      /*
       * Written back, including what it cost. A non-refundable cancellation
       * charges anyway, and a record that said only "cancelled" would tell
       * somebody they had their money back when they did not.
       */
      try {
        await db.supplierBooking.updateMany({
          where: { bookingId: String(req.params.bookingId), userId: sessionOf(req, "a stays route").userId },
          data: {
            status: result.status || "CANCELLED",
            cancelledAt: new Date(),
            cancellationFee: result.cancellationFee == null ? null : BigInt(result.cancellationFee),
            refund: result.refund == null ? null : BigInt(result.refund),
          },
        });
      } catch (e) {
        /* The cancellation already happened at the supplier. A stale row is a
           reporting problem; refusing here would imply it had not been cancelled. */
        console.error("cancellation not recorded:", e && messageOf(e));
      }

      res.set("Cache-Control", "no-store");
      res.json({
        cancellation: result,
        /* The distinction, named. */
        charged: result.charged,
        sandbox: result.sandbox,
        supplier: publicStatus(),
      });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- 6
 * THE PERSON'S OWN BOOKINGS.
 *
 * Answered entirely from PALTAS's own record — no supplier call at all. Three
 * reasons, and any one of them would be enough:
 *
 *   It works when the supplier is down. A guest wanting to check where they are
 *   staying tomorrow should not depend on a wholesaler being awake.
 *   It is one query rather than N.
 *   And it is the only list that can exist: the supplier knows PALTAS's
 *   bookings, not this user's.
 *
 * Status and money here are as they were when last seen. The supplier remains
 * authoritative — open one and it is re-read.
 * ---------------------------------------------------------------- */
stayRoutes.get("/marketplace/stays",
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireSession(),
  async (req, res, next) => {
    try {
      const rows = await db.supplierBooking.findMany({
        where: { userId: sessionOf(req, "a stays route").userId },
        orderBy: [{ createdAt: "desc" }],
        take: 50,
      });

      res.set("Cache-Control", "no-store");
      res.json({
        stays: rows.map((r) => ({
          bookingId: r.bookingId,
          supplier: r.supplier,
          hotelName: r.hotelName,
          hotelConfirmationCode: r.hotelConfirmationCode,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          nights: r.nights,
          /* Minor units, as everywhere. The JSON replacer in server.js turns
             BigInt into a number. */
          price: r.price,
          currency: r.currency,
          status: r.status,
          refundable: r.refundable,
          cancelledAt: r.cancelledAt,
          cancellationFee: r.cancellationFee,
          refund: r.refund,
          /* So a client can never render a sandbox booking as real travel. */
          sandbox: r.sandbox,
          bookedAt: r.createdAt,
        })),
        count: rows.length,
      });
    } catch (e) { next(e); }
  });

/**
 * A stored row as the booking shape a client already understands.
 *
 * Used for the idempotent replay: a second book against the same held rate must
 * answer with the SAME booking, not a fresh call to the supplier. Asking LiteAPI
 * again would be a second reservation attempt for a rate already taken.
 */
function fromRecord(r: SupplierBookingRow) {
  return {
    bookingId: r.bookingId,
    clientReference: r.clientReference || null,
    status: r.status,
    hotelConfirmationCode: r.hotelConfirmationCode || null,
    hotelId: r.hotelId || null,
    hotelName: r.hotelName || null,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    price: r.price,
    currency: r.currency,
    refundable: r.refundable,
    cancellation: [],
    createdAt: r.createdAt,
    supplierBookingId: r.supplierBookingId || null,
    source: r.supplier,
    sandbox: r.sandbox,
  };
}
