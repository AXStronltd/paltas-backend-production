/* ====================================================================== *
 * HANDING IT OVER, WHO WAS ON IT, AND WHAT A SALE ACTUALLY DID.
 *
 * ── THE ONE RULE THIS FILE EXISTS FOR ──────────────────────────────────
 *
 * A flat cannot be handed over with a CRITICAL or MAJOR defect still open
 * against it.
 *
 * That is the moment a snagging list either meant something or did not, and
 * it is also the moment the pressure to ignore it is greatest: the buyer is
 * in the car park, the keys are in somebody's hand, and the defect is "being
 * sorted". So the check reads the SAME defect register the site uses —
 * actual rows, not a checkbox somebody ticks — and it names them.
 *
 * Minor defects do NOT block. They are what a snagging list at handover is
 * for, and refusing over a scratched worktop would teach people to lie about
 * severity, which costs more than the scratch.
 *
 * ── AND WHY A CONTRACT MOVES THROUGH HERE ──────────────────────────────
 *
 * Because completing a sale and handing over a flat are the same afternoon,
 * and the rules interlock: a contract is not complete while money is
 * outstanding, and a handover is not complete while the flat is not fit to
 * take. Splitting them across two files means the second one forgets.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { whyNotArea } from "../domain/access.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { numberFor } from "../http/resource.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const handoverRoutes = Router();

handoverRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req, act, label) {
  const why = whyNotArea(req.actor, "property", act, label);
  if (why) throw forbidden(why);
}
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

async function ownHandover(req, id) {
  const row = await db.handover.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownItem(req, id) {
  const row = await db.handoverItem.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownContract(req, id) {
  const row = await db.contract.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownMember(req, id) {
  const row = await db.projectMember.findFirst({ where: { id, orgId: req.actor.orgId } });
  if (!row) throw hidden();
  return row;
}

/* ====================================================================== *
 * WHAT STANDS IN THE WAY
 * ====================================================================== */

/**
 * The defects that would stop a handover, read from the register itself.
 *
 * Critical and major only. A minor defect is what a snagging list at handover
 * is FOR, and refusing over a scratched worktop teaches people to record
 * everything as minor — which costs far more than the scratch.
 */
async function blockingDefects(orgId, unitId) {
  if (!unitId) return [];
  return db.defect.findMany({
    where: {
      orgId, unitId,
      severity: { in: ["CRITICAL", "MAJOR"] },
      status: { in: ["OPEN", "IN_PROGRESS", "FIXED"] },
    },
    select: { id: true, ref: true, title: true, severity: true, status: true },
    orderBy: { severity: "desc" },
  });
}

/** GET /handovers/:id/readiness — what still stands in the way, before anybody drives over. */
handoverRoutes.get("/handovers/:id/readiness", route(async (req, res) => {
  need(req, "get", "handovers");
  const h = await ownHandover(req, req.params.id);
  const orgId = req.actor.orgId;

  const [defects, items] = await Promise.all([
    blockingDefects(orgId, h.unitId),
    db.handoverItem.findMany({
      where: { orgId, handoverId: h.id },
      orderBy: { position: "asc" },
    }),
  ]);
  const outstanding = items.filter((i) => i.status === "PENDING" || i.status === "ISSUE");
  /* Fixed-but-unverified counts against readiness, because a defect one
     person says is done is not a defect anybody has checked. */
  const unverified = defects.filter((d) => d.status === "FIXED");

  res.json({
    handover: { id: h.id, ref: h.ref, status: h.status },
    ready: defects.length === 0 && outstanding.length === 0,
    defects, outstanding,
    counts: {
      blockingDefects: defects.length,
      awaitingVerification: unverified.length,
      itemsOutstanding: outstanding.length,
    },
    means: defects.length
      ? "Critical and major defects are still open against this unit. Minor ones " +
        "are not counted — that is what a snagging list at handover is for."
      : outstanding.length
        ? "The unit is clear of serious defects; the handover list is not finished."
        : "Nothing stands in the way.",
  });
}));

/* ====================================================================== *
 * THE HANDOVER ITSELF
 * ====================================================================== */

/** POST /handovers/:id/items — keys, meters, manuals, warranties. */
handoverRoutes.post("/handovers/:id/items", route(async (req, res) => {
  need(req, "update", "handovers");
  const h = await ownHandover(req, req.params.id);
  if (h.status === "COMPLETED") {
    throw conflict(`${h.ref} is done. Its list is the record of what was handed over.`);
  }
  const title = text(req.body?.title, 300);
  if (!title) throw badRequest("An item needs to say what is being handed over.");

  const count = await db.handoverItem.count({
    where: { orgId: req.actor.orgId, handoverId: h.id },
  });
  const item = await db.handoverItem.create({
    data: {
      orgId: req.actor.orgId, handoverId: h.id, title,
      kind: text(req.body?.kind, 80), position: count + 1,
    },
  });
  res.status(201).json({ item });
}));

/** POST /handovers/:id/items/:itemId — what happened to it on the day. */
handoverRoutes.post("/handovers/:id/items/:itemId", route(async (req, res) => {
  need(req, "update", "handovers");
  const h = await ownHandover(req, req.params.id);
  const item = await ownItem(req, req.params.itemId);
  if (item.handoverId !== h.id) throw hidden();
  if (h.status === "COMPLETED") {
    throw conflict(`${h.ref} is done. What was handed over that day does not change afterwards.`);
  }

  const to = String(req.body?.status || "").toUpperCase();
  if (!["PENDING", "DONE", "ISSUE", "NOT_APPLICABLE"].includes(to)) {
    throw badRequest(`"${req.body?.status}" is not an item state.`,
      ["PENDING", "DONE", "ISSUE", "NOT_APPLICABLE"]);
  }
  const note = text(req.body?.note, 4000);
  if (to === "ISSUE" && !note) {
    throw badRequest("An item marked as a problem needs to say what the problem is.");
  }

  const out = await db.handoverItem.update({
    where: { id: item.id },
    data: { status: to, reading: text(req.body?.reading, 160), note },
  });
  /*
   * A METER READING IS THE RECORD. Auditing only the completion would mean an
   * item marked as a problem and quietly changed to done before the handover
   * finished leaves nothing behind — and that is precisely the change
   * somebody would want to make quietly.
   */
  await audit(req, "handover.item", "handover", h.id,
    { ref: h.ref, item: item.title, to, reading: out.reading || undefined });
  res.json({ item: out });
}));

/**
 * POST /handovers/:id/complete
 *
 * THE CHECK. It reads the defect register — the real one — and refuses while
 * a critical or major defect is open against the unit.
 */
handoverRoutes.post("/handovers/:id/complete", route(async (req, res) => {
  need(req, "update", "handovers");
  const h = await ownHandover(req, req.params.id);
  const orgId = req.actor.orgId;

  if (h.status === "COMPLETED") throw conflict(`${h.ref} has already been handed over.`);
  if (h.status === "CANCELLED") throw conflict(`${h.ref} was cancelled.`);

  const defects = await blockingDefects(orgId, h.unitId);
  if (defects.length) {
    throw conflict(
      `${h.ref} cannot complete — ${defects.length} serious defect${
        defects.length === 1 ? " is" : "s are"} still open against this unit:\n  ` +
      defects.map((d) => `${d.ref} ${d.title} (${d.severity.toLowerCase()}, ${
        d.status.toLowerCase().replace(/_/g, " ")})`).join("\n  ") +
      `\n\nA defect somebody says is fixed still needs verifying by somebody else. ` +
      `Minor defects do not block — they are what the snagging list is for.`);
  }

  const items = await db.handoverItem.findMany({ where: { orgId, handoverId: h.id } });
  const pending = items.filter((i) => i.status === "PENDING");
  if (pending.length && req.body?.acceptIncomplete !== true) {
    throw conflict(
      `${pending.length} item${pending.length === 1 ? " has" : "s have"} not been dealt with: ` +
      pending.map((i) => i.title).join(", ") +
      `. Mark them, or complete deliberately with acceptIncomplete.`);
  }

  /* Two names, like a defect's. A handover recorded by one person is one
     person's account of an afternoon in which somebody else was present. */
  const handedBy = text(req.body?.handedBy, 160) || who(req);
  const receivedBy = text(req.body?.receivedBy, 160);
  if (!receivedBy) {
    throw badRequest(
      "A handover needs the name of whoever took it. Without it there is no record " +
      "that anybody actually received the keys.");
  }

  const out = await db.handover.update({
    where: { id: h.id },
    data: {
      status: "COMPLETED", completedOn: day(req.body?.completedOn) || new Date(),
      handedBy, receivedBy, notes: text(req.body?.notes, 20000) || h.notes,
    },
  });
  await audit(req, "handover.complete", "handover", h.id,
    { ref: h.ref, unitId: h.unitId, items: items.length });

  const issues = items.filter((i) => i.status === "ISSUE");
  res.json({
    handover: out,
    said: `${h.ref} handed over by ${handedBy} to ${receivedBy}.` +
      (issues.length
        ? ` ${issues.length} item${issues.length === 1 ? " was" : "s were"} recorded as a ` +
          `problem on the day and ${issues.length === 1 ? "is" : "are"} still outstanding.`
        : "") +
      (pending.length ? ` ${pending.length} item${pending.length === 1 ? "" : "s"} were never dealt with.` : ""),
  });
}));

/**
 * POST /handovers/:id/refuse — the buyer would not take it.
 *
 * A real and common outcome, and a scheduled/completed pair cannot express
 * it. The reason is required because it is what has to be fixed before
 * anybody drives over again.
 */
handoverRoutes.post("/handovers/:id/refuse", route(async (req, res) => {
  need(req, "update", "handovers");
  const h = await ownHandover(req, req.params.id);
  if (h.status === "COMPLETED") {
    throw conflict(`${h.ref} was completed. A complaint afterwards is a defect, not a refusal.`);
  }
  const why = text(req.body?.reason, 4000);
  if (!why) {
    throw badRequest(
      "A refusal needs the reason. It is what has to be put right before anybody " +
      "drives over again.");
  }
  const out = await db.handover.update({
    where: { id: h.id },
    data: { status: "REFUSED", refusedReason: why },
  });
  await audit(req, "handover.refuse", "handover", h.id, { ref: h.ref });
  res.json({
    handover: out,
    said: `${h.ref} refused. Schedule another once the reason is put right — this one ` +
          `keeps the record of why it did not happen.`,
  });
}));

/* ====================================================================== *
 * WHAT A SALE ACTUALLY DID
 * ====================================================================== */

/**
 * What is still owed on a contract, from the money that has actually arrived.
 *
 * READ FROM THE PAYMENTS, not from the deposit column. `Contract.deposit` is
 * what was taken at reservation; a buyer six instalments in has paid far more
 * than that, and completing a sale on the strength of a stale column is how a
 * flat gets transferred before it is paid for.
 */
async function balanceOf(orgId, contract) {
  /*
   * THE PATH FROM MONEY TO A SALE runs contract → invoice → payment. There is
   * no direct link and there should not be: an instalment is invoiced and the
   * invoice is paid, and a payment pointing at both would be two answers to
   * which one it settled.
   */
  const invoices = await db.invoice.findMany({
    where: { orgId, contractId: contract.id }, select: { id: true },
  });
  const paid = invoices.length
    ? await db.payment.aggregate({
        where: { orgId, invoiceId: { in: invoices.map((i) => i.id) }, voided: false },
        _sum: { amount: true },
      })
    : { _sum: { amount: 0n } };

  /*
   * The deposit is the FLOOR, not the total.
   *
   * `Contract.deposit` is what was taken at reservation, and for a buyer six
   * instalments in it is wildly wrong — so the payments win wherever they are
   * larger. Taking the deposit alone is how a flat gets transferred before it
   * is paid for; taking the payments alone loses a deposit recorded before
   * anybody raised an invoice for it.
   */
  const fromPayments = paid._sum.amount || 0n;
  const received = fromPayments > contract.deposit ? fromPayments : contract.deposit;
  const variations = await db.changeOrder.aggregate({
    where: { orgId, contractId: contract.id, status: "APPROVED" },
    _sum: { amount: true },
  });
  const value = contract.price + (variations._sum.amount || 0n);
  return { value, received, owed: value - received };
}

const CONTRACT_NEXT = {
  RESERVED: ["SOLD", "CANCELLED"],
  SOLD: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * POST /contracts/:id/status
 *
 * RESERVED → SOLD is signing. SOLD → COMPLETED is the money being in, and it
 * refuses while anything is owed unless somebody says so deliberately.
 * Cancelling puts the unit back on the market, which is the consequence a
 * status column cannot carry.
 */
handoverRoutes.post("/contracts/:id/status", route(async (req, res) => {
  needMoney(req, "update", "contracts");
  const c = await ownContract(req, req.params.id);
  const orgId = req.actor.orgId;

  const to = String(req.body?.status || "").toUpperCase();
  if (!CONTRACT_NEXT[to]) {
    throw badRequest(`"${req.body?.status}" is not a contract state.`, Object.keys(CONTRACT_NEXT));
  }
  const allowed = CONTRACT_NEXT[c.status];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length
        ? `${c.ref} is ${c.status.toLowerCase()} and can only move to ${
            allowed.join(" or ").toLowerCase()}.`
        : `${c.ref} is ${c.status.toLowerCase()} and does not move again.`);
  }

  const data = { status: to };
  const balance = await balanceOf(orgId, c);

  if (to === "SOLD") {
    data.signedOn = day(req.body?.signedOn) || new Date();
  }

  if (to === "COMPLETED") {
    if (balance.owed > 0n && req.body?.acceptOutstanding !== true) {
      throw conflict(
        `${c.ref} still has ${c.currency} ${(Number(balance.owed) / 100).toFixed(2)} ` +
        `outstanding against a value of ${c.currency} ${(Number(balance.value) / 100).toFixed(2)}. ` +
        `Completing transfers the flat. If that is the deal, say so with acceptOutstanding.`);
    }
    data.completedOn = day(req.body?.completedOn) || new Date();
  }

  /* CANCELLING PUTS THE UNIT BACK. Without this a cancelled sale leaves a
     flat marked RESERVED that nobody can sell and nobody can find. */
  let released = null;
  if (to === "CANCELLED") {
    const why = text(req.body?.reason, 2000);
    if (!why) throw badRequest("Cancelling a sale needs a reason — a buyer was told they had it.");
    data.note = c.note ? `${c.note}\n\nCancelled: ${why}` : `Cancelled: ${why}`;
    if (c.unitId) {
      const unit = await db.unit.findFirst({ where: { id: c.unitId, orgId } });
      if (unit && unit.status === "RESERVED") {
        /* VACANT, not "AVAILABLE" — the word this schema has always used for a
           unit nobody is in. Inventing a second one would have produced a
           status no screen draws and no filter finds. */
        released = await db.unit.update({
          where: { id: unit.id }, data: { status: "VACANT" },
        });
      }
    }
  }

  const out = await db.contract.update({ where: { id: c.id }, data });
  await audit(req, "contract.status", "contract", c.id,
    { ref: c.ref, to, owed: String(balance.owed) });

  res.json({
    contract: out,
    balance: {
      value: String(balance.value), received: String(balance.received),
      owed: String(balance.owed),
    },
    releasedUnit: released ? { id: released.id, ref: released.ref, status: released.status } : null,
    said: to === "COMPLETED"
      ? balance.owed > 0n
        ? `${c.ref} completed with ${c.currency} ${(Number(balance.owed) / 100).toFixed(2)} ` +
          `still outstanding. That was a deliberate decision and it is on the record.`
        : `${c.ref} completed, paid in full.`
      : to === "CANCELLED"
        ? `${c.ref} cancelled.` + (released ? ` ${released.ref} is back on the market.` : "")
        : `${c.ref} is now ${to.toLowerCase()}.`,
  });
}));

/** GET /contracts/:id/balance — value, received, owed. Computed every time. */
handoverRoutes.get("/contracts/:id/balance", route(async (req, res) => {
  needMoney(req, "get", "contracts");
  const c = await ownContract(req, req.params.id);
  const b = await balanceOf(req.actor.orgId, c);
  res.json({
    contract: { id: c.id, ref: c.ref, currency: c.currency, status: c.status },
    value: String(b.value), received: String(b.received), owed: String(b.owed),
    means: "Received is read from the payments actually taken, not from the deposit " +
           "column — a buyer six instalments in has paid far more than their deposit.",
  });
}));

/* ====================================================================== *
 * WHO IS ON THE JOB
 * ====================================================================== */

/**
 * POST /projects/:id/team — somebody joins.
 *
 * Most of a project team has no login here: the architect, the QS and the
 * main contractor work for other companies. So a name is enough, and a userId
 * is checked against this company's own members when one is given.
 */
handoverRoutes.post("/projects/:id/team", route(async (req, res) => {
  need(req, "update", "project-team");
  const orgId = req.actor.orgId;
  const project = await db.project.findFirst({ where: { id: req.params.id, orgId } });
  if (!project) throw hidden();

  const b = req.body || {};
  let name = text(b.name, 200);
  let userId = null;
  let partyId = null;

  if (b.userId) {
    const member = await db.membership.findFirst({
      where: { orgId, userId: String(b.userId) },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!member) {
      throw badRequest("That person is not a member of this company.");
    }
    userId = member.user.id;
    if (!name) name = member.user.name || member.user.email;
  }
  if (b.partyId) {
    const party = await db.party.findFirst({ where: { id: String(b.partyId), orgId } });
    if (!party) throw badRequest("That contact is not one of yours.");
    partyId = party.id;
    if (!name) name = party.name;
  }
  if (!name) throw badRequest("Somebody on the team needs a name.");

  const role = text(b.role, 160);
  if (!role) {
    throw badRequest(
      "A role is what makes a team list useful — it is the answer to who to ring.");
  }

  const member = await db.projectMember.create({
    data: {
      orgId, projectId: project.id, userId, partyId, name, role,
      company: text(b.company, 200), email: text(b.email, 200),
      phone: text(b.phone, 60), responsible: text(b.responsible, 4000),
      joinedOn: day(b.joinedOn) || new Date(),
    },
  });
  await audit(req, "project.team.join", "project", project.id,
    { name, role, projectRef: project.name });
  res.status(201).json({ member });
}));

/**
 * POST /projects/:id/team/:memberId/leave
 *
 * LEAVING IS A DATE, NOT A DELETION. Somebody who was on the job in March was
 * on the job in March, and a team list that forgets them cannot answer who
 * approved something in March.
 *
 * And it says what they were carrying, because tasks do not leave with people.
 */
handoverRoutes.post("/projects/:id/team/:memberId/leave", route(async (req, res) => {
  need(req, "update", "project-team");
  const orgId = req.actor.orgId;
  const member = await ownMember(req, req.params.memberId);
  if (member.projectId !== req.params.id) throw hidden();
  if (member.leftOn) throw conflict(`${member.name} already left this job.`);

  const out = await db.projectMember.update({
    where: { id: member.id },
    data: { leftOn: day(req.body?.leftOn) || new Date() },
  });

  /* What they were carrying. Not reassigned automatically — somebody has to
     decide who takes it — but never silently dropped either. */
  const open = await db.task.findMany({
    where: {
      orgId, projectId: member.projectId,
      status: { in: ["TODO", "IN_PROGRESS", "BLOCKED"] },
      OR: [
        ...(member.userId ? [{ assigneeId: member.userId }] : []),
        { assigneeName: member.name },
      ],
    },
    select: { id: true, ref: true, title: true, dueOn: true },
  });

  await audit(req, "project.team.leave", "project", member.projectId,
    { name: member.name, openTasks: open.length });

  res.json({
    member: out, openTasks: open,
    said: open.length
      ? `${member.name} has left the job with ${open.length} open task${
          open.length === 1 ? "" : "s"}. They have not been reassigned — somebody has to ` +
        `decide who takes them.`
      : `${member.name} has left the job. Nothing was outstanding.`,
  });
}));

/**
 * GET /projects/:id/team — who to ring, and who used to be.
 *
 * Current and former separately, because a list that mixes them answers
 * neither question.
 */
handoverRoutes.get("/projects/:id/team", route(async (req, res) => {
  need(req, "get", "project-team");
  const orgId = req.actor.orgId;
  const project = await db.project.findFirst({ where: { id: req.params.id, orgId } });
  if (!project) throw hidden();

  const all = await db.projectMember.findMany({
    where: { orgId, projectId: project.id },
    orderBy: [{ leftOn: "asc" }, { role: "asc" }],
  });
  const current = all.filter((m) => !m.leftOn);
  res.json({
    project: { id: project.id, name: project.name },
    team: current,
    former: all.filter((m) => m.leftOn),
    counts: { current: current.length, former: all.length - current.length },
    /* The gap that matters: somebody in a role with nothing said about what
       they answer for is a name, not a contact. */
    unstated: current.filter((m) => !m.responsible).length,
  });
}));
