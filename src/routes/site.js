/* ====================================================================== *
 * THE FIVE THINGS A SITE IS RUN ON.
 *
 * Creating and editing these rows is the resource framework's job. Everything
 * here MOVES them, and every move is a rule that a writable column could not
 * express:
 *
 *   RFI         an unanswered question cannot be closed. The whole point of
 *               the register is that open questions stop work, and a close
 *               button that skipped the answer would empty it on demand.
 *   Submittal   revise-and-resubmit OPENS THE NEXT REVISION rather than
 *               editing this one. Somebody built to rev 1 and will need to
 *               know what rev 1 said.
 *   Inspection  passing it with defects raises them, in the same transaction.
 *               An inspection that "passed with defects" and produced no
 *               defects is an inspection that passed.
 *   Defect      it cannot be verified by whoever fixed it. Two names or none.
 *   Site diary  one per project per day, never for a day that has not
 *               happened, and locked once the day is over — corrections are
 *               appended as amendments, because a diary that can be rewritten
 *               months later is worth nothing in the dispute it exists for.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { aliasesFor } from "../domain/console-map.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { numberFor } from "../http/resource.js";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const siteRoutes = Router();

siteRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

/* The site registers are property work — the same area the programme,
   phases and milestones live in. */
function need(req, act, label) {
  const why = whyNotArea(req.actor, "property", act, label);
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

const who = (req) => req.view?.user?.name || req.view?.user?.email || "";
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/**
 * THE CONSOLE'S OWN NAMES FOR THESE FIELDS.
 *
 * The console posts `{ project, on, work, labour }` because its 135 screens
 * are full of those abbreviations; this service calls them `projectId`,
 * `workDone`, `labourCount`. The resource framework translates through
 * console-map for every generated create, and a HAND-WRITTEN create is
 * outside it — so this one read `projectId` and the console's form was
 * refused for a field it had definitely filled in.
 *
 * Found by console-forms.test.js, which posts every form exactly as the
 * console does. Doing the same mapping here rather than inventing a second
 * naming keeps the two creates indistinguishable from outside.
 */
const DIARY_ALIASES = aliasesFor("site-diary");

function consoleNames(body) {
  const out = { ...(body || {}) };
  for (const [from, to] of Object.entries(DIARY_ALIASES)) {
    if (out[from] !== undefined && out[to] === undefined) out[to] = out[from];
  }
  return out;
}

/** A date sent as a day, read as that day and not as the epoch. */
function day(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/** Midnight of a date, so "one diary per day" is a comparison that works. */
function midnight(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
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

/* One lookup per table, written out, so the scoping scanner can read them. */
async function ownRfi(req, id) {
  const row = await db.rfi.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownSubmittal(req, id) {
  const row = await db.submittal.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownInspection(req, id) {
  const row = await db.inspection.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownDefect(req, id) {
  const row = await db.defect.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownDiary(req, id) {
  const row = await db.siteDiary.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}

/** The append-only line every move leaves. One table, five registers. */
function event(req, entity, ids, action, detail) {
  return db.siteEvent.create({
    data: {
      orgId: req.actor.orgId, entity, action,
      detail: text(detail, 1000), byName: who(req), ...ids,
    },
  });
}

/* ====================================================================== *
 * RFIs
 * ====================================================================== */

/**
 * POST /rfis/:id/answer
 *
 * An answer is text, a name and a date together. An RFI whose answer is a
 * writable column can be answered by nobody, on no date, with nothing — which
 * is indistinguishable from an RFI that was never answered at all.
 */
siteRoutes.post("/rfis/:id/answer", route(async (req, res) => {
  need(req, "update", "rfis");
  const rfi = await ownRfi(req, req.params.id);

  if (rfi.status === "VOID") {
    throw conflict(`${rfi.ref} was withdrawn. Raise a new question rather than answering a dead one.`);
  }
  const answer = text(req.body?.answer, 20000);
  if (!answer) throw badRequest("An answer needs something in it.");

  const by = text(req.body?.answeredBy, 160) || who(req);
  const now = new Date();
  const [out] = await db.$transaction([
    db.rfi.update({
      where: { id: rfi.id },
      data: {
        status: "ANSWERED", answer, answeredOn: now, answeredBy: by,
        costImpact: text(req.body?.costImpact, 500) || rfi.costImpact,
        timeImpact: text(req.body?.timeImpact, 500) || rfi.timeImpact,
      },
    }),
    event(req, "rfi", { rfiId: rfi.id }, "ANSWERED", `Answered by ${by}.`),
  ]);
  await audit(req, "rfi.answer", "rfi", rfi.id, { ref: rfi.ref });

  /* Late is a fact about the answer, not about the question, so it is worked
     out here rather than stored and left to go stale. */
  const late = rfi.dueOn ? now > rfi.dueOn : false;
  res.json({
    rfi: out, late,
    said: late
      ? `${rfi.ref} answered, after the date it was needed.`
      : `${rfi.ref} answered.`,
  });
}));

/** POST /rfis/:id/close — only once there is an answer to close on. */
siteRoutes.post("/rfis/:id/close", route(async (req, res) => {
  need(req, "update", "rfis");
  const rfi = await ownRfi(req, req.params.id);

  if (rfi.status === "OPEN") {
    throw conflict(
      `${rfi.ref} has not been answered. An RFI register whose questions can be ` +
      `closed unanswered is a register that empties itself. Answer it, or void it ` +
      `if the question stopped mattering.`);
  }
  if (rfi.status === "CLOSED") throw conflict(`${rfi.ref} is already closed.`);

  const [out] = await db.$transaction([
    db.rfi.update({ where: { id: rfi.id }, data: { status: "CLOSED" } }),
    event(req, "rfi", { rfiId: rfi.id }, "CLOSED", text(req.body?.note, 1000)),
  ]);
  await audit(req, "rfi.close", "rfi", rfi.id, { ref: rfi.ref });
  res.json({ rfi: out });
}));

/** POST /rfis/:id/void — the question stopped mattering, and we say why. */
siteRoutes.post("/rfis/:id/void", route(async (req, res) => {
  need(req, "update", "rfis");
  const rfi = await ownRfi(req, req.params.id);
  if (rfi.status === "CLOSED") throw conflict(`${rfi.ref} is closed. It cannot be withdrawn afterwards.`);

  const reason = text(req.body?.reason, 1000);
  if (!reason) {
    throw badRequest("Withdrawing a question needs a reason — it is the only record of why it went away.");
  }
  const [out] = await db.$transaction([
    db.rfi.update({ where: { id: rfi.id }, data: { status: "VOID" } }),
    event(req, "rfi", { rfiId: rfi.id }, "VOID", reason),
  ]);
  await audit(req, "rfi.void", "rfi", rfi.id, { ref: rfi.ref });
  res.json({ rfi: out });
}));

/**
 * GET /rfis/overdue — the question the register exists to answer.
 *
 * Not a filter on the list: overdue is OPEN and past its date, which is two
 * conditions a query string cannot say together, and is what somebody means
 * every single time they ask what is outstanding.
 */
siteRoutes.get("/rfis/overdue", route(async (req, res) => {
  need(req, "list", "rfis");
  const orgId = req.actor.orgId;
  const now = new Date();
  const [rows, open, overdue, answered] = await Promise.all([
    db.rfi.findMany({
      where: { orgId, status: "OPEN", dueOn: { lt: now } },
      orderBy: { dueOn: "asc" }, take: 200,
      include: { project: { select: { id: true, name: true } } },
    }),
    db.rfi.count({ where: { orgId, status: "OPEN" } }),
    db.rfi.count({ where: { orgId, status: "OPEN", dueOn: { lt: now } } }),
    db.rfi.count({ where: { orgId, status: "ANSWERED" } }),
  ]);
  res.json({
    rfis: rows, count: rows.length,
    counts: { open, overdue, answered, awaitingClose: answered },
  });
}));

/* ====================================================================== *
 * SUBMITTALS
 * ====================================================================== */

const SUBMITTAL_DECIDED = ["APPROVED", "APPROVED_AS_NOTED", "REVISE_RESUBMIT", "REJECTED"];

/** POST /submittals/:id/submit — DRAFT becomes a thing somebody must look at. */
siteRoutes.post("/submittals/:id/submit", route(async (req, res) => {
  need(req, "update", "submittals");
  const s = await ownSubmittal(req, req.params.id);
  if (s.status !== "DRAFT") {
    throw conflict(`${s.ref} has already been submitted.`);
  }
  const [out] = await db.$transaction([
    db.submittal.update({
      where: { id: s.id },
      data: { status: "SUBMITTED", submittedOn: new Date() },
    }),
    event(req, "submittal", { submittalId: s.id }, "SUBMITTED", ""),
  ]);
  await audit(req, "submittal.submit", "submittal", s.id, { ref: s.ref });
  res.json({ submittal: out });
}));

/**
 * POST /submittals/:id/review
 *
 * The four outcomes, and the one that is not an outcome at all:
 * REVISE_RESUBMIT does not end this submittal, it opens the next revision as
 * its own row, chained to this one. Somebody built to rev 1 and will need to
 * know what rev 1 said, so rev 1 stays exactly as it was reviewed.
 */
siteRoutes.post("/submittals/:id/review", route(async (req, res) => {
  need(req, "update", "submittals");
  const s = await ownSubmittal(req, req.params.id);

  if (s.status === "DRAFT") {
    throw conflict(`${s.ref} has not been submitted yet. There is nothing to review.`);
  }
  if (SUBMITTAL_DECIDED.includes(s.status)) {
    throw conflict(
      `${s.ref} was already reviewed as ${s.status.toLowerCase().replace(/_/g, " ")}. ` +
      `A second opinion on the same revision is a new revision.`);
  }

  const outcome = String(req.body?.outcome || "").toUpperCase();
  if (!SUBMITTAL_DECIDED.includes(outcome)) {
    throw badRequest(`"${req.body?.outcome}" is not a review outcome.`, SUBMITTAL_DECIDED);
  }
  const reviewer = text(req.body?.reviewerName, 160) || who(req);
  const comments = text(req.body?.comments, 20000);

  /* The two outcomes that send it back must say what is wrong with it. A
     rejection with no comments is a contractor guessing. */
  if (["REVISE_RESUBMIT", "REJECTED"].includes(outcome) && !comments) {
    throw badRequest(
      "Sending a submittal back needs comments — otherwise the contractor is guessing " +
      "at what to change.");
  }

  const now = new Date();
  const [out] = await db.$transaction([
    db.submittal.update({
      where: { id: s.id },
      data: { status: outcome, reviewedOn: now, reviewerName: reviewer, comments },
    }),
    event(req, "submittal", { submittalId: s.id }, outcome, `Reviewed by ${reviewer}.`),
  ]);

  /* REVISE_RESUBMIT opens the next revision. Done after the review is
     recorded, so a failure here leaves a reviewed rev 1 rather than an
     unreviewed one with a mysterious rev 2 beside it. */
  let nextRev = null;
  if (outcome === "REVISE_RESUBMIT") {
    nextRev = await db.submittal.create({
      data: {
        orgId: req.actor.orgId, ref: await numberFor("submittals", req.actor.orgId),
        projectId: s.projectId, title: s.title, specRef: s.specRef,
        discipline: s.discipline, contractor: s.contractor,
        status: "DRAFT", revision: s.revision + 1, previousId: s.id,
        dueOn: s.dueOn,
        createdById: req.session.userId, createdByName: who(req),
      },
    });
    await event(req, "submittal", { submittalId: nextRev.id }, "OPENED",
      `Revision ${nextRev.revision}, after ${s.ref} was sent back.`);
  }

  await audit(req, "submittal.review", "submittal", s.id, { ref: s.ref, outcome });
  res.json({
    submittal: out,
    nextRevision: nextRev,
    said: nextRev
      ? `${s.ref} sent back. ${nextRev.ref} opened as revision ${nextRev.revision}.`
      : `${s.ref} ${outcome.toLowerCase().replace(/_/g, " ")}.`,
  });
}));

/* ====================================================================== *
 * INSPECTIONS AND DEFECTS
 * ====================================================================== */

const INSPECTION_RESULTS = ["PASSED", "PASSED_WITH_DEFECTS", "FAILED"];

/**
 * POST /inspections/:id/record
 *
 * The result and the defects it found, together, in one transaction. An
 * inspection recorded as PASSED_WITH_DEFECTS that produced no defects is an
 * inspection that passed, and letting the two be separate requests is how a
 * site ends up with a list of inspections nobody can act on.
 */
siteRoutes.post("/inspections/:id/record", route(async (req, res) => {
  need(req, "update", "inspections");
  const ins = await ownInspection(req, req.params.id);

  if (ins.status !== "SCHEDULED") {
    throw conflict(
      `${ins.ref} was already recorded as ${ins.status.toLowerCase().replace(/_/g, " ")}. ` +
      `Re-inspecting is a new inspection, so the first result stays readable.`);
  }

  const result = String(req.body?.result || "").toUpperCase();
  if (!INSPECTION_RESULTS.includes(result)) {
    throw badRequest(`"${req.body?.result}" is not an inspection result.`, INSPECTION_RESULTS);
  }
  const inspector = text(req.body?.inspectorName, 160) || who(req);
  const found = Array.isArray(req.body?.defects) ? req.body.defects : [];

  if (result === "PASSED_WITH_DEFECTS" && !found.length) {
    throw badRequest(
      "Passed with defects, and no defects. Either list what was found, or record it as passed.");
  }
  if (result === "FAILED" && !found.length && !text(req.body?.notes, 20000)) {
    throw badRequest("A failed inspection needs either the defects found or a note saying why.");
  }

  const orgId = req.actor.orgId;
  const now = new Date();

  /* The numbers first: nextNumber is a counter upsert and cannot run inside
     the transaction below without holding it open for each one. */
  const refs = [];
  for (let i = 0; i < found.length; i += 1) refs.push(await numberFor("defects", orgId));

  const [out] = await db.$transaction([
    db.inspection.update({
      where: { id: ins.id },
      data: { status: result, inspectedOn: now, inspectorName: inspector,
              notes: text(req.body?.notes, 20000) || ins.notes },
    }),
    ...(found.length ? [db.defect.createMany({
      data: found.map((d, i) => ({
        orgId, ref: refs[i], projectId: ins.projectId, unitId: ins.unitId,
        inspectionId: ins.id,
        title: text(d?.title, 300) || "Untitled defect",
        description: text(d?.description, 20000),
        location: text(d?.location, 300) || ins.area,
        trade: text(d?.trade, 160),
        severity: ["MINOR", "MAJOR", "CRITICAL"].includes(String(d?.severity).toUpperCase())
          ? String(d.severity).toUpperCase() : "MINOR",
        assigneeName: text(d?.assigneeName, 160),
        dueOn: day(d?.dueOn),
        createdById: req.session.userId, createdByName: who(req),
      })),
    })] : []),
    event(req, "inspection", { inspectionId: ins.id }, result,
      `${inspector} — ${found.length} defect${found.length === 1 ? "" : "s"} raised.`),
  ]);

  const defects = await db.defect.findMany({
    where: { orgId, inspectionId: ins.id }, orderBy: { createdAt: "asc" },
  });
  await audit(req, "inspection.record", "inspection", ins.id,
    { ref: ins.ref, result, defects: defects.length });

  res.json({
    inspection: out, defects, raised: found.length,
    said: found.length
      ? `${ins.ref} ${result.toLowerCase().replace(/_/g, " ")}. ${found.length} defect${
          found.length === 1 ? "" : "s"} raised and waiting for somebody.`
      : `${ins.ref} ${result.toLowerCase()}.`,
  });
}));

/** POST /defects/:id/assign — somebody owns it, or nobody does. */
siteRoutes.post("/defects/:id/assign", route(async (req, res) => {
  need(req, "update", "defects");
  const d = await ownDefect(req, req.params.id);
  const to = text(req.body?.assigneeName, 160);
  if (!to) throw badRequest("A defect is assigned to somebody by name.");

  const [out] = await db.$transaction([
    db.defect.update({
      where: { id: d.id },
      data: { assigneeName: to, dueOn: day(req.body?.dueOn) || d.dueOn,
              status: d.status === "OPEN" ? "IN_PROGRESS" : d.status },
    }),
    event(req, "defect", { defectId: d.id }, "ASSIGNED",
      d.assigneeName ? `Reassigned from ${d.assigneeName} to ${to}.` : `Assigned to ${to}.`),
  ]);
  await audit(req, "defect.assign", "defect", d.id, { ref: d.ref, to });
  res.json({ defect: out, reassigned: !!d.assigneeName });
}));

/** POST /defects/:id/fixed — somebody says it is done. Not the end. */
siteRoutes.post("/defects/:id/fixed", route(async (req, res) => {
  need(req, "update", "defects");
  const d = await ownDefect(req, req.params.id);
  if (["VERIFIED", "CLOSED", "REJECTED"].includes(d.status)) {
    throw conflict(`${d.ref} is ${d.status.toLowerCase()}. It is not waiting for a fix.`);
  }
  const by = text(req.body?.fixedByName, 160) || who(req);
  const [out] = await db.$transaction([
    db.defect.update({
      where: { id: d.id },
      data: { status: "FIXED", fixedByName: by, fixedOn: new Date() },
    }),
    event(req, "defect", { defectId: d.id }, "FIXED",
      `${by} says it is done. Still needs verifying.`),
  ]);
  await audit(req, "defect.fixed", "defect", d.id, { ref: d.ref, by });
  res.json({
    defect: out,
    /* Said out loud, because FIXED is the state everybody reads as finished. */
    said: `${d.ref} marked fixed by ${by}. It is not closed until somebody else verifies it.`,
  });
}));

/**
 * POST /defects/:id/verify
 *
 * THE RULE THIS WHOLE REGISTER EXISTS FOR.
 *
 * A defect signed off by whoever fixed it is not signed off. It is the same
 * person saying the same thing twice, and a snagging list where that counts
 * is a snagging list that empties itself on the last day before handover.
 */
siteRoutes.post("/defects/:id/verify", route(async (req, res) => {
  need(req, "update", "defects");
  const d = await ownDefect(req, req.params.id);

  if (d.status !== "FIXED") {
    throw conflict(
      `${d.ref} is ${d.status.toLowerCase().replace(/_/g, " ")}. ` +
      `Only a defect somebody has fixed can be verified.`);
  }
  const by = text(req.body?.verifiedByName, 160) || who(req);
  if (by.toLowerCase() === String(d.fixedByName || "").toLowerCase()) {
    throw conflict(
      `${d.fixedByName} fixed this one, so ${d.fixedByName} cannot also verify it. ` +
      `A defect signed off by whoever caused it is not signed off.`);
  }

  const [out] = await db.$transaction([
    db.defect.update({
      where: { id: d.id },
      data: { status: "VERIFIED", verifiedByName: by, verifiedOn: new Date() },
    }),
    event(req, "defect", { defectId: d.id }, "VERIFIED", `Checked by ${by}.`),
  ]);
  await audit(req, "defect.verify", "defect", d.id, { ref: d.ref, by });
  res.json({ defect: out });
}));

/** POST /defects/:id/reject — it was not a defect, and here is why. */
siteRoutes.post("/defects/:id/reject", route(async (req, res) => {
  need(req, "update", "defects");
  const d = await ownDefect(req, req.params.id);
  if (["VERIFIED", "CLOSED"].includes(d.status)) {
    throw conflict(`${d.ref} is ${d.status.toLowerCase()} — it is too late to say it was never a defect.`);
  }
  const reason = text(req.body?.reason, 1000);
  if (!reason) {
    throw badRequest("Rejecting a defect needs a reason. Somebody raised it in good faith.");
  }
  const [out] = await db.$transaction([
    db.defect.update({ where: { id: d.id }, data: { status: "REJECTED" } }),
    event(req, "defect", { defectId: d.id }, "REJECTED", reason),
  ]);
  await audit(req, "defect.reject", "defect", d.id, { ref: d.ref });
  res.json({ defect: out });
}));

/**
 * GET /defects/outstanding — what stands between here and handover.
 *
 * Grouped by severity, because "142 defects" is not a number anybody can act
 * on and "3 critical, 20 major" is.
 */
siteRoutes.get("/defects/outstanding", route(async (req, res) => {
  need(req, "list", "defects");
  const orgId = req.actor.orgId;
  const open = { in: ["OPEN", "IN_PROGRESS", "FIXED"] };
  const [rows, critical, major, minor, awaiting, late] = await Promise.all([
    db.defect.findMany({
      where: { orgId, status: open },
      orderBy: [{ severity: "desc" }, { dueOn: "asc" }], take: 300,
      include: {
        project: { select: { id: true, name: true } },
        unit: { select: { id: true, ref: true } },
      },
    }),
    db.defect.count({ where: { orgId, status: open, severity: "CRITICAL" } }),
    db.defect.count({ where: { orgId, status: open, severity: "MAJOR" } }),
    db.defect.count({ where: { orgId, status: open, severity: "MINOR" } }),
    /* Fixed and waiting for somebody else to look. The queue that silently
       grows when a site is busy. */
    db.defect.count({ where: { orgId, status: "FIXED" } }),
    db.defect.count({ where: { orgId, status: open, dueOn: { lt: new Date() } } }),
  ]);
  res.json({
    defects: rows, count: rows.length,
    counts: { critical, major, minor, awaitingVerification: awaiting, overdue: late },
  });
}));

/* ====================================================================== *
 * THE SITE DIARY
 * ====================================================================== */

/**
 * POST /site-diary
 *
 * Its own create, not the framework's, because three of its rules are about
 * WHICH DAY it is for and the framework has no opinion about that:
 *
 *   one per project per day     two accounts of one Tuesday is not evidence
 *   never for a future day      you cannot record what has not happened
 *   locked once the day is over corrections are appended, never edited in
 */
siteRoutes.post("/site-diary", route(async (req, res) => {
  need(req, "create", "site-diary");
  const orgId = req.actor.orgId;
  const b = consoleNames(req.body);

  const projectId = text(b.projectId, 60);
  if (!projectId) throw badRequest("A site diary belongs to one development.");
  const project = await db.project.findFirst({ where: { id: projectId, orgId } });
  if (!project) throw badRequest("That development is not one of yours.");

  const on = midnight(day(b.on) || new Date());
  const today = midnight(new Date());
  if (on > today) {
    throw badRequest(
      "A site diary records a day that has happened. That one has not yet.");
  }

  const already = await db.siteDiary.findFirst({ where: { orgId, projectId, on } });
  if (already) {
    throw conflict(
      `${already.ref} already records ${on.toISOString().slice(0, 10)} for this development. ` +
      `Two accounts of one day is not a record — amend that one instead.`);
  }

  const diary = await db.siteDiary.create({
    data: {
      orgId, ref: await numberFor("site-diary", orgId), projectId, on,
      weather: text(b.weather, 160), temperature: text(b.temperature, 40),
      labourCount: Number.isFinite(Number(b.labourCount)) ? Math.max(0, Math.trunc(Number(b.labourCount))) : 0,
      contractors: text(b.contractors, 4000), equipment: text(b.equipment, 4000),
      workDone: text(b.workDone, 20000), delays: text(b.delays, 20000),
      visitors: text(b.visitors, 4000), safetyNotes: text(b.safetyNotes, 20000),
      materials: text(b.materials, 20000),
      /* A diary for a day that is already over is locked as it is written.
         There is no window in which yesterday's page is editable. */
      lockedAt: on < today ? new Date() : null,
      createdById: req.session.userId, createdByName: who(req),
    },
  });
  await event(req, "diary", { diaryId: diary.id }, "WRITTEN", "");
  await audit(req, "diary.write", "siteDiary", diary.id, { ref: diary.ref });

  res.status(201).json({
    /*
     * `siteDiary`, NOT `diary` — the same key the framework's own GET uses.
     * Two names for one thing means the console reads `diary` from a create
     * and `siteDiary` from a read, and finds undefined on whichever it gets
     * wrong.
     */
    siteDiary: diary,
    locked: !!diary.lockedAt,
    said: diary.lockedAt
      ? `${diary.ref} recorded for a day that is already over, so it is locked. ` +
        `Anything else goes on as an amendment.`
      : `${diary.ref} recorded. It can be edited until the day is out.`,
  });
}));

/**
 * PATCH /site-diary/:id — while the day is still running, and not after.
 */
siteRoutes.patch("/site-diary/:id", route(async (req, res) => {
  need(req, "update", "site-diary");
  const diary = await ownDiary(req, req.params.id);

  /* Locked on write for a past day; locked here the moment the day is over,
     so a page left open in a browser overnight cannot rewrite yesterday. */
  const stale = midnight(diary.on) < midnight(new Date());
  if (diary.lockedAt || stale) {
    if (!diary.lockedAt) {
      await db.siteDiary.update({ where: { id: diary.id }, data: { lockedAt: new Date() } });
    }
    throw conflict(
      `${diary.ref} records a day that is over and is now fixed. ` +
      `Add an amendment — both what was written and what you correct will stay readable.`);
  }

  const b = consoleNames(req.body);
  const data = {};
  for (const [k, max] of [["weather", 160], ["temperature", 40], ["contractors", 4000],
                          ["equipment", 4000], ["workDone", 20000], ["delays", 20000],
                          ["visitors", 4000], ["safetyNotes", 20000], ["materials", 20000]]) {
    if (b[k] !== undefined) data[k] = text(b[k], max);
  }
  if (b.labourCount !== undefined) {
    data.labourCount = Math.max(0, Math.trunc(Number(b.labourCount) || 0));
  }
  if (!Object.keys(data).length) throw badRequest("Nothing to change.");

  const [out] = await db.$transaction([
    db.siteDiary.update({ where: { id: diary.id }, data }),
    event(req, "diary", { diaryId: diary.id }, "EDITED", Object.keys(data).join(", ")),
  ]);
  await audit(req, "diary.edit", "siteDiary", diary.id, { ref: diary.ref });
  res.json({ siteDiary: out });
}));

/**
 * POST /site-diary/:id/amend
 *
 * The only way a closed day changes. It does not change: the amendment is
 * appended beside it, and both survive. That is the difference between a
 * correction and a rewrite, and it is the whole reason anybody keeps a diary.
 */
siteRoutes.post("/site-diary/:id/amend", route(async (req, res) => {
  need(req, "update", "site-diary");
  const diary = await ownDiary(req, req.params.id);

  const note = text(req.body?.note, 20000);
  if (!note) throw badRequest("An amendment needs to say what is being corrected.");

  await event(req, "diary", { diaryId: diary.id }, "AMENDED", note);
  await audit(req, "diary.amend", "siteDiary", diary.id, { ref: diary.ref });

  const events = await db.siteEvent.findMany({
    where: { orgId: req.actor.orgId, diaryId: diary.id }, orderBy: { at: "asc" },
  });
  res.json({
    siteDiary: diary, amendments: events.filter((e) => e.action === "AMENDED"),
    said: `Recorded as an amendment to ${diary.ref}. The original entry is unchanged.`,
  });
}));
