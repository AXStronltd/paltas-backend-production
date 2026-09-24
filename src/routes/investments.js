/* ====================================================================== *
 * TOKENISED REAL-ESTATE INVESTMENT.
 *
 * Additive. Not one existing route changed; every path here is new and sits
 * under /investments or /tokenization.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────
 *
 * Four of the module's tables ARE registry resources and get their five
 * endpoints for free: investors, investor-profiles, investment-orders (read
 * only) and token-holdings (read only). What cannot be a registry resource is
 * the OFFERING, and the reason is the whole point of the module:
 *
 *     A generic PATCH /offerings/:id would let the company raising the money
 *     set its own status to LIVE.
 *
 * So an offering moves only through the transitions in
 * src/domain/investments.js, each behind a named right, and a company holds
 * none of the rights that approve one.
 *
 * ── THREE GATES, IN THIS ORDER ──────────────────────────────────────────
 *
 *   1. session + organization + open subscription   (the router's middleware)
 *   2. the `investments` AREA, at the level the verb needs   (need())
 *   3. IssuerProfile.status === "APPROVED"                   (issuer())
 *
 * The third is not a subscription. A company may hold every product PALTAS
 * sells and still not be allowed to raise a penny, because that permission
 * comes from a regulator and PALTAS only records it.
 *
 * ── WHAT PALTAS IS NOT ──────────────────────────────────────────────────
 *
 * Not the owner, not the issuer, not the regulated partner, not the custodian.
 * Those are named on each offering as OfferingParty rows, and an offering
 * cannot be submitted without at least the property owner and the issuer.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import {
  badRequest, conflict, forbidden, hidden, unavailable,
} from "../http/errors.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.js";
import { whyNotArea } from "../domain/access.ts";
import {
  EDITABLE_STATES, OFFERING_TRANSITIONS, canOffering, eligibilityRefusal,
  offeringRefusal, splitCodes, submissionGaps,
} from "../domain/investments.js";
import * as tokens from "../domain/tokenisation.js";

export const investmentRoutes = Router();

const guarded = Router();
guarded.use(requireSession(), requireOrganization(), requireOpenSubscription());
investmentRoutes.use(guarded);

/** The `investments` area, at the level this verb needs. For the COMPANY side. */
function need(req, act, label) {
  const why = whyNotArea(req.actor, "investments", act, label || "investments");
  if (why) throw forbidden(why);
}

/**
 * A read that a REVIEWER must also be able to make.
 *
 * PALTAS's reviewing roles hold `none` on every customer area by design — their
 * authority is the PLATFORM entitlement and the rights table. So an area check
 * alone blocks them from reading the very offering they were asked to review,
 * along with its parties and its documents. That is not a theoretical problem:
 * it is the second half of the bug described on ownOffering(), and it made the
 * review queue unreadable to the only people allowed to read it.
 *
 * Either gate is enough, and neither widens the other: a customer passes on the
 * area, a reviewer on the `queue` right, and nobody else holds either.
 */
function needRead(req, act, label) {
  if (canOffering(req.actor, "queue")) return;
  need(req, act, label);
}

/**
 * Is this company allowed to run offerings?
 *
 * Returns the profile, because every caller wants it — `jurisdictions` bounds
 * what an offering may name, and the licence reference belongs on the screen.
 */
async function issuer(req, { mustBeApproved = true } = {}) {
  const profile = await db.issuerProfile.findUnique({ where: { orgId: req.actor.orgId } });
  if (!mustBeApproved) return profile;
  if (!profile || profile.status !== "APPROVED") {
    /*
     * The same sentence whether there is no profile or a suspended one.
     *
     * "You have not applied" and "you were suspended" are different facts, and
     * the second is not this endpoint's to disclose to whoever is holding the
     * session — it is a conversation with PALTAS, not a 403 body.
     */
    throw forbidden(
      "This company is not an approved issuer, so it cannot create or change " +
      "investment offerings. Approval is recorded by PALTAS once the regulated " +
      "partner confirms it.");
  }
  return profile;
}

/**
 * An offering this caller may act on.
 *
 * A CUSTOMER may only reach its own. PALTAS STAFF reach anybody's — and they
 * have to, because a reviewer sits in PALTAS's own organization and a strictly
 * org-scoped lookup makes the entire review step unreachable. That was the bug
 * this comment replaces: submit, claim, approve and goLive all answered 403 for
 * the only people holding those rights.
 *
 * Identical to routes/promotions.js, which solved the same problem first:
 *
 *     const isStaff = can(actor, "queue");
 *     if (!isStaff && p.orgId !== actor.orgId) throw hidden();
 *
 * `queue` is the right that means "reviews other companies' work", and no
 * customer role holds it. So this widens nothing for a customer: the cross-org
 * path exists only for an actor who already had to be PALTAS staff.
 */
async function ownOffering(req, id, extra) {
  const reviewer = canOffering(req.actor, "queue");
  const row = await db.offering.findFirst({
    where: {
      id: String(id),
      /* Narrowed for a customer; unnarrowed only for a reviewer. */
      ...(reviewer ? {} : { orgId: req.actor.orgId }),
    },
    ...(extra || {}),
  });
  if (!row) throw hidden();
  return row;
}

/** The next reference for this company, atomically. */
async function nextRef(prefix, orgId) {
  const name = `${prefix}:${orgId}`;
  const row = await db.counter.upsert({
    where: { name }, create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${String(row.value).padStart(4, "0")}`;
}

async function audit(req, action, entity, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        orgId: req.actor.orgId, actorId: req.session.userId,
        actorName: req.actor.userName || "", action, entity,
        entityId: String(entityId || ""), detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) { /* best effort, exactly as elsewhere: the work stands */ }
}

/** Money as the rest of this service stores it. */
const big = (v) => (typeof v === "bigint" ? v : BigInt(Math.round(Number(v) || 0)));

/**
 * The wire shape of an offering.
 *
 * `raised` is included; `parties` and `documents` only when asked for, because
 * a list of forty offerings does not need four hundred party rows.
 */
function offeringWire(o) {
  return {
    id: o.id, ref: o.ref, title: o.title, summary: o.summary,
    structure: o.structure, status: o.status, sandbox: o.sandbox,
    currency: o.currency,
    targetRaise: o.targetRaise, raised: o.raised,
    tokenUnits: o.tokenUnits, unitPrice: o.unitPrice,
    minInvestment: o.minInvestment, minUnits: o.minUnits,
    eligibility: o.eligibility, jurisdictions: o.jurisdictions,
    distributionRule: o.distributionRule, targetYieldBps: o.targetYieldBps,
    projectId: o.projectId, siteId: o.siteId, unitId: o.unitId,
    opensOn: o.opensOn, closesOn: o.closesOn,
    submittedAt: o.submittedAt, approvedAt: o.approvedAt,
    liveAt: o.liveAt, closedAt: o.closedAt,
    decisionNote: o.decisionNote,
    ...(o.parties ? { parties: o.parties } : {}),
    ...(o.documents ? { documents: o.documents } : {}),
    ...(o._count ? { counts: o._count } : {}),
  };
}

/* ====================================================================== *
 * 1. IS THIS COMPANY ELIGIBLE, AND WHAT IS IT ALLOWED TO DO?
 *
 * The Overview and Settings screens open on this. Readable by anyone with
 * `investments` read, because "we are not approved yet" is the first thing
 * somebody needs to be told rather than discover from a 403.
 * ====================================================================== */
guarded.get("/investments/eligibility", async (req, res, next) => {
  try {
    need(req, "list", "investments");
    const profile = await issuer(req, { mustBeApproved: false });
    res.json({
      eligible: Boolean(profile && profile.status === "APPROVED"),
      status: profile ? profile.status : "NOT_APPLIED",
      regulator: profile ? profile.regulator : "",
      licenceRef: profile ? profile.licenceRef : "",
      legalName: profile ? profile.legalName : "",
      jurisdictions: profile ? splitCodes(profile.jurisdictions) : [],
      approvedAt: profile ? profile.approvedAt : null,
      /* Who approved it is recorded, and shown: a company is entitled to know
         on whose authority it may raise money. */
      approvedBy: profile ? profile.approvedBy : "",
      tokenisation: tokens.status(),
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 2. OFFERINGS.
 * ====================================================================== */

guarded.get("/investments/offerings", async (req, res, next) => {
  try {
    needRead(req, "list", "offerings");
    const take = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    /*
     * `?queue=true` is PALTAS staff reading every company's submissions. Asking
     * for it without the right is REFUSED rather than quietly narrowed to your
     * own, so an integration bug is visible instead of silently returning the
     * wrong list. The same choice routes/promotions.js makes.
     */
    const wantsQueue = String(req.query.queue) === "true";
    if (wantsQueue && !canOffering(req.actor, "queue")) {
      throw forbidden("Only PALTAS staff read the review queue.");
    }

    const where = wantsQueue ? {} : { orgId: req.actor.orgId };
    if (wantsQueue) where.status = { in: ["SUBMITTED", "UNDER_REVIEW"] };
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    /*
     * SANDBOX IS EXCLUDED UNLESS ASKED FOR.
     *
     * A test offering must never be counted in a real total by accident, so the
     * default is production-only and including them takes a deliberate
     * ?sandbox=true. The reverse default would make every sum on the Overview
     * screen quietly wrong.
     */
    where.sandbox = String(req.query.sandbox) === "true";

    const rows = await db.offering.findMany({
      where, orderBy: [{ createdAt: "desc" }], take,
      include: {
        _count: { select: { orders: true, holdings: true, parties: true, documents: true } },
        project: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
      },
    });
    res.json({ offerings: rows.map(offeringWire) });
  } catch (e) { next(e); }
});

guarded.get("/investments/offerings/:id", async (req, res, next) => {
  try {
    needRead(req, "get", "offerings");
    const o = await ownOffering(req, req.params.id, {
      include: {
        parties: { orderBy: { role: "asc" } },
        documents: { include: { document: { select: { id: true, name: true, kind: true } } } },
        _count: { select: { orders: true, holdings: true } },
        project: { select: { id: true, name: true } },
      },
    });
    const profile = await issuer(req, { mustBeApproved: false });
    res.json({
      offering: offeringWire(o),
      /* What still stands between this and a submission. Computed rather than
         stored, so it is never stale. */
      outstanding: submissionGaps(o, {
        parties: o.parties, documents: o.documents, issuer: profile,
      }),
    });
  } catch (e) { next(e); }
});

/**
 * Create an offering against something the company already owns.
 *
 * This is "Enable Investment" on an existing property or development. The
 * project, site or unit must be THIS company's — checked, not trusted.
 */
guarded.post("/investments/offerings", async (req, res, next) => {
  try {
    need(req, "create", "offerings");
    const profile = await issuer(req);
    const b = req.body || {};

    const title = String(b.title || "").trim();
    if (!title) throw badRequest("An offering needs a title.");

    /* Exactly one subject, and it must be ours. */
    const subjects = ["projectId", "siteId", "unitId"].filter((k) => b[k]);
    if (subjects.length !== 1) {
      throw badRequest(
        "Name exactly one of projectId, siteId or unitId — the development, " +
        "site or unit this offering is raised against.");
    }
    const key = subjects[0];
    const scope = { id: String(b[key]), orgId: req.actor.orgId };

    /*
     * THREE EXPLICIT QUERIES, NOT `db[model]`.
     *
     * A model reached through a variable cannot be read by the scanner in
     * tenancy.test.js, which cannot then tell whether the query was scoped to a
     * company — and it fails the build rather than guess. It is right to: the
     * one thing that must be obvious in this file is that every query names its
     * table and its orgId in the same line.
     */
    let owned = null;
    let what = "";
    if (key === "projectId") {
      what = "development";
      owned = await db.project.findFirst({ where: scope, select: { id: true } });
    } else if (key === "siteId") {
      what = "site";
      owned = await db.site.findFirst({ where: scope, select: { id: true } });
    } else {
      what = "unit";
      owned = await db.unit.findFirst({ where: scope, select: { id: true } });
    }
    if (!owned) throw badRequest(`That ${what} is not one of this company's.`);

    /* Jurisdictions may not exceed the licence. */
    const wanted = splitCodes(b.jurisdictions);
    const allowed = splitCodes(profile.jurisdictions);
    const outside = allowed.length ? wanted.filter((c) => !allowed.includes(c)) : [];
    if (outside.length) {
      throw badRequest(
        `This company is not licensed to offer in: ${outside.join(", ")}. ` +
        `Its licence covers: ${allowed.join(", ")}.`);
    }

    const sandbox = b.sandbox === true;
    const ref = await nextRef(sandbox ? "SBX" : "OFF", req.actor.orgId);

    const row = await db.offering.create({
      data: {
        orgId: req.actor.orgId,
        [key]: String(b[key]),
        ref, title,
        summary: String(b.summary || ""),
        structure: b.structure ? String(b.structure).toUpperCase() : undefined,
        currency: String(b.currency || "KES"),
        targetRaise: big(b.targetRaise),
        tokenUnits: Number(b.tokenUnits) || 0,
        unitPrice: big(b.unitPrice),
        minInvestment: big(b.minInvestment),
        minUnits: Number(b.minUnits) || 1,
        eligibility: b.eligibility ? String(b.eligibility).toUpperCase() : undefined,
        jurisdictions: wanted.join(","),
        distributionRule: String(b.distributionRule || ""),
        targetYieldBps: Number(b.targetYieldBps) || 0,
        opensOn: b.opensOn ? new Date(b.opensOn) : null,
        closesOn: b.closesOn ? new Date(b.closesOn) : null,
        sandbox,
        /* status stays DRAFT. There is no way to create one in any other state,
           which is the first half of "cannot go live without approval". */
      },
    });
    await audit(req, "investment.offering.create", "offering", row.id, { ref, sandbox });
    res.status(201).json({ offering: offeringWire(row) });
  } catch (e) { next(e); }
});

/** Edit an offering's definition — only while it is still editable. */
guarded.patch("/investments/offerings/:id", async (req, res, next) => {
  try {
    need(req, "update", "offerings");
    const profile = await issuer(req);
    const o = await ownOffering(req, req.params.id);

    if (!EDITABLE_STATES.has(o.status)) {
      throw conflict(
        `This offering is ${o.status.toLowerCase().replace(/_/g, " ")} and its terms are fixed. ` +
        `Terms can only change while it is a draft, or after a reviewer has asked for changes.`);
    }

    const b = req.body || {};
    const data = {};
    if (b.title !== undefined) data.title = String(b.title).trim();
    if (b.summary !== undefined) data.summary = String(b.summary);
    if (b.structure !== undefined) data.structure = String(b.structure).toUpperCase();
    if (b.currency !== undefined) data.currency = String(b.currency);
    if (b.targetRaise !== undefined) data.targetRaise = big(b.targetRaise);
    if (b.tokenUnits !== undefined) data.tokenUnits = Number(b.tokenUnits) || 0;
    if (b.unitPrice !== undefined) data.unitPrice = big(b.unitPrice);
    if (b.minInvestment !== undefined) data.minInvestment = big(b.minInvestment);
    if (b.minUnits !== undefined) data.minUnits = Number(b.minUnits) || 1;
    if (b.eligibility !== undefined) data.eligibility = String(b.eligibility).toUpperCase();
    if (b.distributionRule !== undefined) data.distributionRule = String(b.distributionRule);
    if (b.targetYieldBps !== undefined) data.targetYieldBps = Number(b.targetYieldBps) || 0;
    if (b.opensOn !== undefined) data.opensOn = b.opensOn ? new Date(b.opensOn) : null;
    if (b.closesOn !== undefined) data.closesOn = b.closesOn ? new Date(b.closesOn) : null;

    if (b.jurisdictions !== undefined) {
      const wanted = splitCodes(b.jurisdictions);
      const allowed = splitCodes(profile.jurisdictions);
      const outside = allowed.length ? wanted.filter((c) => !allowed.includes(c)) : [];
      if (outside.length) {
        throw badRequest(`This company is not licensed to offer in: ${outside.join(", ")}.`);
      }
      data.jurisdictions = wanted.join(",");
    }

    /*
     * `status`, `raised`, `sandbox` and every timestamp are absent by design.
     *
     * Status moves through POST /investments/offerings/:id/:action and nowhere
     * else. `raised` is the sum of settled orders. `sandbox` cannot change,
     * because a test offering that becomes a real one carries its test orders
     * with it.
     */
    const row = await db.offering.update({ where: { id: o.id }, data });
    await audit(req, "investment.offering.update", "offering", o.id, { fields: Object.keys(data) });
    res.json({ offering: offeringWire(row) });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * THE LIFECYCLE. One route, every transition.
 *
 * A single handler for all twelve actions, because the rules live in
 * OFFERING_TRANSITIONS and a handler per action is twelve places for one of
 * them to forget a check.
 * ---------------------------------------------------------------- */
guarded.post("/investments/offerings/:id/:action", async (req, res, next) => {
  try {
    const action = String(req.params.action);
    const rule = OFFERING_TRANSITIONS[action];
    /* Not a lifecycle action — let the more specific routes below try. */
    if (!rule) return next();

    /*
     * RIGHTS, NOT AREAS — and this is the bug that taught me why.
     *
     * The first version called need(req, "update", "offerings"), and it refused
     * every reviewer. PALTAS's own COMPLIANCE and PUBLISHER roles hold `none` on
     * every customer area by design: their authority comes from the PLATFORM
     * entitlement and the rights table, not from a company's areas. An area
     * check here therefore blocked exactly the people the review step exists
     * for, before offeringRefusal() was ever consulted.
     *
     * routes/promotions.js has no area check at all, for the same reason. So
     * the only gate on a transition is offeringRefusal(), which checks the
     * named right — and no customer role holds `approve` or `goLive`.
     */
    const o = await ownOffering(req, req.params.id, {
      include: { parties: true, documents: true },
    });
    const reason = String((req.body && (req.body.reason || req.body.note)) || "");

    const refusal = offeringRefusal(req.actor, action, o, { reason });
    if (refusal) throw forbidden(refusal);

    /*
     * SUBMISSION IS THE ONE THAT CHECKS COMPLETENESS.
     *
     * Everything else is a reviewer's decision about an offering that was
     * already complete enough to submit.
     */
    if (action === "submit") {
      const profile = await issuer(req);
      const gaps = submissionGaps(o, {
        parties: o.parties, documents: o.documents, issuer: profile,
      });
      if (gaps.length) {
        throw badRequest(
          "This offering is not ready to submit. It still needs: " + gaps.join("; ") + ".",
          { outstanding: gaps });
      }
    }

    const now = new Date();
    const stamp = {
      submit: { submittedAt: now, decisionNote: "" },
      claim: { reviewedAt: now },
      approve: { approvedAt: now },
      goLive: { liveAt: now },
      close: { closedAt: now },
    }[action] || {};

    const data = {
      status: rule.to,
      ...stamp,
      ...(rule.needsReason ? { decisionNote: reason, decidedBy: req.actor.userName || "" } : {}),
    };

    const row = await db.offering.update({ where: { id: o.id }, data });
    await audit(req, `investment.offering.${action}`, "offering", o.id,
      { from: o.status, to: rule.to, reason: reason || undefined });
    res.json({ offering: offeringWire(row), was: o.status });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 3. THE PARTIES. Who is who, named on the record.
 *
 * Not a registry resource: OfferingParty carries no orgId and is scoped
 * through the offering, which the caller already had to be allowed to see.
 * ====================================================================== */

guarded.get("/investments/offerings/:id/parties", async (req, res, next) => {
  try {
    needRead(req, "get", "offering parties");
    const o = await ownOffering(req, req.params.id, { select: { id: true } });
    const parties = await db.offeringParty.findMany({
      where: { offeringId: o.id }, orderBy: [{ role: "asc" }, { legalName: "asc" }],
    });
    res.json({ parties });
  } catch (e) { next(e); }
});

guarded.post("/investments/offerings/:id/parties", async (req, res, next) => {
  try {
    need(req, "create", "offering parties");
    await issuer(req);
    const o = await ownOffering(req, req.params.id);
    if (!EDITABLE_STATES.has(o.status)) {
      throw conflict(
        "The parties to an offering cannot change once it has been submitted. " +
        "Who the issuer and the custodian are is part of what a reviewer approved.");
    }
    const b = req.body || {};
    const role = String(b.role || "").toUpperCase();
    const legalName = String(b.legalName || "").trim();
    if (!role) throw badRequest("Say what part this entity plays — its role.");
    if (!legalName) throw badRequest("A party needs its legal name, as registered.");

    const row = await db.offeringParty.create({
      data: {
        offeringId: o.id, role, legalName,
        registration: String(b.registration || ""),
        jurisdiction: String(b.jurisdiction || "").toUpperCase(),
        regulator: String(b.regulator || ""),
        contact: String(b.contact || ""),
        note: String(b.note || ""),
      },
    }).catch((e) => {
      if (String(e && e.code) === "P2002") {
        throw conflict(`${legalName} is already named as ${role.toLowerCase()} on this offering.`);
      }
      throw e;
    });
    await audit(req, "investment.party.add", "offeringParty", row.id, { role, legalName });
    res.status(201).json({ party: row });
  } catch (e) { next(e); }
});

guarded.delete("/investments/offerings/:id/parties/:partyId", async (req, res, next) => {
  try {
    need(req, "delete", "offering parties");
    const o = await ownOffering(req, req.params.id, { select: { id: true, status: true } });
    if (!EDITABLE_STATES.has(o.status)) {
      throw conflict("The parties to a submitted offering cannot be removed.");
    }
    const { count } = await db.offeringParty.deleteMany({
      where: { id: String(req.params.partyId), offeringId: o.id },
    });
    if (!count) throw hidden();
    await audit(req, "investment.party.remove", "offeringParty", req.params.partyId, {});
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 4. THE DOCUMENTS. Pointing at the Document table that already exists.
 * ====================================================================== */

guarded.get("/investments/offerings/:id/documents", async (req, res, next) => {
  try {
    needRead(req, "get", "offering documents");
    const o = await ownOffering(req, req.params.id, { select: { id: true } });
    const rows = await db.offeringDocument.findMany({
      where: { offeringId: o.id },
      include: {
        document: {
          select: {
            id: true, name: true, kind: true, bytes: true, mimeType: true,
            expiresAt: true, createdAt: true,
            /* storageKey is NOT returned. Where a file physically lives is not
               something a list of documents needs to hand out. */
          },
        },
      },
      orderBy: [{ role: "asc" }],
    });
    res.json({ documents: rows });
  } catch (e) { next(e); }
});

guarded.post("/investments/offerings/:id/documents", async (req, res, next) => {
  try {
    need(req, "create", "offering documents");
    await issuer(req);
    const o = await ownOffering(req, req.params.id, { select: { id: true } });
    const b = req.body || {};

    /* The document must already exist, and be this company's. Uploading is the
       existing documents capability; this only attaches one. */
    const doc = await db.document.findFirst({
      where: { id: String(b.documentId || ""), orgId: req.actor.orgId },
      select: { id: true, name: true },
    });
    if (!doc) throw badRequest("That document is not one of this company's.");

    const row = await db.offeringDocument.create({
      data: {
        offeringId: o.id, documentId: doc.id,
        role: b.role ? String(b.role).toUpperCase() : undefined,
        required: b.required === true,
      },
    }).catch((e) => {
      if (String(e && e.code) === "P2002") {
        throw conflict(`"${doc.name}" is already attached to this offering.`);
      }
      throw e;
    });
    await audit(req, "investment.document.attach", "offeringDocument", row.id,
      { documentId: doc.id, role: row.role });
    res.status(201).json({ document: row });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 5. ORDERS. An investor subscribing to a live offering.
 *
 * COMPLIANCE GATES THIS, NOT THE FORM. eligibilityRefusal() reads the
 * investor's KYC, screening, jurisdiction and classification, and an order
 * that fails any of them is recorded as COMPLIANCE_HOLD with the reason —
 * never silently dropped, because a refused investor is entitled to know.
 * ====================================================================== */

guarded.post("/investments/offerings/:id/orders", async (req, res, next) => {
  try {
    need(req, "create", "investment orders");
    await issuer(req);
    const o = await ownOffering(req, req.params.id);
    const b = req.body || {};

    const investor = await db.investor.findFirst({
      where: { id: String(b.investorId || ""), orgId: req.actor.orgId },
      include: { investorProfile: true },
    });
    if (!investor) throw badRequest("That investor is not on this company's register.");

    const units = Number(b.units) || 0;
    if (units <= 0) throw badRequest("An order needs a number of units above zero.");
    if (units < o.minUnits) {
      throw badRequest(`The minimum for this offering is ${o.minUnits} units.`);
    }

    /* Amount is computed. A submitted amount would be a way to buy units at a
       price the offering never advertised. */
    const amount = o.unitPrice * BigInt(units);
    if (o.minInvestment > 0n && amount < o.minInvestment) {
      throw badRequest(
        `The minimum investment for this offering is ${o.minInvestment} ` +
        `${o.currency} in minor units, and ${units} units comes to ${amount}.`);
    }

    /* Not more than is left. */
    const taken = await db.investmentOrder.aggregate({
      where: { offeringId: o.id, status: { in: ["APPROVED", "AWAITING_PAYMENT", "SETTLED", "ALLOCATED"] } },
      _sum: { units: true },
    });
    const left = o.tokenUnits - Number(taken._sum.units || 0);
    if (o.tokenUnits > 0 && units > left) {
      throw conflict(`Only ${left} of ${o.tokenUnits} units are still available.`);
    }

    const refusal = eligibilityRefusal(o, investor.investorProfile);
    const ref = await nextRef(o.sandbox ? "SBXORD" : "ORD", req.actor.orgId);

    const row = await db.investmentOrder.create({
      data: {
        orgId: req.actor.orgId, offeringId: o.id, investorId: investor.id,
        ref, units, amount, currency: o.currency,
        /*
         * A failed compliance check is a HOLD with a reason, not a rejection
         * and not a success. Somebody has to look at it.
         */
        status: refusal ? "COMPLIANCE_HOLD" : "APPROVED",
        refusedWhy: refusal || "",
        sandbox: o.sandbox,
      },
      include: { investor: { select: { id: true, name: true } } },
    });
    await audit(req, "investment.order.place", "investmentOrder", row.id,
      { ref, units, held: Boolean(refusal) });

    res.status(201).json({
      order: row,
      /* Said plainly, both ways. */
      held: Boolean(refusal),
      why: refusal || "",
      /*
       * NO PAYMENT HAS BEEN TAKEN.
       *
       * No provider is integrated. An order is a commitment; it becomes SETTLED
       * when an Invoice raised for it is paid in full, through the money path
       * this platform already has.
       */
      settled: false,
    });
  } catch (e) { next(e); }
});

/** Cancel an order, with a reason. Never deleted. */
guarded.post("/investments/orders/:id/cancel", async (req, res, next) => {
  try {
    need(req, "update", "investment orders");
    const reason = String((req.body && req.body.reason) || "").trim();
    if (!reason) throw badRequest("Say why this order is being cancelled.");

    const order = await db.investmentOrder.findFirst({
      where: { id: String(req.params.id), orgId: req.actor.orgId },
    });
    if (!order) throw hidden();
    if (["SETTLED", "ALLOCATED", "CANCELLED", "REFUNDED"].includes(order.status)) {
      throw conflict(
        `This order is ${order.status.toLowerCase()} and cannot be cancelled here. ` +
        `Money that has been received is returned as a refund, which is a ` +
        `finance action with its own record.`);
    }
    const row = await db.investmentOrder.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), refusedWhy: reason },
    });
    await audit(req, "investment.order.cancel", "investmentOrder", order.id, { reason });
    res.json({ order: row });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 6. TOKENISATION.
 *
 * Namespaced separately, as asked. Every write goes through the adapter, and
 * with no provider connected the adapter throws 503 — it does not return a
 * plausible reference. See the long note in src/domain/tokenisation.js.
 * ====================================================================== */

guarded.get("/tokenization/status", async (req, res, next) => {
  try {
    need(req, "list", "tokenisation");
    res.json(tokens.status());
  } catch (e) { next(e); }
});

guarded.post("/tokenization/offerings/:id/issue", async (req, res, next) => {
  try {
    need(req, "update", "tokenisation");
    if (!canOffering(req.actor, "tokenise")) {
      throw forbidden("Your role cannot issue units.");
    }
    await issuer(req);
    const o = await ownOffering(req, req.params.id);

    /*
     * Units are issued against a SETTLED order and nothing else. Issuing
     * against a commitment nobody has paid is how a register comes to show
     * ownership that was never bought.
     */
    const order = await db.investmentOrder.findFirst({
      where: { id: String((req.body && req.body.orderId) || ""), orgId: req.actor.orgId, offeringId: o.id },
      include: { investor: { select: { id: true, name: true } } },
    });
    if (!order) throw badRequest("Name a settled order on this offering.");
    if (order.status !== "SETTLED") {
      throw conflict(
        `That order is ${order.status.toLowerCase()}. Units are issued against a ` +
        `settled order — one whose invoice has been paid in full.`);
    }

    const p = tokens.provider();
    /* A sandbox provider may only touch a sandbox offering, and the reverse. */
    const st = tokens.status();
    if (st.connected && st.sandbox !== o.sandbox) {
      throw conflict(
        st.sandbox
          ? "A sandbox tokenisation provider cannot issue units on a production offering."
          : "A production provider cannot issue units on a sandbox offering.");
    }

    /*
     * Nothing is connected -> this throws, and nothing below runs. No holding
     * row, no token event, no change to the order. That is the correct outcome.
     *
     * Translated into an ApiError because the error handler only honours those;
     * a bare throw became a 500, which would have said this service failed when
     * in fact it declined, correctly, to invent a token.
     */
    let result;
    try {
      result = await p.mint({
        offeringRef: o.ref, investorRef: order.investorId, units: order.units,
      });
    } catch (e) {
      if (e && e.name === "TokenisationUnavailable") throw unavailable(e.message);
      throw e;
    }

    const at = new Date();
    const holding = await db.tokenHolding.create({
      data: {
        orgId: req.actor.orgId, offeringId: o.id, investorId: order.investorId,
        orderId: order.id, units: result.units,
        provider: p.name || "", providerRef: result.providerRef,
        custodian: result.custodian || "", custodianRef: result.custodianRef || "",
        chain: result.chain || "", contractRef: result.contractRef || "",
        walletRef: result.walletRef || "",
        /* When the PROVIDER says it happened, if it says. Otherwise now, and
           the difference is recorded rather than assumed away. */
        asAt: result.asAt ? new Date(result.asAt) : at,
        sandbox: o.sandbox,
      },
    });

    await db.tokenEvent.create({
      data: {
        orgId: req.actor.orgId, offeringId: o.id, kind: "MINT",
        units: result.units, provider: p.name || "",
        externalRef: result.providerRef, txRef: result.txRef || "",
        detail: { orderRef: order.ref }, at, sandbox: o.sandbox,
      },
    });

    await db.investmentOrder.update({
      where: { id: order.id },
      data: { status: "ALLOCATED", allocatedAt: at },
    });

    await audit(req, "tokenisation.issue", "tokenHolding", holding.id,
      { provider: p.name, units: result.units, orderRef: order.ref });
    res.status(201).json({ holding, event: { kind: "MINT", units: result.units } });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 7. MY INVESTMENTS — the investor's own view.
 *
 * PERSON-SCOPED, like the guest portal, and for the same reason: this is not
 * "a company's investors", it is "my holdings". Resolved from
 * Investor.userId and never from a parameter.
 *
 * No `need()` call: an investor is not staff and holds no area at all. What
 * bounds this is the session's own userId.
 * ====================================================================== */
guarded.get("/investments/mine", async (req, res, next) => {
  try {
    const mine = await db.investor.findMany({
      where: { userId: req.session.userId },
      select: { id: true, orgId: true, name: true, currency: true },
    });
    if (!mine.length) {
      return res.json({ investments: [], linked: false });
    }
    const ids = mine.map((m) => m.id);

    const orders = await db.investmentOrder.findMany({
      where: { investorId: { in: ids }, sandbox: false },
      orderBy: [{ placedAt: "desc" }],
      take: 200,
      include: {
        offering: {
          select: {
            id: true, ref: true, title: true, status: true, currency: true,
            structure: true, targetYieldBps: true,
          },
        },
      },
    });

    const holdings = await db.tokenHolding.findMany({
      where: { investorId: { in: ids }, sandbox: false },
      include: { offering: { select: { id: true, ref: true, title: true } } },
    });

    const distributions = await db.distribution.findMany({
      where: { investorId: { in: ids } },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      include: { offering: { select: { id: true, ref: true, title: true } } },
    });

    res.json({
      linked: true,
      investments: orders.map((o) => ({
        id: o.id, ref: o.ref, units: o.units, amount: o.amount,
        currency: o.currency, status: o.status, placedAt: o.placedAt,
        settledAt: o.settledAt, offering: o.offering,
        /* Why a hold is on it — the investor's own order, so their own reason. */
        why: o.refusedWhy || "",
      })),
      /*
       * UNITS AS THE PROVIDER REPORTS THEM.
       *
       * Not a sum of orders. If no provider is connected this is empty, and
       * empty is the truth: nothing has been issued.
       */
      holdings: holdings.map((h) => ({
        id: h.id, units: h.units, offering: h.offering,
        provider: h.provider, providerRef: h.providerRef,
        custodian: h.custodian, chain: h.chain, asAt: h.asAt,
      })),
      distributions: distributions.map((d) => ({
        id: d.id, period: d.period, amount: d.amount, currency: d.currency,
        status: d.status, paidOn: d.paidOn, offering: d.offering,
      })),
      /*
       * NO PORTFOLIO VALUATION.
       *
       * "What is my investment worth now" needs a current valuation of the
       * underlying property, and nothing in this platform holds one. A figure
       * here would be the number an investor makes a decision on.
       */
      valuation: null,
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * 8. OVERVIEW — what the Investments dashboard opens on.
 * ====================================================================== */
guarded.get("/investments/summary", async (req, res, next) => {
  try {
    need(req, "list", "investments");
    const orgId = req.actor.orgId;
    const live = { orgId, sandbox: false };

    const [offerings, byStatus, investors, pending, held, raised, holdings, distributed] =
      await Promise.all([
        db.offering.count({ where: live }),
        db.offering.groupBy({ by: ["status"], where: live, _count: { _all: true } }),
        db.investor.count({ where: { orgId } }),
        db.investmentOrder.count({ where: { ...live, status: "PENDING" } }),
        db.investmentOrder.count({ where: { ...live, status: "COMPLIANCE_HOLD" } }),
        db.investmentOrder.aggregate({
          where: { ...live, status: { in: ["SETTLED", "ALLOCATED"] } },
          _sum: { amount: true },
        }),
        db.tokenHolding.aggregate({ where: live, _sum: { units: true } }),
        db.distribution.aggregate({ where: { orgId, status: "PAID" }, _sum: { amount: true } }),
      ]);

    res.json({
      counts: {
        offerings,
        investors,
        ordersPending: pending,
        ordersOnComplianceHold: held,
        /* Units the PROVIDER has reported. Zero when none is connected. */
        unitsIssued: Number(holdings._sum.units || 0),
      },
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      money: {
        raised: raised._sum.amount || 0n,
        distributed: distributed._sum.amount || 0n,
      },
      tokenisation: tokens.status(),
    });
  } catch (e) { next(e); }
});
