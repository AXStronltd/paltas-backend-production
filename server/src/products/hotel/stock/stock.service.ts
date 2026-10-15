/*
 * Stock and purchasing. Quantities are thousandths of a unit; each item keeps its quantity AND its value, so the
 * average cost is value ÷ quantity and a movement of q units moves round(value × q ÷ quantity) — the last unit takes
 * exactly what is left. The value of all stock therefore always equals inventory account 1300.
 *
 *   receipt (market purchase)  Dr 1300 inventory                Cr 1000 bank / 2000 payables
 *   receipt against an order   Dr 1300 inventory                Cr 2010 goods received not invoiced (at order price)
 *   supplier bill (matched)    Dr 2010 GRNI + 2100 VAT          Cr 2000 payables
 *   supplier bill (approved)   … and the price variance to cost of sales / rooms costs
 *   sale (recipe), issue, waste, count shortage   Dr 5200 F&B cost of sales or 5100 rooms costs   Cr 1300
 *   count surplus              Dr 1300                          Cr 5200 / 5100
 *
 * Separation of duties: a purchase order is approved, and a bill that does not match is approved, by someone other
 * than the person who raised / entered it (database constraints too). Housekeeping manages linen, amenities and
 * cleaning supplies only.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC, STOCK_EXPENSE_ACCOUNT } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";

export interface StockItemRow {
  id: string;
  code: string;
  name: string;
  category: hotel.StockCategory;
  unit: string;
  par_milli: number;
  reorder_milli: number;
  qty_milli: number;
  value_minor: number;
  active: boolean;
}

interface MoveRow {
  id: string;
  business_date: string;
  kind: hotel.StockMoveOut["kind"];
  qty_milli: number;
  value_minor: number;
  outlet_id: string | null;
  ref: string;
  journal_id: string | null;
}

interface PoRow {
  id: string;
  number: string;
  supplier: string;
  status: hotel.PurchaseOrderOut["status"];
  created_by: string;
  approved_by: string | null;
}

export const toMilli = (q: number) => Math.round(q * 1000);
export const fromMilli = (m: number) => m / 1000;

/** The value of q (thousandths) taken from an item at its average cost; all of it when q is everything. */
export const valueOf = (item: { qty_milli: number; value_minor: number }, q: number) =>
  item.qty_milli <= 0
    ? 0
    : q >= item.qty_milli
      ? item.value_minor
      : Math.round((item.value_minor * q) / item.qty_milli);

export const toItem = (i: StockItemRow): hotel.StockItemOut => ({
  id: i.id,
  code: i.code,
  name: i.name,
  category: i.category,
  unit: i.unit,
  quantity: fromMilli(i.qty_milli),
  parLevel: fromMilli(i.par_milli),
  reorderQuantity: fromMilli(i.reorder_milli),
  valueMinor: i.value_minor,
  unitCostMinor: i.qty_milli > 0 ? Math.round((i.value_minor * 1000) / i.qty_milli) : 0,
  belowPar: i.qty_milli < i.par_milli,
  active: i.active,
});

const toMove = (m: MoveRow): hotel.StockMoveOut => ({
  id: m.id,
  date: m.business_date,
  kind: m.kind,
  quantity: fromMilli(m.qty_milli),
  valueMinor: m.value_minor,
  outletId: m.outlet_id,
  ref: m.ref,
  journalId: m.journal_id,
});

const HOUSEKEEPING_CATEGORIES: hotel.StockCategory[] = ["linen", "amenity", "cleaning"];

/** Housekeeping supervisors look after linen, amenities and cleaning supplies — not food and drink. */
function checkCategory(s: { role: string }, category: hotel.StockCategory) {
  if (s.role === "housekeeping_supervisor" && !HOUSEKEEPING_CATEGORIES.includes(category))
    throw fail.forbidden("Housekeeping manages linen, amenities and cleaning supplies only");
}

export async function stockItem(t: Db, propertyId: string, id: string, lock = false): Promise<StockItemRow> {
  const r = await t.row<StockItemRow>(
    `SELECT * FROM hotel_stock_items WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [propertyId, id],
  );
  if (!r) throw fail.notFound("Stock item not found");
  return r;
}

export function stockService(d: HotelDeps) {
  const { core } = d;
  const { db } = core;

  async function move(
    t: Db,
    op: HotelOp,
    item: StockItemRow,
    m: {
      kind: MoveRow["kind"];
      qty: number;
      value: number;
      outletId?: string | null;
      ref: string;
      journalId?: string | null;
    },
  ): Promise<string> {
    const id = newId("hsm");
    await t.run(
      "UPDATE hotel_stock_items SET qty_milli = qty_milli + $2, value_minor = value_minor + $3 WHERE id = $1",
      [item.id, m.qty, m.value],
    );
    await t.run(
      `INSERT INTO hotel_stock_moves (id, org_id, property_id, item_id, business_date, kind, qty_milli, value_minor, outlet_id,
         ref, journal_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        op.orgId,
        op.property.id,
        item.id,
        op.property.business_date,
        m.kind,
        m.qty,
        m.value,
        m.outletId ?? null,
        m.ref,
        m.journalId ?? null,
        op.userId,
      ],
    );
    return id;
  }

  /**
   * Take what a sale used from stock (recipes × quantities), at average cost, and post the cost of sales once for
   * the whole sale. Refused (409) when an ingredient is short — count or receive stock first.
   */
  async function consume(
    t: Db,
    op: HotelOp,
    use: { itemId: string; qtyMilli: number }[],
    o: { outletId: string | null; ref: string; memo: string },
  ): Promise<number> {
    const need = new Map<string, number>();
    for (const u of use) need.set(u.itemId, (need.get(u.itemId) ?? 0) + u.qtyMilli);
    const ids = [...need.keys()].sort();
    if (!ids.length) return 0;
    const items: StockItemRow[] = [];
    for (const id of ids) items.push(await stockItem(t, op.property.id, id, true));
    const short = items.filter((i) => (need.get(i.id) ?? 0) > i.qty_milli);
    if (short.length)
      throw fail.conflict(
        `Not enough in stock: ${short.map((i) => `${i.name} (on hand ${fromMilli(i.qty_milli)} ${i.unit})`).join(", ")} — receive or count stock first`,
      );
    const byAccount = new Map<string, number>();
    const moves: string[] = [];
    for (const i of items) {
      const q = need.get(i.id) as number;
      const value = valueOf(i, q);
      moves.push(await move(t, op, i, { kind: "sale", qty: -q, value: -value, outletId: o.outletId, ref: o.ref }));
      const acc = STOCK_EXPENSE_ACCOUNT[i.category];
      byAccount.set(acc, (byAccount.get(acc) ?? 0) + value);
    }
    const total = [...byAccount.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const journalId = await postToLedger(t, core, {
        orgId: op.orgId,
        propertyId: op.property.id,
        date: op.property.business_date,
        kind: "stock",
        memo: `Cost of sales — ${o.memo}`,
        ref: `cos:${o.ref}`,
        lines: [...[...byAccount.entries()].map(([a, v]) => dr(a, v)), cr(ACC.inventory, total)],
      });
      await t.run("UPDATE hotel_stock_moves SET journal_id = $2 WHERE id = ANY($1::text[])", [moves, journalId]);
    }
    return total;
  }

  async function poRow(t: Db, propertyId: string, id: string, lock = false): Promise<PoRow> {
    const r = await t.row<PoRow>(
      `SELECT * FROM hotel_purchase_orders WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [propertyId, id],
    );
    if (!r) throw fail.notFound("Purchase order not found");
    return r;
  }

  async function toPo(t: Db, po: PoRow): Promise<hotel.PurchaseOrderOut> {
    const lines = await t.rows<{
      id: string;
      item_id: string;
      name: string;
      qty_milli: number;
      received_milli: number;
      unit_cost_minor: number;
    }>(
      `SELECT l.*, i.name FROM hotel_po_lines l JOIN hotel_stock_items i ON i.id = l.item_id WHERE l.po_id = $1 ORDER BY l.seq`,
      [po.id],
    );
    const bills = await t.rows<{
      id: string;
      supplier_ref: string;
      amount_minor: number;
      vat_minor: number;
      expected_minor: number;
      variance_minor: number;
      status: "matched" | "held" | "approved";
      entered_by: string;
      approved_by: string | null;
    }>("SELECT * FROM hotel_supplier_bills WHERE po_id = $1 ORDER BY created_at, id", [po.id]);
    const received = await t.row<{ n: number }>(
      "SELECT COALESCE(sum(value_minor), 0)::bigint AS n FROM hotel_goods_receipts WHERE po_id = $1",
      [po.id],
    );
    const lineMinor = (l: { qty_milli: number; unit_cost_minor: number }) =>
      Math.round((l.qty_milli * l.unit_cost_minor) / 1000);
    return {
      id: po.id,
      number: po.number,
      supplier: po.supplier,
      status: po.status,
      lines: lines.map((l) => ({
        id: l.id,
        stockItemId: l.item_id,
        name: l.name,
        quantity: fromMilli(l.qty_milli),
        receivedQuantity: fromMilli(l.received_milli),
        unitCostMinor: l.unit_cost_minor,
        lineMinor: lineMinor(l),
      })),
      totalMinor: lines.reduce((n, l) => n + lineMinor(l), 0),
      receivedValueMinor: received?.n ?? 0,
      billedMinor: bills.filter((b) => b.status !== "held").reduce((n, b) => n + b.amount_minor, 0),
      createdBy: po.created_by,
      approvedBy: po.approved_by,
      bills: bills.map((b) => ({
        id: b.id,
        supplierRef: b.supplier_ref,
        amountMinor: b.amount_minor,
        vatMinor: b.vat_minor,
        expectedMinor: b.expected_minor,
        varianceMinor: b.variance_minor,
        status: b.status,
        enteredBy: b.entered_by,
        approvedBy: b.approved_by,
      })),
    };
  }

  const loadPo = async (propertyId: string, id: string) => toPo(db, await poRow(db, propertyId, id));

  /** The expense account of a purchase order's price variance: that of its first item's category. */
  async function varianceAccount(t: Db, poId: string): Promise<string> {
    const r = await t.row<{ category: hotel.StockCategory }>(
      `SELECT i.category FROM hotel_po_lines l JOIN hotel_stock_items i ON i.id = l.item_id WHERE l.po_id = $1
       ORDER BY l.seq LIMIT 1`,
      [poId],
    );
    return STOCK_EXPENSE_ACCOUNT[r?.category ?? "food"];
  }

  return {
    consume,
    valueOf,

    // ---------------------------------------------------------------- items
    async list(s: HotelScope, q: { category?: hotel.StockCategory | undefined; belowPar?: boolean | undefined }) {
      const rows = await db.rows<StockItemRow>(
        `SELECT * FROM hotel_stock_items WHERE property_id = $1 AND ($2::text IS NULL OR category = $2)
           AND ($3::boolean IS NULL OR (qty_milli < par_milli) = $3) ORDER BY category, code`,
        [s.property.id, q.category ?? null, q.belowPar ?? null],
      );
      const all = await db.row<{ n: number }>(
        "SELECT COALESCE(sum(value_minor), 0)::bigint AS n FROM hotel_stock_items WHERE property_id = $1",
        [s.property.id],
      );
      return { items: rows.map(toItem), totalValueMinor: all?.n ?? 0 };
    },

    async create(s: HotelScope, b: z.output<typeof hotel.createStockItem.body>) {
      checkCategory(s, b.category);
      const id = newId("hsi");
      await db.tx(async (t) => {
        if (
          await t.row("SELECT 1 FROM hotel_stock_items WHERE property_id = $1 AND code = $2", [s.property.id, b.code])
        )
          throw fail.conflict(`Stock item ${b.code} already exists`);
        await t.run(
          `INSERT INTO hotel_stock_items (id, org_id, property_id, code, name, category, unit, par_milli, reorder_milli)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.code,
            b.name,
            b.category,
            b.unit,
            toMilli(b.parLevel),
            toMilli(b.reorderQuantity),
          ],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Stock item added", target: b.code });
      });
      return toItem(await stockItem(db, s.property.id, id));
    },

    async receive(s: HotelScope, itemId: string, b: z.output<typeof hotel.receiveStock.body>) {
      const out = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const item = await stockItem(t, s.property.id, itemId, true);
        checkCategory(s, item.category);
        const ref = `receipt:${newId("rcp")}`;
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "stock",
          memo: `Stock received — ${item.name} (${b.quantity} ${item.unit}, ref ${b.reference})`,
          ref,
          lines: [
            dr(ACC.inventory, b.totalCostMinor),
            cr(b.paidFrom === "bank" ? ACC.bank : ACC.payables, b.totalCostMinor),
          ],
        });
        const moveId = await move(t, s, item, {
          kind: "receipt",
          qty: toMilli(b.quantity),
          value: b.totalCostMinor,
          ref: b.reference,
          journalId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Stock received",
          target: item.code,
          detail: `${b.quantity} ${item.unit} · ${b.totalCostMinor}`,
        });
        return moveId;
      });
      return {
        item: toItem(await stockItem(db, s.property.id, itemId)),
        move: toMove((await db.row<MoveRow>("SELECT * FROM hotel_stock_moves WHERE id = $1", [out])) as MoveRow),
      };
    },

    async issue(s: HotelScope, itemId: string, b: z.output<typeof hotel.issueStock.body>) {
      const out = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const item = await stockItem(t, s.property.id, itemId, true);
        checkCategory(s, item.category);
        if (
          b.outletId &&
          !(await t.row("SELECT 1 FROM hotel_outlets WHERE property_id = $1 AND id = $2", [s.property.id, b.outletId]))
        )
          throw fail.notFound("Outlet not found");
        const q = toMilli(b.quantity);
        if (q > item.qty_milli)
          throw fail.conflict(`Only ${fromMilli(item.qty_milli)} ${item.unit} of ${item.name} on hand`);
        const value = valueOf(item, q);
        const ref = `${b.kind}:${newId("iss")}`;
        const journalId =
          value > 0
            ? await postToLedger(t, core, {
                orgId: s.orgId,
                propertyId: s.property.id,
                date: s.property.business_date,
                kind: "stock",
                memo: `Stock ${b.kind === "waste" ? "written off" : "issued"} — ${item.name} (${b.quantity} ${item.unit}): ${b.note}`,
                ref,
                lines: [dr(STOCK_EXPENSE_ACCOUNT[item.category], value), cr(ACC.inventory, value)],
              })
            : null;
        const moveId = await move(t, s, item, {
          kind: b.kind,
          qty: -q,
          value: -value,
          outletId: b.outletId ?? null,
          ref: b.note,
          journalId,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: b.kind === "waste" ? "Stock written off" : "Stock issued",
          target: item.code,
          detail: `${b.quantity} ${item.unit} · ${value} · ${b.note}`,
        });
        return moveId;
      });
      return {
        item: toItem(await stockItem(db, s.property.id, itemId)),
        move: toMove((await db.row<MoveRow>("SELECT * FROM hotel_stock_moves WHERE id = $1", [out])) as MoveRow),
      };
    },

    async count(s: HotelScope, counts: { itemId: string; quantity: number }[]) {
      if (new Set(counts.map((c) => c.itemId)).size !== counts.length) throw fail.invalid("Count each item once");
      return db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const variances = [];
        for (const c of [...counts].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
          const item = await stockItem(t, s.property.id, c.itemId, true);
          checkCategory(s, item.category);
          const counted = toMilli(c.quantity);
          const diff = counted - item.qty_milli;
          if (diff === 0) continue;
          // a shortage leaves at average cost; a surplus is valued at average cost (nothing to value it by when empty)
          const value =
            diff < 0
              ? -valueOf(item, -diff)
              : item.qty_milli > 0
                ? Math.round((item.value_minor * diff) / item.qty_milli)
                : 0;
          const ref = `count:${newId("cnt")}`;
          const exp = STOCK_EXPENSE_ACCOUNT[item.category];
          const journalId =
            value !== 0
              ? await postToLedger(t, core, {
                  orgId: s.orgId,
                  propertyId: s.property.id,
                  date: s.property.business_date,
                  kind: "stock",
                  memo: `Stock count variance — ${item.name} (${fromMilli(diff)} ${item.unit})`,
                  ref,
                  lines:
                    value < 0
                      ? [dr(exp, -value), cr(ACC.inventory, -value)]
                      : [dr(ACC.inventory, value), cr(exp, value)],
                })
              : null;
          await move(t, s, item, { kind: "count", qty: diff, value, ref: "Stock count", journalId });
          variances.push({ itemId: item.id, name: item.name, varianceQuantity: fromMilli(diff), valueMinor: value });
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Stock count recorded",
          target: s.property.id,
          detail: `${counts.length} item(s), ${variances.length} variance(s)`,
        });
        return { variances, totalVarianceMinor: variances.reduce((n, v) => n + v.valueMinor, 0) };
      });
    },

    async moves(s: HotelScope, itemId: string) {
      const item = await stockItem(db, s.property.id, itemId);
      const rows = await db.rows<MoveRow>("SELECT * FROM hotel_stock_moves WHERE item_id = $1 ORDER BY seq", [itemId]);
      return { item: toItem(item), moves: rows.map(toMove) };
    },

    // ---------------------------------------------------------------- purchase orders, receipts, bills
    async listPos(s: HotelScope, status?: PoRow["status"]) {
      const rows = await db.rows<PoRow>(
        "SELECT * FROM hotel_purchase_orders WHERE property_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY number",
        [s.property.id, status ?? null],
      );
      const orders = [];
      for (const r of rows) orders.push(await toPo(db, r));
      return { orders };
    },

    async createPo(s: HotelScope, b: z.output<typeof hotel.createPurchaseOrder.body>) {
      const id = newId("hpo");
      await db.tx(async (t) => {
        for (const l of b.lines) checkCategory(s, (await stockItem(t, s.property.id, l.stockItemId)).category);
        const number = await nextNumber(t, s.orgId, "PO", 5);
        await t.run(
          "INSERT INTO hotel_purchase_orders (id, org_id, property_id, number, supplier, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, s.orgId, s.property.id, number, b.supplier, s.userId],
        );
        for (const l of b.lines)
          await t.run(
            "INSERT INTO hotel_po_lines (id, po_id, item_id, qty_milli, unit_cost_minor) VALUES ($1,$2,$3,$4,$5)",
            [newId("hpl"), id, l.stockItemId, toMilli(l.quantity), l.unitCostMinor],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Purchase order raised",
          target: number,
          detail: `${b.supplier} · ${b.lines.length} line(s)`,
        });
      });
      return loadPo(s.property.id, id);
    },

    async approvePo(s: HotelScope, id: string) {
      await db.tx(async (t) => {
        const po = await poRow(t, s.property.id, id, true);
        if (po.status !== "draft") throw fail.conflict(`Purchase order ${po.number} is ${po.status}`);
        if (po.created_by === s.userId)
          throw fail.separationOfDuties("You raised this purchase order — someone else must approve it");
        await t.run(
          "UPDATE hotel_purchase_orders SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
          [id, s.userId],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Purchase order approved", target: po.number });
      });
      return loadPo(s.property.id, id);
    },

    async receivePo(s: HotelScope, id: string, lines: { poLineId: string; quantity: number }[]) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const po = await poRow(t, s.property.id, id, true);
        if (po.status !== "approved")
          throw fail.conflict(`Only an approved order is received (${po.number} is ${po.status})`);
        if (new Set(lines.map((l) => l.poLineId)).size !== lines.length) throw fail.invalid("Each line once");
        const receiptId = newId("hgr");
        let total = 0;
        const taken: { item: StockItemRow; qty: number; value: number }[] = [];
        for (const l of lines) {
          const pl = await t.row<{
            id: string;
            item_id: string;
            qty_milli: number;
            received_milli: number;
            unit_cost_minor: number;
          }>("SELECT * FROM hotel_po_lines WHERE po_id = $1 AND id = $2 FOR UPDATE", [id, l.poLineId]);
          if (!pl) throw fail.notFound("Order line not found");
          const q = toMilli(l.quantity);
          if (pl.received_milli + q > pl.qty_milli)
            throw fail.conflict(
              `At most ${fromMilli(pl.qty_milli - pl.received_milli)} more can be received on this line`,
            );
          const value = Math.round((q * pl.unit_cost_minor) / 1000);
          await t.run("UPDATE hotel_po_lines SET received_milli = received_milli + $2 WHERE id = $1", [pl.id, q]);
          taken.push({ item: await stockItem(t, s.property.id, pl.item_id, true), qty: q, value });
          total += value;
        }
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "purchase",
          memo: `Goods received — ${po.number} from ${po.supplier}`,
          ref: `grn:${receiptId}`,
          lines: [dr(ACC.inventory, total), cr(ACC.grni, total)],
        });
        for (const x of taken)
          await move(t, s, x.item, { kind: "receipt", qty: x.qty, value: x.value, ref: po.number, journalId });
        await t.run(
          "INSERT INTO hotel_goods_receipts (id, org_id, po_id, business_date, value_minor, journal_id, received_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [receiptId, s.orgId, id, s.property.business_date, total, journalId, s.userId],
        );
        const open = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM hotel_po_lines WHERE po_id = $1 AND received_milli < qty_milli",
          [id],
        );
        if (!open?.n) await t.run("UPDATE hotel_purchase_orders SET status = 'received' WHERE id = $1", [id]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Goods received",
          target: po.number,
          detail: `${total}`,
        });
      });
      return loadPo(s.property.id, id);
    },

    async enterBill(s: HotelScope, poId: string, b: z.output<typeof hotel.enterSupplierBill.body>) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const po = await poRow(t, s.property.id, poId, true);
        if (
          await t.row("SELECT 1 FROM hotel_supplier_bills WHERE po_id = $1 AND supplier_ref = $2", [
            poId,
            b.supplierRef,
          ])
        )
          throw fail.conflict(`Bill ${b.supplierRef} is already entered on ${po.number}`);
        const received = await t.row<{ n: number }>(
          "SELECT COALESCE(sum(value_minor), 0)::bigint AS n FROM hotel_goods_receipts WHERE po_id = $1",
          [poId],
        );
        const billed = await t.row<{ n: number }>(
          "SELECT COALESCE(sum(expected_minor), 0)::bigint AS n FROM hotel_supplier_bills WHERE po_id = $1",
          [poId],
        );
        const expected = (received?.n ?? 0) - (billed?.n ?? 0);
        if (expected <= 0)
          throw fail.conflict(
            `Nothing received on ${po.number} is waiting for a bill — receive the goods first (three-way match)`,
          );
        const variance = b.amountMinor - expected;
        const id = newId("hsb");
        let journalId: string | null = null;
        if (variance === 0)
          journalId = await postToLedger(t, core, {
            orgId: s.orgId,
            propertyId: s.property.id,
            date: s.property.business_date,
            kind: "purchase",
            memo: `Supplier bill ${b.supplierRef} — ${po.supplier} (${po.number}, matched)`,
            ref: `bill:${id}`,
            lines: [dr(ACC.grni, b.amountMinor), dr(ACC.vat, b.vatMinor), cr(ACC.payables, b.amountMinor + b.vatMinor)],
          });
        await t.run(
          `INSERT INTO hotel_supplier_bills (id, org_id, property_id, po_id, supplier_ref, amount_minor, vat_minor, expected_minor,
             variance_minor, status, entered_by, journal_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            s.orgId,
            s.property.id,
            poId,
            b.supplierRef,
            b.amountMinor,
            b.vatMinor,
            expected,
            variance,
            variance === 0 ? "matched" : "held",
            s.userId,
            journalId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: variance === 0 ? "Supplier bill matched and posted" : "Supplier bill held — does not match",
          target: po.number,
          detail: `${b.supplierRef} · ${b.amountMinor} vs received ${expected}`,
        });
      });
      return loadPo(s.property.id, poId);
    },

    async approveBill(s: HotelScope, billId: string, reason: string) {
      const poId = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const b = await t.row<{
          id: string;
          po_id: string;
          supplier_ref: string;
          amount_minor: number;
          vat_minor: number;
          expected_minor: number;
          variance_minor: number;
          status: string;
          entered_by: string;
        }>("SELECT * FROM hotel_supplier_bills WHERE property_id = $1 AND id = $2 FOR UPDATE", [s.property.id, billId]);
        if (!b) throw fail.notFound("Supplier bill not found");
        if (b.status !== "held") throw fail.conflict("Only a held bill needs approval");
        if (b.entered_by === s.userId)
          throw fail.separationOfDuties("You entered this bill — someone else must approve its variance");
        const po = await poRow(t, s.property.id, b.po_id);
        const acc = await varianceAccount(t, b.po_id);
        const v = b.variance_minor;
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "purchase",
          memo: `Supplier bill ${b.supplier_ref} — ${po.supplier} (${po.number}), price variance ${v} approved: ${reason}`,
          ref: `bill:${b.id}`,
          lines: [
            dr(ACC.grni, b.expected_minor),
            ...(v > 0 ? [dr(acc, v)] : []),
            dr(ACC.vat, b.vat_minor),
            ...(v < 0 ? [cr(acc, -v)] : []),
            cr(ACC.payables, b.amount_minor + b.vat_minor),
          ],
        });
        await t.run(
          "UPDATE hotel_supplier_bills SET status = 'approved', approved_by = $2, approve_reason = $3, journal_id = $4 WHERE id = $1",
          [b.id, s.userId, reason, journalId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Supplier bill variance approved",
          target: po.number,
          detail: `${b.supplier_ref} · variance ${v}: ${reason}`,
        });
        return b.po_id;
      });
      return loadPo(s.property.id, poId);
    },
  };
}

export type StockService = ReturnType<typeof stockService>;
