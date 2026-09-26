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
import type { Request, RequestHandler, Response } from "express";
import type { Prisma } from "@prisma/client";
import type { Act } from "../domain/access.ts";
import { messageOf } from "../http/errors.ts";
import { actorOf, sessionOf, param } from "../http/request.ts";
import type { $Enums } from "@prisma/client";
import { enumParam } from "../http/errors.ts";

/** A sale, as this file reads one back. */
type ContractRow = NonNullable<Awaited<ReturnType<typeof db.contract.findFirst>>>;
import { whyNotArea } from "../domain/access.ts";
import { badRequest, conflict, forbidden, hidden } from "../http/errors.ts";
import { numberFor } from "../http/resource.ts";
import {
  buildPlan, certifyMilestone, dueUninvoiced, livePlanFor, setPlan,
} from "../domain/plans.ts";
import type { PlanInput } from "../domain/plans.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.ts";

export const handoverRoutes = Router();

handoverRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

function need(req: Request, act: Act, label?: string): void {
  const why = whyNotArea(actorOf(req, "a handover route"), "property", act, label);
  if (why) throw forbidden(why);
}
function needMoney(req: Request, act: Act, label?: string): void {
  const why = whyNotArea(actorOf(req, "a handover route"), "finance", act, label);
  if (why) throw forbidden(why);
}

/** One handler, with its `try`/`catch` written once. */
const route = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try { await fn(req, res); } catch (e) { next(e); }
  };

const who = (req: Request): string =>
  req.view?.user?.name || req.view?.user?.email || "";
const text = (v: unknown, max: number): string =>
  String(v == null ? "" : v).trim().slice(0, max);
const day = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
};

function money(v: unknown): bigint | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.trunc(n))) return null;
  return BigInt(Math.trunc(n));
}

async function audit(
  req: Request, action: string, entity: string,
  entityId?: string, detail?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: actorOf(req, "a handover route").orgId, actorId: sessionOf(req, "a handover route").userId, actorName: who(req),
        action, entity, entityId: entityId || "", detail: detail || undefined,
        ip: req.ip || "",
      },
    });
  } catch (e) { console.error("audit write failed", action, messageOf(e)); }
}

async function ownHandover(req: Request, id: string) {
  const row = await db.handover.findFirst({ where: { id, orgId: actorOf(req, "a handover route").orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownItem(req: Request, id: string) {
  const row = await db.handoverItem.findFirst({ where: { id, orgId: actorOf(req, "a handover route").orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownContract(req: Request, id: string) {
  const row = await db.contract.findFirst({ where: { id, orgId: actorOf(req, "a handover route").orgId } });
  if (!row) throw hidden();
  return row;
}
async function ownMember(req: Request, id: string) {
  const row = await db.projectMember.findFirst({ where: { id, orgId: actorOf(req, "a handover route").orgId } });
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
async function blockingDefects(orgId: string, unitId: string | null | undefined) {
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
  const h = await ownHandover(req, param(req, "id"));
  const orgId = actorOf(req, "a handover route").orgId;

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
  const h = await ownHandover(req, param(req, "id"));
  if (h.status === "COMPLETED") {
    throw conflict(`${h.ref} is done. Its list is the record of what was handed over.`);
  }
  const title = text(req.body?.title, 300);
  if (!title) throw badRequest("An item needs to say what is being handed over.");

  const count = await db.handoverItem.count({
    where: { orgId: actorOf(req, "a handover route").orgId, handoverId: h.id },
  });
  const item = await db.handoverItem.create({
    data: {
      orgId: actorOf(req, "a handover route").orgId, handoverId: h.id, title,
      kind: text(req.body?.kind, 80), position: count + 1,
    },
  });
  res.status(201).json({ item });
}));

/** POST /handovers/:id/items/:itemId — what happened to it on the day. */
handoverRoutes.post("/handovers/:id/items/:itemId", route(async (req, res) => {
  need(req, "update", "handovers");
  const h = await ownHandover(req, param(req, "id"));
  const item = await ownItem(req, param(req, "itemId"));
  if (item.handoverId !== h.id) throw hidden();
  if (h.status === "COMPLETED") {
    throw conflict(`${h.ref} is done. What was handed over that day does not change afterwards.`);
  }

  const to = enumParam("HandoverItemStatus", req.body?.status, "handover item state");
  if (!to) throw badRequest("Which state? Send `status`.");
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
  const h = await ownHandover(req, param(req, "id"));
  const orgId = actorOf(req, "a handover route").orgId;

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
  const h = await ownHandover(req, param(req, "id"));
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
async function balanceOf(orgId: string, contract: ContractRow) {
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

/** What a sale may become next. Anything not listed is refused. */
const CONTRACT_NEXT: Readonly<Record<string, readonly $Enums.ContractStatus[]>> = {
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
  const c = await ownContract(req, param(req, "id"));
  const orgId = actorOf(req, "a handover route").orgId;

  const to = enumParam("ContractStatus", req.body?.status, "contract state");
  if (!to) throw badRequest("Which state? Send `status`.");
  if (!CONTRACT_NEXT[to]) {
    throw badRequest(`"${to}" is not a contract state.`, Object.keys(CONTRACT_NEXT));
  }
  const allowed = CONTRACT_NEXT[c.status] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length
        ? `${c.ref} is ${c.status.toLowerCase()} and can only move to ${
            allowed.join(" or ").toLowerCase()}.`
        : `${c.ref} is ${c.status.toLowerCase()} and does not move again.`);
  }

  const data: Prisma.ContractUpdateInput = { status: to };
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

  /*
   * A COMPLETED SALE TAKES THE UNIT OFF THE MARKET.
   *
   * It had stayed RESERVED for ever: reserving was the only thing that ever
   * moved a unit forward, and nothing moved it at the end. A flat that was
   * sold, paid for and handed over still read as merely reserved, so it
   * never left the pipeline and never counted as sold.
   *
   * OFF_MARKET rather than a new status. The unit is no longer available to
   * let or to sell, which is precisely what OFF_MARKET has always meant here
   * — and if the new owner later lets it through PALTAS, the lease hook in
   * domain/occupancy.ts deliberately refuses to move it, so an owner's
   * letting cannot quietly put a sold unit back on the developer's market.
   */
  let sold = null;
  if (to === "COMPLETED" && c.unitId) {
    const unit = await db.unit.findFirst({ where: { id: c.unitId, orgId } });
    if (unit && unit.status === "RESERVED") {
      sold = await db.unit.update({
        where: { id: unit.id }, data: { status: "OFF_MARKET" },
      });
    }
  }

  const out = await db.contract.update({ where: { id: c.id }, data });
  await audit(req, "contract.status", "contract", c.id,
    { ref: c.ref, to, owed: String(balance.owed) });
  if (sold) {
    await audit(req, "unit.occupancy", "unit", sold.id,
      { from: "RESERVED", to: "OFF_MARKET", because: c.ref });
  }

  res.json({
    contract: out,
    balance: {
      value: String(balance.value), received: String(balance.received),
      owed: String(balance.owed),
    },
    releasedUnit: released ? { id: released.id, ref: released.ref, status: released.status } : null,
    soldUnit: sold ? { id: sold.id, ref: sold.ref, status: sold.status } : null,
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
  const c = await ownContract(req, param(req, "id"));
  const b = await balanceOf(actorOf(req, "a handover route").orgId, c);
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
  const orgId = actorOf(req, "a handover route").orgId;
  const project = await db.project.findFirst({ where: { id: param(req, "id"), orgId } });
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
  const orgId = actorOf(req, "a handover route").orgId;
  const member = await ownMember(req, param(req, "memberId"));
  if (member.projectId !== param(req, "id")) throw hidden();
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
  const orgId = actorOf(req, "a handover route").orgId;
  const project = await db.project.findFirst({ where: { id: param(req, "id"), orgId } });
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

/* ====================================================================== *
 * PAYMENT PLANS.
 *
 * On the contract routes rather than in finance, because a plan is a term
 * of the sale — it is negotiated with the buyer, not set by the accounts
 * department. The money it produces posts through the ordinary invoice and
 * payment path, which is where finance owns it. See domain/plans.ts.
 * ====================================================================== */

/* Shown before it is agreed to. Writes nothing — a buyer is entitled to see
   the schedule before signing it, and a preview that saves is not one. */
handoverRoutes.post("/contracts/:id/plan/preview", route(async (req, res) => {
  needMoney(req, "get", "a payment plan");
  const orgId = actorOf(req, "a contract route").orgId;
  const contract = await db.contract.findFirst({
    where: { id: param(req, "id"), orgId },
  });
  if (!contract) throw hidden();

  const draft = buildPlan(contract.price, contract.deposit, planFrom(req.body));
  res.json({
    currency: contract.currency,
    total: String(draft.reduce((a, i) => a + i.amount, 0n)),
    price: String(contract.price),
    instalments: draft.map((i) => ({
      ...i, amount: String(i.amount),
    })),
  });
}));

handoverRoutes.get("/contracts/:id/plan", route(async (req, res) => {
  needMoney(req, "get", "a payment plan");
  const orgId = actorOf(req, "a contract route").orgId;
  const plan = await livePlanFor(db, orgId, param(req, "id"));
  if (!plan) return res.json({ plan: null, said: "This contract has no payment plan." });

  const total = plan.instalments.reduce((a, i) => a + i.amount, 0n);
  const invoiced = plan.instalments.filter((i) => i.invoiceId);
  res.json({
    plan: {
      ...plan,
      instalments: plan.instalments.map((i) => ({ ...i, amount: String(i.amount) })),
      total: String(total),
      invoicedCount: invoiced.length,
      /* Named rather than left to the reader: a construction-linked plan with
         dates on none of its lines is normal, not broken. */
      awaitingMilestone: plan.instalments.filter((i) => i.milestone && !i.dueOn).length,
    },
  });
}));

handoverRoutes.post("/contracts/:id/plan", route(async (req, res) => {
  /* Agreeing what a buyer pays and when is a money decision, not a filing
     one. Same guard the balance gate on /status uses. */
  needMoney(req, "create", "a payment plan");
  const orgId = actorOf(req, "a contract route").orgId;
  const who = req.view?.user?.name || req.view?.user?.email || "";

  const plan = await setPlan(db, orgId, param(req, "id"), planFrom(req.body), who);
  await audit(req, "contract.plan.set", "contract", param(req, "id"), {
    kind: plan.kind, instalments: plan.instalments.length,
    total: String(plan.instalments.reduce((a, i) => a + i.amount, 0n)),
  });

  res.status(201).json({
    plan: {
      ...plan,
      instalments: plan.instalments.map((i) => ({ ...i, amount: String(i.amount) })),
    },
  });
}));

/* A stage was certified. Every instalment waiting on it becomes due — across
   every live plan, because a milestone is reached for the building and not for
   one buyer at a time. */
handoverRoutes.post("/plans/milestones/:name/certify", route(async (req, res) => {
  /* Certifying a stage makes money fall due, so it is a money act even though
     the fact being certified is a construction one. */
  needMoney(req, "update", "a payment plan");
  const orgId = actorOf(req, "a contract route").orgId;
  const dueOn = req.body?.dueOn ? new Date(String(req.body.dueOn)) : new Date();
  if (Number.isNaN(dueOn.getTime())) throw badRequest("`dueOn` is not a date.");

  const out = await certifyMilestone(db, orgId, param(req, "name"), dueOn);
  await audit(req, "plan.milestone.certify", "paymentInstalment", undefined,
    { milestone: param(req, "name"), became: out.made });

  res.json({
    ...out,
    said: out.made
      ? `${out.made} instalment(s) are now due.`
      : `Nothing was waiting on that stage.`,
  });
}));

/* What a job would work through daily. See domain/plans.ts on why this is an
   endpoint today rather than a schedule. */
handoverRoutes.get("/plans/due", route(async (req, res) => {
  needMoney(req, "list", "payment plans");
  const orgId = actorOf(req, "a contract route").orgId;
  const asAt = req.query["asAt"] ? new Date(String(req.query["asAt"])) : new Date();
  if (Number.isNaN(asAt.getTime())) throw badRequest("`asAt` is not a date.");

  const due = await dueUninvoiced(db, orgId, asAt);
  res.json({
    due: due.map((i) => ({
      id: i.id, description: i.description, amount: String(i.amount),
      dueOn: i.dueOn, currency: i.plan.currency, contract: i.plan.contract,
    })),
  });
}));

/** The plan a request is asking for, checked before anything is built. */
function planFrom(body: unknown): PlanInput {
  const b = (body || {}) as Record<string, unknown>;
  const depositBp = Math.round(Number(b["depositBp"]) || 0);
  const kind = String(b["kind"] || "").toUpperCase();

  if (kind === "CONSTRUCTION_LINKED") {
    const depositDue = new Date(String(b["depositDue"] || ""));
    if (Number.isNaN(depositDue.getTime())) {
      throw badRequest("A construction-linked plan needs a date the deposit is due.");
    }
    const raw = Array.isArray(b["milestones"]) ? b["milestones"] : [];
    const milestones = raw.map((m: Record<string, unknown>) => ({
      name: String(m["name"] || "").trim(),
      shareBp: Math.round(Number(m["shareBp"]) || 0),
    }));
    if (milestones.some((m) => !m.name)) {
      throw badRequest("Every milestone on a plan needs a name.");
    }
    return { kind: "CONSTRUCTION_LINKED", depositBp, depositDue, milestones };
  }

  if (kind === "TIME_BASED") {
    const firstDue = new Date(String(b["firstDue"] || ""));
    if (Number.isNaN(firstDue.getTime())) {
      throw badRequest("A time-based plan needs the date the first payment is due.");
    }
    return {
      kind: "TIME_BASED", depositBp,
      count: Math.round(Number(b["count"]) || 0),
      everyMonths: Math.round(Number(b["everyMonths"]) || 0),
      firstDue,
    };
  }

  throw badRequest(
    `"${b["kind"]}" is not a kind of payment plan.`,
    ["TIME_BASED", "CONSTRUCTION_LINKED"]);
}
