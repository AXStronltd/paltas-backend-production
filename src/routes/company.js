/* ====================================================================== *
 * WHAT A COMPANY CAN ASK ABOUT ITSELF.
 *
 * Four things the audit found half-built: each had its data, and no way for
 * the company that owns it to read it.
 *
 *   GET   /audit                    what has happened here, and who did it
 *   GET   /documents/expiring       the papers about to lapse
 *   GET   /payments/history         one customer's payments, in order
 *   GET   /organization/settings    the company's own record
 *   PATCH /organization/settings    and how to correct it
 *
 * ── WHY THIS MOUNTS ABOVE productRoutes ────────────────────────────────
 *
 * `/documents/expiring` would otherwise reach the documents RESOURCE router
 * first, which is mounted at `/documents` and reads `expiring` as an id — the
 * same collision `/market/services` hit, answering 404 for a route that
 * exists. server.js mounts this above it.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import { RESOURCES } from "../domain/registry.js";
import { levelFor, whyNotArea } from "../domain/access.js";
import { badRequest, forbidden, hidden } from "../http/errors.js";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.js";
import { country as marketCountry } from "../domain/market.js";

export const companyRoutes = Router();

companyRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req, area, act, label) {
  const why = whyNotArea(req.actor, area, act, label);
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

/* ====================================================================== *
 * 1. THE COMPANY'S OWN AUDIT TRAIL
 * ====================================================================== */

/**
 * WHICH AREA AN AUDITED ENTITY BELONGS TO.
 *
 * Built from the registry, so a new resource is covered the day it is
 * declared rather than the day somebody remembers this table. The
 * hand-written entries below are the models that have no registry
 * declaration — the ledger's three, and the ones products.js writes directly.
 */
const AREA_OF = (() => {
  const map = new Map();
  for (const r of Object.values(RESOURCES)) map.set(r.model, r.area);
  /* Not resources, but audited all the same. */
  map.set("ledgerAccount", "finance");
  map.set("journalEntry", "finance");
  map.set("financialPeriod", "finance");
  map.set("payment", "finance");
  map.set("invoice", "finance");
  map.set("organization", "people");
  map.set("membership", "people");
  map.set("invitation", "people");
  return map;
})();

/**
 * GET /audit — what has happened in this company.
 *
 * ── WHO SEES WHAT, AND WHY IT IS NOT A NEW PERMISSION ──────────────────
 *
 * There is no "audit" area and inventing one would mean a nineteenth row in
 * every role. An audit trail is not a kind of work — it is a view OVER every
 * kind of work — so it is filtered by the areas this person may already read.
 * A finance clerk sees the money; a maintenance supervisor sees the work
 * orders; an owner sees everything, because an owner may read everything.
 *
 * That has a property worth stating: the log can never show somebody an
 * action against a record they could not have opened. It adds no reach.
 *
 * `detail` is not returned, exactly as the platform log does not return it.
 * It holds whatever a write happened to change, and a log is for who did what
 * to which row — not a second copy of the row.
 */
companyRoutes.get("/audit", route(async (req, res) => {
  const orgId = req.actor.orgId;

  /* Every area this person can read at all. */
  const readable = new Set();
  for (const [model, area] of AREA_OF) {
    if (levelFor(req.actor, area) !== "none") readable.add(model);
  }
  if (!readable.size) {
    throw forbidden(`The role “${req.actor.role}” cannot read any of this company's records, so there is no history to show.`);
  }

  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const skip = Math.max(Number(req.query.offset) || 0, 0);

  const where = { orgId, entity: { in: [...readable] } };
  if (req.query.action) where.action = { startsWith: String(req.query.action) };
  if (req.query.entity) {
    const asked = String(req.query.entity);
    if (!readable.has(asked)) throw hidden();
    where.entity = asked;
  }
  if (req.query.entityId) where.entityId = String(req.query.entityId);

  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  if ((from && isNaN(from)) || (to && isNaN(to))) throw badRequest("from and to must be dates.");
  if (from || to) where.at = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  const [rows, total] = await Promise.all([
    db.auditEvent.findMany({
      where, orderBy: { at: "desc" }, take, skip,
      select: {
        id: true, at: true, action: true, entity: true, entityId: true,
        actorName: true,
      },
    }),
    db.auditEvent.count({ where }),
  ]);

  res.json({
    events: rows.map((a) => ({
      id: a.id, at: a.at, action: a.action,
      entity: a.entity, entityId: a.entityId,
      who: a.actorName || "—",
      area: AREA_OF.get(a.entity) || "",
    })),
    count: rows.length,
    total,
    limit: take,
    offset: skip,
    /* So a screen can say "these are the parts you can see" rather than
       implying it is the whole history. */
    areas: [...new Set([...readable].map((m) => AREA_OF.get(m)))].filter(Boolean).sort(),
  });
}));

/* ====================================================================== *
 * 2. DOCUMENTS ABOUT TO LAPSE
 * ====================================================================== */

/**
 * GET /documents/expiring?withinDays=90
 *
 * `Document.expiresAt` has existed all along, and is INDEXED on
 * [orgId, expiresAt] — the column was built for exactly this question and
 * nothing ever asked it. An insurance certificate that lapsed last month is
 * the kind of thing a company finds out about from somebody else.
 *
 * Already-expired documents come back too, marked, because they are the most
 * urgent rows in the answer rather than rows that have stopped mattering.
 */
companyRoutes.get("/documents/expiring", route(async (req, res) => {
  need(req, "documents", "list", "documents");
  const orgId = req.actor.orgId;

  const days = Math.min(Math.max(Number(req.query.withinDays) || 90, 1), 3650);
  const now = new Date();
  const until = new Date(now.getTime() + days * 864e5);

  const rows = await db.document.findMany({
    where: { orgId, expiresAt: { not: null, lte: until } },
    orderBy: { expiresAt: "asc" },
    take: 500,
    select: {
      id: true, name: true, kind: true, about: true, expiresAt: true,
      createdAt: true,
    },
  });

  const documents = rows.map((d) => {
    const days = Math.ceil((new Date(d.expiresAt) - now) / 864e5);
    return { ...d, daysLeft: days, expired: days < 0 };
  });

  res.json({
    documents,
    count: documents.length,
    expired: documents.filter((d) => d.expired).length,
    withinDays: days,
  });
}));

/* ====================================================================== *
 * 3. ONE CUSTOMER'S PAYMENTS
 * ====================================================================== */

/**
 * GET /payments/history?partyId=…  (or ?invoiceId=)
 *
 * The payments resource lists a company's payments; this answers the question
 * somebody actually asks at a desk — "what has this tenant paid us?" — in
 * date order, with what it settled and what is still owed.
 *
 * A payment names no party of its own: it clears an INVOICE, and the invoice
 * knows whose it is. So the filter goes through the relation rather than
 * inventing a column.
 */
companyRoutes.get("/payments/history", route(async (req, res) => {
  need(req, "finance", "list", "payments");
  const orgId = req.actor.orgId;
  const { partyId, invoiceId } = req.query;

  if (!partyId && !invoiceId) {
    throw badRequest("Whose payments? Send partyId, or invoiceId for one bill.");
  }

  if (partyId) {
    const p = await db.party.findFirst({
      where: { id: String(partyId), orgId }, select: { id: true },
    });
    if (!p) throw hidden();
  }

  const where = {
    orgId,
    ...(invoiceId ? { invoiceId: String(invoiceId) } : {}),
    ...(partyId ? { invoice: { partyId: String(partyId) } } : {}),
  };

  const rows = await db.payment.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: 500,
    include: {
      invoice: {
        select: { id: true, ref: true, total: true, paid: true, status: true, currency: true },
      },
    },
  });

  /* A voided payment is not money received. It stays in the list — the
     history is what happened, not what is convenient — and out of the total. */
  const received = rows
    .filter((p) => !p.voided)
    .reduce((t, p) => t + BigInt(p.amount), 0n);

  res.json({
    payments: rows.map((p) => ({
      id: p.id, amount: p.amount, currency: p.currency,
      method: p.method, reference: p.reference,
      receivedAt: p.receivedAt,
      voided: p.voided, voidReason: p.voidReason,
      invoice: p.invoice,
    })),
    count: rows.length,
    received,
    voided: rows.filter((p) => p.voided).length,
  });
}));

/* ====================================================================== *
 * 4. THE COMPANY'S OWN RECORD
 * ====================================================================== */

/**
 * GET /organization/settings
 *
 * There was nowhere in the product to see or change this. The company's
 * COUNTRY in particular was set once at signup and then unreachable — and it
 * is not a label: it decides the currency the books are kept in, which
 * payment rails are offered, and how prices are formatted. A company that
 * registered under the wrong one had no way to say so.
 */
companyRoutes.get("/organization/settings", route(async (req, res) => {
  need(req, "people", "get", "this company's settings");
  const org = await db.organization.findFirst({
    where: { id: req.actor.orgId },
    select: {
      id: true, name: true, country: true, city: true, size: true,
      status: true, createdAt: true,
    },
  });
  if (!org) throw hidden();

  const c = org.country ? marketCountry(String(org.country).toUpperCase()) : null;

  res.json({
    organization: org,
    /* What the country actually decides, said out loud — so somebody changing
       it can see what they are changing. */
    market: c
      ? { code: c.code, name: c.name, currency: c.currency, locale: c.locale, languages: c.langs }
      : null,
    reportingCurrency: c ? c.currency : null,
    warning: c ? null
      : "This company's country is not one the market catalogue knows, so the ledger cannot work out a reporting currency on its own.",
  });
}));

/**
 * PATCH /organization/settings
 *
 * Name, country and city. Not `status`, not `kind`, and not the subscription
 * — those are PALTAS's to set, not the customer's, and a company that could
 * mark itself ACTIVE is a company that has stopped paying without noticing.
 */
companyRoutes.patch("/organization/settings", route(async (req, res) => {
  need(req, "people", "delete", "this company's settings");
  const orgId = req.actor.orgId;
  const b = req.body || {};

  for (const locked of ["status", "kind", "id", "subscription", "entitlements"]) {
    if (b[locked] !== undefined) {
      throw badRequest(`${locked} is not a company's own setting to change.`);
    }
  }

  const data = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) throw badRequest("A company needs a name.");
    if (name.length > 160) throw badRequest("That company name is too long.");
    data.name = name;
  }
  if (b.city !== undefined) data.city = String(b.city).slice(0, 120);
  if (b.size !== undefined) data.size = String(b.size).slice(0, 40);

  if (b.country !== undefined) {
    const code = String(b.country).trim().toLowerCase().slice(0, 4);
    if (!code) throw badRequest("A country is required.");
    /*
     * REFUSED IF THE CATALOGUE DOES NOT KNOW IT.
     *
     * An unknown country leaves the ledger with no reporting currency, so
     * every automatic posting would start skipping with "this company's
     * reporting currency is not known" — which is a correct message and a
     * terrible way to find out about a typo.
     */
    const c = marketCountry(code.toUpperCase());
    if (!c) {
      throw badRequest(
        `“${b.country}” is not a market PALTAS knows, and the books need a country ` +
        `they can take a currency from.`);
    }
    data.country = code;
  }

  if (!Object.keys(data).length) throw badRequest("Nothing to change.");

  const before = await db.organization.findFirst({
    where: { id: orgId }, select: { name: true, country: true, city: true, size: true },
  });
  const org = await db.organization.update({
    where: { id: orgId }, data,
    select: { id: true, name: true, country: true, city: true, size: true },
  });

  try {
    await db.auditEvent.create({
      data: {
        orgId, actorId: req.session.userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action: "organization.settings", entity: "organization", entityId: orgId,
        detail: { changed: Object.keys(data), from: before },
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", e.message); }

  const c = org.country ? marketCountry(String(org.country).toUpperCase()) : null;
  res.json({
    organization: org,
    reportingCurrency: c ? c.currency : null,
    /* Changing the country changes the currency the books are kept in from
       here on. Entries already posted keep the currency they were posted in;
       nothing is restated. */
    note: data.country
      ? "Entries already posted keep the currency they were posted in. This applies to new ones."
      : null,
  });
}));
