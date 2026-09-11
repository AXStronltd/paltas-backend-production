/* ====================================================================== *
 * /promotions — the workflow, enforced.
 *
 * The eight endpoints named in backend.md §4b, in the same order, with the
 * same shapes. The frontend's `PromoAPI` was written against this months
 * before it existed; swapping its insides for fetch() is the only change the
 * frontend needs, and no screen changes at all.
 *
 * Three things this file does that the browser's copy cannot:
 *
 *   IT DECIDES WHO YOU ARE. Not the request body, not a header, not a role
 *   the client claims. `req.actor` is assembled from the session row.
 *
 *   IT OWNS THE ARROWS. A promotion moves along the state machine in
 *   lib/promotions.js or it does not move. There is no arrow from DRAFT to
 *   PUBLISHED, so no request can draw one.
 *
 *   IT DECIDES WHAT THE WORLD SEES. One function, one index, three conditions,
 *   all required.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import { badRequest, forbidden, hidden, notFound } from "../lib/errors.js";
import {
  requireOpenSubscription, requireOrganization, requireSession, rateLimit,
} from "../lib/middleware.js";
import { can, whyNot } from "../lib/rights.js";
import {
  TRANSITIONS, cleanPromotionInput, contentCheck, creativeCheck,
  isPubliclyVisible, publicWhere, toPublicWire, toWire, transitionRefusal,
} from "../lib/promotions.js";

export const promotionRoutes = Router();

const INCLUDE = {
  org: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  events: { orderBy: { at: "asc" } },
};

/* ====================================================================== *
 * GET /promotions/public
 *
 * The only endpoint here an anonymous visitor can reach, and the only one that
 * matters if every other guard in this file were removed.
 *
 * It is defined FIRST, above the router-wide auth, because a homepage must not
 * need a session to know what PALTAS is promoting.
 * ====================================================================== */
promotionRoutes.get("/public",
  rateLimit({ windowMs: 60_000, max: 240 }),
  async (req, res, next) => {
    try {
      const today = req.query.today ? new Date(String(req.query.today)) : new Date();
      if (Number.isNaN(today.getTime())) throw badRequest("`today` is not a date.");

      const rows = await db.promotion.findMany({
        where: publicWhere(today),
        include: { org: { select: { name: true } } },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        take: 50,
      });

      /* Checked AGAIN in memory. The `where` makes it fast; this makes it
         right. If the two ever disagree, what leaks is nothing. */
      const safe = rows.filter((p) => isPubliclyVisible(p, today));

      /* A public answer is cacheable for a minute — that is the difference
         between a homepage that survives being linked somewhere busy and one
         that does not. It is `public` because it contains nothing about
         anybody: no session is consulted to produce it. */
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ promotions: safe.map(toPublicWire) });
    } catch (e) { next(e); }
  });

/* ====================================================================== *
 * Everything below needs a session, a company, and an open subscription.
 * ====================================================================== */
promotionRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

/**
 * GET /promotions?scope=mine|all&status=&queue=&finalQueue=
 *
 * `scope=all` is not a parameter anybody may pass — it is PALTAS staff reading
 * every company's work, and asking for it without the right is refused rather
 * than quietly narrowed, so an integration bug is visible.
 */
promotionRoutes.get("/", async (req, res, next) => {
  try {
    const actor = req.actor;
    const scope = String(req.query.scope || "mine");
    const wantsAll = scope === "all" || req.query.queue === "true" || req.query.finalQueue === "true";

    if (wantsAll && !can(actor, "queue")) {
      throw forbidden("Only PALTAS staff can read other companies' promotions.");
    }

    const where = {};
    if (!wantsAll) where.orgId = actor.orgId;

    if (req.query.queue === "true") {
      where.status = { in: ["SUBMITTED", "UNDER_REVIEW", "RESUBMITTED"] };
    } else if (req.query.finalQueue === "true") {
      if (!can(actor, "finalQueue")) {
        throw forbidden("The final approval queue belongs to a PALTAS publisher.");
      }
      where.status = "MARKETING_APPROVED";
    } else if (req.query.status) {
      where.status = String(req.query.status);
    }

    const rows = await db.promotion.findMany({
      where,
      include: INCLUDE,
      orderBy: { updatedAt: "desc" },
      take: Math.min(Number(req.query.limit) || 100, 200),
    });

    res.setHeader("Cache-Control", "no-store, private");
    res.json({ promotions: rows.map(toWire) });
  } catch (e) { next(e); }
});

/** GET /promotions/:ref */
promotionRoutes.get("/:ref", async (req, res, next) => {
  try {
    const p = await load(req.params.ref);
    if (!p) throw notFound("No promotion with that reference.");
    if (!mayRead(req.actor, p)) throw hidden();
    res.setHeader("Cache-Control", "no-store, private");
    res.json(toWire(p));
  } catch (e) { next(e); }
});

/**
 * GET /promotions/:ref/checks — the content and creative checks, from the
 * server, so a reviewer and a customer are never reading two different
 * verdicts on the same promotion.
 */
promotionRoutes.get("/:ref/checks", async (req, res, next) => {
  try {
    const p = await load(req.params.ref);
    if (!p) throw notFound("No promotion with that reference.");
    if (!mayRead(req.actor, p)) throw hidden();
    res.json({ content: contentCheck(p), creative: creativeCheck(p.imageMeta) });
  } catch (e) { next(e); }
});

/** POST /promotions — always a DRAFT, whatever the body says. */
promotionRoutes.post("/", async (req, res, next) => {
  try {
    const no = whyNot(req.actor, "create");
    if (no) throw forbidden(no);

    const data = cleanPromotionInput(req.body);
    const ref = await nextRef();

    const p = await db.promotion.create({
      data: {
        ...data,
        ref,
        orgId: req.actor.orgId,
        createdById: req.actor.userId,
        /* NOT from the body. `cleanPromotionInput` has no `status` field, so
           there is no path to it — but saying it here as well means the next
           person to read this route sees the rule rather than inferring it. */
        status: "DRAFT",
        events: {
          create: {
            what: "created", why: "Draft started.", status: "DRAFT",
            byId: req.actor.userId, byName: req.actor.userName,
          },
        },
      },
      include: INCLUDE,
    });

    res.status(201).json(toWire(p));
  } catch (e) { next(e); }
});

/**
 * PATCH /promotions/:ref
 *
 * A promotion is editable by its company while it is a draft, or while PALTAS
 * has handed it back. Once it is submitted it belongs to the review until the
 * review returns it — otherwise a reviewer reads one thing and approves
 * another, which is the failure this whole workflow exists to prevent.
 */
promotionRoutes.patch("/:ref", async (req, res, next) => {
  try {
    const p = await load(req.params.ref);
    if (!p) throw notFound("No promotion with that reference.");
    if (!mayWrite(req.actor, p)) throw hidden();

    const EDITABLE = ["DRAFT", "CHANGES_REQUESTED", "REJECTED"];
    if (!EDITABLE.includes(p.status)) {
      throw forbidden(
        "This promotion is with PALTAS. You can change it again as soon as they come back to you — " +
        "which they will, either way."
      );
    }

    const data = cleanPromotionInput(req.body);
    const updated = await db.promotion.update({
      where: { id: p.id }, data, include: INCLUDE,
    });
    res.json(toWire(updated));
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * The transitions. One handler, because they differ only in the arrow they
 * follow and who may follow it — and a single handler is how they stay
 * impossible to get subtly out of step with each other.
 * ====================================================================== */

const ACTIONS = {
  "submit": { action: "submit", what: (from) => (from === "DRAFT" ? "submitted" : "resubmitted"),
    say: (from) => (from === "DRAFT" ? "Sent to PALTAS Marketing." : "Changes made and sent back to PALTAS.") },
  "review/claim": { action: "claim", what: () => "taken for review", say: () => "A reviewer is reading it." },
  "review/approve": { action: "approveMarketing", what: () => "approved by marketing",
    say: () => "Approved for final review." },
  "review/changes": { action: "requestChanges", what: () => "changes requested", say: () => "" },
  "review/reject": { action: "reject", what: () => "not accepted", say: () => "" },
  "publish": { action: "publish", what: () => "published", say: () => "Live on paltas.io." },
  "schedule": { action: "schedule", what: () => "scheduled", say: () => "" },
  "pause": { action: "pause", what: () => "paused", say: () => "" },
};

for (const [path, spec] of Object.entries(ACTIONS)) {
  promotionRoutes.post(`/:ref/${path}`, async (req, res, next) => {
    try {
      const t = TRANSITIONS[spec.action];
      const actor = req.actor;

      const no = whyNot(actor, t.right);
      if (no) throw forbidden(no);

      const p = await load(req.params.ref);
      if (!p) throw notFound("No promotion with that reference.");

      /* A customer may only act on their own; PALTAS staff act on anybody's. */
      const isStaff = can(actor, "queue");
      if (!isStaff && p.orgId !== actor.orgId) throw hidden();

      if (!t.from.includes(p.status)) {
        throw badRequest(transitionRefusal(spec.action, p.status));
      }

      const message = String(req.body?.message || "").trim();

      /*
       * A REQUEST FOR CHANGES WITHOUT A MESSAGE IS NOT A REQUEST FOR CHANGES.
       *
       * The customer's screen shows this message and nothing else. An empty
       * one sends somebody back to a form to guess what a reviewer wanted,
       * and they will guess wrong, and it will come back again.
       */
      if (t.needsMessage && message.length < 10) {
        throw badRequest(
          "Say what needs to change, in at least a sentence. The customer sees this message and " +
          "nothing else — “not approved” on its own sends them back to guess."
        );
      }

      /* Submitting is the one transition with a quality bar, and it is the
         customer's own check — the same ten rules their screen ran. */
      if (spec.action === "submit") {
        const check = contentCheck(p);
        if (!check.ready) {
          const blocking = check.rows.filter((r) => r.st === "ACTION").map((r) => r.k);
          throw badRequest(
            "This promotion is not ready to submit: " + blocking.join(", ") + ".",
            check.rows
          );
        }
      }

      const to = t.to(p.status);
      const updated = await db.promotion.update({
        where: { id: p.id },
        data: {
          status: to,
          reviewedBy: isStaff ? actor.userName : p.reviewedBy,
          events: {
            create: {
              what: spec.what(p.status),
              why: message || spec.say(p.status),
              status: to,
              byId: actor.userId,
              byName: actor.userName,
            },
          },
        },
        include: INCLUDE,
      });

      res.json(toWire(updated));
    } catch (e) { next(e); }
  });
}

/* ------------------------------------------------------------ helpers */

const load = (ref) => db.promotion.findUnique({ where: { ref: String(ref) }, include: INCLUDE });

/** PALTAS staff read everything. Everybody else reads their own company's. */
function mayRead(actor, p) {
  return can(actor, "queue") || p.orgId === actor.orgId;
}

/**
 * Writing is narrower than reading, deliberately: PALTAS staff can READ a
 * customer's promotion and cannot EDIT it. A reviewer who could quietly fix
 * the copy would be approving their own work, and the customer whose name is
 * on it would never know.
 */
function mayWrite(actor, p) {
  if (p.orgId !== actor.orgId) return false;
  if (can(actor, "editOrg")) return true;
  return can(actor, "editOwn") && p.createdById === actor.userId;
}

/**
 * PR-0001, PR-0002…
 *
 * An atomic increment on a counter row, not `count() + 1`. Two people creating
 * a promotion in the same second must not both be told they made PR-0007.
 */
async function nextRef() {
  const row = await db.counter.upsert({
    where: { name: "promotion" },
    create: { name: "promotion", value: 1 },
    update: { value: { increment: 1 } },
  });
  return "PR-" + String(row.value).padStart(4, "0");
}
