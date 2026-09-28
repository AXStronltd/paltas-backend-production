/* ====================================================================== *
 * THE PLATFORM CONSOLE — PALTAS's OWN STAFF, READING ACROSS TENANTS.
 *
 * ── THIS FILE IS THE ONE EXCEPTION IN THE SERVICE, AND IT IS SEPARATE ──
 *
 * Every one of the 185 other authenticated routes is scoped to a single
 * organization. `http/resource.js` starts every query `{ orgId: actor.orgId }`
 * and there is no code path in which that is absent — which is the one
 * guarantee the product actually sells.
 *
 * A staff console necessarily breaks it. PALTAS's own people have to see every
 * customer in order to support them. There were two ways to allow that:
 *
 *   A. Make the organization filter conditional — skip it when the caller
 *      holds PLATFORM.
 *   B. Put the cross-tenant reads in their own file that never touches the
 *      resource framework at all.
 *
 * This is B, deliberately. Under A, the single most important line in the
 * system becomes an `if`, and a bug in that condition shows one customer
 * another customer's business. Under B the filter stays unconditional
 * forever, and a second, narrower door exists beside it — one that is short
 * enough to read in full, audits everything, and cannot be reached by
 * accident.
 *
 * ── THE THREE RULES THIS FILE KEEPS ────────────────────────────────────
 *
 *   1. READ ONLY. Nothing here writes a customer's business data. Supporting
 *      a customer means seeing what they see, not changing it behind them.
 *      The promotion queues are the one place PALTAS staff act, and they have
 *      their own routes with their own rights table.
 *
 *   2. EVERY READ IS AUDITED, naming the staff member. "Who looked at whose
 *      data" is the question that matters about a console like this, and it
 *      has to be answerable without anybody's cooperation.
 *
 *   3. NO CUSTOMER DETAIL THAT SUPPORT DOES NOT NEED. Staff get names,
 *      counts, states and dates. They do not get tenants' phone numbers,
 *      folio lines, or the contents of anybody's documents — those are the
 *      customer's business and a support console is not a reason to hold
 *      them.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { badRequest, conflict, enumParam, forbidden, notFound } from "../http/errors.ts";
import { requireSession } from "../http/session.ts";
import { actorFor } from "../domain/session-view.ts";
import type { Actor } from "../http/request.ts";
import type { Request, RequestHandler } from "express";
import type { Prisma } from "@prisma/client";
import { messageOf } from "../http/errors.ts";
import { actorOf, sessionOf } from "../http/request.ts";

/** Read one property off an unknown value without asserting its shape. */
const at = (v: unknown, key: string): unknown =>
  (typeof v === "object" && v !== null) ? (v as Record<string, unknown>)[key] : undefined;import { status as supplyStatus } from "../domain/supply.ts";
import { describe as storageDescribe } from "../domain/storage.ts";
import { compareStatus } from "../domain/compare.ts";
import { JOBS, jobByKey, runJob, tick } from "../domain/scheduler.ts";

export const platformRoutes = Router();

/*
 * WHO PALTAS'S OWN STAFF ARE.
 *
 * Two things, and BOTH are required:
 *
 *   - the PLATFORM entitlement, which is granted by PALTAS and cannot be
 *     requested at signup — routes/organizations.js refuses it outright, and
 *     a test asserts that;
 *   - a role that is actually staff.
 *
 * An OWNER of a hotel group is an owner of THEIR company. Being an owner of
 * yours grants nothing on ours, and that wall is the thing this console must
 * not quietly open.
 */
const STAFF_ROLES = new Set(["OWNER", "MANAGER", "MARKETING", "COMPLIANCE", "PUBLISHER"]);

/* Exported so provisioning.js can stand behind the SAME door rather than
   growing a second one that can drift from this. */
/**
 * WHAT A REFUSED ATTEMPT AT THE STAFF CONSOLE LEAVES BEHIND.
 *
 * Nothing, until this existed. The door refused correctly and said nothing
 * to anybody — so an account trying every /platform/* endpoint in turn was
 * invisible, and the first anyone would know of it is when one of them
 * eventually worked.
 *
 * A refusal is the more interesting event of the two. A successful staff
 * read is somebody doing their job; a refused one is either a stale tab or
 * somebody finding out what is behind the wall, and the difference is only
 * visible if both are written down.
 *
 * WRITTEN AGAINST THE CALLER'S OWN ORGANIZATION. It is a fact about their
 * user and their session, so their administrator should be able to see it —
 * and PALTAS can still find it across tenants through /platform/audit. That
 * is the mirror of auditRead() below, which writes a staff read against
 * PALTAS's own organization for exactly the same reason: the row belongs to
 * whoever the act was by.
 *
 * Best-effort and never fatal, like every other audit write here. A caller
 * who should be refused is refused whether or not the note gets written; the
 * refusal is the protection, this is only the record of it.
 *
 * Bounded by the global rate limit in server.ts — 600 requests a minute per
 * address — so a script cannot turn this into a way of filling the table.
 */
async function auditRefused(req: Request, actor: Actor | null, why: string): Promise<void> {
  /* No organization means no row: AuditEvent is org-scoped by design, and
     inventing an owner for this would put a stranger's act in somebody's
     trail. The console log is the only honest place for it. */
  if (!actor) {
    console.warn("platform refused, unattributable", why, req.ip || "");
    return;
  }
  try {
    await db.auditEvent.create({
      data: {
        orgId: actor.orgId,
        actorId: req.session?.userId || null,
        actorName: actor.userName || "",
        action: "platform.refused", entity: "platform", entityId: "",
        detail: { why, path: req.originalUrl, role: actor.role },
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("platform refusal audit failed", messageOf(e)); }
}

export function requirePlatform(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const session = req.session;
      if (!session) {
        await auditRefused(req, null, "no session");
        return next(forbidden("This account does not act for any organization."));
      }
      const actor = await actorFor(session);
      if (!actor) {
        await auditRefused(req, null, "session belongs to no organization");
        return next(forbidden("This account does not act for any organization."));
      }
      if (!actor.isPlatform) {
        /*
         * Deliberately the same sentence whatever the reason.
         *
         * A caller probing this console learns only that it is not for them.
         * "You need the PLATFORM entitlement" tells somebody exactly what to
         * go looking for.
         *
         * The REASON is recorded even though it is not said out loud — the
         * point of one sentence is that the caller learns nothing, not that
         * we do.
         */
        await auditRefused(req, actor, "not a PALTAS staff account");
        return next(forbidden("The PALTAS staff console is not available to this account."));
      }
      if (!STAFF_ROLES.has(actor.role)) {
        await auditRefused(req, actor, `role ${actor.role} is not a staff role`);
        return next(forbidden("The PALTAS staff console is not available to this account."));
      }
      req.actor = actor;
      next();
    } catch (e) { next(e); }
  };
}

platformRoutes.use("/platform", requireSession(), requirePlatform());

/**
 * Record that a member of staff looked across the wall.
 *
 * Written against PALTAS's OWN organization, not the customer's: it is a fact
 * about our staff, and a customer's audit trail should not fill up with our
 * support activity.
 *
 * Best-effort, like every other audit write in this service — a logging
 * failure must not break somebody's support call. The things that must not
 * happen are prevented above, not detected here.
 */
async function auditRead(
  req: Request, what: string, detail?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: actorOf(req, "a platform route").orgId,
        actorId: sessionOf(req, "a platform route").userId,
        actorName: actorOf(req, "a platform route").userName || "",
        action: "platform.read", entity: what, entityId: "",
        detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("platform audit write failed", what, messageOf(e)); }
}

/*
 * The same record for something staff DID rather than read.
 *
 * auditRead writes `platform.read`, which is the right label for looking
 * across the wall and the wrong one for running a job — a trail that files a
 * write under "read" is worse than no label, because it reads as checked.
 */
async function auditDid(
  req: Request, action: string, what: string, entityId: string,
  detail?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: actorOf(req, "a platform route").orgId,
        actorId: sessionOf(req, "a platform route").userId,
        actorName: actorOf(req, "a platform route").userName || "",
        action, entity: what, entityId,
        detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("platform audit write failed", action, messageOf(e)); }
}

/** Page size, capped, for the same reason as everywhere else. */
function paging(req: Request): { take: number; cursor: string | null } {
  const take = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  return { take, cursor };
}

/* ---------------------------------------------------------------- *
 * GET /platform/organizations — every customer.
 *
 * What the console's company screens read: who they are, what they bought,
 * what state they are in, and how big they are. Not their data.
 * ---------------------------------------------------------------- */
/**
 * THE ACCOMMODATION SUPPLIER, AS AN OPERATOR NEEDS TO SEE IT.
 *
 * /marketplace/suppliers is public, and answers the visitor's question: whose
 * room is this and can I book it. It deliberately does not name the adapter,
 * the wholesaler, or the environment variable behind a failure — a visitor
 * cannot act on any of that, and it describes how the integration is built to
 * anyone who asks.
 *
 * An operator's question is the opposite one: WHICH supplier is connected, and
 * exactly WHY can it not take a payment. That answer names names, so it lives
 * behind the staff door instead of being deleted.
 *
 * No customer data is read here, so there is nothing to audit — this says
 * which third party PALTAS is connected to, which is PALTAS's own business.
 */
/**
 * DOCUMENT STORAGE, AS AN OPERATOR NEEDS TO SEE IT.
 *
 * The customer-facing answer is "uploads are not available at the moment",
 * because a customer cannot act on the name of an environment variable. The
 * operator's answer is WHICH one is missing, so it lives behind the staff
 * door rather than being deleted — the same split as the supplier above.
 */
/*
 * WHAT THE SCHEDULER KNOWS HOW TO DO, AND WHAT IT HAS DONE.
 *
 * Every job declares why it exists, so the list reads as an explanation rather
 * than a set of names nobody dares delete. The runs are the record: a period
 * appears once, with what it scanned and changed, or with the reason it failed.
 */
platformRoutes.get("/platform/jobs", async (_req, res, next) => {
  try {
    const runs = await db.jobRun.findMany({
      orderBy: { startedAt: "desc" }, take: 50,
    });
    res.json({
      jobs: JOBS.map((j) => ({ key: j.key, title: j.title, why: j.why })),
      runs,
    });
  } catch (e) { next(e); }
});

/*
 * RUN NOW.
 *
 * For the moment somebody is watching and does not want to wait a quarter of
 * an hour. It is NOT a way to run a period twice: the claim in the database
 * decides that, so pressing this after a period has been done reports that it
 * was already done rather than doing it again. That is the same guarantee the
 * timer relies on, exercised by hand.
 */
platformRoutes.post("/platform/jobs/run", async (req, res, next) => {
  try {
    const wanted = req.body && (req.body as Record<string, unknown>)["job"];
    if (wanted !== undefined && wanted !== null && String(wanted).trim() !== "") {
      const job = jobByKey(String(wanted).trim());
      if (!job) {
        throw notFound(`There is no job called “${String(wanted).trim()}”.`);
      }
      const outcome = await runJob(db, job);
      await auditDid(req, "platform.job.run", "jobRun", job.key,
        { ran: outcome.ran, changed: outcome.changed });
      return res.json({ runs: [outcome] });
    }

    const runs = await tick(db);
    await auditDid(req, "platform.job.run", "jobRun", "all",
      { ran: runs.filter((r) => r.ran).length });
    res.json({ runs });
  } catch (e) { next(e); }
});

platformRoutes.get("/platform/storage", (_req, res) => {
  res.json({ storage: storageDescribe() });
});

platformRoutes.get("/platform/suppliers", (_req, res) => {
  res.json({ suppliers: [supplyStatus()], comparison: compareStatus() });
});

platformRoutes.get("/platform/organizations", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.OrganizationWhereInput = {};
    if (req.query.product) {
      where.entitlements = {
        some: {
          product: enumParam("Product", req.query["product"], "product"),
          status: "ACTIVE",
        },
      };
    }
    where.status = enumParam("OrgStatus", req.query["status"], "company status");
    const q = String(req.query["q"] || "").trim();
    if (q) where.name = { contains: q, mode: "insensitive" };

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.organization.findMany({
      where,
      orderBy: [{ name: "asc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, name: true, country: true, city: true, size: true,
        status: true, createdAt: true,
        subscription: { select: { status: true, plan: true, planKey: true,
                                  seats: true, trialEnds: true } },
        verification: { select: { status: true } },
        entitlements: { where: { status: "ACTIVE" },
                        select: { product: true, since: true } },
        /*
         * COUNTS, NOT CONTENTS. How many units a customer has is what support
         * needs to know; what is in them is theirs. `_count` is the whole
         * difference between a support console and a back door.
         */
        _count: { select: { memberships: true, sites: true, units: true,
                            reservations: true, listings: true, incidents: true,
                            /* The console's company screens count rooms for a
                               hotel, deals for an agency and guards for a
                               security firm. All counts, no contents. */
                            rooms: true, deals: true, guardShifts: true } },
      },
    });

    const more = rows.length > take;
    const organizations = (more ? rows.slice(0, take) : rows).map((o) => ({
      id: o.id, name: o.name, country: o.country, city: o.city, size: o.size,
      status: o.status, since: o.createdAt,
      subscription: o.subscription || { status: "EXPIRED", plan: "", seats: 0 },
      verification: o.verification ? o.verification.status : "NOT_STARTED",
      products: o.entitlements.map((e) => e.product),
      counts: o._count,
    }));

    await auditRead(req, "organization", { returned: organizations.length, q: q || undefined });
    res.json({ organizations, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/users — everybody with an account.
 *
 * Support's commonest question is "which company is this person in, and what
 * can they do there". That is memberships, and nothing else about them.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/users", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.UserWhereInput = {};
    const q = String(req.query.q || "").trim();
    if (q) {
      where.OR = [{ email: { contains: q, mode: "insensitive" } },
                  { name: { contains: q, mode: "insensitive" } }];
    }

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, name: true, email: true, createdAt: true,
        /*
         * `phone` and `picture` are NOT here, and neither is googleSub.
         * Support does not need to ring a customer's staff, and a subject
         * claim is an identifier for Google's benefit, not a person's.
         */
        memberships: { select: { role: true, scope: true,
                                 org: { select: { id: true, name: true } } } },
        _count: { select: { sessions: true } },
      },
    });

    const more = rows.length > take;
    const users = (more ? rows.slice(0, take) : rows).map((u) => ({
      id: u.id, name: u.name, email: u.email, since: u.createdAt,
      signedInSessions: u._count.sessions,
      memberships: u.memberships.map((m) => ({
        organization: m.org.id, organizationName: m.org.name,
        role: m.role, scope: m.scope,
      })),
    }));

    await auditRead(req, "user", { returned: users.length, q: q || undefined });
    res.json({ users, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/entitlements — who holds what.
 *
 * The modules screen: one row per company per product, which is what a
 * commercial conversation is actually about.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/entitlements", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.EntitlementWhereInput = {};
    where.product = enumParam("Product", req.query["product"], "product");
    where.status = enumParam("EntitlementStatus", req.query["status"], "entitlement status");

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.entitlement.findMany({
      where,
      orderBy: [{ since: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, product: true, status: true, since: true,
        org: { select: { id: true, name: true, country: true,
                         subscription: { select: { status: true, plan: true } } } },
      },
    });

    const more = rows.length > take;
    const entitlements = (more ? rows.slice(0, take) : rows).map((e) => ({
      id: e.id, product: e.product, status: e.status, since: e.since,
      organization: e.org.id, organizationName: e.org.name, country: e.org.country,
      subscription: e.org.subscription ? e.org.subscription.status : "EXPIRED",
      plan: e.org.subscription ? e.org.subscription.plan : "",
    }));

    await auditRead(req, "entitlement", { returned: entitlements.length });
    res.json({ entitlements, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/audit — what has been happening, across every customer.
 *
 * Including what PALTAS staff themselves have read, because a log that
 * excludes the people who can read it is not a log.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/audit", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.AuditEventWhereInput = {};
    if (req.query.organization) where.orgId = String(req.query.organization);
    if (req.query.action) where.action = { startsWith: String(req.query.action) };

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.auditEvent.findMany({
      where,
      orderBy: [{ at: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, at: true, action: true, entity: true, entityId: true,
        actorName: true, ip: true,
        org: { select: { id: true, name: true } },
      },
    });

    const more = rows.length > take;
    const events = (more ? rows.slice(0, take) : rows).map((a) => ({
      id: a.id, at: a.at, action: a.action, entity: a.entity, entityId: a.entityId,
      who: a.actorName, ip: a.ip,
      organization: a.org ? a.org.id : null,
      organizationName: a.org ? a.org.name : "",
      /*
       * `detail` is NOT returned.
       *
       * It is a free-form Json column written by every route in the service,
       * and some of what lands in it is the customer's — field names, amounts,
       * references. An audit LIST is for seeing that something happened and
       * by whom; reading the contents of a customer's records is a different
       * question with a different answer.
       */
    }));

    await auditRead(req, "auditEvent", { returned: events.length });
    res.json({ events, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/moderation — the listings queue.
 *
 * READ ONLY, like everything else in this file. The moderation screen offers
 * no per-row action — its buttons navigate — so a decision endpoint would be
 * capability nobody asked for, on the one router that crosses tenants.
 *
 * When a decision workflow IS wanted it needs deciding first: who may uphold,
 * whether a company can appeal, what the customer is told. That is a product
 * question, and guessing at it here would bake an answer into the schema.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/moderation", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.ModerationItemWhereInput = {};
    where.status = enumParam("ModerationStatus", req.query["status"], "moderation status");
    if (req.query["organization"]) where.orgId = String(req.query["organization"]);

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.moderationItem.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, title: true, reason: true, severity: true, status: true,
        createdAt: true, decidedAt: true,
        org: { select: { id: true, name: true } },
        /* The listing's id, NOT its contents. Knowing WHICH listing is held is
           the queue's job; reading the customer's copy is not. */
        listingId: true,
      },
    });

    const more = rows.length > take;
    const items = (more ? rows.slice(0, take) : rows).map((r) => ({
      id: r.id, title: r.title, reason: r.reason, severity: r.severity,
      status: r.status, raisedAt: r.createdAt, decidedAt: r.decidedAt,
      listingId: r.listingId,
      organization: r.org ? r.org.id : null,
      organizationName: r.org ? r.org.name : "",
    }));

    await auditRead(req, "moderationItem", { returned: items.length });
    res.json({ items, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/compliance — statutory cases with a clock on them.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/compliance", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.ComplianceCaseWhereInput = {};
    where.status = enumParam("ComplianceStatus", req.query["status"], "compliance status");

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.complianceCase.findMany({
      where,
      orderBy: [{ dueOn: "asc" }, { createdAt: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, ref: true, kind: true, subject: true, detail: true,
        dueOn: true, status: true, createdAt: true,
        org: { select: { id: true, name: true } },
      },
    });

    const more = rows.length > take;
    const cases = (more ? rows.slice(0, take) : rows).map((c) => ({
      id: c.id, ref: c.ref, kind: c.kind,
      /*
       * `subject` is a named person — usually the one exercising a data right.
       * It is returned because a case is unworkable without knowing whose it
       * is, and this router already requires PALTAS staff and logs every read.
       */
      subject: c.subject, detail: c.detail,
      dueOn: c.dueOn, status: c.status, raisedAt: c.createdAt,
      organization: c.org ? c.org.id : null,
      organizationName: c.org ? c.org.name : "",
    }));

    await auditRead(req, "complianceCase", { returned: cases.length });
    res.json({ cases, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/verifications — companies waiting to be let in.
 *
 * No new model: this is the existing Verification, read across tenants. It is
 * what the console's approvals queue has always been drawing.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/verifications", async (req, res, next) => {
  try {
    const { take, cursor } = paging(req);
    const where: Prisma.VerificationWhereInput = {};
    where.status = enumParam("VerificationStatus", req.query["status"], "verification status");

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
    const rows = await db.verification.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, status: true, documents: true, createdAt: true, updatedAt: true,
        org: {
          select: {
            id: true, name: true, country: true,
            memberships: {
              take: 1, orderBy: { createdAt: "asc" },
              select: { user: { select: { name: true, email: true } } },
            },
          },
        },
      },
    });

    const more = rows.length > take;
    const queue = (more ? rows.slice(0, take) : rows).map((v) => {
      const docs = Array.isArray(v.documents) ? v.documents : [];
      const owner = v.org && v.org.memberships[0] && v.org.memberships[0].user;
      return {
        id: v.id, status: v.status,
        organization: v.org ? v.org.id : null,
        organizationName: v.org ? v.org.name : "",
        country: v.org ? v.org.country : "",
        /* Who to ask, and WHAT KINDS of document are on file — never the files
           themselves. A passport scan is not something a support queue needs
           to hand out in order to say "identity is still outstanding". */
        contactName: owner ? (owner.name || owner.email) : "",
        documentKinds: docs.map((d: unknown) =>
          String(at(d, "kind") || at(d, "type") || "document")),
        documentCount: docs.length,
        waitingSince: v.updatedAt,
      };
    });

    await auditRead(req, "verification", { returned: queue.length });
    res.json({ queue, nextCursor: more ? (rows[take - 1]?.id ?? null) : null });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/plans — the price list.
 *
 * The one endpoint here that crosses no tenant at all, because a Plan has no
 * organization: it is the same catalogue for everybody.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/plans", async (req, res, next) => {
  try {
    const rows = await db.plan.findMany({
      where: { active: true },
      orderBy: [{ seq: "asc" }, { price: "asc" }],
      take: 100,
    });
    await auditRead(req, "plan", { returned: rows.length });
    res.json({
      plans: rows.map((p) => ({
        id: p.id, code: p.code, name: p.name,
        price: p.price, currency: p.currency,
        limitText: p.limitText, propertyCap: p.propertyCap,
        includes: p.includes,
      })),
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * GET /platform/summary — the numbers the console opens on.
 * ---------------------------------------------------------------- */
platformRoutes.get("/platform/summary", async (req, res, next) => {
  try {
    const [organizations, active, trialing, pastDue, users, byProduct] = await Promise.all([
    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
      db.organization.count(),
    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
      db.subscription.count({ where: { status: "ACTIVE" } }),
    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
      db.subscription.count({ where: { status: "TRIALING" } }),
    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
      db.subscription.count({ where: { status: "PAST_DUE" } }),
    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
      db.user.count(),
    /* CROSS-TENANT BY DESIGN — requirePlatform() above, read-only, audited below. */
      db.entitlement.groupBy({ by: ["product"], where: { status: "ACTIVE" }, _count: true }),
    ]);

    await auditRead(req, "summary");
    res.json({
      counts: { organizations, users,
                subscriptions: { active, trialing, pastDue } },
      products: Object.fromEntries(byProduct.map((p) => [p.product, p._count])),
    });
  } catch (e) { next(e); }
});

