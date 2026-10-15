/*
 * Cashier shifts: one open shift per person per hotel (database rule), opening float, takings by method from the
 * payments recorded in the shift less the refunds paid out of it (a cash refund is paid from the approver's open
 * shift), closing count and over / short. An open shift blocks the night audit.
 */
import { roleCan, type hotel } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps } from "../deps.js";
import type { HotelScope } from "../shared/access.js";

interface ShiftRow {
  id: string;
  user_id: string;
  business_date: string;
  status: "open" | "closed";
  float_minor: number;
  counted_cash_minor: number | null;
  expected_cash_minor: number | null;
  over_short_minor: number | null;
  opened_at: string;
  closed_at: string | null;
}

async function takings(db: Db, shiftId: string) {
  const rows = await db.rows<{ method: hotel.PaymentMethod; n: number }>(
    `SELECT method, -sum(total_minor)::bigint AS n FROM hotel_folio_lines
     WHERE shift_id = $1 AND kind IN ('payment', 'refund') GROUP BY method`,
    [shiftId],
  );
  const get = (m: hotel.PaymentMethod) => rows.find((r) => r.method === m)?.n ?? 0;
  return {
    cash: get("cash"),
    card: get("card"),
    mobile_money: get("mobile_money"),
    bank_transfer: get("bank_transfer"),
  };
}

async function toShift(db: Db, r: ShiftRow): Promise<hotel.CashierShiftOut> {
  const t = await takings(db, r.id);
  return {
    id: r.id,
    userId: r.user_id,
    businessDate: r.business_date,
    status: r.status,
    floatMinor: r.float_minor,
    takings: t,
    expectedCashMinor: r.expected_cash_minor ?? r.float_minor + t.cash,
    countedCashMinor: r.counted_cash_minor,
    overShortMinor: r.over_short_minor,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}

export function cashierService(d: HotelDeps) {
  const { db } = d.core;
  const load = async (id: string) =>
    toShift(db, (await db.row<ShiftRow>("SELECT * FROM hotel_cashier_shifts WHERE id = $1", [id])) as ShiftRow);

  return {
    async list(s: HotelScope, status?: "open" | "closed") {
      const rows = await db.rows<ShiftRow>(
        "SELECT * FROM hotel_cashier_shifts WHERE property_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY opened_at DESC, id",
        [s.property.id, status ?? null],
      );
      const shifts = [];
      for (const r of rows) shifts.push(await toShift(db, r));
      return { shifts };
    },

    async open(s: HotelScope, floatMinor: number) {
      const id = newId("hcs");
      await db.tx(async (t) => {
        if (
          await t.row(
            "SELECT 1 FROM hotel_cashier_shifts WHERE property_id = $1 AND user_id = $2 AND status = 'open'",
            [s.property.id, s.userId],
          )
        )
          throw fail.conflict("You already have an open cashier shift at this hotel");
        await t.run(
          "INSERT INTO hotel_cashier_shifts (id, org_id, property_id, user_id, business_date, float_minor) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, s.orgId, s.property.id, s.userId, s.property.business_date, floatMinor],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Cashier shift opened",
          target: id,
          detail: `Float ${floatMinor}`,
        });
      });
      return load(id);
    },

    async close(s: HotelScope, id: string, counted: number) {
      await db.tx(async (t) => {
        const r = await t.row<ShiftRow>(
          "SELECT * FROM hotel_cashier_shifts WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, id],
        );
        if (!r) throw fail.notFound("Shift not found");
        if (r.status !== "open") throw fail.conflict("This shift is already closed");
        // your own shift; a manager who approves (front office / general manager) may close another person's
        if (r.user_id !== s.userId && !roleCan(s.role, "hotel.folio.approve"))
          throw fail.forbidden("You can close only your own shift");
        const cash = (await takings(t, id)).cash;
        const expected = r.float_minor + cash;
        await t.run(
          `UPDATE hotel_cashier_shifts SET status = 'closed', closed_at = now(), counted_cash_minor = $2,
             expected_cash_minor = $3, over_short_minor = $4 WHERE id = $1`,
          [id, counted, expected, counted - expected],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Cashier shift closed",
          target: id,
          detail: `Counted ${counted}, expected ${expected}, over/short ${counted - expected}`,
        });
      });
      return load(id);
    },
  };
}

export type CashierService = ReturnType<typeof cashierService>;
