/* ====================================================================== *
 * THE CARRIER TELLING US WHAT HAPPENED.
 *
 * THIS FILE HOLDS THE ONLY CODE IN THE SERVICE THAT MAY WRITE "DELIVERED"
 * for a message that left the building. Everything else works from what it
 * can know — that a provider accepted it — and this is where the other half
 * of the truth arrives.
 *
 * ── IT IS THE MOST ATTACKABLE SURFACE HERE, SO IT ASSUMES THE WORST ────
 *
 * There is no session: a provider has none. So anybody on the internet can
 * post to it, and a route that believed what it was told would let a stranger
 * mark a company's entire outbox as delivered — which is worse than marking
 * nothing, because it would be a confident lie in a record people rely on.
 *
 * Three things stand in the way, in order:
 *
 *   1. A SHARED SECRET, compared in constant time. Without COMMS_WEBHOOK_SECRET
 *      set, the route answers 503 and believes nothing at all. A service that
 *      accepts unverified callbacks "until the secret is configured" is a
 *      service that ships without one.
 *   2. THE PROVIDER'S OWN ID, which is the only handle offered. A caller must
 *      already know a reference this service generated and stored, which is
 *      not guessable and is never shown to anybody outside the company.
 *   3. THE PROVIDER NAME MUST MATCH the one that accepted it. A Postmark
 *      callback cannot resolve a message Resend is carrying.
 *
 * ── WHY IT NEVER 500s ──────────────────────────────────────────────────
 *
 * Every provider retries a non-2xx, and a retry storm against a handler that
 * throws is how one bounce becomes four hundred rows. Anything it cannot
 * place is acknowledged and logged rather than refused.
 * ====================================================================== */

import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db.js";

export const commsWebhookRoutes = Router();

const log = {
  info: (...a) => console.log(new Date().toISOString(), "[comms]", ...a),
  error: (...a) => console.error(new Date().toISOString(), "[comms]", ...a),
};

/**
 * Constant time, because a plain `===` on a secret leaks its length and then
 * its bytes to anybody willing to time a few thousand requests.
 */
function secretOk(given) {
  const want = process.env.COMMS_WEBHOOK_SECRET || "";
  if (!want) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Every provider names these differently, and none of them is wrong.
 *
 * The mapping is here rather than in the provider modules because it is about
 * what this service believes, not about how to talk to anybody: `spam` and
 * `bounce` are two words for a message that did not arrive, and both become
 * BOUNCED so a person reading the outbox does not have to know which provider
 * carried which.
 */
const EVENT_STATUS = {
  delivered: "DELIVERED",
  delivery: "DELIVERED",
  "email.delivered": "DELIVERED",
  bounce: "BOUNCED",
  bounced: "BOUNCED",
  "email.bounced": "BOUNCED",
  spamcomplaint: "BOUNCED",
  complaint: "BOUNCED",
  failed: "FAILED",
  "email.failed": "FAILED",
  undelivered: "FAILED",
};

/**
 * POST /hooks/comms/:provider
 *
 * Mounted outside the session, so it says nothing about what it found: a
 * caller who guesses a reference must not be able to tell a real one from a
 * wrong one by the answer. Every outcome is 200 `{ ok: true }`.
 */
commsWebhookRoutes.post("/hooks/comms/:provider", async (req, res) => {
  if (!process.env.COMMS_WEBHOOK_SECRET) {
    /* 503, not 401: the request may be perfectly genuine and this installation
       simply is not listening for callbacks yet. */
    return res.status(503).json({
      error: "unavailable",
      message: "Delivery callbacks are not configured on this installation.",
    });
  }
  if (!secretOk(req.get("x-paltas-signature") || req.query.token)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const provider = String(req.params.provider || "").toLowerCase().slice(0, 40);
  const b = req.body || {};

  /* The three names a provider might use for its own id, and the three for
     what happened. Read rather than demanded, because a provider adding a
     field must not break a callback that was working. */
  const ref = String(b.providerRef || b.MessageID || b.message_id || b.id ||
                     b.MessageSid || b.sid || "").trim();
  const kind = String(b.type || b.RecordType || b.event || b.MessageStatus || "")
    .trim().toLowerCase();
  const status = EVENT_STATUS[kind];

  if (!ref || !status) {
    log.info("callback ignored", provider, JSON.stringify({ ref, kind }).slice(0, 200));
    return res.json({ ok: true });
  }

  try {
    /*
     * FOUND BY THE PROVIDER'S REFERENCE AND THE PROVIDER'S NAME.
     *
     * Not scoped to a company, because a callback belongs to no session and
     * carries no company — the reference IS the scope. It was generated by
     * somebody else, stored against exactly one row, and never shown outside
     * the company that owns it.
     */
    const dispatch = await db.dispatch.findFirst({
      where: { providerRef: ref, provider },
    });
    if (!dispatch) {
      log.info("callback for an unknown reference", provider, ref.slice(0, 40));
      return res.json({ ok: true });
    }

    /*
     * A LATE CALLBACK MUST NOT UNDO A LATER TRUTH.
     *
     * Providers redeliver, and they redeliver out of order. A `delivered`
     * arriving after a `bounce` would otherwise rewrite a message that came
     * back as one that arrived — so a message that has already bounced or
     * failed stays that way, and only the event list shows both.
     */
    const settled = ["BOUNCED", "FAILED"].includes(dispatch.status);
    const now = new Date();

    await db.$transaction([
      db.dispatchEvent.create({
        data: {
          orgId: dispatch.orgId, dispatchId: dispatch.id, status,
          detail: String(b.Description || b.description || b.reason ||
                         b.ErrorCode || "").slice(0, 1000) ||
                  `${provider} reported ${kind}`,
          byName: "system",
        },
      }),
      ...(settled && status === "DELIVERED" ? [] : [
        db.dispatch.update({
          where: { id: dispatch.id },
          data: {
            status,
            deliveredAt: status === "DELIVERED" ? (dispatch.deliveredAt || now) : dispatch.deliveredAt,
            failedAt: status === "DELIVERED" ? dispatch.failedAt : now,
            error: status === "DELIVERED" ? ""
              : String(b.Description || b.description || b.reason || "").slice(0, 1000),
          },
        }),
      ]),
    ]);

    /* A campaign's counters follow its messages, so a list of campaigns does
       not have to count four hundred rows to draw one line. */
    if (dispatch.campaignId) {
      const [delivered, failed] = await Promise.all([
        db.dispatch.count({ where: { campaignId: dispatch.campaignId, status: "DELIVERED" } }),
        db.dispatch.count({
          where: { campaignId: dispatch.campaignId, status: { in: ["FAILED", "BOUNCED"] } },
        }),
      ]);
      await db.campaign.update({
        where: { id: dispatch.campaignId }, data: { delivered, failed },
      });
    }
  } catch (e) {
    /* Logged, never thrown: a 500 makes the provider retry, and a retry of a
       handler that died halfway is how one bounce becomes several. */
    log.error("callback failed", provider, e.message);
  }

  res.json({ ok: true });
});
