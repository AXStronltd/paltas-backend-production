/*
 * The letting pipeline on the ONE contact store: enquiry (contact found by email or phone, or added; an open lead for
 * the same unit reused; an idempotency key never creates a second lead) → contacted / qualified → viewing (no clash for
 * the agent within an hour; a let unit cannot be viewed) → application (screening by one person, approval by another)
 * → draft lease → lease activated = lead won. Lost leads keep their reason. Every step is an activity on the contact.
 */
import type { contacts as C, property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import type { LeasesService } from "../leases/leases.service.js";
import { numberScope } from "../shared/money.js";
import * as R from "../shared/records.js";
import { addDays, addMonths } from "../shared/util.js";

interface LeadRow {
  id: string;
  number: string;
  contact_id: string;
  contact_name: string;
  source: string;
  campaign: string | null;
  unit_id: string | null;
  budget_minor: number | null;
  bedrooms: number | null;
  move_in: string | null;
  stage: P.Lead["stage"];
  stage_at: string;
  agent_id: string | null;
  lost_reason: string | null;
  created_at: string;
}

interface ViewingRow {
  id: string;
  lead_id: string;
  contact_id: string;
  unit_id: string;
  agent_id: string;
  date: string;
  time: string;
  status: "scheduled" | "completed" | "no_show" | "cancelled";
  feedback: string;
  interest: number | null;
}

interface AppRow {
  id: string;
  number: string;
  lead_id: string;
  contact_id: string;
  unit_id: string;
  status: P.Application["status"];
  employer: string;
  income_minor: number | null;
  occupants: number;
  offer_rent_minor: number;
  offer_deposit_minor: number;
  offer_start: string;
  offer_months: number;
  check_identity: boolean;
  check_income: boolean;
  check_reference: boolean;
  screened_by: string | null;
  approved_by: string | null;
  lease_id: string | null;
}

const STAGE_ORDER: P.Lead["stage"][] = [
  "new",
  "contacted",
  "qualified",
  "viewing",
  "viewed",
  "application",
  "approved",
  "won",
];
const isOpen = (stage: P.Lead["stage"]) => stage !== "won" && stage !== "lost";

const toLead = (r: LeadRow): P.Lead => ({
  id: r.id,
  number: r.number,
  contactId: r.contact_id,
  contactName: r.contact_name,
  source: r.source,
  campaign: r.campaign,
  unitId: r.unit_id,
  budgetMinor: r.budget_minor,
  bedrooms: r.bedrooms,
  moveIn: r.move_in,
  stage: r.stage,
  stageAt: r.stage_at,
  agentId: r.agent_id,
  lostReason: r.lost_reason,
  createdAt: r.created_at,
});

function toViewing(r: ViewingRow) {
  return {
    id: r.id,
    leadId: r.lead_id,
    contactId: r.contact_id,
    unitId: r.unit_id,
    agentId: r.agent_id,
    date: r.date,
    time: r.time,
    status: r.status,
    feedback: r.feedback,
    interest: r.interest,
  };
}

const toApp = (r: AppRow): P.Application => ({
  id: r.id,
  number: r.number,
  leadId: r.lead_id,
  contactId: r.contact_id,
  unitId: r.unit_id,
  status: r.status,
  employer: r.employer,
  incomeMinor: r.income_minor,
  occupants: r.occupants,
  offer: {
    rentMinor: r.offer_rent_minor,
    depositMinor: r.offer_deposit_minor,
    startDate: r.offer_start,
    months: r.offer_months,
  },
  checks: { identity: r.check_identity, income: r.check_income, reference: r.check_reference },
  screenedBy: r.screened_by,
  approvedBy: r.approved_by,
  leaseId: r.lease_id,
});

const LEAD_SQL = "SELECT l.*, c.name AS contact_name FROM pm_leads l JOIN contacts c ON c.id = l.contact_id";
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function crmService(d: PmDeps, deps: { leases: LeasesService }) {
  const { core } = d;
  const db = core.db;

  async function leadRow(t: Db, orgId: string, id: string, lock = false): Promise<LeadRow> {
    if (lock) await t.run("SELECT 1 FROM pm_leads WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    const r = await t.row<LeadRow>(`${LEAD_SQL} WHERE l.org_id = $1 AND l.id = $2`, [orgId, id]);
    if (!r) throw fail.notFound("Lead not found");
    return r;
  }

  async function appRow(t: Db, orgId: string, id: string, lock = false): Promise<AppRow> {
    const r = await t.row<AppRow>(
      `SELECT * FROM pm_applications WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!r) throw fail.notFound("Application not found");
    return r;
  }

  /** Move a lead forward (never backwards past a later stage it reached), as an activity on the contact. */
  async function advance(t: Db, s: OrgScope, lead: LeadRow, to: P.Lead["stage"], why = "") {
    if (!isOpen(lead.stage)) return;
    if (STAGE_ORDER.indexOf(to) <= STAGE_ORDER.indexOf(lead.stage)) return;
    await t.run("UPDATE pm_leads SET stage = $2, stage_at = now() WHERE id = $1", [lead.id, to]);
    await core.contacts.activity(t, {
      orgId: s.orgId,
      contactId: lead.contact_id,
      kind: "stage",
      text: `Stage: ${lead.stage} → ${to}${why ? ` · ${why}` : ""}`,
      refType: "lead",
      refId: lead.id,
      by: s.userId,
    });
    lead.stage = to;
  }

  /** A let unit (an active lease covering today or later) cannot be viewed or applied for. */
  async function unitLet(t: Db, unitId: string, from: string): Promise<boolean> {
    return !!(await t.row(
      "SELECT 1 FROM pm_leases WHERE unit_id = $1 AND status = 'active' AND (end_date IS NULL OR end_date >= $2)",
      [unitId, from],
    ));
  }

  return {
    async enquiry(
      s: OrgScope,
      b: {
        name: string;
        email?: string | undefined;
        phone?: string | undefined;
        unitId?: string | undefined;
        source: string;
        campaign?: string | undefined;
        message?: string | undefined;
        budgetMinor?: number | undefined;
        bedrooms?: number | undefined;
        moveIn?: string | undefined;
        consent?: { email: boolean; sms: boolean; marketing: boolean } | undefined;
        idempotencyKey?: string | undefined;
      },
    ) {
      if (!b.email && !b.phone) throw fail.invalid("Enter an email or a phone number");
      if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw fail.invalid("That email address is not valid");
      if (b.phone && b.phone.replace(/\D/g, "").length < 9) throw fail.invalid("That phone number is not valid");
      return db.tx(async (t) => {
        if (b.idempotencyKey) {
          const seen = await t.row<{ id: string }>(
            "SELECT id FROM pm_leads WHERE org_id = $1 AND idempotency_key = $2",
            [s.orgId, b.idempotencyKey],
          );
          if (seen) return { lead: toLead(await leadRow(t, s.orgId, seen.id)), contactReused: true, leadReused: true };
        }
        if (b.unitId) await R.unitRow(t, s.orgId, b.unitId);
        const { contact, reused } = await core.contacts.findOrCreate(
          t,
          s.orgId,
          {
            name: b.name,
            email: b.email?.toLowerCase() ?? null,
            phone: b.phone ?? null,
            types: ["prospect"] as C.ContactType[],
            consent: b.consent
              ? {
                  email: b.consent.email,
                  sms: b.consent.sms,
                  marketing: b.consent.marketing,
                  source: `Enquiry · ${b.source}`,
                }
              : undefined,
          },
          s.actor,
        );
        const open = await t.row<{ id: string }>(
          `SELECT id FROM pm_leads WHERE org_id = $1 AND contact_id = $2 AND stage NOT IN ('won', 'lost')
             AND unit_id IS NOT DISTINCT FROM $3 ORDER BY created_at LIMIT 1`,
          [s.orgId, contact.id, b.unitId ?? null],
        );
        if (open) {
          await core.contacts.activity(t, {
            orgId: s.orgId,
            contactId: contact.id,
            kind: "enquiry",
            text: `Repeat enquiry${b.message ? `: ${b.message}` : ""}`,
            refType: "lead",
            refId: open.id,
            by: s.userId,
          });
          return { lead: toLead(await leadRow(t, s.orgId, open.id)), contactReused: reused, leadReused: true };
        }
        const id = newId("pld");
        const number = await nextNumber(t, numberScope(s.orgId), "LEAD", 5);
        await t.run(
          `INSERT INTO pm_leads (id, org_id, number, contact_id, source, campaign, unit_id, budget_minor, bedrooms, move_in,
             stage, agent_id, idempotency_key, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', $11, $12, $13)`,
          [
            id,
            s.orgId,
            number,
            contact.id,
            b.source,
            b.campaign ?? null,
            b.unitId ?? null,
            b.budgetMinor ?? null,
            b.bedrooms ?? null,
            b.moveIn ?? null,
            s.role === "leasing_agent" ? s.userId : null,
            b.idempotencyKey ?? null,
            s.userId,
          ],
        );
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: contact.id,
          kind: "enquiry",
          text: `New enquiry via ${b.source}${b.message ? `: “${b.message}”` : ""}`,
          refType: "lead",
          refId: id,
          by: s.userId,
        });
        if (b.message)
          await core.contacts.recordMessage(t, {
            orgId: s.orgId,
            contactId: contact.id,
            channel: "inapp",
            direction: "in",
            body: b.message,
            refType: "lead",
            refId: id,
            by: s.userId,
          });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Lead created",
          target: number,
          detail: `${contact.name}${reused ? " (existing contact reused)" : ""}`,
        });
        return { lead: toLead(await leadRow(t, s.orgId, id)), contactReused: reused, leadReused: false };
      });
    },

    async listLeads(s: OrgScope, stage?: P.Lead["stage"]) {
      const rows = await db.rows<LeadRow>(
        `${LEAD_SQL} WHERE l.org_id = $1 AND ($2::text IS NULL OR l.stage = $2) ORDER BY l.created_at DESC`,
        [s.orgId, stage ?? null],
      );
      return { leads: rows.map(toLead) };
    },

    async move(s: OrgScope, id: string, b: { stage: "new" | "contacted" | "qualified"; note: string }) {
      await db.tx(async (t) => {
        const l = await leadRow(t, s.orgId, id, true);
        if (!isOpen(l.stage)) throw fail.conflict(`This lead is ${l.stage}`);
        if (l.stage === b.stage) return;
        await t.run(
          "UPDATE pm_leads SET stage = $2, stage_at = now(), first_response_at = COALESCE(first_response_at, now()) WHERE id = $1",
          [id, b.stage],
        );
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: l.contact_id,
          kind: "stage",
          text: `Stage: ${l.stage} → ${b.stage}${b.note ? ` · ${b.note}` : ""}`,
          refType: "lead",
          refId: id,
          by: s.userId,
        });
      });
      return toLead(await leadRow(db, s.orgId, id));
    },

    async lose(s: OrgScope, id: string, b: { reason: string; note: string }) {
      await db.tx(async (t) => {
        const l = await leadRow(t, s.orgId, id, true);
        if (!isOpen(l.stage)) throw fail.conflict(`This lead is already ${l.stage}`);
        await t.run(
          "UPDATE pm_leads SET stage = 'lost', stage_at = now(), lost_reason = $2, lost_note = $3 WHERE id = $1",
          [id, b.reason, b.note],
        );
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: l.contact_id,
          kind: "stage",
          text: `Lead lost: ${b.reason}${b.note ? ` · ${b.note}` : ""}`,
          refType: "lead",
          refId: id,
          by: s.userId,
        });
      });
      return toLead(await leadRow(db, s.orgId, id));
    },

    async scheduleViewing(
      s: OrgScope,
      b: { leadId: string; unitId?: string | undefined; date: string; time: string; agentId?: string | undefined },
    ) {
      if (b.date < s.today) throw fail.invalid("Pick today or a future date");
      const id = await db.tx(async (t) => {
        const l = await leadRow(t, s.orgId, b.leadId, true);
        if (!isOpen(l.stage)) throw fail.conflict(`This lead is ${l.stage}`);
        const unitId = b.unitId ?? l.unit_id;
        if (!unitId) throw fail.invalid("Choose the unit to view");
        await R.unitRow(t, s.orgId, unitId);
        if (await unitLet(t, unitId, b.date)) throw fail.conflict("That unit is let");
        const agent = b.agentId ?? l.agent_id ?? s.userId;
        const member = await t.row(
          "SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
          [s.orgId, agent],
        );
        if (!member) throw fail.invalid("The agent is not a member of this organisation");
        // the agent cannot be in two viewings within the same hour (locked per agent and day)
        await t.run("SELECT pg_advisory_xact_lock(hashtext('pm-viewing:' || $1 || ':' || $2))", [agent, b.date]);
        const same = await t.rows<{ time: string }>(
          "SELECT time FROM pm_viewings WHERE org_id = $1 AND agent_id = $2 AND date = $3 AND status = 'scheduled'",
          [s.orgId, agent, b.date],
        );
        const clash = same.find((v) => Math.abs(minutes(v.time) - minutes(b.time)) < 60);
        if (clash) throw fail.conflict(`The agent already has a viewing at ${clash.time} that day`);
        const id = newId("pvw");
        await t.run(
          `INSERT INTO pm_viewings (id, org_id, lead_id, contact_id, unit_id, agent_id, date, time, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9)`,
          [id, s.orgId, l.id, l.contact_id, unitId, agent, b.date, b.time, s.userId],
        );
        if (!l.unit_id) await t.run("UPDATE pm_leads SET unit_id = $2 WHERE id = $1", [l.id, unitId]);
        await t.run("UPDATE pm_leads SET first_response_at = COALESCE(first_response_at, now()) WHERE id = $1", [l.id]);
        await advance(t, s, l, "viewing", `${b.date} ${b.time}`);
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: l.contact_id,
          kind: "viewing",
          text: `Viewing booked ${b.date} ${b.time}`,
          refType: "viewing",
          refId: id,
          by: s.userId,
        });
        return id;
      });
      return toViewing((await db.row<ViewingRow>("SELECT * FROM pm_viewings WHERE id = $1", [id])) as ViewingRow);
    },

    async viewingOutcome(
      s: OrgScope,
      id: string,
      b: { attended: boolean; feedback: string; interest?: number | undefined },
    ) {
      await db.tx(async (t) => {
        const v = await t.row<ViewingRow>("SELECT * FROM pm_viewings WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          id,
        ]);
        if (!v) throw fail.notFound("Viewing not found");
        if (v.status !== "scheduled") throw fail.conflict("The outcome is already recorded");
        await t.run("UPDATE pm_viewings SET status = $2, feedback = $3, interest = $4 WHERE id = $1", [
          id,
          b.attended ? "completed" : "no_show",
          b.feedback,
          b.attended ? (b.interest ?? null) : null,
        ]);
        const l = await leadRow(t, s.orgId, v.lead_id, true);
        if (b.attended) await advance(t, s, l, "viewed");
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: v.contact_id,
          kind: "viewing",
          text: b.attended
            ? `Viewing completed · interest ${b.interest ?? "—"}/5${b.feedback ? ` · ${b.feedback}` : ""}`
            : "Did not attend the viewing",
          refType: "viewing",
          refId: id,
          by: s.userId,
        });
      });
      return toViewing((await db.row<ViewingRow>("SELECT * FROM pm_viewings WHERE id = $1", [id])) as ViewingRow);
    },

    async listViewings(s: OrgScope, date?: string) {
      const rows = await db.rows<ViewingRow>(
        "SELECT * FROM pm_viewings WHERE org_id = $1 AND ($2::date IS NULL OR date = $2) ORDER BY date, time",
        [s.orgId, date ?? null],
      );
      return { viewings: rows.map(toViewing) };
    },

    async startApplication(
      s: OrgScope,
      b: {
        leadId: string;
        unitId?: string | undefined;
        employer: string;
        incomeMinor?: number | undefined;
        occupants: number;
        offer: { rentMinor: number; depositMinor: number; startDate: string; months: number };
      },
    ) {
      const id = await db.tx(async (t) => {
        const l = await leadRow(t, s.orgId, b.leadId, true);
        if (!isOpen(l.stage)) throw fail.conflict(`This lead is ${l.stage}`);
        const unitId = b.unitId ?? l.unit_id;
        if (!unitId) throw fail.invalid("The lead needs a unit before applying");
        await R.unitRow(t, s.orgId, unitId);
        if (await unitLet(t, unitId, b.offer.startDate))
          throw fail.conflict("That unit is let for the offered start date");
        const existing = await t.row<{ number: string }>(
          "SELECT number FROM pm_applications WHERE lead_id = $1 AND unit_id = $2 AND status NOT IN ('rejected', 'withdrawn')",
          [l.id, unitId],
        );
        if (existing) throw fail.conflict(`Application ${existing.number} is already open for this lead and unit`);
        const id = newId("pap");
        const number = await nextNumber(t, numberScope(s.orgId), "APP", 5);
        await t.run(
          `INSERT INTO pm_applications (id, org_id, number, lead_id, contact_id, unit_id, status, employer, income_minor,
             occupants, offer_rent_minor, offer_deposit_minor, offer_start, offer_months, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            id,
            s.orgId,
            number,
            l.id,
            l.contact_id,
            unitId,
            b.employer,
            b.incomeMinor ?? null,
            b.occupants,
            b.offer.rentMinor,
            b.offer.depositMinor,
            b.offer.startDate,
            b.offer.months,
            s.userId,
          ],
        );
        await advance(t, s, l, "application", number);
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: l.contact_id,
          kind: "application",
          text: `Application ${number} started`,
          refType: "application",
          refId: id,
          by: s.userId,
        });
        return id;
      });
      return toApp(await appRow(db, s.orgId, id));
    },

    async listApplications(s: OrgScope) {
      const rows = await db.rows<AppRow>("SELECT * FROM pm_applications WHERE org_id = $1 ORDER BY created_at DESC", [
        s.orgId,
      ]);
      return { applications: rows.map(toApp) };
    },

    async screen(s: OrgScope, id: string, b: { identity: boolean; income: boolean; reference: boolean }) {
      await db.tx(async (t) => {
        const a = await appRow(t, s.orgId, id, true);
        if (a.status !== "submitted" && a.status !== "screening")
          throw fail.conflict(`This application is ${a.status}`);
        await t.run(
          `UPDATE pm_applications SET status = 'screening', check_identity = $2, check_income = $3, check_reference = $4,
             screened_by = $5 WHERE id = $1`,
          [id, b.identity, b.income, b.reference, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Application screened",
          target: a.number,
          after: b,
        });
      });
      return toApp(await appRow(db, s.orgId, id));
    },

    async decide(s: OrgScope, id: string, b: { approve: boolean; note: string }) {
      await db.tx(async (t) => {
        const a = await appRow(t, s.orgId, id, true);
        if (a.status !== "screening") throw fail.conflict("Screen the application before deciding");
        if (a.screened_by === s.userId)
          throw fail.separationOfDuties("You screened this application — another manager must decide it");
        if (b.approve && !(a.check_identity && a.check_income && a.check_reference))
          throw fail.conflict("Complete all screening checks (identity, income, reference) first");
        await t.run("UPDATE pm_applications SET status = $2, approved_by = $3, decision_note = $4 WHERE id = $1", [
          id,
          b.approve ? "approved" : "rejected",
          s.userId,
          b.note,
        ]);
        const l = await leadRow(t, s.orgId, a.lead_id, true);
        if (b.approve) await advance(t, s, l, "approved", a.number);
        await core.contacts.activity(t, {
          orgId: s.orgId,
          contactId: a.contact_id,
          kind: "application",
          text: `Application ${a.number} ${b.approve ? "approved" : "rejected"}${b.note ? ` · ${b.note}` : ""}`,
          refType: "application",
          refId: id,
          by: s.userId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.approve ? "Application approved" : "Application rejected",
          target: a.number,
          detail: b.note,
        });
      });
      return toApp(await appRow(db, s.orgId, id));
    },

    async convert(s: OrgScope, id: string) {
      const leaseId = await db.tx(async (t) => {
        const a = await appRow(t, s.orgId, id, true);
        if (a.status === "converted" && a.lease_id) return a.lease_id;
        if (a.status !== "approved") throw fail.conflict("Only an approved application becomes a lease");
        const end = addDays(addMonths(a.offer_start, a.offer_months), -1);
        const leaseId = await deps.leases.createDraft(t, s, {
          unitId: a.unit_id,
          tenantId: a.contact_id,
          applicationId: a.id,
          startDate: a.offer_start,
          endDate: end,
          rentMinor: a.offer_rent_minor,
          depositMinor: a.offer_deposit_minor,
          depositMode: "collect",
          dueDay: 5,
          escalationPct: 0,
          escalationMonths: null,
          noticeDays: 30,
          charges: [],
        });
        await t.run("UPDATE pm_applications SET status = 'converted', lease_id = $2 WHERE id = $1", [id, leaseId]);
        await core.contacts.addTypes(t, s.orgId, a.contact_id, ["tenant"]);
        return leaseId;
      });
      return { application: toApp(await appRow(db, s.orgId, id)), lease: await deps.leases.one(s, leaseId) };
    },
  };
}

export type CrmService = ReturnType<typeof crmService>;
