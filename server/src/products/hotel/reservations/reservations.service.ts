/*
 * Reservations: individual and multi-room bookings, channel bookings, group blocks with cut-off, the waitlist,
 * cancellations and no-shows by the rate plan's policy. Every night is taken from the ONE inventory record
 * (shared/inventory.ts) in the same transaction that writes the booking.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { ApiError, fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import type { HotelScope } from "../shared/access.js";
import { addDays, daysBetween, nightsOf } from "../shared/dates.js";
import { moveInventory, queueAri } from "../shared/inventory.js";
import { lockBusinessDate } from "../shared/posting.js";
import { loadRateBook, restrictionProblem, stayPrices, type RateBook } from "../shared/rates.js";
import { roomType } from "../setup/setup.repo.js";
import * as repo from "./reservations.repo.js";

type ReservationInput = z.output<typeof hotel.ReservationInput>;
type GuestInput = z.output<typeof hotel.GuestInput>;

interface BlockRow {
  id: string;
  property_id: string;
  name: string;
  room_type_id: string;
  rate_plan_id: string;
  arrival: string;
  departure: string;
  rooms_per_night: number;
  cutoff_date: string;
  billing: "master" | "individual";
  corporate_account_id: string | null;
  status: "open" | "released";
  master_folio_id: string | null;
}

export function reservationsService(d: HotelDeps, folios: FoliosService) {
  const { core, adapters } = d;
  const { db } = core;

  const load = async (t: Db, propertyId: string, id: string) =>
    repo.toReservation(t, await repo.reservationRow(t, propertyId, id));

  /** A returning guest is recognised by e-mail, phone or ID number; otherwise a new profile is created. */
  async function guestFor(t: Db, orgId: string, g: GuestInput): Promise<string> {
    const found = await t.row<{ id: string }>(
      `SELECT id FROM hotel_guests WHERE org_id = $1 AND (
         ($2::text IS NOT NULL AND lower(email) = lower($2)) OR ($3::text IS NOT NULL AND phone = $3)
         OR ($4::text IS NOT NULL AND id_number = $4))
       ORDER BY created_at LIMIT 1`,
      [orgId, g.email ?? null, g.phone ?? null, g.idNumber ?? null],
    );
    if (found) {
      await t.run(
        `UPDATE hotel_guests SET email = COALESCE(email, $2), phone = COALESCE(phone, $3), id_number = COALESCE(id_number, $4),
           nationality = COALESCE(nationality, $5) WHERE id = $1`,
        [found.id, g.email ?? null, g.phone ?? null, g.idNumber ?? null, g.nationality ?? null],
      );
      return found.id;
    }
    const id = newId("hgu");
    await t.run(
      "INSERT INTO hotel_guests (id, org_id, name, email, phone, id_number, nationality) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, orgId, g.name, g.email ?? null, g.phone ?? null, g.idNumber ?? null, g.nationality ?? null],
    );
    return id;
  }

  async function block(t: Db, propertyId: string, id: string, lock = false): Promise<BlockRow> {
    const b = await t.row<BlockRow>(
      `SELECT * FROM hotel_group_blocks WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [propertyId, id],
    );
    if (!b) throw fail.notFound("Group block not found");
    return b;
  }

  async function pushAri(
    t: Db,
    op: HotelOp,
    book: RateBook,
    items: { roomTypeId: string; from: string; to: string }[],
  ) {
    for (const i of items) await queueAri(t, adapters, book, { orgId: op.orgId, propertyId: op.property.id, ...i });
  }

  /** Take the stay's nights from inventory: from its group block, or from general sale. */
  async function takeRooms(
    t: Db,
    op: HotelOp,
    s: { roomTypeId: string; arrival: string; departure: string; blockId: string | null },
  ) {
    const inv = {
      orgId: op.orgId,
      propertyId: op.property.id,
      roomTypeId: s.roomTypeId,
      from: s.arrival,
      to: s.departure,
    };
    if (!s.blockId) return moveInventory(t, inv, "sell");
    const full = await t.rows<{ date: string }>(
      `SELECT date FROM hotel_group_block_nights WHERE block_id = $1 AND date >= $2 AND date < $3 AND picked >= held`,
      [s.blockId, s.arrival, s.departure],
    );
    if (full.length) throw fail.conflict(`The group block is fully picked up on ${full.map((r) => r.date).join(", ")}`);
    await t.run(
      "UPDATE hotel_group_block_nights SET picked = picked + 1 WHERE block_id = $1 AND date >= $2 AND date < $3",
      [s.blockId, s.arrival, s.departure],
    );
    await moveInventory(t, inv, "pickup");
  }

  /** Give a stay's nights from `from` back to sale (or to its open group block). */
  async function giveBack(t: Db, op: HotelOp, s: repo.StayRow, from: string) {
    const start = from > s.arrival ? from : s.arrival;
    if (start >= s.departure) return;
    const inv = {
      orgId: op.orgId,
      propertyId: op.property.id,
      roomTypeId: s.room_type_id,
      from: start,
      to: s.departure,
    };
    const r = await t.row<{ group_block_id: string | null }>(
      "SELECT group_block_id FROM hotel_reservations WHERE id = $1",
      [s.reservation_id],
    );
    const open =
      s.from_block && r?.group_block_id
        ? await t.row("SELECT 1 FROM hotel_group_blocks WHERE id = $1 AND status = 'open'", [r.group_block_id])
        : null;
    if (open && r?.group_block_id) {
      await t.run(
        "UPDATE hotel_group_block_nights SET picked = picked - 1 WHERE block_id = $1 AND date >= $2 AND date < $3",
        [r.group_block_id, start, s.departure],
      );
      await moveInventory(t, inv, "unpick");
    } else {
      await moveInventory(t, inv, "unsell");
    }
  }

  async function create(op: HotelOp, b: ReservationInput, ext: { externalRef?: string } = {}): Promise<string> {
    if (b.arrival < op.property.business_date)
      throw fail.invalid(`Arrival is before the hotel's business date (${op.property.business_date})`);
    if ((b.source === "channel") !== !!b.channelId)
      throw fail.invalid("A channel booking names its channel, and only it");
    return db.tx(async (t) => {
      const book = await loadRateBook(t, op.property.id);
      if (b.channelId) {
        const c = await t.row<{ active: boolean }>(
          "SELECT active FROM hotel_channels WHERE property_id = $1 AND id = $2",
          [op.property.id, b.channelId],
        );
        if (!c?.active) throw fail.invalid("Unknown or inactive channel");
      }
      if (
        b.corporateAccountId &&
        !(await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [
          op.orgId,
          b.corporateAccountId,
        ]))
      )
        throw fail.invalid("Unknown company account");
      let grp: BlockRow | null = null;
      if (b.groupBlockId) {
        grp = await block(t, op.property.id, b.groupBlockId, true);
        if (grp.status !== "open") throw fail.conflict("This group block has been released");
        if (b.arrival < grp.arrival || b.departure > grp.departure)
          throw fail.invalid("Group bookings stay within the block's dates");
      }
      // check every room before taking any inventory
      const rooms = [];
      for (const r of b.rooms) {
        const rt = await roomType(t, op.property.id, r.roomTypeId);
        if (r.adults > rt.capacity_adults || r.children > rt.capacity_children)
          throw fail.invalid(`${rt.name} sleeps ${rt.capacity_adults} adult(s) and ${rt.capacity_children} child(ren)`);
        const plan = book.plans.get(r.ratePlanId);
        if (plan?.kind === "corporate" && plan.corporate_account_id !== (b.corporateAccountId ?? null))
          throw fail.invalid(`Rate plan ${plan.code} is for its company account only`);
        if (grp && (r.roomTypeId !== grp.room_type_id || r.ratePlanId !== grp.rate_plan_id))
          throw fail.invalid("Group bookings use the block's room type and rate plan");
        if (!grp) {
          const problem = restrictionProblem(book, {
            roomTypeId: r.roomTypeId,
            ratePlanId: r.ratePlanId,
            channelId: b.channelId ?? null,
            arrival: b.arrival,
            departure: b.departure,
          });
          if (problem) throw fail.conflict(problem);
        }
        const prices = stayPrices(book, r.ratePlanId, r.roomTypeId, b.arrival, b.departure);
        rooms.push({ ...r, prices });
      }

      let waitlisted = false;
      if (b.waitlist) await t.run("SAVEPOINT hotel_booking");
      try {
        for (const r of rooms)
          await takeRooms(t, op, {
            roomTypeId: r.roomTypeId,
            arrival: b.arrival,
            departure: b.departure,
            blockId: grp?.id ?? null,
          });
      } catch (e) {
        if (!(b.waitlist && e instanceof ApiError && e.status === 409)) throw e;
        await t.run("ROLLBACK TO SAVEPOINT hotel_booking");
        waitlisted = true;
      }

      const id = newId("hre");
      const number = await nextNumber(t, op.orgId, "RES", 6);
      await t.run(
        `INSERT INTO hotel_reservations (id, org_id, property_id, number, guest_id, arrival, departure, source, channel_id,
           external_ref, corporate_account_id, group_block_id, special_requests, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          op.orgId,
          op.property.id,
          number,
          await guestFor(t, op.orgId, b.guest),
          b.arrival,
          b.departure,
          grp ? "group" : b.source,
          b.channelId ?? null,
          ext.externalRef ?? null,
          b.corporateAccountId ?? grp?.corporate_account_id ?? null,
          grp?.id ?? null,
          b.specialRequests,
          op.userId,
        ],
      );
      for (const r of rooms) {
        const stayId = newId("hst");
        await t.run(
          `INSERT INTO hotel_stays (id, org_id, property_id, reservation_id, room_type_id, rate_plan_id, adults, children, arrival, departure, status, from_block)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            stayId,
            op.orgId,
            op.property.id,
            id,
            r.roomTypeId,
            r.ratePlanId,
            r.adults,
            r.children,
            b.arrival,
            b.departure,
            waitlisted ? "waitlisted" : "reserved",
            !!grp,
          ],
        );
        for (const n of r.prices)
          await t.run(
            "INSERT INTO hotel_stay_nights (stay_id, date, rate_minor, plan_rate_minor) VALUES ($1,$2,$3,$4)",
            [stayId, n.date, r.rateOverrideMinor ?? n.amount, n.amount],
          );
      }
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
        action: waitlisted ? "Reservation waitlisted" : "Reservation made",
        target: number,
        detail: `${b.arrival} → ${b.departure} · ${rooms.length} room(s) · ${grp ? "group" : b.source}${b.channelId ? " · channel" : ""}`,
      });
      if (!waitlisted)
        await pushAri(
          t,
          op,
          book,
          [...new Set(rooms.map((r) => r.roomTypeId))].map((rt) => ({
            roomTypeId: rt,
            from: b.arrival,
            to: b.departure,
          })),
        );
      return id;
    });
  }

  /**
   * Cancellation or no-show: fee per the rate plan's policy, deposits applied, rooms back on sale.
   * Runs inside `within` when given (the night audit's transaction).
   */
  async function close(op: HotelOp, id: string, kind: "cancel" | "no_show", reason: string, within: Db = db) {
    return within.tx(async (t) => {
      await lockBusinessDate(t, op);
      const r = await repo.reservationRow(t, op.property.id, id, true);
      const stays = (await repo.staysOf(t, id)).filter((s) => s.status === "reserved" || s.status === "waitlisted");
      if (!stays.length) throw fail.conflict("Nothing left to cancel on this reservation");
      if (kind === "no_show" && op.property.business_date < r.arrival)
        throw fail.conflict(`A no-show can be recorded from the arrival date (${r.arrival})`);
      const book = await loadRateBook(t, op.property.id);
      const daysAhead = daysBetween(op.property.business_date, r.arrival);
      let fee = 0;
      for (const s of stays) {
        const plan = book.plans.get(s.rate_plan_id);
        const nights = await t.rows<{ rate_minor: number }>(
          "SELECT rate_minor FROM hotel_stay_nights WHERE stay_id = $1 ORDER BY date",
          [s.id],
        );
        let feeNights = 0;
        if (s.status === "reserved" && plan) {
          if (!plan.refundable) feeNights = nights.length;
          else if (kind === "no_show") feeNights = plan.no_show_fee_nights;
          else if (daysAhead < plan.free_cancel_days) feeNights = plan.cancel_fee_nights;
        }
        fee += nights.slice(0, feeNights).reduce((n, x) => n + x.rate_minor, 0);
        await t.run("UPDATE hotel_stays SET status = $2, room_id = NULL WHERE id = $1", [
          s.id,
          kind === "cancel" ? "cancelled" : "no_show",
        ]);
        if (s.status === "reserved") await giveBack(t, op, s, s.arrival);
      }
      await t.run("UPDATE hotel_reservations SET cancelled_reason = $2 WHERE id = $1", [id, reason]);
      const hasDeposit = !!(await t.row(
        "SELECT 1 FROM hotel_deposits WHERE reservation_id = $1 AND applied_folio_id IS NULL",
        [id],
      ));
      let folioId: string | null = null;
      if (fee > 0 || hasDeposit) {
        folioId = await folios.open(t, op, {
          reservationId: id,
          name: `${r.number} — ${kind === "cancel" ? "cancellation" : "no-show"}`,
          payer: r.corporate_account_id ? "company" : "guest",
          corporateAccountId: r.corporate_account_id,
        });
        if (fee > 0)
          await folios.charge(t, op, folioId, {
            department: "noshow",
            description: kind === "cancel" ? "Cancellation fee (rate plan policy)" : "No-show fee (rate plan policy)",
            net: fee,
          });
        await folios.applyDeposits(t, op, id, folioId);
        const f = await t.row<{ n: number }>(
          "SELECT COALESCE(sum(total_minor), 0)::bigint AS n FROM hotel_folio_lines WHERE folio_id = $1",
          [folioId],
        );
        if ((f?.n ?? 0) === 0) await folios.close(t, op, folioId);
      }
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
        action: kind === "cancel" ? "Reservation cancelled" : "No-show recorded",
        target: r.number,
        detail: `${reason} · fee ${fee}`,
      });
      for (const rt of new Set(stays.filter((s) => s.status === "reserved").map((s) => s.room_type_id)))
        await pushAri(t, op, book, [{ roomTypeId: rt, from: r.arrival, to: r.departure }]);
      return { reservation: await load(t, op.property.id, id), feeMinor: fee, folioId };
    });
  }

  async function toBlock(t: Db, b: BlockRow): Promise<hotel.GroupBlockOut> {
    const nights = await t.rows<{ date: string; held: number; picked: number }>(
      "SELECT date, held, picked FROM hotel_group_block_nights WHERE block_id = $1 ORDER BY date",
      [b.id],
    );
    return {
      id: b.id,
      name: b.name,
      roomTypeId: b.room_type_id,
      ratePlanId: b.rate_plan_id,
      arrival: b.arrival,
      departure: b.departure,
      roomsPerNight: b.rooms_per_night,
      cutoffDate: b.cutoff_date,
      billing: b.billing,
      corporateAccountId: b.corporate_account_id,
      status: b.status,
      masterFolioId: b.master_folio_id,
      nights,
    };
  }

  /** Release the unsold rooms of every open block whose cut-off date is on or before `lastCutoff`. */
  async function releaseCutoffs(t: Db, op: HotelOp, lastCutoff: string) {
    const blocks = await t.rows<BlockRow>(
      "SELECT * FROM hotel_group_blocks WHERE property_id = $1 AND status = 'open' AND cutoff_date <= $2 ORDER BY id FOR UPDATE",
      [op.property.id, lastCutoff],
    );
    const book = await loadRateBook(t, op.property.id);
    const released = [];
    for (const b of blocks) {
      const nights = await t.rows<{ date: string; held: number; picked: number }>(
        "SELECT date, held, picked FROM hotel_group_block_nights WHERE block_id = $1 ORDER BY date FOR UPDATE",
        [b.id],
      );
      let roomNights = 0;
      for (const n of nights) {
        const unsold = n.held - n.picked;
        if (!unsold) continue;
        roomNights += unsold;
        await moveInventory(
          t,
          {
            orgId: op.orgId,
            propertyId: op.property.id,
            roomTypeId: b.room_type_id,
            from: n.date,
            to: addDays(n.date, 1),
            count: unsold,
          },
          "release",
        );
      }
      await t.run("UPDATE hotel_group_block_nights SET held = picked WHERE block_id = $1", [b.id]);
      await t.run("UPDATE hotel_group_blocks SET status = 'released' WHERE id = $1", [b.id]);
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
        action: "Group block released at cut-off",
        target: b.id,
        detail: `${b.name}: ${roomNights} unsold room night(s) back on sale`,
      });
      await pushAri(t, op, book, [{ roomTypeId: b.room_type_id, from: b.arrival, to: b.departure }]);
      released.push({ groupId: b.id, roomNights });
    }
    return released;
  }

  return {
    create,
    load,
    giveBack,
    takeRooms,
    releaseCutoffs,
    cancelOrNoShow: close,

    async list(s: HotelScope, q: z.output<typeof hotel.listReservations.query>) {
      const rows = await db.rows<repo.ReservationRow>(
        `SELECT * FROM hotel_reservations WHERE property_id = $1
           AND ($2::date IS NULL OR departure > $2) AND ($3::date IS NULL OR arrival <= $3)
         ORDER BY arrival, number LIMIT 500`,
        [s.property.id, q.from ?? null, q.to ?? null],
      );
      const out = [];
      for (const r of rows) {
        const res = await repo.toReservation(db, r);
        if (!q.status || res.status === q.status) out.push(res);
      }
      return { reservations: out };
    },

    async confirmWaitlisted(s: HotelScope, id: string) {
      await db.tx(async (t) => {
        const r = await repo.reservationRow(t, s.property.id, id, true);
        const stays = (await repo.staysOf(t, id)).filter((x) => x.status === "waitlisted");
        if (!stays.length) throw fail.conflict("This reservation is not on the waitlist");
        if (r.arrival < s.property.business_date) throw fail.conflict("The arrival date has passed");
        for (const x of stays) {
          await takeRooms(t, s, {
            roomTypeId: x.room_type_id,
            arrival: x.arrival,
            departure: x.departure,
            blockId: null,
          });
          await t.run("UPDATE hotel_stays SET status = 'reserved' WHERE id = $1", [x.id]);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Waitlisted reservation confirmed",
          target: r.number,
        });
        const book = await loadRateBook(t, s.property.id);
        for (const rt of new Set(stays.map((x) => x.room_type_id)))
          await pushAri(t, s, book, [{ roomTypeId: rt, from: r.arrival, to: r.departure }]);
      });
      return load(db, s.property.id, id);
    },

    async createBlock(s: HotelScope, b: z.output<typeof hotel.createGroupBlock.body>) {
      if (b.arrival < s.property.business_date) throw fail.invalid("The block starts before the hotel's business date");
      const id = newId("hgb");
      await db.tx(async (t) => {
        const book = await loadRateBook(t, s.property.id);
        await roomType(t, s.property.id, b.roomTypeId);
        stayPrices(book, b.ratePlanId, b.roomTypeId, b.arrival, b.departure);
        if (
          b.corporateAccountId &&
          !(await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [
            s.orgId,
            b.corporateAccountId,
          ]))
        )
          throw fail.invalid("Unknown company account");
        await moveInventory(
          t,
          {
            orgId: s.orgId,
            propertyId: s.property.id,
            roomTypeId: b.roomTypeId,
            from: b.arrival,
            to: b.departure,
            count: b.roomsPerNight,
          },
          "hold",
        );
        await t.run(
          `INSERT INTO hotel_group_blocks (id, org_id, property_id, name, room_type_id, rate_plan_id, arrival, departure,
             rooms_per_night, cutoff_date, billing, corporate_account_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.name,
            b.roomTypeId,
            b.ratePlanId,
            b.arrival,
            b.departure,
            b.roomsPerNight,
            b.cutoffDate,
            b.billing,
            b.corporateAccountId ?? null,
            s.userId,
          ],
        );
        for (const date of nightsOf(b.arrival, b.departure))
          await t.run("INSERT INTO hotel_group_block_nights (block_id, date, held) VALUES ($1, $2, $3)", [
            id,
            date,
            b.roomsPerNight,
          ]);
        if (b.billing === "master") {
          const folioId = await folios.open(t, s, {
            groupBlockId: id,
            name: `${b.name} — master folio`,
            payer: b.corporateAccountId ? "company" : "guest",
            corporateAccountId: b.corporateAccountId ?? null,
          });
          await t.run("UPDATE hotel_group_blocks SET master_folio_id = $2 WHERE id = $1", [id, folioId]);
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Group block created",
          target: id,
          detail: `${b.name}: ${b.roomsPerNight} room(s) ${b.arrival} → ${b.departure}, cut-off ${b.cutoffDate}`,
        });
        await pushAri(t, s, book, [{ roomTypeId: b.roomTypeId, from: b.arrival, to: b.departure }]);
      });
      return toBlock(db, await block(db, s.property.id, id));
    },

    async listBlocks(s: HotelScope) {
      const rows = await db.rows<BlockRow>(
        "SELECT * FROM hotel_group_blocks WHERE property_id = $1 ORDER BY arrival, id",
        [s.property.id],
      );
      const groups = [];
      for (const b of rows) groups.push(await toBlock(db, b));
      return { groups };
    },

    block,
  };
}

export type ReservationsService = ReturnType<typeof reservationsService>;
