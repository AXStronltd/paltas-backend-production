/* ====================================================================== *
 * SITE SCOPE — "a guard on two gates is not a guard on every gate".
 *
 * `Membership.scope` has always been stored, returned in the session, and read
 * by the frontend. Nothing enforced it. So a guard whose remit was one gate
 * could list every visit, pass, vehicle, incident and patrol in the whole
 * company — the organization filter held, and inside it there was no wall at
 * all. `contract/backend.md` admitted as much: "Membership carries a scope;
 * nothing enforces it per site yet."
 *
 * This enforces it, in the same place and the same way the organization filter
 * works: by narrowing `where` before any handler can see it.
 *
 * ── THE SHAPES, AND WHAT EACH MEANS ────────────────────────────────────
 *
 *   {"all": true}            every site. The column default, and what
 *                            POST /organizations writes for an owner.
 *   {"sites": ["a", "b"]}    those sites and nothing else.
 *   anything else            NOTHING.
 *
 * That last one is deliberate and it is the only defensible default. An
 * unreadable scope is a data bug, and the two ways to read it are "show them
 * everything" or "show them nothing". The first turns a malformed row into a
 * silent breach; the second turns it into a person saying "my screen is
 * empty", which somebody fixes the same morning. Visible and wrong beats
 * invisible and wrong.
 *
 * ── WHAT IT CANNOT REACH, SAID PLAINLY ─────────────────────────────────
 *
 * Seventeen resources carry a site and are narrowed. Twelve do not — parties,
 * documents, leases, reservations, listings, leads, viewings, deals, invoices,
 * payments, payouts, guest-requests — and for those this does nothing, because
 * there is no column to narrow by. A site-scoped receptionist can still read
 * the company's whole contact list.
 *
 * That is a real limit, not an oversight. Fixing it means deciding what a
 * site-scoped person's remit IS for a row with no site — an invoice raised
 * against a lease, a contact who visits three buildings — and that is a
 * product decision rather than a filter. Naming the twelve here is better than
 * implying a wall that is not there.
 * ====================================================================== */

/** The site ids this actor may see, or null for "all of them". */
export function scopedSites(actor) {
  let scope = actor && actor.scope;

  /* A Json column usually arrives parsed, but not down every path — raw SQL
     and some drivers hand back text. Refusing to read it would lock a person
     out over a representation detail. Unparseable text falls through to the
     rule below and shows nothing, which is the same answer as any other
     scope this cannot read. */
  if (typeof scope === "string") {
    try { scope = JSON.parse(scope); } catch { scope = null; }
  }
  if (scope && scope.all === true) return null;                 /* unrestricted */
  if (scope && Array.isArray(scope.sites) && scope.sites.length) {
    return scope.sites.map(String);
  }
  return [];                                                    /* nothing */
}

/**
 * The extra `where` this actor's scope adds for this resource, or null.
 *
 * `sites` narrows on its own id; everything else with a `siteId` narrows on
 * that. A row whose `siteId` is null is NOT included: scope means "these
 * sites", and a row belonging to no site is not one of them.
 */
export function scopeWhere(actor, resource, slug) {
  const allowed = scopedSites(actor);
  if (allowed === null) return null;
  if (slug === "sites") return { id: { in: allowed } };
  if (resource.fields && resource.fields.siteId) return { siteId: { in: allowed } };
  return null;                    /* no site to narrow by — see the note above */
}

/**
 * The same narrowing for a hand-written query, given a model's own field map.
 *
 * The resource framework reaches this through scopeWhere() with a resource
 * declaration. products.js counts models directly and has no declaration to
 * hand over, so it says which model it means and gets the same answer — the
 * alternative is a second copy of the rule, and two copies of a filter is how
 * one of them comes to be wrong.
 *
 * Returns null when nothing should be narrowed, which spreads to nothing.
 */
export function scopedTo(actor, model) {
  const allowed = scopedSites(actor);
  if (allowed === null) return null;
  if (model === "site") return { id: { in: allowed } };
  return SITE_BEARING.has(model) ? { siteId: { in: allowed } } : null;
}

/**
 * The models that carry a siteId of their own.
 *
 * Listed rather than derived because a hand-written count names a MODEL, not a
 * resource slug, and there is no declaration to read the field map from. The
 * test in scope-api.test.js checks this against the schema, so a new site-
 * bearing model cannot be added without either appearing here or failing.
 */
export const SITE_BEARING = new Set([
  "building", "unit", "project", "workOrder", "asset", "room", "hotelService",
  "zone", "visit", "pass", "vehicle", "incident", "guardShift", "patrol",
  "delivery", "expense",
  /* Added with the security capabilities: a camera, a duty and an emergency
     plan all belong to a site, so a site-scoped guard must see only their
     own. scope-api.test.js compares this set against the schema. */
  "camera", "guardTask", "emergencyPlan",
]);
