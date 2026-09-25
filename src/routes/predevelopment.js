/* ====================================================================== *
 * EVERYTHING BEFORE ANYBODY BUILDS ANYTHING.
 *
 * Four registers, and one rule each that a spreadsheet cannot hold:
 *
 *   ACQUISITION  cannot complete while a due-diligence item is unresolved.
 *                Buying land on an unsettled title search is the single most
 *                expensive mistake available in this business, and it is
 *                always made the same way — the search is outstanding, the
 *                deadline is Friday, and somebody ticks it off.
 *
 *   FEASIBILITY  every derived figure is computed, never stored. Total cost,
 *                profit, margin and the residual land value come out of the
 *                inputs on the way past; a stored margin is one that
 *                disagrees with its own numbers the first time a cost changes.
 *
 *   DRAWING      issuing a revision supersedes the previous rather than
 *                overwriting it, and a sheet issued for construction cannot
 *                be edited at all. Somebody built to revision B.
 *
 *   PERMIT       approving needs the authority's own reference, because that
 *                is the only handle that works when ringing them up — and a
 *                consent that has lapsed reads as expired whatever the column
 *                says, because a stored "approved" on a dead permit is a
 *                licence to build illegally.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { ACQUISITION_NEXT, PERMIT_NEXT } from "../domain/decisions.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { feasibilityNumbers } from "../domain/feasibility.ts";
import { numberFor } from "../http/resource.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const predevRoutes = Router();

predevRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req, act, label) {
  const why = whyNotArea(req.actor, "property", act, label);
  if (why) throw forbidden(why);
}

/* Buying land and approving a feasibility are money decisions, whatever else
   they are. Somebody who may draw the programme must not be able to commit
   the company to a purchase. */
function needMoney(req, act, label) {
  const why = whyNotArea(req.actor, "finance", act, label);
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

const who = (req) => req.view?.user?.name || req.view?.user?.email || "";
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const day = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.trunc(n))) return null;
  return BigInt(Math.trunc(n));
}

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
async function ownAcquisition(req, id) {
  const row = await db.acquisition.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownDiligence(req, id) {
  const row = await db.diligenceItem.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownFeasibility(req, id) {
  const row = await db.feasibility.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownDrawing(req, id) {
  const row = await db.drawing.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownPermit(req, id) {
  const row = await db.permit.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}

/* ====================================================================== *
 * LAND
 * ====================================================================== */


/**
 * POST /acquisitions/:id/status
 *
 * The pipeline only moves forwards, and COMPLETED is the one move with a
 * condition on it: nothing outstanding in the due-diligence list.
 */
predevRoutes.post("/acquisitions/:id/status", route(async (req, res) => {
  needMoney(req, "update", "acquisitions");
  const a = await ownAcquisition(req, req.params.id);
  const orgId = req.actor.orgId;

  const to = String(req.body?.status || "").toUpperCase();
  if (!ACQUISITION_NEXT[to]) {
    throw badRequest(`"${req.body?.status}" is not an acquisition state.`,
      Object.keys(ACQUISITION_NEXT));
  }
  const allowed = ACQUISITION_NEXT[a.status];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length
        ? `${a.ref} is ${a.status.toLowerCase().replace(/_/g, " ")} and can only move to ` +
          `${allowed.join(", ").toLowerCase().replace(/_/g, " ")}.`
        : `${a.ref} is ${a.status.toLowerCase()} and does not move again. ` +
          `A deal that comes back is a new one.`);
  }

  const data = { status: to };

  if (to === "OFFERED") {
    const offered = money(req.body?.offeredPrice ?? a.offeredPrice);
    if (offered === null || offered <= 0n) {
      throw badRequest("An offer needs a figure. Offering nothing is not offering.");
    }
    data.offeredPrice = offered;
    data.offeredOn = new Date();
  }

  if (to === "AGREED") {
    const agreed = money(req.body?.agreedPrice ?? a.agreedPrice);
    if (agreed === null || agreed <= 0n) throw badRequest("An agreed deal needs the agreed figure.");
    const seller = text(req.body?.sellerName, 200) || a.sellerName;
    if (!seller && !a.sellerId) {
      throw badRequest("An agreed deal needs somebody to have agreed it with.");
    }
    data.agreedPrice = agreed;
    data.sellerName = seller;
    data.agreedOn = new Date();
  }

  if (to === "ABANDONED") {
    const why = text(req.body?.reason, 2000);
    if (!why) {
      throw badRequest(
        "A deal that died needs to say why. It is the most useful column in the " +
        "table by the third one that dies the same way.");
    }
    data.abandonedReason = why;
  }

  /*
   * COMPLETION IS THE ONE THAT REFUSES.
   *
   * Every item must be settled — CLEAR, or WAIVED by somebody who put their
   * name to accepting a known problem. PENDING means nobody looked; ISSUE
   * means somebody looked and found something. Neither is a reason to pay.
   */
  if (to === "COMPLETED") {
    const open = await db.diligenceItem.findMany({
      where: { orgId, acquisitionId: a.id, status: { in: ["PENDING", "ISSUE"] } },
      select: { title: true, status: true, finding: true },
    });
    if (open.length) {
      throw conflict(
        `${a.ref} cannot complete — ${open.length} due-diligence item${
          open.length === 1 ? " is" : "s are"} unsettled:\n  ` +
        open.map((i) => `${i.title} (${i.status.toLowerCase()})${
          i.finding ? ` — ${i.finding}` : ""}`).join("\n  ") +
        `\n\nClear them, or waive them in writing with a reason.`);
    }
    if (!a.agreedPrice || a.agreedPrice <= 0n) {
      throw conflict(`${a.ref} has no agreed price. Completing would buy land for nothing.`);
    }
    data.completedOn = day(req.body?.completedOn) || new Date();
  }

  const out = await db.acquisition.update({ where: { id: a.id }, data });
  await audit(req, "acquisition.status", "acquisition", a.id, { ref: a.ref, to });

  const waived = to === "COMPLETED"
    ? await db.diligenceItem.count({ where: { orgId, acquisitionId: a.id, status: "WAIVED" } })
    : 0;

  res.json({
    acquisition: out,
    said: to === "COMPLETED"
      ? `${a.ref} completed.` + (waived
        ? ` ${waived} item${waived === 1 ? " was" : "s were"} waived rather than cleared — ` +
          `the reasons are on the record.`
        : " Every check was clear.")
      : `${a.ref} is now ${to.toLowerCase().replace(/_/g, " ")}.`,
  });
}));

/** POST /acquisitions/:id/diligence — something else that must be checked. */
predevRoutes.post("/acquisitions/:id/diligence", route(async (req, res) => {
  need(req, "update", "acquisitions");
  const a = await ownAcquisition(req, req.params.id);
  const title = text(req.body?.title, 300);
  if (!title) throw badRequest("A check needs to say what is being checked.");

  const count = await db.diligenceItem.count({
    where: { orgId: req.actor.orgId, acquisitionId: a.id },
  });
  const item = await db.diligenceItem.create({
    data: {
      orgId: req.actor.orgId, acquisitionId: a.id, title,
      category: text(req.body?.category, 120),
      dueOn: day(req.body?.dueOn), position: count + 1,
    },
  });
  res.status(201).json({ item });
}));

/**
 * POST /acquisitions/:id/diligence/:itemId
 *
 * CLEAR, ISSUE or WAIVED — and waiving is the one that needs a name on it.
 * Accepting a known problem is a decision somebody made; a waiver with nobody
 * attached is the one that turns out to have been nobody's.
 */
predevRoutes.post("/acquisitions/:id/diligence/:itemId", route(async (req, res) => {
  need(req, "update", "acquisitions");
  const a = await ownAcquisition(req, req.params.id);
  const item = await ownDiligence(req, req.params.itemId);
  if (item.acquisitionId !== a.id) throw hidden();

  const to = String(req.body?.status || "").toUpperCase();
  if (!["PENDING", "CLEAR", "ISSUE", "WAIVED"].includes(to)) {
    throw badRequest(`"${req.body?.status}" is not a check result.`,
      ["PENDING", "CLEAR", "ISSUE", "WAIVED"]);
  }

  const data = {
    status: to,
    finding: req.body?.finding === undefined ? item.finding : text(req.body.finding, 20000),
    checkedBy: text(req.body?.checkedBy, 160) || who(req),
    checkedOn: new Date(),
  };

  if (to === "ISSUE" && !data.finding) {
    throw badRequest("An issue needs to say what the issue is.");
  }
  if (to === "WAIVED") {
    const by = text(req.body?.waivedBy, 160) || who(req);
    const why = text(req.body?.waivedReason, 2000);
    if (!why) {
      throw badRequest(
        "Waiving a check means accepting a known problem, so it needs a reason and a " +
        "name. Clearing it would say the problem is not there.");
    }
    data.waivedBy = by;
    data.waivedReason = why;
  } else {
    data.waivedBy = "";
    data.waivedReason = "";
  }

  const out = await db.diligenceItem.update({ where: { id: item.id }, data });
  await audit(req, "acquisition.diligence", "acquisition", a.id,
    { ref: a.ref, item: item.title, to });
  res.json({ item: out });
}));

/* ====================================================================== *
 * DOES IT WORK ON PAPER
 * ====================================================================== */

/**
 * POST /feasibilities/:id/decide
 *
 * A study is approved by a named person, on a date, and never when its own
 * numbers say it does not work — approving an unviable scheme silently is how
 * one gets built.
 */
predevRoutes.post("/feasibilities/:id/decide", route(async (req, res) => {
  needMoney(req, "update", "feasibilities");
  const f = await ownFeasibility(req, req.params.id);

  if (!["DRAFT", "UNDER_REVIEW"].includes(f.status)) {
    throw conflict(
      `${f.ref} is ${f.status.toLowerCase().replace(/_/g, " ")}. ` +
      `A decision is made once; a later view is a later study.`);
  }

  const approve = req.body?.approve === true;
  const by = text(req.body?.decidedBy, 160) || who(req);
  const note = text(req.body?.note, 4000);
  const numbers = feasibilityNumbers(f);

  if (approve) {
    if (f.grossValue <= 0n) {
      throw badRequest(
        `${f.ref} has no gross development value. A study with nothing on the other ` +
        `side of the sum cannot be approved.`);
    }
    /* An unviable scheme MAY be approved — companies take strategic losses —
       but never silently. The override has to be asked for by name. */
    if (!numbers.viable && req.body?.acceptLoss !== true) {
      throw conflict(
        `${f.ref} does not work on its own numbers: ${numbers.marginOnCost} on cost ` +
        `against a target of ${(f.targetMarginBps / 100).toFixed(2)}%. ` +
        `Approve it deliberately with acceptLoss if that is the decision.`);
    }
    if (!note && !numbers.viable) {
      throw badRequest("Approving a scheme that does not work needs the reasoning.");
    }
  } else if (!note) {
    throw badRequest("Turning down a study needs a reason.");
  }

  const out = await db.feasibility.update({
    where: { id: f.id },
    data: {
      status: approve ? "APPROVED" : "REJECTED",
      decidedBy: by, decidedOn: new Date(), decidedNote: note,
    },
  });
  await audit(req, "feasibility.decide", "feasibility", f.id,
    { ref: f.ref, approve, marginBps: numbers.marginBps });

  res.json({
    feasibility: out, numbers,
    said: approve
      ? numbers.viable
        ? `${f.ref} approved by ${by} at ${numbers.marginOnCost} on cost.`
        : `${f.ref} approved by ${by} DESPITE returning ${numbers.marginOnCost} on cost. ` +
          `The reasoning is on the record.`
      : `${f.ref} turned down.`,
  });
}));

/**
 * POST /feasibilities/:id/supersede
 *
 * A later study replaces an earlier one without erasing it. The numbers a
 * decision was actually made on matter more than the numbers that turned out
 * to be right.
 */
predevRoutes.post("/feasibilities/:id/supersede", route(async (req, res) => {
  needMoney(req, "create", "feasibilities");
  const f = await ownFeasibility(req, req.params.id);
  if (f.status === "SUPERSEDED") throw conflict(`${f.ref} has already been replaced.`);
  const orgId = req.actor.orgId;

  const next = await db.feasibility.create({
    data: {
      orgId, ref: await numberFor("feasibilities", orgId),
      projectId: f.projectId, acquisitionId: f.acquisitionId,
      title: text(req.body?.title, 300) || `${f.title} (revised)`,
      assumptions: f.assumptions, status: "DRAFT",
      landCost: f.landCost, buildCost: f.buildCost, professional: f.professional,
      financeCost: f.financeCost, otherCost: f.otherCost, grossValue: f.grossValue,
      currency: f.currency, targetMarginBps: f.targetMarginBps,
      createdById: req.session.userId, createdByName: who(req),
    },
  });
  const out = await db.feasibility.update({
    where: { id: f.id }, data: { status: "SUPERSEDED" },
  });
  await audit(req, "feasibility.supersede", "feasibility", f.id,
    { ref: f.ref, next: next.ref });
  res.json({
    feasibility: out, next,
    said: `${next.ref} opened as a copy of ${f.ref}, which stays exactly as it was ` +
          `decided on.`,
  });
}));

/* ====================================================================== *
 * DRAWINGS
 * ====================================================================== */

/**
 * POST /drawings/:id/issue
 *
 * For comment, or for construction. The second is the one that matters: from
 * then on the sheet cannot be edited, because somebody is building to it.
 */
predevRoutes.post("/drawings/:id/issue", route(async (req, res) => {
  need(req, "update", "drawings");
  const d = await ownDrawing(req, req.params.id);

  if (d.status === "SUPERSEDED") {
    throw conflict(`${d.number} rev ${d.revision} has been superseded. Issue the current revision.`);
  }
  const to = String(req.body?.for || "CONSTRUCTION").toUpperCase();
  const status = to === "COMMENT" ? "ISSUED_FOR_COMMENT" : "ISSUED_FOR_CONSTRUCTION";
  if (d.status === status) {
    throw conflict(`${d.number} rev ${d.revision} has already been issued for ${to.toLowerCase()}.`);
  }
  if (d.status === "ISSUED_FOR_CONSTRUCTION" && status === "ISSUED_FOR_COMMENT") {
    throw conflict(
      `${d.number} rev ${d.revision} is already out for construction. It cannot be ` +
      `pulled back to comment — issue a new revision.`);
  }

  const out = await db.drawing.update({
    where: { id: d.id },
    data: {
      status, issuedOn: new Date(),
      issuedBy: text(req.body?.issuedBy, 160) || who(req),
    },
  });
  await audit(req, "drawing.issue", "drawing", d.id,
    { ref: d.ref, number: d.number, revision: d.revision, status });

  res.json({
    drawing: out,
    said: status === "ISSUED_FOR_CONSTRUCTION"
      ? `${d.number} rev ${d.revision} is out for construction. It is now fixed — ` +
        `a change is a new revision.`
      : `${d.number} rev ${d.revision} issued for comment.`,
  });
}));

/**
 * POST /drawings/:id/revise
 *
 * Opens the next revision as its OWN row and supersedes this one. Exactly the
 * arrangement submittals use, and for the same reason: somebody built to
 * revision B, and overwriting it means nobody can find out what they built to.
 */
predevRoutes.post("/drawings/:id/revise", route(async (req, res) => {
  need(req, "create", "drawings");
  const d = await ownDrawing(req, req.params.id);
  const orgId = req.actor.orgId;

  if (d.status === "SUPERSEDED") {
    throw conflict(`${d.number} rev ${d.revision} was already superseded. Revise the current one.`);
  }
  const why = text(req.body?.reason, 2000);
  if (!why) {
    throw badRequest(
      "A revision needs to say what changed. It is what everybody holding the old " +
      "sheet has to be told.");
  }

  const revision = text(req.body?.revision, 12) || nextLetter(d.revision);
  const next = await db.drawing.create({
    data: {
      orgId, ref: await numberFor("drawings", orgId),
      projectId: d.projectId, number: d.number, title: d.title,
      discipline: d.discipline, revision, scale: d.scale,
      status: "DRAFT", previousId: d.id,
      createdById: req.session.userId, createdByName: who(req),
    },
  });
  const out = await db.drawing.update({
    where: { id: d.id }, data: { status: "SUPERSEDED" },
  });
  await audit(req, "drawing.revise", "drawing", d.id,
    { ref: d.ref, number: d.number, from: d.revision, to: revision, reason: why });

  res.json({
    drawing: out, next,
    said: `${d.number} rev ${revision} opened. Rev ${d.revision} stays exactly as it ` +
          `was issued — somebody is building to it.`,
  });
}));

/** A → B → C. Numeric revisions increment; anything else the caller names. */
function nextLetter(rev) {
  const r = String(rev || "A").trim();
  if (/^\d+$/.test(r)) return String(Number(r) + 1);
  if (/^[A-Za-z]$/.test(r)) {
    return r.toUpperCase() === "Z" ? "AA" : String.fromCharCode(r.toUpperCase().charCodeAt(0) + 1);
  }
  return `${r}1`;
}

/**
 * GET /drawings/current — the sheet to build to, per drawing number.
 *
 * A register that lists every revision is a register nobody can use on site.
 * This is the one question anybody asks of it.
 */
predevRoutes.get("/drawings/current", route(async (req, res) => {
  need(req, "list", "drawings");
  const orgId = req.actor.orgId;
  const rows = await db.drawing.findMany({
    where: { orgId, status: { not: "SUPERSEDED" } },
    orderBy: [{ number: "asc" }, { createdAt: "desc" }],
    take: 500,
    include: { project: { select: { id: true, name: true } } },
  });
  const forConstruction = rows.filter((d) => d.status === "ISSUED_FOR_CONSTRUCTION");
  res.json({
    drawings: rows, count: rows.length,
    counts: {
      current: rows.length,
      forConstruction: forConstruction.length,
      draft: rows.filter((d) => d.status === "DRAFT").length,
      forComment: rows.filter((d) => d.status === "ISSUED_FOR_COMMENT").length,
    },
    means: "The current revision of each sheet. Superseded ones are kept and are " +
           "not here — but they are still what somebody on site may be holding.",
  });
}));

/* ====================================================================== *
 * PERMITS
 * ====================================================================== */


/**
 * POST /permits/:id/status
 *
 * Approving needs the authority's own reference and the date they decided.
 * Without the reference there is no way to ring them up about it, and a
 * permit nobody can look up is a permit nobody can prove.
 */
predevRoutes.post("/permits/:id/status", route(async (req, res) => {
  need(req, "update", "permits");
  const p = await ownPermit(req, req.params.id);

  const to = String(req.body?.status || "").toUpperCase();
  if (!PERMIT_NEXT[to]) {
    throw badRequest(`"${req.body?.status}" is not a permit state.`, Object.keys(PERMIT_NEXT));
  }
  const allowed = PERMIT_NEXT[p.status];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length
        ? `${p.ref} is ${p.status.toLowerCase().replace(/_/g, " ")} and can only move to ` +
          `${allowed.join(", ").toLowerCase().replace(/_/g, " ")}.`
        : `${p.ref} is ${p.status.toLowerCase()} and does not move again. ` +
          `A fresh application is a new permit.`);
  }

  const data = { status: to };
  let detail = text(req.body?.note, 4000);

  if (to === "SUBMITTED") {
    data.submittedOn = day(req.body?.submittedOn) || new Date();
    if (req.body?.reference) data.reference = text(req.body.reference, 160);
  }

  if (to === "APPROVED") {
    const reference = text(req.body?.reference, 160) || p.reference;
    if (!reference) {
      throw badRequest(
        "An approved permit needs the authority's own reference number. It is the only " +
        "handle that works when ringing them up, and a permit nobody can look up is a " +
        "permit nobody can prove.");
    }
    data.reference = reference;
    data.decidedOn = day(req.body?.decidedOn) || new Date();
    data.conditions = text(req.body?.conditions, 20000) || p.conditions;
    const expires = day(req.body?.expiresOn);
    if (expires) data.expiresOn = expires;
    detail = detail || `Granted as ${reference}.`;
  }

  if (to === "REFUSED") {
    const why = text(req.body?.reason, 4000);
    if (!why) throw badRequest("A refusal needs the authority's reason — it is what an appeal is built on.");
    data.refusedReason = why;
    data.decidedOn = day(req.body?.decidedOn) || new Date();
    detail = why;
  }

  if (to === "WITHDRAWN") {
    const why = text(req.body?.reason, 4000);
    if (!why) throw badRequest("Withdrawing an application needs a reason.");
    detail = why;
  }

  const [out] = await db.$transaction([
    db.permit.update({ where: { id: p.id }, data }),
    db.permitEvent.create({
      data: {
        orgId: req.actor.orgId, permitId: p.id, status: to,
        detail, byName: who(req),
      },
    }),
  ]);
  await audit(req, "permit.status", "permit", p.id, { ref: p.ref, to });

  res.json({
    permit: out,
    said: to === "APPROVED"
      ? `${p.ref} granted as ${out.reference}.` +
        (out.expiresOn
          ? ` It lapses on ${out.expiresOn.toISOString().slice(0, 10)} — after that it ` +
            `reads as expired whatever anybody types.`
          : " No expiry was recorded, so nothing here will warn you before it lapses.")
      : `${p.ref} is now ${to.toLowerCase().replace(/_/g, " ")}.`,
  });
}));

/**
 * GET /permits/blocking — what legally stops work today.
 *
 * Not a filter: blocking means required AND not currently granted, where
 * "currently" includes having lapsed. Three conditions a query string cannot
 * say together, and the only question anybody asks of a permit register.
 */
predevRoutes.get("/permits/blocking", route(async (req, res) => {
  need(req, "list", "permits");
  const orgId = req.actor.orgId;
  const now = new Date();
  const soon = new Date(Date.now() + 90 * 864e5);

  const all = await db.permit.findMany({
    where: { orgId },
    include: { project: { select: { id: true, name: true } } },
    orderBy: { expiresOn: "asc" },
    take: 500,
  });

  const lapsed = (p) => p.status === "APPROVED" && p.expiresOn && p.expiresOn < now;
  const granted = (p) => p.status === "APPROVED" && !lapsed(p);

  const blocking = all.filter((p) => p.blocking && !granted(p));
  const expiring = all.filter((p) => granted(p) && p.expiresOn && p.expiresOn < soon);

  res.json({
    permits: blocking,
    count: blocking.length,
    expiring,
    counts: {
      blocking: blocking.length,
      lapsed: all.filter(lapsed).length,
      granted: all.filter(granted).length,
      expiringWithin90Days: expiring.length,
      refused: all.filter((p) => p.status === "REFUSED").length,
    },
    means: blocking.length
      ? "Work that legally needs these cannot proceed. A permit that has lapsed counts " +
        "as not granted, whatever its column says."
      : "Nothing required is outstanding.",
  });
}));
