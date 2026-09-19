/**
 * ====================================================================== *
 * HOW A PUBLIC AUTHORITY REACHES A PROPERTY.
 *
 * Not through membership — an authority is not a member of the company that
 * owns the building. Not through a relationship — it is not an owner or an
 * executor. It reaches a property through a MANDATE:
 *
 *     this authority, over this jurisdiction, for these datasets,
 *     on this basis, for this long.
 *
 * ── WHAT THIS FILE REFUSES TO BUILD ─────────────────────────────────────
 *
 * There is no wildcard. AuthorityDataset has no ALL value and the mandate
 * model has no "everything" flag, so the widest mandate that can exist is
 * still a list somebody wrote down and somebody else can read back. A
 * planning authority that may read a zoning decision has no route to a will,
 * a private valuation or a camera map — the mandate does not name them and
 * the classification refuses them.
 *
 * ── WHY JURISDICTION IS A STRING PREFIX ─────────────────────────────────
 *
 * Containment is decided against a materialised path — "KE/NAIROBI" contains
 * "KE/NAIROBI/WESTLANDS" because the second starts with the first, plus a
 * separator. The alternative is a recursive query on every property read.
 * The separator check is what stops "KE/NAIRO" matching "KE/NAIROBI".
 * ====================================================================== */

import { db } from "../../../db.js";

/** Uppercase, slash-separated, no leading or trailing slash. */
export function normalisePath(parts) {
  return (Array.isArray(parts) ? parts : String(parts || "").split("/"))
    .map((p) => String(p || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, ""))
    .filter(Boolean)
    .join("/");
}

/**
 * Does `mandatePath` contain `propertyPath`?
 *
 * Exact match, or an ancestor. The separator is required so that a mandate
 * over KE/NAIRO — which is not a place — cannot reach KE/NAIROBI.
 */
export function contains(mandatePath, propertyPath) {
  if (!mandatePath || !propertyPath) return false;
  if (mandatePath === propertyPath) return true;
  return propertyPath.startsWith(mandatePath + "/");
}

/**
 * Where a property sits, as a path.
 *
 * Derived from the property's own country and city today, because that is
 * what a Site records. When a parcel with a jurisdiction is linked, that is
 * authoritative and wins — a parcel's jurisdiction was set by an authority,
 * and a city typed into a form was not.
 */
export async function pathForProperty(orgId, site) {
  const link = await db.propertyParcel.findFirst({
    where: { orgId, siteId: site.id },
    include: { parcel: { include: { jurisdiction: true } } },
  });
  const fromParcel = link?.parcel?.jurisdiction?.path;
  if (fromParcel) return { path: fromParcel, source: "parcel" };
  return { path: normalisePath([site.country, site.city]), source: "property record" };
}

/**
 * The authority context for this caller on this property, or null.
 *
 * Null is the normal answer: almost every caller is a person at a company,
 * not a public body. Returning null means "not an authority", and the caller
 * then has to reach the property the ordinary way.
 *
 * An UNVERIFIED authority profile grants nothing. PALTAS checking that a body
 * is what it says it is comes before any mandate it claims.
 */
export async function authorityContext(req, dna, site) {
  const actorOrgId = req.actor?.orgId;
  if (!actorOrgId) return null;

  const profile = await db.authorityProfile.findFirst({ where: { orgId: actorOrgId } });
  if (!profile) return null;

  if (!profile.verified) {
    return {
      profile, verified: false, datasets: [], mandates: [], within: false,
      why: "This authority has not been verified by PALTAS, so none of its " +
           "mandates are in force yet.",
    };
  }

  const now = new Date();
  const mandates = await db.authorityMandate.findMany({
    where: {
      profileId: profile.id, active: true,
      startsOn: { lte: now },
      OR: [{ endsOn: null }, { endsOn: { gte: now } }],
    },
    include: { jurisdiction: true },
  });
  if (!mandates.length) return { profile, verified: true, datasets: [], mandates: [], within: false,
    why: "This authority holds no mandate that is in force." };

  /*
   * The property's jurisdiction is read against the PROPERTY's organization,
   * not the authority's: the parcel link belongs to the company that owns the
   * building. dna.orgId is that company.
   */
  const where = await pathForProperty(dna.orgId, site);

  const applicable = mandates.filter((m) => contains(m.jurisdiction?.path || "", where.path));
  if (!applicable.length) {
    return {
      profile, verified: true, datasets: [], mandates: [], within: false,
      jurisdiction: where,
      why: `This property is in ${where.path || "an unrecorded jurisdiction"}, ` +
           `and this authority's mandates cover ` +
           `${mandates.map((m) => m.jurisdiction?.path).filter(Boolean).join(", ") || "nowhere"}.`,
    };
  }

  /* The union of what the applicable mandates name, and nothing wider. */
  const datasets = [...new Set(applicable.flatMap((m) => m.datasets || []))];
  const mayWrite = applicable.some((m) => m.mayWrite);

  return {
    profile, verified: true, within: true,
    jurisdiction: where,
    mandates: applicable.map((m) => ({
      id: m.id, path: m.jurisdiction?.path, datasets: m.datasets,
      basis: m.basis, purpose: m.purpose, endsOn: m.endsOn,
    })),
    datasets, mayWrite,
  };
}

/** May this authority context read this dataset? */
export function mayDataset(authority, dataset) {
  if (!authority || !authority.within) return false;
  return (authority.datasets || []).includes(dataset);
}

/**
 * Why not — a sentence naming the mandate that is missing, so somebody can
 * go and ask for the right one rather than guessing.
 */
export function whyNotDataset(authority, dataset, what) {
  if (!authority) return `${what} is not available to this account.`;
  if (!authority.verified) return authority.why;
  if (!authority.within) return authority.why;
  if (mayDataset(authority, dataset)) return null;
  return `${what} needs the ${dataset} dataset. This authority's mandate over ` +
         `${authority.jurisdiction?.path} covers ` +
         `${(authority.datasets || []).join(", ") || "no datasets"}.`;
}
