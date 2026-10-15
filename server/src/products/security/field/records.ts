/*
 * Alarms and occurrence-book entries as stored, and how they are written. Other areas (roster no-shows, patrol
 * misses, visitor check-ins) raise alarms and write the book through these functions only.
 */
import type { security, z } from "@paltas/contracts";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { minutesBetween } from "../shared/util.js";

type AlarmOut = z.infer<typeof security.Alarm>;
type OccurrenceOut = z.infer<typeof security.Occurrence>;
export type Attachment = OccurrenceOut["attachments"][number];

export interface AlarmRow {
  id: string;
  number: string;
  site_id: string;
  source: AlarmOut["source"];
  provider: string | null;
  source_ref: string | null;
  guard_id: string | null;
  raised_at: string;
  detail: string;
  status: AlarmOut["status"];
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  dispatch_unit: string | null;
  dispatched_at: string | null;
  resolved_at: string | null;
  outcome: AlarmOut["outcome"];
  resolution_note: string | null;
  incident_id: string | null;
}

export const toAlarm = (a: AlarmRow): AlarmOut => ({
  id: a.id,
  number: a.number,
  siteId: a.site_id,
  source: a.source,
  provider: a.provider,
  sourceRef: a.source_ref,
  guardId: a.guard_id,
  raisedAt: a.raised_at,
  detail: a.detail,
  status: a.status,
  acknowledgedAt: a.acknowledged_at,
  acknowledgedBy: a.acknowledged_by,
  dispatchUnit: a.dispatch_unit,
  dispatchedAt: a.dispatched_at,
  resolvedAt: a.resolved_at,
  outcome: a.outcome,
  resolutionNote: a.resolution_note,
  incidentId: a.incident_id,
  responseMinutes: a.acknowledged_at ? minutesBetween(a.raised_at, a.acknowledged_at) : null,
});

export async function findAlarm(t: Db, orgId: string, id: string, lock = false): Promise<AlarmRow> {
  const a = await t.row<AlarmRow>(
    `SELECT * FROM sec_alarms WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [orgId, id],
  );
  if (!a) throw fail.notFound("Alarm not found");
  return a;
}

export interface NewOccurrence {
  orgId: string;
  siteId: string;
  kind: OccurrenceOut["kind"];
  text: string;
  at: string;
  /** null: written by the system (an alarm received, a missed checkpoint). */
  by: string | null;
  incidentId?: string | null;
  alarmId?: string | null;
  correctsId?: string | null;
  attachments?: Attachment[];
}

/** Append an entry to the occurrence book (the table refuses any change afterwards). */
export async function writeOccurrence(t: Db, o: NewOccurrence): Promise<string> {
  const id = newId("sob");
  await t.run(
    `INSERT INTO sec_occurrences (id, org_id, number, site_id, incident_id, alarm_id, at, recorded_by, kind, text,
       corrects_id, attachments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      o.orgId,
      await nextNumber(t, o.orgId, "OB", 6),
      o.siteId,
      o.incidentId ?? null,
      o.alarmId ?? null,
      o.at,
      o.by,
      o.kind,
      o.text,
      o.correctsId ?? null,
      JSON.stringify(o.attachments ?? []),
    ],
  );
  return id;
}

export interface NewAlarm {
  orgId: string;
  siteId: string;
  source: AlarmOut["source"];
  detail: string;
  raisedAt: string;
  provider?: string | null;
  sourceRef?: string | null;
  guardId?: string | null;
}

/**
 * Raise an alarm and note it in the occurrence book. An alarm with a source reference (provider event, missed
 * checkpoint, no-show) is raised once: a repeat returns the existing alarm with duplicate = true.
 */
export async function insertAlarm(t: Db, a: NewAlarm): Promise<{ id: string; number: string; duplicate: boolean }> {
  if (a.sourceRef) {
    const existing = await t.row<{ id: string; number: string }>(
      `SELECT id, number FROM sec_alarms WHERE org_id = $1 AND source = $2 AND coalesce(provider, '') = $3
         AND source_ref = $4`,
      [a.orgId, a.source, a.provider ?? "", a.sourceRef],
    );
    if (existing) return { ...existing, duplicate: true };
  }
  const id = newId("sal");
  const number = await nextNumber(t, a.orgId, "ALM");
  await t.run(
    `INSERT INTO sec_alarms (id, org_id, number, site_id, source, provider, source_ref, guard_id, raised_at, detail,
       status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'raised')`,
    [
      id,
      a.orgId,
      number,
      a.siteId,
      a.source,
      a.provider ?? null,
      a.sourceRef ?? null,
      a.guardId ?? null,
      a.raisedAt,
      a.detail,
    ],
  );
  await writeOccurrence(t, {
    orgId: a.orgId,
    siteId: a.siteId,
    kind: "alarm",
    text: `${number} raised (${a.source.replace("_", " ")}): ${a.detail}`,
    at: a.raisedAt,
    by: null,
    alarmId: id,
  });
  return { id, number, duplicate: false };
}

interface OccurrenceRow {
  id: string;
  number: string;
  site_id: string;
  incident_id: string | null;
  alarm_id: string | null;
  at: string;
  recorded_at: string;
  recorded_by: string | null;
  kind: OccurrenceOut["kind"];
  text: string;
  corrects_id: string | null;
  attachments: Attachment[];
  corrected_by: string[];
}

export const OCCURRENCE_SELECT = `SELECT o.*, COALESCE((SELECT array_agg(c.id ORDER BY c.recorded_at) FROM sec_occurrences c
  WHERE c.corrects_id = o.id), '{}') AS corrected_by FROM sec_occurrences o`;

export const toOccurrence = (o: OccurrenceRow): OccurrenceOut => ({
  id: o.id,
  number: o.number,
  siteId: o.site_id,
  incidentId: o.incident_id,
  alarmId: o.alarm_id,
  at: o.at,
  recordedAt: o.recorded_at,
  recordedBy: o.recorded_by,
  kind: o.kind,
  text: o.text,
  correctsId: o.corrects_id,
  correctedBy: o.corrected_by,
  attachments: o.attachments,
});

export async function occurrences(t: Db, where: string, params: unknown[]): Promise<OccurrenceOut[]> {
  const rows = await t.rows<OccurrenceRow>(`${OCCURRENCE_SELECT} WHERE ${where} ORDER BY o.at, o.number`, params);
  return rows.map(toOccurrence);
}
