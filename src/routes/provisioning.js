/* ====================================================================== *
 * PROVISIONING — putting a company on a product, and taking it off.
 *
 * ── WHY THIS IS NOT IN platform.js ──────────────────────────────────
 *
 * The staff console is READ-ONLY, on purpose, and platform-api.test.js holds
 * it to that: "supporting a customer means seeing what they see, not changing
 * it behind them." Every /platform/* path refuses POST, PATCH and DELETE.
 *
 * Granting a product is not support. It is a commercial act — it changes what
 * a company can open and what it will be billed for — and the codebase already
 * says where those belong: the promotion queues are the one place staff act,
 * and they have their own routes. So does this.
 *
 * It stands behind the SAME door: requirePlatform(), imported rather than
 * rewritten, so there is one definition of who PALTAS staff are.
 *
 * ── WHY THE AUDIT ROW GOES TO THE CUSTOMER, NOT TO US ────────────────
 *
 * platform.js files staff READS against the PALTAS organization, so a
 * customer's trail is not filled with our support activity. A grant is the
 * opposite: it changes what that company can do and what they pay, and they
 * are entitled to see that it happened and who did it. This writes to THEIR
 * trail, naming the member of staff.
 *
 * ── NOTHING IS EVER DELETED ─────────────────────────────────────────
 *
 * Removing a product SUSPENDS the entitlement. A deleted row cannot answer
 * "when did they have this, and who took it away" — which is exactly the
 * question asked when a customer says a screen has vanished.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import { requireSession } from "../http/session.ts";
import { requirePlatform } from "./platform.js";

export const provisioningRoutes = Router();

provisioningRoutes.use("/provisioning", requireSession(), requirePlatform());

/** The products a company can be sold. PLATFORM is not one of them. */
const SELLABLE = new Set([
  "PROPERTY_MANAGEMENT", "AGENT_HOST", "HOTEL_MANAGEMENT",
  "SECURITY_MANAGEMENT", "GUEST_PORTAL",
]);

/**
 * PLATFORM is staff access to every company on the service. It is grantable
 * here, because otherwise a second staff account could never be made without a
 * database prompt — but it is not a product, it is not sold, and it must not
 * arrive by the same door as one. It needs `confirmStaffAccess: true` said out
 * loud, so it cannot be granted by a typo in a product name.
 */
const STAFF_PRODUCT = "PLATFORM";

async function auditWrite(req, orgId, action, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        /* THEIR trail, not ours — see the note in the header. */
        orgId,
        actorId: req.session.userId,
        actorName: req.actor.userName || "",
        action, entity: "entitlement", entityId: entityId || "",
        detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) {
    /* Best-effort, like every audit write here: a logging failure must not
       undo a grant somebody has already been told went through. */
    console.error("provisioning audit write failed", action, e.message);
  }
}

/**
 * POST /provisioning/entitlements
 * Body: { orgId, product, confirmStaffAccess? }
 */
provisioningRoutes.post("/provisioning/entitlements", async (req, res, next) => {
  try {
    const orgId = String(req.body?.orgId || "").trim();
    const product = String(req.body?.product || "").trim().toUpperCase();

    if (!orgId) throw badRequest("Say which company this is for.");
    if (!product) throw badRequest("Say which product to add.");

    if (product === STAFF_PRODUCT) {
      if (req.body?.confirmStaffAccess !== true) {
        throw badRequest(
          "PLATFORM is staff access to every company on PALTAS, not a product. " +
          "Send confirmStaffAccess: true if that is really what you mean.");
      }
    } else if (!SELLABLE.has(product)) {
      throw badRequest(
        `“${product}” is not a product. One of: ${[...SELLABLE].join(", ")}.`);
    }

    /* CROSS-TENANT BY DESIGN — requirePlatform() above, and the grant below is
       written to the customer's own audit trail. */
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
    if (!org) throw notFound("No company with that id.");

    /*
     * UPSERT, because @@unique([orgId, product]) already says a company holds a
     * product once. A company that had it and lost it gets it back, rather than
     * collecting a second row it can never use.
     */
    const row = await db.entitlement.upsert({
      where: { orgId_product: { orgId: org.id, product } },
      create: { orgId: org.id, product, status: "ACTIVE" },
      update: { status: "ACTIVE" },
    });

    await auditWrite(req, org.id, "provisioning.entitlement.granted", row.id,
      { product, company: org.name });

    res.setHeader("Cache-Control", "no-store, private");
    res.status(201).json({
      entitlement: { id: row.id, product: row.product, status: row.status, since: row.since },
      company: { id: org.id, name: org.name },
      note: `${org.name} now holds ${product}. It opens on their next page load.`,
    });
  } catch (e) { next(e); }
});

/**
 * POST /provisioning/entitlements/:id/suspend — take a product away.
 *
 * The console reads only ACTIVE entitlements, so a suspended product closes
 * immediately and the row still answers when they had it and who removed it.
 */
provisioningRoutes.post("/provisioning/entitlements/:id/suspend", async (req, res, next) => {
  try {
    /* CROSS-TENANT BY DESIGN — requirePlatform() above; the suspend below is
       written to the customer's own audit trail. */
    const row = await db.entitlement.findUnique({
      where: { id: String(req.params.id) },
      include: { org: { select: { id: true, name: true } } },
    });
    if (!row) throw notFound("No entitlement with that id.");
    if (row.status !== "ACTIVE") {
      throw conflict(`That entitlement is already ${row.status.toLowerCase()}.`);
    }

    const updated = await db.entitlement.update({
      where: { id: row.id },
      data: { status: "SUSPENDED" },
    });

    await auditWrite(req, row.org.id, "provisioning.entitlement.suspended", row.id,
      { product: row.product, company: row.org.name, why: String(req.body?.why || "") });

    res.json({
      entitlement: { id: updated.id, product: updated.product, status: updated.status },
      company: { id: row.org.id, name: row.org.name },
      note: `${row.org.name} no longer holds ${row.product}.`,
    });
  } catch (e) { next(e); }
});
