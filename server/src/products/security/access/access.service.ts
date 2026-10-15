/*
 * PALTAS Access: visitor reception (pre-registration with a pass code, walk-ins awaiting the host, check-in and
 * check-out, denial with a reason, retention and purge of personal data), the watchlist (every match at the gate is
 * refused and logged), and physical access control (doors, access groups with daily windows, credentials with one
 * active of each kind per person, and the access rule a door controller would apply — run in PALTAS and logged, never
 * presented as a door event). No controller, reader or messaging provider is connected: test adapters say so.
 */
import { randomInt } from "node:crypto";
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import type { SecurityDeps } from "../deps.js";
import { loadSettings } from "../setup/setup.service.js";
import { findGuard } from "../shared/access.js";
import { findSite, must, orgTimezone } from "../shared/util.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;
type VisitorOut = z.infer<typeof security.Visitor>;
type CredentialOut = z.infer<typeof security.Credential>;

const personKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
const plateKey = (plate: string) => plate.replace(/\s+/g, "").toUpperCase();

interface VisitorRow {
  id: string;
  number: string;
  site_id: string;
  name: string;
  host: string;
  purpose: string;
  kind: VisitorOut["kind"];
  expected_date: string;
  expected_time: string | null;
  pass_code: string | null;
  plate: string | null;
  id_type: string | null;
  id_last4: string | null;
  status: VisitorOut["status"];
  host_approval_by: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  denied_reason: string | null;
  retain_until: string;
  purged_at: string | null;
}

interface WatchRow {
  id: string;
  site_id: string | null;
  kind: "person" | "vehicle";
  value: string;
  reason: string;
  removed_at: string | null;
  added_at: string;
  hits: number;
}

interface CredentialRow {
  id: string;
  number: string;
  guard_id: string | null;
  holder_name: string;
  holder_key: string;
  kind: CredentialOut["kind"];
  group_ids: string[];
  valid_from: string;
  valid_to: string;
  status: CredentialOut["status"];
  status_reason: string | null;
  replaced_by: string | null;
  licence_expiry: string | null;
}

interface GroupRow {
  id: string;
  name: string;
  door_ids: string[];
  from_time: string;
  to_time: string;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is a time of day inside a daily window? from = to means all day; a window ending before it starts runs overnight. */
export function inWindow(from: string, to: string, at: string): boolean {
  const f = minutesOf(from);
  const t = minutesOf(to);
  const x = minutesOf(at);
  if (f === t) return true;
  return f < t ? x >= f && x < t : x >= f || x < t;
}

export function accessService(d: SecurityDeps) {
  const { db } = d.core;
  const { accessControl, messaging } = d.adapters;

  const toVisitor = (v: VisitorRow): VisitorOut => ({
    id: v.id,
    number: v.number,
    siteId: v.site_id,
    name: v.name,
    host: v.host,
    purpose: v.purpose,
    kind: v.kind,
    expectedDate: v.expected_date,
    expectedTime: v.expected_time,
    passCode: v.pass_code,
    plate: v.plate,
    idType: v.id_type,
    idLast4: v.id_last4,
    status: v.status,
    hostApprovalBy: v.host_approval_by,
    checkedInAt: v.checked_in_at,
    checkedOutAt: v.checked_out_at,
    deniedReason: v.denied_reason,
    retainUntil: v.retain_until,
    purged: v.purged_at !== null,
    delivery:
      v.kind === "pre_registered" && !messaging.state.connected
        ? "Pass code not sent — no messaging provider connected; give it to the visitor yourself"
        : null,
  });

  async function visitorRow(t: Db, orgId: string, id: string, lock = false) {
    const v = await t.row<VisitorRow>(
      `SELECT * FROM sec_visitors WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [orgId, id],
    );
    if (!v) throw fail.notFound("Visitor not found");
    return v;
  }

  /** The active watchlist entry this person or plate matches at this site, if any. */
  async function watchHit(t: Db, orgId: string, siteId: string, name: string, plate: string | null) {
    return t.row<{ id: string; value: string; reason: string }>(
      `SELECT id, value, reason FROM sec_watchlist WHERE org_id = $1 AND removed_at IS NULL
         AND (site_id IS NULL OR site_id = $2)
         AND ((kind = 'person' AND match_key = $3) OR (kind = 'vehicle' AND match_key = $4))
       ORDER BY added_at LIMIT 1`,
      [orgId, siteId, personKey(name), plate ? plateKey(plate) : null],
    );
  }

  /** Refuse a watchlist match — and keep the hit even though the request is refused. */
  async function refuseIfWatched(s: OrgScope, siteId: string, name: string, plate: string | null) {
    const hit = await watchHit(db, s.orgId, siteId, name, plate);
    if (!hit) return;
    await db.tx(async (t) => {
      await t.run(
        "INSERT INTO sec_watchlist_hits (id, org_id, watchlist_id, site_id, by_user, presented) VALUES ($1,$2,$3,$4,$5,$6)",
        [newId("swh"), s.orgId, hit.id, siteId, s.userId, [name, plate].filter(Boolean).join(" · ")],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: "Watchlist match at the gate",
        target: hit.id,
        detail: name,
      });
    });
    throw fail.conflict(`On the watchlist: ${hit.value} — ${hit.reason}. Entry refused; call the supervisor.`);
  }

  async function watchRow(t: Db, orgId: string, id: string): Promise<WatchRow> {
    const w = await t.row<WatchRow>(
      `SELECT w.*, (SELECT count(*)::int FROM sec_watchlist_hits h WHERE h.watchlist_id = w.id) AS hits
       FROM sec_watchlist w WHERE w.org_id = $1 AND w.id = $2`,
      [orgId, id],
    );
    if (!w) throw fail.notFound("Watchlist entry not found");
    return w;
  }
  const toWatch = (w: WatchRow) => ({
    id: w.id,
    siteId: w.site_id,
    kind: w.kind,
    value: w.value,
    reason: w.reason,
    active: w.removed_at === null,
    addedAt: w.added_at,
    hits: w.hits,
  });

  const CRED_SELECT = `SELECT c.*, g.licence_expiry FROM sec_credentials c LEFT JOIN sec_guards g ON g.id = c.guard_id`;
  function credState(c: CredentialRow, today: string): string {
    if (c.status !== "active") return c.status;
    if (c.valid_to < today) return "expired";
    if (c.valid_from > today) return "not yet valid";
    return "active";
  }
  const toCredential = (c: CredentialRow, today: string): CredentialOut => ({
    id: c.id,
    number: c.number,
    guardId: c.guard_id,
    holderName: c.holder_name,
    kind: c.kind,
    groupIds: c.group_ids,
    validFrom: c.valid_from,
    validTo: c.valid_to,
    status: c.status,
    state: credState(c, today),
    statusReason: c.status_reason,
    replacedBy: c.replaced_by,
    enrolment: accessControl.state.connected
      ? "Enrolled on the readers of its groups' doors"
      : "Not enrolled — no door controller connected (test adapter)",
    outlastsLicence: c.licence_expiry !== null && c.status === "active" && c.valid_to > c.licence_expiry,
  });
  async function credentialRow(t: Db, orgId: string, id: string, lock = false) {
    const c = await t.row<CredentialRow>(
      `${CRED_SELECT} WHERE c.org_id = $1 AND c.id = $2${lock ? " FOR UPDATE OF c" : ""}`,
      [orgId, id],
    );
    if (!c) throw fail.notFound("Credential not found");
    return c;
  }

  async function insertCredential(
    t: Db,
    s: OrgScope,
    c: {
      guardId: string | null;
      holderName: string;
      holderKey: string;
      kind: CredentialOut["kind"];
      groupIds: string[];
      validFrom: string;
      validTo: string;
    },
  ): Promise<string> {
    const id = newId("scr");
    try {
      await t.run(
        `INSERT INTO sec_credentials (id, org_id, number, guard_id, holder_name, holder_key, kind, group_ids, valid_from,
           valid_to, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)`,
        [
          id,
          s.orgId,
          await nextNumber(t, s.orgId, "CR"),
          c.guardId,
          c.holderName,
          c.holderKey,
          c.kind,
          c.groupIds,
          c.validFrom,
          c.validTo,
          s.userId,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw fail.conflict(
          `${c.holderName} already has an active ${c.kind}. Suspend or revoke it first, or replace it if it was lost.`,
        );
      throw e;
    }
    const doors = await t.rows<{ code: string }>(
      "SELECT DISTINCT d.code FROM sec_doors d JOIN sec_access_groups g ON d.id = ANY(g.door_ids) WHERE g.id = ANY($1)",
      [c.groupIds],
    );
    const enrolment = accessControl.enrol({ id, kind: c.kind, doorCodes: doors.map((d) => d.code) });
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Credential issued",
      target: id,
      detail: `${c.holderName} · ${enrolment}`,
    });
    return id;
  }

  async function checkGroups(t: Db, orgId: string, ids: string[]) {
    const found = await t.rows<{ id: string }>("SELECT id FROM sec_access_groups WHERE org_id = $1 AND id = ANY($2)", [
      orgId,
      ids,
    ]);
    if (found.length !== new Set(ids).size) throw fail.invalid("Unknown access group");
  }

  async function groupOut(t: Db, orgId: string, id: string) {
    const g = await t.row<GroupRow & { credentials: number }>(
      `SELECT g.*, (SELECT count(*)::int FROM sec_credentials c WHERE c.org_id = g.org_id AND g.id = ANY(c.group_ids)
         AND c.status <> 'revoked') AS credentials FROM sec_access_groups g WHERE g.org_id = $1 AND g.id = $2`,
      [orgId, id],
    );
    if (!g) throw fail.notFound("Access group not found");
    return {
      id: g.id,
      name: g.name,
      doorIds: g.door_ids,
      from: g.from_time,
      to: g.to_time,
      credentials: g.credentials,
    };
  }

  const toDoor = (r: { id: string; site_id: string; code: string; name: string; zone: string }) => ({
    id: r.id,
    siteId: r.site_id,
    code: r.code,
    name: r.name,
    zone: r.zone,
    reader: accessControl.state,
  });

  return {
    // ---------------------------------------------------------------- visitors
    async listVisitors(s: OrgScope, view: "expected" | "onsite" | "log", siteId?: string) {
      const rows = await db.rows<VisitorRow>(
        `SELECT * FROM sec_visitors WHERE org_id = $1 AND ($2::text IS NULL OR site_id = $2)
           AND ($3 = 'log' OR ($3 = 'onsite' AND status = 'on_site')
                OR ($3 = 'expected' AND status IN ('expected', 'awaiting_host', 'approved')))
         ORDER BY created_at DESC, number DESC`,
        [s.orgId, siteId ?? null, view],
      );
      return { visitors: rows.map(toVisitor) };
    },

    async registerVisitor(s: OrgScope, b: Body<typeof security.registerVisitor>) {
      await findSite(db, s.orgId, b.siteId);
      const plate = b.plate ? plateKey(b.plate) : null;
      await refuseIfWatched(s, b.siteId, b.name, plate);
      return db.tx(async (t) => {
        const settings = await loadSettings(t, s.orgId);
        const pre = b.kind === "pre_registered";
        if (pre && b.expectedDate < s.today) throw fail.invalid("Choose today or a later date");
        const date = pre ? b.expectedDate : s.today;
        const id = newId("svs");
        await t.run(
          `INSERT INTO sec_visitors (id, org_id, number, site_id, name, host, purpose, kind, expected_date, expected_time,
             pass_code, plate, id_type, id_last4, status, retain_until, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            id,
            s.orgId,
            await nextNumber(t, s.orgId, "VIS"),
            b.siteId,
            b.name,
            b.host,
            b.purpose,
            b.kind,
            date,
            pre ? b.expectedTime : null,
            pre ? String(randomInt(100000, 1000000)) : null,
            plate,
            pre ? null : b.idType,
            pre ? null : b.idLast4.toUpperCase(),
            pre ? "expected" : "awaiting_host",
            addDays(date, settings.visitor_retention_days),
            s.userId,
          ],
        );
        return toVisitor(await visitorRow(t, s.orgId, id));
      });
    },

    async visitorAction(s: OrgScope, id: string, b: Body<typeof security.visitorAction>) {
      const v = await visitorRow(db, s.orgId, id);
      if (b.action === "check_in" && ["expected", "approved"].includes(v.status))
        await refuseIfWatched(s, v.site_id, v.name, v.plate);
      return db.tx(async (t) => {
        const cur = await visitorRow(t, s.orgId, id, true);
        switch (b.action) {
          case "host_approved":
            if (cur.status !== "awaiting_host") throw fail.conflict("This visitor is not waiting for the host");
            await t.run("UPDATE sec_visitors SET status = 'approved', host_approval_by = $2 WHERE id = $1", [
              id,
              s.userId,
            ]);
            break;
          case "deny":
            if (!b.reason) throw fail.invalid("Give the reason entry was denied");
            if (!["expected", "awaiting_host", "approved"].includes(cur.status))
              throw fail.conflict(`This visitor is ${cur.status.replace("_", " ")}`);
            await t.run("UPDATE sec_visitors SET status = 'denied', denied_reason = $2, denied_by = $3 WHERE id = $1", [
              id,
              b.reason,
              s.userId,
            ]);
            break;
          case "check_in":
            if (cur.status === "awaiting_host") throw fail.conflict("The host has not approved this visitor yet");
            if (!["expected", "approved"].includes(cur.status))
              throw fail.conflict(`This visitor is ${cur.status.replace("_", " ")}`);
            if (cur.expected_date > s.today) throw fail.conflict(`This visitor is expected on ${cur.expected_date}`);
            await t.run(
              "UPDATE sec_visitors SET status = 'on_site', checked_in_at = $2, checked_in_by = $3 WHERE id = $1",
              [id, b.at, s.userId],
            );
            break;
          case "check_out":
            if (cur.status !== "on_site") throw fail.conflict("This visitor is not on site");
            if (cur.checked_in_at && new Date(b.at) < new Date(cur.checked_in_at))
              throw fail.invalid("Check-out cannot be before check-in");
            await t.run(
              "UPDATE sec_visitors SET status = 'departed', checked_out_at = $2, checked_out_by = $3 WHERE id = $1",
              [id, b.at, s.userId],
            );
            break;
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: `Visitor ${b.action.replace("_", " ")}`,
          target: cur.number,
          detail: b.reason ?? "",
        });
        return toVisitor(await visitorRow(t, s.orgId, id));
      });
    },

    async purgeVisitors(s: OrgScope) {
      return db.tx(async (t) => {
        const n = await t.run(
          `UPDATE sec_visitors SET name = '(removed)', plate = NULL, id_type = NULL, id_last4 = NULL, pass_code = NULL,
             purged_at = now()
           WHERE org_id = $1 AND purged_at IS NULL AND retain_until < $2 AND status <> 'on_site'`,
          [s.orgId, s.today],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Visitor data purged",
          detail: `${n} visitor(s)`,
        });
        return { purged: n };
      });
    },

    // ---------------------------------------------------------------- watchlist
    async listWatchlist(s: OrgScope) {
      const rows = await db.rows<WatchRow>(
        `SELECT w.*, (SELECT count(*)::int FROM sec_watchlist_hits h WHERE h.watchlist_id = w.id) AS hits
         FROM sec_watchlist w WHERE w.org_id = $1 ORDER BY (w.removed_at IS NOT NULL), w.added_at DESC`,
        [s.orgId],
      );
      return { entries: rows.map(toWatch) };
    },

    async addWatch(s: OrgScope, b: Body<typeof security.addWatch>) {
      return db.tx(async (t) => {
        if (b.siteId) await findSite(t, s.orgId, b.siteId);
        const id = newId("swl");
        const value = b.kind === "vehicle" ? plateKey(b.value) : b.value;
        await t.run(
          `INSERT INTO sec_watchlist (id, org_id, site_id, kind, value, match_key, reason, added_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            s.orgId,
            b.siteId,
            b.kind,
            value,
            b.kind === "vehicle" ? plateKey(b.value) : personKey(b.value),
            b.reason,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Added to watchlist",
          target: id,
          detail: b.reason,
        });
        return toWatch(await watchRow(t, s.orgId, id));
      });
    },

    async removeWatch(s: OrgScope, id: string, reason: string) {
      return db.tx(async (t) => {
        const w = await watchRow(t, s.orgId, id);
        if (w.removed_at) throw fail.conflict("This entry is already off the watchlist");
        await t.run("UPDATE sec_watchlist SET removed_at = now(), removed_by = $2, removed_reason = $3 WHERE id = $1", [
          id,
          s.userId,
          reason,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Removed from watchlist",
          target: id,
          detail: reason,
        });
        return toWatch(await watchRow(t, s.orgId, id));
      });
    },

    // ---------------------------------------------------------------- doors, groups, credentials
    async overview(s: OrgScope) {
      const doors = await db.rows<{ id: string; site_id: string; code: string; name: string; zone: string }>(
        "SELECT * FROM sec_doors WHERE org_id = $1 ORDER BY code",
        [s.orgId],
      );
      const groupIds = await db.rows<{ id: string }>(
        "SELECT id FROM sec_access_groups WHERE org_id = $1 ORDER BY name",
        [s.orgId],
      );
      const groups = [];
      for (const g of groupIds) groups.push(await groupOut(db, s.orgId, g.id));
      const creds = await db.rows<CredentialRow>(`${CRED_SELECT} WHERE c.org_id = $1 ORDER BY c.number`, [s.orgId]);
      const decisions = await db.rows<{
        id: string;
        credential_id: string;
        door_id: string;
        at: string;
        allowed: boolean;
        reason: string;
      }>("SELECT * FROM sec_access_decisions WHERE org_id = $1 ORDER BY checked_at DESC, id LIMIT 200", [s.orgId]);
      return {
        controller: accessControl.state,
        doors: doors.map(toDoor),
        groups,
        credentials: creds.map((c) => toCredential(c, s.today)),
        decisions: decisions.map((x) => ({
          id: x.id,
          credentialId: x.credential_id,
          doorId: x.door_id,
          at: x.at,
          allowed: x.allowed,
          reason: x.reason,
          source: "PALTAS rule check — not a door event",
        })),
      };
    },

    async createDoor(s: OrgScope, b: Body<typeof security.createDoor>) {
      return db.tx(async (t) => {
        await findSite(t, s.orgId, b.siteId);
        const id = newId("sdr");
        try {
          await t.run("INSERT INTO sec_doors (id, org_id, site_id, code, name, zone) VALUES ($1,$2,$3,$4,$5,$6)", [
            id,
            s.orgId,
            b.siteId,
            b.code,
            b.name,
            b.zone,
          ]);
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw fail.conflict(`Door ${b.code} already exists`);
          throw e;
        }
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Door recorded", target: b.code });
        return toDoor({ id, site_id: b.siteId, code: b.code, name: b.name, zone: b.zone });
      });
    },

    async saveGroup(s: OrgScope, b: Body<typeof security.saveAccessGroup>) {
      return db.tx(async (t) => {
        const doors = await t.rows<{ id: string }>("SELECT id FROM sec_doors WHERE org_id = $1 AND id = ANY($2)", [
          s.orgId,
          b.doorIds,
        ]);
        if (doors.length !== new Set(b.doorIds).size) throw fail.invalid("Unknown door");
        const doorIds = [...new Set(b.doorIds)];
        let id = b.id;
        try {
          if (id) {
            const n = await t.run(
              "UPDATE sec_access_groups SET name = $3, door_ids = $4, from_time = $5, to_time = $6 WHERE org_id = $1 AND id = $2",
              [s.orgId, id, b.name, doorIds, b.from, b.to],
            );
            if (!n) throw fail.notFound("Access group not found");
          } else {
            id = newId("sag");
            await t.run(
              "INSERT INTO sec_access_groups (id, org_id, name, door_ids, from_time, to_time) VALUES ($1,$2,$3,$4,$5,$6)",
              [id, s.orgId, b.name, doorIds, b.from, b.to],
            );
          }
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw fail.conflict(`A group called ${b.name} already exists`);
          throw e;
        }
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Access group saved", target: id, after: b });
        return groupOut(t, s.orgId, id);
      });
    },

    async issueCredential(s: OrgScope, b: Body<typeof security.issueCredential>) {
      if (b.validTo < b.validFrom) throw fail.invalid("The end date must be on or after the start date");
      return db.tx(async (t) => {
        await checkGroups(t, s.orgId, b.groupIds);
        let holder: { guardId: string | null; holderName: string; holderKey: string };
        if (b.guardId) {
          const g = await findGuard(t, s.orgId, b.guardId);
          holder = { guardId: g.id, holderName: g.name, holderKey: g.id };
        } else if (b.holderName) {
          holder = { guardId: null, holderName: b.holderName, holderKey: personKey(b.holderName) };
        } else throw fail.invalid("Choose a guard or give the staff member's name");
        const id = await insertCredential(t, s, {
          ...holder,
          kind: b.kind,
          groupIds: [...new Set(b.groupIds)],
          validFrom: b.validFrom,
          validTo: b.validTo,
        });
        return toCredential(await credentialRow(t, s.orgId, id), s.today);
      });
    },

    async changeCredential(
      s: OrgScope,
      id: string,
      action: "suspend" | "reactivate" | "revoke" | "replace",
      reason: string,
    ) {
      return db.tx(async (t) => {
        const c = await credentialRow(t, s.orgId, id, true);
        let replacement: string | null = null;
        if (action === "suspend") {
          if (c.status !== "active") throw fail.conflict("Only an active credential can be suspended");
          await t.run("UPDATE sec_credentials SET status = 'suspended', status_reason = $2 WHERE id = $1", [
            id,
            reason,
          ]);
        } else if (action === "reactivate") {
          if (c.status !== "suspended") throw fail.conflict("Only a suspended credential can be reactivated");
          try {
            await t.run("UPDATE sec_credentials SET status = 'active', status_reason = NULL WHERE id = $1", [id]);
          } catch (e) {
            if ((e as { code?: string }).code === "23505")
              throw fail.conflict(`${c.holder_name} already has another active ${c.kind}`);
            throw e;
          }
        } else {
          if (c.status === "revoked") throw fail.conflict("This credential is already revoked");
          await t.run("UPDATE sec_credentials SET status = 'revoked', status_reason = $2 WHERE id = $1", [id, reason]);
          accessControl.revoke(id);
          if (action === "replace") {
            replacement = await insertCredential(t, s, {
              guardId: c.guard_id,
              holderName: c.holder_name,
              holderKey: c.holder_key,
              kind: c.kind,
              groupIds: c.group_ids,
              validFrom: s.today > c.valid_from ? s.today : c.valid_from,
              validTo: c.valid_to < s.today ? s.today : c.valid_to,
            });
            await t.run("UPDATE sec_credentials SET replaced_by = $2 WHERE id = $1", [id, replacement]);
          }
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: `Credential ${action}`,
          target: c.number,
          detail: reason,
        });
        return {
          credential: toCredential(await credentialRow(t, s.orgId, id), s.today),
          replacement: replacement ? toCredential(await credentialRow(t, s.orgId, replacement), s.today) : null,
        };
      });
    },

    async checkAccess(s: OrgScope, credentialId: string, doorId: string, at: string) {
      return db.tx(async (t) => {
        const c = await credentialRow(t, s.orgId, credentialId);
        const door = await t.row<{ id: string; site_id: string }>(
          "SELECT id, site_id FROM sec_doors WHERE org_id = $1 AND id = $2",
          [s.orgId, doorId],
        );
        if (!door) throw fail.notFound("Door not found");
        const tz = await orgTimezone(t, s.orgId);
        const local = must(
          await t.row<{ d: string; hm: string }>(
            "SELECT ($1::timestamptz AT TIME ZONE $2)::date AS d, to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS hm",
            [at, tz],
          ),
          "the local time",
        );
        const day = local.d;
        const hm = local.hm;
        let allowed = false;
        let reason: string;
        const guard = c.guard_id ? await findGuard(t, s.orgId, c.guard_id) : null;
        const watched = await t.row<{ id: string }>(
          `SELECT id FROM sec_watchlist WHERE org_id = $1 AND removed_at IS NULL AND kind = 'person' AND match_key = $2
             AND (site_id IS NULL OR site_id = $3) LIMIT 1`,
          [s.orgId, personKey(c.holder_name), door.site_id],
        );
        const groups = await t.rows<GroupRow>(
          "SELECT * FROM sec_access_groups WHERE org_id = $1 AND id = ANY($2) AND $3 = ANY(door_ids) ORDER BY name",
          [s.orgId, c.group_ids, doorId],
        );
        const open = groups.find((g) => inWindow(g.from_time, g.to_time, hm));
        if (c.status !== "active") reason = `Credential is ${c.status}`;
        else if (day < c.valid_from) reason = "Credential is not valid yet";
        else if (day > c.valid_to) reason = "Credential has expired";
        else if (guard && guard.status !== "active") reason = `Holder is not an active guard (${guard.status})`;
        else if (guard && guard.licence_expiry < day) reason = "Holder's guard licence has expired";
        else if (watched) reason = "Holder is on the watchlist";
        else if (!groups.length) reason = "No access group on this credential opens this door";
        else if (!open)
          reason = `Outside the schedule of ${groups.map((g) => `${g.name} (${g.from_time}–${g.to_time})`).join(", ")}`;
        else {
          allowed = true;
          reason = `Allowed by ${open.name} (${open.from_time}–${open.to_time})`;
        }
        const id = newId("sad");
        await t.run(
          `INSERT INTO sec_access_decisions (id, org_id, credential_id, door_id, at, allowed, reason, checked_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, s.orgId, credentialId, doorId, at, allowed, reason, s.userId],
        );
        return {
          id,
          credentialId,
          doorId,
          at: new Date(at).toISOString(),
          allowed,
          reason,
          source: "PALTAS rule check — not a door event",
        };
      });
    },

    async remoteUnlock(s: OrgScope, doorId: string, reason: string) {
      return db.tx(async (t) => {
        const door = await t.row<{ code: string }>("SELECT code FROM sec_doors WHERE org_id = $1 AND id = $2", [
          s.orgId,
          doorId,
        ]);
        if (!door) throw fail.notFound("Door not found");
        const r = accessControl.unlock({ code: door.code });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Remote unlock requested",
          target: door.code,
          detail: `${reason} · ${r.status}`,
        });
        return r;
      });
    },
  };
}

export type AccessService = ReturnType<typeof accessService>;
