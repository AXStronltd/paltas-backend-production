/* ====================================================================== *
 * OFFERINGS — WHO MAY MOVE ONE, AND WHERE IT MAY GO.
 *
 * Modelled on src/domain/rights.js and src/domain/promotions.js, which
 * already solve this exact problem for promotions: a customer writes, PALTAS
 * reviews, and the two are different people. Reusing that shape rather than
 * inventing a second one means there is one idea in this codebase about what
 * "submitted for review" means, not two that drift.
 *
 * ── THE RULE THIS FILE EXISTS FOR ───────────────────────────────────────
 *
 *     An offering cannot become LIVE without having been APPROVED, and it
 *     cannot be APPROVED without having been REVIEWED.
 *
 * That is enforced by the `from` lists below and nothing else — no handler
 * checks it separately, so there is one place to read and one place to get it
 * wrong. test/investments.test.js walks every path in this table and fails if
 * any route reaches LIVE without passing through APPROVED.
 *
 * ── WHY REJECTED AND CHANGES_REQUESTED EXIST ────────────────────────────
 *
 * They were not in the requested lifecycle. A review that can only say yes is
 * not a review, and a reviewer with no way to ask for a correction has to
 * either approve something wrong or refuse it outright. Both states are
 * returnable: `submit` accepts them, so a corrected offering re-enters the
 * queue rather than starting again.
 * ====================================================================== */

/*
 * WHO MAY DO WHAT.
 *
 * The customer side creates and submits. The PALTAS side queues, reviews,
 * approves and publishes. No customer role holds `approve`, which is the whole
 * point: a company cannot approve its own offering, any more than it can
 * publish its own promotion.
 */
/**
 * THE THIRTEEN THINGS SOMEBODY CAN DO TO AN OFFERING.
 *
 * Named as a union for the same reason PromotionAct is in rights.ts: the two
 * tables below are indexed by these, and a typo reads a missing key, returns
 * false, and tells somebody their role cannot do something it can.
 */
export type OfferingRight =
  /* the company raising the money */
  | "create" | "edit" | "submit" | "manageInvestors" | "distribute"
  | "manageDocuments" | "tokenise"
  /* PALTAS's own staff */
  | "queue" | "requestChanges" | "reject" | "approve"
  | "schedule" | "goLive" | "close";

/** What one role may do. Absent is the same as false, and says so. */
export type OfferingGrants = Readonly<Partial<Record<OfferingRight, boolean>>>;

/** Who is asking, as far as this module is concerned. */
export interface OfferingActor {
  readonly role?: string;
  readonly isPlatform?: boolean;
}

export const OFFERING_RIGHTS: Readonly<Record<string, OfferingGrants>> = {
  /* The company raising the money. */
  OWNER:    { create: true, edit: true, submit: true, manageInvestors: true,
              distribute: true, manageDocuments: true, tokenise: true },
  MANAGER:  { create: true, edit: true, submit: true, manageInvestors: true,
              distribute: true, manageDocuments: true, tokenise: true },
  GM:       { manageInvestors: true },
  FINANCE:  { edit: true, manageInvestors: true, distribute: true },

  /* PALTAS's own staff. Reviewing is not approving and approving is not
     going live, for the same reason those are three rights on a promotion. */
  MARKETING:  { queue: true, requestChanges: true },
  COMPLIANCE: { queue: true, requestChanges: true, reject: true, approve: true },
  PUBLISHER:  { queue: true, requestChanges: true, reject: true, approve: true,
                schedule: true, goLive: true, close: true },
};

/**
 * The rights an actor actually holds.
 *
 * Same conditional elevation as promotionRights(): the owner of PALTAS is the
 * publisher on PALTAS's platform, and the owner of a property group is not.
 * Being an owner of YOUR company grants nothing on OURS.
 */
export function offeringRights({ role, isPlatform }: OfferingActor): OfferingGrants {
  if (isPlatform && (role === "OWNER" || role === "MANAGER")) {
    return OFFERING_RIGHTS.PUBLISHER;
  }
  /* A platform COMPLIANCE or MARKETING role keeps its reviewing rights; a
     customer's own staff never gain them, because these keys only appear on
     the PALTAS-side rows. */
  return (role ? OFFERING_RIGHTS[role] : undefined) || {};
}

export const canOffering = (actor: OfferingActor, act: OfferingRight): boolean =>
  Boolean(offeringRights(actor)[act]);

/* ====================================================================== *
 * THE TEN STATES THAT WERE ASKED FOR, PLUS THE TWO A REVIEW NEEDS.
 * ====================================================================== */

/** The moves this table names. A typo is a compile error, not a silent no. */
export type OfferingAction =
  | "submit" | "claim" | "requestChanges" | "reject" | "approve" | "schedule"
  | "goLive" | "fund" | "close" | "distribute" | "complete";

/** One move: where it may start, where it lands, and what it costs to make. */
export interface OfferingTransition {
  readonly from: readonly string[];
  readonly to: string;
  readonly right: OfferingRight;
  /** A refusal with no reason is not something a company can act on. */
  readonly needsReason?: boolean;
}

export const OFFERING_TRANSITIONS: Readonly<Record<OfferingAction, OfferingTransition>> = {
  submit: {
    from: ["DRAFT", "CHANGES_REQUESTED", "REJECTED"],
    to: "SUBMITTED",
    right: "submit",
  },
  claim: {
    from: ["SUBMITTED"],
    to: "UNDER_REVIEW",
    right: "queue",
  },
  requestChanges: {
    from: ["SUBMITTED", "UNDER_REVIEW"],
    to: "CHANGES_REQUESTED",
    right: "requestChanges",
    needsReason: true,
  },
  reject: {
    from: ["SUBMITTED", "UNDER_REVIEW"],
    to: "REJECTED",
    right: "reject",
    needsReason: true,
  },
  /*
   * APPROVED comes only from UNDER_REVIEW.
   *
   * Not from SUBMITTED. Somebody has to have claimed it and looked at it, and
   * allowing SUBMITTED -> APPROVED would make the review step optional in
   * practice while still appearing in the diagram.
   */
  approve: {
    from: ["UNDER_REVIEW"],
    to: "APPROVED",
    right: "approve",
  },
  schedule: {
    from: ["APPROVED"],
    to: "SCHEDULED",
    right: "schedule",
  },
  /* The only two doors into LIVE, and both are behind APPROVED. */
  goLive: {
    from: ["APPROVED", "SCHEDULED"],
    to: "LIVE",
    right: "goLive",
  },
  /* Raised what it set out to raise. Not a decision — a consequence — so the
     service sets it when settled orders reach the target. */
  fund: {
    from: ["LIVE"],
    to: "FUNDED",
    right: "goLive",
  },
  close: {
    from: ["LIVE", "FUNDED"],
    to: "CLOSED",
    right: "close",
  },
  distribute: {
    from: ["FUNDED", "CLOSED"],
    to: "DISTRIBUTING",
    right: "distribute",
  },
  complete: {
    from: ["DISTRIBUTING", "CLOSED"],
    to: "COMPLETED",
    right: "distribute",
  },
};

/** States in which an offering is visible to investors. */
export const INVESTABLE_STATES: ReadonlySet<string> = new Set(["LIVE"]);

/** States in which the offering's own definition may still be edited. */
export const EDITABLE_STATES: ReadonlySet<string> =
  new Set(["DRAFT", "CHANGES_REQUESTED", "REJECTED"]);

/**
 * Why this actor may not make this move, or null if they may.
 *
 * Returns a sentence rather than throwing, so the route decides the status
 * code — the same contract as whyNot() in rights.js.
 */
export function offeringRefusal(
  actor: OfferingActor,
  action: string,
  offering: { status?: string } | null | undefined,
  { reason }: { reason?: unknown } = {},
): string | null {
  const rule = OFFERING_TRANSITIONS[action as OfferingAction];
  if (!rule) return `There is no action called "${action}".`;

  if (!canOffering(actor, rule.right)) {
    return `Your role cannot ${action.replace(/([A-Z])/g, " $1").toLowerCase()} an offering.`;
  }
  if (!offering) return "That offering does not exist, or this account cannot see it.";

  if (!rule.from.includes(String(offering.status))) {
    return `An offering that is ${label(offering.status)} cannot be ${pastTense(action)}. ` +
      `That is only possible from: ${rule.from.map(label).join(", ")}.`;
  }
  if (rule.needsReason && !String(reason || "").trim()) {
    return "Say why. A refusal with no reason is not something the company can act on.";
  }
  return null;
}

const label = (s: unknown): string => String(s).toLowerCase().replace(/_/g, " ");
const PAST_TENSE: Readonly<Record<string, string>> = {
  submit: "submitted", claim: "taken for review", requestChanges: "sent back",
  reject: "rejected", approve: "approved", schedule: "scheduled",
  goLive: "made live", fund: "marked funded", close: "closed",
  distribute: "moved to distributing", complete: "completed",
};
const pastTense = (a: string): string => PAST_TENSE[a] || a;

/* ====================================================================== *
 * WHAT AN OFFERING NEEDS BEFORE IT MAY BE SUBMITTED.
 *
 * Checked on submit rather than on save, so a half-finished draft is allowed
 * to be half-finished. Returns a LIST of what is missing, because telling
 * somebody one problem at a time when there are five is its own kind of rude.
 * ====================================================================== */

/** The parties every structure needs named, whatever the jurisdiction. */
export const REQUIRED_PARTIES: readonly string[] = ["PROPERTY_OWNER", "ISSUER"];

/** And the ones a tokenised offering needs on top. */
export const REQUIRED_TOKEN_PARTIES: readonly string[] = ["TOKENISATION_PROVIDER"];

/**
 * An offering as this check reads it.
 *
 * Money arrives as BigInt from Prisma and as a string or number from a form,
 * which is why the comparisons below accept both — that is existing behaviour
 * this migration preserved rather than tightened.
 */
export interface OfferingDraft {
  readonly title?: string | null;
  readonly targetRaise?: bigint | number | string | null;
  readonly tokenUnits?: number | null;
  readonly unitPrice?: bigint | number | string | null;
  readonly jurisdictions?: string | null;
  readonly distributionRule?: string | null;
  readonly status?: string;
  readonly eligibility?: string;
}

/** What else is on the file when submission is checked. */
export interface SubmissionContext {
  readonly parties?: readonly { role?: string }[];
  readonly documents?: readonly { role?: string }[];
  readonly issuer?: { status?: string; jurisdictions?: string | null } | null;
}

/**
 * Is this money amount above zero?
 *
 * Money reaches here as a BigInt from Prisma and as a string or a number from
 * a form. The original check was `x > 0n || Number(x) > 0`, which is the same
 * two branches written out here — the BigInt one exact, the other coerced.
 */
function positive(v: bigint | number | string | null | undefined): boolean {
  if (typeof v === "bigint") return v > 0n;
  return Number(v) > 0;
}

export function submissionGaps(
  offering: OfferingDraft,
  { parties = [], documents = [], issuer }: SubmissionContext = {},
): string[] {
  const gaps: string[] = [];

  if (!offering.title || !offering.title.trim()) gaps.push("a title");
  if (!positive(offering.targetRaise)) {
    gaps.push("a target raise above zero");
  }
  if (!offering.tokenUnits || offering.tokenUnits <= 0) gaps.push("the number of units offered");
  if (!positive(offering.unitPrice)) gaps.push("a price per unit");
  if (!offering.jurisdictions || !offering.jurisdictions.trim()) {
    gaps.push("at least one jurisdiction");
  }
  if (!offering.distributionRule || !offering.distributionRule.trim()) {
    gaps.push("how income will be distributed");
  }

  /*
   * UNITS x PRICE MUST EQUAL THE TARGET.
   *
   * Not a rounding check — a consistency one. An offering advertising 1,000
   * units at 10,000 while claiming to raise 20,000,000 is wrong by a factor of
   * two, and whichever number the investor reads, one of them is false.
   */
  const units = Number(offering.tokenUnits || 0);
  const price = Number(offering.unitPrice || 0);
  const target = Number(offering.targetRaise || 0);
  if (units > 0 && price > 0 && target > 0 && units * price !== target) {
    gaps.push(`a target raise that matches units x price (${units} x ${price} = ` +
      `${units * price}, not ${target})`);
  }

  const have = new Set(parties.map((p) => p.role));
  for (const role of REQUIRED_PARTIES) {
    if (!have.has(role)) gaps.push(`the ${label(role)} named`);
  }
  if ((offering.tokenUnits ?? 0) > 0) {
    for (const role of REQUIRED_TOKEN_PARTIES) {
      if (!have.has(role)) gaps.push(`the ${label(role)} named`);
    }
  }

  /* A prospectus or offering memorandum, by either name. */
  const docRoles = new Set(documents.map((d) => d.role));
  if (!docRoles.has("PROSPECTUS") && !docRoles.has("OFFERING_MEMORANDUM")) {
    gaps.push("an offering document (prospectus or memorandum)");
  }
  if (!docRoles.has("RISK_DISCLOSURE")) gaps.push("a risk disclosure");

  /*
   * AND THE COMPANY ITSELF HAS TO BE ALLOWED TO DO THIS.
   *
   * Checked here as well as at the route, because this is the function a
   * reviewer's screen calls to show what is outstanding — and "you are not an
   * approved issuer" is the most important thing on that list.
   */
  if (!issuer || issuer.status !== "APPROVED") {
    gaps.push("an approved issuer profile for this company");
  } else if (offering.jurisdictions) {
    const allowed = splitCodes(issuer.jurisdictions);
    const outside = splitCodes(offering.jurisdictions).filter((c) => !allowed.includes(c));
    if (allowed.length && outside.length) {
      gaps.push(`jurisdictions this company is not licensed for: ${outside.join(", ")}`);
    }
  }

  return gaps;
}

export const splitCodes = (s: unknown): string[] =>
  String(s || "").split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

/* ====================================================================== *
 * MAY THIS INVESTOR BE SOLD THIS OFFERING?
 *
 * Compliance gating. Every clause here is a reason to REFUSE, and the
 * function returns the reason rather than a boolean, because "no" without a
 * reason cannot be fixed by the person it was said to.
 * ====================================================================== */
/** An investor's compliance profile, as the gate reads it. */
export interface InvestorProfile {
  readonly kyc?: string;
  readonly aml?: string;
  readonly expiresAt?: Date | string | null;
  readonly blockedReason?: string | null;
  readonly jurisdiction?: string | null;
  readonly classifiedAs?: string;
}

export function eligibilityRefusal(
  offering: (OfferingDraft & { jurisdictions?: string | null }) | null | undefined,
  profile: InvestorProfile | null | undefined,
): string | null {
  if (!offering) return "That offering does not exist.";
  if (!INVESTABLE_STATES.has(String(offering.status))) {
    return `This offering is ${label(offering.status)} and is not open for investment.`;
  }
  if (!profile) return "This investor has no compliance profile yet.";

  if (profile.kyc !== "VERIFIED") {
    return `Identity checks are ${label(profile.kyc)}. An investment cannot be accepted until they are verified.`;
  }
  if (profile.aml === "BLOCKED") return "Screening has blocked this investor.";
  if (profile.aml !== "CLEAR") {
    return `Screening is ${label(profile.aml)}. An investment cannot be accepted until it is clear.`;
  }
  if (profile.expiresAt && new Date(profile.expiresAt) < new Date()) {
    return "This investor's checks have expired and must be renewed.";
  }
  if (profile.blockedReason && profile.blockedReason.trim()) {
    return profile.blockedReason;
  }

  /* Where they are, against where this may be offered. */
  const where = splitCodes(offering.jurisdictions);
  const theirs = String(profile.jurisdiction || "").trim().toUpperCase();
  if (where.length && theirs && !where.includes(theirs)) {
    return `This offering is not available in ${theirs}.`;
  }
  if (where.length && !theirs) {
    return "This investor's jurisdiction is not recorded, and this offering is limited by jurisdiction.";
  }

  /* And what they are classified as, against who may invest. */
  const need = offering.eligibility;
  const is = profile.classifiedAs;
  const RANK: Readonly<Record<string, number>> =
    { RETAIL_PERMITTED: 0, PROFESSIONAL_ONLY: 1, ACCREDITED_ONLY: 2 };
  if (need === "BY_INVITATION") {
    /* Invitation is a decision somebody records, not a property of the
       investor — so it is refused here and granted by an explicit order. */
    return "This offering is by invitation only.";
  }
  const wanted = RANK[String(need)];
  const held = RANK[String(is)];
  if (wanted !== undefined && held !== undefined && held < wanted) {
    return `This offering is for ${label(need)} investors.`;
  }
  return null;
}
