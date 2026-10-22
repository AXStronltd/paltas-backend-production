/*
 * Portfolio set-up: settings, charge types, properties (each uses one building allowance of the plan), buildings,
 * units, owners' management agreements and owners' payout details.
 */
import type { property as P } from "@paltas/contracts";
import { requireAllowance, type OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { LATE_FEES_JOB, MONTHLY_BILLING_JOB } from "../shared/jobs.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { ownerFunds } from "../shared/owner-funds.js";
import * as R from "../shared/records.js";
import { toBp, toPct } from "../shared/util.js";

interface SettingsRow {
  vat_bp: number;
  vat_from: string | null;
  po_limits: Record<string, number>;
  match_tolerance_bp: number;
  sla_days: P.Settings["slaDays"];
}

interface ChargeTypeRow {
  id: string;
  code: string;
  name: string;
  payee: "owner" | "agency";
  fee_applies: boolean;
  vat_applies: boolean;
  metered: boolean;
  unit_name: string;
  rate_minor: number;
  active: boolean;
}

export const toChargeType = (r: ChargeTypeRow): P.ChargeType => ({
  id: r.id,
  code: r.code,
  name: r.name,
  payee: r.payee,
  feeApplies: r.fee_applies,
  vatApplies: r.vat_applies,
  metered: r.metered,
  unitName: r.unit_name,
  rateMinor: r.rate_minor,
  active: r.active,
});

/** The organisation's PM settings (defaults until changed: no VAT, zero purchase-order limits). */
export async function settingsOf(db: Db, orgId: string): Promise<P.Settings> {
  const r = await db.row<SettingsRow>("SELECT * FROM pm_settings WHERE org_id = $1", [orgId]);
  return {
    vatPct: toPct(r?.vat_bp ?? 0),
    vatFrom: r?.vat_from ?? null,
    poLimits: r?.po_limits ?? {},
    matchTolerancePct: toPct(r?.match_tolerance_bp ?? 200),
    slaDays: r?.sla_days ?? { urgent: 1, high: 3, normal: 7, low: 14 },
  };
}

export async function chargeTypeRow(db: Db, orgId: string, id: string): Promise<ChargeTypeRow> {
  const r = await db.row<ChargeTypeRow>("SELECT * FROM pm_charge_types WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!r) throw fail.notFound("Charge type not found");
  return r;
}

export function setupService(d: PmDeps) {
  const { core } = d;
  const db = core.db;

  async function propertyView(orgId: string, p: R.PropertyRow, today: string): Promise<P.PropertyRecord> {
    const buildings = await db.rows<P.Building>(
      `SELECT b.id, b.name, b.floors, b.is_archived AS "isArchived",
       (SELECT count(*)::int FROM pm_units u WHERE u.building_id=b.id) AS "unitCount",
       (SELECT count(*)::int FROM pm_leases l JOIN pm_units u ON u.id=l.unit_id WHERE u.building_id=b.id AND l.status='active') AS "activeLeaseCount"
       FROM pm_buildings b WHERE b.property_id = $1 ORDER BY b.is_archived, b.name`,
      [p.id],
    );
    const counts = await db.row<{ units: number; let: number }>(
      `SELECT count(*)::int AS units,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pm_leases l WHERE l.unit_id = u.id AND l.status = 'active'
           AND l.start_date <= $2 AND (l.end_date IS NULL OR l.end_date >= $2)))::int AS let
       FROM pm_units u WHERE u.property_id = $1
       AND NOT EXISTS (SELECT 1 FROM pm_buildings b WHERE b.id=u.building_id AND b.is_archived)`,
      [p.id, today],
    );
    const owner = await db.row<{ owner_id: string }>(
      "SELECT owner_id FROM pm_agreements WHERE org_id = $1 AND property_id = $2 AND unit_id IS NULL AND status = 'active'",
      [orgId, p.id],
    );
    return {
      id: p.id,
      name: p.name,
      address: p.address,
      kind: p.kind,
      lateFee: R.toLateFee(p),
      automation: { monthlyBilling: p.auto_billing, billingDay: p.auto_billing_day, lateFees: p.auto_late_fees },
      buildings,
      unitCount: counts?.units ?? 0,
      letCount: counts?.let ?? 0,
      ownerId: owner?.owner_id ?? null,
      createdAt: p.created_at,
    };
  }

  async function unitViews(orgId: string, units: R.UnitRow[], today: string): Promise<P.Unit[]> {
    if (!units.length) return [];
    const leases = await db.rows<{ unit_id: string; id: string }>(
      `SELECT unit_id, id FROM pm_leases WHERE org_id = $1 AND unit_id = ANY($2) AND status = 'active'
         AND start_date <= $3 AND (end_date IS NULL OR end_date >= $3)`,
      [orgId, units.map((u) => u.id), today],
    );
    const ags = await R.agreements(db, orgId, "a.status = 'active'");
    return units.map((u) => {
      const lease = leases.find((l) => l.unit_id === u.id);
      const ag =
        ags.find((a) => a.unit_id === u.id) ?? ags.find((a) => a.property_id === u.property_id && !a.unit_id) ?? null;
      return {
        id: u.id,
        propertyId: u.property_id,
        buildingId: u.building_id,
        unitNo: u.unit_no,
        floor: u.floor,
        unitType: u.unit_type,
        bedrooms: u.bedrooms,
        toilets: u.toilets,
        areaSqm: u.area_sqm === null ? null : Number(u.area_sqm),
        marketRentMinor: u.market_rent_minor,
        status: u.status,
        occupancy: lease ? "let" : "vacant",
        leaseId: lease?.id ?? null,
        ownerId: ag?.owner_id ?? null,
      };
    });
  }

  async function ownerSummary(orgId: string, ownerId: string, today: string): Promise<P.OwnerSummary> {
    const c = await core.contacts.live(db, orgId, ownerId);
    const prof = await db.row<{ bank_account_masked: string; bank_verified_at: string | null; reserve_minor: number }>(
      "SELECT * FROM pm_owner_profiles WHERE owner_id = $1",
      [ownerId],
    );
    const funds = await ownerFunds(db, orgId, today, ownerId);
    return {
      ownerId,
      name: c.name,
      bankAccountMasked: prof?.bank_account_masked ?? "",
      bankVerified: !!prof?.bank_verified_at,
      reserveMinor: prof?.reserve_minor ?? 0,
      fundsMinor: funds.get(ownerId) ?? 0,
      agreements: (await R.agreements(db, orgId, "a.owner_id = $2", [ownerId])).map(R.toAgreement),
    };
  }

  return {
    propertyView,
    unitViews,

    settings: (orgId: string) => settingsOf(db, orgId),

    async updateSettings(
      s: OrgScope,
      b: Partial<Omit<P.Settings, "poLimits">> & { poLimits?: Record<string, number> },
    ) {
      const cur = await settingsOf(db, s.orgId);
      const next = {
        vatPct: b.vatPct ?? cur.vatPct,
        vatFrom: b.vatFrom === undefined ? cur.vatFrom : b.vatFrom,
        poLimits: { ...cur.poLimits, ...(b.poLimits ?? {}) },
        matchTolerancePct: b.matchTolerancePct ?? cur.matchTolerancePct,
        slaDays: b.slaDays ?? cur.slaDays,
      };
      if (next.vatPct > 0 && !next.vatFrom) throw fail.invalid("Give the date the VAT registration applies from");
      await db.tx(async (t) => {
        await t.run(
          `INSERT INTO pm_settings (org_id, vat_bp, vat_from, po_limits, match_tolerance_bp, sla_days, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (org_id) DO UPDATE SET vat_bp = EXCLUDED.vat_bp, vat_from = EXCLUDED.vat_from,
             po_limits = EXCLUDED.po_limits, match_tolerance_bp = EXCLUDED.match_tolerance_bp,
             sla_days = EXCLUDED.sla_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [
            s.orgId,
            toBp(next.vatPct),
            next.vatFrom,
            JSON.stringify(next.poLimits),
            toBp(next.matchTolerancePct),
            JSON.stringify(next.slaDays),
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Property Management settings changed",
          before: cur,
          after: next,
        });
      });
      return settingsOf(db, s.orgId);
    },

    async listChargeTypes(orgId: string) {
      const rows = await db.rows<ChargeTypeRow>("SELECT * FROM pm_charge_types WHERE org_id = $1 ORDER BY code", [
        orgId,
      ]);
      return { chargeTypes: rows.map(toChargeType) };
    },

    async createChargeType(s: OrgScope, b: Omit<P.ChargeType, "id" | "active">): Promise<P.ChargeType> {
      if (b.payee === "agency" && b.feeApplies) throw fail.invalid("The management fee applies to owner charges only");
      if (b.payee === "owner" && b.vatApplies)
        throw fail.invalid("VAT applies to agency charges (the owner's charges are the owner's money)");
      if (b.metered && !b.unitName) throw fail.invalid("Give the unit a metered charge is measured in, e.g. m³");
      return db.tx(async (t) => {
        const id = newId("pct");
        await t.run(
          `INSERT INTO pm_charge_types (id, org_id, code, name, payee, fee_applies, vat_applies, metered, unit_name, rate_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, s.orgId, b.code, b.name, b.payee, b.feeApplies, b.vatApplies, b.metered, b.unitName, b.rateMinor],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Charge type added",
          target: b.code,
          detail: `${b.name} · ${b.payee}${b.metered ? ` · metered ${b.rateMinor} per ${b.unitName}` : ""}`,
        });
        return toChargeType(await chargeTypeRow(t, s.orgId, id));
      });
    },

    async updateChargeType(
      s: OrgScope,
      id: string,
      b: { name?: string | undefined; rateMinor?: number | undefined; active?: boolean | undefined },
    ) {
      return db.tx(async (t) => {
        const before = await chargeTypeRow(t, s.orgId, id);
        await t.run(
          "UPDATE pm_charge_types SET name = $3, rate_minor = $4, active = $5 WHERE org_id = $1 AND id = $2",
          [s.orgId, id, b.name ?? before.name, b.rateMinor ?? before.rate_minor, b.active ?? before.active],
        );
        const after = await chargeTypeRow(t, s.orgId, id);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Charge type changed",
          target: before.code,
          before: toChargeType(before),
          after: toChargeType(after),
        });
        return toChargeType(after);
      });
    },

    async listProperties(s: OrgScope) {
      const rows = await db.rows<R.PropertyRow>("SELECT * FROM pm_properties WHERE org_id = $1 ORDER BY lower(name)", [
        s.orgId,
      ]);
      const properties = [];
      for (const p of rows) properties.push(await propertyView(s.orgId, p, s.today));
      return { properties };
    },

    async createProperty(
      s: OrgScope,
      b: { name: string; address: string; kind: P.PropertyRecord["kind"]; lateFee: P.LateFeePolicy },
    ) {
      requireAllowance(s);
      const id = newId("ppr");
      await db.tx(async (t) => {
        const clash = await t.row("SELECT 1 FROM pm_properties WHERE org_id = $1 AND lower(name) = lower($2)", [
          s.orgId,
          b.name,
        ]);
        if (clash) throw fail.conflict(`${b.name} already exists`);
        await t.run(
          `INSERT INTO pm_properties (id, org_id, name, address, kind, late_fee_enabled, late_fee_bp, late_fee_grace_days,
             late_fee_min_minor, late_fee_payee, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            s.orgId,
            b.name,
            b.address,
            b.kind,
            b.lateFee.enabled,
            toBp(b.lateFee.pct),
            b.lateFee.graceDays,
            b.lateFee.minMinor,
            b.lateFee.payee,
            s.userId,
          ],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Property added", target: id, detail: b.name });
      });
      return propertyView(s.orgId, await R.propertyRow(db, s.orgId, id), s.today);
    },

    async getProperty(s: OrgScope, id: string) {
      const p = await R.propertyRow(db, s.orgId, id);
      const units = await db.rows<R.UnitRow>(
        "SELECT * FROM pm_units WHERE org_id = $1 AND property_id = $2 ORDER BY upper(unit_no)",
        [s.orgId, id],
      );
      return {
        property: await propertyView(s.orgId, p, s.today),
        units: await unitViews(s.orgId, units, s.today),
        agreements: (await R.agreements(db, s.orgId, "a.property_id = $2", [id])).map(R.toAgreement),
      };
    },

    /** Automatic billing and late fees: stored on the property and registered with the PALTAS scheduler. */
    async setAutomation(s: OrgScope, id: string, b: P.Automation) {
      await db.tx(async (t) => {
        const p = await R.propertyRow(t, s.orgId, id, true);
        await t.run(
          "UPDATE pm_properties SET auto_billing = $3, auto_billing_day = $4, auto_late_fees = $5 WHERE org_id = $1 AND id = $2",
          [s.orgId, id, b.monthlyBilling, b.billingDay, b.lateFees],
        );
        const org = await t.row<{ timezone: string }>("SELECT timezone FROM organisations WHERE id = $1", [s.orgId]);
        const timezone = org?.timezone ?? "UTC";
        // a schedule is kept once registered; the job itself does nothing while the property has it switched off
        if (b.monthlyBilling)
          await core.scheduler.ensureJob(t, {
            key: MONTHLY_BILLING_JOB,
            orgId: s.orgId,
            targetId: id,
            label: `Monthly billing run — ${p.name}`,
            cron: `0 6 ${b.billingDay} * *`,
            timezone,
          });
        if (b.lateFees)
          await core.scheduler.ensureJob(t, {
            key: LATE_FEES_JOB,
            orgId: s.orgId,
            targetId: id,
            label: `Late fees — ${p.name}`,
            cron: "30 6 * * *",
            timezone,
          });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Property automation changed",
          target: id,
          before: { monthlyBilling: p.auto_billing, billingDay: p.auto_billing_day, lateFees: p.auto_late_fees },
          after: b,
        });
      });
      return propertyView(s.orgId, await R.propertyRow(db, s.orgId, id), s.today);
    },

    async updateProperty(
      s: OrgScope,
      id: string,
      b: {
        name?: string | undefined;
        address?: string | undefined;
        kind?: P.PropertyRecord["kind"] | undefined;
        lateFee?: P.LateFeePolicy | undefined;
      },
    ) {
      await db.tx(async (t) => {
        const before = await R.propertyRow(t, s.orgId, id, true);
        const lf = b.lateFee ?? R.toLateFee(before);
        await t.run(
          `UPDATE pm_properties SET name = $3, address = $4, kind = $5, late_fee_enabled = $6, late_fee_bp = $7,
             late_fee_grace_days = $8, late_fee_min_minor = $9, late_fee_payee = $10
           WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            id,
            b.name ?? before.name,
            b.address ?? before.address,
            b.kind ?? before.kind,
            lf.enabled,
            toBp(lf.pct),
            lf.graceDays,
            lf.minMinor,
            lf.payee,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Property changed",
          target: id,
          before: { name: before.name, lateFee: R.toLateFee(before) },
          after: { name: b.name ?? before.name, lateFee: lf },
        });
      });
      return propertyView(s.orgId, await R.propertyRow(db, s.orgId, id), s.today);
    },

    async createBuilding(s: OrgScope, propertyId: string, b: { name: string; floors?: number | undefined }) {
      await R.propertyRow(db, s.orgId, propertyId);
      return db.tx(async (t) => {
        const id = newId("pbl");
        if (
          await t.row("SELECT 1 FROM pm_buildings WHERE property_id = $1 AND lower(name) = lower($2)", [
            propertyId,
            b.name,
          ])
        )
          throw fail.conflict(`${b.name} already exists in this property`);
        await t.run("INSERT INTO pm_buildings (id, org_id, property_id, name, floors) VALUES ($1, $2, $3, $4, $5)", [
          id,
          s.orgId,
          propertyId,
          b.name,
          b.floors ?? null,
        ]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Building added", target: id, detail: b.name });
        return { id, name: b.name, floors: b.floors ?? null, isArchived: false, unitCount: 0, activeLeaseCount: 0 };
      });
    },

    async updateBuilding(s: OrgScope, id: string, b: { name: string }) {
      const propertyId = await db.tx(async (t) => {
        const before = await t.row<{ name: string; property_id: string }>(
          "SELECT * FROM pm_buildings WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [s.orgId, id],
        );
        if (!before) throw fail.notFound("Block not found");
        await t.run("UPDATE pm_buildings SET name=$3 WHERE org_id=$1 AND id=$2", [s.orgId, id, b.name]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Block renamed",
          target: id,
          before: { name: before.name },
          after: { name: b.name },
        });
        return before.property_id;
      });
      const p = await propertyView(s.orgId, await R.propertyRow(db, s.orgId, propertyId), s.today);
      const building = p.buildings.find((b) => b.id === id);
      if (!building) throw fail.notFound("Block not found");
      return building;
    },

    async deleteBuilding(s: OrgScope, id: string): Promise<{ id: string; action: "deleted" | "archived" }> {
      return db.tx(async (t) => {
        const before = await t.row<{ name: string; is_archived: boolean }>(
          "SELECT * FROM pm_buildings WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [s.orgId, id],
        );
        if (!before) throw fail.notFound("Block not found");
        const active = await t.row<{ n: number }>(
          "SELECT count(*)::int n FROM pm_leases l JOIN pm_units u ON u.id=l.unit_id WHERE u.building_id=$1 AND l.status='active'",
          [id],
        );
        if (!active) throw new Error("Could not read block lease count");
        if (active.n > 0)
          throw fail.invalid(
            `Cannot delete this block. It currently has ${active.n} active leases. Please terminate all leases first.`,
          );
        const units = await t.row<{ n: number }>("SELECT count(*)::int n FROM pm_units WHERE building_id=$1", [id]);
        if (!units) throw new Error("Could not read block unit count");
        const action = units.n > 0 ? ("archived" as const) : ("deleted" as const);
        if (action === "archived")
          await t.run("UPDATE pm_buildings SET is_archived=true WHERE org_id=$1 AND id=$2", [s.orgId, id]);
        else await t.run("DELETE FROM pm_buildings WHERE org_id=$1 AND id=$2", [s.orgId, id]);
        if (!before.is_archived || action === "deleted")
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: action === "archived" ? "Block archived" : "Empty block deleted",
            target: id,
            before: { name: before.name },
            after: { action },
          });
        return { id, action };
      });
    },

    async createUnits(
      s: OrgScope,
      propertyId: string,
      units: {
        unitNo: string;
        buildingId?: string | undefined;
        floor?: string | undefined;
        unitType?: string | undefined;
        bedrooms?: number | undefined;
        toilets?: number | undefined;
        areaSqm?: number | undefined;
        marketRentMinor?: number | undefined;
        status: "available" | "off_market";
      }[],
    ) {
      await R.propertyRow(db, s.orgId, propertyId);
      const seen = new Set<string>();
      for (const u of units) {
        const k = u.unitNo.toUpperCase();
        if (seen.has(k)) throw fail.invalid(`Unit ${u.unitNo} appears twice`);
        seen.add(k);
      }
      const ids = await db.tx(async (t) => {
        const out: string[] = [];
        for (const u of units) {
          if (
            u.buildingId &&
            !(await t.row("SELECT 1 FROM pm_buildings WHERE id = $1 AND property_id = $2", [u.buildingId, propertyId]))
          )
            throw fail.invalid(`Building ${u.buildingId} is not in this property`);
          if (
            await t.row("SELECT 1 FROM pm_units WHERE property_id = $1 AND upper(unit_no) = upper($2)", [
              propertyId,
              u.unitNo,
            ])
          )
            throw fail.conflict(`Unit ${u.unitNo} already exists in this property`);
          const id = newId("pun");
          await t.run(
            `INSERT INTO pm_units (id, org_id, property_id, building_id, unit_no, floor, unit_type, bedrooms, area_sqm,
               market_rent_minor, status, toilets)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              id,
              s.orgId,
              propertyId,
              u.buildingId ?? null,
              u.unitNo,
              u.floor ?? null,
              u.unitType ?? null,
              u.bedrooms ?? null,
              u.areaSqm ?? null,
              u.marketRentMinor ?? null,
              u.status,
              u.toilets ?? null,
            ],
          );
          out.push(id);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Units added",
          target: propertyId,
          detail: `${units.length} unit(s): ${units
            .map((u) => u.unitNo)
            .join(", ")
            .slice(0, 400)}`,
        });
        return out;
      });
      const rows = await db.rows<R.UnitRow>("SELECT * FROM pm_units WHERE id = ANY($1) ORDER BY upper(unit_no)", [ids]);
      return { units: await unitViews(s.orgId, rows, s.today) };
    },

    async updateUnit(
      s: OrgScope,
      id: string,
      b: Partial<{
        unitNo: string;
        buildingId: string;
        floor: string;
        unitType: string;
        bedrooms: number;
        toilets: number;
        areaSqm: number;
        marketRentMinor: number;
        status: "available" | "off_market";
        archive: boolean;
      }>,
    ) {
      await db.tx(async (t) => {
        // Serialize removal with lease creation/activation, which locks the same unit row.
        if (!(await t.row("SELECT id FROM pm_units WHERE org_id=$1 AND id=$2 FOR UPDATE", [s.orgId, id])))
          throw fail.notFound("Apartment not found");
        const u = await R.unitRow(t, s.orgId, id);
        if (b.archive) {
          if (Object.keys(b).some((key) => key !== "archive"))
            throw fail.invalid("Remove the apartment separately from other edits");
          const originalBlock = u.building_id
            ? await t.row<{ is_archived: boolean }>("SELECT is_archived FROM pm_buildings WHERE org_id=$1 AND id=$2", [
                s.orgId,
                u.building_id,
              ])
            : undefined;
          if (originalBlock?.is_archived) return;
          if (
            await t.row("SELECT 1 FROM pm_leases WHERE org_id=$1 AND unit_id=$2 AND status IN ('draft','active')", [
              s.orgId,
              id,
            ])
          )
            throw fail.conflict("This apartment has a draft or active lease. Resolve that lease before removing it.");
          // Move into a new active holding block, then archive it in the same transaction.
          // Existing block/lease safety triggers remain enabled throughout; no history is deleted.
          const archiveId = newId("pbl");
          await t.run("INSERT INTO pm_buildings (id,org_id,property_id,name) VALUES ($1,$2,$3,$4)", [
            archiveId,
            s.orgId,
            u.property_id,
            `Removed ${u.unit_no.slice(0, 40)} — ${archiveId}`,
          ]);
          await t.run("UPDATE pm_units SET building_id=$3 WHERE org_id=$1 AND id=$2", [s.orgId, id, archiveId]);
          await t.run("UPDATE pm_buildings SET is_archived=true WHERE org_id=$1 AND id=$2", [s.orgId, archiveId]);
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Apartment removed from inventory",
            target: id,
            before: { buildingId: u.building_id, floor: u.floor, unitNo: u.unit_no },
            after: { buildingId: archiveId, archived: true },
            detail: "All tenancy, invoice, payment and ledger history retained",
          });
          return;
        }
        if (b.status === "off_market") {
          const active = await t.row("SELECT 1 FROM pm_leases WHERE unit_id = $1 AND status = 'active'", [id]);
          if (active)
            throw fail.conflict("The unit has an active lease — end it before taking the unit off the market");
        }
        if (b.unitNo && b.unitNo.toUpperCase() !== u.unit_no.toUpperCase()) {
          if (
            await t.row("SELECT 1 FROM pm_units WHERE property_id = $1 AND upper(unit_no) = upper($2)", [
              u.property_id,
              b.unitNo,
            ])
          )
            throw fail.conflict(`Unit ${b.unitNo} already exists in this property`);
        }
        if (
          b.buildingId &&
          !(await t.row("SELECT 1 FROM pm_buildings WHERE id = $1 AND property_id = $2", [b.buildingId, u.property_id]))
        )
          throw fail.invalid("That building is not in this property");
        await t.run(
          `UPDATE pm_units SET unit_no = $3, building_id = $4, floor = $5, unit_type = $6, bedrooms = $7, area_sqm = $8,
             market_rent_minor = $9, status = $10, toilets = $11 WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            id,
            b.unitNo ?? u.unit_no,
            b.buildingId ?? u.building_id,
            b.floor ?? u.floor,
            b.unitType ?? u.unit_type,
            b.bedrooms ?? u.bedrooms,
            b.areaSqm ?? u.area_sqm,
            b.marketRentMinor ?? u.market_rent_minor,
            b.status ?? u.status,
            b.toilets ?? u.toilets,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Unit changed",
          target: id,
          before: u,
          after: b,
        });
      });
      const [view] = await unitViews(s.orgId, [await R.unitRow(db, s.orgId, id)], s.today);
      return view as P.Unit;
    },

    async listAgreements(orgId: string, f: { propertyId?: string | undefined; ownerId?: string | undefined }) {
      const rows = await R.agreements(
        db,
        orgId,
        "($2::text IS NULL OR a.property_id = $2) AND ($3::text IS NULL OR a.owner_id = $3)",
        [f.propertyId ?? null, f.ownerId ?? null],
      );
      return { agreements: rows.map(R.toAgreement) };
    },

    async createAgreement(
      s: OrgScope,
      b: {
        propertyId: string;
        unitId?: string | undefined;
        ownerId: string;
        feePct: number;
        authorityMinor: number;
        payoutDay: number;
        startDate: string;
      },
    ) {
      await R.propertyRow(db, s.orgId, b.propertyId);
      if (b.unitId) {
        const u = await R.unitRow(db, s.orgId, b.unitId);
        if (u.property_id !== b.propertyId) throw fail.invalid("That unit is not in this property");
      }
      const id = newId("pag");
      await db.tx(async (t) => {
        const owner = await core.contacts.live(t, s.orgId, b.ownerId, true);
        const clash = await t.row(
          "SELECT number FROM pm_agreements WHERE property_id = $1 AND COALESCE(unit_id, '') = COALESCE($2, '') AND status = 'active'",
          [b.propertyId, b.unitId ?? null],
        );
        if (clash) throw fail.conflict("An active management agreement already covers this — end it first");
        await t.run(
          `INSERT INTO pm_agreements (id, org_id, number, property_id, unit_id, owner_id, fee_bp, authority_minor, payout_day,
             start_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            s.orgId,
            await nextNumber(t, `pm:${s.orgId}`, "MA", 4),
            b.propertyId,
            b.unitId ?? null,
            b.ownerId,
            toBp(b.feePct),
            b.authorityMinor,
            b.payoutDay,
            b.startDate,
            s.userId,
          ],
        );
        await core.contacts.addTypes(t, s.orgId, b.ownerId, ["owner"]);
        await t.run(
          "INSERT INTO pm_owner_profiles (owner_id, org_id) VALUES ($1, $2) ON CONFLICT (owner_id) DO NOTHING",
          [b.ownerId, s.orgId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Management agreement added",
          target: id,
          detail: `${owner.name} · fee ${b.feePct}% · authority ${b.authorityMinor}`,
        });
      });
      const [a] = await R.agreements(db, s.orgId, "a.id = $2", [id]);
      return R.toAgreement(a as R.AgreementRow);
    },

    async endAgreement(s: OrgScope, id: string, b: { endDate: string; reason: string }) {
      await db.tx(async (t) => {
        const [a] = await R.agreements(t, s.orgId, "a.id = $2", [id]);
        if (!a) throw fail.notFound("Agreement not found");
        if (a.status !== "active") throw fail.conflict("This agreement has already ended");
        if (b.endDate < a.start_date) throw fail.invalid("An agreement cannot end before it starts");
        await t.run("UPDATE pm_agreements SET status = 'ended', end_date = $2 WHERE id = $1", [id, b.endDate]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Management agreement ended",
          target: a.number,
          detail: b.reason,
        });
      });
      const [a] = await R.agreements(db, s.orgId, "a.id = $2", [id]);
      return R.toAgreement(a as R.AgreementRow);
    },

    ownerSummary,

    async listOwners(s: OrgScope) {
      const ids = await db.rows<{ owner_id: string }>(
        "SELECT DISTINCT owner_id FROM pm_agreements WHERE org_id = $1 UNION SELECT owner_id FROM pm_owner_profiles WHERE org_id = $1",
        [s.orgId],
      );
      const owners = [];
      for (const r of ids) owners.push(await ownerSummary(s.orgId, r.owner_id, s.today));
      return { owners: owners.sort((a, b) => a.name.localeCompare(b.name)) };
    },

    async updateOwnerProfile(
      s: OrgScope,
      ownerId: string,
      b: {
        bankAccountMasked?: string | undefined;
        verifyBank?: boolean | undefined;
        reserveMinor?: number | undefined;
      },
    ) {
      await financeTransaction(db, s.orgId, async (t) => {
        const owner = await core.contacts.live(t, s.orgId, ownerId);
        if (!owner.types.includes("owner")) throw fail.invalid("This contact is not an owner");
        const before = await t.row<{ bank_account_masked: string; reserve_minor: number }>(
          "SELECT * FROM pm_owner_profiles WHERE owner_id = $1",
          [ownerId],
        );
        const changedBank = b.bankAccountMasked !== undefined && b.bankAccountMasked !== before?.bank_account_masked;
        const changedReserve = b.reserveMinor !== undefined && b.reserveMinor !== (before?.reserve_minor ?? 0);
        if (
          (changedBank || changedReserve) &&
          (await t.row(
            "SELECT 1 FROM pm_payouts WHERE org_id=$1 AND owner_id=$2 AND status IN ('prepared','approved') LIMIT 1",
            [s.orgId, ownerId],
          ))
        )
          throw fail.conflict(
            "Cancel the owner's pending payout before changing the payout account or reserve, then prepare it again",
          );
        await t.run(
          `INSERT INTO pm_owner_profiles (owner_id, org_id, bank_account_masked, reserve_minor) VALUES ($1, $2, $3, $4)
           ON CONFLICT (owner_id) DO UPDATE SET bank_account_masked = EXCLUDED.bank_account_masked,
             reserve_minor = EXCLUDED.reserve_minor, updated_at = now(),
             -- a changed bank account must be verified again
             bank_verified_at = CASE WHEN $5 THEN NULL ELSE pm_owner_profiles.bank_verified_at END,
             bank_verified_by = CASE WHEN $5 THEN NULL ELSE pm_owner_profiles.bank_verified_by END`,
          [
            ownerId,
            s.orgId,
            b.bankAccountMasked ?? before?.bank_account_masked ?? "",
            b.reserveMinor ?? before?.reserve_minor ?? 0,
            changedBank,
          ],
        );
        if (b.verifyBank) {
          const p = await t.row<{ bank_account_masked: string }>(
            "SELECT bank_account_masked FROM pm_owner_profiles WHERE owner_id = $1",
            [ownerId],
          );
          if (!p?.bank_account_masked) throw fail.invalid("Record the owner's bank account before verifying it");
          await t.run(
            "UPDATE pm_owner_profiles SET bank_verified_at = now(), bank_verified_by = $2 WHERE owner_id = $1",
            [ownerId, s.userId],
          );
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.verifyBank ? "Owner bank details verified" : "Owner payout details changed",
          target: ownerId,
          detail: owner.name,
        });
      });
      return ownerSummary(s.orgId, ownerId, s.today);
    },
  };
}

export type SetupService = ReturnType<typeof setupService>;
