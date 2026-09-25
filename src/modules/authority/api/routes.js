/**
 * ====================================================================== *
 * THE AUTHORITY API.
 *
 * Two audiences, deliberately separated:
 *
 *   /authority/...            a public body, reading within its mandate
 *   /properties/:id/authority  a property's own people, reading the official
 *                              records held about their building
 *
 * The same rows, two doors, two different checks. A customer reaches them
 * because it is their property; an authority reaches them because it has a
 * mandate over the jurisdiction. Neither door grants what the other has.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../../../db.ts";
import { requireSession, requireOrganization } from "../../../http/session.ts";
import { badRequest, conflict, forbidden, hidden } from "../../../http/errors.ts";
import { clean } from "../../../domain/input.ts";
import { mayRead, visibleRows, withheldSummary, AUTHORITY_CLASS } from "../../../domain/classification.ts";
import { context, gate, audit } from "../../property-dna/domain/context.ts";
import { authorityContext, mayDataset, whyNotDataset, normalisePath, contains } from "../domain/jurisdiction.ts";

export const authorityRoutes = Router();

/*
 * requireOrganization but NOT requireOpenSubscription.
 *
 * A public authority is not a paying customer and has no subscription to
 * lapse. Putting the subscription guard here would make a land registry's
 * access depend on somebody's card, which is the wrong dependency for a
 * statutory function.
 */
authorityRoutes.use(requireSession(), requireOrganization());

/** The caller's own authority profile, or a refusal that says why. */
async function mustBeAuthority(req) {
  const profile = await db.authorityProfile.findFirst({ where: { orgId: req.actor.orgId } });
  if (!profile) {
    throw forbidden(
      "This is the authority interface. It is for public bodies that PALTAS " +
      "has verified and that hold a mandate; this account is a customer."
    );
  }
  if (!profile.verified) {
    throw forbidden(
      "This authority has not been verified by PALTAS yet. Verification comes " +
      "before any mandate takes effect."
    );
  }
  return profile;
}

/* ---------------------------------------------------------------- *
 * 1. WHAT THIS AUTHORITY MAY DO
 * ---------------------------------------------------------------- */

/**
 * GET /authority/mandate
 *
 * An authority reading its own standing. This discloses nothing about any
 * property — it is the list of what was granted, which the authority already
 * knows and a reviewer should be able to see.
 */
authorityRoutes.get("/authority/mandate", async (req, res, next) => {
  try {
    const profile = await mustBeAuthority(req);
    const now = new Date();
    const mandates = await db.authorityMandate.findMany({
      where: { profileId: profile.id },
      include: { jurisdiction: true },
      orderBy: { startsOn: "desc" },
    });
    res.json({
      authority: { kind: profile.kind, legalName: profile.legalName, country: profile.country, verified: profile.verified },
      mandates: mandates.map((m) => ({
        id: m.id,
        jurisdiction: m.jurisdiction ? { path: m.jurisdiction.path, name: m.jurisdiction.name, level: m.jurisdiction.level } : null,
        datasets: m.datasets, basis: m.basis, purpose: m.purpose,
        mayWrite: m.mayWrite, startsOn: m.startsOn, endsOn: m.endsOn,
        inForce: m.active && m.startsOn <= now && (!m.endsOn || m.endsOn >= now),
      })),
      /* Said plainly, in the response, so an integrator reading this endpoint
         learns the rule rather than discovering it by being refused. */
      notice:
        "A mandate names datasets. There is no value meaning “all”, and no " +
        "mandate reaches owner-only, legal-restricted or security-restricted " +
        "information about a property.",
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 2. SEARCH — never global
 * ---------------------------------------------------------------- */

/**
 * GET /authority/properties?q=&path=
 *
 * Scoped to the jurisdictions this authority's live mandates cover, and to
 * the datasets they name. There is no route that lists every property on
 * PALTAS, and there is no query parameter that widens the scope — the paths
 * come from the mandates, never from the request.
 */
authorityRoutes.get("/authority/properties", async (req, res, next) => {
  try {
    const profile = await mustBeAuthority(req);
    const now = new Date();
    const mandates = await db.authorityMandate.findMany({
      where: {
        profileId: profile.id, active: true, startsOn: { lte: now },
        OR: [{ endsOn: null }, { endsOn: { gte: now } }],
      },
      include: { jurisdiction: true },
    });
    const paths = [...new Set(mandates.map((m) => m.jurisdiction?.path).filter(Boolean))];
    if (!paths.length) {
      return res.json({ properties: [], scope: [], why: "This authority holds no mandate that is in force." });
    }

    /*
     * A narrowing filter only.
     *
     * `path` may make the search SMALLER — a district inside the county the
     * mandate covers — and can never make it larger: a path outside every
     * mandate matches nothing rather than widening the scope.
     */
    const asked = normalisePath(req.query.path || "");
    const scope = asked ? paths.filter((p) => contains(p, asked) || contains(asked, p)) : paths;
    if (asked && !scope.length) {
      return res.json({ properties: [], scope: [], why: `No mandate of this authority covers ${asked}.` });
    }

    const q = String(req.query.q || "").trim();
    const take = Math.min(Number(req.query.limit) || 50, 200);

    /*
     * Found through the PARCEL, which is the authority's own reference point,
     * and through the property's recorded country/city as a fallback. Both
     * are then filtered by jurisdiction containment in code, because a prefix
     * test is the one thing SQL cannot express here across two sources.
     */
    const links = await db.propertyParcel.findMany({
      where: {
        parcel: { jurisdiction: { path: { in: scope } }, active: true },
        ...(q ? { OR: [
          { parcel: { ref: { contains: q, mode: "insensitive" } } },
          { site: { name: { contains: q, mode: "insensitive" } } },
        ] } : {}),
      },
      include: { parcel: { include: { jurisdiction: true } }, site: true },
      take,
    });

    const out = links.map((l) => ({
      /* The property's own id is NOT returned. An authority addresses a
         property by its parcel and its Property DNA reference; handing out
         the customer's internal id invites it to be used as a key elsewhere. */
      parcelRef: l.parcel.ref,
      jurisdiction: l.parcel.jurisdiction?.path || "",
      name: mayDataset({ within: true, datasets: mandates.flatMap((m) => m.datasets) }, "PROPERTY_IDENTITY")
        ? l.site.name : undefined,
      city: l.site.city, country: l.site.country,
      lat: mayDataset({ within: true, datasets: mandates.flatMap((m) => m.datasets) }, "LOCATION") ? l.parcel.lat : undefined,
      lng: mayDataset({ within: true, datasets: mandates.flatMap((m) => m.datasets) }, "LOCATION") ? l.parcel.lng : undefined,
    }));

    await audit(req, "authority.search", "authorityProfile", profile.id, { scope, results: out.length, q: q || undefined });
    res.json({ properties: out, scope });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 3. THE OFFICIAL RECORD ON A PROPERTY
 * ---------------------------------------------------------------- */

/**
 * GET /properties/:siteId/authority
 *
 * Reached by both audiences. context() has already worked out which one the
 * caller is: an authority arrives with `clearance.authority` true and the
 * dataset list from its mandate; a customer arrives with a rank.
 *
 * A customer sees the official records held about THEIR OWN property — that
 * is not a leak, it is their building. What a customer does not get is the
 * ability to read another property's records, which is what the mandate is
 * for and what the org scope already prevents.
 */
authorityRoutes.get("/properties/:siteId/authority", async (req, res, next) => {
  try {
    const { orgId, dna, site, clearance, authority } = await context(req);

    const rows = await db.propertyAuthorityRecord.findMany({
      where: { orgId, dnaId: dna.id },
      orderBy: [{ issuedOn: "desc" }, { createdAt: "desc" }],
      include: { jurisdiction: true, parcel: true },
      take: 200,
    });

    /*
     * TWO FILTERS, AND BOTH APPLY.
     *
     * A record has a classification, and an authority has a dataset list. A
     * customer passes the first and has no second; an authority passes the
     * first through the authority room and then must also hold the dataset.
     * Neither check is sufficient alone.
     */
    let allowed = visibleRows(rows, clearance);
    if (clearance.authority) {
      allowed = allowed.filter((r) => mayDataset(authority, r.dataset));
    }

    if (allowed.length) {
      await audit(req, "authority.records.read", "propertyDna", dna.id, {
        rows: allowed.length, as: clearance.authority ? "authority" : "customer",
      });
    }

    res.json({
      property: { ref: dna.ref, name: site.name },
      records: allowed.map((r) => ({
        id: r.id, kind: r.kind, dataset: r.dataset, ref: r.ref,
        title: r.title, detail: r.detail,
        issuedBy: r.issuedByName, issuedOn: r.issuedOn, expiresOn: r.expiresOn,
        status: r.status,
        jurisdiction: r.jurisdiction?.path || "",
        parcelRef: r.parcel?.ref || "",
        /* The trust layer, on every row: who said so, and was it checked. */
        source: r.source, verification: r.verification,
      })),
      withheld: withheldSummary(rows, clearance),
      trust: {
        note:
          "Every record says who provided it and whether it was checked. " +
          "“A planning authority issued this” and “an owner says a planning " +
          "authority issued this” are different claims and are stored as " +
          "different values.",
      },
    });
  } catch (e) { next(e); }
});

/**
 * POST /properties/:siteId/authority
 *
 * Filing an official record. Only an authority with a WRITE mandate covering
 * this property and this dataset may do it — a customer cannot file a permit
 * against its own building and call it official.
 */
authorityRoutes.post("/properties/:siteId/authority", async (req, res, next) => {
  try {
    const { orgId, dna, authority, clearance } = await context(req);

    if (!clearance.authority) {
      throw forbidden(
        "Official records are filed by the authority that issued them. A " +
        "company cannot record a permit against its own property and have it " +
        "read as official — upload it as a document instead, where it will be " +
        "marked as owner-supplied."
      );
    }
    if (!authority.mayWrite) {
      throw forbidden("This authority's mandate is read-only.");
    }

    const body = clean({ fields: {
      kind: "string", dataset: "string", ref: "string", title: "string",
      detail: "text", issuedOn: "date", expiresOn: "date", status: "string",
    } }, req.body, { partial: true });

    if (!body.title) throw badRequest("An official record needs a title.");
    if (!body.dataset) throw badRequest("Say which dataset this record belongs to.");
    const no = whyNotDataset(authority, body.dataset, "filing this record");
    if (no) throw forbidden(no);

    const made = await db.propertyAuthorityRecord.create({
      data: {
        orgId, dnaId: dna.id,
        kind: body.kind || "OTHER",
        dataset: body.dataset,
        ref: body.ref || "", title: body.title, detail: body.detail || "",
        issuedByOrgId: req.actor.orgId,
        issuedByName: authority.profile.legalName || "",
        issuedOn: body.issuedOn || new Date(),
        expiresOn: body.expiresOn || null,
        status: body.status || "",
        source: "GOVERNMENT",
        verification: "AUTHORITY_VERIFIED",
        class: AUTHORITY_CLASS,
      },
    });

    /*
     * ON THE PROPERTY'S TIMELINE, at a classification its own people can
     * read. The property's memory should contain "a permit was issued" even
     * for a reader who may not open the permit itself.
     */
    await db.propertyTimelineEvent.create({
      data: {
        orgId, dnaId: dna.id,
        kind: body.kind === "BUILDING_PERMIT" ? "PERMIT_ISSUED"
            : body.kind === "PLANNING_APPROVAL" ? "PLANNING_APPROVED"
            : body.kind === "INSPECTION" ? "INSPECTION_PASSED"
            : body.kind === "OCCUPANCY_APPROVAL" ? "OCCUPANCY_APPROVED"
            : body.kind === "ZONING_DECISION" ? "ZONING_CHANGED"
            : "OFFICIAL_NOTICE",
        title: body.title,
        detail: body.ref ? `Reference ${body.ref}` : "",
        entity: "authority-record", entityId: made.id,
        actorName: authority.profile.legalName || "",
        source: "GOVERNMENT",
        verification: "AUTHORITY_VERIFIED",
        class: "INTERNAL",
      },
    });

    await audit(req, "authority.record.file", "propertyDna", dna.id, { id: made.id, dataset: body.dataset });
    res.status(201).json({ record: { id: made.id, ref: made.ref, title: made.title, verification: made.verification } });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- *
 * 4. ASKING FOR WHAT A MANDATE DOES NOT COVER
 * ---------------------------------------------------------------- */

/**
 * POST /authority/requests
 *
 * Asking is not receiving. This creates a record of a request and grants
 * nothing; what follows is a decision by somebody at the company that owns
 * the property, and the access that follows the decision is the access that
 * was GRANTED, which may be narrower than what was asked for.
 */
authorityRoutes.post("/authority/requests", async (req, res, next) => {
  try {
    const profile = await mustBeAuthority(req);
    const body = clean({ fields: {
      propertyRef: "string", datasets: "string", basis: "string",
      purpose: "text", reference: "string",
    } }, req.body, { partial: true });

    if (!body.purpose) throw badRequest("A request needs a stated purpose.");
    if (!body.basis) throw badRequest("A request needs a basis — consent is one of several, not the only one.");
    const datasets = String(body.datasets || "").split(",").map((d) => d.trim()).filter(Boolean);
    if (!datasets.length) throw badRequest("Name the datasets being asked for.");

    const dna = body.propertyRef
      ? await db.propertyDna.findFirst({ where: { ref: body.propertyRef } })
      : null;
    if (body.propertyRef && !dna) throw hidden();

    const made = await db.authorityRequest.create({
      data: {
        profileId: profile.id,
        orgId: dna ? dna.orgId : req.actor.orgId,
        dnaId: dna ? dna.id : null,
        datasets, basis: body.basis, purpose: body.purpose,
        reference: body.reference || "",
        status: "SUBMITTED",
      },
    });
    await audit(req, "authority.request.submit", "authorityRequest", made.id, { datasets, basis: body.basis });

    res.status(201).json({
      request: { id: made.id, status: made.status, datasets: made.datasets },
      notice:
        "Submitted. This grants no access. Somebody authorised at the company " +
        "that holds the property decides what, if anything, is shared, and the " +
        "decision is recorded with its scope.",
    });
  } catch (e) { next(e); }
});

/**
 * POST /authority/requests/:id/decide
 *
 * Decided by the COMPANY, not by the authority. The scope of the grant is
 * explicit: approving a request for four datasets while granting two is a
 * normal outcome and is recorded as PARTIALLY_APPROVED.
 */
authorityRoutes.post("/authority/requests/:id/decide", async (req, res, next) => {
  try {
    const found = await db.authorityRequest.findFirst({
      where: { id: req.params.id, orgId: req.actor.orgId },
    });
    if (!found) throw hidden();
    if (found.status !== "SUBMITTED" && found.status !== "UNDER_REVIEW") {
      throw conflict(`This request is ${found.status.toLowerCase()} and cannot be decided again.`);
    }

    const body = clean({ fields: {
      decision: "string", granted: "string", note: "text", expiresOn: "date",
    } }, req.body, { partial: true });

    const decision = String(body.decision || "").toUpperCase();
    if (!["APPROVED", "REFUSED"].includes(decision)) {
      throw badRequest('decision must be "approved" or "refused".');
    }

    const granted = decision === "APPROVED"
      ? String(body.granted || "").split(",").map((d) => d.trim()).filter(Boolean)
      : [];
    /* Granting something that was not asked for is a mistake, not a kindness. */
    const extra = granted.filter((d) => !found.datasets.includes(d));
    if (extra.length) {
      throw badRequest(`These were not asked for and cannot be granted: ${extra.join(", ")}.`);
    }

    const status = decision === "REFUSED" ? "REFUSED"
      : granted.length === found.datasets.length ? "APPROVED"
      : "PARTIALLY_APPROVED";

    const row = await db.authorityRequest.update({
      where: { id: found.id },
      data: {
        status, grantedDatasets: granted,
        decidedById: req.session.userId,
        decidedByName: req.view?.user?.name || "",
        decidedAt: new Date(),
        decisionNote: body.note || "",
        expiresOn: body.expiresOn || null,
      },
    });
    await audit(req, "authority.request.decide", "authorityRequest", found.id, {
      status, granted, asked: found.datasets,
    });

    res.json({
      request: { id: row.id, status: row.status, granted: row.grantedDatasets, expiresOn: row.expiresOn },
      notice: status === "PARTIALLY_APPROVED"
        ? "Recorded as partially approved. The authority receives the datasets " +
          "granted and not the others."
        : undefined,
    });
  } catch (e) { next(e); }
});

/** A company reading the requests made against its own properties. */
authorityRoutes.get("/authority/requests", async (req, res, next) => {
  try {
    const rows = await db.authorityRequest.findMany({
      where: { orgId: req.actor.orgId },
      orderBy: { createdAt: "desc" },
      include: { profile: true, dna: true },
      take: 100,
    });
    res.json({
      requests: rows.map((r) => ({
        id: r.id, status: r.status,
        authority: r.profile?.legalName || "", kind: r.profile?.kind || "",
        property: r.dna?.ref || "",
        datasets: r.datasets, granted: r.grantedDatasets,
        basis: r.basis, purpose: r.purpose, reference: r.reference,
        decidedBy: r.decidedByName, decidedAt: r.decidedAt, expiresOn: r.expiresOn,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) { next(e); }
});
