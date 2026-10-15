/*
 * Revenue management from the hotel's own bookings — rules, clearly labelled; no external AI, no competitor feed
 * (rate shopping stays BLOCKED behind its adapter):
 *   on the books   rooms sold + held in the ONE inventory record for the night
 *   pickup 7d      room nights for the night booked in the last 7 days
 *   pace vs LY     on the books now vs on the books for the same weekday a year earlier (364 days) at the same lead
 *                  time (bookings made by then and not cancelled by then)
 *   expected       the average pickup still to come at this lead time over the last 28 nights (none without history)
 *   suggestion     forecast occupancy ≥ 90 % +15 %, ≥ 80 % +10 %, ≥ 70 % +5 %, < 30 % −10 %, < 45 % −5 %; pace 10
 *                  rooms or more ahead of last year +5 %, behind −5 %. Applying it writes a one-night BAR season.
 * Group displacement: the transient room revenue a block would push out (forecast demand at BAR) vs its revenue.
 * Corporate sales: RFPs accepted into the company's corporate rate plan for the season; production per account.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { addDays, daysBetween, nightsOf } from "../shared/dates.js";
import { ensureInventory, queueAri } from "../shared/inventory.js";
import { loadRateBook, priceFor, type RateBook } from "../shared/rates.js";
import { roomTypes } from "../setup/setup.repo.js";

const METHOD =
  "Rules from the hotel's own bookings: forecast = rooms on the books + average pickup still to come at this lead time (last 28 nights); suggestion bands by forecast occupancy and pace vs last year. No external AI or competitor data.";

/** Rooms booked for a night (stays covering it) as they stood at the end of `asOf`. */
const OTB_AT = `SELECT count(*)::int AS n FROM hotel_stays s JOIN hotel_reservations r ON r.id = s.reservation_id
  WHERE s.property_id = $1 AND s.arrival <= $2 AND s.departure > $2 AND r.created_at::date <= $3
    AND s.status <> 'waitlisted'
    AND (s.status NOT IN ('cancelled', 'no_show') OR s.cancelled_at::date > $3)`;

export function suggestionFor(occPct: number, paceDelta: number): { pct: number; reason: string } {
  let pct = occPct >= 90 ? 15 : occPct >= 80 ? 10 : occPct >= 70 ? 5 : occPct < 30 ? -10 : occPct < 45 ? -5 : 0;
  const reasons = [`forecast occupancy ${occPct}%`];
  if (paceDelta >= 10) {
    pct += 5;
    reasons.push(`pace ${paceDelta} room(s) ahead of last year`);
  } else if (paceDelta <= -10) {
    pct -= 5;
    reasons.push(`pace ${-paceDelta} room(s) behind last year`);
  }
  return { pct, reason: pct === 0 ? `Hold — ${reasons.join(", ")}` : reasons.join(", ") };
}

const round100 = (n: number) => Math.max(100, Math.round(n / 100) * 100);

export function revenueService(d: HotelDeps) {
  const { db } = d.core;

  /** Average rooms still picked up after `lead` days before arrival, over the last 28 nights (0 without history). */
  async function expectedPickup(t: Db, s: HotelScope, lead: number, cache: Map<number, number>): Promise<number> {
    const hit = cache.get(lead);
    if (hit !== undefined) return hit;
    const bd = s.property.business_date;
    let sum = 0;
    let nights = 0;
    for (let k = 1; k <= 28; k++) {
      const night = addDays(bd, -k);
      const final = await t.row<{ n: number }>(
        `SELECT count(*)::int AS n FROM hotel_stays WHERE property_id = $1 AND arrival <= $2 AND departure > $2
           AND status IN ('in_house', 'checked_out')`,
        [s.property.id, night],
      );
      if (!final?.n) continue;
      const before = await t.row<{ n: number }>(OTB_AT, [s.property.id, night, addDays(night, -lead)]);
      sum += Math.max(0, final.n - (before?.n ?? 0));
      nights++;
    }
    const v = nights ? Math.round(sum / nights) : 0;
    cache.set(lead, v);
    return v;
  }

  async function forecastDays(t: Db, s: HotelScope, from: string, to: string) {
    const bd = s.property.business_date;
    for (const rt of await roomTypes(t, s.property.id))
      await ensureInventory(t, s.orgId, s.property.id, rt.id, from, addDays(to, 1));
    const cache = new Map<number, number>();
    const out = [];
    for (const date of nightsOf(from, addDays(to, 1))) {
      const inv = await t.row<{ capacity: number; otb: number }>(
        `SELECT COALESCE(sum(total - ooo), 0)::int AS capacity, COALESCE(sum(sold + held), 0)::int AS otb
         FROM hotel_inventory WHERE property_id = $1 AND date = $2`,
        [s.property.id, date],
      );
      const capacity = inv?.capacity ?? 0;
      const otb = inv?.otb ?? 0;
      const pick = await t.row<{ n: number }>(
        `SELECT count(*)::int AS n FROM hotel_stays s JOIN hotel_reservations r ON r.id = s.reservation_id
         WHERE s.property_id = $1 AND s.arrival <= $2 AND s.departure > $2 AND s.status IN ('reserved', 'in_house', 'checked_out')
           AND r.created_at::date > $3::date - 7`,
        [s.property.id, date, bd],
      );
      const lead = Math.max(0, daysBetween(bd, date));
      const ly = await t.row<{ n: number }>(OTB_AT, [s.property.id, addDays(date, -364), addDays(bd, -364)]);
      const expected = date >= bd ? await expectedPickup(t, s, lead, cache) : 0;
      const forecast = Math.min(capacity, otb + expected);
      const occ = (n: number) => (capacity > 0 ? Math.round((n / capacity) * 10_000) / 100 : 0);
      const paceDelta = otb - (ly?.n ?? 0);
      const sug = suggestionFor(occ(forecast), (ly?.n ?? 0) > 0 ? paceDelta : 0);
      out.push({
        date,
        capacity,
        onTheBooks: otb,
        occupancyPct: occ(otb),
        pickup7d: pick?.n ?? 0,
        lastYearSameLeadTime: ly?.n ?? 0,
        paceDelta,
        expectedPickup: expected,
        forecastRooms: forecast,
        forecastOccupancyPct: occ(forecast),
        suggestedChangePct: sug.pct,
        reason: sug.reason,
      });
    }
    return out;
  }

  const barOf = (book: RateBook) => [...book.plans.values()].find((p) => p.kind === "bar" && p.active) ?? null;

  async function suggestions(t: Db, s: HotelScope, from: string, to: string) {
    const days = await forecastDays(t, s, from, to);
    const book = await loadRateBook(t, s.property.id);
    const bar = barOf(book);
    if (!bar) return [];
    const applied = await t.rows<{ date: string; room_type_id: string }>(
      "SELECT date, room_type_id FROM hotel_rate_suggestions WHERE property_id = $1 AND date BETWEEN $2 AND $3",
      [s.property.id, from, to],
    );
    const out: hotel.RateSuggestionOut[] = [];
    for (const day of days)
      for (const rt of await roomTypes(t, s.property.id)) {
        const current = priceFor(book, bar.id, rt.id, day.date);
        if (current == null) continue;
        const done = applied.some((a) => a.date === day.date && a.room_type_id === rt.id);
        out.push({
          date: day.date,
          roomTypeId: rt.id,
          ratePlanId: bar.id,
          currentMinor: current,
          suggestedMinor:
            done || !day.suggestedChangePct ? current : round100(current * (1 + day.suggestedChangePct / 100)),
          changePct: done ? 0 : day.suggestedChangePct,
          forecastOccupancyPct: day.forecastOccupancyPct,
          reason: done ? "Applied" : day.reason,
          applied: done,
        });
      }
    return out;
  }

  return {
    async forecast(s: HotelScope, from: string, to: string) {
      if (daysBetween(from, to) > 92) throw fail.invalid("Forecast at most 93 nights at a time");
      return db.tx(async (t) => {
        const days = await forecastDays(t, s, from, to);
        const segments = await t.rows<{ source: string; nights: number; revenue: number }>(
          `SELECT r.source, count(*)::int AS nights, COALESCE(sum(n.rate_minor), 0)::bigint AS revenue
           FROM hotel_stay_nights n JOIN hotel_stays s ON s.id = n.stay_id JOIN hotel_reservations r ON r.id = s.reservation_id
           WHERE s.property_id = $1 AND n.date BETWEEN $2 AND $3 AND s.status IN ('reserved', 'in_house', 'checked_out')
           GROUP BY r.source ORDER BY r.source`,
          [s.property.id, from, to],
        );
        return {
          days,
          segments: segments.map((x) => ({ source: x.source, roomNights: x.nights, revenueMinor: x.revenue })),
          competitorRates: d.adapters.rateShopping.state,
          method: METHOD,
        };
      });
    },

    async pickup(s: HotelScope, q: { bookedFrom: string; bookedTo: string; stayFrom: string; stayTo: string }) {
      const rows = await db.rows<{ date: string; booked: number; cancelled: number }>(
        `SELECT n.date,
           count(*) FILTER (WHERE r.created_at::date BETWEEN $2 AND $3)::int AS booked,
           count(*) FILTER (WHERE s.cancelled_at::date BETWEEN $2 AND $3)::int AS cancelled
         FROM hotel_stay_nights n JOIN hotel_stays s ON s.id = n.stay_id JOIN hotel_reservations r ON r.id = s.reservation_id
         WHERE s.property_id = $1 AND n.date BETWEEN $4 AND $5 AND s.status <> 'waitlisted'
         GROUP BY n.date ORDER BY n.date`,
        [s.property.id, q.bookedFrom, q.bookedTo, q.stayFrom, q.stayTo],
      );
      const days = rows
        .filter((r) => r.booked || r.cancelled)
        .map((r) => ({ date: r.date, booked: r.booked, cancelled: r.cancelled, net: r.booked - r.cancelled }));
      const sum = (k: "booked" | "cancelled" | "net") => days.reduce((n, x) => n + x[k], 0);
      return { days, totals: { booked: sum("booked"), cancelled: sum("cancelled"), net: sum("net") } };
    },

    async suggestions(s: HotelScope, from: string, to: string) {
      if (daysBetween(from, to) > 62) throw fail.invalid("Ask for at most 63 nights at a time");
      return { suggestions: await db.tx((t) => suggestions(t, s, from, to)), method: METHOD };
    },

    async apply(s: HotelScope, date: string, roomTypeId: string) {
      if (date < s.property.business_date) throw fail.invalid("That night has passed");
      return db.tx(async (t) => {
        const sug = (await suggestions(t, s, date, date)).find((x) => x.roomTypeId === roomTypeId);
        if (!sug) throw fail.notFound("No BAR price for that room type and night");
        if (sug.applied) throw fail.conflict("A suggestion is already applied to that night");
        if (!sug.changePct) throw fail.conflict("The suggestion is to hold the rate — nothing to apply");
        await t.run(
          `INSERT INTO hotel_rate_seasons (id, rate_plan_id, room_type_id, name, date_from, date_to, amount_minor)
           VALUES ($1,$2,$3,$4,$5,$5,$6)`,
          [newId("hrs"), sug.ratePlanId, roomTypeId, `Revenue management ${date}`, date, sug.suggestedMinor],
        );
        await t.run(
          `INSERT INTO hotel_rate_suggestions (id, org_id, property_id, date, room_type_id, rate_plan_id, current_minor,
             suggested_minor, change_bp, reason, applied_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            newId("hsg"),
            s.orgId,
            s.property.id,
            date,
            roomTypeId,
            sug.ratePlanId,
            sug.currentMinor,
            sug.suggestedMinor,
            Math.round(sug.changePct * 100),
            sug.reason,
            s.userId,
          ],
        );
        await queueAri(t, d.adapters, await loadRateBook(t, s.property.id), {
          orgId: s.orgId,
          propertyId: s.property.id,
          roomTypeId,
          from: date,
          to: addDays(date, 1),
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Rate suggestion applied",
          target: `${roomTypeId}:${date}`,
          detail: `${sug.currentMinor} → ${sug.suggestedMinor} (${sug.changePct}%: ${sug.reason})`,
        });
        return { ...sug, applied: true };
      });
    },

    async displacement(s: HotelScope, b: z.output<typeof hotel.displacement.body>) {
      return db.tx(async (t) => {
        const days = await forecastDays(t, s, b.arrival, addDays(b.departure, -1));
        const book = await loadRateBook(t, s.property.id);
        const bar = barOf(book);
        if (!bar) throw fail.conflict("Set up a best available rate (BAR) plan first");
        const nights = [];
        for (const day of days) {
          const inv = await t.row<{ total: number; ooo: number; sold: number; held: number }>(
            "SELECT total, ooo, sold, held FROM hotel_inventory WHERE room_type_id = $1 AND date = $2",
            [b.roomTypeId, day.date],
          );
          if (!inv) throw fail.notFound("Room type not found");
          const capacity = inv.total - inv.ooo;
          if (b.roomsPerNight > capacity)
            throw fail.conflict(`Only ${capacity} room(s) of this type exist on ${day.date}`);
          const share = day.capacity > 0 ? capacity / day.capacity : 0;
          const transient = Math.min(capacity, inv.sold + inv.held + Math.round(day.expectedPickup * share));
          const displaced = Math.max(0, transient + b.roomsPerNight - capacity);
          const rate = priceFor(book, bar.id, b.roomTypeId, day.date) ?? 0;
          nights.push({
            date: day.date,
            capacity,
            forecastTransient: transient,
            displacedRooms: displaced,
            transientRateMinor: rate,
            groupRevenueMinor: b.roomsPerNight * b.groupRateMinor,
            displacedRevenueMinor: displaced * rate,
          });
        }
        const group = nights.reduce((n, x) => n + x.groupRevenueMinor, 0);
        const lost = nights.reduce((n, x) => n + x.displacedRevenueMinor, 0);
        return {
          nights,
          groupRevenueMinor: group,
          displacedRevenueMinor: lost,
          netGainMinor: group - lost,
          recommendation: group - lost > 0 ? ("accept" as const) : ("negotiate" as const),
          method:
            "Rules: transient demand = rooms on the books + expected pickup (own history); displaced rooms valued at today's BAR",
        };
      });
    },

    // ---------------------------------------------------------------- corporate RFPs and production
    async listRfps(s: HotelScope) {
      const rows = await db.rows<RfpRow>("SELECT * FROM hotel_rfps WHERE property_id = $1 ORDER BY number", [
        s.property.id,
      ]);
      return { rfps: rows.map(toRfp) };
    },

    async createRfp(s: HotelScope, b: z.output<typeof hotel.createRfp.body>) {
      const id = newId("hrf");
      await db.tx(async (t) => {
        if (
          !(await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [
            s.orgId,
            b.corporateAccountId,
          ]))
        )
          throw fail.invalid("Unknown company account");
        const known = new Set((await roomTypes(t, s.property.id)).map((r) => r.id));
        if (b.rates.some((r) => !known.has(r.roomTypeId))) throw fail.invalid("Unknown room type for this hotel");
        if (new Set(b.rates.map((r) => r.roomTypeId)).size !== b.rates.length)
          throw fail.invalid("One rate per room type");
        const number = await nextNumber(t, s.orgId, "RFP", 5);
        await t.run(
          `INSERT INTO hotel_rfps (id, org_id, property_id, number, corporate_account_id, season_from, season_to, rates,
             expected_room_nights, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            s.orgId,
            s.property.id,
            number,
            b.corporateAccountId,
            b.seasonFrom,
            b.seasonTo,
            JSON.stringify(b.rates),
            b.expectedRoomNights,
            s.userId,
          ],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Corporate RFP recorded", target: number });
      });
      return toRfp((await db.row<RfpRow>("SELECT * FROM hotel_rfps WHERE id = $1", [id])) as RfpRow);
    },

    async decideRfp(s: HotelScope, id: string, b: { decision: "accepted" | "declined"; reason: string }) {
      await db.tx(async (t) => {
        const r = await t.row<RfpRow>("SELECT * FROM hotel_rfps WHERE property_id = $1 AND id = $2 FOR UPDATE", [
          s.property.id,
          id,
        ]);
        if (!r) throw fail.notFound("RFP not found");
        if (r.status !== "submitted") throw fail.conflict(`RFP ${r.number} is already ${r.status}`);
        let planId: string | null = null;
        if (b.decision === "accepted") {
          planId = newId("hrp");
          await t.run(
            `INSERT INTO hotel_rate_plans (id, org_id, property_id, code, name, kind, refundable, free_cancel_days,
               cancel_fee_nights, no_show_fee_nights, corporate_account_id)
             VALUES ($1,$2,$3,$4,$5,'corporate',true,1,1,1,$6)`,
            [planId, s.orgId, s.property.id, r.number, `Corporate rate ${r.number}`, r.corporate_account_id],
          );
          // the negotiated rates hold for the season only: outside it the plan has no price
          for (const x of r.rates)
            await t.run(
              `INSERT INTO hotel_rate_seasons (id, rate_plan_id, room_type_id, name, date_from, date_to, amount_minor)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [newId("hrs"), planId, x.roomTypeId, `RFP ${r.number}`, r.season_from, r.season_to, x.amountMinor],
            );
        }
        await t.run(
          "UPDATE hotel_rfps SET status = $2, rate_plan_id = $3, decided_by = $4, decision_reason = $5 WHERE id = $1",
          [id, b.decision, planId, s.userId, b.reason],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: `Corporate RFP ${b.decision}`,
          target: r.number,
          detail: b.reason,
        });
      });
      return toRfp((await db.row<RfpRow>("SELECT * FROM hotel_rfps WHERE id = $1", [id])) as RfpRow);
    },

    async production(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<{
        id: string;
        name: string;
        kind: "company" | "travel_agent";
        reservations: number;
        nights: number;
        revenue: number;
      }>(
        `SELECT a.id, a.name, a.kind,
           (SELECT count(DISTINCT r.id)::int FROM hotel_reservations r JOIN hotel_stays st ON st.reservation_id = r.id
             WHERE r.property_id = $1 AND r.corporate_account_id = a.id AND st.arrival <= $3 AND st.departure > $2
               AND st.status IN ('reserved', 'in_house', 'checked_out')) AS reservations,
           (SELECT count(*)::int FROM hotel_folio_lines l JOIN hotel_stays st ON st.id = l.stay_id
              JOIN hotel_reservations r ON r.id = st.reservation_id
             WHERE r.property_id = $1 AND r.corporate_account_id = a.id AND l.kind = 'charge' AND l.night_date BETWEEN $2 AND $3
               AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)) AS nights,
           COALESCE((SELECT sum(l.net_minor) FROM hotel_folio_lines l JOIN hotel_stays st ON st.id = l.stay_id
              JOIN hotel_reservations r ON r.id = st.reservation_id
             WHERE r.property_id = $1 AND r.corporate_account_id = a.id AND l.kind = 'charge' AND l.night_date BETWEEN $2 AND $3
               AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines v WHERE v.voids_line_id = l.id)), 0)::bigint AS revenue
         FROM hotel_corporate_accounts a WHERE a.org_id = $4 ORDER BY a.name`,
        [s.property.id, from, to, s.orgId],
      );
      return {
        accounts: rows
          .filter((r) => r.reservations || r.nights)
          .map((r) => ({
            accountId: r.id,
            name: r.name,
            kind: r.kind,
            reservations: r.reservations,
            roomNights: r.nights,
            roomRevenueMinor: r.revenue,
            adrMinor: r.nights ? Math.round(r.revenue / r.nights) : 0,
          })),
      };
    },
  };
}

interface RfpRow {
  id: string;
  number: string;
  corporate_account_id: string;
  season_from: string;
  season_to: string;
  rates: { roomTypeId: string; amountMinor: number }[];
  expected_room_nights: number;
  status: "submitted" | "accepted" | "declined";
  rate_plan_id: string | null;
  decided_by: string | null;
  decision_reason: string | null;
}

const toRfp = (r: RfpRow): hotel.RfpOut => ({
  id: r.id,
  number: r.number,
  corporateAccountId: r.corporate_account_id,
  seasonFrom: r.season_from,
  seasonTo: r.season_to,
  rates: r.rates,
  expectedRoomNights: r.expected_room_nights,
  status: r.status,
  ratePlanId: r.rate_plan_id,
  decidedBy: r.decided_by,
  decisionReason: r.decision_reason,
});

export type RevenueService = ReturnType<typeof revenueService>;
