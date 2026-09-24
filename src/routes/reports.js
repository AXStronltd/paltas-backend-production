/* ====================================================================== *
 * ONE DEVELOPMENT, ON ONE PAGE — AND WHAT IT COULD NOT WORK OUT.
 *
 * ── THE RULE THAT MAKES A REPORT WORTH READING ─────────────────────────
 *
 * A report that shows 0 where it has no data is worse than no report. Zero
 * defects and "nobody has recorded any defects" look identical on a screen
 * and mean opposite things, and it is always the second one — the site that
 * has not started snagging, the project nobody has raised an RFI against —
 * that a green dashboard is hiding.
 *
 * So every section here says which of the two it is. `recorded: false` means
 * the register is empty, and the console draws that differently from a
 * genuine zero. Nothing is estimated, nothing is filled in, and a figure that
 * cannot be computed is absent rather than plausible.
 *
 * ── AND WHERE THE NUMBERS COME FROM ────────────────────────────────────
 *
 * All of them from the registers themselves — the same rows the screens
 * show. Nothing here keeps its own copy of anything, which is why a report
 * can be trusted against the screen it summarises.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.ts";
import { levelFor, whyNotArea } from "../domain/access.ts";
import { RESOURCES } from "../domain/registry.js";
import { forbidden, hidden } from "../http/errors.ts";
import {
  requireOpenSubscription, requireOrganization, requireSession,
} from "../http/session.js";

export const reportRoutes = Router();

reportRoutes.use(requireSession(), requireOrganization(), requireOpenSubscription());

const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

function need(req, act, label) {
  const why = whyNotArea(req.actor, "property", act, label);
  if (why) throw forbidden(why);
}

/** Can this person see money at all. Decides whether the report carries any. */
const seesMoney = (req) => levelFor(req.actor, "finance") !== "none";

/**
 * A section, with the one distinction that matters.
 *
 * `recorded` is false when the register is EMPTY — nobody has raised
 * anything — and true when it holds rows. A count of zero with
 * recorded:false is "nobody is doing this"; with recorded:true it is "all
 * clear". A dashboard that cannot tell those apart is a dashboard that hides
 * the first one, and the first one is the problem.
 */
const section = (total, body) => ({ recorded: total > 0, total, ...body });

/* ====================================================================== *
 * THE REPORT
 * ====================================================================== */

/**
 * GET /projects/:id/report
 *
 * Everything about one development, read from the registers. Sections a
 * person may not see are absent rather than zeroed, because a zero somebody
 * is not allowed to see is still a number about the company.
 */
reportRoutes.get("/projects/:id/report", route(async (req, res) => {
  need(req, "get", "projects");
  const orgId = req.actor.orgId;
  const project = await db.project.findFirst({ where: { id: req.params.id, orgId } });
  if (!project) throw hidden();

  const now = new Date();
  const id = project.id;

  /* ---------------------------------------------------- the programme */
  const [phases, milestones] = await Promise.all([
    db.projectPhase.findMany({ where: { orgId, projectId: id } }),
    db.milestone.findMany({ where: { orgId, projectId: id } }),
  ]);

  /*
   * THE SAME WEIGHTING THE DEVELOPMENT SCREEN USES, so the report and the
   * screen can never tell two stories. A phase with no weight counts once.
   */
  const weight = phases.reduce((t, p) => t + (p.weight > 0 ? p.weight : 1), 0);
  const weighted = phases.reduce((t, p) => t + p.progress * (p.weight > 0 ? p.weight : 1), 0);
  const overdueMilestones = milestones.filter(
    (m) => m.status === "PENDING" && m.dueOn && m.dueOn < now);

  const programme = section(phases.length, {
    /*
     * ABSENT, not zero, when there are no phases. A development with no
     * programme has whatever single figure somebody typed on the project, and
     * reporting that as a weighted average would be dressing up a guess.
     */
    progress: phases.length ? Math.round(weighted / weight) : null,
    from: phases.length ? "the weighted average of its phases" : "no phases recorded",
    running: phases.filter((p) => p.status === "IN_PROGRESS").length,
    onHold: phases.filter((p) => p.status === "ON_HOLD").length,
    done: phases.filter((p) => p.status === "DONE").length,
    milestones: {
      recorded: milestones.length > 0, total: milestones.length,
      pending: milestones.filter((m) => m.status === "PENDING").length,
      missed: milestones.filter((m) => m.status === "MISSED").length,
      overdue: overdueMilestones.length,
      next: milestones
        .filter((m) => m.status === "PENDING" && m.dueOn)
        .sort((a, b) => a.dueOn - b.dueOn)
        .slice(0, 3)
        .map((m) => ({ name: m.name, dueOn: m.dueOn, owner: m.owner })),
    },
  });

  /* ------------------------------------------------------- what stops it */
  const [rfis, permits, defects] = await Promise.all([
    db.rfi.findMany({ where: { orgId, projectId: id } }),
    db.permit.findMany({ where: { orgId, projectId: id } }),
    db.defect.findMany({ where: { orgId, projectId: id } }),
  ]);

  const lapsed = (p) => p.status === "APPROVED" && p.expiresOn && p.expiresOn < now;
  const granted = (p) => p.status === "APPROVED" && !lapsed(p);
  const openDefect = (d) => ["OPEN", "IN_PROGRESS", "FIXED"].includes(d.status);

  const blockers = {
    rfis: section(rfis.length, {
      open: rfis.filter((r) => r.status === "OPEN").length,
      overdue: rfis.filter((r) => r.status === "OPEN" && r.dueOn && r.dueOn < now).length,
      awaitingClose: rfis.filter((r) => r.status === "ANSWERED").length,
    }),
    permits: section(permits.length, {
      /* A lapsed consent counts as not granted. The column says what the
         authority said; this says what is true today. */
      blocking: permits.filter((p) => p.blocking && !granted(p)).length,
      lapsed: permits.filter(lapsed).length,
      granted: permits.filter(granted).length,
      expiringWithin90Days: permits.filter(
        (p) => granted(p) && p.expiresOn && p.expiresOn < new Date(Date.now() + 90 * 864e5)).length,
    }),
    defects: section(defects.length, {
      critical: defects.filter((d) => openDefect(d) && d.severity === "CRITICAL").length,
      major: defects.filter((d) => openDefect(d) && d.severity === "MAJOR").length,
      minor: defects.filter((d) => openDefect(d) && d.severity === "MINOR").length,
      awaitingVerification: defects.filter((d) => d.status === "FIXED").length,
    }),
  };

  /* ----------------------------------------------------------- delivery */
  const [contracts, handovers, unitCount] = await Promise.all([
    db.contract.findMany({ where: { orgId, projectId: id } }),
    db.handover.findMany({ where: { orgId, projectId: id } }),
    db.unit.count({ where: { orgId, projectId: id } }),
  ]);

  const delivery = {
    units: { recorded: unitCount > 0, total: unitCount },
    sales: section(contracts.length, {
      reserved: contracts.filter((c) => c.status === "RESERVED").length,
      sold: contracts.filter((c) => c.status === "SOLD").length,
      completed: contracts.filter((c) => c.status === "COMPLETED").length,
      cancelled: contracts.filter((c) => c.status === "CANCELLED").length,
    }),
    handovers: section(handovers.length, {
      booked: handovers.filter((h) => h.status === "SCHEDULED").length,
      done: handovers.filter((h) => h.status === "COMPLETED").length,
      refused: handovers.filter((h) => h.status === "REFUSED").length,
    }),
  };

  /* -------------------------------------------------------------- money */
  let money = null;
  if (seesMoney(req)) {
    const [variations, orders, expenses, feasibility] = await Promise.all([
      db.changeOrder.findMany({ where: { orgId, projectId: id, status: "APPROVED" } }),
      db.purchaseOrder.findMany({ where: { orgId, projectId: id } }),
      db.expense.findMany({ where: { orgId, purchaseOrder: { projectId: id } } }),
      db.feasibility.findFirst({
        where: { orgId, projectId: id, status: "APPROVED" },
        orderBy: { decidedOn: "desc" },
      }),
    ]);

    const signed = contracts
      .filter((c) => c.status !== "CANCELLED")
      .reduce((t, c) => t + c.price, 0n);
    const varied = variations.reduce((t, v) => t + v.amount, 0n);
    const live = orders.filter((o) => ["ISSUED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(o.status));

    money = {
      currency: project.currency || "KES",
      sales: {
        recorded: contracts.length > 0,
        signed: String(signed),
        approvedVariations: String(varied),
        currentValue: String(signed + varied),
        note: "Signed is what the contracts were signed at and never changes.",
      },
      /*
       * COMMITTED AND SPENT, SEPARATELY AND NEVER SUMMED. An issued order is
       * a promise; the cost exists when the expense does.
       */
      purchasing: section(orders.length, {
        committed: String(live.reduce((t, o) => t + o.total, 0n)),
        invoiced: String(expenses.reduce((t, e) => t + e.amount, 0n)),
        note: "Committed is money promised and not yet spent. It is not in the ledger.",
      }),
      appraisal: feasibility
        ? {
            recorded: true, ref: feasibility.ref,
            decidedBy: feasibility.decidedBy, decidedOn: feasibility.decidedOn,
            grossValue: String(feasibility.grossValue),
            note: "The approved study. Its derived figures are on the appraisal itself.",
          }
        : { recorded: false, note: "No approved appraisal for this development." },
    };
  }

  /* --------------------------------------------------------------- people */
  const team = await db.projectMember.findMany({ where: { orgId, projectId: id, leftOn: null } });

  /* ----------------------------------------------------------- the verdict */
  /*
   * NAMED, NOT SCORED. A number out of ten invites somebody to improve the
   * number; a sentence naming what is wrong invites them to fix it. And
   * anything that was never recorded is called out separately from anything
   * that is clear, because those are the two things a dashboard confuses.
   */
  const attention = [];
  if (blockers.permits.blocking) {
    attention.push(`${blockers.permits.blocking} permit${
      blockers.permits.blocking === 1 ? "" : "s"} required and not granted — work cannot lawfully proceed`);
  }
  if (blockers.defects.critical) {
    attention.push(`${blockers.defects.critical} critical defect${
      blockers.defects.critical === 1 ? "" : "s"} open`);
  }
  if (blockers.rfis.overdue) {
    attention.push(`${blockers.rfis.overdue} question${
      blockers.rfis.overdue === 1 ? "" : "s"} unanswered past the date ${
      blockers.rfis.overdue === 1 ? "it was" : "they were"} needed`);
  }
  if (programme.milestones.overdue) {
    attention.push(`${programme.milestones.overdue} milestone${
      programme.milestones.overdue === 1 ? "" : "s"} past due`);
  }
  if (delivery.handovers.refused) {
    attention.push(`${delivery.handovers.refused} handover${
      delivery.handovers.refused === 1 ? "" : "s"} refused by the buyer`);
  }

  const unrecorded = [];
  if (!programme.recorded) unrecorded.push("no programme — progress is whatever was typed on the project");
  if (!blockers.rfis.recorded) unrecorded.push("no RFIs have ever been raised");
  if (!blockers.permits.recorded) unrecorded.push("no permits recorded at all");
  if (!blockers.defects.recorded) unrecorded.push("nothing has been inspected or snagged");
  if (!team.length) unrecorded.push("nobody is recorded as being on this job");

  res.json({
    project: {
      id: project.id, name: project.name, status: project.status,
      city: project.city, currency: project.currency,
    },
    generatedAt: now,
    programme, blockers, delivery,
    money,
    moneyVisible: seesMoney(req),
    team: section(team.length, {
      /* Somebody in a role with nothing said about what they answer for is a
         name, not a contact. */
      withoutRemit: team.filter((m) => !m.responsible).length,
      roles: team.map((m) => ({ name: m.name, role: m.role, company: m.company })),
    }),
    attention,
    /*
     * THE HALF A DASHBOARD USUALLY HIDES. An empty register and a clean one
     * look identical as a zero, and it is always the empty one that matters.
     */
    unrecorded,
    means: attention.length
      ? "These need somebody today."
      : unrecorded.length
        ? "Nothing is flagged — but several registers are empty, which is not the " +
          "same as clear."
        : "Nothing outstanding across the registers that carry one.",
  });
}));

/* ====================================================================== *
 * WHAT HAS HAPPENED TO ONE DEVELOPMENT
 * ====================================================================== */

/**
 * Everything belonging to one development, as audit clauses.
 *
 * WRITTEN OUT, ONE CALL PER TABLE, and deliberately so. The first version put
 * the fifteen queries in a table of functions taking `db_` as a parameter,
 * which is tidy and invisible to the scanner that proves every query is
 * scoped: `db_.rfi.findMany` does not match `db.<model>.<method>`, so fifteen
 * queries left the guard's sight at once. It is the same evasion as
 * `db[model]`, wearing a different hat.
 *
 * Fifteen lines a reader can check are worth more than one clever one they
 * cannot.
 */
async function projectClauses(orgId, projectId, readable) {
  const where = { orgId, projectId };
  const clauses = [];
  const add = (model, rows) => {
    if (readable.has(model) && rows.length) {
      clauses.push({ entity: model, entityId: { in: rows.map((r) => r.id) } });
    }
  };
  const pick = { select: { id: true } };

  add("rfi", await db.rfi.findMany({ where, ...pick }));
  add("submittal", await db.submittal.findMany({ where, ...pick }));
  add("inspection", await db.inspection.findMany({ where, ...pick }));
  add("defect", await db.defect.findMany({ where, ...pick }));
  add("siteDiary", await db.siteDiary.findMany({ where, ...pick }));
  add("meeting", await db.meeting.findMany({ where, ...pick }));
  add("decision", await db.decision.findMany({ where, ...pick }));
  add("task", await db.task.findMany({ where, ...pick }));
  add("drawing", await db.drawing.findMany({ where, ...pick }));
  add("permit", await db.permit.findMany({ where, ...pick }));
  add("purchaseOrder", await db.purchaseOrder.findMany({ where, ...pick }));
  add("changeOrder", await db.changeOrder.findMany({ where, ...pick }));
  add("contract", await db.contract.findMany({ where, ...pick }));
  add("handover", await db.handover.findMany({ where, ...pick }));
  add("feasibility", await db.feasibility.findMany({ where, ...pick }));
  add("rfq", await db.rfq.findMany({ where, ...pick }));
  add("acquisition", await db.acquisition.findMany({ where, ...pick }));

  /* The project row itself — team joins and leaves are audited against it. */
  if (readable.has("project")) clauses.push({ entity: "project", entityId: projectId });

  return clauses;
}

/**
 * GET /projects/:id/activity
 *
 * The trail, narrowed to one development.
 *
 * An AuditEvent carries what was touched, not which project it belonged to —
 * deliberately, because a project id on every audit row would be a copy of a
 * fact that already lives on the row it describes, free to drift. So this
 * gathers what belongs to the project and asks for events against those.
 *
 * ── AND IT ADDS NO REACH ───────────────────────────────────────────────
 *
 * Exactly like GET /audit: a person sees only events about models in areas
 * they may already read. A site manager reading this does not learn what the
 * purchase orders said.
 */
reportRoutes.get("/projects/:id/activity", route(async (req, res) => {
  need(req, "get", "projects");
  const orgId = req.actor.orgId;
  const project = await db.project.findFirst({ where: { id: req.params.id, orgId } });
  if (!project) throw hidden();

  /* Which models this person may hear about at all. */
  const areaOf = new Map();
  for (const r of Object.values(RESOURCES)) areaOf.set(r.model, r.area);
  const readable = new Set(
    [...areaOf].filter(([, area]) => levelFor(req.actor, area) !== "none").map(([m]) => m));

  const clauses = await projectClauses(orgId, project.id, readable);

  if (!clauses.length) {
    return res.json({
      project: { id: project.id, name: project.name },
      events: [], count: 0,
      means: "Nothing has been recorded against this development that you can see.",
    });
  }

  const take = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
  const events = await db.auditEvent.findMany({
    where: { orgId, OR: clauses },
    orderBy: { at: "desc" },
    take,
    select: {
      id: true, at: true, action: true, entity: true, entityId: true,
      actorName: true, detail: true,
    },
  });

  res.json({
    project: { id: project.id, name: project.name },
    events, count: events.length,
    /* What this person is NOT being shown, said plainly rather than left as a
       suspiciously short list. */
    hidden: [...areaOf.keys()].filter((m) => !readable.has(m)).length,
    means: events.length
      ? "Everything recorded against this development, most recent first."
      : "Nothing has happened to this development yet.",
  });
}));
