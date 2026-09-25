/* ====================================================================== *
 * WHO MAY TOUCH WHAT, ACROSS THE SIX PRODUCTS.
 *
 * rights.js does this for promotions, where the frontend's backend.md sets
 * out the table role by role and the server's job is only to enforce it
 * again. Nothing equivalent is written down for property, hotel, agent or
 * security: the built console decides what a guard sees by hiding sections,
 * and hiding a section is not a permission.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SO READ THIS TABLE BEFORE TRUSTING IT. It is a proposal, not a
 * transcription. It was derived from what each role's name means in the
 * business and from which sections the console shows them — which is
 * evidence, but it is not the same as somebody deciding. Two entries in
 * particular are judgement calls worth arguing about:
 *
 *   - A GUARD may write incidents and visits and may delete nothing. A
 *     guard who can delete a visit log can delete the record of the visit
 *     they let through.
 *   - FINANCE may read every product and write only money. Reading is how
 *     an invoice gets raised against the right lease; writing a lease is
 *     not a finance job.
 *
 * If either is wrong, this file is the only place to change it.
 * ────────────────────────────────────────────────────────────────────────
 *
 * The shape is deliberately small. Nineteen roles against thirty-four
 * resources is six hundred boxes nobody will ever check, so resources are
 * grouped into eight AREAS, and a role gets one of four LEVELS in each.
 * Adding a resource means naming its area, not editing a matrix.
 * ====================================================================== */

/**
 * The eight areas. Every resource in registry.js names one of them.
 *
 * `as const` and not a plain array, because that is what turns this from a
 * list of strings into a type. `Area` below is derived from it, so a resource
 * declaring `area: "propery"` stops compiling instead of quietly granting
 * nobody access to anything — which is the shape this mistake takes today:
 * levelFor() returns "none", every request 403s, and the message blames the
 * role.
 */
export const AREAS = [
  "property",     // sites, buildings, units, leases, projects, assets
  "maintenance",  // work orders and their history
  "hotel",        // rooms, reservations, folios, services
  "agent",        // listings, leads, viewings, deals
  "security",     // zones, visits, passes, vehicles, incidents, shifts, patrols, deliveries
  "people",       // the parties a company deals with
  "documents",    // the document register
  "finance",      // invoices, payments, expenses, payouts,
  /*
   * THE NINTH AREA, ADDED FOR TOKENISED INVESTMENT.
   *
   * Not a ninth level and not a parallel permission system — the requested
   * names (investment.view, investment.approve, tokenization.manage) are this
   * area at read, manage and manage. An area is what this file has always
   * meant by "a kind of work", and an investor register is plainly a different
   * kind of work from a rent roll.
   *
   * Separate from `property` and `finance` on purpose. A front desk with
   * property read has no business in a list of who invested how much, and a
   * finance clerk reconciling rent is not thereby approving an offering.
   */
  "investments",
] as const;

/**
 * The four levels, in order. Each includes everything below it.
 *
 * `manage` is separated from `write` for one reason: DELETION. Most roles
 * that need to do a job need to create and correct records; almost none of
 * them need to make a record disappear, and the ones that do are the ones a
 * company would name if asked.
 */
export const LEVELS = ["none", "read", "write", "manage"] as const;

/** One of the eight areas. Derived, so the list above is the only place to edit. */
export type Area = (typeof AREAS)[number];
/** How much of an area somebody holds. */
export type Level = (typeof LEVELS)[number];
/** What every role is granted, per area. */
export type AreaGrants = Readonly<Record<Area, Level>>;

/**
 * The order, as numbers, so `>=` can compare two levels.
 *
 * Typed as a full record rather than inferred: `RANK[level]` is then known to
 * exist for every level, and an unknown string cannot reach it at all.
 */
const RANK: Readonly<Record<Level, number>> =
  Object.fromEntries(LEVELS.map((l, i) => [l, i])) as Record<Level, number>;

/** Shorthand, so the table below reads as a table rather than as JSON. */
const all = (level: Level): AreaGrants =>
  Object.fromEntries(AREAS.map((a) => [a, level])) as AreaGrants;

/* ====================================================================== *
 * THE TABLE.
 * ====================================================================== */

export const ROLE_AREAS: Readonly<Record<string, AreaGrants>> = {
  /* ---- the people who run the company ---- */

  OWNER: all("manage"),
  MANAGER: all("manage"),

  /** A hotel's general manager runs the hotel and its building; security is
      somebody else's department, and they can see it but not run it. */
  GM: {
    ...all("write"),
    hotel: "manage", property: "manage", maintenance: "manage",
    people: "manage", documents: "manage",
    security: "read", agent: "write", finance: "write", investments: "read" },

  OPERATIONS: {
    ...all("read"),
    property: "write", maintenance: "write", people: "write", documents: "write", investments: "none" },

  /* ---- the specialists ---- */

  /** Money in and money out, and read access everywhere so an invoice can be
      raised against the right lease, folio or deal. */
  FINANCE: { ...all("read"), finance: "manage", investments: "write" },

  LEASING: {
    ...all("none"),
    agent: "manage", property: "write", people: "write",
    documents: "write", finance: "read", investments: "none" },

  /** A host runs listings and stays. They are often not an employee of the
      company at all, which is why they see no finance and no security. */
  HOST: {
    ...all("none"),
    agent: "write", hotel: "write", people: "write", property: "read", investments: "none" },

  /* ---- the hotel floor ---- */

  FRONT_DESK: {
    ...all("none"),
    hotel: "write", people: "write", security: "read", property: "read", investments: "none" },

  /** Housekeeping changes the state of rooms and needs to know who is in
      them. It has no business creating a reservation. */
  HOUSEKEEPING: { ...all("none"), hotel: "write", maintenance: "write", investments: "none" },

  ENGINEERING: { ...all("none"), maintenance: "write", property: "read", hotel: "read", investments: "none" },

  FNB: { ...all("none"), hotel: "write", investments: "none" },

  /* ---- the front desk of a building, which is not a hotel's ---- */

  RECEPTIONIST: {
    ...all("none"),
    security: "write", people: "write", property: "read", documents: "read", investments: "none" },

  /* ---- security ---- */

  SECURITY_MANAGER: {
    ...all("none"),
    security: "manage", people: "read", property: "read", documents: "read", investments: "none" },

  /**
   * WRITE, NEVER MANAGE — and this one is not a detail.
   *
   * A guard logs visits, raises incidents, walks patrols. A guard who can
   * DELETE a visit can delete the record of the person they waved through,
   * and the log stops being evidence of anything. Corrections are events on
   * top, which is why the incident history is append-only.
   */
  GUARD: { ...all("none"), security: "write", people: "read", investments: "none" },

  /* ---- the roles that belong to the promotion workflow, not to a product ---- */

  PROMO_CONTRIBUTOR: all("none"),
  MARKETING: all("none"),
  COMPLIANCE: all("none"),
  PUBLISHER: all("none"),

  /**
   * A guest is not staff. The guest portal reads a guest's OWN stay through
   * its own endpoints, and nothing here.
   */
  GUEST: all("none"),
};

/**
 * WHO IS ASKING.
 *
 * Built by session-view.js from the person's MEMBERSHIPS, never from anything
 * the request said — that is the line every other check in this service rests
 * on. Only the two fields this module reads are named here; the full shape
 * arrives with the session types in a later phase.
 */
export interface Actor {
  readonly role: string;
  readonly orgId: string;
}

/* ====================================================================== *
 * ASKING THE TABLE.
 * ====================================================================== */

/** What this actor may do in an area. Unknown role → nothing. */
/**
 * WHO IS ASKING, AS FAR AS THE AREA TABLE IS CONCERNED.
 *
 * A role and nothing else, because a role and nothing else is what the three
 * functions below read. The same shape rights.ts already uses for
 * PromotionActor, and for the same reason: a function that demands a whole
 * Actor to look up one column cannot be called from a test, a job, or
 * anywhere else that has a role and no session — without inventing eight
 * fields it will not read.
 *
 * A full Actor satisfies it, so nothing that already calls these changes.
 */
export interface AreaActor {
  readonly role?: string;
}

export function levelFor(actor: AreaActor | null | undefined, area: Area): Level {
  if (!actor) return "none";
  const row = actor.role ? ROLE_AREAS[actor.role] : undefined;
  if (!row) return "none";
  return row[area] || "none";
}

/** Which level each verb needs. */
export const ACT_LEVEL = {
  list: "read", get: "read",
  create: "write", update: "write",
  delete: "manage",
} as const satisfies Readonly<Record<string, Level>>;

/** One of the five things a caller can ask to do. */
export type Act = keyof typeof ACT_LEVEL;

export function allows(actor: AreaActor | null | undefined, area: Area, act: Act): boolean {
  const need = ACT_LEVEL[act];
  if (!need) return false;
  return RANK[levelFor(actor, area)] >= RANK[need];
}

/**
 * Why not — a sentence, or null when it IS allowed.
 *
 * Same contract as whyNot() in rights.js: it returns a reason rather than
 * throwing, so the route picks the status code and the person reads
 * something that tells them what to do next.
 */
export function whyNotArea(
  actor: AreaActor | null | undefined,
  area: Area,
  act: Act,
  label?: string,
): string | null {
  if (!actor) return "You are not signed in.";

  const have = levelFor(actor, area);
  const need = ACT_LEVEL[act];
  const thing = label || area;

  if (have === "none") {
    return `The role “${actor.role}” has no access to ${thing}.`;
  }
  if (RANK[have] < RANK[need]) {
    if (need === "manage" && have === "write") {
      return `The role “${actor.role}” can create and correct ${thing}, but not delete. ` +
             `Deleting belongs to an owner or a manager — and for anything with a ` +
             `history, correcting it is usually what was meant.`;
    }
    return `The role “${actor.role}” can only ${have} ${thing}.`;
  }
  return null;
}

/**
 * EVERY AREA THIS ROLE MAY TOUCH, AND AT WHAT LEVEL.
 *
 * Published on the session so the console can draw a ＋ button only where a
 * create would actually be allowed. It is the same table `levelFor()` reads,
 * exported rather than restated — a second copy in the frontend is precisely
 * how the two drifted apart in the first place.
 *
 * An unknown role gets "none" everywhere, which is the same answer
 * `levelFor()` gives it.
 */
export function grantsFor(role: string | null | undefined): AreaGrants {
  const row = role ? ROLE_AREAS[role] : undefined;
  if (row) return row;
  return Object.fromEntries(AREAS.map((a) => [a, "none"])) as AreaGrants;
}
