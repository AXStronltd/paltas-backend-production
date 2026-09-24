/* ====================================================================== *
 * FIVE ENDPOINTS PER RESOURCE, BUILT FROM A DECLARATION.
 *
 * The reason this file exists rather than thirty route files:
 *
 *     PALTAS is one database holding many companies' businesses. Every
 *     query against every table must be filtered by organization. There
 *     are about 170 such queries. One of them being wrong shows a hotel
 *     its competitor's rates.
 *
 * Written by hand, that is 170 chances to forget. Written here, there is
 * no code path that omits it — `where` starts as `{ orgId: actor.orgId }`
 * and a caller cannot reach a query builder to change that. The same
 * applies to the permission check, the audit entry, and the cap on how
 * many rows one request can drag out of the database.
 *
 * WHAT EVERY ENDPOINT DOES, IN ORDER, WITHOUT EXCEPTION:
 *
 *   1. There is a session, a company, and an open subscription.
 *   2. The company owns the product this resource belongs to.
 *   3. The role may do this verb in this area          (domain/access.js)
 *   4. The query is scoped to that company             (never from the body)
 *   5. Only declared fields are written                (domain/registry.js)
 *   6. Ids pointing at other rows point INSIDE the company
 *   7. Writes are recorded in AuditEvent
 *
 * Steps 4, 6 and 7 are the ones a hand-written route forgets, so they are
 * the ones that are not optional here.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { RESOURCES } from "../domain/registry.js";
import { allows, whyNotArea } from "../domain/access.ts";
import { badRequest, conflict, forbidden, hidden } from "./errors.ts";
import { clean } from "../domain/input.js";
/* Site scope lives in the domain, not here — products.js needs the same
   rule for its summary counts, and one copy of a filter is the point. */
import { scopeWhere, scopedSites } from "../domain/scope.js";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "./session.js";

/* ====================================================================== *
 * THE CHECKS A HAND-WRITTEN ROUTE FORGETS.
 * ====================================================================== */

/**
 * An id in a body must name a row in the CALLER'S OWN company.
 *
 * Without this, a request can say `{ leaseId: "<another company's lease>" }`
 * and the write succeeds: the row lands in the right company, but it is
 * joined to a stranger's, and from then on every screen that follows the
 * relation reads across the wall. The foreign keys do not stop it — they
 * only check the row exists somewhere.
 */
async function checkReferences(resource, data, orgId) {
  const jobs = [];
  for (const [key, kind] of Object.entries(resource.fields)) {
    if (!kind.startsWith("id:")) continue;
    const value = data[key];
    if (!value) continue;
    const target = RESOURCES[pluralOf(kind.slice(3))] || { model: kind.slice(3) };
    jobs.push(
      db[target.model].findFirst({ where: { id: value, orgId }, select: { id: true } })
        .then((row) => (row ? null : key))
    );
  }
  const missing = (await Promise.all(jobs)).filter(Boolean);
  if (missing.length) {
    /*
     * NOT FOUND RATHER THAN FORBIDDEN, for the same reason as hidden():
     * a different answer for "exists but is not yours" is a way to find
     * out what another company has.
     */
    throw badRequest(
      `${missing[0]} does not name anything this company has.`,
      missing.map((k) => `${k} does not name anything this company has.`));
  }
}

/** `site` → `sites`, so a kind of `id:site` finds the sites declaration. */
function pluralOf(model) {
  for (const [slug, r] of Object.entries(RESOURCES)) if (r.model === model) return slug;
  return model;
}

/**
 * The next number for THIS COMPANY.
 *
 * An atomic increment, not `count() + 1`. Two people raising an invoice in
 * the same second must not both be told they made INV-0007 — and because
 * the counter is named per company, one customer's volume never shows in
 * another's numbering.
 */
async function nextNumber(resource, slug, orgId) {
  const name = `${slug}:${orgId}`;
  const row = await db.counter.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  const prefix = (resource.prefix || slug.slice(0, 3)).toUpperCase().replace(/[^A-Z]/g, "");
  return `${prefix}-${String(row.value).padStart(4, "0")}`;
}

/**
 * The same number, for a route that writes rows the framework did not.
 *
 * A campaign creates four hundred dispatches at once; the framework's create
 * handler makes one at a time. Without this the route would have to build the
 * ref itself, and two pieces of code deciding what MSG-0042 means is how a
 * company ends up with two of them.
 */
export async function numberFor(slug, orgId) {
  const resource = RESOURCES[slug];
  if (!resource || !resource.numbered) {
    throw new Error(`${slug} is not a numbered resource`);
  }
  return nextNumber(resource, slug, orgId);
}

/**
 * Record what was done.
 *
 * Best-effort ON PURPOSE: a failure to write the log must not undo the work
 * the customer just did. It is a record of activity, not a control — the
 * things that must not happen are prevented above, not detected here.
 */
async function audit(req, action, entity, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        orgId: req.actor.orgId,
        actorId: req.session.userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action, entity, entityId,
        detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) {
    console.error("audit write failed", action, entity, entityId, e.message);
  }
}

/* ====================================================================== *
 * THE ROUTER.
 * ====================================================================== */

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

export { clean };

export function resourceRouter(slug) {
  const resource = RESOURCES[slug];
  if (!resource) throw new Error(`no resource declared for "${slug}"`);

  const router = Router({ mergeParams: true });
  const model = () => db[resource.model];
  const label = resource.label || slug;

  router.use(requireSession(), requireOrganization(), requireOpenSubscription());

  /* Entitlement before role. A company that has not bought Hotel Management
     has no rooms, and no role inside it can reach one. */
  if (resource.product) {
    router.use((req, _res, next) => {
      if (!req.actor.products.includes(resource.product)) {
        return next(forbidden(
          `This company's subscription does not include ` +
          `${resource.product.replace(/_/g, " ").toLowerCase()}, so it has no ${label}.`));
      }
      next();
    });
  }

  /** Role. One line, one place, every verb. */
  const may = (act) => (req, _res, next) => {
    const why = whyNotArea(req.actor, resource.area, act, label);
    if (why) return next(forbidden(why));
    next();
  };

  /* ---------------------------------------------------------------- *
   * GET /  — the list.
   * ---------------------------------------------------------------- */
  router.get("/", may("list"), async (req, res, next) => {
    try {
      /*
       * THE LINE THIS WHOLE FILE EXISTS FOR. `where` starts scoped, and
       * everything below narrows it further. There is no branch in which
       * orgId is absent and none in which it comes from the request.
       */
      /* Narrowed to the company, and then to this person's remit inside it.
         Both in one literal, so nothing can be inserted between the filter
         and the query it belongs to — see the note on scopedSites(). */
      const where = {
        orgId: req.actor.orgId,
        ...(scopeWhere(req.actor, resource, slug) || {}),
      };

      if (req.query.status) {
        where[resource.statusField || "status"] =
          String(req.query.status).toUpperCase().replace(/[\s-]+/g, "_");
      }

      /* Filter by any declared id field: ?siteId=…, ?listingId=… */
      for (const [key, kind] of Object.entries(resource.fields)) {
        if (!kind.startsWith("id:")) continue;
        if (req.query[key]) where[key] = String(req.query[key]);
      }

      const q = String(req.query.q || "").trim();
      if (q && (resource.search || []).length) {
        where.OR = resource.search.map((f) => ({ [f]: { contains: q, mode: "insensitive" } }));
      }

      /*
       * A CAP THAT CANNOT BE RAISED BY ASKING.
       *
       * `?limit=100000` against a busy company is a way to make the service
       * spend a minute building one response, and it does not need to be
       * malicious to happen — a script with no pagination does it by
       * accident. The ceiling is the ceiling.
       */
      const take = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));
      const cursor = req.query.cursor ? String(req.query.cursor) : null;

      const rows = await model().findMany({
        where,
        include: resource.include,
        orderBy: resource.order || [{ createdAt: "desc" }],
        take: take + 1,                        // one extra, to know if there is more
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const more = rows.length > take;
      const page = more ? rows.slice(0, take) : rows;

      /*
       * ROLL-UPS THE ROW CANNOT ANSWER FOR ITSELF.
       *
       * A property's occupancy and its rent roll live in OTHER tables — how
       * many of its units are occupied, and what the active leases on them
       * come to. The console showed 0 for both and said so honestly in a
       * comment: "no endpoint computes them, and a plausible-looking number
       * on a portfolio screen is the kind of figure that gets reported
       * upwards."
       *
       * That was the right refusal and the wrong end state. They are the two
       * headline numbers of a property business, so they are counted here —
       * from the units and leases the caller can already see, in one grouped
       * query each rather than one per row.
       */
      const rolled = resource.rollup ? await resource.rollup(page, req.actor.orgId) : page;

      res.json({
        [slug]: rolled.map((r) => onRead(resource, r)),
        nextCursor: more ? rows[take - 1].id : null,
      });
    } catch (e) { next(e); }
  });

  /* ---------------------------------------------------------------- *
   * GET /:id
   * ---------------------------------------------------------------- */
  router.get("/:id", may("get"), async (req, res, next) => {
    try {
      const row = await model().findFirst({
        where: {
          id: req.params.id, orgId: req.actor.orgId,
          /*
           * AND, NOT SPREAD. The `sites` resource narrows on its OWN id —
           * scopeWhere returns { id: { in: allowed } } — and a spread puts
           * that key last, so it REPLACED the id being asked for. The
           * request became "any site in my remit", which Prisma answered
           * with the first one.
           *
           * GET /sites/B returned 200 with A's data. PATCH /sites/B renamed
           * A. DELETE /sites/B deleted A, and its buildings and units with
           * it. All three looked like they had worked.
           *
           * Every other resource narrows on `siteId`, which does not collide,
           * so this only ever bit sites — the one resource where being wrong
           * about WHICH row means being wrong about a whole property.
           */
          AND: [scopeWhere(req.actor, resource, slug) || {}],
        },
        include: withHistory(resource),
      });
      if (!row) throw hidden();
      res.json({ [singular(slug)]: onRead(resource, row) });
    } catch (e) { next(e); }
  });

  /* ---------------------------------------------------------------- *
   * POST /
   * ---------------------------------------------------------------- */
  /*
   * A RESOURCE MAY KEEP ITS OWN CREATE.
   *
   * When a declaration sets `ownCreate`, the framework does not register
   * one, and the request falls through to the hand-written route in
   * routes/products.js. Registering both is not a tie — whichever is
   * mounted first wins silently, and the other becomes dead code that
   * still looks correct when you read it. test/routing.test.js exists
   * because that had already happened once.
   */
  /*
   * `noCreate` — nothing creates this through the staff API at all, not even a
   * hand-written route. `ownCreate` means "written by hand elsewhere in this
   * service"; `noCreate` means "written by somebody who is not staff". The
   * guest portal is the first of those.
   */
  if (!resource.ownCreate && !resource.noCreate) {
  router.post("/", may("create"), async (req, res, next) => {
    try {
      const data = clean(resource, req.body, { partial: false });
      await checkReferences(resource, data, req.actor.orgId);

      /*
       * AND IT CANNOT BE WRITTEN OUTSIDE THE REMIT EITHER.
       *
       * Narrowing reads alone would let a guard on one gate file an incident
       * against another, then never see it again — a record nobody asked for,
       * in a place they cannot reach.
       */
      const allowed = scopedSites(req.actor);
      if (allowed !== null && data.siteId && !allowed.includes(String(data.siteId))) {
        throw forbidden(
          "That site is not part of your remit. You can only add " + label +
          " at the sites you are assigned to.");
      }

      if (resource.numbered) data[resource.numbered] = await nextNumber(resource, slug, req.actor.orgId);

      let row;
      try {
        row = await model().create({
          /* orgId LAST, so that even a declaration that mistakenly listed it
             as writable could not override the session's. */
          data: { ...data, orgId: req.actor.orgId },
          include: resource.include,
        });
      } catch (e) {
        throw translate(e, label);
      }

      if (resource.history) await appendHistory(resource, row, "created", req);
      await audit(req, "create", resource.model, row.id, { fields: Object.keys(data) });

      res.status(201).json({ [singular(slug)]: row, ...(await afterWrite(resource, {
        row, before: null, action: "create", req,
      })) });
    } catch (e) { next(e); }
  });
  }

  /* ---------------------------------------------------------------- *
   * PATCH /:id
   * ---------------------------------------------------------------- */
  /*
   * `ownUpdate` — the same arrangement as `ownCreate` above, for a resource
   * whose edit rules the framework cannot express.
   *
   * The site diary is the first: three of its rules are about WHICH DAY an
   * entry is for — one per project per day, never a day that has not
   * happened, and fixed once the day is over — and the framework has no
   * opinion about days. Registering both would not be a tie; whichever mounts
   * first wins silently and the other becomes dead code that still reads as
   * correct, which is exactly what routing.test.js exists to catch.
   */
  if (!resource.ownUpdate) {
  router.patch("/:id", may("update"), async (req, res, next) => {
    try {
      const before = await model().findFirst({
        where: {
          id: req.params.id, orgId: req.actor.orgId,
          /*
           * AND, NOT SPREAD. The `sites` resource narrows on its OWN id —
           * scopeWhere returns { id: { in: allowed } } — and a spread puts
           * that key last, so it REPLACED the id being asked for. The
           * request became "any site in my remit", which Prisma answered
           * with the first one.
           *
           * GET /sites/B returned 200 with A's data. PATCH /sites/B renamed
           * A. DELETE /sites/B deleted A, and its buildings and units with
           * it. All three looked like they had worked.
           *
           * Every other resource narrows on `siteId`, which does not collide,
           * so this only ever bit sites — the one resource where being wrong
           * about WHICH row means being wrong about a whole property.
           */
          AND: [scopeWhere(req.actor, resource, slug) || {}],
        },
      });
      if (!before) throw hidden();

      const data = clean(resource, req.body, { partial: true });
      if (!Object.keys(data).length) throw badRequest("Nothing to change.");
      await checkReferences(resource, data, req.actor.orgId);

      /*
       * updateMany, NOT update.
       *
       * `update` takes a unique `where`, which means it takes an id and
       * nothing else — the organization cannot be part of it. The row is
       * re-read above, so this is belt and braces; but it is the kind of
       * belt that costs nothing and the kind of braces that has saved
       * somebody's data before.
       */
      await model().updateMany({ where: { id: before.id, orgId: req.actor.orgId }, data });

      const row = await model().findFirst({
        where: { id: before.id, orgId: req.actor.orgId },
        include: resource.include,
      });

      const statusField = resource.statusField || "status";
      if (resource.history && data[statusField] && data[statusField] !== before[statusField]) {
        await appendHistory(resource, row, String(data[statusField]).toLowerCase().replace(/_/g, " "), req);
      }
      await audit(req, "update", resource.model, row.id, { fields: Object.keys(data) });

      res.json({ [singular(slug)]: row, ...(await afterWrite(resource, {
        row, before, action: "update", req,
      })) });
    } catch (e) { next(e); }
  });

  }

  /* ---------------------------------------------------------------- *
   * DELETE /:id
   * ---------------------------------------------------------------- */
  router.delete("/:id", may("delete"), async (req, res, next) => {
    try {
      if (resource.noDelete) throw forbidden(resource.noDelete);

      const { count } = await model().deleteMany({
        where: {
          id: req.params.id, orgId: req.actor.orgId,
          /*
           * AND, NOT SPREAD. The `sites` resource narrows on its OWN id —
           * scopeWhere returns { id: { in: allowed } } — and a spread puts
           * that key last, so it REPLACED the id being asked for. The
           * request became "any site in my remit", which Prisma answered
           * with the first one.
           *
           * GET /sites/B returned 200 with A's data. PATCH /sites/B renamed
           * A. DELETE /sites/B deleted A, and its buildings and units with
           * it. All three looked like they had worked.
           *
           * Every other resource narrows on `siteId`, which does not collide,
           * so this only ever bit sites — the one resource where being wrong
           * about WHICH row means being wrong about a whole property.
           */
          AND: [scopeWhere(req.actor, resource, slug) || {}],
        },
      });
      if (!count) throw hidden();

      await audit(req, "delete", resource.model, req.params.id, null);
      res.json({ deleted: req.params.id });
    } catch (e) { next(e); }
  });

  return router;
}

/* ====================================================================== *
 * HISTORY.
 * ====================================================================== */

function withHistory(resource) {
  if (!resource.history) return resource.include;
  return { ...(resource.include || {}), events: { orderBy: { at: "asc" } } };
}

/**
 * WHAT HAPPENS AFTER A ROW IS WRITTEN.
 *
 * A resource may declare `afterWrite({ row, before, action, req, db })`. It
 * runs once the write has succeeded and been audited, and whatever object it
 * returns is merged into the response beside the row.
 *
 * IT EXISTS FOR THE BOOKS. An expense recorded and an invoice issued should
 * post a journal entry, and there was nowhere in this framework for that to
 * happen — those two are built from declarations rather than hand-written
 * handlers, so there was no line to add it to.
 *
 * ── IT CANNOT UNDO THE WRITE, DELIBERATELY ─────────────────────────────
 *
 * A throw here is caught and logged rather than propagated. The rule the
 * ledger bridge is built on is that bookkeeping never blocks the business
 * record: an expense that was genuinely incurred must be recorded whether or
 * not this company has set up a chart of accounts. A hook that could 500 the
 * request would be exactly the coupling that rule exists to prevent.
 *
 * So it reports rather than refuses — the same way appendHistory below does.
 */
async function afterWrite(resource, ctx) {
  if (!resource.afterWrite) return {};
  try {
    return (await resource.afterWrite({ ...ctx, db })) || {};
  } catch (e) {
    console.error("afterWrite failed", resource.model, ctx.row && ctx.row.id, e.message);
    return {};
  }
}

/**
 * WHAT A ROW LOOKS LIKE ON THE WAY OUT.
 *
 * A resource may declare `onRead(row)` returning fields to merge onto it. It
 * is for facts that are DERIVED rather than stored — which moves a decision
 * may still make, what a task is waiting on — where storing them would mean
 * keeping a copy of a rule in a column and having to remember to update it.
 *
 * IT EXISTS SO A SCREEN NEVER OFFERS A BUTTON THE SERVER WOULD REFUSE. The
 * decision register only moves forwards along one table; a console that kept
 * its own copy of that table would drift from it on the first change, and the
 * drift shows up as a person pressing Approve and being told no.
 *
 * Pure and synchronous on purpose. A hook that could query would be a query
 * per row on every list, which is how a fast list becomes a slow one without
 * anybody noticing.
 */
function onRead(resource, row) {
  if (!resource.onRead || !row) return row;
  try {
    return { ...row, ...(resource.onRead(row) || {}) };
  } catch (e) {
    /* Derived fields are a convenience; the row is the record. Losing the
       former must never cost the latter. */
    console.error("onRead failed", resource.model, row.id, e.message);
    return row;
  }
}

/**
 * Append, never update.
 *
 * A work order's or an incident's history is what somebody reads months
 * later to find out what actually happened. An entry that can be edited
 * afterwards is not a history, it is a draft.
 */
async function appendHistory(resource, row, what, req) {
  try {
    await db[resource.history.model].create({
      data: {
        [resource.history.key]: row.id,
        what,
        status: row[resource.statusField || "status"],
        byId: req.session.userId,
        /* The name as well as the id: somebody who leaves the company must
           not erase the record of what they did. */
        byName: req.view?.user?.name || req.view?.user?.email || "",
      },
    });
  } catch (e) {
    console.error("history write failed", resource.model, row.id, e.message);
  }
}

/* ====================================================================== *
 * TURNING A DATABASE ERROR INTO A SENTENCE.
 * ====================================================================== */

function translate(e, label) {
  /* P2002 — a unique constraint. The caller broke a rule they can fix. */
  if (e && e.code === "P2002") {
    const on = (e.meta && e.meta.target) || [];
    const field = Array.isArray(on) ? on.filter((f) => f !== "orgId").join(", ") : String(on);
    return conflict(
      field
        ? `Another of this company's ${label} already uses that ${field}.`
        : `That would duplicate one of this company's ${label}.`);
  }
  /* P2003 — a foreign key. checkReferences catches the ones a caller sends;
     this catches a race where the row was deleted in between. */
  if (e && e.code === "P2003") {
    return badRequest("Something this refers to no longer exists. Reload and try again.");
  }
  /*
   * P2011 — a NOT NULL column with nothing in it. The declaration should
   * have listed the field as required, and a test now insists that it does;
   * this is the net underneath, so that the worst case is a 400 naming the
   * column rather than a 500 saying nothing.
   */
  if (e && e.code === "P2011") {
    const col = (e.meta && (e.meta.target || e.meta.constraint)) || "";
    const name = Array.isArray(col) ? col.join(", ") : String(col);
    return badRequest(
      name ? `${name} is required.` : `Something required was missing from that ${label.replace(/s$/, "")}.`);
  }
  return e;
}

/** `work-orders` → `workOrder`, for the single-row envelope. */
function singular(slug) {
  const base = slug
    .replace(/ies$/, "y")
    .replace(/sses$/, "ss")
    /*
     * `dispatches` → `dispatch`, not `dispatche`.
     *
     * English adds -ES rather than -S after a sibilant, and stripping one
     * letter from those leaves a word that is not a word. It surfaced on the
     * first resource whose name ends in one: every response came back under
     * `{ dispatche: ... }`, which is the sort of thing that is only ever found
     * by a caller reading undefined.
     *
     * A bare `s` is deliberately NOT in this set — `expenses` ends in -ses and
     * is an -s plural, so including it would turn `expense` into `expens`.
     */
    .replace(/(ch|sh|x|z)es$/, "$1")
    .replace(/s$/, "");
  return base.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
