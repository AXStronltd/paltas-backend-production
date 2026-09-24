/* ====================================================================== *
 * WHERE A RECORD CAN GO NEXT.
 *
 * ONE COPY OF THE RULE, because two would be worse than none.
 *
 * Three registers keep a move table here, for one reason each time: the
 * route enforces it and the console draws its buttons from it.
 * When those were the same file the console could not read it, and when they
 * were two files they would agree until the first time somebody changed one —
 * and the drift shows up as a person pressing Approve on a decision the server
 * has no intention of approving. So the table lives here, the route imports it
 * to refuse with, and the `decisions` resource sends it out beside each row.
 * ====================================================================== */

/**
 * A register only moves forwards.
 *
 * Reopening an approved decision as OPEN would let a record be rewritten into
 * a different record; a changed mind is a NEW decision that supersedes the old
 * one, and both stay.
 */
export const DECISION_NEXT: Readonly<Record<string, readonly string[]>> = {
  OPEN: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["IMPLEMENTED", "CLOSED"],
  REJECTED: ["CLOSED"],
  IMPLEMENTED: ["CLOSED"],
  CLOSED: [],
};

/** The moves still open to a decision in this state. Never undefined. */
export function nextFor(status: string): readonly string[] {
  return DECISION_NEXT[status] ?? [];
}


/* ====================================================================== *
 * WHERE A LAND DEAL CAN GO NEXT.
 *
 * Same arrangement as the decision register above, and here for the same
 * reason: routes/predevelopment.js refuses anything not in this table, and
 * the `acquisitions` resource sends the allowed moves out beside each row so
 * the console draws exactly those buttons and no others.
 * ====================================================================== */
export const ACQUISITION_NEXT: Readonly<Record<string, readonly string[]>> = {
  IDENTIFIED: ["APPRAISING", "OFFERED", "ABANDONED"],
  APPRAISING: ["OFFERED", "ABANDONED"],
  OFFERED: ["UNDER_NEGOTIATION", "AGREED", "ABANDONED"],
  UNDER_NEGOTIATION: ["AGREED", "ABANDONED"],
  AGREED: ["DUE_DILIGENCE", "COMPLETED", "ABANDONED"],
  DUE_DILIGENCE: ["COMPLETED", "ABANDONED"],
  /* Both terminal. A deal that comes back is a new deal, so that the one that
     died keeps its reason. */
  COMPLETED: [],
  ABANDONED: [],
};

/* ====================================================================== *
 * WHERE A PERMIT CAN GO NEXT.
 *
 * EXPIRED is reachable only from APPROVED, and is never typed — a consent
 * that lapsed is expired whatever the column says, which the resource works
 * out on the way out. It is in the table so that the one legitimate write of
 * it has a path.
 * ====================================================================== */
export const PERMIT_NEXT: Readonly<Record<string, readonly string[]>> = {
  NOT_STARTED: ["PREPARING", "WITHDRAWN"],
  PREPARING: ["SUBMITTED", "WITHDRAWN"],
  SUBMITTED: ["UNDER_REVIEW", "APPROVED", "REFUSED", "WITHDRAWN"],
  UNDER_REVIEW: ["APPROVED", "REFUSED", "WITHDRAWN"],
  APPROVED: ["EXPIRED"],
  /* A refused or withdrawn application does not quietly come back; a fresh
     application is a new permit, so the refusal keeps its reason. */
  REFUSED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};
