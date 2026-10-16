/*
 * Rosters and attendance. Shifts are created open per post and assigned to guards; the database refuses a guard on
 * two overlapping shifts (sec_guard_not_double_booked) and each assignment first locks the guard row, so two
 * concurrent assignments of one guard are decided one after the other (the second sees the first). Assignment also
 * checks the guard is active, licensed through the shift, vetted and rested.
 *
 * Clock-in / clock-out evidence (time, position, method, device) is RECORDED AS SUBMITTED; PALTAS computes only
 * whether the submitted position is inside the site geofence. Biometric verification needs a reader (test adapter).
 * Approved timesheets feed client billing (extra cover) and payroll; whoever recorded or corrected the attendance
 * cannot approve it (logic here, and a database constraint).
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { SecurityDeps } from "../deps.js";
import { patrolOut } from "../field/field.service.js";
import { insertAlarm, writeOccurrence } from "../field/records.js";
import { loadSettings } from "../setup/setup.service.js";
import { actingGuard, findGuard, type GuardRow } from "../shared/access.js";
import { distanceM, findSite, minutesBetween, must, orgTimezone } from "../shared/util.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type ShiftOut = security.Shift;
type Evidence = z.infer<typeof security.Evidence>;
type EvidenceInput = Body<typeof security.clockIn>;

export interface ShiftRow {
  id: string;
  org_id: string;
  site_id: string;
  post_id: string;
  guard_id: string | null;
  starts_at: string;
  ends_at: string;
  extra: boolean;
  holiday: boolean;
  status: ShiftOut["status"];
  offered: boolean;
  published_at: string | null;
  clock_in: Evidence | null;
  clock_out: Evidence | null;
  clocked_in_by: string | null;
  clocked_out_by: string | null;
  no_show: boolean;
  adjusted_in_at: string | null;
  adjusted_out_at: string | null;
  adjust_reason: string | null;
  adjusted_by: string | null;
  timesheet_status: ShiftOut["timesheet"]["status"];
  normal_minutes: number;
  overtime_minutes: number;
  approved_by: string | null;
  approved_at: string | null;
}

export const toShift = (r: ShiftRow): ShiftOut => ({
  id: r.id,
  siteId: r.site_id,
  postId: r.post_id,
  guardId: r.guard_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  extra: r.extra,
  holiday: r.holiday,
  status: r.status,
  offered: r.offered,
  publishedAt: r.published_at,
  clockIn: r.clock_in,
  clockOut: r.clock_out,
  noShow: r.no_show,
  adjustment:
    r.adjusted_in_at && r.adjusted_out_at && r.adjust_reason && r.adjusted_by
      ? { inAt: r.adjusted_in_at, outAt: r.adjusted_out_at, reason: r.adjust_reason, by: r.adjusted_by }
      : null,
  timesheet: {
    status: r.timesheet_status,
    normalMinutes: r.normal_minutes,
    overtimeMinutes: r.overtime_minutes,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
  },
});

/** Worked minutes split into normal (up to the scheduled length) and overtime. */
function split(shift: ShiftRow, inAt: string, outAt: string) {
  const worked = Math.max(0, minutesBetween(inAt, outAt));
  const scheduled = minutesBetween(shift.starts_at, shift.ends_at);
  return { normal: Math.min(worked, scheduled), overtime: Math.max(0, worked - scheduled) };
}

export function rosterService(d: SecurityDeps) {
  const { db } = d.core;
  const { messaging, biometrics } = d.adapters;

  async function shiftRow(t: Db, orgId: string, id: string, lock = false): Promise<ShiftRow> {
    const r = await t.row<ShiftRow>(
      `SELECT * FROM sec_shifts WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!r) throw fail.notFound("Shift not found");
    return r;
  }

  /** Why this guard cannot take this shift, or null. Reads the guard's other shifts (call with the guard locked). */
  async function ineligible(t: Db, orgId: string, g: GuardRow, shift: ShiftRow, restHours: number) {
    if (g.status !== "active") return `${g.name} is not active (${g.status})`;
    if (g.vetting !== "cleared") return `${g.name}'s vetting is not cleared (${g.vetting})`;
    const tz = await orgTimezone(t, orgId);
    const end = await t.row<{ d: string }>("SELECT (($1::timestamptz) AT TIME ZONE $2)::date AS d", [
      shift.ends_at,
      tz,
    ]);
    if (g.licence_expiry < must(end, "the shift's end date").d)
      return `${g.name}'s licence expires on ${g.licence_expiry}, before this shift ends`;
    const clash = await t.row<{ id: string; overlap: boolean }>(
      `SELECT id, tstzrange(starts_at, ends_at) && tstzrange($3, $4) AS overlap FROM sec_shifts
       WHERE org_id = $1 AND guard_id = $2 AND status <> 'cancelled' AND id <> $5
         AND tstzrange(starts_at - make_interval(hours => $6), ends_at + make_interval(hours => $6)) && tstzrange($3, $4)
       ORDER BY overlap DESC LIMIT 1`,
      [orgId, g.id, shift.starts_at, shift.ends_at, shift.id, restHours],
    );
    if (clash?.overlap) return `${g.name} is already booked on an overlapping shift`;
    if (clash) return `${g.name} would have less than ${restHours} hours' rest between shifts`;
    return null;
  }

  async function evidence(t: Db, s: OrgScope, shift: ShiftRow, e: EvidenceInput): Promise<Evidence> {
    const site = await findSite(t, s.orgId, shift.site_id);
    const fence =
      site.lat !== null && site.lng !== null && site.radius_m !== null
        ? { lat: site.lat, lng: site.lng, radiusM: site.radius_m }
        : null;
    const dist =
      fence && e.lat !== undefined && e.lng !== undefined ? distanceM(fence, { lat: e.lat, lng: e.lng }) : null;
    const v = biometrics.verify({ method: e.method, deviceRef: e.deviceRef ?? null });
    return {
      capturedAt: new Date(e.capturedAt).toISOString(),
      receivedAt: new Date().toISOString(),
      method: e.method,
      lat: e.lat ?? null,
      lng: e.lng ?? null,
      accuracyM: e.accuracyM ?? null,
      deviceRef: e.deviceRef ?? null,
      insideGeofence: dist === null || !fence ? null : dist <= fence.radiusM,
      distanceM: dist,
      verified: v.verified,
      verification: v.status,
      recordedBy: s.userId,
    };
  }

  return {
    /** The signed-in guard's own duty (security.field): nothing about any other guard. */
    async myDuty(s: OrgScope, q: z.output<typeof security.myDuty.query>) {
      const g = await db.row<GuardRow>(
        "SELECT * FROM sec_guards WHERE org_id = $1 AND user_id = $2 ORDER BY id LIMIT 1",
        [s.orgId, s.userId],
      );
      if (!g) return { guard: null, shifts: [], posts: [], patrols: [] };
      const rows = await db.rows<ShiftRow>(
        `SELECT * FROM sec_shifts WHERE org_id = $1 AND guard_id = $2 AND starts_at >= $3 AND starts_at < $4
         ORDER BY starts_at, id`,
        [s.orgId, g.id, q.from, q.to],
      );
      const posts = await db.rows<{
        id: string;
        site_id: string;
        site_name: string;
        name: string;
        order_version: number;
        order_text: string;
        acknowledged: boolean;
      }>(
        `SELECT p.id, p.site_id, si.name AS site_name, p.name, p.order_version, p.order_text,
           EXISTS (SELECT 1 FROM sec_post_order_acks a WHERE a.post_id = p.id AND a.version = p.order_version
             AND a.guard_id = $2) AS acknowledged
         FROM sec_posts p JOIN sec_sites si ON si.id = p.site_id
         WHERE p.org_id = $1 AND p.id = ANY($3::text[]) ORDER BY si.name, p.name`,
        [s.orgId, g.id, [...new Set(rows.map((r) => r.post_id))]],
      );
      const patrolIds = await db.rows<{ id: string }>(
        `SELECT id FROM sec_patrols WHERE org_id = $1 AND guard_id = $2 AND started_at >= $3 AND started_at < $4
         ORDER BY started_at`,
        [s.orgId, g.id, q.from, q.to],
      );
      const patrols = [];
      for (const r of patrolIds) patrols.push(await patrolOut(db, s.orgId, r.id));
      return {
        guard: {
          id: g.id,
          name: g.name,
          grade: g.grade,
          status: g.status,
          licenceNo: g.licence_no,
          licenceExpiry: g.licence_expiry,
          homeSiteId: g.home_site_id,
        },
        shifts: rows.map(toShift),
        posts: posts.map((p) => ({
          id: p.id,
          siteId: p.site_id,
          siteName: p.site_name,
          name: p.name,
          orderVersion: p.order_version,
          orderText: p.order_text,
          acknowledged: p.acknowledged,
        })),
        patrols,
      };
    },

    async listShifts(s: OrgScope, q: z.output<typeof security.listShifts.query>) {
      const rows = await db.rows<ShiftRow>(
        `SELECT * FROM sec_shifts WHERE org_id = $1 AND starts_at >= $2 AND starts_at < $3
           AND ($4::text IS NULL OR site_id = $4) AND ($5::text IS NULL OR guard_id = $5)
           AND ($6::text IS NULL OR status = $6)
         ORDER BY starts_at, id`,
        [s.orgId, q.from, q.to, q.siteId ?? null, q.guardId ?? null, q.status ?? null],
      );
      return { shifts: rows.map(toShift) };
    },

    async createShifts(s: OrgScope, b: Body<typeof security.createShifts>) {
      return db.tx(async (t) => {
        const post = await t.row<{ id: string; site_id: string; name: string }>(
          "SELECT id, site_id, name FROM sec_posts WHERE org_id = $1 AND id = $2",
          [s.orgId, b.postId],
        );
        if (!post) throw fail.notFound("Post not found");
        const ids: string[] = [];
        for (const x of b.shifts) {
          const len = minutesBetween(x.startsAt, x.endsAt);
          if (len <= 0) throw fail.invalid("A shift must end after it starts");
          if (len > 24 * 60) throw fail.invalid("A shift cannot be longer than 24 hours");
          for (let i = 0; i < x.count; i++) {
            const id = newId("ssh");
            await t.run(
              `INSERT INTO sec_shifts (id, org_id, site_id, post_id, starts_at, ends_at, extra, holiday, status, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
              [id, s.orgId, post.site_id, post.id, x.startsAt, x.endsAt, x.extra, x.holiday, s.userId],
            );
            ids.push(id);
          }
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Shifts created",
          target: post.id,
          detail: `${ids.length} open shift(s) at ${post.name}`,
        });
        const rows = await t.rows<ShiftRow>("SELECT * FROM sec_shifts WHERE id = ANY($1) ORDER BY starts_at, id", [
          ids,
        ]);
        return { shifts: rows.map(toShift) };
      });
    },

    async assignShift(s: OrgScope, shiftId: string, guardId: string) {
      return db.tx(async (t) => {
        // the guard row first: assignments of one guard queue here, so each sees the previous one's shifts
        const g = await findGuard(t, s.orgId, guardId, true);
        const shift = await shiftRow(t, s.orgId, shiftId, true);
        if (shift.status === "cancelled") throw fail.conflict("This shift is cancelled");
        if (shift.clock_in) throw fail.conflict("This shift has started: the guard has clocked in");
        if (shift.guard_id === guardId) return toShift(shift);
        if (shift.status === "assigned")
          throw fail.conflict("This shift is already assigned to another guard: take them off it first");
        const settings = await loadSettings(t, s.orgId);
        const why = await ineligible(t, s.orgId, g, shift, settings.min_rest_hours);
        if (why) throw fail.conflict(why);
        try {
          await t.run("UPDATE sec_shifts SET guard_id = $2, status = 'assigned', offered = false WHERE id = $1", [
            shiftId,
            guardId,
          ]);
        } catch (e) {
          if ((e as { code?: string }).code === "23P01")
            throw fail.conflict(`${g.name} is already booked on an overlapping shift`);
          throw e;
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Shift assigned",
          target: shiftId,
          detail: `${g.number} ${g.name}`,
        });
        return toShift(await shiftRow(t, s.orgId, shiftId));
      });
    },

    async unassignShift(s: OrgScope, shiftId: string, cancel: boolean, reason: string) {
      return db.tx(async (t) => {
        const shift = await shiftRow(t, s.orgId, shiftId, true);
        if (shift.status === "cancelled") throw fail.conflict("This shift is already cancelled");
        if (shift.clock_in || shift.adjusted_in_at) throw fail.conflict("Attendance is recorded on this shift");
        await t.run(
          cancel
            ? "UPDATE sec_shifts SET status = 'cancelled', offered = false WHERE id = $1"
            : "UPDATE sec_shifts SET guard_id = NULL, status = 'open', published_at = NULL, no_show = false WHERE id = $1",
          [shiftId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: cancel ? "Shift cancelled" : "Guard taken off shift",
          target: shiftId,
          detail: reason,
        });
        return toShift(await shiftRow(t, s.orgId, shiftId));
      });
    },

    async offerShift(s: OrgScope, shiftId: string) {
      return db.tx(async (t) => {
        const shift = await shiftRow(t, s.orgId, shiftId, true);
        if (shift.status !== "open") throw fail.conflict("Only an open shift can be offered");
        const settings = await loadSettings(t, s.orgId);
        const guards = await t.rows<GuardRow>("SELECT * FROM sec_guards WHERE org_id = $1 AND status = 'active'", [
          s.orgId,
        ]);
        const eligible: string[] = [];
        for (const g of guards)
          if (!(await ineligible(t, s.orgId, g, shift, settings.min_rest_hours))) eligible.push(g.id);
        await t.run("UPDATE sec_shifts SET offered = true WHERE id = $1", [shiftId]);
        const delivery = messaging.deliver({
          to: `${eligible.length} guard(s)`,
          text: `Open shift ${shift.starts_at}`,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Shift offered",
          target: shiftId,
          detail: `${eligible.length} eligible guard(s) · ${delivery}`,
        });
        return { shift: toShift(await shiftRow(t, s.orgId, shiftId)), eligibleGuardIds: eligible.sort(), delivery };
      });
    },

    async publishRoster(s: OrgScope, from: string, to: string) {
      return db.tx(async (t) => {
        const n = await t.run(
          `UPDATE sec_shifts SET published_at = now() WHERE org_id = $1 AND status = 'assigned' AND published_at IS NULL
             AND starts_at >= $2 AND starts_at < $3`,
          [s.orgId, from, to],
        );
        const delivery = messaging.deliver({ to: "guards", text: `Roster ${from} – ${to}` });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Roster published",
          detail: `${n} shift(s) ${from} – ${to} · ${delivery}`,
        });
        return { published: n, delivery };
      });
    },

    async coverage(s: OrgScope, from: string, to: string) {
      if (from > to) throw fail.invalid("The start date is after the end date");
      const tz = await orgTimezone(db, s.orgId);
      const rows = await db.rows<{ site_id: string; date: string; required: number; assigned: number; open: number }>(
        `SELECT site_id, (starts_at AT TIME ZONE $2)::date AS date, count(*)::int AS required,
           count(*) FILTER (WHERE status = 'assigned')::int AS assigned, count(*) FILTER (WHERE status = 'open')::int AS open
         FROM sec_shifts WHERE org_id = $1 AND status <> 'cancelled'
           AND (starts_at AT TIME ZONE $2)::date BETWEEN $3 AND $4
         GROUP BY 1, 2 ORDER BY 2, 1`,
        [s.orgId, tz, from, to],
      );
      return {
        days: rows.map((r) => ({
          siteId: r.site_id,
          date: r.date,
          required: r.required,
          assigned: r.assigned,
          open: r.open,
        })),
      };
    },

    async clockIn(s: OrgScope, shiftId: string, e: EvidenceInput) {
      return db.tx(async (t) => {
        const shift = await shiftRow(t, s.orgId, shiftId, true);
        if (shift.status !== "assigned" || !shift.guard_id) throw fail.conflict("This shift has no guard assigned");
        const g = await actingGuard(t, s, shift.guard_id);
        if (shift.clock_in) throw fail.conflict("Already clocked in");
        const settings = await loadSettings(t, s.orgId);
        const early = minutesBetween(e.capturedAt, shift.starts_at);
        if (early > settings.clock_in_early_minutes)
          throw fail.conflict(`Clock-in opens ${settings.clock_in_early_minutes} minutes before the shift starts`);
        if (new Date(e.capturedAt) >= new Date(shift.ends_at)) throw fail.conflict("This shift has already ended");
        const post = await t.row<{ order_version: number; acked: boolean }>(
          `SELECT p.order_version, EXISTS (SELECT 1 FROM sec_post_order_acks a WHERE a.post_id = p.id
             AND a.version = p.order_version AND a.guard_id = $2) AS acked FROM sec_posts p WHERE p.id = $1`,
          [shift.post_id, g.id],
        );
        if (post && post.order_version > 0 && !post.acked)
          throw fail.conflict(`Acknowledge post order version ${post.order_version} before clocking in`);
        const ev = await evidence(t, s, shift, e);
        await t.run("UPDATE sec_shifts SET clock_in = $2, clocked_in_by = $3 WHERE id = $1", [
          shiftId,
          JSON.stringify(ev),
          s.userId,
        ]);
        await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: shift.site_id,
          kind: "entry",
          text: `${g.name} (${g.number}) clocked in${ev.insideGeofence === false ? ` — OUTSIDE the geofence (${ev.distanceM} m)` : ""}`,
          at: ev.capturedAt,
          by: s.userId,
        });
        return toShift(await shiftRow(t, s.orgId, shiftId));
      });
    },

    async clockOut(s: OrgScope, shiftId: string, e: EvidenceInput) {
      return db.tx(async (t) => {
        const shift = await shiftRow(t, s.orgId, shiftId, true);
        if (!shift.guard_id || !shift.clock_in) throw fail.conflict("Clock in first");
        const g = await actingGuard(t, s, shift.guard_id);
        if (shift.clock_out) throw fail.conflict("Already clocked out");
        const ev = await evidence(t, s, shift, e);
        if (new Date(ev.capturedAt) <= new Date(shift.clock_in.capturedAt))
          throw fail.invalid("Clock-out must be after clock-in");
        const m = split(
          shift,
          shift.adjusted_in_at ?? shift.clock_in.capturedAt,
          shift.adjusted_out_at ?? ev.capturedAt,
        );
        await t.run(
          `UPDATE sec_shifts SET clock_out = $2, clocked_out_by = $3, timesheet_status = 'submitted', normal_minutes = $4,
             overtime_minutes = $5 WHERE id = $1`,
          [shiftId, JSON.stringify(ev), s.userId, m.normal, m.overtime],
        );
        await writeOccurrence(t, {
          orgId: s.orgId,
          siteId: shift.site_id,
          kind: "entry",
          text: `${g.name} (${g.number}) clocked out`,
          at: ev.capturedAt,
          by: s.userId,
        });
        return toShift(await shiftRow(t, s.orgId, shiftId));
      });
    },

    async adjustAttendance(s: OrgScope, shiftId: string, inAt: string, outAt: string, reason: string) {
      if (new Date(outAt) <= new Date(inAt)) throw fail.invalid("The worked time must end after it starts");
      return db.tx(async (t) => {
        const shift = await shiftRow(t, s.orgId, shiftId, true);
        if (shift.status !== "assigned") throw fail.conflict("This shift has no guard assigned");
        if (shift.timesheet_status === "approved") throw fail.conflict("This timesheet is approved already");
        const m = split(shift, inAt, outAt);
        await t.run(
          `UPDATE sec_shifts SET adjusted_in_at = $2, adjusted_out_at = $3, adjust_reason = $4, adjusted_by = $5,
             timesheet_status = 'submitted', normal_minutes = $6, overtime_minutes = $7 WHERE id = $1`,
          [shiftId, inAt, outAt, reason, s.userId, m.normal, m.overtime],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Attendance corrected",
          target: shiftId,
          detail: reason,
          before: { clockIn: shift.clock_in?.capturedAt ?? null, clockOut: shift.clock_out?.capturedAt ?? null },
          after: { inAt, outAt },
        });
        return toShift(await shiftRow(t, s.orgId, shiftId));
      });
    },

    async detectNoShows(s: OrgScope) {
      return db.tx(async (t) => {
        const settings = await loadSettings(t, s.orgId);
        const due = await t.rows<ShiftRow & { guard_name: string; post_name: string }>(
          `SELECT sh.*, g.name AS guard_name, p.name AS post_name FROM sec_shifts sh
             JOIN sec_guards g ON g.id = sh.guard_id JOIN sec_posts p ON p.id = sh.post_id
           WHERE sh.org_id = $1 AND sh.status = 'assigned' AND sh.clock_in IS NULL AND sh.adjusted_in_at IS NULL
             AND NOT sh.no_show AND sh.starts_at + make_interval(mins => $2) < now()
           ORDER BY sh.starts_at FOR UPDATE OF sh`,
          [s.orgId, settings.no_show_grace_minutes],
        );
        const alarmIds: string[] = [];
        for (const sh of due) {
          await t.run("UPDATE sec_shifts SET no_show = true WHERE id = $1", [sh.id]);
          const a = await insertAlarm(t, {
            orgId: s.orgId,
            siteId: sh.site_id,
            source: "no_show",
            sourceRef: sh.id,
            guardId: sh.guard_id,
            raisedAt: new Date(
              new Date(sh.starts_at).getTime() + settings.no_show_grace_minutes * 60_000,
            ).toISOString(),
            detail: `${sh.guard_name} did not clock in at ${sh.post_name}`,
          });
          alarmIds.push(a.id);
        }
        return { shiftIds: due.map((x) => x.id), alarmIds };
      });
    },

    async listTimesheets(s: OrgScope, status: "submitted" | "approved") {
      const rows = await db.rows<ShiftRow>(
        "SELECT * FROM sec_shifts WHERE org_id = $1 AND timesheet_status = $2 ORDER BY starts_at, id",
        [s.orgId, status],
      );
      return { shifts: rows.map(toShift) };
    },

    async approveTimesheets(s: OrgScope, shiftIds: string[]) {
      return db.tx(async (t) => {
        const out: ShiftOut[] = [];
        for (const id of [...new Set(shiftIds)].sort()) {
          const sh = await shiftRow(t, s.orgId, id, true);
          if (sh.timesheet_status !== "submitted")
            throw fail.conflict(`Shift ${id} has no timesheet awaiting approval`);
          if (!sh.guard_id) throw fail.conflict(`Shift ${id} has no guard`);
          const g = await findGuard(t, s.orgId, sh.guard_id);
          if (g.user_id === s.userId) throw fail.separationOfDuties("You cannot approve your own timesheet");
          if ([sh.clocked_in_by, sh.clocked_out_by, sh.adjusted_by].includes(s.userId))
            throw fail.separationOfDuties(
              "You recorded or corrected this attendance: someone else must approve the timesheet",
            );
          await t.run(
            "UPDATE sec_shifts SET timesheet_status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
            [id, s.userId],
          );
          out.push(toShift(await shiftRow(t, s.orgId, id)));
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Timesheets approved",
          detail: `${out.length} timesheet(s)`,
        });
        return { shifts: out };
      });
    },

    async sendMessage(s: OrgScope, b: Body<typeof security.sendMessage>) {
      return db.tx(async (t) => {
        let guards: { id: string; name: string }[];
        if ("guardId" in b.to) {
          const g = await findGuard(t, s.orgId, b.to.guardId);
          guards = [{ id: g.id, name: g.name }];
        } else {
          guards = await t.rows<{ id: string; name: string }>(
            `SELECT DISTINCT g.id, g.name FROM sec_shifts sh JOIN sec_guards g ON g.id = sh.guard_id
             WHERE sh.org_id = $1 AND sh.status = 'assigned' AND sh.starts_at <= $2 AND sh.ends_at > $2 ORDER BY g.id`,
            [s.orgId, b.to.at],
          );
        }
        let delivery = messaging.deliver({ to: "nobody", text: b.text });
        for (const g of guards) {
          delivery = messaging.deliver({ to: g.name, text: b.text });
          await t.run(
            "INSERT INTO sec_messages (id, org_id, guard_id, text, status, sent_by) VALUES ($1,$2,$3,$4,$5,$6)",
            [newId("smg"), s.orgId, g.id, b.text, delivery, s.userId],
          );
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Message to guards recorded",
          detail: `${guards.length} recipient(s) · ${delivery}`,
        });
        return { recipients: guards.length, delivery };
      });
    },
  };
}

export type RosterService = ReturnType<typeof rosterService>;
