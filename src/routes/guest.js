/* ====================================================================== *
 * THE GUEST PORTAL.
 *
 * ── WHY THIS IS A SEPARATE ROUTER AND NOT A PRODUCT ────────────────────
 *
 * Every other authenticated route in this service is scoped to an
 * ORGANIZATION: the caller holds a membership, and `where` starts
 * `{ orgId: actor.orgId }`. A guest holds no membership. They are not staff,
 * they do not work for the hotel, and `access.js` gives the GUEST role no
 * access to any area — deliberately:
 *
 *     "A guest is not staff. The guest portal reads a guest's OWN stay
 *      through its own endpoints, and nothing here."
 *
 * These are those endpoints. They are scoped to a PERSON, not a company, and
 * that is a different question asked a different way. Reusing the product
 * framework would have meant either giving a guest a membership in the
 * hotel's organization — which would let them read the hotel's business — or
 * making the organization filter conditional, which is the one thing in this
 * system that must never become an `if`.
 *
 * ── HOW A GUEST IS IDENTIFIED ──────────────────────────────────────────
 *
 * By `Party.userId`. A Party is the record a company keeps of a person; a
 * User is somebody who signs in. The bridge is set when a person proves they
 * are that party by signing in. So:
 *
 *     session.userId  ->  Party[] (which guests am I?)  ->  Reservation[]
 *
 * NOTHING is taken from the request. Not an organization, not a reservation
 * id, not a party id. A guest cannot name a stay they would like to read;
 * they can only be shown the stays that are theirs. That is the whole
 * security model and it is why it is short.
 *
 * ── WHAT A GUEST CANNOT SEE ────────────────────────────────────────────
 *
 * The hotel's work orders, its other guests, its rates, its finances, its
 * staff, its other sites. A guest request is NOT a WorkOrder for exactly this
 * reason: a guest who could read the work queue could learn what else is
 * broken in the building and which rooms are empty.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import { badRequest, forbidden, hidden } from "../http/errors.js";
import { requireSession } from "../http/session.js";
import { rateLimit } from "../http/rate-limit.js";

export const guestRoutes = Router();

guestRoutes.use(requireSession());

/* ---------------------------------------------------------------- *
 * WHO THIS PERSON IS, AS A GUEST.
 * ---------------------------------------------------------------- */

/**
 * The parties this signed-in person IS, and the stays that belong to them.
 *
 * One query, cached on the request. Every handler below needs it and none of
 * them may go without it — a handler that skipped this would be a handler
 * reading somebody else's holiday.
 */
async function asGuest(req) {
  if (req._guest) return req._guest;

  const parties = await db.party.findMany({
    where: { userId: req.session.userId },
    select: { id: true, orgId: true, name: true },
  });

  if (!parties.length) {
    /*
     * NOT 404, and not a blank page either.
     *
     * Somebody signed in whose email no hotel has against a booking. The
     * honest reason is that nobody has linked them yet, and the thing to do
     * about it is ask the hotel — so the message says that rather than
     * implying they have no booking.
     */
    throw forbidden(
      "This account is not linked to a booking yet. The property adds your " +
      "email to your reservation, and this page opens as soon as it does.");
  }

  req._guest = {
    partyIds: parties.map((p) => p.id),
    orgIds: [...new Set(parties.map((p) => p.orgId))],
    names: parties.map((p) => p.name),
  };
  return req._guest;
}

/** A stay of this guest's, or nothing that admits it exists. */
async function ownStay(req, id) {
  const g = await asGuest(req);
  const stay = await db.reservation.findFirst({
    where: { id, guestId: { in: g.partyIds } },
  });
  if (!stay) throw hidden();
  return stay;
}

/* The shape the guest screens read. Deliberately narrow: a guest is shown
   their stay, not the hotel's record of it. No rate breakdown, no source, no
   internal notes. */
const stayWire = (r) => ({
  id: r.id,
  ref: r.ref,
  guestName: r.guestName,
  property: r.property || "",
  roomNumber: r.roomNumber || "",
  roomType: r.roomType || "",
  arriveOn: r.arriveOn,
  departOn: r.departOn,
  nights: r.nights,
  adults: r.adults,
  children: r.children,
  eta: r.eta || "",
  status: r.status,
  currency: r.currency,
});

/* ---------------------------------------------------------------- *
 * POST /guest/link — "the booking with my email is mine".
 *
 * ── WHY THIS IS SAFE, AND WHY IT IS NOT STAFF WORK ─────────────────
 *
 * Without this, `Party.userId` is never set and every guest gets the "not
 * linked to a booking yet" refusal forever. Something has to make the link.
 *
 * The two facts it rests on:
 *
 *   1. THE PROPERTY said this guest's email address is X. A hotel types it in
 *      when it takes the booking, and emails the confirmation to it.
 *   2. GOOGLE says this person controls X. The only way into this service is
 *      Google OAuth, and the email on the session is the verified claim from
 *      a Google ID token — not something the browser said.
 *
 * So: the property addressed the booking to X, and the person asking proved
 * they are X. That is the same evidence a hotel accepts when somebody arrives
 * holding the confirmation email, and it needs no member of staff.
 *
 * WHAT IT WILL NOT DO. It only ever claims a party whose `userId` is NULL. A
 * party already linked to somebody else is left alone — a second person
 * cannot take over a guest record, however their email matches, and the
 * refusal is silent because the existence of that record is not this caller's
 * business.
 *
 * THE RESIDUAL RISK, NAMED. A property that types somebody else's email onto
 * a booking links the wrong person. That is a data-entry risk the property
 * already carries — the same typo sends the confirmation, the folio and the
 * door code to the same wrong address. This does not create the exposure; it
 * inherits it. Worth knowing rather than worth hiding.
 * ---------------------------------------------------------------- */
guestRoutes.post("/guest/link", async (req, res, next) => {
  try {
    /* From the SESSION, never the body. A caller naming the email to match
       would be choosing which guest to become. */
    const user = await db.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, email: true },
    });
    if (!user || !user.email) throw forbidden("This account has no verified email address.");

    const claimable = await db.party.findMany({
      where: {
        userId: null,
        email: { equals: user.email, mode: "insensitive" },
        /* A guest record, not a vendor or a member of staff who happens to
           share the address. Widening this would let somebody claim a
           supplier's record and read its invoices. */
        kind: { in: ["GUEST", "CONTACT"] },
      },
      select: { id: true, orgId: true },
    });

    if (!claimable.length) {
      const already = await db.party.count({ where: { userId: user.id } });
      return res.json({ linked: 0, total: already });
    }

    const ids = claimable.map((p) => p.id);
    await db.party.updateMany({
      /* `userId: null` repeated in the WHERE, not just the read above: two
         requests arriving together must not both claim the same record. */
      where: { id: { in: ids }, userId: null },
      data: { userId: user.id },
    });

    /* Recorded against each company, because "somebody claimed this guest
       record" is a thing a property is entitled to see in its own log. */
    for (const p of claimable) {
      try {
        await db.auditEvent.create({
          data: {
            orgId: p.orgId, actorId: user.id, actorName: user.email,
            action: "guest.link", entity: "party", entityId: p.id,
            detail: { by: "verified email" }, ip: req.ip || "",
          },
        });
      } catch (e) { console.error("guest link audit failed", p.id, e.message); }
    }

    const total = await db.party.count({ where: { userId: user.id } });
    res.json({ linked: ids.length, total });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /guest/stay — my booking, or bookings.
 * ---------------------------------------------------------------- */
guestRoutes.get("/guest/stay", async (req, res, next) => {
  try {
    const g = await asGuest(req);
    const stays = await db.reservation.findMany({
      where: { guestId: { in: g.partyIds } },
      orderBy: [{ arriveOn: "desc" }],
      take: 20,
    });
    res.json({ guest: { names: g.names }, stays: stays.map(stayWire) });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /guest/stay/:id/folio — my bill.
 *
 * Reads the existing Folio. It does NOT open one: a folio is opened by the
 * desk, and a guest arriving at the page should not create a financial
 * record as a side effect of looking.
 * ---------------------------------------------------------------- */
guestRoutes.get("/guest/stay/:id/folio", async (req, res, next) => {
  try {
    const stay = await ownStay(req, req.params.id);
    const folio = await db.folio.findFirst({
      where: { reservationId: stay.id, orgId: stay.orgId },
      include: { lines: { orderBy: { at: "asc" } } },
    });
    if (!folio) {
      /* Nothing charged yet is a real answer, and a better one than a 404. */
      return res.json({ folio: null, lines: [], balance: 0, currency: stay.currency });
    }
    const balance = folio.lines.reduce((sum, l) => sum + BigInt(l.amount), 0n);
    res.json({
      folio: { id: folio.id, closed: folio.closed, currency: folio.currency },
      /* `postedBy` is a member of staff's name. A guest's bill shows what was
         charged, not which employee keyed it in. */
      lines: folio.lines.map((l) => ({ id: l.id, kind: l.kind, detail: l.detail,
                                       amount: l.amount, at: l.at })),
      balance, currency: folio.currency,
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /guest/services — what this property offers.
 *
 * Only the ACTIVE ones, and only at properties this guest is staying at.
 * Airport transfer appears here like any other service, because that is what
 * it is.
 * ---------------------------------------------------------------- */
guestRoutes.get("/guest/services", async (req, res, next) => {
  try {
    const g = await asGuest(req);
    const services = await db.hotelService.findMany({
      where: { orgId: { in: g.orgIds }, active: true },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, kind: true, opensAt: true,
                capacity: true, chargeable: true, note: true },
    });
    res.json({ services });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /guest/requests — what I have asked for.
 * ---------------------------------------------------------------- */
guestRoutes.get("/guest/requests", async (req, res, next) => {
  try {
    const g = await asGuest(req);
    const requests = await db.guestRequest.findMany({
      where: { partyId: { in: g.partyIds } },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      select: { id: true, kind: true, detail: true, note: true, status: true,
                response: true, resolvedAt: true, createdAt: true,
                reservationId: true },
    });
    res.json({ requests });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * POST /guest/requests — ask for something.
 *
 * Covers all four guest screens: a service, the airport transfer, a problem,
 * a question. `reservationId` must be a stay of THIS guest's — checked
 * against the bridge, never taken on trust.
 * ---------------------------------------------------------------- */
/*
 * CHECK_IN and CHECK_OUT are requests like any other.
 *
 * A guest asking to check in is not a guest checking in: the room has to be
 * ready, the identity seen, the payment authorised. So the portal raises a
 * request and the property moves the reservation — which is also why there is
 * no endpoint here that writes Reservation.status.
 */
const KINDS = new Set([
  "SERVICE", "TRANSFER", "ISSUE", "QUESTION", "CHECK_IN", "CHECK_OUT",
]);

guestRoutes.post("/guest/requests", async (req, res, next) => {
  try {
    const kind = String(req.body?.kind || "").trim().toUpperCase();
    if (!KINDS.has(kind)) {
      throw badRequest(`kind must be one of: ${[...KINDS].join(", ").toLowerCase()}.`);
    }
    const detail = String(req.body?.detail || "").trim();
    if (!detail) throw badRequest("Say what you would like — detail is required.");
    if (detail.length > 2000) throw badRequest("That is longer than 2000 characters.");

    const stay = await ownStay(req, String(req.body?.reservationId || ""));

    /*
     * A REQUEST AGAINST A FINISHED STAY IS A MISTAKE, NOT A FEATURE.
     *
     * Somebody who checked out last month asking for housekeeping has almost
     * certainly opened an old tab. Refusing says so; accepting puts a job on
     * a hotel's board for a room that now has somebody else in it.
     */
    if (stay.status === "CHECKED_OUT" || stay.status === "CANCELLED" || stay.status === "NO_SHOW") {
      throw badRequest(
        `That stay is ${stay.status.toLowerCase().replace("_", " ")}. ` +
        `Contact the property directly if you still need something.`);
    }

    const g = await asGuest(req);
    const mine = g.partyIds.find((id) => id === stay.guestId);

    const created = await db.guestRequest.create({
      data: {
        orgId: stay.orgId,
        reservationId: stay.id,
        partyId: mine || null,
        kind,
        detail,
        note: String(req.body?.note || "").slice(0, 500),
      },
      select: { id: true, kind: true, detail: true, note: true, status: true,
                createdAt: true, reservationId: true },
    });

    /*
     * Recorded in the company's audit trail, with the guest named.
     *
     * A request is something the property will be held to, so it belongs in
     * the same log as every other thing that happened to them.
     */
    try {
      await db.auditEvent.create({
        data: {
          orgId: stay.orgId,
          actorId: req.session.userId,
          actorName: stay.guestName || "Guest",
          action: "guest.request", entity: "guestRequest", entityId: created.id,
          detail: { kind, reservation: stay.ref },
          ip: req.ip || "",
        },
      });
    } catch (e) { console.error("guest audit write failed", created.id, e.message); }

    res.status(201).json({ request: created });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * POST /guest/requests/:id/cancel — changed my mind.
 *
 * A guest may withdraw their own request and nothing else. They cannot mark
 * one done, and they cannot write a response — both of those are the
 * property answering, and a guest answering on the property's behalf would
 * make the record worthless.
 * ---------------------------------------------------------------- */
guestRoutes.post("/guest/requests/:id/cancel", async (req, res, next) => {
  try {
    const g = await asGuest(req);
    const found = await db.guestRequest.findFirst({
      where: { id: req.params.id, partyId: { in: g.partyIds } },
    });
    if (!found) throw hidden();
    if (found.status === "DONE" || found.status === "DECLINED") {
      throw badRequest(`That request is already ${found.status.toLowerCase()}.`);
    }
    const row = await db.guestRequest.update({
      where: { id: found.id },
      data: { status: "CANCELLED", resolvedAt: new Date() },
      select: { id: true, status: true, resolvedAt: true },
    });
    res.json({ request: row });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * THE PROPERTY, AS A GUEST SEES IT.
 *
 * `g_info` needs to say where the guest is staying and what the property
 * offers. Everything here comes from the organization the guest's own
 * reservation belongs to — never from a parameter, for the same reason as
 * every other route in this file.
 * ====================================================================== */
guestRoutes.get("/guest/hotel", async (req, res, next) => {
  try {
    const guest = await asGuest(req);

    const orgs = await db.organization.findMany({
      where: { id: { in: [...guest.orgIds] } },
      select: { id: true, name: true, country: true },
    });

    const services = await db.hotelService.findMany({
      where: { orgId: { in: [...guest.orgIds] }, active: true },
      select: { id: true, orgId: true, name: true, kind: true, chargeable: true },
      orderBy: [{ name: "asc" }],
      take: 200,
    });

    res.json({
      hotels: orgs.map((o) => ({
        id: o.id, name: o.name, country: o.country,
        /* What this property offers, by name and whether it costs anything.
           NOT the price: a rate belongs on the folio that charges it, and a
           number shown here that the bill then disagrees with is worse than
           no number. */
        services: services
          .filter((sv) => sv.orgId === o.id)
          .map((sv) => ({ id: sv.id, name: sv.name, kind: sv.kind, chargeable: sv.chargeable })),
      })),
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * MESSAGES, BOTH WAYS.
 *
 * The request list is one-way with a single reply. A guest asking "is the
 * airport transfer still coming?" wants a conversation, so this is the
 * Conversation/Message pair, found by the guest's own party.
 *
 * A guest may only ever see a thread whose `partyId` is one of THEIR parties.
 * Nothing is taken from the request but the text they typed.
 * ====================================================================== */
guestRoutes.get("/guest/messages", async (req, res, next) => {
  try {
    const guest = await asGuest(req);

    const threads = await db.conversation.findMany({
      where: { partyId: { in: [...guest.partyIds] } },
      orderBy: [{ lastAt: "desc" }],
      take: 50,
      select: {
        id: true, subject: true, lastText: true, lastAt: true, orgId: true,
        messages: {
          orderBy: { createdAt: "asc" },
          take: 200,
          select: {
            id: true, direction: true, body: true, createdAt: true, readAt: true,
            /* authorName is NOT returned. Which member of staff replied is the
               property's business; the guest is talking to the hotel. */
          },
        },
      },
    });

    res.json({
      threads: threads.map((t) => ({
        id: t.id, subject: t.subject, lastText: t.lastText, lastAt: t.lastAt,
        messages: t.messages.map((m) => ({
          id: m.id,
          /* From the GUEST's point of view: what the property sent is incoming.
             The column is written from the company's side, so it flips here. */
          mine: m.direction === "IN",
          body: m.body, at: m.createdAt, readAt: m.readAt,
        })),
      })),
    });
  } catch (e) { next(e); }
});

/*
 * KEYED ON THE PERSON, NOT THE ADDRESS.
 *
 * A hotel's guests share one wifi and therefore one IP, so an IP-keyed limiter
 * would have the first guest to send twenty messages silence everybody else in
 * the building. The session's userId is the thing being limited.
 */
guestRoutes.post("/guest/messages",
  rateLimit({ windowMs: 3_600_000, max: 20,
              key: (req) => "guest-message:" + (req.session && req.session.userId) }),
  async (req, res, next) => {
  try {
    const guest = await asGuest(req);

    const body = String((req.body && req.body.body) || "").trim();
    if (!body) throw badRequest("A message needs something in it.");
    if (body.length > 2000) throw badRequest("That message is too long. 2000 characters is the limit.");

    /* Which property? The one their stay belongs to. If a person is somehow a
       guest of two, they must say which — guessing would send a complaint to
       the wrong hotel. */
    const orgIds = [...guest.orgIds];
    let orgId = orgIds[0];
    if (orgIds.length > 1) {
      const asked = String((req.body && req.body.hotel) || "");
      if (!orgIds.includes(asked)) {
        throw badRequest("You have stays at more than one property. Say which one this is for.");
      }
      orgId = asked;
    }

    const party = await db.party.findFirst({
      where: { orgId, userId: req.session.userId },
      select: { id: true, name: true },
    });
    if (!party) throw forbidden("This account is not linked to a booking at that property.");

    /* One open thread per guest, reopened rather than duplicated. */
    let thread = await db.conversation.findFirst({
      where: { orgId, partyId: party.id, closed: false },
      orderBy: { lastAt: "desc" },
      select: { id: true },
    });
    if (!thread) {
      thread = await db.conversation.create({
        data: {
          orgId, partyId: party.id, withName: party.name,
          subject: "From the guest portal",
          lastText: body.slice(0, 160), unread: 1,
        },
        select: { id: true },
      });
    }

    const message = await db.message.create({
      data: {
        orgId, conversationId: thread.id,
        /* IN: into the company, from the guest. */
        direction: "IN", authorName: party.name, body,
      },
      select: { id: true, body: true, createdAt: true },
    });

    await db.conversation.update({
      where: { id: thread.id },
      data: { lastText: body.slice(0, 160), lastAt: message.createdAt,
              unread: { increment: 1 }, closed: false },
    });

    res.status(201).json({
      message: { id: message.id, mine: true, body: message.body, at: message.createdAt },
      thread: thread.id,
    });
  } catch (e) { next(e); }
});
