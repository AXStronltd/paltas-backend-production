/**
 * ====================================================================== *
 * THE ONE PLACE A PROPERTY IS OPENED.
 *
 * Every Property DNA service starts here, and none of them may load a
 * property any other way. That is the point of the module: the tenant check,
 * the standing check and the clearance are computed once, in one function, so
 * a new service cannot be written that forgets one of them.
 *
 * Returned to every caller:
 *
 *   orgId       the company, from the session — never from the request
 *   dna         the identity record, created on first open
 *   site        the property it hangs off
 *   relations   THIS person's active standing on THIS property
 *   clearance   role ∪ relationship ∪ jurisdiction
 *   authority   the public-authority profile, when the caller is one
 * ====================================================================== */

import { db } from "../../../db.js";
import { forbidden, hidden } from "../../../http/errors.ts";
import { whyNotArea } from "../../../domain/access.js";
import { clearanceFor, reachesProperty, whyNotClass } from "../../../domain/classification.js";
import { dnaFor } from "./identity.js";
import { authorityContext } from "../../authority/domain/jurisdiction.js";

/**
 * Open a property for this caller.
 *
 * Throws hidden() — a 404 — when the property is not this company's. A 403
 * would confirm that a property with that id exists somewhere, which is the
 * insecure-direct-object-reference the rest of this service avoids through
 * own().
 */
export async function context(req) {
  const actorOrgId = req.actor.orgId;
  const siteId = req.params.siteId;

  /*
   * THE ONE PLACE A CROSS-TENANT READ IS LEGITIMATE, AND WHY.
   *
   * Every other read in this service is scoped to the caller's own company.
   * A public authority is the exception: it is not a member of the company
   * that owns the building, so scoping to ITS organization would find
   * nothing and return 404 for every property it has a lawful mandate over.
   *
   * So an authority resolves the property by site alone — and its isolation
   * is JURISDICTION rather than tenant, enforced immediately below. If no
   * mandate reaches the property, `authority.within` is false and the caller
   * falls through to the ordinary checks, which it also fails, and the
   * result is the same 404 a stranger gets.
   *
   * It also does NOT create the record on demand. dnaFor() writes a row and
   * a timeline event; an authority glancing at a property must not cause a
   * write inside somebody else's tenant.
   */
  const authorityProfile = await db.authorityProfile.findFirst({ where: { orgId: actorOrgId } });

  const dna = authorityProfile
    ? await db.propertyDna.findFirst({ where: { siteId }, include: { site: true } })
    : await dnaFor(actorOrgId, siteId);
  if (!dna) throw hidden();

  /*
   * From here on, `orgId` is the PROPERTY'S company — every record about a
   * property belongs to its owner's tenant, whoever is reading it.
   */
  const orgId = dna.orgId;

  const relations = await db.propertyRelationship.findMany({
    where: { orgId, dnaId: dna.id, active: true, userId: req.session.userId },
  });

  /*
   * A PUBLIC AUTHORITY REACHES PROPERTIES A DIFFERENT WAY.
   *
   * It is not a member of the company that owns the building and holds no
   * relationship to it, so both checks above are empty for one. What it has
   * instead is a mandate over a JURISDICTION, and that is resolved here — by
   * the authority module, which is the only thing that knows how.
   */
  const authority = await authorityContext(req, dna, dna.site);

  /*
   * An authority whose mandate does not reach here is told nothing —
   * including whether the property exists. A 403 would confirm it.
   */
  if (authorityProfile && !authority?.within) throw hidden();

  if (!authority && !reachesProperty(req.actor, relations)) {
    throw forbidden(
      whyNotArea(req.actor, "property", "get", "this property") ||
      "You have no relationship to this property."
    );
  }

  const clearance = clearanceFor(req.actor, relations, authority);

  return { orgId, actorOrgId, dna, site: dna.site, relations, clearance, authority };
}

/** Refuse a whole section, in words that say where the person stands. */
export function gate(clearance, cls, what) {
  const why = whyNotClass(clearance, cls, what);
  if (why) throw forbidden(why);
}

/**
 * The audit writer.
 *
 * Here rather than in each service, because "who read this" is a question
 * asked after something has gone wrong and it cannot be answered later if it
 * was not recorded at the time. A failure to audit is logged and swallowed:
 * losing the record of a read is bad, and failing the read because the
 * recording failed is worse.
 */
export async function audit(req, action, entity, entityId, detail, orgId) {
  try {
    await db.auditEvent.create({
      data: {
        /*
         * Recorded in the PROPERTY's tenant when one is given, not the
         * reader's. "Who looked at my building" is a question the building's
         * owner has to be able to answer, and an audit row filed in the
         * authority's own organization would be invisible to them.
         */
        orgId: orgId || req.actor.orgId,
        actorId: req.session.userId,
        actorName: req.view?.user?.name || req.view?.user?.email || "",
        action, entity, entityId, detail: detail || undefined, ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, entity, e.message); }
}
