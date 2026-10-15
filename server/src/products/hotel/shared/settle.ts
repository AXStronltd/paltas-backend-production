/*
 * Settling a sale made outside the room rate (an outlet order, a treatment): either
 *   - charged to the room of a guest IN HOUSE whose folio is not blocked (each department to its routed folio), or
 *   - paid now on a walk-in folio: the charges post with their taxes, the payments (one or several — a split bill)
 *     must equal the total exactly, a tip on a payment goes to the staff tips pool (bank 1000 / tips payable 2130),
 *     and the folio closes at zero.
 * Lines of the same department (and outlet) post as one charge, so the taxes equal what sumTaxed() quoted.
 */
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import * as folioRepo from "../folios/folios.repo.js";
import { cr, dr, postToLedger } from "./posting.js";
import type { PropertyRow } from "./property.js";
import { applyTaxes } from "./tax.js";

export type SaleDepartment = Exclude<hotel.HotelDepartment, "noshow">;

export interface SaleLine {
  department: SaleDepartment;
  description: string;
  net: number;
  outletId?: string | null;
}

export interface PaymentIn {
  method: hotel.PaymentMethod;
  amountMinor: number;
  reference: string;
  tipMinor: number;
}

export interface Settlement {
  roomNumber?: string | undefined;
  payments: PaymentIn[];
}

/** Lines grouped as they will post: one charge per department and outlet. */
export function group(lines: SaleLine[]): SaleLine[] {
  const by = new Map<string, SaleLine>();
  for (const l of lines) {
    const k = `${l.department}|${l.outletId ?? ""}`;
    const g = by.get(k);
    if (g) {
      g.net += l.net;
      g.description = `${g.description}, ${l.description}`;
    } else by.set(k, { ...l });
  }
  return [...by.values()];
}

/** What the folio will charge for these lines, taxes included. */
export function sumTaxed(p: PropertyRow, lines: SaleLine[]): number {
  return group(lines).reduce((n, l) => n + applyTaxes(p, l.department, l.net).total, 0);
}

export function settler(d: HotelDeps, folios: FoliosService) {
  const { core } = d;

  /** The in-house stay in a room and the folio this department's charges go to (refused if blocked). */
  async function roomTarget(t: Db, op: HotelOp, roomNumber: string, department: SaleDepartment, stayId?: string) {
    const stay = await t.row<{ id: string }>(
      `SELECT s.id FROM hotel_stays s JOIN hotel_rooms r ON r.id = s.room_id
       WHERE s.property_id = $1 AND r.number = $2 AND s.status = 'in_house'`,
      [op.property.id, roomNumber],
    );
    if (!stay) throw fail.conflict(`No guest is in house in room ${roomNumber} — take payment on the spot`);
    if (stayId && stay.id !== stayId) throw fail.conflict(`Room ${roomNumber} now holds another guest`);
    const folioId = await folios.folioFor(t, stay.id, department);
    const f = await folioRepo.folioRow(t, op.property.id, folioId, true);
    if (f.blocked)
      throw fail.conflict(
        `This guest's folio is blocked (${f.blocked_reason ?? "no reason given"}) — take payment on the spot`,
      );
    return { stayId: stay.id, folioId };
  }

  /** The user's open cashier shift (a cash tip goes into that drawer). */
  async function shiftOf(t: Db, op: HotelOp): Promise<string | null> {
    if (!op.userId) return null;
    const r = await t.row<{ id: string }>(
      "SELECT id FROM hotel_cashier_shifts WHERE property_id = $1 AND user_id = $2 AND status = 'open'",
      [op.property.id, op.userId],
    );
    return r?.id ?? null;
  }

  async function settle(
    t: Db,
    op: HotelOp,
    sale: {
      name: string;
      lines: SaleLine[];
      settlement: Settlement;
      stayId?: string;
      outletId?: string | null;
      orderId?: string | null;
    },
  ): Promise<{ mode: "room" | "paid"; folioId: string; tipsMinor: number }> {
    const lines = group(sale.lines);
    if (!lines.length) throw fail.invalid("Nothing to settle");
    if (sale.settlement.roomNumber) {
      let first: string | null = null;
      for (const l of lines) {
        const target = await roomTarget(t, op, sale.settlement.roomNumber, l.department, sale.stayId);
        await folios.charge(t, op, target.folioId, {
          department: l.department,
          description: l.description,
          net: l.net,
          outletId: l.outletId ?? null,
          stayId: target.stayId,
        });
        first ??= target.folioId;
      }
      return { mode: "room", folioId: first as string, tipsMinor: 0 };
    }
    const folioId = await folios.open(t, op, { name: sale.name, payer: "guest" });
    for (const l of lines)
      await folios.charge(t, op, folioId, {
        department: l.department,
        description: l.description,
        net: l.net,
        outletId: l.outletId ?? null,
      });
    const due = await folioRepo.balance(t, folioId);
    const paid = sale.settlement.payments.reduce((n, p) => n + p.amountMinor, 0);
    if (paid !== due)
      throw fail.invalid(`The total with taxes is ${due}; the payments add up to ${paid}`, { totalMinor: due });
    let tips = 0;
    for (const p of sale.settlement.payments) {
      await folios.payment(t, op, folioId, p);
      if (p.tipMinor > 0) {
        const id = newId("htp");
        const journalId = await postToLedger(t, core, {
          orgId: op.orgId,
          propertyId: op.property.id,
          date: op.property.business_date,
          kind: "tip",
          memo: `Tip by ${p.method} (ref ${p.reference}) — ${sale.name}; held for staff`,
          ref: `tip:${id}`,
          lines: [dr(ACC.bank, p.tipMinor), cr(ACC.tips, p.tipMinor)],
        });
        await t.run(
          `INSERT INTO hotel_tips (id, org_id, property_id, outlet_id, order_id, amount_minor, method, reference, shift_id,
             business_date, journal_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            op.orgId,
            op.property.id,
            sale.outletId ?? null,
            sale.orderId ?? null,
            p.tipMinor,
            p.method,
            p.reference,
            await shiftOf(t, op),
            op.property.business_date,
            journalId,
            op.userId,
          ],
        );
        tips += p.tipMinor;
      }
    }
    await folios.close(t, op, folioId);
    return { mode: "paid", folioId, tipsMinor: tips };
  }

  return { settle, roomTarget };
}

export type Settler = ReturnType<typeof settler>;
