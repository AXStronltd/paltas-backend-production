import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { unitRow } from "../shared/records.js";
type Meter = {
  id: string;
  org_id: string;
  unit_id: string;
  unit_no: string;
  charge_type_id: string;
  code: string;
  serial: string;
  from_period: string;
  opening: number;
  through_period: string | null;
  closing: number | null;
  version: number;
  reason: string;
};
type Reading = {
  id: string;
  unit_id: string;
  unit_no: string;
  charge_type_id: string;
  code: string;
  period: string;
  previous: number;
  current: number;
  meter_id: string | null;
  meter_serial: string | null;
  reading_kind: "actual" | "estimated";
  reason: string;
  version: number;
  billed: boolean;
};
const METER_SQL =
  "SELECT m.*,u.unit_no,c.code FROM pm_utility_meters m JOIN pm_units u ON u.id=m.unit_id AND u.org_id=m.org_id JOIN pm_charge_types c ON c.id=m.charge_type_id AND c.org_id=m.org_id";
const READING_SQL = `SELECT m.*,u.unit_no,c.code,r.serial AS meter_serial,EXISTS(SELECT 1 FROM pm_invoices i JOIN pm_leases l ON l.id=i.lease_id AND l.org_id=i.org_id WHERE i.org_id=m.org_id AND l.unit_id=m.unit_id AND i.kind='charge' AND i.recurring AND i.period=m.period) AS billed FROM pm_meter_readings m JOIN pm_units u ON u.id=m.unit_id AND u.org_id=m.org_id JOIN pm_charge_types c ON c.id=m.charge_type_id AND c.org_id=m.org_id LEFT JOIN pm_utility_meters r ON r.org_id=m.org_id AND r.id=m.meter_id`;
const readingView = (r: Reading): P.MeterReading => ({
  id: r.id,
  unitId: r.unit_id,
  unitNo: r.unit_no,
  chargeTypeId: r.charge_type_id,
  code: r.code,
  period: r.period,
  previous: Number(r.previous),
  current: Number(r.current),
  consumption: Number((Number(r.current) - Number(r.previous)).toFixed(3)),
  meterId: r.meter_id,
  meterSerial: r.meter_serial,
  kind: r.reading_kind,
  reason: r.reason,
  version: r.version,
  billed: r.billed,
});
function precision(n: number, label: string) {
  if (!Number.isFinite(n) || n < 0 || n > 1e9 || !/^\d+(?:\.\d{1,3})?$/.test(String(n)))
    throw fail.invalid(`${label} must be a non-negative meter value with at most three decimal places`);
}
export function utilityMetersService(d: PmDeps) {
  const db = d.core.db;
  async function unit(t: Db, s: OrgScope, id: string) {
    const u = await unitRow(t, s.orgId, id);
    if (s.propertyIds && !s.propertyIds.includes(u.property_id)) throw fail.notFound("Unit not found");
    return u;
  }
  async function meter(t: Db, s: OrgScope, id: string, lock = false) {
    const m = await t.row<Meter>(`${METER_SQL} WHERE m.org_id=$1 AND m.id=$2 ${lock ? "FOR UPDATE OF m" : ""}`, [
      s.orgId,
      id,
    ]);
    if (!m) throw fail.notFound("Meter not found");
    await unit(t, s, m.unit_id);
    return m;
  }
  async function view(t: Db, s: OrgScope, m: Meter): Promise<P.UtilityMeter> {
    const events = await t.rows<P.UtilityMeter["events"][number]>(
      `SELECT e.id,e.reason,e.snapshot,u.name AS "actorName",e.created_at AS "createdAt" FROM pm_utility_meter_events e JOIN users u ON u.id=e.actor_id WHERE e.org_id=$1 AND e.meter_id=$2 ORDER BY e.created_at,e.id`,
      [s.orgId, m.id],
    );
    return {
      id: m.id,
      unitId: m.unit_id,
      unitNo: m.unit_no,
      chargeTypeId: m.charge_type_id,
      code: m.code,
      serial: m.serial,
      fromPeriod: m.from_period,
      opening: Number(m.opening),
      throughPeriod: m.through_period,
      closing: m.closing === null ? null : Number(m.closing),
      version: m.version,
      reason: m.reason,
      events,
    };
  }
  async function meterEvent(t: Db, s: OrgScope, m: Meter, reason: string) {
    await t.run(
      "INSERT INTO pm_utility_meter_events(id,org_id,meter_id,snapshot,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
      [newId("pme"), s.orgId, m.id, JSON.stringify(m), reason, s.userId],
    );
    await recordAudit(t, {
      orgId: s.orgId,
      actor: s.actor,
      action: "Utility meter lifecycle recorded",
      target: m.id,
      detail: reason,
      after: m,
    });
  }
  async function readingEvent(t: Db, s: OrgScope, r: Reading, reason: string) {
    await t.run(
      "INSERT INTO pm_meter_reading_events(id,org_id,reading_id,snapshot,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
      [newId("pre"), s.orgId, r.id, JSON.stringify(readingView(r)), reason, s.userId],
    );
  }
  async function reading(t: Db, s: OrgScope, id: string) {
    const r = await t.row<Reading>(`${READING_SQL} WHERE m.org_id=$1 AND m.id=$2`, [s.orgId, id]);
    if (!r) throw fail.notFound("Meter reading not found");
    await unit(t, s, r.unit_id);
    return r;
  }
  return {
    async list(s: OrgScope, q: P.MeterIndexQuery) {
      const args = [s.orgId, q.propertyId ?? null, q.unitId ?? null, s.propertyIds ?? null];
      const where =
        "m.org_id=$1 AND ($2::text IS NULL OR u.property_id=$2) AND ($3::text IS NULL OR m.unit_id=$3) AND ($4::text[] IS NULL OR u.property_id=ANY($4))";
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const count = await t.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM pm_utility_meters m JOIN pm_units u ON u.org_id=m.org_id AND u.id=m.unit_id WHERE ${where}`,
          args,
        );
        const rows = await t.rows<Meter>(
          `${METER_SQL} WHERE ${where} ORDER BY u.unit_no,m.from_period DESC,m.id LIMIT $5 OFFSET $6`,
          [...args, q.limit, q.offset],
        );
        const meters = [];
        for (const r of rows) meters.push(await view(t, s, r));
        return { meters, total: count?.n ?? 0 };
      });
    },
    async register(s: OrgScope, b: P.UtilityMeterInput) {
      precision(b.opening, "Opening reading");
      return financeTransaction(db, s.orgId, async (t) => {
        await unit(t, s, b.unitId);
        const ct = await t.row<{ metered: boolean; active: boolean }>(
          "SELECT metered,active FROM pm_charge_types WHERE org_id=$1 AND id=$2",
          [s.orgId, b.chargeTypeId],
        );
        if (!ct) throw fail.notFound("Service category not found");
        if (!ct.metered || !ct.active) throw fail.invalid("Select an active metered service category");
        if (
          await t.row(
            "SELECT id FROM pm_utility_meters WHERE org_id=$1 AND (serial=$2 OR (unit_id=$3 AND charge_type_id=$4 AND COALESCE(through_period,'9999-12') >=$5))",
            [s.orgId, b.serial, b.unitId, b.chargeTypeId, b.fromPeriod],
          )
        )
          throw fail.conflict(
            "This serial is already registered or an existing meter covers that period. Close the old meter before registering its replacement.",
          );
        if (
          await t.row(
            "SELECT i.id FROM pm_invoices i JOIN pm_leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE i.org_id=$1 AND l.unit_id=$2 AND i.kind='charge' AND i.recurring AND i.period >=$3 LIMIT 1",
            [s.orgId, b.unitId, b.fromPeriod],
          )
        )
          throw fail.conflict(
            "A utility invoice already exists in or after this period. Register from a later unbilled period; issued history cannot be reassigned.",
          );
        const id = newId("pmt");
        await t.run(
          "INSERT INTO pm_utility_meters(id,org_id,unit_id,charge_type_id,serial,from_period,opening,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [id, s.orgId, b.unitId, b.chargeTypeId, b.serial, b.fromPeriod, b.opening, b.reason, s.userId],
        );
        const m = await meter(t, s, id);
        await meterEvent(t, s, m, b.reason);
        return view(t, s, m);
      });
    },
    async retire(
      s: OrgScope,
      id: string,
      b: { expectedVersion: number; throughPeriod: string; closing: number; reason: string },
    ) {
      precision(b.closing, "Closing reading");
      return financeTransaction(db, s.orgId, async (t) => {
        const m = await meter(t, s, id, true);
        if (m.version !== b.expectedVersion) throw fail.conflict("The meter changed. Reopen it before continuing.");
        if (m.through_period) throw fail.conflict("This meter is already closed; its history is retained");
        if (b.throughPeriod < m.from_period) throw fail.invalid("Closing period cannot precede installation");
        const last = await t.row<{ current: number; reading_kind: string }>(
          "SELECT current,reading_kind FROM pm_meter_readings WHERE org_id=$1 AND meter_id=$2 AND period=$3",
          [s.orgId, id, b.throughPeriod],
        );
        if (!last || last.reading_kind !== "actual" || Number(last.current) !== b.closing)
          throw fail.conflict(
            "Record an actual final reading on this meter in the closing month, then use that value to close it",
          );
        if (
          await t.row(
            "SELECT id FROM pm_meter_readings WHERE org_id=$1 AND unit_id=$2 AND charge_type_id=$3 AND period>$4 LIMIT 1",
            [s.orgId, m.unit_id, m.charge_type_id, b.throughPeriod],
          )
        )
          throw fail.conflict("Later readings exist. Review them before closing this meter.");
        await t.run(
          "UPDATE pm_utility_meters SET through_period=$3,closing=$4,retired_by=$5,retired_at=now(),version=version+1 WHERE org_id=$1 AND id=$2",
          [s.orgId, id, b.throughPeriod, b.closing, s.userId],
        );
        const saved = await meter(t, s, id);
        await meterEvent(t, s, saved, b.reason);
        return view(t, s, saved);
      });
    },
    async record(s: OrgScope, b: P.MeterReadingInput) {
      return financeTransaction(db, s.orgId, async (t) => {
        const out = [];
        const seen = new Set<string>();
        for (const x of b.readings) {
          const key = x.unitId + "|" + x.chargeTypeId;
          if (seen.has(key)) throw fail.invalid("Enter each unit/service only once in a reading batch");
          seen.add(key);
          await unit(t, s, x.unitId);
          const ct = await t.row<{ metered: boolean; code: string }>(
            "SELECT metered,code FROM pm_charge_types WHERE org_id=$1 AND id=$2",
            [s.orgId, x.chargeTypeId],
          );
          if (!ct) throw fail.notFound("Service not found");
          if (!ct.metered) throw fail.invalid("This service is not metered");
          precision(x.previous, "Previous reading");
          precision(x.current, "Current reading");
          if (x.current < x.previous)
            throw fail.invalid(
              "The reading decreased. For a meter replacement, close the old meter and register the new one from the next month; do not reset an existing reading.",
            );
          const old = await t.row<Reading>(
            `${READING_SQL} WHERE m.org_id=$1 AND m.unit_id=$2 AND m.charge_type_id=$3 AND m.period=$4`,
            [s.orgId, x.unitId, x.chargeTypeId, b.period],
          );
          if (old?.billed)
            throw fail.conflict(
              `Charges for ${b.period} are already billed on this unit. Open the invoice billing query/credit workflow; issued amounts and source readings stay unchanged.`,
            );
          if (
            !old &&
            (await t.row(
              "SELECT i.id FROM pm_invoices i JOIN pm_leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE i.org_id=$1 AND l.unit_id=$2 AND i.kind='charge' AND i.recurring AND i.period=$3 LIMIT 1",
              [s.orgId, x.unitId, b.period],
            ))
          )
            throw fail.conflict(
              "This period is already billed. Correct its invoice through the billing query/credit workflow.",
            );
          if (old && (x.expectedVersion !== old.version || x.reason.length < 5))
            throw fail.conflict(
              "Reopen the reading and provide its current version and a correction reason of at least five characters",
            );
          if (!old && x.expectedVersion !== undefined)
            throw fail.conflict("This reading no longer exists. Refresh before saving");
          if (b.period > s.today.slice(0, 7) && x.kind !== "estimated")
            throw fail.invalid(
              "A future month's usage cannot be recorded as actual. Use a documented estimate or wait for the reading.",
            );
          if (x.kind === "estimated" && x.reason.length < 5)
            throw fail.invalid("Explain how this estimated reading was calculated");
          const active = await t.row<Meter>(
            `${METER_SQL} WHERE m.org_id=$1 AND m.unit_id=$2 AND m.charge_type_id=$3 AND m.from_period<=$4 AND (m.through_period IS NULL OR m.through_period>=$4)`,
            [s.orgId, x.unitId, x.chargeTypeId, b.period],
          );
          if (x.meterId && x.meterId !== active?.id)
            throw fail.invalid("The selected meter does not cover this unit, service and period");
          if (
            !active &&
            (await t.row(
              "SELECT id FROM pm_utility_meters WHERE org_id=$1 AND unit_id=$2 AND charge_type_id=$3 AND from_period<=$4 LIMIT 1",
              [s.orgId, x.unitId, x.chargeTypeId, b.period],
            ))
          )
            throw fail.conflict(
              "No registered meter covers this month. Register its replacement before recording usage",
            );
          if (active) {
            if (b.period === active.from_period && x.previous !== Number(active.opening))
              throw fail.conflict("The first previous value must match this meter's registered opening reading");
            const before = await t.row<{ current: number }>(
              "SELECT current FROM pm_meter_readings WHERE org_id=$1 AND meter_id=$2 AND period<$3 ORDER BY period DESC LIMIT 1",
              [s.orgId, active.id, b.period],
            );
            const after = await t.row<{ previous: number }>(
              "SELECT previous FROM pm_meter_readings WHERE org_id=$1 AND meter_id=$2 AND period>$3 ORDER BY period LIMIT 1",
              [s.orgId, active.id, b.period],
            );
            if (before && x.previous !== Number(before.current))
              throw fail.conflict("Previous value must equal the prior recorded closing value for this physical meter");
            if (after && x.current !== Number(after.previous))
              throw fail.conflict(
                "A later reading depends on this value. Review the adjacent unbilled readings before correcting it",
              );
            if (active.through_period === b.period && (x.kind !== "actual" || x.current !== Number(active.closing)))
              throw fail.conflict("This closed meter's final reading must retain its recorded actual closing value");
          }
          if (
            old &&
            !(await t.row("SELECT id FROM pm_meter_reading_events WHERE org_id=$1 AND reading_id=$2 LIMIT 1", [
              s.orgId,
              old.id,
            ]))
          )
            await readingEvent(t, s, old, "Legacy reading snapshot captured before its first audited correction");
          const id = old?.id ?? newId("pmr");
          if (old)
            await t.run(
              "UPDATE pm_meter_readings SET previous=$3,current=$4,meter_id=$5,reading_kind=$6,reason=$7,version=version+1,recorded_by=$8,recorded_at=now() WHERE org_id=$1 AND id=$2",
              [s.orgId, id, x.previous, x.current, active?.id ?? null, x.kind, x.reason, s.userId],
            );
          else
            await t.run(
              "INSERT INTO pm_meter_readings(id,org_id,unit_id,charge_type_id,period,previous,current,meter_id,reading_kind,reason,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              [
                id,
                s.orgId,
                x.unitId,
                x.chargeTypeId,
                b.period,
                x.previous,
                x.current,
                active?.id ?? null,
                x.kind,
                x.reason,
                s.userId,
              ],
            );
          const r = await reading(t, s, id);
          await readingEvent(t, s, r, x.reason || "Initial actual reading recorded");
          await recordAudit(t, {
            orgId: s.orgId,
            actor: s.actor,
            action: old ? "Meter reading corrected" : "Meter reading recorded",
            target: id,
            detail: x.reason,
            after: readingView(r),
          });
          out.push(readingView(r));
        }
        return { readings: out };
      });
    },
    async readings(s: OrgScope, q: { period: string; propertyId?: string }) {
      const rows = await db.rows<Reading>(
        `${READING_SQL} WHERE m.org_id=$1 AND m.period=$2 AND ($3::text IS NULL OR u.property_id=$3) AND ($4::text[] IS NULL OR u.property_id=ANY($4)) ORDER BY u.unit_no,c.code`,
        [s.orgId, q.period, q.propertyId ?? null, s.propertyIds ?? null],
      );
      return { readings: rows.map(readingView) };
    },
    async history(s: OrgScope, id: string) {
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const r = await reading(t, s, id);
        const events = await t.rows<{
          id: string;
          actorName: string;
          snapshot: Record<string, unknown>;
          reason: string;
          createdAt: string;
        }>(
          `SELECT e.id,e.snapshot,e.reason,u.name AS "actorName",e.created_at AS "createdAt" FROM pm_meter_reading_events e JOIN users u ON u.id=e.actor_id WHERE e.org_id=$1 AND e.reading_id=$2 ORDER BY e.created_at,e.id`,
          [s.orgId, id],
        );
        return { reading: readingView(r), events };
      });
    },
  };
}
