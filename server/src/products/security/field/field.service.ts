/*
 * The field and the control room: patrol rounds with checkpoint scans (a missed checkpoint raises an alarm),
 * incidents (facts fixed once reported; the reporter cannot close), the append-only occurrence book (corrections are
 * new entries), and alarms from guards (panic), the control room (manual), the roster (no-shows), patrols (missed
 * checkpoints) and monitoring providers (signed webhook) — acknowledged, dispatched and resolved with response times.
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { resolveEntitlement } from "../../../core/subscriptions/entitlement.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { SecurityDeps } from "../deps.js";
import { actingGuard, findGuard } from "../shared/access.js";
import { addMinutes, findSite, memberRole, must, type SiteRow } from "../shared/util.js";
import {
  findAlarm,
  insertAlarm,
  occurrences,
  OCCURRENCE_SELECT,
  toAlarm,
  toOccurrence,
  writeOccurrence,
  type AlarmRow,
} from "./records.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type PatrolOut = z.infer<typeof security.Patrol>;
type IncidentOut = z.infer<typeof security.Incident>;

interface PatrolRow {
  id: string;
  site_id: string;
  guard_id: string;
  shift_id: string | null;
  started_at: string;
  closed_at: string | null;
}

interface IncidentRow {
  id: string;
  number: string;
  site_id: string;
  type: string;
  severity: IncidentOut["severity"];
  description: string;
  occurred_at: string;
  reported_by: string;
  reported_at: string;
  guard_id: string | null;
  alarm_id: string | null;
  status: IncidentOut["status"];
  investigator_user: string | null;
  closed_by: string | null;
  closed_at: string | null;
  closing_note: string | null;
}

const toIncident = (i: IncidentRow): IncidentOut => ({
  id: i.id,
  number: i.number,
  siteId: i.site_id,
  type: i.type,
  severity: i.severity,
  description: i.description,
  occurredAt: i.occurred_at,
  reportedBy: i.reported_by,
  reportedAt: i.reported_at,
  guardId: i.guard_id,
  alarmId: i.alarm_id,
  status: i.status,
  investigatorUserId: i.investigator_user,
  closedBy: i.closed_by,
  closedAt: i.closed_at,
  closingNote: i.closing_note,
});

const later = (a: string, b: string) => new Date(a).getTime() >= new Date(b).getTime();

/** A patrol round with each checkpoint's state and, once closed, its on-time compliance. */
export async function patrolOut(t: Db, orgId: string, id: string): Promise<PatrolOut> {
  const p = await t.row<PatrolRow>("SELECT * FROM sec_patrols WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!p) throw fail.notFound("Patrol not found");
  const cps = await t.rows<{
    id: string;
    code: string;
    name: string;
    offset_minutes: number;
    grace_minutes: number;
    scanned_at: string | null;
    method: string | null;
  }>(
    `SELECT c.id, c.code, c.name, c.offset_minutes, c.grace_minutes, x.scanned_at, x.method FROM sec_checkpoints c
     LEFT JOIN sec_patrol_scans x ON x.checkpoint_id = c.id AND x.patrol_id = $2
     WHERE c.site_id = $1 ORDER BY c.seq`,
    [p.site_id, p.id],
  );
  const checkpoints = cps.map((c) => {
    const dueBy = addMinutes(p.started_at, c.offset_minutes + c.grace_minutes);
    const state: PatrolOut["checkpoints"][number]["state"] = c.scanned_at
      ? later(dueBy, c.scanned_at)
        ? "on_time"
        : "late"
      : p.closed_at
        ? "missed"
        : "due";
    return { checkpointId: c.id, code: c.code, name: c.name, dueBy, scannedAt: c.scanned_at, method: c.method, state };
  });
  const onTime = checkpoints.filter((c) => c.state === "on_time").length;
  return {
    id: p.id,
    siteId: p.site_id,
    guardId: p.guard_id,
    shiftId: p.shift_id,
    startedAt: p.started_at,
    closedAt: p.closed_at,
    status: p.closed_at ? "closed" : "in_progress",
    checkpoints,
    compliancePct: p.closed_at && checkpoints.length ? Math.round((onTime / checkpoints.length) * 1000) / 10 : null,
  };
}

export function fieldService(d: SecurityDeps) {
  const { ctx } = d;
  const { db } = d.core;

  async function patrolRow(t: Db, orgId: string, id: string): Promise<PatrolRow> {
    const p = await t.row<PatrolRow>("SELECT * FROM sec_patrols WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, id]);
    if (!p) throw fail.notFound("Patrol not found");
    return p;
  }

  async function incidentRow(t: Db, orgId: string, id: string, lock = false): Promise<IncidentRow> {
    const i = await t.row<IncidentRow>(
      `SELECT * FROM sec_incidents WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!i) throw fail.notFound("Incident not found");
    return i;
  }

  async function incidentDetail(t: Db, orgId: string, id: string) {
    const i = await incidentRow(t, orgId, id);
    return { ...toIncident(i), timeline: await occurrences(t, "o.org_id = $1 AND o.incident_id = $2", [orgId, id]) };
  }

  async function insertIncident(
    t: Db,
    s: OrgScope,
    site: SiteRow,
    b: {
      type: string;
      severity: IncidentOut["severity"];
      description: string;
      occurredAt: string;
      guardId?: string | undefined;
      alarmId?: string | undefined;
      attachments: z.output<typeof security.reportIncident.body>["attachments"];
    },
  ): Promise<string> {
    if (b.guardId) await findGuard(t, s.orgId, b.guardId);
    if (b.alarmId) {
      const a = await findAlarm(t, s.orgId, b.alarmId, true);
      if (a.site_id !== site.id) throw fail.invalid("That alarm belongs to another site");
    }
    const id = newId("sin");
    const number = await nextNumber(t, s.orgId, "INC");
    await t.run(
      `INSERT INTO sec_incidents (id, org_id, number, site_id, type, severity, description, occurred_at, reported_by,
         guard_id, alarm_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open')`,
      [
        id,
        s.orgId,
        number,
        site.id,
        b.type,
        b.severity,
        b.description,
        b.occurredAt,
        s.userId,
        b.guardId ?? null,
        b.alarmId ?? null,
      ],
    );
    if (b.alarmId)
      await t.run("UPDATE sec_alarms SET incident_id = $2 WHERE id = $1 AND incident_id IS NULL", [b.alarmId, id]);
    await writeOccurrence(t, {
      orgId: s.orgId,
      siteId: site.id,
      kind: "incident",
      text: `${number} ${b.type} (${b.severity}) reported: ${b.description}`,
      at: b.occurredAt,
      by: s.userId,
      incidentId: id,
      alarmId: b.alarmId ?? null,
      attachments: b.attachments,
    });
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Incident reported",
      target: number,
      detail: b.type,
    });
    return id;
  }

  async function alarmStep(t: Db, s: OrgScope, a: AlarmRow, text: string, at: string) {
    await writeOccurrence(t, {
      orgId: s.orgId,
      siteId: a.site_id,
      kind: "alarm",
      text,
      at,
      by: s.userId,
      alarmId: a.id,
    });
  }

  return {
    // ---------------------------------------------------------------- patrols
    async listPatrols(s: OrgScope, q: z.output<typeof security.listPatrols.query>) {
      const ids = await db.rows<{ id: string }>(
        `SELECT id FROM sec_patrols WHERE org_id = $1 AND started_at >= $2 AND started_at < $3
           AND ($4::text IS NULL OR site_id = $4) ORDER BY started_at`,
        [s.orgId, q.from, q.to, q.siteId ?? null],
      );
      const patrols = [];
      for (const r of ids) patrols.push(await patrolOut(db, s.orgId, r.id));
      return { patrols };
    },

    async startPatrol(s: OrgScope, b: Body<typeof security.startPatrol>) {
      return db.tx(async (t) => {
        const site = await findSite(t, s.orgId, b.siteId);
        const g = await actingGuard(t, s, b.guardId);
        if (b.shiftId) {
          const sh = await t.row<{ guard_id: string | null; site_id: string }>(
            "SELECT guard_id, site_id FROM sec_shifts WHERE org_id = $1 AND id = $2",
            [s.orgId, b.shiftId],
          );
          if (!sh) throw fail.notFound("Shift not found");
          if (sh.guard_id !== g.id || sh.site_id !== site.id)
            throw fail.invalid("That shift is not this guard's at this site");
        }
        const cps = await t.row<{ n: number }>("SELECT count(*)::int AS n FROM sec_checkpoints WHERE site_id = $1", [
          site.id,
        ]);
        if (!cps?.n) throw fail.conflict("This site has no patrol checkpoints");
        const id = newId("spt");
        await t.run(
          "INSERT INTO sec_patrols (id, org_id, site_id, guard_id, shift_id, started_at, started_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [id, s.orgId, site.id, g.id, b.shiftId ?? null, b.startedAt, s.userId],
        );
        await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: site.id,
          kind: "patrol",
          text: `Patrol round started by ${g.name}`,
          at: b.startedAt,
          by: s.userId,
        });
        return patrolOut(t, s.orgId, id);
      });
    },

    async scanCheckpoint(s: OrgScope, patrolId: string, b: Body<typeof security.scanCheckpoint>) {
      return db.tx(async (t) => {
        const p = await patrolRow(t, s.orgId, patrolId);
        await actingGuard(t, s, p.guard_id);
        if (p.closed_at) throw fail.conflict("This round is closed");
        if (!later(b.scannedAt, p.started_at)) throw fail.invalid("A scan cannot be before the round started");
        const cp = await t.row<{ id: string; code: string }>(
          "SELECT id, code FROM sec_checkpoints WHERE site_id = $1 AND tag_ref = $2",
          [p.site_id, b.tagRef],
        );
        if (!cp) throw fail.invalid("This tag is not a checkpoint of this site");
        if (b.method === "manual" && !b.note)
          throw fail.invalid("A manual scan needs a note saying why the tag was not read");
        try {
          await t.run(
            `INSERT INTO sec_patrol_scans (id, org_id, patrol_id, checkpoint_id, scanned_at, method, lat, lng, note, recorded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              newId("sps"),
              s.orgId,
              patrolId,
              cp.id,
              b.scannedAt,
              b.method,
              b.lat ?? null,
              b.lng ?? null,
              b.note,
              s.userId,
            ],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw fail.conflict(`${cp.code} is already scanned in this round`);
          throw e;
        }
        return patrolOut(t, s.orgId, patrolId);
      });
    },

    async closePatrol(s: OrgScope, patrolId: string, closedAt: string) {
      return db.tx(async (t) => {
        const p = await patrolRow(t, s.orgId, patrolId);
        const g = await actingGuard(t, s, p.guard_id);
        if (p.closed_at) throw fail.conflict("This round is already closed");
        if (!later(closedAt, p.started_at)) throw fail.invalid("A round cannot close before it started");
        await t.run("UPDATE sec_patrols SET closed_at = $2 WHERE id = $1", [patrolId, closedAt]);
        const out = await patrolOut(t, s.orgId, patrolId);
        const alarmIds: string[] = [];
        for (const c of out.checkpoints.filter((x) => x.state === "missed")) {
          const a = await insertAlarm(t, {
            orgId: s.orgId,
            siteId: p.site_id,
            source: "missed_checkpoint",
            sourceRef: `${patrolId}:${c.checkpointId}`,
            guardId: g.id,
            raisedAt: closedAt,
            detail: `Checkpoint ${c.code} ${c.name} missed in ${g.name}'s round`,
          });
          alarmIds.push(a.id);
        }
        await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: p.site_id,
          kind: "patrol",
          text: `Patrol round closed by ${g.name}: ${out.compliancePct ?? 0}% on time, ${alarmIds.length} missed`,
          at: closedAt,
          by: s.userId,
        });
        return { patrol: out, alarmIds };
      });
    },

    // ---------------------------------------------------------------- incidents
    async listIncidents(s: OrgScope, filter: "all" | "open" | "high", siteId?: string) {
      const rows = await db.rows<IncidentRow>(
        `SELECT * FROM sec_incidents WHERE org_id = $1 AND ($2::text IS NULL OR site_id = $2)
           AND ($3 <> 'open' OR status <> 'closed') AND ($3 <> 'high' OR severity = 'high')
         ORDER BY occurred_at DESC, number DESC`,
        [s.orgId, siteId ?? null, filter],
      );
      return { incidents: rows.map(toIncident) };
    },

    async reportIncident(s: OrgScope, b: Body<typeof security.reportIncident>) {
      return db.tx(async (t) => {
        const site = await findSite(t, s.orgId, b.siteId);
        return incidentDetail(t, s.orgId, await insertIncident(t, s, site, b));
      });
    },

    async getIncident(s: OrgScope, id: string) {
      return incidentDetail(db, s.orgId, id);
    },

    async assignInvestigator(s: OrgScope, id: string, userId: string) {
      return db.tx(async (t) => {
        const i = await incidentRow(t, s.orgId, id, true);
        if (i.status === "closed") throw fail.conflict("This incident is closed");
        if (!(await memberRole(t, s.orgId, userId))) throw fail.invalid("The investigator must be a member");
        await t.run("UPDATE sec_incidents SET status = 'investigating', investigator_user = $2 WHERE id = $1", [
          id,
          userId,
        ]);
        await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: i.site_id,
          kind: "status",
          text: `${i.number}: investigator assigned`,
          at: new Date().toISOString(),
          by: s.userId,
          incidentId: id,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Investigator assigned",
          target: i.number,
          detail: userId,
        });
        return incidentDetail(t, s.orgId, id);
      });
    },

    async closeIncident(s: OrgScope, id: string, note: string) {
      return db.tx(async (t) => {
        const i = await incidentRow(t, s.orgId, id, true);
        if (i.status === "closed") throw fail.conflict("This incident is already closed");
        if (i.reported_by === s.userId)
          throw fail.separationOfDuties("You reported this incident: someone else must close it");
        await t.run(
          "UPDATE sec_incidents SET status = 'closed', closed_by = $2, closed_at = now(), closing_note = $3 WHERE id = $1",
          [id, s.userId, note],
        );
        await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: i.site_id,
          kind: "status",
          text: `${i.number} closed: ${note}`,
          at: new Date().toISOString(),
          by: s.userId,
          incidentId: id,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Incident closed",
          target: i.number,
          detail: note,
        });
        return incidentDetail(t, s.orgId, id);
      });
    },

    // ---------------------------------------------------------------- occurrence book
    async addOccurrence(s: OrgScope, b: Body<typeof security.addOccurrence>) {
      return db.tx(async (t) => {
        await findSite(t, s.orgId, b.siteId);
        if ((b.kind === "correction") !== Boolean(b.correctsId))
          throw fail.invalid("A correction names the entry it corrects (correctsId), and only a correction does");
        let incidentId = b.incidentId ?? null;
        if (incidentId) {
          const i = await incidentRow(t, s.orgId, incidentId);
          if (i.site_id !== b.siteId) throw fail.invalid("That incident belongs to another site");
        }
        if (b.correctsId) {
          const o = await t.row<{ site_id: string; incident_id: string | null }>(
            "SELECT site_id, incident_id FROM sec_occurrences WHERE org_id = $1 AND id = $2",
            [s.orgId, b.correctsId],
          );
          if (!o) throw fail.notFound("The entry to correct was not found");
          if (o.site_id !== b.siteId) throw fail.invalid("That entry belongs to another site's book");
          incidentId = incidentId ?? o.incident_id;
        }
        const id = await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: b.siteId,
          kind: b.kind,
          text: b.text,
          at: b.at,
          by: s.userId,
          incidentId,
          correctsId: b.correctsId ?? null,
          attachments: b.attachments,
        });
        const row = await t.row<Parameters<typeof toOccurrence>[0]>(`${OCCURRENCE_SELECT} WHERE o.id = $1`, [id]);
        return toOccurrence(must(row, "the new entry"));
      });
    },

    async listOccurrences(s: OrgScope, q: z.output<typeof security.listOccurrences.query>) {
      await findSite(db, s.orgId, q.siteId);
      return {
        entries: await occurrences(db, "o.org_id = $1 AND o.site_id = $2 AND o.at >= $3 AND o.at < $4", [
          s.orgId,
          q.siteId,
          q.from,
          q.to,
        ]),
      };
    },

    // ---------------------------------------------------------------- alarms
    async listAlarms(s: OrgScope, active: "true" | "false" | undefined, siteId?: string) {
      const rows = await db.rows<AlarmRow>(
        `SELECT * FROM sec_alarms WHERE org_id = $1 AND ($2::text IS NULL OR site_id = $2)
           AND ($3::text IS NULL OR (status <> 'resolved') = ($3 = 'true'))
         ORDER BY (status = 'resolved'), raised_at DESC, number DESC`,
        [s.orgId, siteId ?? null, active ?? null],
      );
      return { alarms: rows.map(toAlarm) };
    },

    async raisePanic(s: OrgScope, b: Body<typeof security.raisePanic>) {
      return db.tx(async (t) => {
        const site = await findSite(t, s.orgId, b.siteId);
        const g = await actingGuard(t, s, b.guardId);
        const where = b.lat !== undefined && b.lng !== undefined ? ` at ${b.lat}, ${b.lng} (as submitted)` : "";
        const a = await insertAlarm(t, {
          orgId: s.orgId,
          siteId: site.id,
          source: "panic",
          guardId: g.id,
          raisedAt: b.at,
          detail: `Panic raised by ${g.name} (${g.number})${where}`,
        });
        return toAlarm(await findAlarm(t, s.orgId, a.id));
      });
    },

    async raiseAlarm(s: OrgScope, b: Body<typeof security.raiseAlarm>) {
      return db.tx(async (t) => {
        await findSite(t, s.orgId, b.siteId);
        const a = await insertAlarm(t, {
          orgId: s.orgId,
          siteId: b.siteId,
          source: "manual",
          raisedAt: b.at,
          detail: b.detail,
        });
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Alarm recorded", target: a.number });
        return toAlarm(await findAlarm(t, s.orgId, a.id));
      });
    },

    async acknowledgeAlarm(s: OrgScope, id: string, at: string) {
      return db.tx(async (t) => {
        const a = await findAlarm(t, s.orgId, id, true);
        if (a.status !== "raised") throw fail.conflict(`This alarm is already ${a.status}`);
        if (!later(at, a.raised_at)) throw fail.invalid("An alarm cannot be acknowledged before it was raised");
        await t.run(
          "UPDATE sec_alarms SET status = 'acknowledged', acknowledged_at = $2, acknowledged_by = $3 WHERE id = $1",
          [id, at, s.userId],
        );
        await alarmStep(t, s, a, `${a.number} acknowledged`, at);
        return toAlarm(await findAlarm(t, s.orgId, id));
      });
    },

    async dispatchAlarm(s: OrgScope, id: string, unit: string, at: string) {
      return db.tx(async (t) => {
        const a = await findAlarm(t, s.orgId, id, true);
        if (a.status !== "acknowledged")
          throw fail.conflict("Acknowledge the alarm before dispatching (or it is resolved)");
        if (!later(at, a.acknowledged_at ?? a.raised_at))
          throw fail.invalid("Dispatch cannot be before the acknowledgement");
        await t.run(
          "UPDATE sec_alarms SET status = 'dispatched', dispatch_unit = $2, dispatched_at = $3, dispatched_by = $4 WHERE id = $1",
          [id, unit, at, s.userId],
        );
        await alarmStep(t, s, a, `${a.number}: ${unit} dispatched`, at);
        return toAlarm(await findAlarm(t, s.orgId, id));
      });
    },

    async resolveAlarm(s: OrgScope, id: string, b: Body<typeof security.resolveAlarm>) {
      return db.tx(async (t) => {
        const a = await findAlarm(t, s.orgId, id, true);
        if (a.status === "raised") throw fail.conflict("Acknowledge the alarm first");
        if (a.status === "resolved") throw fail.conflict("This alarm is already resolved");
        if (!later(b.at, a.dispatched_at ?? a.acknowledged_at ?? a.raised_at))
          throw fail.invalid("Resolution cannot be before the response");
        if (b.incident && b.outcome === "false_alarm") throw fail.invalid("A false alarm does not open an incident");
        await t.run(
          `UPDATE sec_alarms SET status = 'resolved', resolved_at = $2, resolved_by = $3, outcome = $4, resolution_note = $5
           WHERE id = $1`,
          [id, b.at, s.userId, b.outcome, b.note],
        );
        await alarmStep(t, s, a, `${a.number} resolved (${b.outcome.replace("_", " ")}): ${b.note}`, b.at);
        if (b.incident) {
          const site = await findSite(t, s.orgId, a.site_id);
          await insertIncident(t, s, site, {
            ...b.incident,
            occurredAt: a.raised_at,
            guardId: a.guard_id ?? undefined,
            alarmId: a.id,
            attachments: [],
          });
        }
        return toAlarm(await findAlarm(t, s.orgId, id));
      });
    },

    /** A signed event from a monitoring provider; the signature was checked by the route layer. */
    async inboundAlarm(provider: string, b: Body<typeof security.alarmWebhook>) {
      return db.tx(async (t) => {
        const site = await t.row<SiteRow>(
          "SELECT * FROM sec_sites WHERE alarm_provider = $1 AND alarm_account_ref = $2",
          [provider, b.accountRef],
        );
        if (!site) throw fail.notFound("Unknown alarm account");
        const en = await resolveEntitlement(t, ctx.products, ctx.clock.today(), site.org_id, "security").catch(
          () => null,
        );
        if (!en) throw fail.notFound("Unknown alarm account");
        if (!en.ent.usable) throw fail.subscriptionInactive("This organisation's security subscription is not active");
        const a = await insertAlarm(t, {
          orgId: site.org_id,
          siteId: site.id,
          source: b.kind === "panic" ? "panic" : "device",
          provider,
          sourceRef: b.eventId,
          raisedAt: b.occurredAt,
          detail: `${b.kind} signal${b.zone ? " · zone " + b.zone : ""} from ${provider}`,
        });
        return { alarmId: a.id, number: a.number, duplicate: a.duplicate };
      });
    },
  };
}

export type FieldService = ReturnType<typeof fieldService>;
