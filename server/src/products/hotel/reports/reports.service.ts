/*
 * Hotel KPIs and reports, all computed from the ledger postings of the hotel (figures.ts):
 *   Occupancy = rooms sold ÷ rooms available; ADR = room revenue ÷ rooms sold; RevPAR = room revenue ÷ rooms
 *   available; TRevPAR = total revenue ÷ rooms available; GOP = revenue − departmental and undistributed costs
 *   (by the hotel's USALI-style account mapping); GOPPAR = GOP ÷ rooms available; cost per occupied room = rooms
 *   department costs ÷ rooms sold.
 * Group views exist only for organisations with two or more hotels.
 */
import type { hotel, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, REVENUE_ACCOUNT } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import { assignedProperties, type HotelScope } from "../shared/access.js";
import { availabilityOf } from "../shared/inventory.js";
import { findProperty, listPropertyRows, type PropertyRow } from "../shared/property.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { loadRateBook } from "../shared/rates.js";
import { roomTypes } from "../setup/setup.repo.js";
import * as F from "./figures.js";

const DEPT_NAMES = {
  rooms: "Rooms",
  fnb: "Food and beverage",
  spa: "Spa and activities",
  other: "Other operated departments",
};

export function reportsService(d: HotelDeps) {
  const { core } = d;
  const { db } = core;

  async function kpis(
    t: Db,
    p: PropertyRow,
    from: string,
    to: string,
  ): Promise<hotel.Kpis & { roomsCostsMinor: number }> {
    const totals = await F.ledgerTotals(t, p.id, from, to);
    const revenue = F.revenueOf(totals);
    const sold = await F.roomsSold(t, p.id, from, to);
    const available = await F.roomsAvailable(t, p.id, from, to);
    const cost = (codes: string[]) => codes.reduce((n, c) => n + totals.net(c), 0);
    const roomsCosts = cost(p.usali.rooms.costs);
    const costs =
      roomsCosts +
      cost(p.usali.fnb.costs) +
      cost(p.usali.spa.costs) +
      cost(p.usali.other.costs) +
      cost(p.usali.undistributed.costs);
    const gop = revenue.total - costs;
    return {
      from,
      to,
      currency: p.currency,
      roomsAvailable: available,
      roomsSold: sold,
      ...F.ratios({ roomRevenue: revenue.rooms, totalRevenue: revenue.total, sold, available }),
      gopMinor: gop,
      gopparMinor: available > 0 ? Math.round(gop / available) : 0,
      costPerOccupiedRoomMinor: sold > 0 ? Math.round(roomsCosts / sold) : 0,
      revenue,
      roomsCostsMinor: roomsCosts,
    };
  }

  async function dailyReport(t: Db, p: PropertyRow, date: string): Promise<hotel.DailyReport> {
    const totals = await F.ledgerTotals(t, p.id, date, date);
    const revenue = F.revenueOf(totals);
    const folioRevenue = await F.folioRevenue(t, p.id, date, date);
    const sold = await F.roomsSold(t, p.id, date, date);
    const available = await F.roomsAvailable(t, p.id, date, date);
    const count = async (sql: string) => (await t.row<{ n: number }>(sql, [p.id, date]))?.n ?? 0;
    return {
      propertyId: p.id,
      businessDate: date,
      currency: p.currency,
      roomsAvailable: available,
      roomsSold: sold,
      outOfOrder: await F.outOfOrder(t, p.id, date, date),
      ...F.ratios({ roomRevenue: revenue.rooms, totalRevenue: revenue.total, sold, available }),
      revenue,
      folioRevenue,
      reconciled: (Object.keys(revenue) as (keyof F.DeptAmounts)[]).every((k) => revenue[k] === folioRevenue[k]),
      taxes: {
        vat: totals.credit(ACC.vat),
        serviceCharge: totals.credit(ACC.serviceCharge),
        levy: totals.credit(ACC.levy),
      },
      payments: await F.paymentsByMethod(t, p.id, date, date),
      depositsReceivedMinor: await F.depositsReceived(t, p.id, date, date),
      arrivals: await count(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE property_id = $1 AND arrival = $2 AND status IN ('in_house', 'checked_out')",
      ),
      departures: await count(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE property_id = $1 AND status = 'checked_out' AND checked_out_at IS NOT NULL AND departure = $2",
      ),
      noShows: await count(
        "SELECT count(*)::int AS n FROM hotel_stays WHERE property_id = $1 AND status = 'no_show' AND arrival = $2",
      ),
      distribution: "Stored for the managers — not e-mailed (no e-mail provider connected)",
    };
  }

  async function groupProperties(s: OrgScope): Promise<PropertyRow[]> {
    const all = await listPropertyRows(db, s.orgId);
    if (all.length < 2) throw fail.notFound("Group views are for organisations with two or more hotels");
    const allowed = await assignedProperties(db, s);
    return all.filter((p) => !allowed || allowed.includes(p.id));
  }

  return {
    kpis,
    dailyReport,

    async getKpis(s: HotelScope, from: string, to: string) {
      return kpis(db, s.property, from, to);
    },

    async flash(s: HotelScope, date: string) {
      const r = await dailyReport(db, s.property, date);
      return {
        date,
        currency: r.currency,
        revenue: r.revenue,
        occupancyPct: r.occupancyPct,
        adrMinor: r.adrMinor,
        revparMinor: r.revparMinor,
        payments: r.payments,
        depositsReceivedMinor: r.depositsReceivedMinor,
      };
    },

    async pnl(s: HotelScope, from: string, to: string) {
      const p = s.property;
      const totals = await F.ledgerTotals(db, p.id, from, to);
      const names = new Map((await core.ledger.listAccounts(s.orgId)).accounts.map((a) => [a.code, a.name]));
      const line = (code: string, amount: number) => ({ code, name: names.get(code) ?? code, amountMinor: amount });
      const departments = (["rooms", "fnb", "spa", "other"] as const).map((key) => {
        const m = p.usali[key];
        const revenue = m.revenue.map((c) => line(c, totals.credit(c)));
        const costs = m.costs.map((c) => line(c, totals.net(c)));
        const revenueMinor = revenue.reduce((n, a) => n + a.amountMinor, 0);
        const costsMinor = costs.reduce((n, a) => n + a.amountMinor, 0);
        return {
          key,
          name: DEPT_NAMES[key],
          revenueMinor,
          costsMinor,
          profitMinor: revenueMinor - costsMinor,
          accounts: [...revenue, ...costs],
        };
      });
      const undistributed = p.usali.undistributed.costs.map((c) => line(c, totals.net(c)));
      const undistributedMinor = undistributed.reduce((n, a) => n + a.amountMinor, 0);
      const totalRevenue = departments.reduce((n, x) => n + x.revenueMinor, 0);
      const gop = departments.reduce((n, x) => n + x.profitMinor, 0) - undistributedMinor;
      const available = await F.roomsAvailable(db, p.id, from, to);
      return {
        from,
        to,
        currency: p.currency,
        departments,
        undistributed: { costsMinor: undistributedMinor, accounts: undistributed },
        totalRevenueMinor: totalRevenue,
        gopMinor: gop,
        gopparMinor: available > 0 ? Math.round(gop / available) : 0,
        roomsAvailable: available,
      };
    },

    async channels(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<{
        channel_id: string | null;
        kind: string;
        code: string;
        dr: number;
        cr: number;
        n: number;
      }>(
        `SELECT k.channel_id, k.kind, l.account_code AS code, sum(l.debit_minor)::bigint AS dr, sum(l.credit_minor)::bigint AS cr,
           count(DISTINCT k.journal_id)::int AS n
         FROM hotel_ledger_links k
         JOIN journal_entries e ON e.id = k.journal_id AND e.status = 'posted'
         JOIN journal_lines l ON l.entry_id = e.id
         WHERE k.property_id = $1 AND k.business_date BETWEEN $2 AND $3 AND k.kind IN ('room_night', 'commission')
           AND l.account_code IN ($4, $5)
         GROUP BY k.channel_id, k.kind, l.account_code`,
        [s.property.id, from, to, REVENUE_ACCOUNT.rooms, ACC.commissions],
      );
      const channels = await db.rows<{ id: string; name: string }>(
        "SELECT id, name FROM hotel_channels WHERE property_id = $1 ORDER BY code",
        [s.property.id],
      );
      const out = [{ id: null as string | null, name: "Direct" }, ...channels].map((c) => {
        const mine = rows.filter((r) => r.channel_id === c.id);
        const revenue = mine.filter((r) => r.code === REVENUE_ACCOUNT.rooms).reduce((n, r) => n + r.cr - r.dr, 0);
        const commission = mine.filter((r) => r.code === ACC.commissions).reduce((n, r) => n + r.dr - r.cr, 0);
        const nights = mine
          .filter((r) => r.kind === "room_night" && r.code === REVENUE_ACCOUNT.rooms)
          .reduce((n, r) => n + r.n, 0);
        return {
          channelId: c.id,
          name: c.name,
          roomNights: nights,
          roomRevenueMinor: revenue,
          commissionMinor: commission,
          netMinor: revenue - commission,
        };
      });
      return { channels: out };
    },

    async postCost(s: HotelScope, b: z.output<typeof hotel.postCost.body>) {
      const id = newId("hcs");
      return db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "cost",
          memo: `${s.property.name} · ${b.memo}`,
          ref: `cost:${id}`,
          lines: [dr(b.account, b.amountMinor), cr(b.paidFrom === "bank" ? ACC.bank : ACC.payables, b.amountMinor)],
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Hotel cost posted",
          target: journalId,
          detail: `${b.account} · ${b.amountMinor} · ${b.memo}`,
        });
        return { journalId, date: s.property.business_date };
      });
    },

    async groupAvailability(s: OrgScope, from: string, to: string) {
      const properties = [];
      for (const p of await groupProperties(s)) {
        const book = await loadRateBook(db, p.id);
        const types = [];
        for (const rt of await roomTypes(db, p.id)) {
          const days = await availabilityOf(
            db,
            { orgId: s.orgId, propertyId: p.id, roomTypeId: rt.id, from, to },
            book,
            null,
          );
          types.push({
            roomTypeId: rt.id,
            code: rt.code,
            name: rt.name,
            available: days.length ? Math.min(...days.map((x) => x.available)) : 0,
          });
        }
        properties.push({
          propertyId: p.id,
          name: p.name,
          city: p.city,
          roomTypes: types,
          totalAvailable: types.reduce((n, x) => n + x.available, 0),
        });
      }
      return { properties };
    },

    async groupKpis(s: OrgScope, q: z.output<typeof hotel.groupKpis.query>) {
      const props = await groupProperties(s);
      const rows: {
        propertyId: string;
        name: string;
        kpis: Awaited<ReturnType<typeof kpis>>;
        baseFeeMinor: number;
        incentiveFeeMinor: number;
      }[] = [];
      for (const p of props) {
        const k = await kpis(db, await findProperty(db, s.orgId, p.id), q.from, q.to);
        const baseFee = Math.round((k.revenue.total * Math.round(q.baseFeePct * 100)) / 10_000);
        const incentiveFee =
          k.gopMinor > 0 ? Math.round((k.gopMinor * Math.round(q.incentiveFeePct * 100)) / 10_000) : 0;
        rows.push({ propertyId: p.id, name: p.name, kpis: k, baseFeeMinor: baseFee, incentiveFeeMinor: incentiveFee });
      }
      const sum = (f: (k: hotel.Kpis) => number) => rows.reduce((n, r) => n + f(r.kpis), 0);
      const revenue = {
        rooms: sum((k) => k.revenue.rooms),
        fnb: sum((k) => k.revenue.fnb),
        spa: sum((k) => k.revenue.spa),
        other: sum((k) => k.revenue.other),
        noshow: sum((k) => k.revenue.noshow),
        total: sum((k) => k.revenue.total),
      };
      const sold = sum((k) => k.roomsSold);
      const available = sum((k) => k.roomsAvailable);
      const gop = sum((k) => k.gopMinor);
      const roomsCosts = rows.reduce((n, r) => n + r.kpis.roomsCostsMinor, 0);
      return {
        properties: rows,
        consolidated: {
          from: q.from,
          to: q.to,
          currency: props[0]?.currency ?? "",
          roomsAvailable: available,
          roomsSold: sold,
          ...F.ratios({ roomRevenue: revenue.rooms, totalRevenue: revenue.total, sold, available }),
          gopMinor: gop,
          gopparMinor: available > 0 ? Math.round(gop / available) : 0,
          costPerOccupiedRoomMinor: sold > 0 ? Math.round(roomsCosts / sold) : 0,
          revenue,
        },
        feesMinor: rows.reduce((n, r) => n + r.baseFeeMinor + r.incentiveFeeMinor, 0),
      };
    },
  };
}

export type ReportsService = ReturnType<typeof reportsService>;
