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
import { db } from "../db.ts";
import type { $Enums } from "@prisma/client";
import { enumParam, messageOf } from "../http/errors.ts";
import { sessionOf, param } from "../http/request.ts";import { badRequest, conflict, forbidden, requireSession } from "../http/index.ts";
import { notFound, rateLimit } from "../http/index.ts";
import { config } from "../config.ts";
import {
  INVITE_DAYS, cleanEmail, grantableBy, hashToken, inviteLink, newToken,
  stateOf, toWire, whyNotInvite,
} from "../domain/invitations.ts";
import { sessionView } from "../domain/session-view.ts";
import { seedChartOfAccounts } from "../domain/ledger.ts";
import { runMigration } from "../domain/migration.ts";
import { actorOf } from "../http/request.ts";
import { levelFor, whyNotArea } from "../domain/access.ts";
import { requireOrganization } from "../http/session.ts";
import type { Request } from "express";

export const organizationRoutes = Router();

const PRODUCTS: ReadonlySet<string> = new Set([
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
const WORK_LINES: Readonly<Record<string, $Enums.Product>> = {
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
      where: { userId: sessionOf(req, "an organizations route").userId },
      include: { org: true },
    });
    if (existing) {
      throw conflict(
        `This account already belongs to ${existing.org.name}. ` +
        `To run a second company, ask PALTAS — an account can hold several, but not by signing up twice.`
      );
    }

    /*
     * Through the same resolver. It used to accept only the exact key, so the
     * form's "property" was dropped and the preference fell back to whatever
     * happened to be first — which decides the console that opens at the end
     * of signup.
     */
    let preferred;
    try { preferred = asProduct(body.preferred); } catch (e) { preferred = null; }
    if (!preferred || !products.includes(preferred)) preferred = products[0];

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
            create: products.map((product) => ({ product, status: "ACTIVE" as const })),
          },

          /* The person who creates the company owns it. */
          memberships: {
            create: {
              userId: sessionOf(req, "an organizations route").userId,
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
        where: { id: sessionOf(req, "an organizations route").id },
        data: { orgId: created.id },
      });

      return created;
    });

    /*
     * AND IT STARTS WITH BOOKS.
     *
     * A new company gets the standard property chart of accounts — bank, rent
     * receivable, tenant deposits, maintenance and the rest — so that from its
     * first invoice, every business event posts a journal entry and the books
     * are an account of the business rather than something to set up later.
     *
     * Without this the chart was a button somebody had to find. Nobody found
     * it: every company in production has no chart, so nothing they do reaches
     * the ledger and domain/posting.js skips every posting with a reason.
     *
     * ── WHY IT IS OUTSIDE THE TRANSACTION ABOVE ────────────────────────
     *
     * Signing up must not fail for a reason that has nothing to do with
     * signing up. The chart is an accounting convenience, not part of what
     * makes a company a company — and a company without one is exactly the
     * state every existing company is already in, which the whole service
     * handles: postings are skipped and say why, and the chart can be seeded
     * afterwards from the console.
     *
     * So a failure here costs a click later. Inside the transaction it would
     * cost the customer their signup, which is the one flow in this product
     * that must never be traded against anything.
     *
     * It is idempotent, so a retry cannot produce a second chart.
     */
    let chart = 0;
    try {
      chart = (await seedChartOfAccounts(db, org.id)).length;
    } catch (e) {
      /* Loud in the log, invisible to the person signing up. */
      console.error("chart of accounts not seeded for", org.id, messageOf(e));
    }

    const view = await sessionView({
      ...sessionOf(req, "POST /organizations"), orgId: org.id,
    });
    res.status(201).json({ ...view, chartOfAccounts: chart });
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
/*
 * THE SHORT NAME A PRODUCT HAS ALWAYS HAD.
 *
 * The signup form asks which product the company is buying and sends the
 * answer as the product's short name — "property", "agent", "hotel",
 * "security". Those are the same names the consoles, the workspace gate and
 * every old session link have used throughout.
 *
 * WORK_LINES above answers a different and finer question — what the company
 * actually does, where three different answers all lead to PROPERTY_MANAGEMENT
 * — and it does not contain the product names. Two of the four coincided
 * ("hotel", "security") and appeared to work; the other two did not, so
 * choosing Property Management or Agent & Host produced "Say what the company
 * does" and the company was never created. Only the two that happened to
 * collide got through, which is why it read as working.
 *
 * Accepted here rather than only fixed in the form, because a browser holding
 * a cached copy of the old script would otherwise keep failing after the fix
 * shipped — and the person hitting that is a customer halfway through signing
 * up.
 *
 * GUEST_PORTAL and PLATFORM are deliberately absent: one is never sold, and
 * the other is PALTAS's own staff console, refused explicitly below.
 */
const PRODUCT_NAMES: Readonly<Record<string, $Enums.Product>> = {
  property: "PROPERTY_MANAGEMENT",
  agent: "AGENT_HOST",
  host: "AGENT_HOST",
  hotel: "HOTEL_MANAGEMENT",
  security: "SECURITY_MANAGEMENT",
};

/** A product, however it was named: key, short name, or work line. */
function asProduct(raw: unknown): $Enums.Product | null {
  const v = String(raw || "").trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (upper === "PLATFORM") {
    throw forbidden(
      "PLATFORM is PALTAS's own staff console. It is granted by PALTAS and cannot be requested at signup."
    );
  }
  if (PRODUCTS.has(upper)) return upper as $Enums.Product;
  const lower = v.toLowerCase();
  return WORK_LINES[lower] || PRODUCT_NAMES[lower] || null;
}

export function resolveProducts(body: Record<string, unknown>): $Enums.Product[] {
  const out = new Set<$Enums.Product>();
  for (const raw of [...toArray(body["work"]), ...toArray(body["products"])]) {
    const p = asProduct(raw);
    if (p) out.add(p);
  }
  return [...out];
}

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);

/** GET /organizations/me — the current company, for a page that needs only that. */
organizationRoutes.get("/me", requireSession(), async (req, res, next) => {
  try {
    const view = await sessionView(sessionOf(req, "GET /organizations/me"));
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
async function membershipIn(userId: string, orgId: string) {
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
      const orgId = String(param(req, "id"));
      const mine = await membershipIn(sessionOf(req, "an organizations route").userId, orgId);
      /*
       * NOT FOUND rather than FORBIDDEN for a company that is not yours: a
       * different answer for "exists but is not yours" is a way to discover
       * which company ids are real.
       */
      if (!mine) throw notFound("No company with that id.");

      /*
       * CHECKED AGAINST THE SCHEMA'S OWN ROLES.
       *
       * whyNotInvite() already refuses a role this person may not grant, but
       * it answers about roles it knows — an unrecognised string fell past it
       * and reached Prisma as an enum value, which is a 500. It is the
       * caller's mistake and is now said as one.
       */
      const role = enumParam("Role", req.body?.role, "role");
      if (!role) throw badRequest("Which role? Send `role`.");
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
          invitedById: sessionOf(req, "an organizations route").userId,
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
    const orgId = String(param(req, "id"));
    const mine = await membershipIn(sessionOf(req, "an organizations route").userId, orgId);
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
      const orgId = String(param(req, "id"));
      const mine = await membershipIn(sessionOf(req, "an organizations route").userId, orgId);
      if (!mine) throw notFound("No company with that id.");
      if (!grantableBy(mine.role).length) {
        throw forbidden("Only an owner or a manager can withdraw an invitation.");
      }

      const invite = await db.invitation.findFirst({
        where: { id: String(param(req, "inviteId")), orgId },
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

/* ====================================================================== *
 * MIGRATION — bringing a client's existing records in.
 *
 * On the organizations router because it is an act of setting the company
 * up, not of running it: it is done once, by somebody senior, on day one.
 * See domain/migration.ts for the four rules it keeps.
 * ====================================================================== */

/** Rows as a request sends them, checked before the domain sees them. */
function rowsFrom(body: unknown): { kind: string; [k: string]: unknown }[] {
  const b = (body || {}) as Record<string, unknown>;
  const raw = b["rows"];
  if (!Array.isArray(raw)) {
    throw badRequest("Send `rows`: one object per line of the file, each with a `kind`.");
  }
  return raw.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw badRequest(`Row ${i + 1} is not an object.`);
    }
    const row = r as Record<string, unknown>;
    if (!row["kind"]) {
      throw badRequest(`Row ${i + 1} does not say what it is. Use kind: unit, tenant or lease.`);
    }
    return row as { kind: string; [k: string]: unknown };
  });
}

function mayMigrate(req: Request): void {
  /*
   * THE LEVEL, NOT AN ACT.
   *
   * An import writes hundreds of records at once and is the single act most
   * able to make a mess of a company's data, so it wants `manage` — and
   * somebody who may add one unit is not automatically somebody who may
   * replace the inventory.
   *
   * The five acts only reach `manage` through `delete`, and asking "may you
   * delete property records" is the wrong question about an import. So this
   * reads the level itself. whyNotArea() is still used for the `create`
   * refusal, so somebody with no property access at all gets that sentence
   * rather than this one.
   */
  const actor = actorOf(req, "a migration route");
  const denied = whyNotArea(actor, "property", "create", "an import");
  if (denied) throw forbidden(denied);
  if (levelFor(actor, "property") !== "manage") {
    throw forbidden(
      "An import replaces a company's inventory in one act, so it needs full " +
      "control of the property area — not only the right to add a record.");
  }
}

/**
 * POST /organizations/migration/preview — what WOULD happen. Writes nothing.
 *
 * The same code the commit runs, so the two cannot disagree. Somebody moving
 * their company into a new system is entitled to see the outcome first.
 */
organizationRoutes.post("/migration/preview",
  requireSession(), requireOrganization(),
  async (req, res, next) => {
    try {
      mayMigrate(req);
      const orgId = actorOf(req, "a migration route").orgId;
      const report = await runMigration(db, orgId, rowsFrom(req.body), false);
      res.json({
        ...report,
        said: report.clean
          ? `${report.created} rows would be added, ${report.skipped} are already here.`
          : `${report.refused} rows cannot be imported. Nothing will be added until ` +
            `they are fixed — the list says which and why.`,
      });
    } catch (e) { next(e); }
  });

/**
 * POST /organizations/migration/commit — all of it, or none of it.
 */
organizationRoutes.post("/migration/commit",
  requireSession(), requireOrganization(),
  async (req, res, next) => {
    try {
      mayMigrate(req);
      const orgId = actorOf(req, "a migration route").orgId;
      const rows = rowsFrom(req.body);
      const report = await runMigration(db, orgId, rows, true);

      /* One audit row for the import, with the counts. Not one per record:
         a migration is a single decision somebody made, and four hundred
         rows in the trail would bury the day it happened. */
      try {
        await db.auditEvent.create({
          data: {
            orgId,
            actorId: sessionOf(req, "a migration route").userId,
            actorName: req.view?.user?.name || req.view?.user?.email || "",
            action: "organization.migration", entity: "organization", entityId: orgId,
            detail: {
              rows: rows.length, created: report.created, skipped: report.skipped,
            },
            ip: req.ip || "",
          },
        });
      } catch (e) { console.error("migration audit failed", messageOf(e)); }

      res.status(201).json({
        ...report,
        said: `${report.created} rows imported. ${report.skipped} were already here ` +
              `and were left as they are.`,
      });
    } catch (e) { next(e); }
  });
