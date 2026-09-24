/* ====================================================================== *
 * WHERE A DECISION CAN GO NEXT.
 *
 * ONE COPY OF THE RULE, because two would be worse than none.
 *
 * The route enforces this table and the console draws its buttons from it.
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
export const DECISION_NEXT = {
  OPEN: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["IMPLEMENTED", "CLOSED"],
  REJECTED: ["CLOSED"],
  IMPLEMENTED: ["CLOSED"],
  CLOSED: [],
};

/** The moves still open to a decision in this state. Never undefined. */
export function nextFor(status) {
  return DECISION_NEXT[status] || [];
}
