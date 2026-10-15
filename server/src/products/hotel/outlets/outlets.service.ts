/*
 * Outlets (restaurant, bar, pool, room service): menus with modifiers and recipes, orders at a table that go to the
 * kitchen screen at once (kitchen printers: test adapter, on-screen only), settlement — charged to an in-house
 * guest's room or paid now, split across payments, with tips — and stock deducted by recipe with its cost of sales.
 * Table reservations from guests, the website and in-house guests, refused beyond the restaurant's seats.
 * Outlet staff work only at the outlets they are assigned to.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { lockBusinessDate } from "../shared/posting.js";
import { sumTaxed, type SaleDepartment, type Settlement, type Settler } from "../shared/settle.js";
import { fromMilli, toMilli, valueOf, type StockService } from "../stock/stock.service.js";

interface OutletRow {
  id: string;
  code: string;
  name: string;
  department: SaleDepartment;
  staff_user_ids: string[];
  seats: number;
  slot_minutes: number;
}

interface MenuRow {
  id: string;
  outlet_id: string;
  code: string;
  name: string;
  category: string;
  price_minor: number;
  modifiers: { code: string; name: string; priceMinor: number }[];
  active: boolean;
}

interface OrderRow {
  id: string;
  number: string;
  outlet_id: string;
  table_no: string | null;
  covers: number;
  status: "open" | "settled" | "cancelled";
  settled_mode: "room" | "paid" | null;
  folio_id: string | null;
  created_by: string | null;
}

interface TicketRow {
  id: string;
  number: string;
  outlet_id: string;
  order_id: string;
  items: hotel.KitchenTicketOut["items"];
  status: hotel.KitchenTicketOut["status"];
  printer: string;
  created_at: string;
  table_no: string | null;
}

interface TableRow {
  id: string;
  outlet_id: string;
  name: string;
  stay_id: string | null;
  room_number: string | null;
  date: string;
  time: string;
  covers: number;
  source: hotel.TableBookingOut["source"];
  status: hotel.TableBookingOut["status"];
  notes: string;
}

const toTable = (r: TableRow): hotel.TableBookingOut => ({
  id: r.id,
  outletId: r.outlet_id,
  name: r.name,
  stayId: r.stay_id,
  roomNumber: r.room_number,
  date: r.date,
  time: r.time,
  covers: r.covers,
  source: r.source,
  status: r.status,
  notes: r.notes,
});

const TABLE_SELECT = `SELECT b.*, rm.number AS room_number FROM hotel_table_bookings b
  LEFT JOIN hotel_stays s ON s.id = b.stay_id LEFT JOIN hotel_rooms rm ON rm.id = s.room_id`;

/** "2026-10-12" + "19:30" + minutes → the local timestamp text PostgreSQL reads. */
export function at(date: string, time: string, plusMinutes = 0): string {
  const t = new Date(`${date}T${time}:00Z`);
  t.setUTCMinutes(t.getUTCMinutes() + plusMinutes);
  return t.toISOString().slice(0, 19).replace("T", " ");
}

export function outletsService(d: HotelDeps, x: { settle: Settler; stock: StockService }) {
  const { core, adapters } = d;
  const { db } = core;
  const { settle, stock } = x;

  async function outlet(t: Db, s: HotelScope, id: string, forStaff = false, lock = false): Promise<OutletRow> {
    const o = await t.row<OutletRow>(
      `SELECT * FROM hotel_outlets WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [s.property.id, id],
    );
    if (!o) throw fail.notFound("Outlet not found");
    if (forStaff && s.role === "outlet_staff" && !o.staff_user_ids.includes(s.userId))
      throw fail.forbidden(`You do not work at ${o.name}`);
    return o;
  }

  async function toMenuItem(t: Db, m: MenuRow): Promise<hotel.MenuItemOut> {
    const recipe = await t.rows<{
      stock_item_id: string;
      name: string;
      qty_milli: number;
      item_qty: number;
      item_value: number;
    }>(
      `SELECT r.stock_item_id, i.name, r.qty_milli, i.qty_milli AS item_qty, i.value_minor AS item_value
       FROM hotel_recipe_lines r JOIN hotel_stock_items i ON i.id = r.stock_item_id WHERE r.menu_item_id = $1 ORDER BY i.name`,
      [m.id],
    );
    const cost = recipe.reduce(
      (n, r) => n + valueOf({ qty_milli: r.item_qty, value_minor: r.item_value }, r.qty_milli),
      0,
    );
    return {
      id: m.id,
      outletId: m.outlet_id,
      code: m.code,
      name: m.name,
      category: m.category,
      priceMinor: m.price_minor,
      modifiers: m.modifiers,
      active: m.active,
      recipe: recipe.map((r) => ({ stockItemId: r.stock_item_id, name: r.name, quantity: fromMilli(r.qty_milli) })),
      recipeCostMinor: cost,
      costPct: m.price_minor ? Math.round((cost / m.price_minor) * 10_000) / 100 : 0,
    };
  }

  async function menuRow(t: Db, propertyId: string, id: string): Promise<MenuRow> {
    const m = await t.row<MenuRow>("SELECT * FROM hotel_menu_items WHERE property_id = $1 AND id = $2", [
      propertyId,
      id,
    ]);
    if (!m) throw fail.notFound("Menu item not found");
    return m;
  }

  async function orderRow(t: Db, propertyId: string, id: string, lock = false): Promise<OrderRow> {
    const o = await t.row<OrderRow>(
      `SELECT * FROM hotel_pos_orders WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [propertyId, id],
    );
    if (!o) throw fail.notFound("Order not found");
    return o;
  }

  async function orderLines(t: Db, orderId: string) {
    return t.rows<{
      id: string;
      menu_item_id: string;
      name: string;
      quantity: number;
      modifiers: string[];
      unit_minor: number;
      net_minor: number;
      note: string;
    }>("SELECT * FROM hotel_pos_order_lines WHERE order_id = $1 ORDER BY seq", [orderId]);
  }

  async function toOrder(t: Db, s: HotelScope, o: OrderRow): Promise<hotel.PosOrderOut> {
    const lines = await orderLines(t, o.id);
    const out = await outlet(t, s, o.outlet_id);
    const net = lines.reduce((n, l) => n + l.net_minor, 0);
    const tips = await t.row<{ n: number }>(
      "SELECT COALESCE(sum(amount_minor), 0)::bigint AS n FROM hotel_tips WHERE order_id = $1",
      [o.id],
    );
    return {
      id: o.id,
      number: o.number,
      outletId: o.outlet_id,
      tableNo: o.table_no,
      covers: o.covers,
      status: o.status,
      lines: lines.map((l) => ({
        id: l.id,
        menuItemId: l.menu_item_id,
        name: l.name,
        quantity: l.quantity,
        modifiers: l.modifiers,
        unitMinor: l.unit_minor,
        netMinor: l.net_minor,
        note: l.note,
      })),
      netMinor: net,
      totalMinor: net > 0 ? sumTaxed(s.property, [{ department: out.department, description: "", net }]) : 0,
      settledMode: o.settled_mode,
      folioId: o.folio_id,
      tipsMinor: tips?.n ?? 0,
    };
  }

  /** Add order lines and send them to the kitchen screen as one ticket. */
  async function addLines(
    t: Db,
    s: HotelScope,
    o: { id: string; outletId: string; tableNo: string | null },
    lines: z.output<typeof hotel.createPosOrder.body>["lines"],
  ) {
    const items = [];
    for (const l of lines) {
      const m = await menuRow(t, s.property.id, l.menuItemId);
      if (m.outlet_id !== o.outletId) throw fail.invalid(`${m.name} is not on this outlet's menu`);
      if (!m.active) throw fail.conflict(`${m.name} is not on sale`);
      const mods = l.modifiers.map((code) => {
        const mod = m.modifiers.find((x) => x.code === code);
        if (!mod) throw fail.invalid(`${m.name} has no option ${code}`);
        return mod;
      });
      const unit = m.price_minor + mods.reduce((n, x) => n + x.priceMinor, 0);
      await t.run(
        `INSERT INTO hotel_pos_order_lines (id, order_id, menu_item_id, name, quantity, modifiers, unit_minor, net_minor, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          newId("hol"),
          o.id,
          m.id,
          m.name,
          l.quantity,
          JSON.stringify(mods.map((x) => x.name)),
          unit,
          unit * l.quantity,
          l.note,
        ],
      );
      items.push({ name: m.name, quantity: l.quantity, modifiers: mods.map((x) => x.name), note: l.note });
    }
    const number = await nextNumber(t, s.orgId, "KOT", 6);
    await t.run(
      `INSERT INTO hotel_kitchen_tickets (id, org_id, property_id, outlet_id, order_id, number, items, printer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId("hkt"),
        s.orgId,
        s.property.id,
        o.outletId,
        o.id,
        number,
        JSON.stringify(items),
        adapters.kitchenPrinters.print({ number, outletId: o.outletId }),
      ],
    );
  }

  const toTicket = (r: TicketRow): hotel.KitchenTicketOut => ({
    id: r.id,
    number: r.number,
    outletId: r.outlet_id,
    orderId: r.order_id,
    tableNo: r.table_no,
    items: r.items,
    status: r.status,
    printer: { ...adapters.kitchenPrinters.state, status: r.printer },
    at: r.created_at,
  });

  const TICKET_SELECT = `SELECT k.*, o.table_no FROM hotel_kitchen_tickets k JOIN hotel_pos_orders o ON o.id = k.order_id`;

  return {
    // ---------------------------------------------------------------- menus and recipes
    async listMenu(s: HotelScope, outletId: string) {
      await outlet(db, s, outletId);
      const rows = await db.rows<MenuRow>(
        "SELECT * FROM hotel_menu_items WHERE outlet_id = $1 ORDER BY category, code",
        [outletId],
      );
      const items = [];
      for (const m of rows) items.push(await toMenuItem(db, m));
      return { items };
    },

    async saveMenuItem(s: HotelScope, outletId: string, b: z.output<typeof hotel.saveMenuItem.body>) {
      if (new Set(b.modifiers.map((m) => m.code)).size !== b.modifiers.length)
        throw fail.invalid("Option codes must differ");
      const id = await db.tx(async (t) => {
        await outlet(t, s, outletId);
        const row = await t.row<{ id: string }>(
          `INSERT INTO hotel_menu_items (id, org_id, property_id, outlet_id, code, name, category, price_minor, modifiers, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (outlet_id, code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
             price_minor = EXCLUDED.price_minor, modifiers = EXCLUDED.modifiers, active = EXCLUDED.active
           RETURNING id`,
          [
            newId("hmi"),
            s.orgId,
            s.property.id,
            outletId,
            b.code,
            b.name,
            b.category,
            b.priceMinor,
            JSON.stringify(b.modifiers),
            b.active,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Menu item saved",
          target: b.code,
          detail: `${b.name} · ${b.priceMinor}`,
        });
        return (row as { id: string }).id;
      });
      return toMenuItem(db, await menuRow(db, s.property.id, id));
    },

    async setRecipe(s: HotelScope, itemId: string, lines: { stockItemId: string; quantity: number }[]) {
      if (new Set(lines.map((l) => l.stockItemId)).size !== lines.length) throw fail.invalid("Each ingredient once");
      await db.tx(async (t) => {
        const m = await menuRow(t, s.property.id, itemId);
        for (const l of lines)
          if (
            !(await t.row("SELECT 1 FROM hotel_stock_items WHERE property_id = $1 AND id = $2", [
              s.property.id,
              l.stockItemId,
            ]))
          )
            throw fail.notFound("Stock item not found");
        await t.run("DELETE FROM hotel_recipe_lines WHERE menu_item_id = $1", [m.id]);
        for (const l of lines)
          await t.run("INSERT INTO hotel_recipe_lines (menu_item_id, stock_item_id, qty_milli) VALUES ($1,$2,$3)", [
            m.id,
            l.stockItemId,
            toMilli(l.quantity),
          ]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Recipe set", target: m.code, after: lines });
      });
      return toMenuItem(db, await menuRow(db, s.property.id, itemId));
    },

    async setSeating(s: HotelScope, outletId: string, b: { seats: number; slotMinutes: number }) {
      await db.tx(async (t) => {
        await outlet(t, s, outletId);
        await t.run("UPDATE hotel_outlets SET seats = $2, slot_minutes = $3 WHERE id = $1", [
          outletId,
          b.seats,
          b.slotMinutes,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Outlet seating set",
          target: outletId,
          after: b,
        });
      });
      return { outletId, seats: b.seats, slotMinutes: b.slotMinutes };
    },

    // ---------------------------------------------------------------- orders and the kitchen screen
    async createOrder(s: HotelScope, outletId: string, b: z.output<typeof hotel.createPosOrder.body>) {
      const id = newId("hpo");
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        await outlet(t, s, outletId, true);
        const number = await nextNumber(t, s.orgId, "POS", 6);
        await t.run(
          `INSERT INTO hotel_pos_orders (id, org_id, property_id, outlet_id, number, table_no, covers, business_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            s.orgId,
            s.property.id,
            outletId,
            number,
            b.tableNo ?? null,
            b.covers,
            s.property.business_date,
            s.userId,
          ],
        );
        await addLines(t, s, { id, outletId, tableNo: b.tableNo ?? null }, b.lines);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Order opened", target: number });
      });
      return toOrder(db, s, await orderRow(db, s.property.id, id));
    },

    async addOrderLines(s: HotelScope, orderId: string, lines: z.output<typeof hotel.addPosLines.body>["lines"]) {
      await db.tx(async (t) => {
        const o = await orderRow(t, s.property.id, orderId, true);
        await outlet(t, s, o.outlet_id, true);
        if (o.status !== "open") throw fail.conflict(`Order ${o.number} is ${o.status}`);
        await addLines(t, s, { id: o.id, outletId: o.outlet_id, tableNo: o.table_no }, lines);
      });
      return toOrder(db, s, await orderRow(db, s.property.id, orderId));
    },

    async listOrders(s: HotelScope, outletId: string, status?: OrderRow["status"]) {
      await outlet(db, s, outletId);
      const rows = await db.rows<OrderRow>(
        "SELECT * FROM hotel_pos_orders WHERE outlet_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY number",
        [outletId, status ?? null],
      );
      const orders = [];
      for (const o of rows) orders.push(await toOrder(db, s, o));
      return { orders };
    },

    async settleOrder(s: HotelScope, orderId: string, b: Settlement) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const o = await orderRow(t, s.property.id, orderId, true);
        const out = await outlet(t, s, o.outlet_id, true);
        if (o.status !== "open") throw fail.conflict(`Order ${o.number} is ${o.status}`);
        const lines = await orderLines(t, o.id);
        const recipe = await t.rows<{ stock_item_id: string; qty_milli: number; quantity: number }>(
          `SELECT r.stock_item_id, r.qty_milli, l.quantity FROM hotel_pos_order_lines l
           JOIN hotel_recipe_lines r ON r.menu_item_id = l.menu_item_id WHERE l.order_id = $1`,
          [o.id],
        );
        const sale = await settle.settle(t, s, {
          name: `${out.name} · ${o.number}${o.table_no ? ` · table ${o.table_no}` : ""}`,
          lines: lines.map((l) => ({
            department: out.department,
            description: `${out.name}: ${l.quantity} × ${l.name}${l.modifiers.length ? ` (${l.modifiers.join(", ")})` : ""}`,
            net: l.net_minor,
            outletId: out.id,
          })),
          settlement: b,
          outletId: out.id,
          orderId: o.id,
        });
        await stock.consume(
          t,
          s,
          recipe.map((r) => ({ itemId: r.stock_item_id, qtyMilli: r.qty_milli * r.quantity })),
          { outletId: out.id, ref: o.id, memo: `${out.name} ${o.number}` },
        );
        await t.run(
          "UPDATE hotel_pos_orders SET status = 'settled', settled_mode = $2, folio_id = $3, settled_by = $4 WHERE id = $1",
          [o.id, sale.mode, sale.folioId, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: sale.mode === "room" ? "Order charged to room" : "Order paid",
          target: o.number,
          detail: `${out.name}${b.roomNumber ? ` → room ${b.roomNumber}` : ""}`,
        });
      });
      return toOrder(db, s, await orderRow(db, s.property.id, orderId));
    },

    async cancelOrder(s: HotelScope, orderId: string, reason: string) {
      await db.tx(async (t) => {
        const o = await orderRow(t, s.property.id, orderId, true);
        await outlet(t, s, o.outlet_id, true);
        if (o.status !== "open") throw fail.conflict(`Order ${o.number} is ${o.status}`);
        await t.run("UPDATE hotel_pos_orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1", [
          o.id,
          reason,
        ]);
        await t.run(
          "UPDATE hotel_kitchen_tickets SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status <> 'served'",
          [o.id],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Order cancelled",
          target: o.number,
          detail: reason,
        });
      });
      return toOrder(db, s, await orderRow(db, s.property.id, orderId));
    },

    async kitchen(s: HotelScope, outletId: string, status?: TicketRow["status"]) {
      await outlet(db, s, outletId);
      const rows = await db.rows<TicketRow>(
        `${TICKET_SELECT} WHERE k.outlet_id = $1 AND ($2::text IS NULL OR k.status = $2) ORDER BY k.seq`,
        [outletId, status ?? null],
      );
      return { tickets: rows.map(toTicket) };
    },

    async updateTicket(s: HotelScope, ticketId: string, status: "preparing" | "ready" | "served") {
      await db.tx(async (t) => {
        const k = await t.row<TicketRow>(
          "SELECT * FROM hotel_kitchen_tickets WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, ticketId],
        );
        if (!k) throw fail.notFound("Kitchen ticket not found");
        await outlet(t, s, k.outlet_id, true);
        const order = ["new", "preparing", "ready", "served"];
        if (k.status === "cancelled" || order.indexOf(status) <= order.indexOf(k.status))
          throw fail.conflict(`Ticket ${k.number} is ${k.status}`);
        await t.run("UPDATE hotel_kitchen_tickets SET status = $2, updated_at = now() WHERE id = $1", [k.id, status]);
      });
      return toTicket((await db.row<TicketRow>(`${TICKET_SELECT} WHERE k.id = $1`, [ticketId])) as TicketRow);
    },

    // ---------------------------------------------------------------- table reservations
    async listTables(s: HotelScope, q: { date?: string | undefined; outletId?: string | undefined }) {
      const rows = await db.rows<TableRow>(
        `${TABLE_SELECT} WHERE b.property_id = $1 AND ($2::date IS NULL OR b.date = $2) AND ($3::text IS NULL OR b.outlet_id = $3)
         ORDER BY b.date, b.time, b.id`,
        [s.property.id, q.date ?? null, q.outletId ?? null],
      );
      return { bookings: rows.map(toTable) };
    },

    async bookTable(s: HotelScope, b: z.output<typeof hotel.createTableBooking.body>) {
      const id = newId("htb");
      await db.tx(async (t) => {
        const o = await outlet(t, s, b.outletId, false, true);
        if (o.seats <= 0) throw fail.conflict(`Set the seats of ${o.name} before taking table bookings`);
        if (b.date < s.property.business_date) throw fail.invalid("That date has passed");
        let stayId: string | null = null;
        if (b.roomNumber) {
          const st = await t.row<{ id: string }>(
            `SELECT s.id FROM hotel_stays s JOIN hotel_rooms r ON r.id = s.room_id
             WHERE s.property_id = $1 AND r.number = $2 AND s.status = 'in_house'`,
            [s.property.id, b.roomNumber],
          );
          if (!st) throw fail.conflict(`No guest is in house in room ${b.roomNumber}`);
          stayId = st.id;
        } else if (b.source === "in_house") throw fail.invalid("Give the in-house guest's room number");
        const from = at(b.date, b.time);
        const to = at(b.date, b.time, o.slot_minutes);
        const taken = await t.row<{ n: number }>(
          `SELECT COALESCE(sum(covers), 0)::int AS n FROM hotel_table_bookings
           WHERE outlet_id = $1 AND status IN ('booked', 'seated') AND tsrange(starts_at, ends_at) && tsrange($2::timestamp, $3::timestamp)`,
          [o.id, from, to],
        );
        if ((taken?.n ?? 0) + b.covers > o.seats)
          throw fail.conflict(
            `${o.name} has ${Math.max(0, o.seats - (taken?.n ?? 0))} seat(s) free at ${b.time} on ${b.date}`,
          );
        await t.run(
          `INSERT INTO hotel_table_bookings (id, org_id, property_id, outlet_id, name, stay_id, date, time, starts_at, ends_at,
             covers, source, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            id,
            s.orgId,
            s.property.id,
            o.id,
            b.name,
            stayId,
            b.date,
            b.time,
            from,
            to,
            b.covers,
            b.roomNumber ? "in_house" : b.source,
            b.notes,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Table booked",
          target: o.name,
          detail: `${b.name} · ${b.date} ${b.time} · ${b.covers}`,
        });
      });
      return toTable((await db.row<TableRow>(`${TABLE_SELECT} WHERE b.id = $1`, [id])) as TableRow);
    },

    async updateTable(s: HotelScope, bookingId: string, status: "seated" | "completed" | "cancelled" | "no_show") {
      await db.tx(async (t) => {
        const r = await t.row<TableRow>(
          "SELECT * FROM hotel_table_bookings WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, bookingId],
        );
        if (!r) throw fail.notFound("Table booking not found");
        const next: Record<string, string[]> = { booked: ["seated", "cancelled", "no_show"], seated: ["completed"] };
        if (!(next[r.status] ?? []).includes(status)) throw fail.conflict(`This booking is ${r.status}`);
        await t.run("UPDATE hotel_table_bookings SET status = $2 WHERE id = $1", [r.id, status]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: `Table booking ${status}`, target: r.id });
      });
      return toTable((await db.row<TableRow>(`${TABLE_SELECT} WHERE b.id = $1`, [bookingId])) as TableRow);
    },
  };
}

/** Covers sold at an outlet on a range of dates (settled orders), for labour planning and outlet reports. */
export async function coversOf(t: Db, op: Pick<HotelOp, "property">, from: string, to: string) {
  return t.rows<{ outlet_id: string; date: string; covers: number }>(
    `SELECT outlet_id, business_date AS date, sum(covers)::int AS covers FROM hotel_pos_orders
     WHERE property_id = $1 AND status = 'settled' AND business_date BETWEEN $2 AND $3 GROUP BY outlet_id, business_date`,
    [op.property.id, from, to],
  );
}

export type OutletsService = ReturnType<typeof outletsService>;
