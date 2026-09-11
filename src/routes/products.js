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
import { db } from "../db.js";
import { RESOURCES } from "../domain/registry.js";
import { resourceRouter } from "../http/resource.js";
import { clean } from "../domain/input.js";
import { allows, whyNotArea } from "../domain/access.js";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.js";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.js";

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

  let total = 0;
  for (const l of invoice.lines) {
    const net = l.unitPrice * l.quantity;
    total += net + Math.round((net * l.taxBps) / 10000);
  }

  /* A voided payment has not been received. */
  const paid = invoice.payments
    .filter((p) => !p.voided)
    .reduce((sum, p) => sum + p.amount, 0);

  /*
   * STATUS FOLLOWS THE MONEY, except where a person has decided otherwise.
   * DRAFT and VOID are decisions — an unsent invoice does not become
   * OVERDUE because a date passed, and a cancelled one does not come back
   * to life because somebody paid against it by mistake.
   */
  let status = invoice.status;
  if (status !== "DRAFT" && status !== "VOID") {
    if (paid >= total && total > 0) status = "PAID";
    else if (paid > 0) status = "PART_PAID";
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
      { amount: payment.amount, currency: payment.currency, method: payment.method });

    res.status(201).json({ payment, invoice: updated });
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
    await audit(req, "payment.void", "payment", payment.id, { reason: why, amount: payment.amount });

    res.json({ payment: await db.payment.findUnique({ where: { id: payment.id } }), invoice });
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

    const balance = folio.lines.reduce((sum, l) => sum + l.amount, 0);
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

    const balance = folio.lines.reduce((sum, l) => sum + l.amount, 0);
    if (balance !== 0 && !req.body?.force) {
      throw conflict(
        `That bill does not balance — ${balance > 0 ? "outstanding" : "overpaid by"} ` +
        `${Math.abs(balance)} ${folio.currency} in minor units. Post the payment first, ` +
        `or send force: true to close it anyway and leave the difference on the record.`);
    }

    await db.folio.update({
      where: { id: folio.id },
      data: { closed: true, closedAt: new Date() },
    });
    await audit(req, "folio.close", "folio", folio.id, { balance });
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
     */
    const may = (area) => allows(req.actor, area, "list");
    const has = (product) => req.actor.products.includes(product);

    const jobs = {};
    if (may("property") && has("PROPERTY_MANAGEMENT")) {
      jobs.units = db.unit.count({ where: { orgId } });
      jobs.vacantUnits = db.unit.count({ where: { orgId, status: "VACANT" } });
      jobs.activeLeases = db.lease.count({ where: { orgId, status: "ACTIVE" } });
    }
    if (may("maintenance")) {
      jobs.openWorkOrders = db.workOrder.count({
        where: { orgId, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "BLOCKED"] } },
      });
      jobs.urgentWorkOrders = db.workOrder.count({
        where: { orgId, priority: "URGENT", status: { notIn: ["DONE", "CANCELLED"] } },
      });
    }
    if (may("hotel") && has("HOTEL_MANAGEMENT")) {
      jobs.arrivalsToday = db.reservation.count({
        where: { orgId, arriveOn: { gte: startOfDay }, status: { in: ["CONFIRMED", "PENDING"] } },
      });
      jobs.inHouse = db.reservation.count({ where: { orgId, status: "CHECKED_IN" } });
      jobs.roomsToClean = db.room.count({ where: { orgId, housekeeping: "DIRTY" } });
    }
    if (may("agent") && has("AGENT_HOST")) {
      jobs.liveListings = db.listing.count({ where: { orgId, status: "LIVE" } });
      jobs.openLeads = db.lead.count({ where: { orgId, stage: { notIn: ["CLOSED", "LOST"] } } });
    }
    if (may("security") && has("SECURITY_MANAGEMENT")) {
      jobs.visitorsWaiting = db.visit.count({ where: { orgId, status: "WAITING" } });
      jobs.visitorsInside = db.visit.count({ where: { orgId, status: "INSIDE" } });
      jobs.openIncidents = db.incident.count({
        where: { orgId, status: { notIn: ["CLOSED", "RESOLVED"] } },
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
