/* ====================================================================== *
 * ACCEPTING AN INVITATION.
 *
 * Separate from /organizations because the person using these endpoints is,
 * by definition, not in the company yet — every guard over there starts by
 * asking which of the caller's companies this is, and the answer here is none
 * of them.
 *
 * THE TOKEN IS THE ONLY THING THAT PROVES ANYTHING. It is looked up by hash,
 * so a database copy does not hand anybody a working link, and it is spent on
 * first use.
 *
 * ACCEPTING IS BOUND TO THE EMAIL. A link is the kind of thing that gets
 * forwarded — into a family WhatsApp group, onto a shared laptop — and a link
 * that anybody signed in could redeem is a stranger inside somebody's company
 * with a real role. So the signed-in address must be the one invited, and the
 * refusal says which address is expected.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import {
  badRequest, conflict, forbidden, notFound, rateLimit, requireSession,
} from "../http/index.js";
import { stateOf } from "../domain/invitations.js";
/* The token lookup lives in auth/ beside the session's, because its key IS
   the credential — see the header of that file. */
import { findByToken } from "../auth/invitations.js";

export const invitationRoutes = Router();

/** Why this invitation cannot be taken up — a sentence, or null. */
function whyNotAcceptable(invite) {
  switch (stateOf(invite)) {
    case "ACCEPTED": return "That invitation has already been used.";
    case "REVOKED":  return "That invitation was withdrawn by the company.";
    case "EXPIRED":  return "That invitation has expired. Ask for a new link.";
    default:         return null;
  }
}


/**
 * GET /invitations/:token — what this link is for.
 *
 * NO SESSION REQUIRED, on purpose: somebody following a link has usually not
 * signed in yet, and a page that demands a sign-in before saying what it is
 * asking them to sign in FOR is how an invitation gets ignored.
 *
 * Holding the token is the proof. Nothing here is reachable without it, and it
 * is rate limited so the space cannot be swept.
 */
invitationRoutes.get("/:token",
  rateLimit({ windowMs: 60_000, max: 60 }),
  async (req, res, next) => {
    try {
      const invite = await findByToken(req.params.token);
      if (!invite) throw notFound("That invitation link is not valid.");

      res.setHeader("Cache-Control", "no-store, private");
      res.json({
        company: invite.org.name,
        role: invite.role,
        /* The address that must be signed in. Shown because the person has to
           know WHICH of their accounts to use, and they already hold the link
           that carries it. */
        email: invite.email,
        invitedBy: invite.invitedBy?.name || invite.invitedBy?.email || "",
        state: stateOf(invite),
        expiresAt: invite.expiresAt,
        why: whyNotAcceptable(invite),
      });
    } catch (e) { next(e); }
  });

/**
 * POST /invitations/:token/accept — join the company.
 *
 * Requires a session, because this writes a Membership and a Membership has to
 * belong to somebody real. The person signs in with Google first; the link
 * survives that round trip in the URL.
 */
invitationRoutes.post("/:token/accept",
  requireSession(),
  rateLimit({ windowMs: 60_000, max: 30 }),
  async (req, res, next) => {
    try {
      const invite = await findByToken(req.params.token);
      if (!invite) throw notFound("That invitation link is not valid.");

      const no = whyNotAcceptable(invite);
      if (no) throw conflict(no);

      const me = await db.user.findUnique({
        where: { id: req.session.userId },
        select: { id: true, email: true },
      });
      if (!me) throw badRequest("That account no longer exists.");

      if (String(me.email).toLowerCase() !== invite.email) {
        /*
         * The whole point of binding to an address. Names the expected one so
         * the person can switch account — it is already in the link they are
         * holding, so saying it here reveals nothing they do not have.
         */
        throw forbidden(
          `This invitation was sent to ${invite.email}. You are signed in as ` +
          `${me.email}. Sign in with ${invite.email} to accept it.`);
      }

      const already = await db.membership.findUnique({
        where: { userId_orgId: { userId: me.id, orgId: invite.orgId } },
      });
      if (already) {
        /* Spend the link anyway: it has done its job and must not stay live. */
        await db.invitation.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date(), acceptedById: me.id },
        });
        throw conflict(`You are already in ${invite.org.name}.`);
      }

      /*
       * ONE TRANSACTION. A membership written without the invitation being
       * spent is a link that can be used again; an invitation spent without
       * the membership is a person locked out with no way back in.
       */
      const membership = await db.$transaction(async (tx) => {
        const m = await tx.membership.create({
          data: {
            userId: me.id,
            orgId: invite.orgId,
            role: invite.role,
            scope: invite.scope ?? { all: true },
          },
        });
        await tx.invitation.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date(), acceptedById: me.id },
        });
        await tx.auditEvent.create({
          data: {
            orgId: invite.orgId,
            actorId: me.id,
            actorName: me.email,
            action: "membership.accepted",
            entity: "membership",
            entityId: m.id,
            detail: { role: invite.role, invitationId: invite.id },
            ip: req.ip || "",
          },
        }).catch(() => { /* the log is a record, not a control */ });
        return m;
      });

      res.setHeader("Cache-Control", "no-store, private");
      res.status(201).json({
        joined: { id: invite.org.id, name: invite.org.name },
        role: membership.role,
        note: `You are now in ${invite.org.name} as ${invite.role}.`,
      });
    } catch (e) { next(e); }
  });
