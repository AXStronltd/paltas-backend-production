/**
 * ====================================================================== *
 * PROPERTY DNA — the API.
 *
 * Mounted under /properties/:siteId/... because the property IS the Site and
 * there is no second identifier to learn. Nothing here creates a property;
 * sites are created by the resource framework as they always were.
 *
 * ── THE SHAPE OF EVERY HANDLER ──────────────────────────────────────────
 *
 *   1. requireSession / organization / subscription   (the router's guards)
 *   2. load the property, scoped to req.actor.orgId   — tenant isolation
 *   3. load THIS person's relationships to it         — standing, not role
 *   4. compute a clearance                            — role ∪ relationship
 *   5. refuse, or redact                              — server side, always
 *   6. audit anything confidential that was read
 *
 * Step 5 happens before the response object exists. A field the caller may
 * not read is never put into it, so there is nothing in the network tab to
 * find. Hiding it in the browser would not be access control.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { requireSession, requireOrganization, requireOpenSubscription } from "../http/session.js";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { clean } from "../domain/input.ts";
import { whyNotArea } from "../domain/access.ts";
import {
  clearanceFor, mayRead, visibleRows, redact, withheldSummary,
  whyNotClass, publicProfile, reachesProperty, SECURITY_CLASS, ALL_CLASSES,
} from "../domain/classification.js";
import {
  dnaFor, remember, derivedEvents, advanceCase, successionRef, aiContext,
  SUCCESSION_NEXT,
} from "../domain/dna.js";
import { context, gate, audit } from "../modules/property-dna/domain/context.js";

export const dnaRoutes = Router();
dnaRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

/*
 * PLUMBING MOVED to modules/property-dna/domain/context.js.
 *
 * context(), gate() and audit() are shared with the authority module, and two
 * copies of "how a property is opened" is exactly how one of them ends up
 * missing a check.
 */

/* ---------------------------------------------------------------- *
 * 1. THE RECORD
 * ---------------------------------------------------------------- */

/**
 * GET /properties/:siteId/dna
 *
 * The identity and a count of what the caller cannot see. The counts are
 * deliberate: "4 ownership records withheld" is honest about the record being
 * partial without disclosing a holder, a share or a price.
 */
dnaRoutes.get("/properties/:siteId/dna", async (req, res, next) => {
  try {
    const { orgId, dna, site, clearance } = await context(req);

    const [ownership, heritage, cases, scans] = await Promise.all([
      db.propertyOwnershipRecord.findMany({ where: { orgId, dnaId: dna.id }, select: { class: true } }),
      db.propertyHeritageRecord.findMany({ where: { orgId, dnaId: dna.id }, select: { class: true } }),
      db.successionCase.findMany({ where: { orgId, dnaId: dna.id }, select: { class: true, status: true } }),
      db.propertyScan.findMany({ where: { orgId, dnaId: dna.id }, select: { class: true } }),
    ]);

    res.json({
      dna: {
        ref: dna.ref,
        verification: dna.verification,
        verifiedAt: dna.verifiedAt,
        publicProfile: dna.publicProfile,
        property: {
          id: site.id, name: site.name, kind: site.kind,
          city: site.city, country: site.country,
          address: mayRead(clearance, "INTERNAL") ? site.address : undefined,
        },
      },
      /* What this person may open, so the console shows the tabs they can use
         rather than tabs that 403. The browser is not TRUSTED with this — every
         endpoint checks again — it is told it so the UI is honest. */
      access: {
        clearance: clearance.label,
        via: clearance.via,
        security: clearance.security,
        may: Object.fromEntries(ALL_CLASSES.map((c) => [c, mayRead(clearance, c)])),
      },
      counts: {
        ownership: visibleRows(ownership, clearance).length,
        heritage: visibleRows(heritage, clearance).length,
        succession: visibleRows(cases, clearance).length,
        scans: visibleRows(scans, clearance).length,
      },
      withheld: {
        ownership: withheldSummary(ownership, clearance),
        heritage: withheldSummary(heritage, clearance),
        succession: withheldSummary(cases, clearance),
      },
    });
  } catch (e) { next(e); }
});

/**
 * GET /properties/:siteId/permissions
 *
 * What the caller may see, and why. Shown to a person about THEMSELVES —
 * it discloses nothing about the property.
 */
dnaRoutes.get("/properties/:siteId/permissions", async (req, res, next) => {
  try {
    const { clearance, relations } = await context(req);
    res.json({
      clearance: clearance.label,
      via: clearance.via,
      security: clearance.security,
      relations: relations.map((r) => ({ relation: r.relation, since: r.startedOn })),
      may: Object.fromEntries(ALL_CLASSES.map((c) => [c, mayRead(clearance, c)])),
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 2. THE MEMORY
 * ---------------------------------------------------------------- */

dnaRoutes.get("/properties/:siteId/timeline", async (req, res, next) => {
  try {
    const { orgId, dna, site, clearance } = await context(req);
    const take = Math.min(Number(req.query.limit) || 60, 200);

    const [own, derived] = await Promise.all([
      db.propertyTimelineEvent.findMany({
        where: { orgId, dnaId: dna.id }, orderBy: { at: "desc" }, take: 400,
      }),
      derivedEvents(orgId, site.id),
    ]);

    const merged = visibleRows([...own, ...derived], clearance)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, take)
      .map((e) => ({
        id: e.id, kind: e.kind, at: e.at, title: e.title, detail: e.detail,
        entity: e.entity, entityId: e.entityId,
        actor: e.actorName || "", source: e.source, verification: e.verification,
        derived: !!e.derived,
      }));

    res.json({
      events: merged,
      withheld: withheldSummary([...own, ...derived], clearance),
    });
  } catch (e) { next(e); }
});

/**
 * POST /properties/:siteId/timeline — append, never overwrite.
 *
 * There is no PATCH and no DELETE for an event anywhere in this file. A
 * correction is a new event that says what changed.
 */
dnaRoutes.post("/properties/:siteId/timeline", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    const why = whyNotArea(req.actor, "property", "create", "this property's record");
    if (why) throw forbidden(why);

    const body = clean({ fields: {
      kind: "string", title: "string", detail: "text", at: "date",
      entity: "string", entityId: "string", class: "string",
    } }, req.body, { partial: true });
    if (!body.title) throw badRequest("An event needs a title.");

    const cls = body.class || "INTERNAL";
    if (!ALL_CLASSES.includes(cls)) throw badRequest(`“${cls}” is not a classification.`);
    /* Nobody may file a record they could not then read: it would vanish from
       their own view the moment it was written. */
    gate(clearance, cls, "an event at that classification");

    const made = await remember(orgId, dna.id, {
      kind: body.kind || "NOTE",
      title: body.title,
      detail: body.detail || "",
      at: body.at || undefined,
      entity: body.entity || "",
      entityId: body.entityId || "",
      actorId: req.session.userId,
      actorName: req.view?.user?.name || "",
      class: cls,
    });
    await audit(req, "dna.timeline.append", "propertyDna", dna.id, { kind: made.kind, class: cls });
    res.status(201).json({ event: { id: made.id, kind: made.kind, at: made.at, title: made.title } });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 3. OWNERSHIP — OWNER_ONLY by default
 * ---------------------------------------------------------------- */

const OWNERSHIP_SPEC = {
  id: { from: "id", class: "CONFIDENTIAL" },
  holder: { from: "holder", class: "OWNER_ONLY" },
  holderKind: { from: "holderKind", class: "OWNER_ONLY" },
  shareBp: { from: "shareBp", class: "OWNER_ONLY" },
  fromOn: { from: "fromOn", class: "OWNER_ONLY" },
  toOn: { from: "toOn", class: "OWNER_ONLY" },
  active: { from: "active", class: "CONFIDENTIAL" },
  basis: { from: "basis", class: "LEGAL_RESTRICTED" },
  note: { from: "note", class: "LEGAL_RESTRICTED" },
  source: { from: "source", class: "CONFIDENTIAL" },
  verification: { from: "verification", class: "CONFIDENTIAL" },
};

dnaRoutes.get("/properties/:siteId/ownership", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    const rows = await db.propertyOwnershipRecord.findMany({
      where: { orgId, dnaId: dna.id }, orderBy: { fromOn: "desc" },
    });
    const allowed = visibleRows(rows, clearance);

    /* Reading an ownership record is itself a thing worth being able to prove
       later, so it is audited — the read, not only the write. */
    if (allowed.length) {
      await audit(req, "dna.ownership.read", "propertyDna", dna.id, { rows: allowed.length });
    }
    res.json({
      records: allowed.map((r) => redact(r, OWNERSHIP_SPEC, clearance)),
      withheld: withheldSummary(rows, clearance),
    });
  } catch (e) { next(e); }
});

dnaRoutes.post("/properties/:siteId/ownership", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "OWNER_ONLY", "recording an ownership record");

    const body = clean({ fields: {
      holder: "string", holderKind: "string", shareBp: "int",
      fromOn: "date", toOn: "date", basis: "string", note: "text",
    } }, req.body, { partial: true });
    if (!body.holder) throw badRequest("An ownership record needs a holder.");
    if (body.shareBp != null && (body.shareBp < 0 || body.shareBp > 10000)) {
      throw badRequest("A share is in basis points, 0 to 10000.");
    }

    const made = await db.propertyOwnershipRecord.create({
      data: { orgId, dnaId: dna.id, ...body, source: "OWNER_SUPPLIED", class: "OWNER_ONLY" },
    });
    await remember(orgId, dna.id, {
      kind: "OWNERSHIP_RECORDED",
      title: "An ownership record was filed",
      /* The timeline entry says that something was recorded, not what: the
         timeline is read at RESTRICTED by managers. */
      detail: "",
      entity: "ownership", entityId: made.id,
      actorId: req.session.userId, actorName: req.view?.user?.name || "",
      class: "CONFIDENTIAL",
    });
    await audit(req, "dna.ownership.create", "propertyDna", dna.id, { id: made.id });
    res.status(201).json({ record: redact(made, OWNERSHIP_SPEC, clearance) });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 4. HERITAGE — the family's own account
 * ---------------------------------------------------------------- */

dnaRoutes.get("/properties/:siteId/heritage", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    const rows = await db.propertyHeritageRecord.findMany({
      where: { orgId, dnaId: dna.id }, orderBy: [{ year: "asc" }, { on: "asc" }],
    });
    const allowed = visibleRows(rows, clearance);
    res.json({
      records: allowed.map((r) => ({
        id: r.id, year: r.year, on: r.on, title: r.title, story: r.story,
        family: r.family, publicOk: r.publicOk, source: r.source,
      })),
      withheld: withheldSummary(rows, clearance),
    });
  } catch (e) { next(e); }
});

dnaRoutes.post("/properties/:siteId/heritage", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "OWNER_ONLY", "the family's record of this property");

    const body = clean({ fields: {
      year: "int", on: "date", title: "string", story: "text",
      family: "string", publicOk: "bool",
    } }, req.body, { partial: true });
    if (!body.title) throw badRequest("A heritage entry needs a title.");

    const made = await db.propertyHeritageRecord.create({
      data: { orgId, dnaId: dna.id, ...body, class: "OWNER_ONLY", source: "OWNER_SUPPLIED" },
    });
    await audit(req, "dna.heritage.create", "propertyDna", dna.id, { id: made.id });
    res.status(201).json({ record: { id: made.id, title: made.title, year: made.year } });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 5. SUCCESSION — LEGAL_RESTRICTED throughout
 * ---------------------------------------------------------------- */

dnaRoutes.get("/properties/:siteId/succession", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "LEGAL_RESTRICTED", "succession on this property");

    const cases = await db.successionCase.findMany({
      where: { orgId, dnaId: dna.id },
      orderBy: { openedAt: "desc" },
      include: {
        beneficiaries: { orderBy: { createdAt: "asc" } },
        steps: { orderBy: { at: "asc" } },
      },
    });
    await audit(req, "dna.succession.read", "propertyDna", dna.id, { cases: cases.length });

    res.json({
      cases: cases.map((c) => ({
        id: c.id, ref: c.ref, status: c.status, jurisdiction: c.jurisdiction,
        representative: c.representative, reason: c.reason, note: c.note,
        openedBy: c.openedName, openedAt: c.openedAt,
        decidedAt: c.decidedAt, closedAt: c.closedAt,
        next: SUCCESSION_NEXT[c.status] || [],
        beneficiaries: c.beneficiaries.map((b) => ({
          id: b.id, name: b.name, relation: b.relation, shareBp: b.shareBp,
          contact: b.contact, verification: b.verification, note: b.note,
        })),
        steps: c.steps.map((s) => ({ from: s.from, to: s.to, why: s.why, actor: s.actorName, at: s.at })),
      })),
      /*
       * SAID IN THE RESPONSE, NOT ONLY IN THE UI.
       *
       * Anything that reads this endpoint — the console, a report, an
       * integration — is told the same thing: this is a record of documents,
       * not a determination of who inherits.
       */
      notice:
        "PALTAS records the documents and the decisions taken by the people " +
        "authorised to take them. It does not determine ownership or " +
        "inheritance, and completing a case here does not by itself transfer " +
        "anything to anybody.",
    });
  } catch (e) { next(e); }
});

dnaRoutes.post("/properties/:siteId/succession", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "LEGAL_RESTRICTED", "opening a succession case");

    const open = await db.successionCase.findFirst({
      where: { orgId, dnaId: dna.id, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } },
    });
    if (open) {
      throw conflict(
        `This property already has an open succession case (${open.ref}, ${open.status}). ` +
        `Close or cancel it before opening another.`
      );
    }

    const body = clean({ fields: {
      jurisdiction: "string", representative: "string", reason: "text", note: "text",
    } }, req.body, { partial: true });

    const n = await db.successionCase.count({ where: { orgId } });
    const made = await db.successionCase.create({
      data: {
        orgId, dnaId: dna.id, ref: successionRef(n + 1),
        status: "DRAFT",
        jurisdiction: body.jurisdiction || "",
        representative: body.representative || "",
        reason: body.reason || "",
        note: body.note || "",
        openedById: req.session.userId,
        openedName: req.view?.user?.name || "",
        class: "LEGAL_RESTRICTED",
      },
    });
    await db.successionStep.create({
      data: {
        orgId, caseId: made.id, from: null, to: "DRAFT",
        why: "Case opened.",
        actorId: req.session.userId, actorName: req.view?.user?.name || "",
      },
    });
    await remember(orgId, dna.id, {
      kind: "SUCCESSION_INITIATED",
      title: "A succession case was opened",
      detail: "",
      entity: "succession", entityId: made.id,
      actorId: req.session.userId, actorName: req.view?.user?.name || "",
      class: "CONFIDENTIAL",
    });
    await audit(req, "dna.succession.open", "successionCase", made.id, { ref: made.ref });
    res.status(201).json({ case: { id: made.id, ref: made.ref, status: made.status } });
  } catch (e) { next(e); }
});

dnaRoutes.post("/properties/:siteId/succession/:caseId/beneficiaries", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "LEGAL_RESTRICTED", "recording a beneficiary");

    const found = await db.successionCase.findFirst({
      where: { id: req.params.caseId, orgId, dnaId: dna.id },
    });
    if (!found) throw hidden();
    if (found.status === "COMPLETED" || found.status === "CANCELLED") {
      throw conflict(`Case ${found.ref} is ${found.status.toLowerCase()} and cannot be changed.`);
    }

    const body = clean({ fields: {
      name: "string", relation: "string", shareBp: "int", contact: "string", note: "text",
    } }, req.body, { partial: true });
    if (!body.name) throw badRequest("A beneficiary needs a name.");
    if (body.shareBp != null && (body.shareBp < 0 || body.shareBp > 10000)) {
      throw badRequest("A share is in basis points, 0 to 10000.");
    }

    const made = await db.successionBeneficiary.create({
      data: {
        orgId, caseId: found.id, name: body.name,
        relation: body.relation || "BENEFICIARY",
        shareBp: body.shareBp ?? null,
        contact: body.contact || "", note: body.note || "",
      },
    });
    await audit(req, "dna.succession.beneficiary.add", "successionCase", found.id, { id: made.id });

    /*
     * Shares are RECORDED, not adjudicated, and they are not required to add
     * up. Saying so beside the total is the honest version of a validation
     * error: a case can legitimately sit at 90% while a document is awaited,
     * and refusing to save that would push people to enter something wrong.
     */
    const all = await db.successionBeneficiary.findMany({
      where: { orgId, caseId: found.id }, select: { shareBp: true },
    });
    const total = all.reduce((n, b) => n + (b.shareBp || 0), 0);

    res.status(201).json({
      beneficiary: { id: made.id, name: made.name, relation: made.relation, shareBp: made.shareBp },
      shares: {
        totalBp: total,
        balanced: total === 10000,
        note: total === 10000 ? "" :
          "Recorded shares do not total 100%. PALTAS records what the " +
          "documentation says and does not adjudicate it.",
      },
    });
  } catch (e) { next(e); }
});

/**
 * POST .../succession/:caseId/advance
 *
 * The only way a case moves. Every move is checked against the machine,
 * recorded as a step with its reason and actor, and audited.
 *
 * Reaching COMPLETED records that a documented process concluded. It does not
 * transfer the property — see the notice returned with it.
 */
dnaRoutes.post("/properties/:siteId/succession/:caseId/advance", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "LEGAL_RESTRICTED", "moving a succession case");

    const body = clean({ fields: { to: "string", why: "text" } }, req.body, { partial: true });
    if (!body.to) throw badRequest("Say which status the case is moving to.");

    const found = await db.successionCase.findFirst({
      where: { id: req.params.caseId, orgId, dnaId: dna.id },
    });
    if (!found) throw hidden();

    /* Approving or completing is not something the person who opened the case
       should be able to do alone. Two people, or it does not move. */
    if ((body.to === "APPROVED" || body.to === "COMPLETED") &&
        found.openedById && found.openedById === req.session.userId) {
      throw forbidden(
        "The person who opened a succession case cannot also approve it. " +
        "Another authorised person has to make this decision."
      );
    }

    const moved = await advanceCase(
      orgId, found.id, body.to,
      { userId: req.session.userId, name: req.view?.user?.name || "" },
      body.why || ""
    );
    if (moved.error === "notFound") throw hidden();
    if (moved.error === "transition") throw conflict(moved.why);

    if (body.to === "COMPLETED") {
      await remember(orgId, dna.id, {
        kind: "SUCCESSION_COMPLETED",
        title: "A succession case concluded",
        detail: "",
        entity: "succession", entityId: found.id,
        actorId: req.session.userId, actorName: req.view?.user?.name || "",
        class: "CONFIDENTIAL",
      });
    }
    await audit(req, "dna.succession.advance", "successionCase", found.id, {
      from: moved.from, to: body.to,
    });

    res.json({
      case: { id: moved.case.id, ref: moved.case.ref, status: moved.case.status },
      notice: body.to === "COMPLETED"
        ? "Recorded. This does not transfer the property. Changing who holds " +
          "it is a separate, deliberate act, and the previous holder stays in " +
          "the record."
        : undefined,
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 6. SCAN — evidence, and suggestions that must be confirmed
 * ---------------------------------------------------------------- */

dnaRoutes.get("/properties/:siteId/scan", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    const rows = await db.propertyScan.findMany({
      where: { orgId, dnaId: dna.id },
      orderBy: { createdAt: "desc" }, take: 50,
      include: { findings: { orderBy: { createdAt: "asc" } } },
    });
    const allowed = visibleRows(rows, clearance);
    res.json({
      scans: allowed.map((s) => ({
        id: s.id, kind: s.kind, note: s.note, state: s.state,
        uploadedBy: s.uploadedName, createdAt: s.createdAt,
        findings: s.findings.map((f) => ({
          id: f.id, kind: f.kind, label: f.label, detail: f.detail,
          confidence: f.confidence, source: f.source,
          verified: f.verified, rejected: f.rejected,
          /* Said on every finding, because this is the line somebody will
             otherwise forget when they read a list of them. */
          status: f.rejected ? "rejected" : f.verified ? "confirmed" : "needs confirmation",
        })),
      })),
      withheld: withheldSummary(rows, clearance),
    });
  } catch (e) { next(e); }
});

/**
 * POST /properties/:siteId/scan
 *
 * Records that evidence was captured. It does NOT produce findings: there is
 * no extraction provider configured, and inventing rooms and appliances a
 * model never saw would be exactly the fabrication this codebase refuses
 * everywhere else. The scan sits at PENDING until a provider is connected.
 */
dnaRoutes.post("/properties/:siteId/scan", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    const why = whyNotArea(req.actor, "property", "create", "a property scan");
    if (why) throw forbidden(why);
    gate(clearance, "RESTRICTED", "adding a scan");

    const body = clean({ fields: { kind: "string", storageKey: "string", note: "text" } }, req.body, { partial: true });

    const made = await db.propertyScan.create({
      data: {
        orgId, dnaId: dna.id,
        kind: body.kind || "PHOTO",
        storageKey: body.storageKey || "",
        note: body.note || "",
        uploadedById: req.session.userId,
        uploadedName: req.view?.user?.name || "",
        state: "PENDING",
        class: "RESTRICTED",
      },
    });
    await remember(orgId, dna.id, {
      kind: "SCAN_RECORDED", title: "A scan was added",
      entity: "scan", entityId: made.id,
      actorId: req.session.userId, actorName: req.view?.user?.name || "",
      source: "MANAGER_SUPPLIED", class: "INTERNAL",
    });
    await audit(req, "dna.scan.create", "propertyDna", dna.id, { id: made.id });

    res.status(201).json({
      scan: { id: made.id, kind: made.kind, state: made.state },
      extraction: {
        available: false,
        why: "No extraction provider is connected to this deployment. The " +
             "scan is stored and can be read back; nothing has been inferred " +
             "from it, and no findings have been invented.",
      },
    });
  } catch (e) { next(e); }
});

/**
 * Confirm or reject a suggestion.
 *
 * A finding is a SUGGESTION until a person says otherwise. Nothing in the
 * property's structure is written from one that has not been confirmed.
 */
dnaRoutes.post("/properties/:siteId/scan/:scanId/findings/:findingId", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "RESTRICTED", "confirming a scan finding");

    const body = clean({ fields: { decision: "string", label: "string" } }, req.body, { partial: true });
    const decision = String(body.decision || "").toLowerCase();
    if (decision !== "confirm" && decision !== "reject") {
      throw badRequest('decision must be "confirm" or "reject".');
    }

    const scan = await db.propertyScan.findFirst({
      where: { id: req.params.scanId, orgId, dnaId: dna.id },
    });
    if (!scan) throw hidden();
    const finding = await db.propertyScanFinding.findFirst({
      where: { id: req.params.findingId, orgId, scanId: scan.id },
    });
    if (!finding) throw hidden();

    await db.propertyScanFinding.updateMany({
      where: { id: finding.id, orgId },
      data: {
        verified: decision === "confirm",
        rejected: decision === "reject",
        label: body.label || finding.label,
        verifiedBy: req.view?.user?.name || "",
        verifiedAt: new Date(),
        /* Confirmed by a person is no longer an AI reading. */
        source: decision === "confirm" ? "VERIFIED" : finding.source,
      },
    });
    await audit(req, "dna.scan.finding." + decision, "propertyScan", scan.id, { id: finding.id });
    res.json({
      finding: {
        id: finding.id,
        label: body.label || finding.label,
        verified: decision === "confirm",
        rejected: decision === "reject",
      },
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 7. VERIFICATION
 * ---------------------------------------------------------------- */

dnaRoutes.post("/properties/:siteId/verification", async (req, res, next) => {
  try {
    const { orgId, dna, clearance } = await context(req);
    gate(clearance, "CONFIDENTIAL", "the property's verification state");
    const why = whyNotArea(req.actor, "property", "update", "this property");
    if (why) throw forbidden(why);

    const body = clean({ fields: { state: "string", note: "text" } }, req.body, { partial: true });
    const STATES = ["UNVERIFIED", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED"];
    if (!STATES.includes(body.state)) {
      throw badRequest(`state must be one of ${STATES.join(", ")}.`);
    }
    /*
     * VERIFIED is not a thing a company grants itself.
     *
     * It means PALTAS checked. A customer marking their own property verified
     * would make the badge worthless to everybody who relies on it, so the
     * furthest a customer can go is SUBMITTED.
     */
    if (body.state === "VERIFIED" || body.state === "UNDER_REVIEW") {
      throw forbidden(
        "A property is marked verified by PALTAS, not by its own company. " +
        "Submit it for verification and it will be reviewed."
      );
    }

    /*
     * updateMany, so the organization is IN THE QUERY.
     *
     * `dna` was already loaded scoped to this company, so an update by id
     * alone would be safe today — and a reader of this line could not tell
     * that, and neither can the tenancy test. Every query carries its org.
     */
    await db.propertyDna.updateMany({
      where: { id: dna.id, orgId },
      data: { verification: body.state, verifiedNote: body.note || "" },
    });
    await audit(req, "dna.verification.set", "propertyDna", dna.id, { state: body.state });
    res.json({ verification: body.state });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 8. THE AI BOUNDARY
 * ---------------------------------------------------------------- */

/**
 * POST /properties/:siteId/ai/context
 *
 * Returns exactly the slice of this property a question may be answered from,
 * for THIS caller. It is the boundary, and it is the part that matters:
 * the clearance is applied while the context is assembled, so a model is
 * never handed something it must then be trusted not to repeat.
 *
 * No model is called. There is no provider configured, and a fabricated
 * answer about somebody's building is worse than no answer.
 */
dnaRoutes.post("/properties/:siteId/ai/context", async (req, res, next) => {
  try {
    const { orgId, dna, site, clearance } = await context(req);

    const [own, derived, assets, ownership] = await Promise.all([
      db.propertyTimelineEvent.findMany({ where: { orgId, dnaId: dna.id }, orderBy: { at: "desc" }, take: 200 }),
      derivedEvents(orgId, site.id),
      db.asset.findMany({ where: { orgId, siteId: site.id }, take: 200 }),
      db.propertyOwnershipRecord.findMany({ where: { orgId, dnaId: dna.id } }),
    ]);

    const context_ = aiContext(
      { dna, site, timeline: [...own, ...derived], assets, ownership, clearance },
      { visibleRows }
    );
    await audit(req, "dna.ai.context", "propertyDna", dna.id, { clearance: clearance.label });

    res.json({
      context: context_,
      answer: null,
      provider: {
        available: false,
        why: "No AI provider is connected to this deployment. The context " +
             "above is what a provider would be given — filtered to your " +
             "access before it is assembled, never after.",
      },
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 9. THE PUBLIC PROFILE
 * ---------------------------------------------------------------- */

/**
 * The one shape that may leave for a listing or the marketplace.
 *
 * Built by publicProfile() in domain/classification.js — one function, so a
 * field added to Property DNA cannot quietly widen what the public sees. It
 * returns null unless an owner switched the public profile on.
 */
dnaRoutes.get("/properties/:siteId/public", async (req, res, next) => {
  try {
    const { dna, site } = await context(req);
    const profile = publicProfile(dna, site);
    if (!profile) {
      return res.json({
        profile: null,
        why: "This property has no public profile. Nothing about it is " +
             "published until somebody with owner standing turns one on.",
      });
    }
    res.json({ profile });
  } catch (e) { next(e); }
});
