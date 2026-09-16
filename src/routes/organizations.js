/* ====================================================================== *
 * /organizations — a real company, created by the onboarding that exists.
 *
 * backend.md §1 asks for one endpoint that creates USER + ORGANIZATION +
 * SUBSCRIPTION + ENTITLEMENT + MEMBERSHIP + WORKSPACE "in one transaction, and
 * returns the session". The user already exists here because they signed in
 * with Google first; everything else is made together or not at all.
 *
 * ONE TRANSACTION IS NOT DECORATION. Half of this is a company with a
 * subscription and no entitlement: a customer who has paid and whose console
 * does not exist. There is no sensible way to recover from that automatically,
 * so it must not be reachable.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import { badRequest, conflict, forbidden, requireSession } from "../http/index.js";
import { notFound, rateLimit } from "../http/index.js";
import { config } from "../config.js";
import {
  INVITE_DAYS, cleanEmail, grantableBy, hashToken, inviteLink, newToken,
  stateOf, toWire, whyNotInvite,
} from "../domain/invitations.js";
import { sessionView } from "../domain/session-view.js";

export const organizationRoutes = Router();

const PRODUCTS = new Set([
  "PROPERTY_MANAGEMENT", "AGENT_HOST", "HOTEL_MANAGEMENT",
  "SECURITY_MANAGEMENT", "GUEST_PORTAL",
]);

/*
 * PLATFORM IS NOT ON THAT LIST, AND THAT IS THE POINT.
 *
 * PLATFORM is PALTAS's own staff console — it spans every customer company. If
 * signup could grant it, anyone with a Google account could create a company,
 * ask for PLATFORM, and be looking at the promotion queue for every business
 * on PALTAS thirty seconds later. It is granted by PALTAS, by hand, and there
 * is deliberately no endpoint that does it.
 */

/*
 * The six lines of work the business signup asks about, mapped to the product
 * each one actually needs. The question is what the company DOES; the product
 * is our answer, not theirs to pick from a list of internal names.
 */
const WORK_LINES = {
  develop: "PROPERTY_MANAGEMENT",   // I build or develop projects
  own_let: "PROPERTY_MANAGEMENT",   // I own units and let them long-term
  manage: "PROPERTY_MANAGEMENT",    // I manage buildings for other owners
  nightly: "AGENT_HOST",            // I let places by the night
  act_for: "AGENT_HOST",            // I sell or let for other people
  hotel: "HOTEL_MANAGEMENT",        // I run a hotel or serviced apartments
  security: "SECURITY_MANAGEMENT",  // I guard places, or I want mine guarded
};

/**
 * POST /organizations
 *
 * Body: { name, country?, city?, size?, work?[], products?[], plan?, planKey?, preferred? }
 */
organizationRoutes.post("/", requireSession(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || body.company || "").trim();
    if (!name) throw badRequest("A company needs a name.");
    if (name.length > 160) throw badRequest("That company name is too long.");

    const products = resolveProducts(body);
    if (!products.length) {
      throw badRequest(
        "Say what the company does. Send `work` with one or more of: " +
        Object.keys(WORK_LINES).join(", ") + "."
      );
    }

    /*
     * ONE COMPANY PER PERSON, ON THE WAY IN.
     *
     * Not a limit on how many they may belong to — they can be invited to any
     * number. It stops the accident: somebody presses the signup button twice
     * and ends up with two identical companies and no idea which one their
     * colleague was added to.
     */
    const existing = await db.membership.findFirst({
      where: { userId: req.session.userId },
      include: { org: true },
    });
    if (existing) {
      throw conflict(
        `This account already belongs to ${existing.org.name}. ` +
        `To run a second company, ask PALTAS — an account can hold several, but not by signing up twice.`
      );
    }

    const preferred = PRODUCTS.has(String(body.preferred)) ? String(body.preferred) : products[0];

    const org = await db.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name,
          country: String(body.country || "ke").toLowerCase().slice(0, 4),
          city: String(body.city || "").slice(0, 120),
          size: String(body.size || "").slice(0, 40),
          status: "ACTIVE",

          subscription: {
            create: {
              /* A new company is TRIALING, never ACTIVE. ACTIVE means somebody
                 paid, and marking an unpaid company ACTIVE is how a product
                 loses track of its own revenue. */
              status: "TRIALING",
              plan: String(body.plan || "").slice(0, 60),
              planKey: String(body.planKey || "").slice(0, 40),
              trialDays: 30,
              seats: 1,
              trialEnds: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          },

          /* NOT_STARTED, explicitly. It restricts publishing and payouts and
             opens every console — see domain/rights.js. */
          verification: { create: { status: "NOT_STARTED", documents: [] } },

          workspace: { create: { status: "ACTIVE", preferred } },

          entitlements: {
            create: products.map((product) => ({ product, status: "ACTIVE" })),
          },

          /* The person who creates the company owns it. */
          memberships: {
            create: {
              userId: req.session.userId,
              role: "OWNER",
              scope: { all: true },
            },
          },
        },
      });

      /* The session now acts for the company just created, rather than leaving
         the person signed in to nothing and wondering why the console is
         empty. */
      await tx.session.update({
        where: { id: req.session.id },
        data: { orgId: created.id },
      });

      return created;
    });

    const view = await sessionView({ ...req.session, orgId: org.id });
    res.status(201).json(view);
  } catch (e) { next(e); }
});

/**
 * What the company said it does, turned into products.
 *
 * `work` is the six-line question the signup actually asks. `products` is
 * accepted too, for a caller that already knows — but PLATFORM is refused
 * loudly rather than silently dropped, so a mistake in an integration is
 * visible instead of mysterious.
 */
function resolveProducts(body) {
  const out = new Set();

  for (const line of toArray(body.work)) {
    const p = WORK_LINES[String(line).trim()];
    if (p) out.add(p);
  }

  for (const raw of toArray(body.products)) {
    const p = String(raw).trim().toUpperCase();
    if (p === "PLATFORM") {
      throw forbidden(
        "PLATFORM is PALTAS's own staff console. It is granted by PALTAS and cannot be requested at signup."
      );
    }
    if (PRODUCTS.has(p)) out.add(p);
  }

  return [...out];
}

const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** GET /organizations/me — the current company, for a page that needs only that. */
organizationRoutes.get("/me", requireSession(), async (req, res, next) => {
  try {
    const view = await sessionView(req.session);
    if (!view.organization) {
      return res.status(404).json({
        error: "no_organization",
        message: "This account is not part of a company yet.",
      });
    }
    res.json({
      organization: view.organization,
      subscription: view.subscription,
      entitlements: view.entitlements,
      verification: view.verification,
      workspace: view.workspace,
    });
  } catch (e) { next(e); }
});

/* ====================================================================== *
 * INVITATIONS — how a second person joins a company.
 *
 * Until this existed the only Membership ever written was the founder's, so
 * every customer was capped at one user and eighteen of the nineteen roles
 * could not be given to anybody.
 *
 * DELIVERY IS A LINK, NOT AN EMAIL. There is no mail provider in this service,
 * and a "send invitation" button that silently sends nothing is worse than no
 * button. The endpoint returns a link; the person who pressed it sends it
 * however they already talk to their colleague. When a mail provider exists,
 * only the delivery step changes — the invitation, the token and the accept
 * are already right.
 * ====================================================================== */

/** The caller's membership in THIS company, or null. Never from the body. */
async function membershipIn(userId, orgId) {
  return db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    include: { org: { select: { id: true, name: true } } },
  });
}

/**
 * POST /organizations/:id/invitations
 *
 * Returns the link ONCE. The token is stored only as a SHA-256, so this
 * response is the single moment the plaintext exists — an owner who loses it
 * revokes the invitation and sends another.
 */
organizationRoutes.post("/:id/invitations",
  requireSession(),
  rateLimit({ windowMs: 60_000, max: 30 }),
  async (req, res, next) => {
    try {
      const orgId = String(req.params.id);
      const mine = await membershipIn(req.session.userId, orgId);
      /*
       * NOT FOUND rather than FORBIDDEN for a company that is not yours: a
       * different answer for "exists but is not yours" is a way to discover
       * which company ids are real.
       */
      if (!mine) throw notFound("No company with that id.");

      const role = String(req.body?.role || "").trim().toUpperCase();
      const no = whyNotInvite(mine.role, role);
      if (no) throw forbidden(no);

      const email = cleanEmail(req.body?.email);
      if (!email) throw badRequest("That is not an email address.");

      /* Already in the company: an invitation would either do nothing or, if
         it were allowed to overwrite, quietly change somebody's role without
         anyone deciding to. Role changes are their own act, not a side effect
         of an invitation. */
      const existing = await db.user.findUnique({
        where: { email },
        select: { id: true, memberships: { where: { orgId }, select: { id: true } } },
      });
      if (existing?.memberships?.length) {
        throw conflict(`${email} is already in ${mine.org.name}.`);
      }

      /* One live invitation per address per company. Sending a second replaces
         the first, so a forgotten link cannot still be accepted later. */
      await db.invitation.updateMany({
        where: { orgId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const token = newToken();
      const invite = await db.invitation.create({
        data: {
          orgId, email, role,
          scope: req.body?.scope && typeof req.body.scope === "object"
            ? req.body.scope : { all: true },
          tokenHash: hashToken(token),
          invitedById: req.session.userId,
          expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        },
        include: { invitedBy: { select: { name: true, email: true } } },
      });

      res.setHeader("Cache-Control", "no-store, private");
      res.status(201).json({
        invitation: toWire(invite),
        /* Said out loud, because the caller has to act on it. */
        link: inviteLink(config.appUrl, token),
        note:
          `Send this link to ${email}. It works once, expires in ${INVITE_DAYS} days, ` +
          "and only that address can accept it. PALTAS does not send it for you.",
      });
    } catch (e) { next(e); }
  });

/** GET /organizations/:id/invitations — what is outstanding. Never a token. */
organizationRoutes.get("/:id/invitations", requireSession(), async (req, res, next) => {
  try {
    const orgId = String(req.params.id);
    const mine = await membershipIn(req.session.userId, orgId);
    if (!mine) throw notFound("No company with that id.");
    if (!grantableBy(mine.role).length) {
      throw forbidden("Only an owner or a manager can see who has been invited.");
    }

    const rows = await db.invitation.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { invitedBy: { select: { name: true, email: true } } },
    });

    res.setHeader("Cache-Control", "no-store, private");
    res.json({ invitations: rows.map((r) => toWire(r)) });
  } catch (e) { next(e); }
});

/** POST /organizations/:id/invitations/:inviteId/revoke — withdraw a link. */
organizationRoutes.post("/:id/invitations/:inviteId/revoke",
  requireSession(), async (req, res, next) => {
    try {
      const orgId = String(req.params.id);
      const mine = await membershipIn(req.session.userId, orgId);
      if (!mine) throw notFound("No company with that id.");
      if (!grantableBy(mine.role).length) {
        throw forbidden("Only an owner or a manager can withdraw an invitation.");
      }

      const invite = await db.invitation.findFirst({
        where: { id: String(req.params.inviteId), orgId },
      });
      if (!invite) throw notFound("No invitation with that id.");
      if (invite.acceptedAt) {
        throw conflict(
          "That invitation has already been accepted. Remove the person from the " +
          "company instead — withdrawing the link does not take their access away.");
      }

      const row = await db.invitation.update({
        where: { id: invite.id },
        data: { revokedAt: invite.revokedAt || new Date() },
        include: { invitedBy: { select: { name: true, email: true } } },
      });
      res.json({ invitation: toWire(row) });
    } catch (e) { next(e); }
  });
