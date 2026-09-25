/* ====================================================================== *
 * THE LOOP A DEVELOPMENT IS RUN IN.
 *
 *   meeting → decision → task → owner → deadline → completion
 *
 * The resources create and edit these rows. Everything here MOVES them, and
 * every move does something beyond the row it is called on:
 *
 *   meetings    participants, hold, cancel, minutes — and minutes cannot be
 *               "sent" without saying who to, because a screen that reports a
 *               send nobody received is worse than no button
 *   decisions   a status that only moves forwards through a register, with an
 *               append-only history and an owner before it can be approved
 *   tasks       assign, reassign, checklist, comment, done, reopen — and
 *               finishing a parent refuses while its subtasks are open
 *
 * ── WHY NONE OF THESE IS A WRITABLE FIELD ──────────────────────────────
 *
 * A decision whose status is a column can be edited from OPEN to IMPLEMENTED
 * with no record of who approved it or when — which is the one thing a
 * decision register exists to prevent. A task marked done by PATCH leaves
 * `completedAt` empty, so "finished late" and "finished on time" become the
 * same fact. Each act below writes the consequences with the status, in one
 * place, or refuses.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { DECISION_NEXT } from "../domain/decisions.ts";
import { deliver, STATUS_FOR } from "../domain/messaging.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { numberFor } from "../http/resource.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const workflowRoutes = Router();

workflowRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req, act, label) {
  const why = whyNotArea(req.actor, "property", act, label);
  if (why) throw forbidden(why);
}

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

const who = (req) => req.view?.user?.name || req.view?.user?.email || "";

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

/*
 * ONE LOOKUP PER TABLE, WRITTEN OUT.
 *
 * This was a single `db[model].findFirst(...)` taking the model as a string,
 * which is tidy and defeats the scanner that proves every query is scoped to
 * one company: a reader cannot tell which table `db[model]` touches, and
 * neither can the test. Four functions that each name their table are worth
 * more than one that names none.
 */
async function ownMeeting(req, id, extra) {
  const row = await db.meeting.findFirst({ where: { id, orgId: req.actor.orgId }, ...(extra || {}) });
  if (!row) throw hidden();
  return row;
}
async function ownDecision(req, id) {
  const row = await db.decision.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownTask(req, id) {
  const row = await db.task.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownParty(req, id) {
  const row = await db.party.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}

const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/* ====================================================================== *
 * MEETINGS
 * ====================================================================== */

/** POST /meetings/:id/participants — who is in the room. */
workflowRoutes.post("/meetings/:id/participants", route(async (req, res) => {
  need(req, "update", "meetings");
  const meeting = await ownMeeting(req, req.params.id);
  const b = req.body || {};

  /* A party where they are one of the company's contacts, a name where they
     are not — an architect who is nobody's customer still attends. */
  let name = text(b.name, 160);
  let partyId = null;
  if (b.partyId) {
    const party = await ownParty(req, String(b.partyId));
    partyId = party.id;
    if (!name) name = party.name;
  }
  if (!name) throw badRequest("A participant needs a name, or a contact to take one from.");

  const participant = await db.meetingParticipant.create({
    data: {
      orgId: req.actor.orgId, meetingId: meeting.id, partyId, name,
      email: text(b.email, 200), role: text(b.role, 80),
      attended: !!b.attended,
    },
  });
  await audit(req, "meeting.participant.add", "meeting", meeting.id, { name });
  res.status(201).json({ participant });
}));

workflowRoutes.delete("/meetings/:id/participants/:pid", route(async (req, res) => {
  need(req, "update", "meetings");
  const meeting = await ownMeeting(req, req.params.id);
  const { count } = await db.meetingParticipant.deleteMany({
    where: { id: req.params.pid, meetingId: meeting.id, orgId: req.actor.orgId },
  });
  if (!count) throw hidden();
  await audit(req, "meeting.participant.remove", "meeting", meeting.id, {});
  res.json({ removed: true });
}));

/**
 * POST /meetings/:id/hold — it happened.
 *
 * Attendance is recorded here rather than guessed from the invitation list:
 * a decision taken in a meeting somebody missed is a different thing from one
 * they were part of, and that is asked months later.
 */
workflowRoutes.post("/meetings/:id/hold", route(async (req, res) => {
  need(req, "update", "meetings");
  const meeting = await ownMeeting(req, req.params.id);
  if (meeting.status === "CANCELLED") throw conflict("That meeting was cancelled.");
  if (meeting.status === "HELD") throw conflict("That meeting is already recorded as held.");

  const attended = Array.isArray(req.body?.attended) ? req.body.attended.map(String) : null;
  if (attended) {
    await db.meetingParticipant.updateMany({
      where: { orgId: req.actor.orgId, meetingId: meeting.id },
      data: { attended: false },
    });
    if (attended.length) {
      await db.meetingParticipant.updateMany({
        where: { orgId: req.actor.orgId, meetingId: meeting.id, id: { in: attended } },
        data: { attended: true },
      });
    }
  }

  const held = await db.meeting.update({
    where: { id: meeting.id },
    data: { status: "HELD", minutes: req.body?.minutes ? text(req.body.minutes, 20000) : meeting.minutes },
  });
  await audit(req, "meeting.hold", "meeting", meeting.id, { ref: meeting.ref });
  res.json({ meeting: held });
}));

workflowRoutes.post("/meetings/:id/cancel", route(async (req, res) => {
  need(req, "update", "meetings");
  const meeting = await ownMeeting(req, req.params.id);
  if (meeting.status === "HELD") {
    throw conflict("That meeting was held. A meeting that happened cannot be cancelled — its minutes are the record.");
  }
  const out = await db.meeting.update({ where: { id: meeting.id }, data: { status: "CANCELLED" } });
  await audit(req, "meeting.cancel", "meeting", meeting.id, { ref: meeting.ref });
  res.json({ meeting: out });
}));

/**
 * POST /meetings/:id/minutes — write them, and record that they went out.
 *
 * ── THE HONEST PART ────────────────────────────────────────────────────
 *
 * `send: true` does NOT claim delivery. It stamps that minutes were issued
 * and to whom, and returns the recipients it would reach. Sending an email is
 * the communications layer's job, and until a provider is wired this must not
 * report a send that did not happen — so it says what it did and no more.
 */
workflowRoutes.post("/meetings/:id/minutes", route(async (req, res) => {
  need(req, "update", "meetings");
  const meeting = await ownMeeting(req, req.params.id, {
    include: { participants: { select: { id: true, name: true, email: true, partyId: true } } },
  });

  const minutes = text(req.body?.minutes, 20000);
  if (!minutes) throw badRequest("Minutes need something in them.");

  const send = !!req.body?.send;
  const recipients = meeting.participants.filter((p) => p.email);
  if (send && !recipients.length) {
    throw badRequest(
      "No participant has an email address, so there is nobody to send the minutes to. " +
      "Add an address, or save the minutes without sending.");
  }

  const out = await db.meeting.update({
    where: { id: meeting.id },
    data: { minutes, ...(send ? { minutesSentAt: new Date() } : {}) },
  });

  /*
   * ISSUING MINUTES MAKES REAL MESSAGES.
   *
   * This used to stamp `minutesSentAt` and say in the response that delivery
   * was somebody else's job — which was honest, and was also a promise that
   * nothing kept. Now it hands each recipient to the communications layer,
   * which either finds a provider or does not, and either way there is a row
   * per person with its own state and its own reason.
   *
   * `minutesSentAt` therefore means "these were issued", not "these arrived".
   * Whether they arrived is answered per person in the outbox, because that
   * is the only place it can be answered honestly.
   */
  let dispatched = [];
  if (send) {
    dispatched = await issueMinutes(req, meeting, out, recipients);
  }

  await audit(req, send ? "meeting.minutes.issue" : "meeting.minutes.save", "meeting", meeting.id,
    { ref: meeting.ref, recipients: recipients.length });

  res.json({
    meeting: out,
    issued: send,
    recipients: recipients.map((p) => ({ name: p.name, email: p.email })),
    dispatches: dispatched.map((d) => ({ id: d.id, ref: d.ref, to: d.toAddress, status: d.status })),
    /*
     * Said plainly, and said by the thing that knows. `unconfigured` here is
     * not a failure to report — it is the ordinary state of a company that
     * has not connected a mail provider, and the sentence says exactly that
     * rather than implying the minutes are on their way.
     */
    delivery: send ? sentence(dispatched) : null,
  });
}));

/** One message per person, attempted, each recorded whatever happened. */
async function issueMinutes(req, meeting, updated, recipients) {
  const orgId = req.actor.orgId;
  const subject = `Minutes — ${meeting.title}`;
  const made = [];

  for (const p of recipients) {
    let row;
    try {
      row = await db.dispatch.create({
        data: {
          orgId, ref: await numberFor("dispatches", orgId), channel: "EMAIL",
          status: "QUEUED", toName: p.name, toAddress: p.email, partyId: p.partyId,
          subject, body: updated.minutes,
          projectId: meeting.projectId, meetingId: meeting.id,
          createdById: req.session.userId, createdByName: who(req),
        },
      });
    } catch (e) {
      /* One bad address must not cost the other nine their message. */
      console.error("minutes dispatch not created", meeting.ref, p.email, e.message);
      continue;
    }

    const result = await deliver("EMAIL", { to: p.email, subject, body: updated.minutes });
    const status = STATUS_FOR[result.outcome];
    const now = new Date();
    const [after] = await db.$transaction([
      db.dispatch.update({
        where: { id: row.id },
        data: {
          status, provider: result.provider, providerRef: result.providerRef,
          submittedAt: status === "SUBMITTED" ? now : null,
          failedAt: status === "FAILED" ? now : null,
          error: status === "FAILED" ? String(result.detail).slice(0, 1000) : "",
        },
      }),
      db.dispatchEvent.create({
        data: {
          orgId, dispatchId: row.id, status,
          detail: String(result.detail).slice(0, 1000), byName: who(req),
        },
      }),
    ]);
    made.push(after);
  }
  return made;
}

/** What actually happened, in one sentence, without flattering it. */
function sentence(dispatched) {
  const n = dispatched.length;
  if (!n) return "Nothing was created — no message could be prepared.";
  const queued = dispatched.filter((d) => d.status === "QUEUED").length;
  const submitted = dispatched.filter((d) => d.status === "SUBMITTED").length;
  const failed = dispatched.filter((d) => d.status === "FAILED").length;
  if (queued === n) {
    return `Recorded as issued, and ${n} message${n === 1 ? "" : "s"} queued. ` +
           `No mail provider is connected, so nothing has been sent yet.`;
  }
  return `${submitted} accepted by the provider` +
         (failed ? `, ${failed} refused` : "") +
         (queued ? `, ${queued} still queued` : "") +
         `. Delivery is confirmed separately in the outbox.`;
}

/* ====================================================================== *
 * DECISIONS
 * ====================================================================== */

/* The table lives in domain/decisions.js — the console reads it too. */

workflowRoutes.post("/decisions/:id/status", route(async (req, res) => {
  need(req, "update", "decisions");
  const orgId = req.actor.orgId;
  const decision = await ownDecision(req, req.params.id);

  const to = String(req.body?.status || "").trim().toUpperCase();
  if (!DECISION_NEXT[to]) {
    throw badRequest(`"${req.body?.status}" is not a decision state.`, Object.keys(DECISION_NEXT));
  }
  const allowed = DECISION_NEXT[decision.status];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length
        ? `A ${decision.status.toLowerCase().replace(/_/g, " ")} decision can only become ` +
          `${allowed.map((x) => x.toLowerCase().replace(/_/g, " ")).join(" or ")}.`
        : `That decision is closed. Record a new decision that supersedes it rather than reopening this one.`);
  }

  /* An approved decision with nobody accountable for it is the thing a
     register is supposed to stop. */
  if (to === "APPROVED" && !decision.ownerName && !text(req.body?.ownerName, 160)) {
    throw badRequest("An approved decision needs an owner — somebody accountable for it happening.");
  }
  if (to === "REJECTED" && !text(req.body?.note, 1000)) {
    throw badRequest("Say why it was rejected. The reasoning is the part that is worth keeping.");
  }

  const note = text(req.body?.note, 1000);
  const out = await db.$transaction(async (tx) => {
    const updated = await tx.decision.update({
      where: { id: decision.id },
      data: {
        status: to,
        ...(req.body?.ownerName ? { ownerName: text(req.body.ownerName, 160) } : {}),
        ...(req.body?.decision ? { decision: text(req.body.decision, 5000) } : {}),
        ...(["APPROVED", "REJECTED"].includes(to) ? { decidedOn: new Date() } : {}),
      },
    });
    await tx.decisionEvent.create({
      data: { orgId, decisionId: decision.id, status: to, note, byName: who(req) },
    });
    return updated;
  });

  await audit(req, "decision.status", "decision", decision.id,
    { ref: decision.ref, from: decision.status, to, note });
  res.json({ decision: out, from: decision.status, to });
}));

/* ====================================================================== *
 * TASKS
 * ====================================================================== */

/** POST /tasks/:id/assign — to somebody, by name or by account. */
workflowRoutes.post("/tasks/:id/assign", route(async (req, res) => {
  need(req, "update", "tasks");
  const task = await ownTask(req, req.params.id);
  const b = req.body || {};

  let assigneeId = null;
  let assigneeName = text(b.assigneeName, 160);

  if (b.assigneeId) {
    /* Only somebody who belongs to this company. Assigning to an account
       outside it would put a task on a stranger's list. */
    const member = await db.membership.findFirst({
      where: { orgId: req.actor.orgId, userId: String(b.assigneeId) },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!member) throw badRequest("That person is not a member of this company.");
    assigneeId = member.user.id;
    if (!assigneeName) assigneeName = member.user.name || member.user.email;
  }
  if (!assigneeId && !assigneeName) {
    throw badRequest("Assign it to somebody — a member of this company, or a name.");
  }

  const out = await db.task.update({
    where: { id: task.id }, data: { assigneeId, assigneeName },
  });
  await audit(req, task.assigneeName ? "task.reassign" : "task.assign", "task", task.id, {
    ref: task.ref, from: task.assigneeName || null, to: assigneeName,
  });
  res.json({ task: out, reassigned: !!task.assigneeName });
}));

/**
 * POST /tasks/:id/done
 *
 * A parent with open subtasks is refused. Finishing the parent would leave
 * children nobody is looking at on a list nobody opens.
 */
workflowRoutes.post("/tasks/:id/done", route(async (req, res) => {
  need(req, "update", "tasks");
  const task = await ownTask(req, req.params.id);
  if (task.status === "DONE") throw conflict("That task is already done.");
  if (task.status === "CANCELLED") throw conflict("That task was cancelled. Reopen it first if it still needs doing.");

  const open = await db.task.count({
    where: { orgId: req.actor.orgId, parentId: task.id, status: { notIn: ["DONE", "CANCELLED"] } },
  });
  if (open) {
    throw conflict(`${open} subtask${open === 1 ? " is" : "s are"} still open. Finish or cancel those first.`);
  }

  const out = await db.task.update({
    where: { id: task.id },
    data: { status: "DONE", completedAt: new Date() },
  });
  const late = task.dueOn && new Date() > new Date(task.dueOn);
  await audit(req, "task.done", "task", task.id, { ref: task.ref, late: !!late });
  res.json({ task: out, late: !!late });
}));

workflowRoutes.post("/tasks/:id/reopen", route(async (req, res) => {
  need(req, "update", "tasks");
  const task = await ownTask(req, req.params.id);
  if (task.status !== "DONE" && task.status !== "CANCELLED") {
    throw conflict("That task is already open.");
  }
  /* completedAt is cleared, because a task that was reopened was not
     completed — keeping the stamp would make it finished and unfinished. */
  const out = await db.task.update({
    where: { id: task.id }, data: { status: "TODO", completedAt: null },
  });
  await audit(req, "task.reopen", "task", task.id, { ref: task.ref });
  res.json({ task: out });
}));

/* ---- checklist ---- */

workflowRoutes.post("/tasks/:id/checklist", route(async (req, res) => {
  need(req, "update", "tasks");
  const task = await ownTask(req, req.params.id);
  const t = text(req.body?.text, 400);
  if (!t) throw badRequest("A checklist item needs something in it.");

  const last = await db.taskChecklistItem.findFirst({
    where: { orgId: req.actor.orgId, taskId: task.id },
    orderBy: { position: "desc" }, select: { position: true },
  });
  const item = await db.taskChecklistItem.create({
    data: {
      orgId: req.actor.orgId, taskId: task.id, text: t,
      position: (last?.position ?? -1) + 1,
    },
  });
  res.status(201).json({ item });
}));

workflowRoutes.post("/tasks/:id/checklist/:itemId/toggle", route(async (req, res) => {
  need(req, "update", "tasks");
  const task = await ownTask(req, req.params.id);
  const item = await db.taskChecklistItem.findFirst({
    where: { id: req.params.itemId, taskId: task.id, orgId: req.actor.orgId },
  });
  if (!item) throw hidden();

  const out = await db.taskChecklistItem.update({
    where: { id: item.id },
    data: { done: !item.done, doneAt: item.done ? null : new Date() },
  });
  res.json({ item: out });
}));

/* ---- comments ---- */

workflowRoutes.post("/tasks/:id/comments", route(async (req, res) => {
  need(req, "update", "tasks");
  const task = await ownTask(req, req.params.id);
  const body = text(req.body?.body, 4000);
  if (!body) throw badRequest("A comment needs something in it.");

  const comment = await db.taskComment.create({
    data: { orgId: req.actor.orgId, taskId: task.id, body, byName: who(req) },
  });
  await audit(req, "task.comment", "task", task.id, { ref: task.ref });
  res.status(201).json({ comment });
}));

/* ====================================================================== *
 * WHAT IS ON SOMEBODY'S PLATE
 * ====================================================================== */

/**
 * GET /tasks/mine?view=…
 *
 * The six lists a person actually works from. Computed here rather than by a
 * screen filtering everything it happens to have loaded — a task list that is
 * only as complete as the last page fetched is the kind that loses things.
 */
workflowRoutes.get("/tasks/mine", route(async (req, res) => {
  need(req, "list", "tasks");
  const orgId = req.actor.orgId;
  const me = req.session.userId;
  const myName = who(req);

  const view = String(req.query.view || "assigned").toLowerCase();
  const open = { notIn: ["DONE", "CANCELLED"] };

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const weekOut = new Date(Date.now() + 7 * 864e5);

  /* Assigned "to me" means the account OR the name, because plenty of people
     are assigned work before they ever sign in. */
  const mine = { OR: [{ assigneeId: me }, ...(myName ? [{ assigneeName: myName }] : [])] };

  const WHERE = {
    assigned: { orgId, ...mine, status: open },
    created: { orgId, createdById: me, status: open },
    overdue: { orgId, ...mine, status: open, dueOn: { lt: startOfDay } },
    today: { orgId, ...mine, status: open, dueOn: { gte: startOfDay, lte: endOfDay } },
    upcoming: { orgId, ...mine, status: open, dueOn: { gt: endOfDay, lte: weekOut } },
    all: { orgId, status: open },
  };
  if (!WHERE[view]) {
    throw badRequest(`"${req.query.view}" is not a task view.`, Object.keys(WHERE));
  }

  const tasks = await db.task.findMany({
    where: WHERE[view],
    orderBy: [{ dueOn: "asc" }, { priority: "desc" }],
    take: 200,
    include: {
      project: { select: { id: true, name: true } },
      meeting: { select: { id: true, ref: true } },
      decision: { select: { id: true, ref: true } },
      checklist: { select: { id: true, done: true } },
    },
  });

  const counts = {};
  for (const [name, where] of Object.entries(WHERE)) {
    counts[name] = await db.task.count({ where });
  }

  res.json({
    view,
    tasks: tasks.map((t) => ({
      ...t,
      checklistDone: t.checklist.filter((c) => c.done).length,
      checklistTotal: t.checklist.length,
      overdue: !!(t.dueOn && new Date(t.dueOn) < startOfDay),
    })),
    count: tasks.length,
    counts,
  });
}));
