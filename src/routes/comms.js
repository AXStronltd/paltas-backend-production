/* ====================================================================== *
 * TELLING PEOPLE THINGS, AND BEING ABLE TO PROVE IT.
 *
 * ── WHAT THE BUTTONS HERE ARE ALLOWED TO CLAIM ─────────────────────────
 *
 * Nothing in this file writes DELIVERED for a channel that leaves the
 * building. It cannot know. It writes what it does know:
 *
 *   a provider took it        → SUBMITTED, with the provider's own id
 *   no provider is connected  → QUEUED, and the response says so in words
 *   a provider refused it     → FAILED, in the provider's own words
 *
 * DELIVERED arrives later, through `POST /hooks/comms/:provider`, which is
 * the carrier telling us. That route is deliberately outside the session — a
 * provider has no session — and is therefore the most attackable surface in
 * this service, so it proves the callback is genuine before it believes a
 * word of it.
 *
 * ── WHY A CAMPAIGN IS STILL MADE OF INDIVIDUAL MESSAGES ────────────────
 *
 * Because "sent to 400 leaseholders" is not a record. The question that gets
 * asked is "did Mrs Achieng get it", and a counter cannot answer it. So a
 * campaign creates one Dispatch per recipient, each with its own state and
 * its own reason, and keeps counts alongside only so a list of campaigns does
 * not have to read four hundred rows to draw one line.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { deliver, providerStatus, STATUS_FOR } from "../domain/messaging.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { numberFor } from "../http/resource.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const commsRoutes = Router();

commsRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

/*
 * Communications sit in `people`.
 *
 * Not `documents`, which is where a first draft put them because both are
 * "things with text". A document is a file the company holds; a dispatch is
 * something said to a person, and the reach it needs is the reach to that
 * person's address. Somebody who may read the staff directory may write to it.
 */
const AREA = "people";

function need(req, act, label) {
  const why = whyNotArea(req.actor, AREA, act, label);
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

const who = (req) => req.view?.user?.name || req.view?.user?.email || "";
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

async function audit(req, action, entity, entityId, detail) {
  try {
    await db.auditEvent.create({
      data: {
        orgId: req.actor.orgId, actorId: req.session.userId, actorName: who(req),
        action, entity, entityId: entityId || "", detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, e.message); }
}

/* One lookup per table, named, so the scoping scanner can read them. */
async function ownDispatch(req, id) {
  const row = await db.dispatch.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownCampaign(req, id) {
  const row = await db.campaign.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownMeetingFor(req, id) {
  const row = await db.meeting.findFirst({
    where: { id, orgId: req.actor.orgId },
    include: { participants: { select: { name: true, email: true, partyId: true } } },
  });
  if (!row) throw hidden();
  return row;
}

/* ====================================================================== *
 * WHAT IS CONNECTED
 * ====================================================================== */

/**
 * GET /comms/providers — what can actually carry a message today.
 *
 * A settings screen that says "email: not connected, set RESEND_API_KEY and
 * MAIL_FROM" is the difference between a person fixing it in two minutes and
 * a person filing a bug about messages not arriving.
 */
commsRoutes.get("/comms/providers", route(async (req, res) => {
  need(req, "list", "dispatches");
  res.json({ providers: providerStatus() });
}));

/* ====================================================================== *
 * ONE MESSAGE
 * ====================================================================== */

/** Write the state and the event in one go, so a state with no reason cannot exist. */
async function moveDispatch(dispatch, result, byName, extra) {
  const status = STATUS_FOR[result.outcome];
  const now = new Date();
  const [row] = await db.$transaction([
    db.dispatch.update({
      where: { id: dispatch.id },
      data: {
        status,
        provider: result.provider || dispatch.provider,
        providerRef: result.providerRef || dispatch.providerRef,
        submittedAt: status === "SUBMITTED" || status === "DELIVERED"
          ? (dispatch.submittedAt || now) : dispatch.submittedAt,
        deliveredAt: status === "DELIVERED" ? (dispatch.deliveredAt || now) : dispatch.deliveredAt,
        failedAt: status === "FAILED" ? now : dispatch.failedAt,
        /* Cleared on a success, because a stale reason beside a submitted
           message reads as a message that failed and then went anyway. */
        error: status === "FAILED" ? text(result.detail, 1000) : "",
        ...(extra || {}),
      },
    }),
    db.dispatchEvent.create({
      data: {
        orgId: dispatch.orgId, dispatchId: dispatch.id, status,
        detail: text(result.detail, 1000), byName: byName || "system",
      },
    }),
  ]);
  return row;
}

/**
 * POST /dispatches/:id/send
 *
 * From DRAFT, QUEUED or FAILED. Not from SUBMITTED — asking a provider twice
 * is how somebody receives the same notice twice, and a duplicate notice
 * about a rent increase is its own small disaster.
 */
commsRoutes.post("/dispatches/:id/send", route(async (req, res) => {
  need(req, "update", "dispatches");
  const dispatch = await ownDispatch(req, req.params.id);

  if (["SUBMITTED", "DELIVERED"].includes(dispatch.status)) {
    throw conflict(
      `${dispatch.ref} has already gone to a provider. Sending it again would deliver it twice.`);
  }
  if (dispatch.status === "CANCELLED") {
    throw conflict(`${dispatch.ref} was cancelled. Copy it into a new message rather than reviving it.`);
  }
  if (!dispatch.toAddress) {
    throw badRequest("There is no address to send to.");
  }

  const result = await deliver(dispatch.channel, {
    to: dispatch.toAddress, subject: dispatch.subject, body: dispatch.body,
  });
  const out = await moveDispatch(dispatch, result, who(req));
  await audit(req, "dispatch.send", "dispatch", dispatch.id,
    { ref: dispatch.ref, outcome: result.outcome, provider: result.provider });

  res.json({
    dispatch: out,
    /* The outcome word, not a verb. "accepted" and "unconfigured" are both
       ordinary results and the console draws them differently. */
    outcome: result.outcome,
    /* The sentence a person reads. It never says "sent" unless something
       actually took it. */
    said: result.detail,
  });
}));

/**
 * POST /dispatches/:id/cancel — before anything has taken it.
 *
 * Written out rather than run through moveDispatch: cancelling is not an
 * outcome a provider reported, and forcing it through the same path meant
 * writing FAILED and correcting it afterwards, which left a history saying
 * the message had failed. A cancelled message did not fail. Nobody tried.
 */
commsRoutes.post("/dispatches/:id/cancel", route(async (req, res) => {
  need(req, "update", "dispatches");
  const dispatch = await ownDispatch(req, req.params.id);
  if (["SUBMITTED", "DELIVERED"].includes(dispatch.status)) {
    throw conflict(
      `${dispatch.ref} is already with a provider. It cannot be recalled from here.`);
  }
  if (dispatch.status === "CANCELLED") {
    throw conflict(`${dispatch.ref} was already cancelled.`);
  }

  const detail = text(req.body?.reason, 500) || "Cancelled before sending.";
  const [out] = await db.$transaction([
    db.dispatch.update({
      where: { id: dispatch.id },
      data: { status: "CANCELLED", error: "" },
    }),
    db.dispatchEvent.create({
      data: {
        orgId: dispatch.orgId, dispatchId: dispatch.id,
        status: "CANCELLED", detail, byName: who(req),
      },
    }),
  ]);
  await audit(req, "dispatch.cancel", "dispatch", dispatch.id, { ref: dispatch.ref });
  res.json({ dispatch: out });
}));

/**
 * GET /dispatches/outbox — the four questions somebody asks of an outbox.
 *
 * Not a filter on the list endpoint, because "stuck" is not a status: it is
 * queued AND old, which a query string cannot say and a person asking "what
 * has not gone out?" means every time.
 */
const OUTBOX = {
  queued: { status: { in: ["DRAFT", "QUEUED"] } },
  stuck: { status: "QUEUED" },
  submitted: { status: "SUBMITTED" },
  failed: { status: { in: ["FAILED", "BOUNCED"] } },
  delivered: { status: "DELIVERED" },
};

commsRoutes.get("/dispatches/outbox", route(async (req, res) => {
  need(req, "list", "dispatches");
  const view = String(req.query.view || "queued");
  if (!OUTBOX[view]) {
    throw badRequest(`"${req.query.view}" is not an outbox view.`, Object.keys(OUTBOX));
  }
  const orgId = req.actor.orgId;
  const where = { orgId, ...OUTBOX[view] };
  /* Stuck means queued for more than an hour: long enough that a provider
     being briefly down is not reported as a problem, short enough that a
     missing configuration is. */
  if (view === "stuck") where.updatedAt = { lt: new Date(Date.now() - 3600e3) };

  const [rows, queued, stuck, submitted, failed, delivered] = await Promise.all([
    db.dispatch.findMany({
      where, orderBy: { createdAt: "desc" }, take: 200,
      include: { campaign: { select: { id: true, ref: true, name: true } } },
    }),
    db.dispatch.count({ where: { orgId, status: { in: ["DRAFT", "QUEUED"] } } }),
    db.dispatch.count({ where: { orgId, status: "QUEUED", updatedAt: { lt: new Date(Date.now() - 3600e3) } } }),
    db.dispatch.count({ where: { orgId, status: "SUBMITTED" } }),
    db.dispatch.count({ where: { orgId, status: { in: ["FAILED", "BOUNCED"] } } }),
    db.dispatch.count({ where: { orgId, status: "DELIVERED" } }),
  ]);

  res.json({
    view, dispatches: rows, count: rows.length,
    counts: { queued, stuck, submitted, failed, delivered },
    /* What is connected, beside what is waiting — because a full queue and no
       provider is one problem with one fix, and showing the two separately
       makes somebody hunt for it. */
    providers: providerStatus(),
  });
}));

/* ====================================================================== *
 * MANY MESSAGES
 * ====================================================================== */

/**
 * Work out who a campaign is actually for.
 *
 * Deduplicated by address: a person who is both a buyer and a leaseholder is
 * one person, and telling them twice is how a company looks like it does not
 * know its own customers.
 */
async function audienceFor(req, spec) {
  const orgId = req.actor.orgId;
  const out = new Map();
  const add = (name, address, partyId) => {
    const key = String(address || "").trim().toLowerCase();
    if (!key || out.has(key)) return;
    out.set(key, { name: name || "", address: key, partyId: partyId || null });
  };

  const kinds = Array.isArray(spec.partyKinds) ? spec.partyKinds.filter(Boolean) : [];
  if (kinds.length) {
    const parties = await db.party.findMany({
      where: { orgId, kind: { in: kinds }, NOT: { email: "" } },
      select: { id: true, name: true, email: true },
    });
    parties.forEach((p) => add(p.name, p.email, p.id));
  }

  if (spec.meetingId) {
    const meeting = await ownMeetingFor(req, String(spec.meetingId));
    meeting.participants.forEach((p) => add(p.name, p.email, p.partyId));
  }

  if (spec.projectId) {
    /* Everybody with a stake in one development: the buyers who reserved in
       it, which is who a progress update is for. */
    const contracts = await db.contract.findMany({
      where: { orgId, projectId: String(spec.projectId) },
      select: { buyer: { select: { id: true, name: true, email: true } } },
    });
    contracts.forEach((c) => c.buyer && add(c.buyer.name, c.buyer.email, c.buyer.id));
  }

  (Array.isArray(spec.extra) ? spec.extra : []).forEach((r) =>
    add(text(r?.name, 160), text(r?.email, 200), null));

  return [...out.values()];
}

/** How the audience was described, kept as words so it reads back later. */
function describeAudience(spec, count) {
  const bits = [];
  if (spec.partyKinds?.length) bits.push(spec.partyKinds.join(", ").toLowerCase());
  if (spec.meetingId) bits.push("a meeting's participants");
  if (spec.projectId) bits.push("buyers in one development");
  if (spec.extra?.length) bits.push(`${spec.extra.length} named by hand`);
  return `${count} recipient${count === 1 ? "" : "s"}: ${bits.join(" + ") || "nobody"}`;
}

/**
 * POST /campaigns/:id/audience — who WOULD get this.
 *
 * Reads nothing into the database. Sending to four hundred people without
 * being able to look at the list first is not a feature anybody wants twice.
 */
commsRoutes.post("/campaigns/:id/audience", route(async (req, res) => {
  need(req, "update", "campaigns");
  const campaign = await ownCampaign(req, req.params.id);
  const people = await audienceFor(req, req.body || {});
  res.json({
    campaign: { id: campaign.id, ref: campaign.ref, name: campaign.name },
    recipients: people, count: people.length,
    describes: describeAudience(req.body || {}, people.length),
  });
}));

/**
 * POST /campaigns/:id/send
 *
 * Builds the audience, writes one Dispatch per person, and then attempts each
 * of them. The writing and the attempting are separate on purpose: if the
 * process dies halfway through the attempts, every message still exists and
 * is QUEUED, which is recoverable. If they were created as they were sent, the
 * ones never reached would not exist at all and nobody could tell.
 */
commsRoutes.post("/campaigns/:id/send", route(async (req, res) => {
  need(req, "update", "campaigns");
  const campaign = await ownCampaign(req, req.params.id);
  const orgId = req.actor.orgId;

  if (campaign.status !== "DRAFT") {
    throw conflict(
      `${campaign.ref} is ${campaign.status.toLowerCase()}. A campaign is sent once; ` +
      `copy it into a new one to send again.`);
  }
  if (!campaign.body) throw badRequest("A campaign with no body would be an empty message.");
  if (campaign.channel === "EMAIL" && !campaign.subject) {
    throw badRequest("An email needs a subject.");
  }

  const people = await audienceFor(req, req.body || {});
  if (!people.length) {
    throw badRequest(
      "That audience is nobody — everybody matched is missing an address. " +
      "Nothing has been created.");
  }

  /* Reserve the numbers up front. nextNumber is a counter upsert, and doing it
     inside the loop is the same round trip four hundred times. */
  const refs = [];
  for (let i = 0; i < people.length; i += 1) refs.push(await numberFor("dispatches", orgId));

  await db.$transaction([
    db.dispatch.createMany({
      data: people.map((p, i) => ({
        orgId, ref: refs[i], channel: campaign.channel, status: "QUEUED",
        toName: p.name, toAddress: p.address, partyId: p.partyId,
        subject: campaign.subject, body: campaign.body,
        projectId: campaign.projectId, campaignId: campaign.id,
        createdById: req.session.userId, createdByName: who(req),
      })),
    }),
    db.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "SENDING", total: people.length,
        audience: describeAudience(req.body || {}, people.length),
        sentAt: new Date(),
      },
    }),
  ]);

  const made = await db.dispatch.findMany({ where: { orgId, campaignId: campaign.id } });

  /*
   * ATTEMPTED IN SEQUENCE, NOT ALL AT ONCE.
   *
   * Four hundred simultaneous requests to a provider is how an account gets
   * rate-limited, and a rate-limited batch fails in the middle for a reason
   * that has nothing to do with the messages.
   */
  let submitted = 0, failed = 0, queued = 0;
  for (const d of made) {
    const result = await deliver(d.channel, {
      to: d.toAddress, subject: d.subject, body: d.body,
    });
    await moveDispatch(d, result, who(req));
    if (result.outcome === "accepted") submitted += 1;
    else if (result.outcome === "refused") failed += 1;
    else queued += 1;
  }

  /*
   * PARTIAL IS A REAL STATE, AND THE IMPORTANT ONE.
   *
   * Calling a batch "sent" when a third of it failed is the single most
   * misleading word this service could write, so it is not available: sent
   * means every one was taken, partial means some were, and a batch nothing
   * took stays SENDING with its messages queued — because they are still going
   * to go, the moment a provider exists.
   */
  const status = failed && submitted ? "PARTIAL"
    : failed && !submitted && !queued ? "FAILED"
    : submitted && !failed && !queued ? "SENT"
    : queued && !submitted && !failed ? "SENDING"
    : "PARTIAL";

  const out = await db.campaign.update({
    where: { id: campaign.id },
    data: { status, submitted, failed },
  });
  await audit(req, "campaign.send", "campaign", campaign.id,
    { ref: campaign.ref, total: people.length, submitted, failed, queued });

  res.json({
    campaign: out,
    total: people.length, submitted, failed, queued,
    said: queued === people.length
      ? `${people.length} message${people.length === 1 ? "" : "s"} created and queued. ` +
        `No provider is connected, so none of them has been sent.`
      : `${submitted} accepted by the provider, ${failed} refused, ${queued} still queued. ` +
        `Delivery is confirmed separately.`,
  });
}));

/** POST /campaigns/:id/cancel — and every message of it that has not gone. */
commsRoutes.post("/campaigns/:id/cancel", route(async (req, res) => {
  need(req, "update", "campaigns");
  const campaign = await ownCampaign(req, req.params.id);
  if (["SENT", "CANCELLED"].includes(campaign.status)) {
    throw conflict(`${campaign.ref} is ${campaign.status.toLowerCase()} — there is nothing left to stop.`);
  }
  const stopped = await db.dispatch.updateMany({
    where: {
      orgId: req.actor.orgId, campaignId: campaign.id,
      status: { in: ["DRAFT", "QUEUED"] },
    },
    data: { status: "CANCELLED" },
  });
  const out = await db.campaign.update({
    where: { id: campaign.id }, data: { status: "CANCELLED" },
  });
  await audit(req, "campaign.cancel", "campaign", campaign.id,
    { ref: campaign.ref, stopped: stopped.count });
  res.json({
    campaign: out, stopped: stopped.count,
    /* What could NOT be stopped, which is the number somebody actually needs. */
    said: `${stopped.count} stopped. Anything already with the provider is gone and cannot be recalled.`,
  });
}));
