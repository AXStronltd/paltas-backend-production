/* ====================================================================== *
 * WHO MAY DO WHAT — THE SERVER'S COPY, AND THE ONE THAT COUNTS.
 *
 * The frontend has a table shaped like this one. That table decides which
 * BUTTONS a person is offered, and it is a courtesy: anybody can open the
 * developer tools and press a button they were not offered. This file decides
 * what actually happens, and it never trusts anything the browser said about
 * who the caller is.
 *
 * The rule this whole file exists to enforce is one sentence:
 *
 *     A customer writes. PALTAS Marketing reviews. Only a PALTAS publisher
 *     publishes.
 *
 * Three roles, three different people, and no role is a superset of the one
 * before it. Marketing approving something is not publishing it.
 * ====================================================================== */

/* --------------------------------------------------------- entitlements */

/*
 * WHICH SUBSCRIPTION STATES OPEN A CONSOLE.
 *
 * PAST_DUE is deliberately open. A late invoice is a conversation, not a
 * lockout, and taking away a hotel's front desk over one is how a supplier
 * turns a slow payer into a former customer. The wall is CANCELED and EXPIRED
 * — and even then nothing is deleted.
 */
const OPEN_SUBSCRIPTIONS = new Set(["TRIALING", "ACTIVE", "PAST_DUE"]);

export const subscriptionOpens = (status) => OPEN_SUBSCRIPTIONS.has(String(status));

/*
 * WHAT VERIFICATION RESTRICTS.
 *
 * It restricts `publish` and `payout`. It does NOT close a console, it does
 * not hide a screen, and it does not stop somebody running their business.
 * An unverified company can do all of its own work; what it cannot do is put
 * something in front of the public or move money out.
 */
const VERIFICATION_RESTRICTS = {
  NOT_STARTED: ["publish", "payout"],
  PENDING: ["payout"],
  ADDITIONAL_INFORMATION_REQUIRED: ["publish", "payout"],
  REJECTED: ["publish", "payout"],
  COMPLETE: [],
};

export function verificationRestricts(status, act) {
  return (VERIFICATION_RESTRICTS[String(status)] || VERIFICATION_RESTRICTS.NOT_STARTED)
    .includes(act);
}

/* ---------------------------------------------------------- promotions */

/*
 * The promotion rights table. `create`/`editOwn`/`editOrg`/`submit` are the
 * customer side; `queue`/`requestChanges`/`approveMarketing` are PALTAS
 * Marketing; `publish`/`schedule`/`pause`/`approveFinal` are the publisher.
 *
 * COMPLIANCE is the interesting row: it can read every queue and send
 * anything back, and it can approve NOTHING. That is the point of having it.
 */
export const PROMOTION_RIGHTS = {
  PROMO_CONTRIBUTOR: { create: true, editOwn: true, submit: true },
  OWNER: { create: true, editOwn: true, editOrg: true, submit: true },
  MANAGER: { create: true, editOwn: true, editOrg: true, submit: true },
  GM: { create: true, editOwn: true, editOrg: true, submit: true },
  LEASING: { create: true, editOwn: true, editOrg: true, submit: true },
  HOST: { create: true, editOwn: true, submit: true },

  MARKETING: { queue: true, requestChanges: true, approveMarketing: true },
  COMPLIANCE: { queue: true, requestChanges: true, flag: true },
  PUBLISHER: {
    queue: true, finalQueue: true, requestChanges: true,
    approveFinal: true, publish: true, schedule: true, pause: true,
  },
};

/*
 * THE ONE SPECIAL CASE, WRITTEN DOWN RATHER THAN LEFT IMPLICIT.
 *
 * The owner of PALTAS itself is the publisher on PALTAS's own platform. An
 * owner of a hotel group is not — being an owner of YOUR company grants
 * nothing on OURS, which is exactly the wall the whole product sells. So the
 * elevation is conditional on the membership being in a PLATFORM-entitled
 * organization, and is never inferred from the role alone.
 */
export function promotionRights({ role, isPlatform }) {
  if (isPlatform && (role === "OWNER" || role === "MANAGER")) {
    return PROMOTION_RIGHTS.PUBLISHER;
  }
  return PROMOTION_RIGHTS[role] || {};
}

export function can(actor, act) {
  return Boolean(promotionRights(actor)[act]);
}

/**
 * The one function every promotion route calls before it does anything.
 * Throws nothing — it returns a reason, so the caller decides the status code
 * and the sentence the person reads.
 */
export function whyNot(actor, act) {
  if (!actor) return "You are not signed in.";
  if (!subscriptionOpens(actor.subscriptionStatus)) {
    return "This company's subscription is " + String(actor.subscriptionStatus).toLowerCase() +
      ". Renew it and everything is exactly where it was — nothing has been deleted.";
  }
  if (!can(actor, act)) {
    return "The role “" + actor.role + "” cannot do that. " + whoCan(act);
  }
  /* Verification is checked LAST and only for the two acts it governs, so an
     unverified company gets a message about verification rather than a vaguer
     one about permissions. */
  if ((act === "publish" || act === "schedule") &&
      verificationRestricts(actor.verificationStatus, "publish")) {
    return "This company is not verified yet, and publishing is one of the two things " +
      "verification governs. Everything else stays open.";
  }
  return null;
}

function whoCan(act) {
  if (act === "publish" || act === "schedule" || act === "pause" || act === "approveFinal") {
    return "Publishing belongs to a PALTAS publisher.";
  }
  if (act === "approveMarketing") return "Approving belongs to PALTAS Marketing.";
  if (act === "queue" || act === "finalQueue") return "The review queue belongs to PALTAS staff.";
  return "Ask whoever administers your account.";
}
