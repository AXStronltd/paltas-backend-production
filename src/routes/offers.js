/* ====================================================================== *
 * MOVING AN OFFER — the four acts, and what each one does to everything else.
 *
 * The offers RESOURCE creates and edits them. It does not let anybody write
 * `status`, because moving an offer is never only a status change:
 *
 *   send     DRAFT → SENT          stamps when it went out
 *   view     SENT → VIEWED         the buyer opened it
 *   accept   SENT/VIEWED → ACCEPTED
 *                                  · reserves the unit
 *                                  · opens a reservation (a Contract)
 *                                  · expires every other live offer on that unit
 *   reject   SENT/VIEWED → REJECTED with a reason, kept
 *
 * ── WHY THESE ARE ROUTES AND NOT A FIELD ───────────────────────────────
 *
 * A writable `status` is a state machine anybody can step around. Accepting
 * by PATCH would mark the offer accepted and leave the unit unreserved, no
 * reservation anywhere, and two buyers still holding live offers on the same
 * flat — a sale that looks complete on one screen and never happened on any
 * other. Every consequence below happens in one transaction with the status
 * change, or none of it does.
 *
 * ── AND WHY IT DOES NOT TOUCH THE LEDGER ───────────────────────────────
 *
 * Accepting an offer creates a RESERVED contract, and a reservation is not
 * revenue — it is a deposit and an intention. Finance remains the only thing
 * that books money; this initiates the record the invoice is later raised
 * against. There is deliberately no second accounting path in here.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.js";

export const offerRoutes = Router();

offerRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req, act, label) {
  const why = whyNotArea(req.actor, "agent", act, label || "offers");
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

async function audit(req, action, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        orgId: req.actor.orgId,
        actorId: req.session.userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action, entity: "offer", entityId: entityId || "",
        detail: detail || undefined, ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, e.message); }
}

/** This company's offer, or nothing that admits it exists. */
async function own(req, id) {
  const offer = await db.offer.findFirst({
    where: { id, orgId: req.actor.orgId },
    include: {
      unit: { select: { id: true, ref: true, status: true } },
      buyer: { select: { id: true, name: true } },
      contract: { select: { id: true, ref: true } },
    },
  });
  if (!offer) throw hidden();
  return offer;
}

/**
 * An offer past its validity date is EXPIRED, whoever is looking and whenever
 * they look.
 *
 * Worked out on read rather than by a nightly job, because a job that has not
 * run yet leaves an offer acceptable after it lapsed — and the one moment
 * that matters is somebody trying to accept it. The row is corrected as well,
 * so every other reader agrees.
 */
async function expireIfLapsed(offer) {
  const live = offer.status === "SENT" || offer.status === "VIEWED" || offer.status === "DRAFT";
  if (!live || !offer.validUntil || new Date(offer.validUntil) >= new Date()) return offer;
  const updated = await db.offer.update({
    where: { id: offer.id },
    data: { status: "EXPIRED", decidedAt: new Date() },
  });
  return { ...offer, ...updated };
}

/** What may follow what. Written once, so no route invents its own rule. */
const MAY = {
  send: ["DRAFT"],
  view: ["SENT"],
  accept: ["SENT", "VIEWED"],
  reject: ["SENT", "VIEWED"],
};

function check(offer, act) {
  if (MAY[act].includes(offer.status)) return;
  const was = offer.status.toLowerCase();
  throw conflict(
    `This offer is ${was}, and only a ${MAY[act].map((s) => s.toLowerCase()).join(" or ")} ` +
    `offer can be ${act === "accept" ? "accepted" : act === "reject" ? "rejected" : act + "ed"}.`);
}

/* ---------------------------------------------------------------- *
 * SEND
 * ---------------------------------------------------------------- */

offerRoutes.post("/offers/:id/send", route(async (req, res) => {
  need(req, "update", "offers");
  const offer = await expireIfLapsed(await own(req, req.params.id));
  check(offer, "send");

  if (!offer.buyerId) throw badRequest("An offer needs a buyer before it can be sent.");
  if (!offer.unitId) throw badRequest("An offer needs a unit before it can be sent.");

  const updated = await db.offer.update({
    where: { id: offer.id },
    data: { status: "SENT", sentAt: new Date() },
  });
  await audit(req, "offer.send", offer.id, { ref: offer.ref, buyer: offer.buyer?.name });
  res.json({ offer: updated });
}));

/* ---------------------------------------------------------------- *
 * VIEWED
 * ---------------------------------------------------------------- */

/**
 * The buyer opened it.
 *
 * Idempotent on purpose: an offer opened three times was still first seen
 * once, and overwriting `viewedAt` would lose the only fact this records.
 */
offerRoutes.post("/offers/:id/view", route(async (req, res) => {
  need(req, "update", "offers");
  const offer = await expireIfLapsed(await own(req, req.params.id));
  if (offer.status === "VIEWED") return res.json({ offer, already: true });
  check(offer, "view");

  const updated = await db.offer.update({
    where: { id: offer.id },
    data: { status: "VIEWED", viewedAt: offer.viewedAt || new Date() },
  });
  await audit(req, "offer.view", offer.id, { ref: offer.ref });
  res.json({ offer: updated });
}));

/* ---------------------------------------------------------------- *
 * ACCEPT — the one with consequences
 * ---------------------------------------------------------------- */

offerRoutes.post("/offers/:id/accept", route(async (req, res) => {
  /* Accepting commits a unit, so it is a create-level act rather than an
     edit: it opens a reservation that did not exist. */
  need(req, "create", "accepting an offer");
  const orgId = req.actor.orgId;
  const offer = await expireIfLapsed(await own(req, req.params.id));
  check(offer, "accept");

  if (!offer.unitId) throw badRequest("An offer with no unit cannot be accepted — there is nothing to reserve.");
  if (!offer.buyerId) throw badRequest("An offer with no buyer cannot be accepted.");
  if (offer.contract) throw conflict(`This offer is already reserved as ${offer.contract.ref}.`);

  /* Somebody else may hold this unit already. Checked before the transaction
     so the refusal names the reservation rather than failing on a constraint. */
  const held = await db.contract.findFirst({
    where: {
      orgId, unitId: offer.unitId,
      status: { in: ["RESERVED", "SOLD", "COMPLETED"] },
    },
    select: { ref: true, status: true },
  });
  if (held) {
    throw conflict(
      `That unit is already ${held.status.toLowerCase()} under ${held.ref}. ` +
      `Release that reservation before accepting another offer on it.`);
  }

  const ref = await nextContractRef(orgId);

  /*
   * ONE TRANSACTION, FOUR CONSEQUENCES.
   *
   * The offer is accepted, the reservation exists, the unit is off the
   * market, and every rival offer on that unit is closed — or none of it
   * happened. Half of this is worse than none: a reserved unit with no
   * reservation, or two buyers both told yes.
   */
  const out = await db.$transaction(async (tx) => {
    const accepted = await tx.offer.update({
      where: { id: offer.id },
      data: { status: "ACCEPTED", decidedAt: new Date() },
    });

    const contract = await tx.contract.create({
      data: {
        orgId, ref,
        offerId: offer.id,
        projectId: offer.projectId,
        unitId: offer.unitId,
        buyerId: offer.buyerId,
        /* What was actually agreed, not what was asked. */
        price: BigInt(offer.price) - BigInt(offer.discount),
        deposit: offer.deposit,
        currency: offer.currency,
        status: "RESERVED",
        note: offer.paymentPlan ? `Payment plan: ${offer.paymentPlan}` : "",
      },
      include: {
        unit: { select: { id: true, ref: true } },
        buyer: { select: { id: true, name: true } },
      },
    });

    /*
     * The unit comes off the market HERE, from the same act that reserved it.
     * Marketplace availability reads UnitStatus, so there is one source of
     * truth and no second place to keep in step.
     */
    await tx.unit.update({
      where: { id: offer.unitId },
      data: { status: "RESERVED" },
    });

    /* Every other live offer on this unit is now dead. Saying so beats
       leaving two buyers each believing they are still in the running. */
    const beaten = await tx.offer.updateMany({
      where: {
        orgId, unitId: offer.unitId,
        id: { not: offer.id },
        status: { in: ["DRAFT", "SENT", "VIEWED"] },
      },
      data: { status: "EXPIRED", decidedAt: new Date() },
    });

    return { offer: accepted, contract, superseded: beaten.count };
  });

  await audit(req, "offer.accept", offer.id, {
    ref: offer.ref, reservation: out.contract.ref,
    unit: offer.unit?.ref, superseded: out.superseded,
  });

  res.status(201).json({
    offer: out.offer,
    reservation: out.contract,
    unitReserved: offer.unit?.ref || null,
    supersededOffers: out.superseded,
    /* What the caller should do next, said rather than assumed. */
    next: "Raise an invoice against this reservation to collect the deposit.",
  });
}));

/* ---------------------------------------------------------------- *
 * REJECT
 * ---------------------------------------------------------------- */

offerRoutes.post("/offers/:id/reject", route(async (req, res) => {
  need(req, "update", "offers");
  const offer = await expireIfLapsed(await own(req, req.params.id));
  check(offer, "reject");

  const reason = String((req.body || {}).reason || "").trim();
  if (!reason) {
    throw badRequest(
      "Say why it was turned down. The reason a buyer walked away is worth more " +
      "than the fact that they did.");
  }

  const updated = await db.offer.update({
    where: { id: offer.id },
    data: { status: "REJECTED", decidedAt: new Date(), declineReason: reason.slice(0, 500) },
  });
  await audit(req, "offer.reject", offer.id, { ref: offer.ref, reason });
  res.json({ offer: updated });
}));

/* ---------------------------------------------------------------- *
 * WHAT IS LIVE
 * ---------------------------------------------------------------- */

/**
 * GET /offers/pipeline — the offers still in play, and what they are worth.
 *
 * Reads expiry as it goes, so a lapsed offer is corrected the first time
 * anybody looks at the pipeline rather than sitting there as live.
 */
offerRoutes.get("/offers/pipeline", route(async (req, res) => {
  need(req, "list", "offers");
  const orgId = req.actor.orgId;

  const live = await db.offer.findMany({
    where: { orgId, status: { in: ["DRAFT", "SENT", "VIEWED"] } },
    include: {
      buyer: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true } },
      project: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const now = new Date();
  const lapsed = live.filter((o) => o.validUntil && new Date(o.validUntil) < now);
  if (lapsed.length) {
    await db.offer.updateMany({
      where: { id: { in: lapsed.map((o) => o.id) } },
      data: { status: "EXPIRED", decidedAt: now },
    });
  }
  const lapsedIds = new Set(lapsed.map((o) => o.id));
  const still = live.filter((o) => !lapsedIds.has(o.id));

  const value = still.reduce((t, o) => t + (BigInt(o.price) - BigInt(o.discount)), 0n);

  res.json({
    offers: still,
    count: still.length,
    value,
    expiredNow: lapsed.length,
    byStatus: {
      draft: still.filter((o) => o.status === "DRAFT").length,
      sent: still.filter((o) => o.status === "SENT").length,
      viewed: still.filter((o) => o.status === "VIEWED").length,
    },
  });
}));

/** The same counter the framework uses for contracts, so refs never collide. */
async function nextContractRef(orgId) {
  const name = `contracts:${orgId}`;
  const row = await db.counter.upsert({
    where: { name }, create: { name, value: 1 }, update: { value: { increment: 1 } },
  });
  return `CON-${String(row.value).padStart(4, "0")}`;
}
