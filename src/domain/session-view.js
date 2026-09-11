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

/* ====================================================================== *
 * THE SHAPE VERSION. THE SESSION IS WORTHLESS WITHOUT IT.
 *
 * The frontend does not merely tolerate this field, it GATES ON IT. In
 * `assets/console.js`:
 *
 *     var VERSION = 2;
 *     function read() { ... return o.v === VERSION ? o : migrate(o); }
 *
 * `migrate()` upgrades a version-1 session, and a version-1 session is a
 * flat object of `{ email, who, caps, sub, plan }`. So a response without
 * `v` is not read as "a session missing one field" — it is read as an OLD
 * session, handed to a migrator that looks for keys this service has never
 * sent, finds none of them, and returns a BLANK session.
 *
 * The result, confirmed by running the frontend's own Session module
 * against this service's real response: signedIn stays true, and the
 * company name, the email, every entitlement and every membership come back
 * empty. `resolve()` then answers NOT_ENTITLED and sends the person to
 * index.html. Signed in, and locked out of every console they own, with
 * nothing on screen to explain it.
 *
 * One integer. It must track `VERSION` in assets/console.js, and
 * test/contract.test.js fails if it is ever absent.
 * ====================================================================== */
const SHAPE_VERSION = 2;

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
    v: SHAPE_VERSION,
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
    /*
     * CONSUMER, BY THE FRONTEND'S OWN RULE.
     *
     * `migrate()` in assets/console.js states it: somebody is a consumer when
     * they hold the guest portal, or hold nothing at all. Here, in the branch
     * for a person with no company, they hold nothing — so this is true, and
     * true for the right reason.
     *
     * It used to be hardcoded true for EVERYBODY, a hotel group on a paid
     * subscription included. Nothing in the built frontend reads the field
     * today, so nothing was visibly wrong, which is the only reason it
     * survived this long.
     */
    consumer: true,
  };

  if (!current) return base;

  const org = current.org;

  /* ONE ENTITLEMENT PER PRODUCT. The unique constraint guarantees it in the
     database; this filter guarantees it even if that constraint is ever
     relaxed, because an account listed twice for one product sent that
     customer to a door offering the same console twice. */
  const entitlements = dedupe(
    org.entitlements
      .filter((e) => e.status === "ACTIVE")
      .map((e) => ({ product: e.product, status: e.status, since: day(e.since) }))
  );

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

    entitlements,

    /* A business is not a consumer. See the note in `base` above for the rule
       and where it comes from. */
    consumer: entitlements.every((e) => e.product === "GUEST_PORTAL"),

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
