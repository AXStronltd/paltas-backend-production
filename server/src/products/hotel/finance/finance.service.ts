/*
 * Hotel finance from the ledger:
 *   - budgets and reforecasts per month by department, and the daily manager's report: the day, month to date and
 *     year to date — actual (ledger) vs budget (pro rata by days) and last year (the same dates a year earlier, from
 *     the ledger) — plus the month's forecast: actual room revenue to date + room revenue on the books;
 *   - fixed assets: bought today (fixed assets 1500 / bank, payables or the FF&E reserve fund 1020), straight-line
 *     depreciation per month posted once (depreciation 6100 / accumulated depreciation 1590), disposals with the gain
 *     (4900) or loss (6150);
 *   - the FF&E replacement reserve: each month a share of total revenue moves from the operating bank to the reserve
 *     fund (1020 / 1000), once per month; assets can be bought from it.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import * as F from "../reports/figures.js";
import type { ReportsService } from "../reports/reports.service.js";
import type { HotelScope } from "../shared/access.js";
import { daysBetween } from "../shared/dates.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { fromBp } from "../shared/property.js";

interface BudgetRow {
  month: string;
  kind: "budget" | "forecast";
  rooms_sold: number;
  rooms_minor: number;
  fnb_minor: number;
  spa_minor: number;
  other_minor: number;
  costs_minor: number;
}

interface AssetRow {
  id: string;
  number: string;
  name: string;
  category: hotel.FixedAssetOut["category"];
  acquired_on: string;
  cost_minor: number;
  residual_minor: number;
  life_months: number;
  funded_from: hotel.FixedAssetOut["fundedFrom"];
  status: "active" | "disposed";
  disposed_on: string | null;
  proceeds_minor: number | null;
  accumulated: number;
  months: number;
}

const toBudget = (b: BudgetRow): hotel.BudgetOut => {
  const total = b.rooms_minor + b.fnb_minor + b.spa_minor + b.other_minor;
  return {
    month: b.month,
    kind: b.kind,
    roomsSold: b.rooms_sold,
    revenue: { rooms: b.rooms_minor, fnb: b.fnb_minor, spa: b.spa_minor, other: b.other_minor, total },
    costsMinor: b.costs_minor,
    gopMinor: total - b.costs_minor,
  };
};

const toAsset = (a: AssetRow): hotel.FixedAssetOut => ({
  id: a.id,
  number: a.number,
  name: a.name,
  category: a.category,
  acquiredOn: a.acquired_on,
  costMinor: a.cost_minor,
  residualMinor: a.residual_minor,
  lifeMonths: a.life_months,
  fundedFrom: a.funded_from,
  status: a.status,
  accumulatedMinor: a.accumulated,
  netBookValueMinor: a.cost_minor - a.accumulated,
  disposedOn: a.disposed_on,
  proceedsMinor: a.proceeds_minor,
});

const ASSET_SELECT = `SELECT a.*,
  COALESCE((SELECT sum(amount_minor) FROM hotel_depreciation d WHERE d.asset_id = a.id), 0)::bigint AS accumulated,
  (SELECT count(*)::int FROM hotel_depreciation d WHERE d.asset_id = a.id) AS months
  FROM hotel_fixed_assets a`;

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const daysIn = (month: string) => Number(monthEnd(month).slice(8, 10));

/** The same calendar date a year earlier (29 February → 28 February). */
export function lastYear(date: string): string {
  const y = Number(date.slice(0, 4)) - 1;
  const md = date.slice(5);
  return md === "02-29" ? `${y}-02-28` : `${y}-${md}`;
}

export function financeService(d: HotelDeps, x: { reports: ReportsService }) {
  const { core } = d;
  const { db } = core;
  const { reports } = x;

  async function figures(t: Db, s: HotelScope, from: string, to: string) {
    const k = await reports.kpis(t, s.property, from, to);
    const fig = {
      roomsSold: k.roomsSold,
      occupancyPct: k.occupancyPct,
      adrMinor: k.adrMinor,
      revparMinor: k.revparMinor,
      revenue: {
        rooms: k.revenue.rooms + k.revenue.noshow,
        fnb: k.revenue.fnb,
        spa: k.revenue.spa,
        other: k.revenue.other,
        total: k.revenue.total,
      },
      gopMinor: k.gopMinor,
    };
    return { fig, available: k.roomsAvailable };
  }

  /** The budget of [from, to] (inside one year): whole months plus a share of a part month by days. */
  async function budgetFor(t: Db, s: HotelScope, from: string, to: string, available: number) {
    const rows = await t.rows<BudgetRow>(
      "SELECT * FROM hotel_budgets WHERE property_id = $1 AND kind = 'budget' AND month BETWEEN $2 AND $3",
      [s.property.id, from.slice(0, 7), to.slice(0, 7)],
    );
    if (!rows.length) return null;
    const sum = { rooms_sold: 0, rooms: 0, fnb: 0, spa: 0, other: 0, costs: 0 };
    for (const b of rows) {
      const start = b.month === from.slice(0, 7) ? from : `${b.month}-01`;
      const end = b.month === to.slice(0, 7) ? to : monthEnd(b.month);
      const share = (n: number) => Math.round((n * (daysBetween(start, end) + 1)) / daysIn(b.month));
      sum.rooms_sold += share(b.rooms_sold);
      sum.rooms += share(b.rooms_minor);
      sum.fnb += share(b.fnb_minor);
      sum.spa += share(b.spa_minor);
      sum.other += share(b.other_minor);
      sum.costs += share(b.costs_minor);
    }
    const total = sum.rooms + sum.fnb + sum.spa + sum.other;
    return {
      roomsSold: sum.rooms_sold,
      occupancyPct: available > 0 ? Math.round((sum.rooms_sold / available) * 10_000) / 100 : 0,
      adrMinor: sum.rooms_sold > 0 ? Math.round(sum.rooms / sum.rooms_sold) : 0,
      revparMinor: available > 0 ? Math.round(sum.rooms / available) : 0,
      revenue: { rooms: sum.rooms, fnb: sum.fnb, spa: sum.spa, other: sum.other, total },
      gopMinor: total - sum.costs,
    };
  }

  async function assetRow(t: Db, propertyId: string, id: string, lock = false): Promise<AssetRow> {
    if (lock)
      await t.run("SELECT 1 FROM hotel_fixed_assets WHERE property_id = $1 AND id = $2 FOR UPDATE", [propertyId, id]);
    const a = await t.row<AssetRow>(`${ASSET_SELECT} WHERE a.property_id = $1 AND a.id = $2`, [propertyId, id]);
    if (!a) throw fail.notFound("Asset not found");
    return a;
  }

  async function ffeView(s: HotelScope) {
    const totals = await F.ledgerTotals(db, s.property.id, "1900-01-01", s.property.business_date);
    const rows = await db.rows<{ month: string; revenue_minor: number; rate_bp: number; amount_minor: number }>(
      "SELECT * FROM hotel_ffe_contributions WHERE property_id = $1 ORDER BY month",
      [s.property.id],
    );
    const spent = await db.row<{ n: number }>(
      "SELECT COALESCE(sum(cost_minor), 0)::bigint AS n FROM hotel_fixed_assets WHERE property_id = $1 AND funded_from = 'ffe_reserve'",
      [s.property.id],
    );
    return {
      ratePct: fromBp(s.property.ffe_reserve_bp),
      balanceMinor: totals.net(ACC.ffeReserve),
      contributedMinor: rows.reduce((n, r) => n + r.amount_minor, 0),
      spentMinor: spent?.n ?? 0,
      contributions: rows.map((r) => ({
        month: r.month,
        revenueMinor: r.revenue_minor,
        ratePct: fromBp(r.rate_bp),
        amountMinor: r.amount_minor,
      })),
    };
  }

  return {
    // ---------------------------------------------------------------- budgets and the manager's report
    async setBudget(s: HotelScope, month: string, b: z.output<typeof hotel.setBudget.body>) {
      await db.tx(async (t) => {
        await t.run(
          `INSERT INTO hotel_budgets (property_id, month, kind, org_id, rooms_sold, rooms_minor, fnb_minor, spa_minor, other_minor,
             costs_minor, entered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (property_id, month, kind) DO UPDATE SET rooms_sold = EXCLUDED.rooms_sold, rooms_minor = EXCLUDED.rooms_minor,
             fnb_minor = EXCLUDED.fnb_minor, spa_minor = EXCLUDED.spa_minor, other_minor = EXCLUDED.other_minor,
             costs_minor = EXCLUDED.costs_minor, entered_by = EXCLUDED.entered_by, updated_at = now()`,
          [
            s.property.id,
            month,
            b.kind,
            s.orgId,
            b.roomsSold,
            b.revenue.rooms,
            b.revenue.fnb,
            b.revenue.spa,
            b.revenue.other,
            b.costsMinor,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: `Hotel ${b.kind} set`,
          target: month,
          after: b,
        });
      });
      return toBudget(
        (await db.row<BudgetRow>("SELECT * FROM hotel_budgets WHERE property_id = $1 AND month = $2 AND kind = $3", [
          s.property.id,
          month,
          b.kind,
        ])) as BudgetRow,
      );
    },

    async listBudgets(s: HotelScope, year: number) {
      const rows = await db.rows<BudgetRow>(
        "SELECT * FROM hotel_budgets WHERE property_id = $1 AND month LIKE $2 ORDER BY month, kind",
        [s.property.id, `${year}-%`],
      );
      return { budgets: rows.map(toBudget) };
    },

    async managersReport(s: HotelScope, date: string) {
      const periods = [];
      for (const [key, from] of [
        ["day", date],
        ["mtd", `${date.slice(0, 7)}-01`],
        ["ytd", `${date.slice(0, 4)}-01-01`],
      ] as const) {
        const { fig: actual, available } = await figures(db, s, from, date);
        const ly = (await figures(db, s, lastYear(from), lastYear(date))).fig;
        const budget = await budgetFor(db, s, from, date, available);
        periods.push({
          key,
          from,
          to: date,
          actual,
          budget,
          lastYear: ly,
          varianceToBudgetMinor: budget ? actual.revenue.total - budget.revenue.total : null,
        });
      }
      const month = date.slice(0, 7);
      const mtd = periods.find((p) => p.key === "mtd");
      const otb = await db.row<{ revenue: number; nights: number }>(
        `SELECT COALESCE(sum(n.rate_minor), 0)::bigint AS revenue, count(*)::int AS nights
         FROM hotel_stay_nights n JOIN hotel_stays s ON s.id = n.stay_id
         WHERE s.property_id = $1 AND s.status IN ('reserved', 'in_house') AND n.date > $2 AND n.date <= $3
           AND NOT EXISTS (SELECT 1 FROM hotel_folio_lines l WHERE l.stay_id = n.stay_id AND l.night_date = n.date AND l.kind = 'charge')`,
        [s.property.id, date, monthEnd(month)],
      );
      const monthBudget = await db.row<BudgetRow>(
        "SELECT * FROM hotel_budgets WHERE property_id = $1 AND month = $2 AND kind = 'budget'",
        [s.property.id, month],
      );
      const actualRooms = mtd?.actual.revenue.rooms ?? 0;
      return {
        date,
        currency: s.property.currency,
        periods,
        monthForecast: {
          month,
          actualRoomRevenueToDateMinor: actualRooms,
          onTheBooksRoomRevenueMinor: otb?.revenue ?? 0,
          forecastRoomRevenueMinor: actualRooms + (otb?.revenue ?? 0),
          budgetRoomRevenueMinor: monthBudget?.rooms_minor ?? null,
          forecastRoomsSold: (mtd?.actual.roomsSold ?? 0) + (otb?.nights ?? 0),
        },
      };
    },

    // ---------------------------------------------------------------- fixed assets
    async listAssets(s: HotelScope) {
      const rows = await db.rows<AssetRow>(`${ASSET_SELECT} WHERE a.property_id = $1 ORDER BY a.number`, [
        s.property.id,
      ]);
      return { assets: rows.map(toAsset) };
    },

    async createAsset(s: HotelScope, b: z.output<typeof hotel.createAsset.body>) {
      const id = newId("hfa");
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        if (b.fundedFrom === "ffe_reserve") {
          const fund = (await F.ledgerTotals(t, s.property.id, "1900-01-01", s.property.business_date)).net(
            ACC.ffeReserve,
          );
          if (fund < b.costMinor) throw fail.conflict(`The FF&E reserve holds ${fund}`);
        }
        const number = await nextNumber(t, s.orgId, "FA", 5);
        const from = { bank: ACC.bank, payable: ACC.payables, ffe_reserve: ACC.ffeReserve }[b.fundedFrom];
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "asset",
          memo: `Fixed asset ${number} — ${b.name}`,
          ref: `asset:${id}`,
          lines: [dr(ACC.fixedAssets, b.costMinor), cr(from, b.costMinor)],
        });
        await t.run(
          `INSERT INTO hotel_fixed_assets (id, org_id, property_id, number, name, category, acquired_on, cost_minor, residual_minor,
             life_months, funded_from, journal_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            s.orgId,
            s.property.id,
            number,
            b.name,
            b.category,
            s.property.business_date,
            b.costMinor,
            b.residualMinor,
            b.lifeMonths,
            b.fundedFrom,
            journalId,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Fixed asset added",
          target: number,
          detail: `${b.name} · ${b.costMinor}`,
        });
      });
      return toAsset(await assetRow(db, s.property.id, id));
    },

    async depreciate(s: HotelScope, month: string) {
      return db.tx(async (t) => {
        await lockBusinessDate(t, s);
        if (month > s.property.business_date.slice(0, 7)) throw fail.invalid("That month has not started");
        const assets = await t.rows<AssetRow>(
          `${ASSET_SELECT} WHERE a.property_id = $1 AND a.status = 'active' AND a.acquired_on <= $2
             AND NOT EXISTS (SELECT 1 FROM hotel_depreciation d WHERE d.asset_id = a.id AND d.month >= $3)
           ORDER BY a.number FOR UPDATE OF a`,
          [s.property.id, monthEnd(month), month],
        );
        const out: { assetId: string; amountMinor: number }[] = [];
        for (const a of assets) {
          const base = a.cost_minor - a.residual_minor;
          const left = base - a.accumulated;
          if (left <= 0) continue;
          const amount = a.months + 1 >= a.life_months ? left : Math.min(left, Math.floor(base / a.life_months));
          if (amount > 0) out.push({ assetId: a.id, amountMinor: amount });
        }
        const total = out.reduce((n, a) => n + a.amountMinor, 0);
        if (!total) return { month, totalMinor: 0, journalId: null, assets: [] };
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "asset",
          memo: `Depreciation for ${month} (${out.length} asset(s), straight line)`,
          ref: `depreciation:${s.property.id}:${month}:${out.map((a) => a.assetId).join(",")}`,
          lines: [dr(ACC.depreciation, total), cr(ACC.accumulatedDepreciation, total)],
        });
        for (const a of out)
          await t.run(
            "INSERT INTO hotel_depreciation (asset_id, month, org_id, amount_minor, journal_id) VALUES ($1,$2,$3,$4,$5)",
            [a.assetId, month, s.orgId, a.amountMinor, journalId],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Depreciation posted",
          target: month,
          detail: `${total}`,
        });
        return { month, totalMinor: total, journalId, assets: out };
      });
    },

    async dispose(s: HotelScope, assetId: string, b: { proceedsMinor: number; reason: string }) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const a = await assetRow(t, s.property.id, assetId, true);
        if (a.status !== "active") throw fail.conflict(`Asset ${a.number} is already disposed of`);
        const nbv = a.cost_minor - a.accumulated;
        const result = b.proceedsMinor - nbv;
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "asset",
          memo: `Disposal of ${a.number} ${a.name}: ${b.reason}`,
          ref: `disposal:${a.id}`,
          lines: [
            dr(ACC.accumulatedDepreciation, a.accumulated),
            dr(ACC.bank, b.proceedsMinor),
            ...(result < 0 ? [dr(ACC.disposalLoss, -result)] : []),
            cr(ACC.fixedAssets, a.cost_minor),
            ...(result > 0 ? [cr(ACC.disposalGain, result)] : []),
          ],
        });
        await t.run(
          "UPDATE hotel_fixed_assets SET status = 'disposed', disposed_on = $2, proceeds_minor = $3, disposal_journal_id = $4 WHERE id = $1",
          [a.id, s.property.business_date, b.proceedsMinor, journalId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Fixed asset disposed of",
          target: a.number,
          detail: `${b.reason} · proceeds ${b.proceedsMinor}, ${result >= 0 ? "gain" : "loss"} ${Math.abs(result)}`,
        });
      });
      return toAsset(await assetRow(db, s.property.id, assetId));
    },

    // ---------------------------------------------------------------- FF&E reserve
    ffe: ffeView,

    async contributeFfe(s: HotelScope, month: string) {
      return db.tx(async (t) => {
        await lockBusinessDate(t, s);
        if (month > s.property.business_date.slice(0, 7)) throw fail.invalid("That month has not started");
        if (
          await t.row("SELECT 1 FROM hotel_ffe_contributions WHERE property_id = $1 AND month = $2", [
            s.property.id,
            month,
          ])
        )
          throw fail.conflict(`The ${month} contribution is already made`);
        const end = monthEnd(month) < s.property.business_date ? monthEnd(month) : s.property.business_date;
        const revenue = F.revenueOf(await F.ledgerTotals(t, s.property.id, `${month}-01`, end)).total;
        const amount = Math.round((revenue * s.property.ffe_reserve_bp) / 10_000);
        if (amount <= 0) throw fail.conflict("No revenue to set aside for that month");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "ffe",
          memo: `FF&E reserve ${month}: ${fromBp(s.property.ffe_reserve_bp)}% of revenue ${revenue}`,
          ref: `ffe:${s.property.id}:${month}`,
          lines: [dr(ACC.ffeReserve, amount), cr(ACC.bank, amount)],
        });
        await t.run(
          "INSERT INTO hotel_ffe_contributions (property_id, month, org_id, revenue_minor, rate_bp, amount_minor, journal_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [s.property.id, month, s.orgId, revenue, s.property.ffe_reserve_bp, amount, journalId, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "FF&E reserve contribution",
          target: month,
          detail: `${amount}`,
        });
        return { month, revenueMinor: revenue, ratePct: fromBp(s.property.ffe_reserve_bp), amountMinor: amount };
      });
    },
  };
}

export type FinanceService = ReturnType<typeof financeService>;
