/* ====================================================================== *
 * THE SIX PRODUCTS, MOUNTED.
 *
 * Most of what a console does is list, read, create, correct and remove
 * rows that belong to one company, and http/resource.js builds those five
 * endpoints from a declaration with the organization filter, the permission
 * check and the audit entry already in it. So most of this file is a list of
 * paths.
 *
 * What is NOT generic is written out below it, and there are only four
 * kinds of thing:
 *
 *   - MONEY THAT MUST BE COMPUTED BY THE SERVER. An invoice total is the
 *     sum of its lines and a paid figure is the sum of its payments. Both
 *     are recomputed here on every change, and neither can be sent.
 *   - MONEY THAT MUST NOT BE DELETED. A payment is voided, with a reason,
 *     and the row stays.
 *   - A ROW THAT BELONGS TO ANOTHER ROW. A folio belongs to a reservation,
 *     an invoice line to an invoice.
 *   - WORK THAT IS A DECISION. Admitting a visitor, closing an incident.
 *
 * Everything else is a resource, and a resource that needed a special case
 * would be a resource whose declaration is wrong.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { RESOURCES } from "../domain/registry.ts";
import { resourceRouter } from "../http/resource.ts";
import { clean } from "../domain/input.ts";
import { allows, whyNotArea } from "../domain/access.ts";
import { scopedTo } from "../domain/scope.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";
import { sync as syncChannel, status as channelStatus } from "../domain/channels.js";
import { postForPayment, reverseFor } from "../domain/posting.js";
import {
  presignUpload, presignDownload, head as storageHead,
  publicDescribe as storagePublicDescribe,
} from "../domain/storage.js";

export const productRoutes = Router();

/* ====================================================================== *
 * 1. THE TWENTY-EIGHT.
 * ====================================================================== */

for (const slug of Object.keys(RESOURCES)) {
  productRoutes.use(`/${slug}`, resourceRouter(slug));
}

/* ====================================================================== *
 * 2. THE REST OF THIS FILE NEEDS THE SAME THREE GUARDS.
 * ====================================================================== */

const guarded = Router();
guarded.use(requireSession(), requireOrganization(), requireOpenSubscription());
productRoutes.use(guarded);

/** Role, for the endpoints below, which are not built by the framework. */
function need(req, area, act, label) {
  const why = whyNotArea(req.actor, area, act, label);
  if (why) throw forbidden(why);
}

/** A row of this company's, or nothing that admits the row exists. */
async function own(model, id, orgId, extra) {
  const row = await db[model].findFirst({ where: { id, orgId }, ...(extra || {}) });
  if (!row) throw hidden();
  return row;
}

async function audit(req, action, entity, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        orgId: req.actor.orgId,
        actorId: req.session.userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action, entity, entityId, detail: detail || undefined, ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, entity, e.message); }
}

/* ====================================================================== *
 * 3. INVOICES — WHERE THE TOTAL COMES FROM.
 *
 * `total` and `paid` are columns, but they are never written by a request.
 * They are recomputed from the lines and the payments every time either
 * changes. A client that can name its own total can name zero, and the
 * customer's own books would then disagree with their bank.
 * ====================================================================== */

/* ====================================================================== *
 * MONEY ARITHMETIC, NOW IN BigInt.
 *
 * Amounts are BigInt since prisma/migrations/…_money_bigint — INT4 could not
 * hold a Nairobi valuation. That changes arithmetic everywhere money is
 * touched, because JavaScript REFUSES to mix the two:
 *
 *     1n + 1        TypeError: Cannot mix BigInt and other types
 *
 * Which is the right behaviour and the reason this is safe to do: there is no
 * silent coercion to find later in a total that is out by a rounding step.
 * Every site below was found by that error.
 * ====================================================================== */

/** A BigInt from whatever the database or a request body supplied. */
const big = (v) => (typeof v === "bigint" ? v : BigInt(Math.round(Number(v) || 0)));

/**
 * Tax, in basis points, rounded the way the Number version rounded.
 *
 * BigInt division TRUNCATES toward zero; `Math.round` did not. On a 16% line
 * that is a one-minor-unit difference per line, which is exactly the kind of
 * discrepancy that makes a customer's books disagree with their invoice by a
 * few cents and nobody can say why. So the half is added back explicitly,
 * with the sign handled rather than assumed.
 */
function taxOn(net, bps) {
  const x = net * big(bps);
  const half = 5000n;
  return x >= 0n ? (x + half) / 10000n : -((-x + half) / 10000n);
}

/** Absolute value, for a figure that may legitimately be negative. */
const abs = (v) => (v < 0n ? -v : v);

/**
 * Money going into an audit `detail`, which is a Json column.
 *
 * Prisma cannot serialise a BigInt into Json, and an audit write is
 * best-effort — so a BigInt left in here would turn "record what happened"
 * into a silent catch. Numbers are exact to 9e15 minor units, which every
 * real figure is far below, and the audit trail is a record rather than a
 * ledger the books are reconciled from.
 */
const auditable = (v) => (typeof v === "bigint" ? Number(v) : v);

/**
 * What the caller is told about the books.
 *
 * Deliberately small and always present: `booked` is the reference if there
 * is one, and `why` is the sentence if there is not. A console that shows
 * "recorded, not booked — no chart of accounts" is telling the truth; one
 * that shows nothing leaves somebody to discover the gap at year end.
 */
const bookingOf = (b) => (b
  ? { booked: b.posted ? b.posted.ref : null, why: b.skipped || null }
  : { booked: null, why: null });

/**
 * Sum the lines, sum the payments, work out the status, write all three.
 *
 * Integer arithmetic throughout — minor units. Tax is basis points, so
 * 16% is 1600 and the division by 10,000 happens once, at the end, on a
 * number that is already an integer count of cents.
 */
export async function recomputeInvoice(invoiceId, orgId) {
  /*
   * IT TAKES THE COMPANY TOO, AND THAT IS NOT BELT AND BRACES.
   *
   * Every caller here has already loaded the invoice through own(), so the
   * id is this company's. But this function also WRITES — it is the only
   * thing that sets a total — and it is exported, so the next caller may
   * not have done that checking. A function that rewrites an invoice total
   * given nothing but an id is one mistaken call away from rewriting
   * somebody else's, so it refuses to work without knowing whose.
   */
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, orgId },
    include: { lines: true, payments: true },
  });
  if (!invoice) return null;

  let total = 0n;
  for (const l of invoice.lines) {
    const net = big(l.unitPrice) * big(l.quantity);
    total += net + taxOn(net, l.taxBps);
  }

  /* A voided payment has not been received. */
  const paid = invoice.payments
    .filter((p) => !p.voided)
    .reduce((sum, p) => sum + big(p.amount), 0n);

  /*
   * STATUS FOLLOWS THE MONEY, except where a person has decided otherwise.
   * DRAFT and VOID are decisions — an unsent invoice does not become
   * OVERDUE because a date passed, and a cancelled one does not come back
   * to life because somebody paid against it by mistake.
   */
  let status = invoice.status;
  if (status !== "DRAFT" && status !== "VOID") {
    if (paid >= total && total > 0n) status = "PAID";
    else if (paid > 0n) status = "PART_PAID";
    else if (invoice.dueOn && invoice.dueOn < new Date()) status = "OVERDUE";
    else status = "SENT";
  }

  await db.invoice.updateMany({
    where: { id: invoice.id, orgId },
    data: { total, paid, status },
  });
  return db.invoice.findFirst({
    where: { id: invoice.id, orgId },
    include: { lines: true, party: { select: { id: true, name: true, email: true } } },
  });
}

guarded.post("/invoices/:id/lines", async (req, res, next) => {
  try {
    need(req, "finance", "create", "invoices");
    const invoice = await own("invoice", req.params.id, req.actor.orgId);
    if (invoice.status === "VOID") throw conflict("That invoice is void. Raise a new one.");
    if (invoice.status === "PAID") {
      throw conflict("That invoice is paid. Adding to it would change what somebody has already settled.");
    }

    const detail = String(req.body?.detail || "").trim();
    if (!detail) throw badRequest("detail is required.");

    const quantity = Math.max(1, Math.round(Number(req.body?.quantity) || 1));
    const unitPrice = Math.round(Number(req.body?.unitPrice) || 0);
    const taxBps = Math.max(0, Math.min(10000, Math.round(Number(req.body?.taxBps) || 0)));
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw badRequest("unitPrice must be a whole number of minor units, and not negative.");
    }

    await db.invoiceLine.create({
      data: { invoiceId: invoice.id, detail, quantity, unitPrice, taxBps },
    });
    const updated = await recomputeInvoice(invoice.id, req.actor.orgId);
    await audit(req, "invoice.line.add", "invoice", invoice.id, { detail, quantity, unitPrice });

    res.status(201).json({ invoice: updated });
  } catch (e) { next(e); }
});

guarded.delete("/invoices/:id/lines/:lineId", async (req, res, next) => {
  try {
    need(req, "finance", "update", "invoices");
    const invoice = await own("invoice", req.params.id, req.actor.orgId);
    if (invoice.status === "PAID" || invoice.status === "VOID") {
      throw conflict(`That invoice is ${invoice.status.toLowerCase()}; its lines are settled.`);
    }
    const { count } = await db.invoiceLine.deleteMany({
      where: { id: req.params.lineId, invoiceId: invoice.id },
    });
    if (!count) throw hidden();

    const updated = await recomputeInvoice(invoice.id, req.actor.orgId);
    await audit(req, "invoice.line.remove", "invoice", invoice.id, { lineId: req.params.lineId });
    res.json({ invoice: updated });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 4. PAYMENTS — RECEIVED, AND NEVER UNRECEIVED.
 * ====================================================================== */

guarded.post("/payments", async (req, res, next) => {
  try {
    need(req, "finance", "create", "payments");
    const data = clean(RESOURCES.payments, req.body, { partial: false });

    if (!Number.isFinite(data.amount) || data.amount === 0) {
      throw badRequest("amount must be a whole number of minor units, and not zero.");
    }

    let invoice = null;
    if (data.invoiceId) {
      invoice = await own("invoice", data.invoiceId, req.actor.orgId);
      if (invoice.status === "VOID") throw conflict("That invoice is void.");
      /* Currency is taken FROM THE INVOICE when one is named. Two numbers in
         two currencies added together is a wrong total that looks right. */
      data.currency = invoice.currency;
    }

    let payment;
    try {
      payment = await db.payment.create({ data: { ...data, orgId: req.actor.orgId } });
    } catch (e) {
      /*
       * @@unique([orgId, method, reference]) — the same M-Pesa code cannot
       * be banked twice. This is the constraint that catches a double-submit
       * on a phone with a bad signal, which is the ordinary way it happens.
       */
      if (e.code === "P2002") {
        throw conflict(
          `A ${String(data.method || "").toLowerCase()} payment with reference ` +
          `“${data.reference}” is already recorded. It has not been taken twice.`);
      }
      throw e;
    }

    const updated = invoice ? await recomputeInvoice(invoice.id, req.actor.orgId) : null;
    await audit(req, "payment.receive", "payment", payment.id,
      { amount: auditable(payment.amount), currency: payment.currency, method: payment.method });

    /*
     * AND BOOK IT — after the payment is recorded, never before, and never in
     * a way that can undo it.
     *
     * postForPayment does not throw: a company with no chart of accounts, a
     * closed period or a withdrawn account all come back as a stated reason.
     * Refusing money that has already arrived because the books are not set
     * up would be the worse failure by a long way.
     *
     * The reason is not swallowed. It goes back in the response and into the
     * audit log, so a gap between the payments list and the ledger is always
     * visible and always explained.
     */
    const booking = await postForPayment(db, {
      orgId: req.actor.orgId, payment, invoice, userId: req.session.userId,
    });
    if (booking.skipped) {
      await audit(req, "payment.not_booked", "payment", payment.id, { why: booking.skipped });
    }

    res.status(201).json({ payment, invoice: updated, booking: bookingOf(booking) });
  } catch (e) { next(e); }
});

guarded.post("/payments/:id/void", async (req, res, next) => {
  try {
    /*
     * VOIDING IS A MANAGE-LEVEL ACT, because it is as close to deleting
     * money as this service allows. The row stays, the reason is required,
     * and both are permanent.
     */
    need(req, "finance", "delete", "payments");

    const why = String(req.body?.reason || "").trim();
    if (why.length < 5) {
      throw badRequest(
        "A void needs a reason. Whoever reads the books in six months will have " +
        "only this sentence to go on.");
    }

    const payment = await own("payment", req.params.id, req.actor.orgId);
    if (payment.voided) throw conflict("That payment is already void.");

    await db.payment.update({
      where: { id: payment.id },
      data: { voided: true, voidReason: why, voidedAt: new Date() },
    });

    const invoice = payment.invoiceId ? await recomputeInvoice(payment.invoiceId, req.actor.orgId) : null;
    await audit(req, "payment.void", "payment", payment.id,
      { reason: why, amount: auditable(payment.amount) });

    /* The books are corrected by a mirror entry, not by deleting the first
       one — so the payment, the void and the reason all stay readable. */
    const booking = await reverseFor(db, {
      orgId: req.actor.orgId, sourceType: "payment", sourceId: payment.id,
      reason: why, userId: req.session.userId,
    });
    if (booking.skipped) {
      await audit(req, "payment.void_not_booked", "payment", payment.id, { why: booking.skipped });
    }

    res.json({
      payment: await db.payment.findUnique({ where: { id: payment.id } }),
      invoice,
      booking: bookingOf(booking),
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 5. FOLIOS — a hotel bill, which belongs to a stay.
 * ====================================================================== */

guarded.get("/reservations/:id/folio", async (req, res, next) => {
  try {
    need(req, "hotel", "get", "folios");
    const reservation = await own("reservation", req.params.id, req.actor.orgId);

    let folio = await db.folio.findFirst({
      where: { reservationId: reservation.id, orgId: req.actor.orgId },
      include: { lines: { orderBy: { at: "asc" } } },
    });

    /* Opened on first look rather than at check-in, so that a folio always
       exists when somebody goes to charge something to it. */
    if (!folio) {
      folio = await db.folio.create({
        data: {
          orgId: req.actor.orgId,
          reservationId: reservation.id,
          currency: reservation.currency,
        },
        include: { lines: true },
      });
    }

    const balance = folio.lines.reduce((sum, l) => sum + big(l.amount), 0n);
    res.json({ folio, balance, currency: folio.currency });
  } catch (e) { next(e); }
});

guarded.post("/reservations/:id/folio/lines", async (req, res, next) => {
  try {
    need(req, "hotel", "create", "folios");
    const reservation = await own("reservation", req.params.id, req.actor.orgId);
    const folio = await db.folio.findFirst({
      where: { reservationId: reservation.id, orgId: req.actor.orgId },
    });
    if (!folio) throw badRequest("That stay has no folio open yet. Read it once to open one.");
    if (folio.closed) throw conflict("That folio is closed. A closed bill is a settled bill.");

    const detail = String(req.body?.detail || "").trim();
    if (!detail) throw badRequest("detail is required.");
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount)) throw badRequest("amount must be a whole number of minor units.");

    /* NEGATIVE IS ALLOWED HERE, and only here: a payment or a refund on a
       folio is a line with the sign reversed, which is how a hotel bill has
       always worked. */
    const line = await db.folioLine.create({
      data: {
        folioId: folio.id,
        kind: String(req.body?.kind || "charge").trim().toLowerCase(),
        detail, amount,
        postedBy: req.view?.user?.name || req.view?.user?.email || "",
      },
    });

    await audit(req, "folio.post", "folio", folio.id, { detail, amount });
    res.status(201).json({ line });
  } catch (e) { next(e); }
});

guarded.post("/reservations/:id/folio/close", async (req, res, next) => {
  try {
    need(req, "hotel", "update", "folios");
    const reservation = await own("reservation", req.params.id, req.actor.orgId);
    const folio = await db.folio.findFirst({
      where: { reservationId: reservation.id, orgId: req.actor.orgId },
      include: { lines: true },
    });
    if (!folio) throw hidden();
    if (folio.closed) throw conflict("That folio is already closed.");

    const balance = folio.lines.reduce((sum, l) => sum + big(l.amount), 0n);
    if (balance !== 0n && !req.body?.force) {
      throw conflict(
        `That bill does not balance — ${balance > 0n ? "outstanding" : "overpaid by"} ` +
        `${abs(balance)} ${folio.currency} in minor units. Post the payment first, ` +
        `or send force: true to close it anyway and leave the difference on the record.`);
    }

    await db.folio.update({
      where: { id: folio.id },
      data: { closed: true, closedAt: new Date() },
    });
    await audit(req, "folio.close", "folio", folio.id, { balance: auditable(balance) });
    res.json({ closed: folio.id, balance });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 6. THE GATE — admitting somebody is a decision, not an edit.
 * ====================================================================== */

guarded.post("/visits/:id/decide", async (req, res, next) => {
  try {
    need(req, "security", "update", "visits");

    const decision = String(req.body?.decision || "").trim().toUpperCase();
    if (decision !== "APPROVED" && decision !== "REFUSED") {
      throw badRequest('decision must be "approved" or "refused".');
    }
    const why = String(req.body?.reason || "").trim();
    if (decision === "REFUSED" && why.length < 3) {
      throw badRequest("Refusing somebody entry needs a reason on the record.");
    }

    const visit = await own("visit", req.params.id, req.actor.orgId);
    if (visit.status !== "WAITING") {
      throw conflict(`That visit is already ${visit.status.toLowerCase()}.`);
    }

    const row = await db.visit.update({
      where: { id: visit.id },
      data: {
        status: decision,
        decidedBy: req.view?.user?.name || req.view?.user?.email || "",
        decidedWhy: why,
        admittedAt: decision === "APPROVED" ? new Date() : null,
      },
    });

    await audit(req, "visit." + decision.toLowerCase(), "visit", visit.id,
      { visitor: visit.visitor, reason: why });
    res.json({ visit: row });
  } catch (e) { next(e); }
});

guarded.post("/visits/:id/leave", async (req, res, next) => {
  try {
    need(req, "security", "update", "visits");
    const visit = await own("visit", req.params.id, req.actor.orgId);
    if (visit.leftAt) throw conflict("That visitor is already signed out.");

    const row = await db.visit.update({
      where: { id: visit.id },
      data: { status: "LEFT", leftAt: new Date() },
    });
    await audit(req, "visit.leave", "visit", visit.id, null);
    res.json({ visit: row });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 6b. TWO LISTS THE FRAMEWORK CANNOT BUILD.
 *
 * Every other list in this file comes from registry.js, which needs a model
 * with an `orgId` of its own. These two do not have one:
 *
 *   Membership  belongs to an organization AND a user, and the generic
 *               framework would happily let somebody PATCH a role — which is
 *               how a member promotes themselves. Read-only, here, on purpose.
 *   FolioLine   belongs to a Folio, which belongs to a Reservation, which
 *               belongs to an organization. The company is two joins away.
 *
 * Both already had a screen waiting for them: the staff directory and the
 * hotel's charge list were drawing invented rows — a fabricated colleague
 * with a role, a fabricated charge against a room.
 * ====================================================================== */

/* The company's own people. Read-only: roles are changed through the
   membership flow, not by PATCHing a directory. */
guarded.get("/members", async (req, res, next) => {
  try {
    need(req, "people", "list", "people");
    const rows = await db.membership.findMany({
      where: { orgId: req.actor.orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    res.json({
      members: rows.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name || m.user.email,
        email: m.user.email,
        role: m.role,
        /* The remit, as stored. `sites` is a list of ids; the console shows
           how MANY, because a directory listing every gate each guard covers
           is a map of the company's weak points. */
        scope: m.scope && m.scope.all === true ? { all: true }
             : { sites: Array.isArray(m.scope && m.scope.sites) ? m.scope.sites.length : 0 },
        since: m.createdAt,
      })),
    });
  } catch (e) { next(e); }
});

/* Every charge and payment posted to a folio, across the property. */
guarded.get("/folio-lines", async (req, res, next) => {
  try {
    need(req, "hotel", "list", "folio lines");
    if (!req.actor.products.includes("HOTEL_MANAGEMENT")) {
      throw forbidden("This company has no hotel management, so it has no folios.");
    }
    const take = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const rows = await db.folioLine.findMany({
      /* FolioLine carries no orgId. It is scoped through its folio, which
         does — the same way every event table in this schema is scoped. */
      where: { folio: { orgId: req.actor.orgId } },
      include: {
        folio: {
          select: {
            currency: true, closed: true,
            reservation: { select: { ref: true, roomNumber: true, guestName: true } },
          },
        },
      },
      orderBy: { at: "desc" },
      take,
    });
    res.json({
      "folio-lines": rows.map((l) => ({
        id: l.id, kind: l.kind, detail: l.detail, amount: l.amount, at: l.at,
        currency: l.folio.currency,
        closed: l.folio.closed,
        ref: l.folio.reservation ? l.folio.reservation.ref : "",
        roomNumber: l.folio.reservation ? l.folio.reservation.roomNumber : "",
        guestName: l.folio.reservation ? l.folio.reservation.guestName : "",
        /* postedBy is deliberately absent — see the note in guest.js. Who
           keyed a charge is staff information, not a line on a report. */
      })),
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 7. WHAT A CONSOLE OPENS ON.
 *
 * One request rather than nine. A front desk loading nine separate lists to
 * draw one screen is nine round trips on a hotel's wifi, and the screen
 * assembles itself visibly.
 * ====================================================================== */

guarded.get("/summary", async (req, res, next) => {
  try {
    const orgId = req.actor.orgId;
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    /*
     * Every count is scoped, and each is skipped entirely when the role
     * cannot see that area — a guard's summary must not carry the number of
     * unpaid invoices, because that number is itself information.
     *
     * AND SCOPED AGAIN BY SITE, where the model carries one.
     *
     * Without this a site manager reads "2 sites" on the tile above a list
     * showing one, and the number they cannot reconcile is the number they
     * stop trusting. A count is information too: "14 open incidents" across
     * a company tells somebody restricted to one gate how busy the others
     * are. `at(model)` returns nothing when the model has no site, which is
     * the same honest limit the lists have — see src/domain/scope.js.
     */
    const at = (model) => scopedTo(req.actor, model) || {};
    const may = (area) => allows(req.actor, area, "list");
    const has = (product) => req.actor.products.includes(product);

    const jobs = {};
    if (may("property") && has("PROPERTY_MANAGEMENT")) {
      jobs.units = db.unit.count({ where: { orgId, ...at("unit") } });
      jobs.vacantUnits = db.unit.count({ where: { orgId, ...at("unit"), status: "VACANT" } });
      jobs.activeLeases = db.lease.count({ where: { orgId, status: "ACTIVE" } });
    }
    if (may("maintenance")) {
      jobs.openWorkOrders = db.workOrder.count({
        where: { orgId, ...at("workOrder"),
                 status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "BLOCKED"] } },
      });
      jobs.urgentWorkOrders = db.workOrder.count({
        where: { orgId, ...at("workOrder"),
                 priority: "URGENT", status: { notIn: ["DONE", "CANCELLED"] } },
      });
    }
    if (may("hotel") && has("HOTEL_MANAGEMENT")) {
      jobs.arrivalsToday = db.reservation.count({
        where: { orgId, arriveOn: { gte: startOfDay }, status: { in: ["CONFIRMED", "PENDING"] } },
      });
      jobs.inHouse = db.reservation.count({ where: { orgId, status: "CHECKED_IN" } });
      jobs.roomsToClean = db.room.count({ where: { orgId, ...at("room"), housekeeping: "DIRTY" } });
    }
    if (may("agent") && has("AGENT_HOST")) {
      jobs.liveListings = db.listing.count({ where: { orgId, status: "LIVE" } });
      jobs.openLeads = db.lead.count({ where: { orgId, stage: { notIn: ["CLOSED", "LOST"] } } });
    }
    if (may("security") && has("SECURITY_MANAGEMENT")) {
      jobs.visitorsWaiting = db.visit.count({ where: { orgId, ...at("visit"), status: "WAITING" } });
      jobs.visitorsInside = db.visit.count({ where: { orgId, ...at("visit"), status: "INSIDE" } });
      jobs.openIncidents = db.incident.count({
        where: { orgId, ...at("incident"), status: { notIn: ["CLOSED", "RESOLVED"] } },
      });
    }
    if (may("finance")) {
      jobs.unpaidInvoices = db.invoice.count({
        where: { orgId, status: { in: ["SENT", "PART_PAID", "OVERDUE"] } },
      });
      jobs.overdueInvoices = db.invoice.count({ where: { orgId, status: "OVERDUE" } });
    }

    const keys = Object.keys(jobs);
    const values = await Promise.all(keys.map((k) => jobs[k]));
    const counts = Object.fromEntries(keys.map((k, i) => [k, values[i]]));

    res.json({
      organization: { id: orgId, name: req.actor.orgName },
      role: req.actor.role,
      products: req.actor.products,
      counts,
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * PALTAS CONNECT — SYNCING A CHANNEL.
 *
 * The CRUD for `channels` is built by the framework above, because a channel
 * row is a resource like any other. Syncing one is not: it is work against an
 * outside system that either happened or did not, and the operator pressing
 * the button is entitled to know which.
 *
 * Both endpoints go through domain/channels.js, which refuses when no channel
 * manager is attached. That refusal is the correct production behaviour right
 * now — see the header of that file for why it is a 503 and not a quiet
 * success.
 * ====================================================================== */

guarded.post("/channels/:id/sync", async (req, res, next) => {
  try {
    need(req, "hotel", "update", "channels");

    const channel = await own("channel", req.params.id, req.actor.orgId);
    if (channel.status === "PAUSED") {
      throw conflict(
        `${channel.name} is paused. Resume it before syncing, or it will be ` +
        "handed inventory it is not meant to be selling.");
    }

    /* Throws ChannelUnavailable (503) when nothing is attached. Deliberately
       NOT caught here: the whole point is that the caller hears it. */
    const out = await syncChannel(channel);

    const row = await db.channel.update({
      where: { id: channel.id },
      data: { lastSyncAt: out.at, status: "LIVE" },
    });

    await audit(req, "channel.sync", "channel", channel.id,
      { manager: out.manager, pushed: out.pushed, pulled: out.pulled });
    res.json({ channel: row, sync: out });
  } catch (e) { next(e); }
});

/**
 * POST /channels/sync — every live channel.
 *
 * Reports per channel rather than as one number. "12 channels synced" is the
 * shape of the toast this replaces, and it was wrong precisely because it
 * collapsed twelve outcomes into one cheerful sentence.
 */
guarded.post("/channels/sync", async (req, res, next) => {
  try {
    need(req, "hotel", "update", "channels");

    const rows = await db.channel.findMany({
      where: { orgId: req.actor.orgId, status: "LIVE" },
      orderBy: { name: "asc" },
    });
    if (!rows.length) {
      return res.json({ results: [], synced: 0, failed: 0, note: "No channel is live." });
    }

    const results = [];
    for (const channel of rows) {
      try {
        const out = await syncChannel(channel);
        await db.channel.update({
          where: { id: channel.id }, data: { lastSyncAt: out.at },
        });
        results.push({ id: channel.id, name: channel.name, ok: true,
                       pushed: out.pushed, pulled: out.pulled });
      } catch (e) {
        /* One channel refusing must not hide the other eleven. The failure is
           recorded against that channel and the loop continues. */
        await db.channel.update({
          where: { id: channel.id }, data: { status: "ERROR", note: e.message },
        }).catch(() => {});
        results.push({ id: channel.id, name: channel.name, ok: false, why: e.message });
      }
    }

    const synced = results.filter((r) => r.ok).length;
    await audit(req, "channel.syncAll", "channel", "", { synced, failed: results.length - synced });
    res.json({ results, synced, failed: results.length - synced });
  } catch (e) { next(e); }
});

/** GET /connect/status — whether a channel manager is attached. No secrets. */
guarded.get("/connect/status", async (req, res, next) => {
  try {
    /* Carries no credential and no company data — but the rule that every
       hand-written endpoint checks a role has no exceptions worth making,
       and whether this hotel's distribution is wired is its own business. */
    need(req, "hotel", "list", "channels");
    res.setHeader("Cache-Control", "no-store, private");
    res.json(channelStatus());
  } catch (e) { next(e); }
});

/**
 * GET /connect/rollup — what each channel actually sold.
 *
 * The console's channel KPIs used to read `res: 0, rev: 0` against real data
 * and plausible numbers against the demo array, because a Reservation had no
 * way to point at a Channel. It has one now, and this is the only place the
 * roll-up is computed — on the server, in minor units, grouped by the foreign
 * key rather than by matching a channel's name against a free-text `source`.
 *
 * Cancellations and no-shows are excluded: a channel is not owed commission
 * on a stay that did not happen, so counting them would overstate both the
 * revenue and the commission the operator thinks they are paying.
 *
 * `unattributed` is reported rather than hidden. A hotel that has just linked
 * its channels will see most of its reservations there, and that is the true
 * state — quietly spreading them across the channels would be the fabrication
 * this endpoint replaces.
 */
guarded.get("/connect/rollup", async (req, res, next) => {
  try {
    /* "list", not "read": ACT_LEVEL maps list/get/create/update/delete, and
       an act it does not name is refused for everyone. */
    need(req, "hotel", "list", "channels");

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);
    const countable = { notIn: ["CANCELLED", "NO_SHOW"] };

    const [channels, grouped, loose] = await Promise.all([
      db.channel.findMany({
        where: { orgId: req.actor.orgId },
        orderBy: { name: "asc" },
      }),
      db.reservation.groupBy({
        by: ["channelId"],
        where: {
          orgId: req.actor.orgId,
          createdAt: { gte: since },
          status: countable,
          channelId: { not: null },
        },
        _count: { _all: true },
        _sum: { rate: true },
      }),
      db.reservation.count({
        where: {
          orgId: req.actor.orgId,
          createdAt: { gte: since },
          status: countable,
          channelId: null,
        },
      }),
    ]);

    const by = new Map(grouped.map((g) => [g.channelId, g]));

    const rows = channels.map((c) => {
      const g = by.get(c.id);
      /* `rate` is BigInt minor units. Number() only after summing, and the
         commission is taken from the same integer — never from a float that
         has already been divided for display. */
      const revenue = g?._sum?.rate ? Number(g._sum.rate) : 0;
      return {
        id: c.id,
        name: c.name,
        mark: c.mark || "",
        status: c.status,
        mapped: c.mapped || 0,
        total: c.total || 0,
        lastSyncAt: c.lastSyncAt,
        note: c.note || "",
        reservations: g?._count?._all || 0,
        revenueMinor: revenue,
        commissionMinor: Math.round((revenue * (c.commissionBps || 0)) / 10_000),
        commissionBps: c.commissionBps || 0,
      };
    });

    res.setHeader("Cache-Control", "no-store, private");
    res.json({
      days,
      since: since.toISOString(),
      channels: rows,
      unattributed: loose,
      basis: "Reservations booked in the window, excluding cancellations and no-shows, grouped by the channel recorded against each one.",
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * DOCUMENTS — ATTACHING THE ACTUAL FILE.
 *
 * The Document row has always described a file. These three endpoints are how
 * the file gets there, and they exist because a company being asked to supply
 * a certificate of incorporation could previously only type its name.
 *
 * The bytes never pass through PALTAS. The browser is given a short-lived,
 * single-purpose URL and uploads straight to storage:
 *
 *   1. POST /documents/:id/upload-url   permission to write ONE object
 *   2. the browser PUTs the file to that URL
 *   3. POST /documents/:id/attached     confirm, and record what is really there
 *   4. GET  /documents/:id/download-url a short-lived link to read it back
 *
 * Step 3 is not a formality. It asks STORAGE what was stored rather than
 * believing the browser that said it finished, because a client reporting a
 * size and type it did not upload is the easiest possible thing to do.
 * ====================================================================== */

guarded.get("/storage/status", (req, res, next) => {
  try {
    /* Behind the same permission as documents themselves. Someone who cannot
       see this company's documents has no business knowing how they are
       stored — and routing.test.js is right to insist every hand-written
       endpoint answers the question rather than assuming it is harmless. */
    need(req, "documents", "read", "documents");
    /* Whether uploads work, without naming a missing environment variable to a
       customer — they cannot act on one. An operator reads describe(). */
    res.json({ storage: storagePublicDescribe() });
  } catch (e) { next(e); }
});

guarded.post("/documents/:id/upload-url", async (req, res, next) => {
  try {
    need(req, "documents", "write", "documents");
    const orgId = req.actor.orgId;
    const doc = await own("document", String(req.params.id), orgId);

    const out = presignUpload({
      orgId, documentId: doc.id,
      filename: String(req.body?.filename || doc.name || "file"),
      contentType: req.body?.contentType,
      bytes: req.body?.bytes,
    });
    if (!out.ok) throw badRequest(out.why);

    /*
     * The key is recorded NOW, before the upload, so a file that lands in
     * storage always has a row pointing at it. The other order leaves an
     * orphan whenever a browser uploads and then closes.
     *
     * bytes/mimeType stay at zero until confirmed — the row says "a file was
     * started here", not "a file is here".
     */
    await db.document.updateMany({
      where: { id: doc.id, orgId },
      data: { storageKey: out.storageKey, bytes: 0, checksum: "", mimeType: "" },
    });
    await audit(req, "document.upload.begin", "document", doc.id,
      { filename: out.headers["Content-Type"] });

    res.json({
      upload: {
        url: out.url, method: out.method, headers: out.headers,
        expiresIn: out.expiresIn,
      },
      note: "PUT the file to this URL with exactly these headers, then call " +
            "/documents/" + doc.id + "/attached.",
    });
  } catch (e) { next(e); }
});

guarded.post("/documents/:id/attached", async (req, res, next) => {
  try {
    need(req, "documents", "write", "documents");
    const orgId = req.actor.orgId;
    const doc = await own("document", String(req.params.id), orgId);
    if (!doc.storageKey) throw badRequest("No upload was started for this document.");

    const found = await storageHead({ storageKey: doc.storageKey, orgId });
    if (!found.ok) throw badRequest(found.why);

    const row = await db.document.update({
      where: { id: doc.id },
      data: { bytes: found.bytes, mimeType: found.mimeType, checksum: found.checksum },
    });
    await audit(req, "document.upload.finish", "document", doc.id,
      { bytes: found.bytes, mimeType: found.mimeType });
    res.json({ document: row });
  } catch (e) { next(e); }
});

guarded.get("/documents/:id/download-url", async (req, res, next) => {
  try {
    need(req, "documents", "read", "documents");
    const orgId = req.actor.orgId;
    const doc = await own("document", String(req.params.id), orgId);

    /*
     * own() has already established the row is this company's. The key is
     * checked AGAIN inside presignDownload, against the same organization.
     * Two independent guards on the same question, because a storage key that
     * escaped its tenant is the failure that would be silent.
     */
    const out = presignDownload({ storageKey: doc.storageKey, orgId, filename: doc.name });
    if (!out.ok) throw badRequest(out.why);

    /* Reading somebody's title deed is a thing that should be answerable
       later, so it is recorded at the time. */
    await audit(req, "document.download", "document", doc.id, { name: doc.name });
    res.set("Cache-Control", "no-store, private");
    res.json({ download: { url: out.url, expiresIn: out.expiresIn } });
  } catch (e) { next(e); }
});
