/* ====================================================================== *
 * FINDING AN INVITATION BY ITS LINK.
 *
 * This sits beside sessions.js rather than in routes/ because it is the same
 * kind of thing: a lookup whose key IS the credential.
 *
 * Every query in routes/ is filtered by req.actor.orgId, and tenancy.test.js
 * enforces that with no exceptions worth making. This lookup cannot satisfy
 * it, and not for want of trying — the person accepting an invitation has no
 * membership yet and does not know which company invited them. Which company
 * it is, is precisely what the link tells them. There is no orgId to scope by
 * until this lookup resolves one.
 *
 * Its safety is the key, exactly as a session's is. `tokenHash` is the
 * SHA-256 of 32 random bytes and is unique, so a row is reachable only by
 * already holding the link for it. A wrong token matches nothing; there is no
 * partial match, no enumeration, and no query shape that returns a row the
 * caller did not already have the secret for.
 *
 * db.session.findUnique({ where: { tokenHash } }) two files over is the same
 * statement for the same reason. Putting this next to it keeps the rule in
 * routes/ unconditional instead of teaching it an exception.
 * ====================================================================== */

import { db } from "../db.ts";
import { hashToken } from "../domain/invitations.js";

/**
 * The invitation this link names, or null.
 *
 * Returns null rather than throwing for anything that cannot be a token, so a
 * swept URL and a mistyped one are indistinguishable from the outside.
 */
export async function findByToken(token: unknown) {
  if (!token) return null;
  const raw = String(token);
  /* 32 random bytes base64url is 43 characters. Anything shorter was never
     issued here, so it is not worth a database round trip. */
  if (raw.length < 16 || raw.length > 400) return null;

  return db.invitation.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: {
      org: { select: { id: true, name: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
}
