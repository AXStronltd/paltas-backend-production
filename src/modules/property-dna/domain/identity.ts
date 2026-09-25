/**
 * ====================================================================== *
 * PROPERTY IDENTITY.
 *
 * The identifier and the record it belongs to. Split out of the single
 * domain file so that context.js — which every other service depends on —
 * imports identity alone and not the timeline, succession and AI boundary
 * with it.
 * ====================================================================== */

import { db } from "../../../db.ts";
import { isPrismaError } from "../../../http/errors.ts";

/* ---------------------------------------------------------------- *
 * 1. THE IDENTIFIER
 * ---------------------------------------------------------------- */

/**
 * PALTAS-PROP-KE-NAI-00001234
 *
 * Country and city are there so a person can read one aloud and know roughly
 * what it is. The sequence is per ORGANIZATION, not global: a global counter
 * would tell every customer how many properties every other customer has,
 * which is a business fact PALTAS has no right to publish.
 */
function slug(v: unknown, n: number, fallback: string): string {
  const s = String(v || "").toUpperCase().replace(/[^A-Z]/g, "");
  return (s || fallback).slice(0, n).padEnd(n, "X");
}

/** The parts of a site an identifier is built from. */
export interface SiteForRef {
  readonly country?: string | null;
  readonly city?: string | null;
}

export function refFor(site: SiteForRef | null | undefined, sequence: number | string): string {
  return [
    "PALTAS-PROP",
    slug(site?.country, 2, "XX"),
    slug(site?.city, 3, "XXX"),
    String(sequence).padStart(8, "0"),
  ].join("-");
}

/**
 * Get the DNA record for a site, creating it the first time it is asked for.
 *
 * Created on demand rather than by a migration backfill: a migration that
 * writes a row for every existing site is a migration that can half-finish,
 * and there is no moment where a site NEEDS one before somebody opens it.
 */
export async function dnaFor(orgId: string, siteId: string) {
  const existing = await db.propertyDna.findFirst({
    where: { orgId, siteId },
    include: { site: true },
  });
  if (existing) return existing;

  const site = await db.site.findFirst({ where: { id: siteId, orgId } });
  if (!site) return null;

  /* The sequence is "how many this company already has", which is stable
     enough for an identifier and needs no extra table. A collision can only
     happen if two are created in the same millisecond for one org; the unique
     index catches it and the retry below takes the next number. */
  for (let attempt = 0; attempt < 4; attempt++) {
    const n = await db.propertyDna.count({ where: { orgId } });
    try {
      const made = await db.propertyDna.create({
        data: { orgId, siteId, ref: refFor(site, n + 1 + attempt) },
        include: { site: true },
      });
      await db.propertyTimelineEvent.create({
        data: {
          orgId, dnaId: made.id, kind: "PROPERTY_CREATED",
          title: `${site.name} entered PALTAS`,
          detail: "Property DNA opened for this property.",
          entity: "site", entityId: site.id,
          source: "MANAGER_SUPPLIED", class: "INTERNAL",
        },
      });
      return made;
    } catch (e) {
      if (isPrismaError(e) && e.code === "P2002") continue;   /* ref taken — take the next */
      throw e;
    }
  }
  return db.propertyDna.findFirst({ where: { orgId, siteId }, include: { site: true } });
}

