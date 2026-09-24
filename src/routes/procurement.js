/* ====================================================================== *
 * BUYING THINGS, AND CHANGING WHAT WAS AGREED.
 *
 * ── THE TWO RULES EVERYTHING HERE IS BUILT ON ──────────────────────────
 *
 * FINANCE STAYS AUTHORITATIVE. Nothing in this file records money. A purchase
 * order is a commitment, a goods receipt is a delivery, and neither is a
 * transaction — the moment the invoice arrives it becomes an Expense, which
 * is what the ledger and every report reads. The obvious mistake is a "paid"
 * column on a purchase order, and the cost of it is that a company then has
 * two answers to "what have we spent" and no way to tell which is right.
 *
 * THE ORIGINAL CONTRACT VALUE IS NEVER TOUCHED. A variation does not edit
 * Contract.price. It is its own record, and the contract's current value is
 * what was signed plus every APPROVED variation — computed, never stored. A
 * contract worth £4.3m with no record that it was signed at £3.9m cannot
 * answer the question every dispute turns on.
 *
 * ── AND THE SMALLER ONES ───────────────────────────────────────────────
 *
 *   an order's total is computed from its lines, never sent;
 *   an order cannot be issued with nothing on it;
 *   more cannot be received than was ordered;
 *   an award declines the others, and says why this one.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { numberFor } from "../http/resource.js";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const procurementRoutes = Router();

procurementRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

/*
 * Procurement is FINANCE's area, not property's.
 *
 * Because committing the company to pay somebody is a money decision even
 * though no money has moved: an issued purchase order is a liability, and the
 * person who may raise one is the person who may be trusted with that. A site
 * manager who may record a defect must not be able to order £200,000 of steel.
 */
function need(req, act, label) {
  const why = whyNotArea(req.actor, "finance", act, label);
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

const who = (req) => req.view?.user?.name || req.view?.user?.email || "";
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/** A whole number of minor units. Never a float — see PurchaseLine.quantity. */
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!Number.isSafeInteger(Math.trunc(n))) return null;
  return BigInt(Math.trunc(n));
}

/** Thousandths. 1.5 tonnes is sent as 1500. */
function qty(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

/** Thousandths × minor units, back to minor units, rounded down to the unit. */
function lineTotal(quantity, unitPrice) {
  return (BigInt(quantity) * unitPrice) / 1000n;
}

async function audit(req, action, entity, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        orgId: req.actor.orgId, actorId: req.session.userId, actorName: who(req),
        action, entity, entityId: entityId || "", detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, e.message); }
}

/* One lookup per table, named, so the scoping scanner can read them. */
async function ownRfq(req, id) {
  const row = await db.rfq.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownQuote(req, id) {
  const row = await db.quote.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownOrder(req, id, extra) {
  const row = await db.purchaseOrder.findFirst({
    where: { id, orgId: req.actor.orgId }, ...(extra || {}),
  });
  if (!row) throw hidden();
  return row;
}
async function ownChange(req, id) {
  const row = await db.changeOrder.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownContract(req, id) {
  const row = await db.contract.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}

/* ====================================================================== *
 * ASKING, AND CHOOSING
 * ====================================================================== */

/** POST /rfqs/:id/issue — it goes out, and stops being a draft. */
procurementRoutes.post("/rfqs/:id/issue", route(async (req, res) => {
  need(req, "update", "rfqs");
  const rfq = await ownRfq(req, req.params.id);
  if (rfq.status !== "DRAFT") throw conflict(`${rfq.ref} has already been issued.`);

  const out = await db.rfq.update({
    where: { id: rfq.id }, data: { status: "ISSUED", issuedOn: new Date() },
  });
  await audit(req, "rfq.issue", "rfq", rfq.id, { ref: rfq.ref });
  res.json({
    rfq: out,
    /* It does not claim anybody was told. Sending it is the communications
       layer's job, and that layer says honestly whether anything carried it. */
    said: `${rfq.ref} is open for quotes. Sending it to vendors is a separate step.`,
  });
}));

/**
 * POST /rfqs/:id/award
 *
 * Awarding does four things at once: the quote wins, the others are declined,
 * the request is settled, and a purchase order exists at the quoted figure.
 * Any of those happening without the rest is a procurement record that cannot
 * be defended — an award with no order, or an order at a price nobody quoted.
 */
procurementRoutes.post("/rfqs/:id/award", route(async (req, res) => {
  need(req, "create", "purchase-orders");
  const rfq = await ownRfq(req, req.params.id);
  const orgId = req.actor.orgId;

  if (rfq.status === "AWARDED") {
    throw conflict(`${rfq.ref} has already been awarded. Awarding twice would buy it twice.`);
  }
  if (rfq.status === "CANCELLED") throw conflict(`${rfq.ref} was cancelled.`);

  const quote = await ownQuote(req, text(req.body?.quoteId, 60));
  if (quote.rfqId !== rfq.id) {
    throw badRequest("That quote was given against a different request.");
  }
  /* The reasoning, required. An award with none is the one somebody asks
     about eighteen months later and nobody can answer. */
  const why = text(req.body?.note, 2000);
  if (!why) {
    throw badRequest(
      "An award needs a reason — why this quote and not the others. It is the only " +
      "thing that makes the decision defensible later.");
  }

  const others = await db.quote.findMany({
    where: { orgId, rfqId: rfq.id, id: { not: quote.id } }, select: { id: true },
  });

  const ref = await numberFor("purchase-orders", orgId);
  const [, , , order] = await db.$transaction([
    db.quote.update({
      where: { id: quote.id },
      data: { status: "AWARDED", decidedNote: why },
    }),
    db.quote.updateMany({
      where: { orgId, rfqId: rfq.id, id: { not: quote.id } },
      data: { status: "DECLINED" },
    }),
    db.rfq.update({ where: { id: rfq.id }, data: { status: "AWARDED" } }),
    db.purchaseOrder.create({
      data: {
        orgId, ref, projectId: rfq.projectId, rfqId: rfq.id, quoteId: quote.id,
        vendorId: quote.vendorId, vendorName: quote.vendorName,
        title: rfq.title, description: rfq.description,
        /* AT THE QUOTED FIGURE, not at one the caller sends. An order that
           could differ from the quote it came from is an order nobody
           actually quoted for. */
        subtotal: quote.amount, tax: 0n, total: quote.amount,
        currency: quote.currency, status: "DRAFT",
        createdById: req.session.userId, createdByName: who(req),
      },
    }),
  ]);

  await audit(req, "rfq.award", "rfq", rfq.id,
    { ref: rfq.ref, quote: quote.ref, order: order.ref, declined: others.length });

  res.json({
    rfq: { ...rfq, status: "AWARDED" }, quote: { ...quote, status: "AWARDED" },
    order, declined: others.length,
    said: `${quote.vendorName || "The vendor"} awarded. ${order.ref} opened as a draft ` +
          `at the quoted figure, and ${others.length} other quote${
            others.length === 1 ? " was" : "s were"} declined.`,
  });
}));

/* ====================================================================== *
 * ORDERING
 * ====================================================================== */

/**
 * Recompute an order's figures FROM ITS LINES. The only place they are set.
 *
 * Takes the orgId rather than trusting that the caller checked: the order was
 * already proved to belong to this company, so this is belt and braces — but
 * it is the kind of belt that costs nothing and the kind of braces that has
 * saved somebody's data before.
 */
async function retotal(orgId, orderId, tax) {
  const lines = await db.purchaseLine.findMany({ where: { orgId, orderId } });
  const subtotal = lines.reduce((t, l) => t + l.total, 0n);
  const t = tax === undefined ? undefined : tax;
  return db.purchaseOrder.update({
    where: { id: orderId },
    data: {
      subtotal,
      ...(t === undefined ? {} : { tax: t }),
      total: subtotal + (t === undefined ? 0n : t),
    },
  });
}

/** POST /purchase-orders/:id/lines — what is being bought. */
procurementRoutes.post("/purchase-orders/:id/lines", route(async (req, res) => {
  need(req, "update", "purchase-orders");
  const order = await ownOrder(req, req.params.id);
  if (order.status !== "DRAFT") {
    throw conflict(
      `${order.ref} has been issued. Changing what was ordered afterwards is a ` +
      `variation, not an edit.`);
  }

  const description = text(req.body?.description, 500);
  if (!description) throw badRequest("A line needs to say what is being bought.");
  const unitPrice = money(req.body?.unitPrice);
  if (unitPrice === null || unitPrice < 0n) {
    throw badRequest("A line needs a price, in minor units, that is not negative.");
  }
  const quantity = qty(req.body?.quantity, 1000);
  if (!quantity) throw badRequest("A line needs a quantity. Quantities are in thousandths — 1.5 is 1500.");

  const count = await db.purchaseLine.count({ where: { orderId: order.id } });
  const line = await db.purchaseLine.create({
    data: {
      orgId: req.actor.orgId, orderId: order.id, position: count + 1,
      description, quantity, unit: text(req.body?.unit, 40),
      unitPrice, total: lineTotal(quantity, unitPrice),
    },
  });
  const out = await retotal(req.actor.orgId, order.id, order.tax);
  await audit(req, "purchase.line", "purchaseOrder", order.id, { ref: order.ref });
  res.status(201).json({ line, order: out });
}));

/** DELETE /purchase-orders/:id/lines/:lineId — while it is still a draft. */
procurementRoutes.delete("/purchase-orders/:id/lines/:lineId", route(async (req, res) => {
  need(req, "update", "purchase-orders");
  const order = await ownOrder(req, req.params.id);
  if (order.status !== "DRAFT") {
    throw conflict(`${order.ref} has been issued. Its lines are what was ordered.`);
  }
  const removed = await db.purchaseLine.deleteMany({
    where: { orgId: req.actor.orgId, orderId: order.id, id: req.params.lineId },
  });
  if (!removed.count) throw hidden();
  const out = await retotal(req.actor.orgId, order.id, order.tax);
  /* Adding a line was audited and removing one was not, which is the worse
     half to miss: taking something off an order changes what is being bought
     and leaves nothing behind to say it was ever on it. */
  await audit(req, "purchase.line.remove", "purchaseOrder", order.id,
    { ref: order.ref, lineId: req.params.lineId });
  res.json({ order: out });
}));

/**
 * POST /purchase-orders/:id/issue
 *
 * The moment the company is committed. An order with nothing on it, or a
 * total of nothing, is not a commitment — it is a mistake about to be sent to
 * a supplier.
 */
procurementRoutes.post("/purchase-orders/:id/issue", route(async (req, res) => {
  need(req, "update", "purchase-orders");
  const order = await ownOrder(req, req.params.id, { include: { lines: true } });

  if (order.status !== "DRAFT") throw conflict(`${order.ref} has already been issued.`);
  if (!order.lines.length && order.total === 0n) {
    throw badRequest(
      `${order.ref} has nothing on it. An order with no lines and no value is not a ` +
      `commitment, it is a mistake about to go to a supplier.`);
  }
  if (!order.vendorId && !order.vendorName) {
    throw badRequest("An order needs somebody to send it to.");
  }

  const tax = req.body?.tax === undefined ? undefined : money(req.body.tax);
  if (req.body?.tax !== undefined && tax === null) throw badRequest("Tax must be a whole number of minor units.");
  if (tax !== undefined) await retotal(req.actor.orgId, order.id, tax);

  const out = await db.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: "ISSUED", issuedOn: new Date(),
      expectedOn: req.body?.expectedOn ? new Date(req.body.expectedOn) : order.expectedOn,
    },
  });
  await audit(req, "purchase.issue", "purchaseOrder", order.id,
    { ref: order.ref, total: String(out.total) });

  res.json({
    order: out,
    /* Committed, not spent. The distinction is the whole design. */
    said: `${order.ref} issued. The company is committed to ${out.currency} ` +
          `${(Number(out.total) / 100).toFixed(2)} — nothing has been spent until the ` +
          `invoice is recorded.`,
  });
}));

/**
 * POST /purchase-orders/:id/receive
 *
 * A delivery. More cannot be received than was ordered: a receipt that exceeds
 * the order is either a supplier's mistake or a typo, and accepting it
 * silently means paying for it.
 */
procurementRoutes.post("/purchase-orders/:id/receive", route(async (req, res) => {
  need(req, "update", "purchase-orders");
  const order = await ownOrder(req, req.params.id, { include: { lines: true } });
  const orgId = req.actor.orgId;

  if (!["ISSUED", "PARTIALLY_RECEIVED"].includes(order.status)) {
    throw conflict(
      `${order.ref} is ${order.status.toLowerCase().replace(/_/g, " ")}. ` +
      `Only an issued order can take a delivery.`);
  }

  const sent = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!sent.length) throw badRequest("A delivery needs at least one line.");

  const byId = new Map(order.lines.map((l) => [l.id, l]));
  const over = [];
  const accepted = [];
  for (const s of sent) {
    const line = byId.get(text(s?.lineId, 60));
    if (!line) throw badRequest("One of those lines is not on this order.");
    const n = qty(s?.quantity, 0);
    if (!n) continue;
    if (line.receivedQty + n > line.quantity) {
      over.push(
        `${line.description}: ${(n / 1000).toFixed(3)} would take the total to ` +
        `${((line.receivedQty + n) / 1000).toFixed(3)} against ` +
        `${(line.quantity / 1000).toFixed(3)} ordered`);
      continue;
    }
    accepted.push({ line, quantity: n, condition: text(s?.condition, 160), note: text(s?.note, 1000) });
  }

  if (over.length) {
    throw conflict(
      `More would be received than was ordered:\n  ${over.join("\n  ")}\n\n` +
      `Nothing has been recorded. Raise a variation if the order itself is wrong.`);
  }
  if (!accepted.length) throw badRequest("Nothing was actually received.");

  const ref = await numberFor("goods-receipts", orgId);
  const receipt = await db.$transaction(async (tx) => {
    const made = await tx.goodsReceipt.create({
      data: {
        orgId, ref, orderId: order.id,
        receivedOn: req.body?.receivedOn ? new Date(req.body.receivedOn) : new Date(),
        receivedBy: text(req.body?.receivedBy, 160) || who(req),
        deliveryNote: text(req.body?.deliveryNote, 120),
        note: text(req.body?.note, 2000),
      },
    });
    for (const a of accepted) {
      await tx.goodsReceiptLine.create({
        data: {
          orgId, receiptId: made.id, lineId: a.line.id,
          quantity: a.quantity, condition: a.condition, note: a.note,
        },
      });
      await tx.purchaseLine.update({
        where: { id: a.line.id },
        data: { receivedQty: { increment: a.quantity } },
      });
    }
    return made;
  });

  /* Fully or partly — decided from the lines rather than from what the
     delivery claimed, because the lines are what actually arrived. */
  const after = await db.purchaseLine.findMany({ where: { orgId, orderId: order.id } });
  const complete = after.every((l) => l.receivedQty >= l.quantity);
  const out = await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED" },
  });

  await audit(req, "purchase.receive", "purchaseOrder", order.id,
    { ref: order.ref, receipt: receipt.ref, complete });

  res.json({
    receipt, order: out, complete,
    outstanding: after
      .filter((l) => l.receivedQty < l.quantity)
      .map((l) => ({ id: l.id, description: l.description,
                     short: (l.quantity - l.receivedQty) / 1000 })),
    said: complete
      ? `${receipt.ref} recorded. Everything on ${order.ref} has now arrived.`
      : `${receipt.ref} recorded. ${order.ref} is still short of some lines.`,
  });
}));

/**
 * POST /purchase-orders/:id/invoice
 *
 * WHERE THE MONEY FINALLY EXISTS — and it exists as an Expense, which is what
 * the ledger and every report read. The order points at it; the order never
 * holds a figure anybody spends.
 */
procurementRoutes.post("/purchase-orders/:id/invoice", route(async (req, res) => {
  need(req, "create", "expenses");
  const order = await ownOrder(req, req.params.id);

  if (order.status === "DRAFT") {
    throw conflict(`${order.ref} has not been issued. There is nothing to be invoiced for.`);
  }
  if (order.expenseId) {
    throw conflict(
      `${order.ref} is already in the books. Recording it twice would double the cost.`);
  }

  const amount = req.body?.amount === undefined ? order.total : money(req.body.amount);
  if (amount === null || amount < 0n) throw badRequest("An invoice needs an amount in minor units.");

  const expense = await db.expense.create({
    data: {
      orgId: req.actor.orgId, partyId: order.vendorId,
      detail: `${order.ref} — ${order.title}`,
      category: "Procurement",
      amount, currency: order.currency,
      spentOn: req.body?.invoicedOn ? new Date(req.body.invoicedOn) : new Date(),
      note: text(req.body?.note, 2000),
    },
  });
  const out = await db.purchaseOrder.update({
    where: { id: order.id },
    data: { expenseId: expense.id, status: "CLOSED", closedOn: new Date() },
  });
  await audit(req, "purchase.invoice", "purchaseOrder", order.id,
    { ref: order.ref, expenseId: expense.id, amount: String(amount) });

  /* The difference between what was committed and what was billed. Nobody
     reads a purchase order to find this out, and everybody wants to know. */
  const variance = amount - order.total;
  res.json({
    order: out, expense,
    variance: String(variance),
    said: variance === 0n
      ? `${order.ref} invoiced as ordered and recorded in the books.`
      : `${order.ref} invoiced ${variance > 0n ? "above" : "below"} the order by ` +
        `${order.currency} ${(Number(variance < 0n ? -variance : variance) / 100).toFixed(2)}. ` +
        `The books carry what was invoiced.`,
  });
}));

/** POST /purchase-orders/:id/cancel — before anything arrives. */
procurementRoutes.post("/purchase-orders/:id/cancel", route(async (req, res) => {
  need(req, "update", "purchase-orders");
  const order = await ownOrder(req, req.params.id, { include: { lines: true } });
  if (order.expenseId) {
    throw conflict(`${order.ref} has been invoiced. Cancelling it would not unspend the money.`);
  }
  if (order.lines.some((l) => l.receivedQty > 0)) {
    throw conflict(
      `Part of ${order.ref} has already arrived. Cancelling it would leave goods on ` +
      `site that the company has no record of ordering.`);
  }
  const reason = text(req.body?.reason, 1000);
  if (!reason) throw badRequest("Cancelling an order needs a reason — a supplier was told to expect it.");

  const out = await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: "CANCELLED", description: order.description, closedOn: new Date() },
  });
  await audit(req, "purchase.cancel", "purchaseOrder", order.id, { ref: order.ref, reason });
  res.json({ order: out });
}));

/** GET /purchase-orders/committed — what the company owes but has not spent. */
procurementRoutes.get("/purchase-orders/committed", route(async (req, res) => {
  need(req, "list", "purchase-orders");
  const orgId = req.actor.orgId;
  const live = { in: ["ISSUED", "PARTIALLY_RECEIVED", "RECEIVED"] };
  const rows = await db.purchaseOrder.findMany({
    where: { orgId, status: live }, orderBy: { issuedOn: "asc" }, take: 300,
    include: { project: { select: { id: true, name: true } } },
  });
  /* Grouped by currency, because adding shillings to pounds is how a
     commitment figure becomes nonsense. */
  const byCurrency = {};
  for (const r of rows) {
    byCurrency[r.currency] = (byCurrency[r.currency] || 0n) + r.total;
  }
  res.json({
    orders: rows, count: rows.length,
    committed: Object.fromEntries(Object.entries(byCurrency).map(([k, v]) => [k, String(v)])),
    /* Said plainly: this is not an expense and does not appear in the books. */
    means: "Money the company has promised and not yet spent. It is not in the " +
           "ledger until the invoice is recorded.",
  });
}));

/* ====================================================================== *
 * VARIATIONS
 * ====================================================================== */

/** POST /change-orders/:id/submit — it goes for a decision. */
procurementRoutes.post("/change-orders/:id/submit", route(async (req, res) => {
  need(req, "update", "change-orders");
  const co = await ownChange(req, req.params.id);
  if (co.status !== "DRAFT") throw conflict(`${co.ref} has already been submitted.`);
  if (co.amount === 0n && co.days === 0) {
    throw badRequest(
      "A variation that changes neither the price nor the programme is not a variation.");
  }
  const out = await db.changeOrder.update({
    where: { id: co.id }, data: { status: "SUBMITTED", submittedOn: new Date() },
  });
  await audit(req, "change.submit", "changeOrder", co.id, { ref: co.ref });
  res.json({ changeOrder: out });
}));

/**
 * POST /change-orders/:id/decide
 *
 * Approving one changes what a contract is worth WITHOUT touching what it was
 * signed at. Both figures survive, which is the only reason a variation
 * register is worth keeping.
 */
procurementRoutes.post("/change-orders/:id/decide", route(async (req, res) => {
  need(req, "update", "change-orders");
  const co = await ownChange(req, req.params.id);

  if (co.status !== "SUBMITTED") {
    throw conflict(
      `${co.ref} is ${co.status.toLowerCase()}. Only a submitted variation can be decided.`);
  }
  const approve = req.body?.approve === true;
  const by = text(req.body?.decidedBy, 160) || who(req);
  const note = text(req.body?.note, 2000);

  /* A rejection must say why; an approval must say who. Both for the same
     reason — an unexplained decision about money is the one that turns out to
     have been nobody's. */
  if (!approve && !note) {
    throw badRequest("Turning down a variation needs a reason.");
  }

  const out = await db.changeOrder.update({
    where: { id: co.id },
    data: {
      status: approve ? "APPROVED" : "REJECTED",
      decidedOn: new Date(), decidedBy: by, decidedNote: note,
    },
  });
  await audit(req, "change.decide", "changeOrder", co.id,
    { ref: co.ref, approve, amount: String(co.amount) });

  /* What the contract is worth NOW — computed here, stored nowhere. */
  let contract = null;
  if (approve && co.contractId) contract = await contractValue(req, co.contractId);

  res.json({
    changeOrder: out, contract,
    said: approve
      ? `${co.ref} approved by ${by}.` +
        (contract
          ? ` ${contract.ref} was signed at ${fmt(contract.signedAt, contract.currency)} and is ` +
            `now worth ${fmt(contract.currentValue, contract.currency)}. The signed figure is unchanged.`
          : "")
      : `${co.ref} turned down.`,
  });
}));

/** POST /change-orders/:id/withdraw — taken back before anybody decided. */
procurementRoutes.post("/change-orders/:id/withdraw", route(async (req, res) => {
  need(req, "update", "change-orders");
  const co = await ownChange(req, req.params.id);
  if (["APPROVED", "REJECTED"].includes(co.status)) {
    throw conflict(`${co.ref} was already decided. It cannot be taken back afterwards.`);
  }
  const out = await db.changeOrder.update({
    where: { id: co.id },
    data: { status: "WITHDRAWN", decidedOn: new Date(), decidedBy: who(req),
            decidedNote: text(req.body?.reason, 2000) },
  });
  await audit(req, "change.withdraw", "changeOrder", co.id, { ref: co.ref });
  res.json({ changeOrder: out });
}));

const fmt = (minor, currency) =>
  `${currency} ${(Number(minor) / 100).toFixed(2)}`;

/**
 * What a contract is worth today, and how it got there.
 *
 * COMPUTED EVERY TIME. Storing it would create a second figure that has to be
 * kept in step with the variations, and the day it drifts is the day the
 * contract says one thing and its own history says another.
 */
async function contractValue(req, contractId) {
  const orgId = req.actor.orgId;
  const contract = await db.contract.findFirst({ where: { id: contractId, orgId } });
  if (!contract) return null;
  const variations = await db.changeOrder.findMany({
    where: { orgId, contractId, status: "APPROVED" },
    orderBy: { decidedOn: "asc" },
  });
  const added = variations.reduce((t, v) => t + v.amount, 0n);
  const days = variations.reduce((t, v) => t + v.days, 0);
  return {
    id: contract.id, ref: contract.ref, currency: contract.currency,
    /* The figure on the signed document. Never written to. */
    signedAt: String(contract.price),
    approvedVariations: String(added),
    currentValue: String(contract.price + added),
    daysAdded: days,
    variations: variations.map((v) => ({
      ref: v.ref, title: v.title, amount: String(v.amount), days: v.days,
      decidedOn: v.decidedOn, decidedBy: v.decidedBy,
    })),
  };
}

/**
 * GET /contracts/:id/value — signed, varied, and what it comes to.
 *
 * The three numbers together, because any one of them alone is the one that
 * gets quoted in a meeting and turns out to be the wrong one.
 */
procurementRoutes.get("/contracts/:id/value", route(async (req, res) => {
  need(req, "get", "contracts");
  await ownContract(req, req.params.id);
  const value = await contractValue(req, req.params.id);
  res.json({
    contract: value,
    means: "The signed figure is what the contract was agreed at and never changes. " +
           "The current value is that plus every approved variation.",
  });
}));
