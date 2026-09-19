/**
 * ====================================================================== *
 * PROPERTY DNA — the identity, the memory, and the succession machine.
 *
 * Routes do HTTP. This file does the thinking, so the same rules apply
 * however a record is reached — a route today, a job or a Connect adapter
 * tomorrow.
 * ====================================================================== */

import { db } from "../db.js";

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
function slug(v, n, fallback) {
  const s = String(v || "").toUpperCase().replace(/[^A-Z]/g, "");
  return (s || fallback).slice(0, n).padEnd(n, "X");
}

export function refFor(site, sequence) {
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
export async function dnaFor(orgId, siteId) {
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
      if (e && e.code === "P2002") continue;      /* ref taken — take the next */
      throw e;
    }
  }
  return db.propertyDna.findFirst({ where: { orgId, siteId }, include: { site: true } });
}

/* ---------------------------------------------------------------- *
 * 2. THE MEMORY
 * ---------------------------------------------------------------- */

/**
 * Append an event. There is no update and no delete anywhere in this module,
 * and the test suite asserts that no route offers one.
 *
 * A correction is a new event that says what changed. That is the same rule
 * the work-order history already follows: a record somebody may later be
 * asked to rely on is worth less if it can be quietly tidied.
 */
export async function remember(orgId, dnaId, event) {
  return db.propertyTimelineEvent.create({
    data: {
      orgId,
      dnaId,
      kind: event.kind,
      at: event.at || new Date(),
      title: event.title,
      detail: event.detail || "",
      entity: event.entity || "",
      entityId: event.entityId || "",
      actorId: event.actorId || null,
      actorName: event.actorName || "",
      source: event.source || "MANAGER_SUPPLIED",
      verification: event.verification || "UNVERIFIED",
      class: event.class || "INTERNAL",
    },
  });
}

/**
 * The memory a property already had before Property DNA existed.
 *
 * Leases, work orders and inspections have been recording themselves for as
 * long as the products have run. Copying them into the timeline table would
 * have created a second copy that drifts, so they are READ from where they
 * already live and merged at query time.
 *
 * Everything returned carries a `class`, because the merge is what the
 * caller's clearance is applied to.
 */
export async function derivedEvents(orgId, siteId) {
  const [leases, work, units] = await Promise.all([
    db.lease.findMany({
      where: { orgId, unit: { siteId } },
      select: { id: true, startsOn: true, endsOn: true, unit: { select: { ref: true } } },
      take: 200, orderBy: { startsOn: "desc" },
    }).catch(() => []),
    db.workOrder.findMany({
      where: { orgId, siteId, closedAt: { not: null } },
      select: { id: true, ref: true, title: true, closedAt: true },
      take: 200, orderBy: { closedAt: "desc" },
    }).catch(() => []),
    db.unit.findMany({
      where: { orgId, siteId },
      select: { id: true, ref: true, createdAt: true },
      take: 200, orderBy: { createdAt: "desc" },
    }).catch(() => []),
  ]);

  const out = [];
  for (const l of leases) {
    if (l.startsOn) out.push({
      id: `lease:${l.id}:start`, kind: "LEASE_STARTED", at: l.startsOn,
      title: `Lease started${l.unit?.ref ? ` on ${l.unit.ref}` : ""}`,
      detail: "", entity: "lease", entityId: l.id,
      source: "MANAGER_SUPPLIED", class: "RESTRICTED", derived: true,
    });
    if (l.endsOn && l.endsOn < new Date()) out.push({
      id: `lease:${l.id}:end`, kind: "LEASE_ENDED", at: l.endsOn,
      title: `Lease ended${l.unit?.ref ? ` on ${l.unit.ref}` : ""}`,
      detail: "", entity: "lease", entityId: l.id,
      source: "MANAGER_SUPPLIED", class: "RESTRICTED", derived: true,
    });
  }
  for (const w of work) out.push({
    id: `wo:${w.id}`, kind: "MAINTENANCE_COMPLETED", at: w.closedAt,
    title: w.title || "Work order completed",
    detail: w.ref ? `Work order ${w.ref}` : "", entity: "work-order", entityId: w.id,
    source: "MANAGER_SUPPLIED", class: "INTERNAL", derived: true,
  });
  for (const u of units) out.push({
    id: `unit:${u.id}`, kind: "UNIT_CREATED", at: u.createdAt,
    title: `Unit ${u.ref} added`, detail: "", entity: "unit", entityId: u.id,
    source: "MANAGER_SUPPLIED", class: "INTERNAL", derived: true,
  });
  return out;
}

/* ---------------------------------------------------------------- *
 * 3. SUCCESSION
 * ---------------------------------------------------------------- */

/**
 * The state machine.
 *
 * Every move is explicit. There is no transition INTO ownership: reaching
 * COMPLETED records that a documented process concluded, and moving the
 * property to anybody is a separate, deliberate, audited act performed by a
 * person. PALTAS does not decide who inherits anything.
 */
export const SUCCESSION_NEXT = {
  DRAFT: ["INITIATED", "CANCELLED"],
  INITIATED: ["DOCUMENTS_REQUIRED", "UNDER_REVIEW", "CANCELLED", "DISPUTED"],
  DOCUMENTS_REQUIRED: ["UNDER_REVIEW", "CANCELLED", "DISPUTED"],
  UNDER_REVIEW: ["VERIFICATION_PENDING", "DOCUMENTS_REQUIRED", "REJECTED", "DISPUTED"],
  VERIFICATION_PENDING: ["APPROVED", "REJECTED", "DOCUMENTS_REQUIRED", "DISPUTED"],
  APPROVED: ["COMPLETED", "DISPUTED"],
  COMPLETED: [],
  REJECTED: ["DISPUTED"],
  CANCELLED: [],
  DISPUTED: ["UNDER_REVIEW", "CANCELLED"],
};

/** Terminal states cannot be reopened; a new case is opened instead. */
export const SUCCESSION_TERMINAL = new Set(["COMPLETED", "CANCELLED"]);

export function mayAdvance(from, to) {
  const allowed = SUCCESSION_NEXT[from];
  if (!allowed) return `“${from}” is not a status this workflow knows.`;
  if (SUCCESSION_TERMINAL.has(from)) {
    return `This case is ${from.toLowerCase()} and cannot be moved again. ` +
           `Open a new case if something has changed.`;
  }
  if (!allowed.includes(to)) {
    return `A case that is ${from} can move to ${allowed.join(", ") || "nothing"} — not ${to}.`;
  }
  return null;
}

/**
 * Advance a case, recording the move.
 *
 * The status column and the step trail are written together: the column is
 * what a list reads quickly, the trail is what an argument is settled with.
 */
export async function advanceCase(orgId, caseId, to, actor, why) {
  const found = await db.successionCase.findFirst({ where: { id: caseId, orgId } });
  if (!found) return { error: "notFound" };

  const no = mayAdvance(found.status, to);
  if (no) return { error: "transition", why: no };

  const decided = to === "APPROVED" || to === "REJECTED";
  const closed = SUCCESSION_TERMINAL.has(to) || to === "REJECTED";

  const [row] = await db.$transaction([
    db.successionCase.update({
      where: { id: found.id },
      data: {
        status: to,
        decidedAt: decided ? new Date() : found.decidedAt,
        closedAt: closed ? new Date() : found.closedAt,
      },
    }),
    db.successionStep.create({
      data: {
        orgId, caseId: found.id, from: found.status, to,
        why: why || "",
        actorId: actor?.userId || null,
        actorName: actor?.name || "",
      },
    }),
  ]);
  return { case: row, from: found.status };
}

/** A case reference a person can quote down a telephone. */
export function successionRef(n) {
  return "SUC-" + String(n).padStart(5, "0");
}

/* ---------------------------------------------------------------- *
 * 4. THE AI BOUNDARY
 * ---------------------------------------------------------------- */

/**
 * Assemble the slice of a property a question may be answered from.
 *
 * THE ORDER HERE IS THE WHOLE POINT. The clearance is applied BEFORE the
 * context is built, not after an answer comes back — a model that has been
 * shown a will cannot be asked to forget it, and "the prompt said not to
 * mention it" is not access control.
 *
 * Returns only what this caller could have read themselves through the API.
 */
export function aiContext({ dna, site, timeline, assets, ownership, clearance }, filters) {
  const { visibleRows } = filters;
  return {
    property: {
      ref: dna.ref,
      name: site?.name || "",
      kind: site?.kind || "",
      city: site?.city || "",
      country: site?.country || "",
      verification: dna.verification,
    },
    clearance: clearance.label,
    security: clearance.security,
    timeline: visibleRows(timeline, clearance).map((e) => ({
      at: e.at, kind: e.kind, title: e.title, detail: e.detail, source: e.source,
    })),
    assets: (assets || []).map((a) => ({
      name: a.name, kind: a.kind, status: a.status,
      servicedOn: a.servicedOn, nextServiceOn: a.nextServiceOn,
    })),
    ownership: visibleRows(ownership, clearance).map((o) => ({
      holder: o.holder, shareBp: o.shareBp, active: o.active, source: o.source,
    })),
  };
}
