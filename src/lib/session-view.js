/* ====================================================================== *
 * THE SESSION OBJECT, ASSEMBLED.
 *
 * This is the single most important function in the service, because it is
 * the one thing the frontend does not translate. `assets/session.js` reads
 * exactly this shape:
 *
 *   { user, organization, subscription, entitlements, verification,
 *     memberships, workspace }
 *
 * If a field is missing or an enum is spelt differently, a console opens empty
 * and nothing says why. So this file builds the object from the database and
 * from nothing else — no defaults invented at the edge, no "probably ACTIVE".
 * ====================================================================== */

import { db } from "../db.js";

/**
 * Everything the frontend needs about who is signed in.
 *
 * `session.orgId` decides which company they are currently acting for. Nobody
 * is silently placed in a company they did not choose: if the session names
 * one they still belong to, that is the one; otherwise their first membership;
 * and if they have none, the object comes back with no organization at all,
 * which is a real and legitimate state — a person who has signed in but not
 * yet created a company.
 */
export async function sessionView(sessionRow) {
  const user = sessionRow.user;

  const memberships = await db.membership.findMany({
    where: { userId: user.id },
    include: {
      org: {
        include: {
          subscription: true,
          verification: true,
          workspace: true,
          entitlements: { orderBy: { since: "asc" } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const current =
    memberships.find((m) => m.orgId === sessionRow.orgId) || memberships[0] || null;

  const base = {
    signedIn: true,
    user: {
      id: user.id,
      name: user.name || "",
      email: user.email,
      phone: user.phone || "",
    },
    organization: null,
    subscription: null,
    entitlements: [],
    verification: { status: "NOT_STARTED", documents: [] },
    memberships: memberships.map((m) => ({
      organization: m.orgId,
      organizationName: m.org.name,
      role: m.role,
      scope: m.scope,
    })),
    workspace: { status: "ACTIVE", preferred: "" },
    /* Not part of the contract, but the frontend's own session has it and it
       costs nothing to be consistent: a person is a consumer of the
       marketplace as well as a member of a company. */
    consumer: true,
  };

  if (!current) return base;

  const org = current.org;

  return {
    ...base,
    organization: {
      id: org.id,
      name: org.name,
      country: org.country,
      city: org.city,
      size: org.size,
      status: org.status,
    },
    subscription: org.subscription
      ? {
          status: org.subscription.status,
          plan: org.subscription.plan,
          planKey: org.subscription.planKey,
          trialDays: org.subscription.trialDays,
          seats: org.subscription.seats,
        }
      /* No subscription row is not "ACTIVE by default". It is EXPIRED, which
         is the safe reading of "nobody has ever paid for this". */
      : { status: "EXPIRED", plan: "", planKey: "", trialDays: 0, seats: 1 },

    /* ONE ENTITLEMENT PER PRODUCT. The unique constraint guarantees it in the
       database; this filter guarantees it even if that constraint is ever
       relaxed, because an account listed twice for one product sent that
       customer to a door offering the same console twice. */
    entitlements: dedupe(
      org.entitlements
        .filter((e) => e.status === "ACTIVE")
        .map((e) => ({ product: e.product, status: e.status, since: day(e.since) }))
    ),

    verification: org.verification
      ? { status: org.verification.status, documents: org.verification.documents || [] }
      : { status: "NOT_STARTED", documents: [] },

    workspace: org.workspace
      ? { status: org.workspace.status, preferred: org.workspace.preferred }
      : { status: "ACTIVE", preferred: "" },
  };
}

/**
 * The compact form the permission checks use. Built from the same query the
 * view is, so a route can never be checking one thing and rendering another.
 */
export async function actorFor(sessionRow) {
  const view = await sessionView(sessionRow);
  if (!view.organization) return null;

  const current = view.memberships.find((m) => m.organization === view.organization.id);
  const products = view.entitlements.map((e) => e.product);

  return {
    userId: view.user.id,
    userName: view.user.name || view.user.email,
    orgId: view.organization.id,
    orgName: view.organization.name,
    role: current ? current.role : "OWNER",
    scope: current ? current.scope : { all: true },
    products,
    /* PALTAS's own staff. This is what elevates an OWNER to a publisher, and
       it is an entitlement rather than a role because being the owner of YOUR
       company must grant nothing on OURS. */
    isPlatform: products.includes("PLATFORM"),
    subscriptionStatus: view.subscription.status,
    verificationStatus: view.verification.status,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => (seen.has(e.product) ? false : (seen.add(e.product), true)));
}

const day = (d) => new Date(d).toISOString().slice(0, 10);
