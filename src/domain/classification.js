/**
 * ====================================================================== *
 * PROPERTY DNA — WHO MAY SEE WHAT.
 *
 * The existing access model (domain/access.js) answers one question: may this
 * ROLE touch this AREA, and how far — read, write or manage. That is the
 * right question for "can a receptionist edit a lease", and it is the wrong
 * question for "may this manager read what the family paid for the house".
 *
 * Property DNA needs a second axis. A person's standing ON A PROPERTY is not
 * their job at the company:
 *
 *   - A MANAGER may run the building every day and have no business seeing
 *     an ownership record, a private valuation or a will.
 *   - An OWNER may hold no company role at all.
 *   - An EXECUTOR needs the estate papers and nothing else — not the rent
 *     roll, not the CCTV layout.
 *   - A GUARD needs the gate configuration and must never see a tenant's
 *     lease or an heir's contact details.
 *
 * So: AREA decides whether you reach the property at all, and CLASSIFICATION
 * decides how deep. Both must pass. This module is the second one.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────
 *
 * Hiding a field in the browser is not access control. Every read of a
 * Property DNA record goes through `redact()` here, which DELETES fields the
 * caller has no clearance for before the response is built. A field that was
 * never in the JSON cannot be read out of the network tab.
 *
 * ── WHY SECURITY_RESTRICTED IS NOT SIMPLY "THE TOP" ─────────────────────
 *
 * The other classes form a ladder — an owner sees everything below them. A
 * gate layout and a camera map are different: an owner has no operational
 * need for them, and "the owner can see everything" is exactly how a
 * building's access control ends up in a sale pack. SECURITY_RESTRICTED is
 * therefore granted by a SEPARATE right, held by security roles and by the
 * people who run the company — not inherited by climbing the ladder.
 * ====================================================================== */

import { levelFor } from "./access.ts";

/**
 * The ladder, least to most restricted.
 *
 * SECURITY_RESTRICTED is deliberately absent: it is not a rung. See below.
 */
export const CLASS_RANK = {
  PUBLIC: 0,
  INTERNAL: 1,
  RESTRICTED: 2,
  CONFIDENTIAL: 3,
  OWNER_ONLY: 4,
  LEGAL_RESTRICTED: 5,
};

/**
 * OFF THE LADDER, EACH GRANTED ON ITS OWN TERMS.
 *
 * Two rooms, not two more floors.
 *
 * SECURITY_RESTRICTED — the gate layout, the camera map, the unwatched
 * hours. On a ladder the top sees everything below, so an owner would inherit
 * the document a thief wants most and has no operational need for.
 *
 * AUTHORITY_RESTRICTED — what the state records: the parcel, the zoning, the
 * permits. It is not "more secret" than an owner's private valuation, it is
 * secret to DIFFERENT PEOPLE. A planning authority reads it and never reaches
 * OWNER_ONLY; an owner may be shown it and never reaches it by climbing.
 *
 * Both are therefore tested by a separate right rather than by rank, and
 * neither appears in CLASS_RANK.
 */
export const SECURITY_CLASS = "SECURITY_RESTRICTED";
export const AUTHORITY_CLASS = "AUTHORITY_RESTRICTED";
export const OFF_LADDER = [SECURITY_CLASS, AUTHORITY_CLASS];

export const ALL_CLASSES = [...Object.keys(CLASS_RANK), ...OFF_LADDER];

/**
 * What each PROPERTY RELATIONSHIP is worth, as a ceiling.
 *
 * These are ceilings, not grants: a relationship never LOWERS what somebody
 * already had through their role, and never raises them past this line.
 */
export const RELATION_CEILING = {
  OWNER: "LEGAL_RESTRICTED",
  CO_OWNER: "OWNER_ONLY",
  /* An executor is trusted with the estate and nothing else. They are given
     the legal tier because that is the tier the estate papers live in — and
     the classification of a record, not the person's title, is what decides
     whether they see it. */
  EXECUTOR: "LEGAL_RESTRICTED",
  ADMINISTRATOR: "LEGAL_RESTRICTED",
  TRUSTEE: "OWNER_ONLY",
  LEGAL_REPRESENTATIVE: "LEGAL_RESTRICTED",
  FAMILY_REPRESENTATIVE: "OWNER_ONLY",
  /* A named heir is not yet an owner. They see that a case exists and their
     own place in it; they do not get the family's financial history. */
  BENEFICIARY: "CONFIDENTIAL",
  MANAGER: "RESTRICTED",
  DEVELOPER: "RESTRICTED",
  OPERATOR: "RESTRICTED",
};

/**
 * What a company ROLE is worth on a property the person has no relationship
 * to. Nothing here reaches OWNER_ONLY — that tier is held by standing on the
 * property, never by seniority at the company.
 *
 * OWNER and MANAGER are the company's owner and manager, which is not the
 * property's owner. A managing agent runs other people's buildings; that is
 * the whole business. So they stop at CONFIDENTIAL.
 */
export const ROLE_CEILING = {
  OWNER: "CONFIDENTIAL",
  MANAGER: "CONFIDENTIAL",
  GM: "CONFIDENTIAL",
  FINANCE: "CONFIDENTIAL",
  OPERATIONS: "RESTRICTED",
  LEASING: "RESTRICTED",
  HOST: "INTERNAL",
  SECURITY_MANAGER: "RESTRICTED",
  RECEPTIONIST: "INTERNAL",
  FRONT_DESK: "INTERNAL",
  HOUSEKEEPING: "INTERNAL",
  ENGINEERING: "INTERNAL",
  FNB: "INTERNAL",
  GUARD: "PUBLIC",
  GUEST: "PUBLIC",
  /* PALTAS's own staff. An administrator is not a customer's owner, and
     nothing here gives one access to a family's papers. */
  MARKETING: "PUBLIC",
  COMPLIANCE: "INTERNAL",
  PUBLISHER: "PUBLIC",
};

/** Roles whose job is the building's security posture. */
const SECURITY_ROLES = new Set(["OWNER", "MANAGER", "SECURITY_MANAGER"]);

/**
 * A guard is on the gate and needs the gate. They do NOT get the estate's
 * security design — where the cameras are, which zones are unwatched — which
 * is the document a thief would want most.
 */
const SECURITY_RELATIONS = new Set(["OWNER", "CO_OWNER"]);

/**
 * The clearance a person holds ON ONE PROPERTY.
 *
 * `actor`        the session actor — { role, orgId, ... }
 * `relations`    that person's ACTIVE PropertyRelationship rows for this
 *                property. An empty list is the normal case.
 *
 * Returns { rank, label, security, via } — `via` names what granted it, which
 * is what the permissions endpoint shows a person about themselves.
 */
export function clearanceFor(actor, relations, authority) {
  if (!actor) return { rank: -1, label: "NONE", security: false, authority: false, via: "not signed in" };

  /*
   * A PUBLIC AUTHORITY IS NOT A SENIOR CUSTOMER.
   *
   * It arrives with a mandate rather than a role, and what it gets is the
   * authority room plus the public floor — NOT a rank that climbs toward a
   * family's papers. This is the single most important line in the file: it
   * is what stops "government = see everything" from being true.
   */
  if (authority && authority.within) {
    return {
      rank: CLASS_RANK.PUBLIC,
      label: "AUTHORITY",
      security: false,
      authority: true,
      datasets: authority.datasets || [],
      via: `mandate over ${authority.jurisdiction?.path || "a jurisdiction"}`,
    };
  }
  /* An authority whose mandate does not reach here gets nothing at all. */
  if (authority) {
    return { rank: -1, label: "NONE", security: false, authority: false, via: authority.why || "no mandate here" };
  }

  const roleLabel = ROLE_CEILING[actor.role] || "PUBLIC";
  let best = CLASS_RANK[roleLabel];
  let via = `role ${actor.role}`;

  const live = (relations || []).filter((r) => r && r.active !== false);
  for (const rel of live) {
    const label = RELATION_CEILING[rel.relation];
    if (!label) continue;
    /* A relationship may carry an explicit, narrower clearance — an owner who
       has deliberately limited a co-owner, say. The lower of the two wins,
       because a ceiling is a ceiling. */
    const capped = rel.clearance && CLASS_RANK[rel.clearance] !== undefined
      ? Math.min(CLASS_RANK[label], CLASS_RANK[rel.clearance])
      : CLASS_RANK[label];
    if (capped > best) { best = capped; via = `${rel.relation} of this property`; }
  }

  const security =
    SECURITY_ROLES.has(actor.role) ||
    live.some((r) => SECURITY_RELATIONS.has(r.relation));

  const label = Object.keys(CLASS_RANK).find((k) => CLASS_RANK[k] === best) || "PUBLIC";
  /* A customer never reads the authority room, however senior. What the state
     holds about a property is shown to the property's own people through the
     records they are given, not by climbing. */
  return { rank: best, label, security, authority: false, via };
}

/** May this clearance read a record of this classification? */
export function mayRead(clearance, cls) {
  if (!clearance || clearance.rank < 0) return false;
  if (cls === SECURITY_CLASS) return !!clearance.security;
  /*
   * AUTHORITY_RESTRICTED IS ASYMMETRIC, AND THAT IS THE POINT.
   *
   * Two different people may read an official record about a building:
   *
   *   the authority whose mandate covers it — its own register; and
   *   the building's own people, from RESTRICTED up — it is their permit,
   *   and a landlord who cannot see the permit on their own block is being
   *   protected from nothing.
   *
   * The asymmetry runs ONE WAY. A customer reading up into the authority
   * room does not let an authority read down into OWNER_ONLY: an authority
   * clearance sits at rank PUBLIC and climbs nowhere. So "an owner sees
   * their permits" and "a planning officer never sees a will" are both true,
   * which is exactly the pair this model exists to hold.
   */
  if (cls === AUTHORITY_CLASS) {
    return !!clearance.authority || clearance.rank >= CLASS_RANK.RESTRICTED;
  }
  const need = CLASS_RANK[cls];
  if (need === undefined) return false;          /* an unknown class is refused */
  return clearance.rank >= need;
}

/**
 * Drop every row the caller may not read.
 *
 * Rows carry their own `class`; a row with none is treated as INTERNAL rather
 * than as public, because the failure that matters is the one that leaks.
 */
export function visibleRows(rows, clearance) {
  return (rows || []).filter((r) => mayRead(clearance, (r && r.class) || "INTERNAL"));
}

/**
 * Build a response object, field by field, from a spec.
 *
 * `spec` maps an output key to { from, class } — `from` is the source key (or
 * a function of the row), `class` is what that field costs to read.
 *
 * Fields the caller cannot read are ABSENT, not null and not empty string: a
 * null tells a reader that something exists and they cannot see it, which on
 * an ownership record is itself a disclosure.
 */
export function redact(row, spec, clearance) {
  const out = {};
  if (!row) return out;
  for (const [key, rule] of Object.entries(spec)) {
    if (!mayRead(clearance, rule.class)) continue;
    const v = typeof rule.from === "function" ? rule.from(row) : row[rule.from ?? key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * What was withheld, as counts rather than contents.
 *
 * Shown so a person understands the record is incomplete without learning
 * anything from it — "3 ownership records you cannot see" is honest; listing
 * their holders is not. Nothing here names a field or a value.
 */
export function withheldSummary(rows, clearance) {
  const out = {};
  for (const r of rows || []) {
    const cls = (r && r.class) || "INTERNAL";
    if (mayRead(clearance, cls)) continue;
    out[cls] = (out[cls] || 0) + 1;
  }
  return out;
}

/**
 * The gate for a whole section.
 *
 * Returns null when allowed, or a sentence when not — the same contract as
 * whyNotArea() in access.js, so a route picks the status code and the person
 * reads something that tells them where they stand.
 */
export function whyNotClass(clearance, cls, what) {
  if (!clearance || clearance.rank < 0) return "You are not signed in.";
  if (mayRead(clearance, cls)) return null;
  if (cls === SECURITY_CLASS) {
    return `${what} is security-restricted. It is shown to the people who run ` +
           `this property's security, and holding another role here does not ` +
           `include it.`;
  }
  if (cls === AUTHORITY_CLASS) {
    return `${what} is an official record, shown to the public authority whose ` +
           `mandate covers this property. It is not reached by seniority.`;
  }
  return `${what} is classified ${cls}. Your access to this property is ` +
         `${clearance.label}, through your ${clearance.via}.`;
}

/**
 * The ONE public shape.
 *
 * Everything the marketplace, a listing, a guest page or an unauthenticated
 * visitor may ever learn about a property, in one place, so that adding a
 * field to Property DNA cannot quietly widen what the public sees. If it is
 * not named here, it does not leave.
 */
export function publicProfile(dna, site) {
  if (!dna || !dna.publicProfile) return null;
  return {
    ref: dna.ref,
    name: site?.name || "",
    kind: site?.kind || "",
    city: site?.city || "",
    country: site?.country || "",
    summary: dna.publicSummary || "",
    verified: dna.verification === "VERIFIED",
  };
}

/**
 * Does this actor reach the property at all?
 *
 * The existing area gate, kept as the first door so Property DNA cannot
 * become a way around it. A person who may not read `property` may still
 * reach their own property through a relationship — that is the case of an
 * owner who holds no company role — and nothing else.
 */
export function reachesProperty(actor, relations) {
  if (!actor) return false;
  if (levelFor(actor, "property") !== "none") return true;
  return (relations || []).some((r) => r && r.active !== false);
}
