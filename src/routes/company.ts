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
import { db } from "../db.ts";
import { RESOURCES } from "../domain/registry.ts";
import { levelFor, whyNotArea } from "../domain/access.ts";
import { badRequest, forbidden, hidden } from "../http/errors.ts";
import { whyNotReceiptable } from "../domain/receipts.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";
import { country as marketCountry } from "../domain/market.ts";
import { LIVE_LEASE_STATES } from "../domain/occupancy.ts";
import { rentDueIn, rentPeriod } from "../domain/rent.ts";
import { commandCentre } from "../domain/command-centre.ts";
import { client360 } from "../domain/client360.ts";
import type { Request, RequestHandler, Response } from "express";
import type { Prisma } from "@prisma/client";
import type { Act, Area } from "../domain/access.ts";
import { messageOf } from "../http/errors.ts";
import { actorOf, sessionOf } from "../http/request.ts";

export const companyRoutes = Router();

companyRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req: Request, area: Area, act: Act, label?: string): void {
  const why = whyNotArea(actorOf(req, "a company route"), area, act, label);
  if (why) throw forbidden(why);
}

/** One handler, with its `try`/`catch` written once. */
const route = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
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
  const orgId = actorOf(req, "a company route").orgId;

  /* Every area this person can read at all. */
  const readable = new Set<string>();
  for (const [model, area] of AREA_OF) {
    if (levelFor(actorOf(req, "a company route"), area) !== "none") readable.add(model);
  }
  if (!readable.size) {
    throw forbidden(`The role “${actorOf(req, "a company route").role}” cannot read any of this company's records, so there is no history to show.`);
  }

  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const skip = Math.max(Number(req.query.offset) || 0, 0);

  const where: Prisma.AuditEventWhereInput = { orgId, entity: { in: [...readable] } };
  if (req.query.action) where.action = { startsWith: String(req.query.action) };
  if (req.query.entity) {
    const asked = String(req.query.entity);
    if (!readable.has(asked)) throw hidden();
    where.entity = asked;
  }
  if (req.query.entityId) where.entityId = String(req.query.entityId);

  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw badRequest("from and to must be dates.");
  }
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
  const orgId = actorOf(req, "a company route").orgId;

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
    /* The query already excludes documents with no expiry; the guard is here
       because the column is nullable and a null date reads as 1970, which
       would mark every one of them expired. */
    const days = d.expiresAt
      ? Math.ceil((new Date(d.expiresAt).getTime() - now.getTime()) / 864e5)
      : null;
    return { ...d, daysLeft: days, expired: days !== null && days < 0 };
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
  const orgId = actorOf(req, "a company route").orgId;
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
      /* The proof handed over, if one has been. Included here rather than
         asked for per row: a history of five hundred payments would otherwise
         be five hundred more requests to draw one column. */
      receipt: { select: { id: true, ref: true, basis: true, issuedAt: true, voided: true } },
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
      /*
       * WHETHER A RECEIPT EXISTS, AND IF NOT WHY NOT.
       *
       * Decided here rather than in the console, because "what counts as a
       * confirmed payment" is a rule about money, and a second copy of it in
       * the browser is how the two come to disagree about which payments are
       * real. See domain/receipts.js.
       */
      receipt: p.receipt,
      canReceipt: !p.receipt && !whyNotReceiptable(p),
      whyNoReceipt: p.receipt ? null : whyNotReceiptable(p),
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
    where: { id: actorOf(req, "a company route").orgId },
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
 * GET /clients/:id/360
 *
 * ONE CLIENT, EVERYTHING — assembled, never stored.
 *
 * Every record here belongs to the system that owns it: leases to property
 * management, invoices and arrears to finance, offers and reservations to
 * sales, history to the audit trail. This is the relationship, which is the
 * one thing no single system owns.
 *
 * Money is omitted for a role that may not see it, rather than zeroed.
 */
companyRoutes.get("/clients/:id/360", route(async (req, res) => {
  need(req, "people", "get", "a client");
  const orgId = actorOf(req, "a company route").orgId;

  const out = await client360(db, {
    orgId,
    partyId: String(req.params["id"] || ""),
    money: levelFor(actorOf(req, "a company route"), "finance") !== "none",
  });
  /* Hidden rather than "not found": whether another company's contact exists
     is not this company's business. */
  if (!out) throw hidden();
  res.json(out);
}));

/**
 * GET /command-centre
 *
 * WHAT IS HAPPENING IN THIS BUSINESS, AND WHAT NEEDS ATTENTION.
 *
 * One authenticated aggregation over the services that already own each
 * answer — receivables for arrears, occupancy for which lease states are live,
 * AuditEvent for what happened. It is deliberately not a second source of
 * truth: a command centre that worked out its own version of what is owed
 * would eventually disagree with Collections, and it would be the one people
 * looked at first.
 *
 * MONEY IS OMITTED ENTIRELY, not zeroed, for a role that may not see it.
 * Zeros read as "you have none", which is a different statement and a false
 * one.
 */
companyRoutes.get("/command-centre", route(async (req, res) => {
  /* Seeing the business at all is a property-area read. What it may CONTAIN
     is decided separately, below. */
  need(req, "property", "list", "the command centre");
  const orgId = actorOf(req, "a company route").orgId;

  const out = await commandCentre(db, {
    orgId,
    money: levelFor(actorOf(req, "a company route"), "finance") !== "none",
  });
  res.json(out);
}));

/**
 * GET /rent/automation
 *
 * EVERYTHING THE CONSOLE NEEDS TO SHOW ABOUT AUTOMATIC RENT, AND NOTHING IT
 * WOULD OTHERWISE HAVE TO INVENT.
 *
 * Three questions, answered from the tables rather than guessed at:
 *
 *   IS IT ON, and what would it do if it were?
 *   IS THIS COMPANY READY — which of its leases would be billed, and which
 *     would be passed over, and why.
 *   WHAT HAS IT ALREADY DONE, per billing period.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────
 *
 * "Skipped" and "errors" per company. A JobRun covers every company at once
 * and records its counts across all of them, so there is no honest per-company
 * number to report — and a screen that showed the platform's totals as this
 * customer's would be worse than one that shows nothing.
 *
 * A "next run" TIME, for the same reason. The period a run would cover is
 * knowable and is given; when the scheduler next beats is not a promise this
 * service can make.
 */
companyRoutes.get("/rent/automation", route(async (req, res) => {
  need(req, "finance", "list", "rent automation");
  const orgId = actorOf(req, "a company route").orgId;

  const org = await db.organization.findFirst({
    where: { id: orgId }, select: { autoRent: true, country: true },
  });
  if (!org) throw hidden();

  const leases = await db.lease.findMany({
    where: { orgId, status: { in: [...LIVE_LEASE_STATES] } },
    select: {
      id: true, ref: true, unitRef: true, rent: true, currency: true,
      rentDay: true, billing: true, startsOn: true, endsOn: true, status: true,
    },
    orderBy: { ref: "asc" },
  });

  /*
   * WHAT WOULD ACTUALLY HAPPEN, per lease — asked of the same function the
   * run itself uses, so this screen cannot disagree with the billing.
   */
  const period = rentPeriod(new Date());
  const billable: typeof leases = [];
  const passedOver: Array<{ id: string; ref: string; unitRef: string; why: string }> = [];

  for (const l of leases) {
    if (l.rent <= 0n) {
      passedOver.push({ id: l.id, ref: l.ref, unitRef: l.unitRef,
        why: "no rent is recorded on this lease" });
      continue;
    }
    if (l.billing !== "MONTHLY" && !l.startsOn) {
      /* The backend's own rule, explained rather than restated: without a
         start month there is nothing to anchor a quarter or a year to. */
      passedOver.push({ id: l.id, ref: l.ref, unitRef: l.unitRef,
        why: `${l.billing.toLowerCase()} billing needs a lease start date to count from — `
           + "this one is raised by hand until it has one" });
      continue;
    }
    if (rentDueIn(l, period)) billable.push(l);
  }

  /* What has already been raised, per period. Real rows, not a log. */
  const charges = await db.rentCharge.groupBy({
    by: ["periodKey", "currency"],
    where: { orgId },
    _count: { _all: true },
    _sum: { amount: true },
    orderBy: { periodKey: "desc" },
    take: 24,
  });

  res.json({
    autoRent: org.autoRent,
    /* The period a run would cover if it beat now. Not a time. */
    period,
    leases: {
      live: leases.length,
      billableThisPeriod: billable.length,
      /* Still on the values a lease is created with. Not a fault — a signal
         that nobody has looked at them yet, which is the thing worth checking
         before letting PALTAS bill on them. */
      onDefaultDay: leases.filter((l) => l.rentDay === 1).length,
      onDefaultBilling: leases.filter((l) => l.billing === "MONTHLY").length,
    },
    passedOver,
    history: charges.map((c) => ({
      periodKey: c.periodKey,
      currency: c.currency,
      invoices: c._count._all,
      amount: (c._sum.amount ?? 0n).toString(),
    })),
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
  const orgId = actorOf(req, "a company route").orgId;
  const b = (req.body as Record<string, unknown> | undefined) ?? {};

  for (const locked of ["status", "kind", "id", "subscription", "entitlements"]) {
    if (b[locked] !== undefined) {
      throw badRequest(`${locked} is not a company's own setting to change.`);
    }
  }

  /* Only the four columns this endpoint may change. Named rather than spread
     from the body, which is what stops `status` or `orgId` arriving in it. */
  const data: Prisma.OrganizationUpdateInput = {};
  if (b["name"] !== undefined) {
    const name = String(b["name"]).trim();
    if (!name) throw badRequest("A company needs a name.");
    if (name.length > 160) throw badRequest("That company name is too long.");
    data.name = name;
  }
  if (b["city"] !== undefined) data.city = String(b["city"]).slice(0, 120);
  if (b["size"] !== undefined) data.size = String(b["size"]).slice(0, 40);

  /*
   * WHETHER PALTAS MAY RAISE THIS COMPANY'S RENT BY ITSELF.
   *
   * A company's own decision, and an owner-level one — which this endpoint
   * already requires. It is off until somebody says otherwise, because every
   * company using PALTAS today invoices rent by hand and PALTAS cannot see
   * what was billed outside it; switching it on for everybody would raise the
   * current month a second time for every tenant whose invoice was already
   * typed. See domain/rent.ts.
   *
   * Turning it ON does not raise anything on its own. The next monthly run
   * does, for the month it is in — never for months already gone.
   */
  if (b["autoRent"] !== undefined) data.autoRent = b["autoRent"] === true;

  if (b["country"] !== undefined) {
    const code = String(b["country"]).trim().toLowerCase().slice(0, 4);
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
        `“${b["country"]}” is not a market PALTAS knows, and the books need a country ` +
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
        orgId, actorId: sessionOf(req, "PATCH /company/settings").userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action: "organization.settings", entity: "organization", entityId: orgId,
        detail: { changed: Object.keys(data), from: before },
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", messageOf(e)); }

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
