/* ====================================================================== *
 * THE PROMOTION RULES.
 *
 * The frontend has a copy of everything in this file. That copy exists so a
 * customer gets an answer while they type; THIS copy is the one that decides,
 * and it re-runs every check the browser ran because a browser is a place
 * where checks are suggestions.
 * ====================================================================== */

import { badRequest } from "../http/errors.ts";
import type { PromotionAct } from "./rights.ts";

/* ------------------------------------------------------- the public gate */

/*
 * EXACTLY ONE STATE IS PUBLIC.
 *
 * Not "approved". Not "scheduled". PUBLISHED, and nothing else. This Set is
 * the only thing GET /promotions/public consults, and the only place in the
 * service that may grow a second member.
 *
 * The three reasons a promotion can be public are ALL required:
 *   1. the state is PUBLISHED
 *   2. today is inside startDate–endDate
 *   3. it has a headline and a call to action — something to show, somewhere to go
 */
/** The twelve states a promotion moves through. */
export type PromotionState =
  | "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "CHANGES_REQUESTED" | "RESUBMITTED"
  | "MARKETING_APPROVED" | "FINAL_APPROVED" | "SCHEDULED" | "PUBLISHED"
  | "PAUSED" | "EXPIRED" | "REJECTED";

/** The ten moves between them. */
export type PromotionTransition =
  | "submit" | "claim" | "approveMarketing" | "requestChanges" | "reject"
  | "publish" | "schedule" | "pause" | "approveFinal" | "expire";

export const PUBLIC_STATES: ReadonlySet<string> = new Set(["PUBLISHED"]);

export const isPublicState = (status: unknown): boolean => PUBLIC_STATES.has(String(status));

/** Given a date, the Prisma `where` that answers "what may the world see". */
export function publicWhere(today?: Date | null) {
  const day = startOfDay(today || new Date());
  return {
    status: "PUBLISHED",
    AND: [
      { OR: [{ startDate: null }, { startDate: { lte: endOfDay(day) } }] },
      { OR: [{ endDate: null }, { endDate: { gte: day } }] },
      { headline: { not: "" } },
      { ctaLabel: { not: "" } },
    ],
  };
}

/*
 * AND THEN CHECKED AGAIN IN MEMORY.
 *
 * Belt and braces on purpose. The `where` above is what makes the query fast;
 * this is what makes it correct. If the two ever disagree — a timezone edge,
 * a null that Postgres compared differently than expected — the strict one
 * wins, and what leaks is nothing rather than somebody's draft.
 */
/** A promotion as the visibility rules read it. */
export interface VisibilityFields {
  readonly status?: unknown;
  readonly startDate?: Date | string | null;
  readonly endDate?: Date | string | null;
  readonly headline?: string | null;
  readonly ctaLabel?: string | null;
}

export function isPubliclyVisible(
  p: VisibilityFields | null | undefined,
  today?: Date | null,
): boolean {
  if (!p || !isPublicState(p.status)) return false;
  const day = startOfDay(today || new Date());
  if (p.startDate && startOfDay(p.startDate) > day) return false;
  if (p.endDate && startOfDay(p.endDate) < day) return false;
  return Boolean(p.headline && p.ctaLabel);
}

const startOfDay = (d: Date | string | number): Date => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date | string | number): Date => {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
};

/* ------------------------------------------------------- the transitions */

/*
 * WHAT MAY FOLLOW WHAT.
 *
 * A state machine written down rather than implied by a pile of if-statements.
 * Anything not listed is refused, which means a promotion cannot go from DRAFT
 * to PUBLISHED however the request is crafted — there is no arrow.
 */
/** One arrow: where it may start, where it lands, and what it costs to make. */
export interface PromotionArrow {
  readonly from: readonly PromotionState[];
  /** A function because `submit` lands differently depending where it came from. */
  readonly to: (from: PromotionState) => PromotionState;
  readonly right: PromotionAct;
  /** A move that sends work back has to say why. */
  readonly needsMessage?: boolean;
}

export const TRANSITIONS: Readonly<Record<PromotionTransition, PromotionArrow>> = {
  submit: {
    from: ["DRAFT", "CHANGES_REQUESTED", "REJECTED"],
    /* Coming back after changes is a RESUBMISSION, and a reviewer needs to see
       that rather than a fresh submission with no history. */
    to: (from: PromotionState) => (from === "DRAFT" ? "SUBMITTED" : "RESUBMITTED"),
    right: "submit",
  },
  claim: {
    from: ["SUBMITTED", "RESUBMITTED"],
    to: () => "UNDER_REVIEW",
    right: "queue",
  },
  approveMarketing: {
    from: ["SUBMITTED", "RESUBMITTED", "UNDER_REVIEW"],
    to: () => "MARKETING_APPROVED",
    right: "approveMarketing",
  },
  requestChanges: {
    from: ["SUBMITTED", "RESUBMITTED", "UNDER_REVIEW", "MARKETING_APPROVED",
           "FINAL_APPROVED", "SCHEDULED", "PUBLISHED", "PAUSED"],
    to: () => "CHANGES_REQUESTED",
    right: "requestChanges",
    needsMessage: true,
  },
  reject: {
    from: ["SUBMITTED", "RESUBMITTED", "UNDER_REVIEW", "MARKETING_APPROVED", "FINAL_APPROVED"],
    to: () => "REJECTED",
    right: "requestChanges",
    needsMessage: true,
  },
  /*
   * FINAL APPROVAL — the twelfth state, and until now the unreachable one.
   *
   * `FINAL_APPROVED` was declared in the enum, listed in four `from:` arrays,
   * given a right in rights.js (PUBLISHER.approveFinal) and a sentence in
   * whoCan() — and no transition ever wrote it. A promotion could only go
   * MARKETING_APPROVED -> PUBLISHED, so the state existed everywhere except
   * in the one place that could produce it.
   *
   * It is a real step, not ceremony: marketing approving the COPY and a
   * publisher clearing it to GO are different judgements by different people,
   * which is the whole reason no role here is a superset of the one before it.
   * Publishing straight from MARKETING_APPROVED stays allowed, because that is
   * what the console does today and removing it would break a working queue.
   */
  approveFinal: {
    from: ["MARKETING_APPROVED"],
    to: () => "FINAL_APPROVED",
    right: "approveFinal",
  },

  publish: {
    from: ["MARKETING_APPROVED", "FINAL_APPROVED", "SCHEDULED", "PAUSED"],
    to: () => "PUBLISHED",
    right: "publish",
  },
  schedule: {
    from: ["MARKETING_APPROVED", "FINAL_APPROVED"],
    to: () => "SCHEDULED",
    right: "schedule",
  },
  pause: {
    from: ["PUBLISHED", "SCHEDULED"],
    to: () => "PAUSED",
    right: "pause",
    needsMessage: true,
  },

  /*
   * EXPIRED — recording what the dates already decided.
   *
   * `publicWhere()` has always hidden a promotion once `endDate` passed, so
   * nothing has ever leaked past its window. But the ROW still read PUBLISHED,
   * which meant the database disagreed with the product: a customer asking
   * "is my campaign still running" got one answer from the homepage and a
   * different one from their own dashboard.
   *
   * This writes the state down. It does not change what the public sees —
   * that was already correct — it makes the record honest.
   *
   * NOT automatic. A sweep needs something to run it on a schedule, and this
   * service has no scheduler; inventing a timer inside a web process that
   * Render may run more than one of would expire things twice. So it is an
   * explicit publisher action, and the dates remain the thing that actually
   * governs visibility until a scheduled job calls it.
   */
  expire: {
    from: ["PUBLISHED", "SCHEDULED", "PAUSED"],
    to: () => "EXPIRED",
    right: "publish",
  },
};

/** The words a person reads when they ask for an arrow that does not exist. */
export function transitionRefusal(action: string, from: unknown): string {
  const t = TRANSITIONS[action as PromotionTransition];
  if (!t) return "There is no such action.";
  return `A promotion that is ${humanState(from)} cannot be ${pastTense(action)}. ` +
    `That is only possible from: ${t.from.map(humanState).join(", ")}.`;
}

const HUMAN: Readonly<Record<string, string>> = {
  DRAFT: "a draft", SUBMITTED: "submitted", UNDER_REVIEW: "under review",
  CHANGES_REQUESTED: "waiting on changes", RESUBMITTED: "resubmitted",
  MARKETING_APPROVED: "approved by marketing", FINAL_APPROVED: "approved",
  SCHEDULED: "scheduled", PUBLISHED: "published", PAUSED: "paused",
  EXPIRED: "expired", REJECTED: "not accepted",
};
const humanState = (s: unknown): string => HUMAN[String(s)] || String(s).toLowerCase();
const PAST_TENSE: Readonly<Record<string, string>> = {
  submit: "submitted", claim: "taken for review", approveMarketing: "approved",
  requestChanges: "sent back", reject: "turned down", publish: "published",
  schedule: "scheduled", pause: "paused",
  approveFinal: "given final approval", expire: "expired",
};
const pastTense = (a: string): string => PAST_TENSE[a] || a;

/* --------------------------------------------------------- the checks */

/*
 * Claims PALTAS would be asked to stand behind. Flagged for a person, never
 * silently removed — the customer may have grounds the product knows nothing
 * about, and it is their claim to make or withdraw, not ours to edit.
 */
export const UNSUPPORTED: readonly string[] = [
  "guaranteed", "guarantee", "best price", "cheapest", "lowest price",
  "world's best", "number one", "#1", "award-winning", "five star", "5-star",
  "luxury certified", "free upgrade", "always available", "unlimited",
];

export const CREATIVE_RULES = {
  minW: 1600, minH: 900, ratio: 16 / 9, ratioTol: 0.12,
  maxMB: 5, types: ["jpg", "jpeg", "png", "webp"], minWmobile: 800,
};

/**
 * The ten content checks. Returns rows the frontend renders unchanged, plus
 * `ready`, which is the only thing the submit route consults.
 *
 * It NEVER approves anything. The strongest thing it can say is PASS, and a
 * promotion that passes every check still goes to a person.
 */
/** One line of a check report, exactly as the frontend renders it. */
export interface CheckRow {
  readonly k: string;
  readonly st: CheckState;
  readonly say: string;
}

/** PASS says nothing is wrong. It never says anything is approved. */
export type CheckState = "PASS" | "REVIEW" | "ACTION";

/** What a promotion carries into the content checks. */
export interface PromotionContent extends VisibilityFields {
  readonly subtitle?: string | null;
  readonly description?: string | null;
  readonly ctaDestination?: string | null;
  readonly terms?: string | null;
  readonly offer?: string | null;
  readonly type?: string | null;
  readonly destination?: string | null;
  readonly placement?: string | null;
  readonly audience?: string | null;
  readonly [key: string]: unknown;
}

export function contentCheck(p: PromotionContent) {
  const rows: CheckRow[] = [];
  const add = (k: string, st: CheckState, say: string) => rows.push({ k, st, say });
  const text = [p.headline, p.subtitle, p.description].filter(Boolean).join(" ");

  add("Headline",
    !p.headline ? "ACTION" : p.headline.length > 60 ? "REVIEW" : "PASS",
    !p.headline ? "A promotion needs a headline."
      : p.headline.length > 60 ? `Long for a card — ${p.headline.length} characters. It will wrap on a phone.`
      : "Clear and the right length.");

  add("Description",
    !p.description ? "ACTION" : p.description.length < 25 ? "REVIEW" : "PASS",
    !p.description ? "Say what the offer is."
      : p.description.length < 25 ? "Very short. A reader may not know what they are getting."
      : "Reads clearly.");

  add("Call to action",
    !p.ctaLabel || !p.ctaDestination ? "ACTION" : "PASS",
    !p.ctaLabel ? "The button needs words on it."
      : !p.ctaDestination ? "The button needs somewhere to go — a promotion that lands nowhere is worse than none."
      : "Labelled, and it goes somewhere.");

  const both = p.startDate && p.endDate;
  add("Offer dates",
    !both ? "ACTION" : new Date(p.endDate) < new Date(p.startDate) ? "ACTION" : "PASS",
    !both ? "Both a start and an end date. A promotion with no end runs forever."
      : new Date(p.endDate) < new Date(p.startDate) ? "The end date is before the start date."
      : `Runs ${day(p.startDate)} to ${day(p.endDate)}.`);

  const gaps = ["type", "destination", "placement", "audience"].filter((k) => !p[k]);
  add("Missing information", gaps.length ? "ACTION" : "PASS",
    gaps.length ? `Still to fill in: ${gaps.join(", ")}.` : "Everything a reviewer needs is here.");

  const gram: string[] = [];
  if (/\s{2,}/.test(text)) gram.push("double spaces");
  if (/[a-z]\.[A-Z]/.test(text)) gram.push("a missing space after a full stop");
  if (p.headline && p.headline === p.headline.toUpperCase() && p.headline.length > 12) {
    gram.push("the headline is in capitals");
  }
  if (p.description && !/[.!?]$/.test(String(p.description).trim())) {
    gram.push("the description does not end in a full stop");
  }
  add("Grammar", gram.length ? "REVIEW" : "PASS",
    gram.length ? `Worth a look: ${gram.join(", ")}.` : "Nothing obvious.");

  const offerBare = String(p.offer || "").replace(/%$/, "");
  const inconsistent = p.headline && p.description && p.offer &&
    !p.description.includes(offerBare) && !p.headline.includes(offerBare);
  add("Promotional consistency", inconsistent ? "REVIEW" : "PASS",
    "The headline, the description and the offer should say the same thing.");

  const loud = /!{2,}/.test(text) || /FREE!|BUY NOW/i.test(text);
  add("Brand alignment", loud ? "REVIEW" : "PASS",
    loud ? "Reads louder than PALTAS usually does." : "Reads like PALTAS.");

  add("Terms & conditions",
    !p.terms || p.terms.length < 20 ? "REVIEW" : "PASS",
    !p.terms ? "No terms. An offer with conditions needs them written down — if it has none, say so."
      : p.terms.length < 20 ? "Very short for terms." : "Present.");

  const found = UNSUPPORTED.filter((w) => text.toLowerCase().includes(w));
  add("Unsupported claims", found.length ? "ACTION" : "PASS",
    found.length
      ? `This claims: ${found.join(", ")}. PALTAS cannot verify it, so either remove it or be ready to evidence it to the reviewer.`
      : "Nothing PALTAS would be asked to stand behind.");

  return summarise(rows);
}

/** The seven creative checks, run on the file's PROPERTIES, not on a picture. */
/** An uploaded image's PROPERTIES. Nothing here looks at the picture. */
export interface CreativeMeta {
  readonly name?: string;
  readonly w: number;
  readonly h: number;
  readonly mb: number;
  readonly busy?: boolean;
}

export function creativeCheck(meta: CreativeMeta | null | undefined) {
  if (!meta) return { rows: [], worst: "ACTION", ready: false, none: true };
  const R = CREATIVE_RULES;
  const rows: CheckRow[] = [];
  const add = (k: string, ok: boolean, say: string) =>
    rows.push({ k, st: ok ? "PASS" : "ACTION", say });

  add("Image uploaded", true, meta.name || "Uploaded.");

  const bigEnough = meta.w >= R.minW && meta.h >= R.minH;
  add("Resolution", bigEnough,
    bigEnough ? `${meta.w} × ${meta.h} — enough for a large card.`
      : `Your image should be at least ${R.minW} × ${R.minH} px. This one is ${meta.w} × ${meta.h}.`);

  const ratio = meta.w / meta.h;
  const ratioOk = Math.abs(ratio - R.ratio) <= R.ratioTol;
  add("Aspect ratio", ratioOk,
    ratioOk ? "16:9, which is the shape of the card."
      : `The card is 16:9. Yours is about ${ratio.toFixed(2)}:1, so it will be cropped.`);

  const ext = (String(meta.name || "").split(".").pop() || "").toLowerCase();
  add("File type", R.types.includes(ext), R.types.includes(ext) ? ext.toUpperCase() : `Use ${R.types.join(", ")}.`);

  add("File size", meta.mb <= R.maxMB,
    meta.mb <= R.maxMB ? `${Number(meta.mb).toFixed(1)} MB`
      : `${Number(meta.mb).toFixed(1)} MB is over the ${R.maxMB} MB limit and will be slow on a phone.`);

  add("Mobile suitability", meta.w >= R.minWmobile,
    meta.w >= R.minWmobile ? "Sharp on a phone." : "Too small to look sharp on a phone.");

  rows.push({
    k: "Text readability", st: meta.busy ? "REVIEW" : "PASS",
    say: meta.busy
      ? "Detail across the lower half, where the headline sits. Check the words are readable on a phone."
      : "The lower half is calm enough for the headline to sit on.",
  });

  return summarise(rows);
}

function summarise(rows: readonly CheckRow[]) {
  const worst = rows.some((r) => r.st === "ACTION") ? "ACTION"
    : rows.some((r) => r.st === "REVIEW") ? "REVIEW" : "PASS";
  return { rows, worst, ready: !rows.some((r) => r.st === "ACTION") };
}

const day = (d: Date | string | number): string => new Date(d).toISOString().slice(0, 10);

/* ------------------------------------------------------ input handling */

/** How each writable field is read out of a request body. */
type FieldKind = "string" | "int" | "bool" | "date" | "json" | "tags";

const FIELDS: Readonly<Record<string, FieldKind>> = {
  title: "string", headline: "string", subtitle: "string", description: "string",
  type: "string", offer: "string", destination: "string",
  ctaLabel: "string", ctaDestination: "string", terms: "string",
  image: "string", placement: "string", audience: "string", language: "string",
  startDate: "date", endDate: "date", priority: "int",
  imageMeta: "json", aiDrafted: "bool",

  /* Market targeting. Optional, narrowing, and null when unset — see the
     schema comment for why null is not the same as an empty array. */
  countries: "tags", excludeCountries: "tags", regions: "tags",
  cities: "tags", currencies: "tags", languages: "tags",
  requiresPayment: "string", requiresService: "string", requiresProduct: "string",
};

const LIMITS: Readonly<Record<string, number>> = { headline: 120, subtitle: 160, description: 600, terms: 2000, title: 160, ctaLabel: 60 };

/*
 * ONLY THE FIELDS ON THIS LIST.
 *
 * Whatever else arrives in the body is dropped without comment. It is the
 * reason a request cannot set `status`, `orgId`, `ref` or `createdById`: they
 * are not writable fields, so there is no path to them, rather than a guard
 * somebody could forget to add to a new route.
 */
export function cleanPromotionInput(body: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [k, kind] of Object.entries(FIELDS)) {
    if (!(k in (body || {}))) continue;
    const v = (body as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;

    if (kind === "string") {
      const s = String(v).trim();
      if (LIMITS[k] && s.length > LIMITS[k]) {
        problems.push(`${k} is longer than ${LIMITS[k]} characters.`);
        continue;
      }
      out[k] = s;
    } else if (kind === "int") {
      const n = Number(v);
      if (!Number.isFinite(n)) { problems.push(`${k} must be a number.`); continue; }
      out[k] = Math.max(0, Math.min(100, Math.round(n)));
    } else if (kind === "bool") {
      out[k] = Boolean(v);
    } else if (kind === "date") {
      if (v === "") { out[k] = null; continue; }
      const d = new Date(v as string | number | Date);
      if (Number.isNaN(d.getTime())) { problems.push(`${k} is not a date.`); continue; }
      out[k] = d;
    } else if (kind === "json") {
      out[k] = v;
    } else if (kind === "tags") {
      /*
       * AN EMPTY LIST MEANS "NOT TARGETED", NOT "TARGETED AT NOTHING".
       *
       * Sent as a filter, an empty array matches no market and the promotion
       * disappears everywhere — a customer who cleared the field would watch
       * their approved, published promotion show up on no page at all and
       * have nothing on screen to explain it. So empty normalises to null,
       * which the carousel reads as "global".
       */
      const list = (Array.isArray(v) ? v : [v])
        .map(function (x: unknown) { return String(x).trim(); })
        .filter(Boolean)
        .slice(0, 40);
      out[k] = list.length ? list : null;
    }
  }

  if (out["startDate"] instanceof Date && out["endDate"] instanceof Date
      && out["endDate"] < out["startDate"]) {
    problems.push("The end date is before the start date.");
  }
  if (problems.length) throw badRequest(String(problems[0]), problems);
  return out;
}

/** The shape the frontend reads. Dates as YYYY-MM-DD, because that is what a
    date input and a string comparison both want. */
/** A promotion row with the relations the console's wire reads. */
export interface PromotionRow extends PromotionContent, Targetable {
  readonly id?: string;
  readonly ref?: string;
  readonly orgId?: string;
  readonly org?: { name?: string } | null;
  readonly image?: string | null;
  readonly imageMeta?: unknown;
  readonly language?: string | null;
  readonly priority?: number | null;
  readonly aiDrafted?: boolean | null;
  readonly createdBy?: { name?: string | null; email?: string | null } | null;
  readonly reviewedBy?: unknown;
  readonly createdAt?: Date | null;
  readonly updatedAt?: Date | null;
  readonly events?: readonly {
    at?: Date | null; byName?: string; what?: string; why?: string; status?: string;
  }[];
}

export function toWire(p: PromotionRow) {
  return {
    id: p.ref,
    recordId: p.id,
    organizationId: p.orgId,
    organization: p.org ? p.org.name : "",
    title: p.title, headline: p.headline, subtitle: p.subtitle, description: p.description,
    type: p.type, offer: p.offer,
    startDate: p.startDate ? day(p.startDate) : "",
    endDate: p.endDate ? day(p.endDate) : "",
    destination: p.destination, ctaLabel: p.ctaLabel, ctaDestination: p.ctaDestination,
    terms: p.terms, image: p.image, imageMeta: p.imageMeta || null,
    placement: p.placement, audience: p.audience, language: p.language,
    priority: p.priority,
    ...targeting(p),
    status: p.status,
    aiDrafted: p.aiDrafted,
    createdBy: p.createdBy ? (p.createdBy.name || p.createdBy.email) : "",
    reviewedBy: p.reviewedBy,
    createdAt: stamp(p.createdAt),
    updatedAt: stamp(p.updatedAt),
    reviewHistory: (p.events || []).map((e) => ({
      at: stamp(e.at), by: e.byName, what: e.what, why: e.why, status: e.status,
    })),
  };
}

/** The public feed carries less: a visitor has no business knowing who wrote
    it, who approved it, or what was said during review. */
export function toPublicWire(p: PromotionRow) {
  return {
    id: p.ref,
    organization: p.org ? p.org.name : "",
    type: p.type, offer: p.offer,
    headline: p.headline, subtitle: p.subtitle, description: p.description,
    image: p.image,
    ctaLabel: p.ctaLabel, ctaDestination: p.ctaDestination,
    destination: p.destination,
    placement: p.placement, language: p.language,
    priority: p.priority,

    /*
     * TARGETING SURVIVES THE INTAKE.
     *
     * The carousel narrows a campaign by market and reads these nine fields
     * off every promotion it is handed. A promotion carrying none of them is
     * global, which is the right default because most campaigns are.
     */
    ...targeting(p),

    /*
     * `audience` IS DELIBERATELY NOT HERE.
     *
     * The console's audience is a creator's preference from a fixed list —
     * "all", "travellers", "owners", "business", "returning". The carousel's
     * `audience` is a targeting filter matched against the viewer's own tags
     * (the homepage passes ["traveller"]).
     *
     * They are two different vocabularies wearing the same name. Sending the
     * first into the second would have every promotion narrowed by a tag no
     * viewer carries — so an approved, published promotion would appear on no
     * page at all, with nothing on screen to explain it. A promotion that is
     * global because it was not targeted is right; one that is invisible
     * because two fields shared a name is not.
     *
     * It stays in the private wire, where the console reads it. It comes back
     * here as a real targeting array once `promotionTargets()` in
     * market-config.js can be read and the two vocabularies reconciled.
     */

    startDate: p.startDate ? day(p.startDate) : "",
    endDate: p.endDate ? day(p.endDate) : "",
    status: p.status,
    terms: p.terms,
  };
}

/**
 * The nine targeting fields, in the shape the carousel reads them.
 *
 * A null stays null. The carousel treats null as "not targeted" and an empty
 * array as "targeted at nothing", and the difference between those two is a
 * promotion that runs everywhere and one that runs nowhere.
 */
/** The nine targeting columns, as they sit on a promotion row. */
interface Targetable {
  readonly countries?: readonly string[] | null;
  readonly excludeCountries?: readonly string[] | null;
  readonly regions?: readonly string[] | null;
  readonly cities?: readonly string[] | null;
  readonly currencies?: readonly string[] | null;
  readonly languages?: readonly string[] | null;
  readonly requiresPayment?: string | null;
  readonly requiresService?: string | null;
  readonly requiresProduct?: string | null;
}

function targeting(p: Targetable) {
  return {
    countries: p.countries && p.countries.length ? p.countries : null,
    excludeCountries: p.excludeCountries && p.excludeCountries.length ? p.excludeCountries : null,
    regions: p.regions && p.regions.length ? p.regions : null,
    cities: p.cities && p.cities.length ? p.cities : null,
    currencies: p.currencies && p.currencies.length ? p.currencies : null,
    languages: p.languages && p.languages.length ? p.languages : null,
    requiresPayment: p.requiresPayment || null,
    requiresService: p.requiresService || null,
    requiresProduct: p.requiresProduct || null,
  };
}

const stamp = (d: Date | string | null | undefined): string =>
  (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "");
