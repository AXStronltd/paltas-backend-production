/*
 * Hotel set-up: properties (with their own tax engine and business date), room types, rooms, rate plans, seasons,
 * restrictions, channels, outlets, company accounts and guest profiles. Every change is audited; changes that
 * affect what channels sell queue an availability-and-rates update for them.
 */
import { roleCan, type hotel, type z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, DEFAULT_USALI } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import { assignedProperties, assignToProperty, reachesAllHotels, type HotelScope } from "../shared/access.js";
import { addDays, daysBetween } from "../shared/dates.js";
import { queueAri, refreshTotals } from "../shared/inventory.js";
import { findProperty, listPropertyRows, toBp, toProperty } from "../shared/property.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { loadRateBook, toRatePlan, toRestriction } from "../shared/rates.js";
import * as repo from "./setup.repo.js";

type PropertyInput = z.output<typeof hotel.createProperty.body>;
type RatePlanInput = z.output<typeof hotel.createRatePlan.body>;

/** How far ahead a base-rate change is pushed to the channels. */
const ARI_HORIZON_DAYS = 30;

function taxColumns(t: hotel.TaxConfig) {
  return {
    vat_bp: toBp(t.vatPct),
    service_charge_bp: toBp(t.serviceChargePct),
    service_charge_departments: t.serviceChargeDepartments,
    vat_on_service_charge: t.vatOnServiceCharge,
    levy_kind: t.levy.kind,
    levy_name: t.levy.name,
    levy_amount_minor: t.levy.amountMinor,
    levy_bp: toBp(t.levy.pct),
  };
}

export function setupService(d: HotelDeps) {
  const { core, adapters } = d;
  const { db } = core;

  /** Push availability and rates for every room type of a hotel over a date range. */
  async function pushAll(t: Db, s: HotelScope, from: string, to: string) {
    const book = await loadRateBook(t, s.property.id);
    for (const rt of await repo.roomTypes(t, s.property.id))
      await queueAri(t, adapters, book, { orgId: s.orgId, propertyId: s.property.id, roomTypeId: rt.id, from, to });
  }

  async function setup(s: HotelScope) {
    const book = await loadRateBook(db, s.property.id);
    const channels = await db.rows<repo.ChannelRow>(
      "SELECT * FROM hotel_channels WHERE property_id = $1 ORDER BY code",
      [s.property.id],
    );
    const outlets = await db.rows<repo.OutletRow>("SELECT * FROM hotel_outlets WHERE property_id = $1 ORDER BY code", [
      s.property.id,
    ]);
    return {
      property: toProperty(await findProperty(db, s.orgId, s.property.id)),
      roomTypes: (await repo.roomTypes(db, s.property.id)).map(repo.toRoomType),
      rooms: (await repo.rooms(db, s.property.id)).map(repo.toRoom),
      ratePlans: [...book.plans.values()].map((p) => toRatePlan(book, p)),
      restrictions: book.restrictions.map(toRestriction),
      channels: channels.map((c) => repo.toChannel(c, adapters.channels.state)),
      outlets: outlets.map(repo.toOutlet),
    };
  }

  async function ratePlan(t: Db, s: HotelScope, id: string) {
    const book = await loadRateBook(t, s.property.id);
    const p = book.plans.get(id);
    if (!p) throw fail.notFound("Rate plan not found");
    return toRatePlan(book, p);
  }

  async function checkRoomTypes(t: Db, s: HotelScope, ids: string[]) {
    const known = new Set((await repo.roomTypes(t, s.property.id)).map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw fail.invalid(`Unknown room type(s) for this hotel: ${unknown.join(", ")}`);
  }

  async function corporateAccount(t: Db, orgId: string, id: string, today: string): Promise<hotel.CorporateAccountOut> {
    const a = await t.row<{
      id: string;
      name: string;
      kind: "company" | "travel_agent";
      credit_limit_minor: number;
      contact_email: string | null;
      tax_id: string | null;
      billing_address: string | null;
      payment_terms_days: number;
    }>("SELECT * FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!a) throw fail.notFound("Company account not found");
    const entries = await t.rows<{ kind: "invoice" | "payment"; date: string; amount_minor: number }>(
      "SELECT kind, date, amount_minor FROM hotel_city_ledger WHERE account_id = $1 ORDER BY date, number",
      [id],
    );
    // payments settle the oldest invoices first; what is left is aged from the invoice date
    let paid = entries.filter((e) => e.kind === "payment").reduce((n, e) => n + e.amount_minor, 0);
    const ageing = { current: 0, d31to60: 0, d61to90: 0, over90: 0 };
    let balance = -paid;
    for (const inv of entries.filter((e) => e.kind === "invoice")) {
      balance += inv.amount_minor;
      const settled = Math.min(paid, inv.amount_minor);
      paid -= settled;
      const open = inv.amount_minor - settled;
      if (!open) continue;
      const age = daysBetween(inv.date, today);
      if (age <= 30) ageing.current += open;
      else if (age <= 60) ageing.d31to60 += open;
      else if (age <= 90) ageing.d61to90 += open;
      else ageing.over90 += open;
    }
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      creditLimitMinor: a.credit_limit_minor,
      contactEmail: a.contact_email,
      taxId: a.tax_id,
      billingAddress: a.billing_address,
      paymentTermsDays: a.payment_terms_days,
      balanceMinor: balance,
      ageing,
    };
  }

  return {
    corporateAccount,

    async listProperties(s: OrgScope) {
      const all = await listPropertyRows(db, s.orgId);
      const allowed = await assignedProperties(db, s);
      return {
        properties: all.filter((p) => !allowed || allowed.includes(p.id)).map(toProperty),
        groupViews: all.length >= 2 && roleCan(s.role, "hotel.group.read"),
      };
    },

    async createProperty(s: OrgScope, b: PropertyInput) {
      const allowance = s.entitlement.ent.buildings;
      if (allowance.used >= allowance.allowed) {
        throw fail.allowanceExceeded(`All ${allowance.allowed} hotel allowance(s) in your plan are in use`, {
          used: allowance.used,
          allowed: allowance.allowed,
          extraPrice: s.entitlement.ent.extraBuilding ?? null,
          upgrades: s.entitlement.ent.upgrades,
        });
      }
      const id = newId("htl");
      const tax = taxColumns(b.tax);
      await db.tx(async (t) => {
        if (
          await t.row("SELECT 1 FROM hotel_properties WHERE org_id = $1 AND lower(name) = lower($2)", [s.orgId, b.name])
        )
          throw fail.conflict("A hotel with this name already exists");
        await t.run(
          `INSERT INTO hotel_properties (id, org_id, name, country, city, timezone, check_in_time, check_out_time,
             business_date, vat_bp, service_charge_bp, service_charge_departments, vat_on_service_charge, levy_kind,
             levy_name, levy_amount_minor, levy_bp, require_inspection, welcome_temp_c, eco_temp_c, faq, usali)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [
            id,
            s.orgId,
            b.name,
            b.country,
            b.city,
            b.timezone,
            b.checkInTime,
            b.checkOutTime,
            b.businessDate ?? s.today,
            tax.vat_bp,
            tax.service_charge_bp,
            tax.service_charge_departments,
            tax.vat_on_service_charge,
            tax.levy_kind,
            tax.levy_name,
            tax.levy_amount_minor,
            tax.levy_bp,
            b.requireInspection,
            b.welcomeTemperatureC,
            b.ecoTemperatureC,
            JSON.stringify(b.faq),
            JSON.stringify(b.usali ?? DEFAULT_USALI),
          ],
        );
        // whoever adds a hotel works there (unless they already reach every hotel)
        if (!reachesAllHotels(s.role)) await assignToProperty(t, s.orgId, id, [s.userId]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Hotel added", target: id, detail: b.name });
      });
      return toProperty(await findProperty(db, s.orgId, id));
    },

    async updateProperty(s: HotelScope, b: Partial<PropertyInput>) {
      const before = toProperty(s.property);
      await db.tx(async (t) => {
        const sets: string[] = [];
        const vals: unknown[] = [];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length + 2}`);
        };
        if (b.name !== undefined) set("name", b.name);
        if (b.country !== undefined) set("country", b.country);
        if (b.city !== undefined) set("city", b.city);
        if (b.timezone !== undefined) set("timezone", b.timezone);
        if (b.checkInTime !== undefined) set("check_in_time", b.checkInTime);
        if (b.checkOutTime !== undefined) set("check_out_time", b.checkOutTime);
        if (b.tax !== undefined) for (const [k, v] of Object.entries(taxColumns(b.tax))) set(k, v);
        if (b.requireInspection !== undefined) set("require_inspection", b.requireInspection);
        if (b.welcomeTemperatureC !== undefined) set("welcome_temp_c", b.welcomeTemperatureC);
        if (b.ecoTemperatureC !== undefined) set("eco_temp_c", b.ecoTemperatureC);
        if (b.faq !== undefined) set("faq", JSON.stringify(b.faq));
        if (b.usali !== undefined) set("usali", JSON.stringify(b.usali));
        if (sets.length)
          await t.run(`UPDATE hotel_properties SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2`, [
            s.orgId,
            s.property.id,
            ...vals,
          ]);
        const after = toProperty(await findProperty(t, s.orgId, s.property.id));
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Hotel settings changed",
          target: s.property.id,
          before,
          after,
        });
      });
      return toProperty(await findProperty(db, s.orgId, s.property.id));
    },

    async setStaff(s: HotelScope, userIds: string[]) {
      const unique = [...new Set(userIds)];
      const members = await db.rows<{ user_id: string }>(
        "SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = ANY($2::text[]) AND status = 'active'",
        [s.orgId, unique],
      );
      if (members.length !== unique.length) throw fail.invalid("Every person must be an active member");
      if (!reachesAllHotels(s.role) && !unique.includes(s.userId))
        throw fail.invalid("Keep yourself on this hotel's staff — an administrator can remove you");
      await db.tx(async (t) => {
        await t.run("DELETE FROM hotel_property_staff WHERE property_id = $1", [s.property.id]);
        await assignToProperty(t, s.orgId, s.property.id, unique);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Hotel staff assigned",
          target: s.property.id,
          after: unique,
        });
      });
      return { userIds: unique.sort() };
    },

    setup,

    async createRoomType(s: HotelScope, b: z.output<typeof hotel.createRoomType.body>) {
      const id = newId("hrt");
      await db.tx(async (t) => {
        if (await t.row("SELECT 1 FROM hotel_room_types WHERE property_id = $1 AND code = $2", [s.property.id, b.code]))
          throw fail.conflict(`Room type ${b.code} already exists`);
        await t.run(
          `INSERT INTO hotel_room_types (id, org_id, property_id, code, name, capacity_adults, capacity_children, beds, size_sqm, amenities)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.code,
            b.name,
            b.capacityAdults,
            b.capacityChildren,
            b.beds,
            b.sizeSqm,
            b.amenities,
          ],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Room type added", target: id, detail: b.code });
      });
      return repo.toRoomType(await repo.roomType(db, s.property.id, id));
    },

    async createRooms(s: HotelScope, b: z.output<typeof hotel.createRooms.body>) {
      await checkRoomTypes(
        db,
        s,
        b.rooms.map((r) => r.roomTypeId),
      );
      const numbers = b.rooms.map((r) => r.number);
      if (new Set(numbers).size !== numbers.length) throw fail.invalid("Room numbers repeat");
      const ids: string[] = [];
      await db.tx(async (t) => {
        const taken = await t.rows<{ number: string }>(
          "SELECT number FROM hotel_rooms WHERE property_id = $1 AND number = ANY($2::text[])",
          [s.property.id, numbers],
        );
        if (taken.length) throw fail.conflict(`Room(s) already exist: ${taken.map((r) => r.number).join(", ")}`);
        for (const r of b.rooms) {
          const id = newId("hrm");
          ids.push(id);
          await t.run(
            `INSERT INTO hotel_rooms (id, org_id, property_id, room_type_id, number, floor, attributes)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, s.orgId, s.property.id, r.roomTypeId, r.number, r.floor, r.attributes],
          );
        }
        for (const rt of new Set(b.rooms.map((r) => r.roomTypeId))) await refreshTotals(t, rt);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rooms added",
          target: s.property.id,
          detail: numbers.join(", "),
        });
        await pushAll(t, s, s.property.business_date, addDays(s.property.business_date, ARI_HORIZON_DAYS));
      });
      return { rooms: (await repo.rooms(db, s.property.id)).filter((r) => ids.includes(r.id)).map(repo.toRoom) };
    },

    async createRatePlan(s: HotelScope, b: RatePlanInput) {
      const derived = b.kind === "derived";
      if (derived !== !!b.parentId || derived !== (b.derivedPct !== undefined))
        throw fail.invalid("A derived plan needs a parent plan and a percentage; other plans have neither");
      if (b.kind === "corporate" && !b.corporateAccountId)
        throw fail.invalid("A corporate plan belongs to a company account");
      if (!derived && !b.baseRates.length) throw fail.invalid("Give the plan's base rate for at least one room type");
      const id = newId("hrp");
      const policy = b.kind === "non_refundable" ? { ...b.policy, refundable: false } : b.policy;
      await db.tx(async (t) => {
        await checkRoomTypes(
          t,
          s,
          b.baseRates.map((r) => r.roomTypeId),
        );
        if (await t.row("SELECT 1 FROM hotel_rate_plans WHERE property_id = $1 AND code = $2", [s.property.id, b.code]))
          throw fail.conflict(`Rate plan ${b.code} already exists`);
        if (
          b.parentId &&
          !(await t.row("SELECT 1 FROM hotel_rate_plans WHERE property_id = $1 AND id = $2", [
            s.property.id,
            b.parentId,
          ]))
        )
          throw fail.invalid("Unknown parent rate plan");
        if (
          b.corporateAccountId &&
          !(await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [
            s.orgId,
            b.corporateAccountId,
          ]))
        )
          throw fail.invalid("Unknown company account");
        await t.run(
          `INSERT INTO hotel_rate_plans (id, org_id, property_id, code, name, kind, parent_id, derived_bp, breakfast_included,
             refundable, free_cancel_days, cancel_fee_nights, no_show_fee_nights, corporate_account_id, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.code,
            b.name,
            b.kind,
            b.parentId ?? null,
            b.derivedPct === undefined ? null : toBp(b.derivedPct),
            b.breakfastIncluded,
            policy.refundable,
            policy.freeCancelDays,
            policy.cancelFeeNights,
            policy.noShowFeeNights,
            b.corporateAccountId ?? null,
            b.active,
          ],
        );
        for (const r of derived ? [] : b.baseRates)
          await t.run("INSERT INTO hotel_rate_prices (rate_plan_id, room_type_id, amount_minor) VALUES ($1, $2, $3)", [
            id,
            r.roomTypeId,
            r.amountMinor,
          ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rate plan added",
          target: id,
          detail: `${b.code} (${b.kind})`,
        });
        await pushAll(t, s, s.property.business_date, addDays(s.property.business_date, ARI_HORIZON_DAYS));
      });
      return ratePlan(db, s, id);
    },

    async updateRatePlan(s: HotelScope, id: string, b: Partial<RatePlanInput>) {
      const before = await ratePlan(db, s, id);
      if (b.derivedPct !== undefined && before.kind !== "derived")
        throw fail.invalid("Only a derived plan has a percentage");
      if (b.baseRates?.length && before.kind === "derived")
        throw fail.invalid("A derived plan takes its prices from its parent");
      await db.tx(async (t) => {
        if (b.baseRates)
          await checkRoomTypes(
            t,
            s,
            b.baseRates.map((r) => r.roomTypeId),
          );
        const policy = b.policy
          ? before.kind === "non_refundable"
            ? { ...b.policy, refundable: false }
            : b.policy
          : null;
        await t.run(
          `UPDATE hotel_rate_plans SET name = COALESCE($2, name), breakfast_included = COALESCE($3, breakfast_included),
             active = COALESCE($4, active), derived_bp = COALESCE($5, derived_bp),
             refundable = COALESCE($6, refundable), free_cancel_days = COALESCE($7, free_cancel_days),
             cancel_fee_nights = COALESCE($8, cancel_fee_nights), no_show_fee_nights = COALESCE($9, no_show_fee_nights)
           WHERE id = $1`,
          [
            id,
            b.name ?? null,
            b.breakfastIncluded ?? null,
            b.active ?? null,
            b.derivedPct === undefined ? null : toBp(b.derivedPct),
            policy?.refundable ?? null,
            policy?.freeCancelDays ?? null,
            policy?.cancelFeeNights ?? null,
            policy?.noShowFeeNights ?? null,
          ],
        );
        for (const r of b.baseRates ?? [])
          await t.run(
            `INSERT INTO hotel_rate_prices (rate_plan_id, room_type_id, amount_minor) VALUES ($1, $2, $3)
             ON CONFLICT (rate_plan_id, room_type_id) DO UPDATE SET amount_minor = EXCLUDED.amount_minor`,
            [id, r.roomTypeId, r.amountMinor],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rate plan changed",
          target: id,
          before,
          after: await ratePlan(t, s, id),
        });
        await pushAll(t, s, s.property.business_date, addDays(s.property.business_date, ARI_HORIZON_DAYS));
      });
      return ratePlan(db, s, id);
    },

    async setSeasons(s: HotelScope, id: string, seasons: hotel.RatePlan["seasons"]) {
      const before = await ratePlan(db, s, id);
      if (before.kind === "derived" && seasons.length)
        throw fail.invalid("A derived plan takes its prices from its parent");
      for (const x of seasons) if (x.to < x.from) throw fail.invalid(`Season ${x.name} ends before it starts`);
      await db.tx(async (t) => {
        await checkRoomTypes(
          t,
          s,
          seasons.map((x) => x.roomTypeId),
        );
        await t.run("DELETE FROM hotel_rate_seasons WHERE rate_plan_id = $1", [id]);
        for (const x of seasons)
          await t.run(
            `INSERT INTO hotel_rate_seasons (id, rate_plan_id, room_type_id, name, date_from, date_to, amount_minor, weekday_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [newId("hse"), id, x.roomTypeId, x.name, x.from, x.to, x.amountMinor, x.weekdayAmountsMinor ?? null],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rate seasons changed",
          target: id,
          before: before.seasons,
          after: seasons,
        });
        const dates = [...before.seasons, ...seasons];
        if (dates.length) {
          const from = dates.map((x) => x.from).reduce((a, c) => (c < a ? c : a));
          const to = dates.map((x) => x.to).reduce((a, c) => (c > a ? c : a));
          await pushAll(t, s, from, addDays(to, 1));
        }
      });
      return ratePlan(db, s, id);
    },

    async setRestrictions(s: HotelScope, list: hotel.RestrictionOut[]) {
      const before = (await loadRateBook(db, s.property.id)).restrictions.map(toRestriction);
      await db.tx(async (t) => {
        await checkRoomTypes(
          t,
          s,
          list.flatMap((r) => (r.roomTypeId ? [r.roomTypeId] : [])),
        );
        const plans = new Set(
          (await t.rows<{ id: string }>("SELECT id FROM hotel_rate_plans WHERE property_id = $1", [s.property.id])).map(
            (r) => r.id,
          ),
        );
        const channels = new Set(
          (await t.rows<{ id: string }>("SELECT id FROM hotel_channels WHERE property_id = $1", [s.property.id])).map(
            (r) => r.id,
          ),
        );
        for (const r of list) {
          if (r.to < r.from) throw fail.invalid("A restriction ends before it starts");
          if (r.ratePlanId && !plans.has(r.ratePlanId)) throw fail.invalid("Unknown rate plan in a restriction");
          if (r.channelId && !channels.has(r.channelId)) throw fail.invalid("Unknown channel in a restriction");
        }
        await t.run("DELETE FROM hotel_restrictions WHERE property_id = $1", [s.property.id]);
        for (const r of list)
          await t.run(
            `INSERT INTO hotel_restrictions (id, org_id, property_id, room_type_id, rate_plan_id, channel_id, date_from, date_to,
               min_stay, max_stay, cta, ctd, stop_sell) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              newId("hrs"),
              s.orgId,
              s.property.id,
              r.roomTypeId,
              r.ratePlanId,
              r.channelId,
              r.from,
              r.to,
              r.minStay,
              r.maxStay,
              r.closedToArrival,
              r.closedToDeparture,
              r.stopSell,
            ],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Restrictions changed",
          target: s.property.id,
          before,
          after: list,
        });
        const all = [...before, ...list];
        if (all.length) {
          const from = all.map((x) => x.from).reduce((a, c) => (c < a ? c : a));
          const to = all.map((x) => x.to).reduce((a, c) => (c > a ? c : a));
          await pushAll(t, s, from, addDays(to, 1));
        }
      });
      return { restrictions: (await loadRateBook(db, s.property.id)).restrictions.map(toRestriction) };
    },

    async createChannel(s: HotelScope, b: z.output<typeof hotel.createChannel.body>) {
      const id = newId("hch");
      await db.tx(async (t) => {
        if (await t.row("SELECT 1 FROM hotel_channels WHERE property_id = $1 AND code = $2", [s.property.id, b.code]))
          throw fail.conflict(`Channel ${b.code} already exists`);
        await t.run(
          `INSERT INTO hotel_channels (id, org_id, property_id, code, name, provider, commission_bp) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, s.orgId, s.property.id, b.code, b.name, b.provider, toBp(b.commissionPct)],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Channel connected",
          target: id,
          detail: b.name,
        });
        // the new channel receives the current availability and rates
        await pushAll(t, s, s.property.business_date, addDays(s.property.business_date, ARI_HORIZON_DAYS));
      });
      const c = await db.row<repo.ChannelRow>("SELECT * FROM hotel_channels WHERE id = $1", [id]);
      return repo.toChannel(c as repo.ChannelRow, adapters.channels.state);
    },

    async createOutlet(s: HotelScope, b: z.output<typeof hotel.createOutlet.body>) {
      const id = newId("hot");
      const staff = [...new Set(b.staffUserIds)];
      const members = await db.rows("SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = ANY($2::text[])", [
        s.orgId,
        staff,
      ]);
      if (members.length !== staff.length) throw fail.invalid("Outlet staff must be members of the organisation");
      await db.tx(async (t) => {
        if (await t.row("SELECT 1 FROM hotel_outlets WHERE property_id = $1 AND code = $2", [s.property.id, b.code]))
          throw fail.conflict(`Outlet ${b.code} already exists`);
        await t.run(
          "INSERT INTO hotel_outlets (id, org_id, property_id, code, name, department, staff_user_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [id, s.orgId, s.property.id, b.code, b.name, b.department, staff],
        );
        // outlet staff work at this hotel
        await assignToProperty(t, s.orgId, s.property.id, staff);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Outlet added", target: id, detail: b.name });
      });
      return repo.toOutlet(
        (await db.row<repo.OutletRow>("SELECT * FROM hotel_outlets WHERE id = $1", [id])) as repo.OutletRow,
      );
    },

    // ---------------------------------------------------------------- company accounts and city ledger
    async listCorporateAccounts(s: OrgScope) {
      const ids = await db.rows<{ id: string }>(
        "SELECT id FROM hotel_corporate_accounts WHERE org_id = $1 ORDER BY name",
        [s.orgId],
      );
      const accounts = [];
      for (const { id } of ids) accounts.push(await corporateAccount(db, s.orgId, id, s.today));
      return { accounts };
    },

    async createCorporateAccount(s: OrgScope, b: z.output<typeof hotel.createCorporateAccount.body>) {
      const id = newId("hca");
      await db.tx(async (t) => {
        if (
          await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND lower(name) = lower($2)", [
            s.orgId,
            b.name,
          ])
        )
          throw fail.conflict("A company account with this name already exists");
        await t.run(
          `INSERT INTO hotel_corporate_accounts (id, org_id, name, kind, credit_limit_minor, contact_email, tax_id,
             billing_address, payment_terms_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            s.orgId,
            b.name,
            b.kind,
            b.creditLimitMinor,
            b.contactEmail ?? null,
            b.taxId ?? null,
            b.billingAddress ?? null,
            b.paymentTermsDays,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Company account added",
          target: id,
          detail: `${b.name} · credit limit ${b.creditLimitMinor}`,
        });
      });
      return corporateAccount(db, s.orgId, id, s.today);
    },

    async statement(s: OrgScope, id: string) {
      const account = await corporateAccount(db, s.orgId, id, s.today);
      const rows = await db.rows<{
        id: string;
        number: string;
        date: string;
        kind: "invoice" | "payment";
        amount_minor: number;
        folio_id: string | null;
        reference: string;
      }>("SELECT * FROM hotel_city_ledger WHERE account_id = $1 ORDER BY date, number", [id]);
      return {
        account,
        entries: rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          kind: r.kind,
          amountMinor: r.amount_minor,
          folioId: r.folio_id,
          reference: r.reference,
        })),
      };
    },

    async cityLedgerPayment(s: HotelScope, accountId: string, b: z.output<typeof hotel.cityLedgerPayment.body>) {
      await db.tx(async (t) => {
        const date = await lockBusinessDate(t, s);
        // the account row is locked (as the city-ledger transfer at check-out does) before what it owes is read
        await t.run("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2 FOR UPDATE", [
          s.orgId,
          accountId,
        ]);
        const before = await corporateAccount(t, s.orgId, accountId, s.today);
        if (b.amountMinor > before.balanceMinor)
          throw fail.invalid(`The account owes ${before.balanceMinor}; record at most that amount`);
        const id = newId("hcl");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date,
          kind: "city_ledger_payment",
          memo: `City ledger payment from ${before.name} (${b.method}, ref ${b.reference}) — recorded, not processed`,
          ref: `city-payment:${id}`,
          lines: [dr(ACC.bank, b.amountMinor), cr(ACC.cityLedger, b.amountMinor)],
        });
        await t.run(
          `INSERT INTO hotel_city_ledger (id, org_id, property_id, account_id, number, kind, date, amount_minor, reference, journal_id,
             created_by, method, bank_reference)
           VALUES ($1,$2,$3,$4,$5,'payment',$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            s.orgId,
            s.property.id,
            accountId,
            await nextNumber(t, s.orgId, "CLP", 5),
            date,
            b.amountMinor,
            `${b.method}: ${b.reference}`,
            journalId,
            s.userId,
            b.method,
            b.reference,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "City ledger payment recorded",
          target: accountId,
          detail: `${b.amountMinor} by ${b.method} (${b.reference})`,
        });
      });
      return corporateAccount(db, s.orgId, accountId, s.today);
    },

    // ---------------------------------------------------------------- guests
    async listGuests(s: OrgScope, q: string) {
      const like = `%${q.toLowerCase()}%`;
      const rows = await db.rows<repo.GuestRow>(
        `${repo.GUEST_SELECT} WHERE g.org_id = $1 AND (lower(g.name) LIKE $2 OR lower(g.email) LIKE $2 OR g.phone LIKE $2
           OR lower(g.id_number) = lower($3)) ORDER BY g.name LIMIT 50`,
        [s.orgId, like, q],
      );
      return { guests: rows.map(repo.toGuest) };
    },

    async updateGuest(s: OrgScope, id: string, b: z.output<typeof hotel.updateGuest.body>) {
      const before = await db.row<repo.GuestRow>(`${repo.GUEST_SELECT} WHERE g.org_id = $1 AND g.id = $2`, [
        s.orgId,
        id,
      ]);
      if (!before) throw fail.notFound("Guest not found");
      await db.tx(async (t) => {
        await t.run(
          `UPDATE hotel_guests SET preferences = COALESCE($3, preferences), vip = COALESCE($4, vip), notes = COALESCE($5, notes),
             marketing_consent = COALESCE($6, marketing_consent),
             allergy_consent = COALESCE($7, allergy_consent),
             allergies = CASE WHEN $8::boolean THEN $9 WHEN $7::boolean IS FALSE THEN NULL ELSE allergies END
           WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            id,
            b.preferences ? JSON.stringify(b.preferences) : null,
            b.vip ?? null,
            b.notes ?? null,
            b.marketingConsent ?? null,
            b.allergyConsent ?? null,
            b.allergies !== undefined,
            b.allergies ?? null,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guest profile changed",
          target: id,
          detail: Object.keys(b).join(", "),
        });
      });
      return repo.toGuest(
        (await db.row<repo.GuestRow>(`${repo.GUEST_SELECT} WHERE g.org_id = $1 AND g.id = $2`, [
          s.orgId,
          id,
        ])) as repo.GuestRow,
      );
    },
  };
}

export type SetupService = ReturnType<typeof setupService>;
