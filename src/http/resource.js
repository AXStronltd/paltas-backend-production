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
import { db } from "../db.js";
import { RESOURCES } from "../domain/registry.js";
import { allows, whyNotArea } from "../domain/access.js";
import { badRequest, conflict, forbidden, hidden } from "./errors.js";
import { clean } from "../domain/input.js";
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
      const where = { orgId: req.actor.orgId };

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
      res.json({
        [slug]: more ? rows.slice(0, take) : rows,
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
        where: { id: req.params.id, orgId: req.actor.orgId },
        include: withHistory(resource),
      });
      if (!row) throw hidden();
      res.json({ [singular(slug)]: row });
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
  if (!resource.ownCreate) {
  router.post("/", may("create"), async (req, res, next) => {
    try {
      const data = clean(resource, req.body, { partial: false });
      await checkReferences(resource, data, req.actor.orgId);

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

      res.status(201).json({ [singular(slug)]: row });
    } catch (e) { next(e); }
  });
  }

  /* ---------------------------------------------------------------- *
   * PATCH /:id
   * ---------------------------------------------------------------- */
  router.patch("/:id", may("update"), async (req, res, next) => {
    try {
      const before = await model().findFirst({
        where: { id: req.params.id, orgId: req.actor.orgId },
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

      res.json({ [singular(slug)]: row });
    } catch (e) { next(e); }
  });

  /* ---------------------------------------------------------------- *
   * DELETE /:id
   * ---------------------------------------------------------------- */
  router.delete("/:id", may("delete"), async (req, res, next) => {
    try {
      if (resource.noDelete) throw forbidden(resource.noDelete);

      const { count } = await model().deleteMany({
        where: { id: req.params.id, orgId: req.actor.orgId },
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
  const base = slug.replace(/ies$/, "y").replace(/sses$/, "ss").replace(/s$/, "");
  return base.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
