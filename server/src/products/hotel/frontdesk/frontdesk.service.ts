/*
 * Front desk: digital pre-check-in (ID and signature references, deposit held as a liability), room assignment,
 * check-in, room moves, extensions, check-out and guest requests.
 *
 * A room is given only when it is in service, vacant and clean (inspected where the hotel requires it); the
 * database refuses two overlapping stays in one room (hotel_room_not_double_booked).
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import * as folioRepo from "../folios/folios.repo.js";
import type { Lifecycle } from "../guests/lifecycle.js";
import type { SmartRooms } from "../integrations/smart.js";
import type { ReservationsService } from "../reservations/reservations.service.js";
import * as repo from "../reservations/reservations.repo.js";
import type { HotelScope } from "../shared/access.js";
import { moveInventory, queueAri } from "../shared/inventory.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { loadRateBook, stayPrices } from "../shared/rates.js";
import { room as roomRow, type RoomRow } from "../setup/setup.repo.js";

/** The database's double-booking guard, as a clear answer. */
async function guarded<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw fail.conflict(message);
    throw e;
  }
}

export function frontdeskService(
  d: HotelDeps,
  x: { folios: FoliosService; reservations: ReservationsService; smart: SmartRooms; lifecycle: Lifecycle },
) {
  const { core } = d;
  const { db } = core;
  const { folios, reservations, smart, lifecycle } = x;

  /** A stay sold with room features (sea view, high floor …) only takes a room that has every one of them. */
  function checkFeatures(stay: repo.StayRow, r: RoomRow) {
    const missing = stay.requested_attributes.filter((a) => !r.attributes.includes(a));
    if (missing.length) throw fail.conflict(`Room ${r.number} lacks what the guest booked: ${missing.join(", ")}`);
  }

  function checkReady(op: HotelOp, r: RoomRow, roomTypeId: string) {
    if (r.room_type_id !== roomTypeId) throw fail.invalid(`Room ${r.number} is not of the booked room type`);
    if (r.service_status !== "in_service")
      throw fail.conflict(`Room ${r.number} is ${r.service_status.replaceAll("_", " ")}`);
    if (r.occupied) throw fail.conflict(`Room ${r.number} is occupied`);
    const ok = op.property.require_inspection
      ? r.hk_status === "inspected"
      : ["clean", "inspected"].includes(r.hk_status);
    if (!ok)
      throw fail.conflict(
        `Room ${r.number} is ${r.hk_status} — ${op.property.require_inspection ? "an inspected" : "a clean"} room is needed`,
      );
  }

  async function setRoom(t: Db, stay: repo.StayRow, roomId: string, roomNumber: string) {
    await guarded(
      () => t.run("UPDATE hotel_stays SET room_id = $2 WHERE id = $1", [stay.id, roomId]),
      `Room ${roomNumber} is already given to another stay on these dates`,
    );
  }

  return {
    async preCheckIn(s: HotelScope, id: string, b: z.output<typeof hotel.preCheckIn.body>) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const r = await repo.reservationRow(t, s.property.id, id, true);
        if (!(await repo.staysOf(t, id)).some((x) => x.status === "reserved"))
          throw fail.conflict("Only a confirmed reservation can be pre-checked-in");
        await t.run(
          `UPDATE hotel_reservations SET id_captured = true, id_document_ref = $2, nationality = COALESCE($3, nationality),
             signature_ref = $4, arrival_time = COALESCE($5, arrival_time), precheckin_at = now() WHERE id = $1`,
          [id, b.idDocumentRef, b.nationality ?? null, b.signatureRef, b.arrivalTime ?? null],
        );
        if (b.nationality)
          await t.run("UPDATE hotel_guests SET nationality = $2 WHERE id = $1", [r.guest_id, b.nationality]);
        if (b.deposit) {
          const depId = newId("hdp");
          const journalId = await postToLedger(t, core, {
            orgId: s.orgId,
            propertyId: s.property.id,
            date: s.property.business_date,
            kind: "deposit",
            memo: `${r.number} · advance deposit by ${b.deposit.method} (ref ${b.deposit.reference}) — recorded, not processed`,
            ref: `deposit:${depId}`,
            lines: [dr(ACC.bank, b.deposit.amountMinor), cr(ACC.deposits, b.deposit.amountMinor)],
          });
          await t.run(
            `INSERT INTO hotel_deposits (id, org_id, property_id, reservation_id, amount_minor, method, reference, received_date, journal_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              depId,
              s.orgId,
              s.property.id,
              id,
              b.deposit.amountMinor,
              b.deposit.method,
              b.deposit.reference,
              s.property.business_date,
              journalId,
              s.userId,
            ],
          );
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Digital pre-check-in completed",
          target: r.number,
          detail: `ID ${b.idDocumentRef} · signature ${b.signatureRef}${b.deposit ? ` · deposit ${b.deposit.amountMinor}` : ""}`,
        });
      });
      return reservations.load(db, s.property.id, id);
    },

    async assignRoom(s: HotelScope, stayId: string, roomId: string) {
      await db.tx(async (t) => {
        const stay = await repo.stayRow(t, s.property.id, stayId, true);
        if (stay.status !== "reserved") throw fail.conflict(`This stay is ${stay.status.replace("_", " ")}`);
        const r = await roomRow(t, s.property.id, roomId, true);
        if (r.room_type_id !== stay.room_type_id) throw fail.invalid(`Room ${r.number} is not of the booked room type`);
        if (r.service_status === "out_of_order") throw fail.conflict(`Room ${r.number} is out of order`);
        checkFeatures(stay, r);
        await setRoom(t, stay, roomId, r.number);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Room pre-assigned",
          target: stayId,
          detail: r.number,
        });
      });
      return repo.toStay(db, await repo.stayRow(db, s.property.id, stayId));
    },

    async checkIn(s: HotelScope, stayId: string, roomId: string | undefined) {
      const out = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const stay = await repo.stayRow(t, s.property.id, stayId, true);
        if (stay.status !== "reserved") throw fail.conflict(`This stay is ${stay.status.replace("_", " ")}`);
        const bd = s.property.business_date;
        if (stay.arrival > bd) throw fail.conflict(`Arrival is ${stay.arrival}; the hotel's business date is ${bd}`);
        if (stay.departure <= bd) throw fail.conflict("The stay's departure date has passed");
        const id = roomId ?? stay.room_id;
        if (!id) throw fail.invalid("Choose a room");
        const r = await roomRow(t, s.property.id, id, true);
        checkReady(s, r, stay.room_type_id);
        checkFeatures(stay, r);
        if (id !== stay.room_id) await setRoom(t, stay, id, r.number);
        await t.run("UPDATE hotel_stays SET status = 'in_house', checked_in_at = now() WHERE id = $1", [stayId]);
        const res = await repo.reservationRow(t, s.property.id, stay.reservation_id, true);
        const guest = await t.row<{ name: string }>("SELECT name FROM hotel_guests WHERE id = $1", [res.guest_id]);
        const folioId = await folios.open(t, s, {
          reservationId: res.id,
          stayId,
          name: `${guest?.name ?? "Guest"} — room ${r.number}`,
          payer: "guest",
        });
        // company guests: room and tax (and any policy fee) to the company, extras to the guest
        if (res.corporate_account_id) {
          const company = await folios.open(t, s, {
            reservationId: res.id,
            stayId,
            name: `Company billing — room ${r.number}`,
            payer: "company",
            corporateAccountId: res.corporate_account_id,
          });
          await t.run("INSERT INTO hotel_folio_routing (stay_id, department, folio_id) VALUES ($1, 'rooms', $2)", [
            stayId,
            company,
          ]);
        }
        if (res.group_block_id) {
          const g = await reservations.block(t, s.property.id, res.group_block_id);
          if (g.billing === "master" && g.master_folio_id)
            await t.run("INSERT INTO hotel_folio_routing (stay_id, department, folio_id) VALUES ($1, 'rooms', $2)", [
              stayId,
              g.master_folio_id,
            ]);
        }
        await folios.applyDeposits(t, s, res.id, folioId);
        await lifecycle.checkedIn(t, s, { stayId, reservationId: res.id, folioId, room: r.number });
        const key = await smart.issueKey(t, s, stay, r);
        if (r.eco_mode)
          await smart.command(t, s, r, { command: "eco_off", value: null, reason: `Guest checked in (${res.number})` });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guest checked in",
          target: res.number,
          detail: `Room ${r.number}`,
        });
        return { folioId, key };
      });
      return {
        stay: await repo.toStay(db, await repo.stayRow(db, s.property.id, stayId)),
        folio: await folios.get(s.property.id, out.folioId),
        key: out.key,
      };
    },

    async move(s: HotelScope, stayId: string, roomId: string, reason: string) {
      const key = await db.tx(async (t) => {
        const stay = await repo.stayRow(t, s.property.id, stayId, true);
        if (stay.status !== "in_house") throw fail.conflict("Only an in-house guest can be moved");
        if (stay.room_id === roomId) throw fail.invalid("The guest is already in this room");
        const from = await roomRow(t, s.property.id, stay.room_id as string, true);
        const to = await roomRow(t, s.property.id, roomId, true);
        checkReady(s, to, stay.room_type_id);
        checkFeatures(stay, to);
        await setRoom(t, stay, roomId, to.number);
        await t.run("UPDATE hotel_rooms SET hk_status = 'dirty' WHERE id = $1", [from.id]);
        const k = await smart.issueKey(t, s, stay, to);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Room move",
          target: stayId,
          detail: `${from.number} → ${to.number}: ${reason}`,
        });
        return k;
      });
      return { stay: await repo.toStay(db, await repo.stayRow(db, s.property.id, stayId)), key };
    },

    async extend(s: HotelScope, stayId: string, departure: string) {
      await db.tx(async (t) => {
        const stay = await repo.stayRow(t, s.property.id, stayId, true);
        if (!["reserved", "in_house"].includes(stay.status)) throw fail.conflict(`This stay is ${stay.status}`);
        if (departure <= stay.departure) throw fail.invalid("The new departure must be later than the current one");
        const book = await loadRateBook(t, s.property.id);
        const prices = stayPrices(book, stay.rate_plan_id, stay.room_type_id, stay.departure, departure);
        const inv = {
          orgId: s.orgId,
          propertyId: s.property.id,
          roomTypeId: stay.room_type_id,
          from: stay.departure,
          to: departure,
        };
        await moveInventory(t, inv, "sell");
        await guarded(
          () => t.run("UPDATE hotel_stays SET departure = $2 WHERE id = $1", [stayId, departure]),
          `Room ${stay.room_number} is booked by another guest on the extra nights — move the guest first`,
        );
        for (const n of prices)
          await t.run(
            "INSERT INTO hotel_stay_nights (stay_id, date, rate_minor, plan_rate_minor) VALUES ($1,$2,$3,$3)",
            [stayId, n.date, n.amount],
          );
        await t.run("UPDATE hotel_keys SET valid_to = $2 WHERE stay_id = $1 AND status = 'active'", [
          stayId,
          departure,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Stay extended",
          target: stayId,
          detail: `${stay.departure} → ${departure}`,
        });
        await queueAri(t, d.adapters, book, inv);
      });
      return repo.toStay(db, await repo.stayRow(db, s.property.id, stayId));
    },

    async checkOut(s: HotelScope, stayId: string) {
      const out = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const stay = await repo.stayRow(t, s.property.id, stayId, true);
        if (stay.status !== "in_house") throw fail.conflict("Only an in-house guest can check out");
        const open = await t.rows<folioRepo.FolioRow>(
          "SELECT * FROM hotel_folios WHERE stay_id = $1 AND status = 'open' ORDER BY number FOR UPDATE",
          [stayId],
        );
        const problems: string[] = [];
        for (const f of open) {
          const bal = await folioRepo.balance(t, f.id);
          if (f.payer === "guest" && bal > 0) problems.push(`${f.number} owes ${bal}`);
          if (bal < 0) problems.push(`${f.number} holds a credit of ${-bal} — refund it first`);
        }
        if (problems.length) throw fail.conflict(`Folios do not balance: ${problems.join("; ")}`, { folios: problems });
        const cityLedger = [];
        for (const f of open) {
          if (f.payer === "company") {
            const amount = await folios.toCityLedger(t, s, f.id);
            if (amount)
              cityLedger.push({
                folioId: f.id,
                corporateAccountId: f.corporate_account_id as string,
                amountMinor: amount,
              });
          }
          await folios.close(t, s, f.id);
        }
        const bd = s.property.business_date;
        if (bd < stay.departure) {
          // early departure: the unused nights go back on sale
          await reservations.giveBack(t, s, stay, bd);
          await t.run("DELETE FROM hotel_stay_nights WHERE stay_id = $1 AND date >= $2", [stayId, bd]);
          const book = await loadRateBook(t, s.property.id);
          await queueAri(t, d.adapters, book, {
            orgId: s.orgId,
            propertyId: s.property.id,
            roomTypeId: stay.room_type_id,
            from: bd,
            to: stay.departure,
          });
        }
        await t.run("UPDATE hotel_stays SET status = 'checked_out', checked_out_at = now() WHERE id = $1", [stayId]);
        await lifecycle.checkedOut(t, s, stay.reservation_id);
        await t.run("UPDATE hotel_rooms SET hk_status = 'dirty' WHERE id = $1", [stay.room_id]);
        await smart.revokeKeys(t, s, stayId);
        const r = await roomRow(t, s.property.id, stay.room_id as string);
        await smart.command(t, s, r, { command: "eco_on", value: null, reason: "Guest checked out — room empty" });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guest checked out",
          target: stayId,
          detail: `Room ${stay.room_number}${bd < stay.departure ? " (early departure)" : ""}`,
        });
        return cityLedger;
      });
      const stay = await repo.toStay(db, await repo.stayRow(db, s.property.id, stayId));
      const fs = [];
      for (const id of stay.folioIds) fs.push(await folios.get(s.property.id, id));
      return { stay, folios: fs, cityLedger: out };
    },

    // ---------------------------------------------------------------- guest requests
    async listRequests(s: HotelScope, status?: "open" | "done") {
      return {
        requests: (
          await db.rows<RequestRow>(
            "SELECT * FROM hotel_requests WHERE property_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at, id",
            [s.property.id, status ?? null],
          )
        ).map(toRequest),
      };
    },

    async createRequest(s: HotelScope, b: z.output<typeof hotel.createRequest.body>) {
      const id = newId("hrq");
      await db.tx(async (t) => {
        let reservationId: string | null = null;
        if (b.stayId) reservationId = (await repo.stayRow(t, s.property.id, b.stayId)).reservation_id;
        await t.run(
          `INSERT INTO hotel_requests (id, org_id, property_id, stay_id, reservation_id, kind, text, due_at, source, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9)`,
          [id, s.orgId, s.property.id, b.stayId ?? null, reservationId, b.kind, b.text, b.dueAt ?? null, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guest request recorded",
          target: id,
          detail: b.text,
        });
      });
      return toRequest((await db.row<RequestRow>("SELECT * FROM hotel_requests WHERE id = $1", [id])) as RequestRow);
    },

    async completeRequest(s: HotelScope, id: string) {
      await db.tx(async (t) => {
        const r = await t.row<RequestRow>(
          "SELECT * FROM hotel_requests WHERE property_id = $1 AND id = $2 FOR UPDATE",
          [s.property.id, id],
        );
        if (!r) throw fail.notFound("Request not found");
        if (r.status === "done") throw fail.conflict("Already done");
        await t.run("UPDATE hotel_requests SET status = 'done', completed_by = $2 WHERE id = $1", [id, s.userId]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Guest request completed", target: id });
      });
      return toRequest((await db.row<RequestRow>("SELECT * FROM hotel_requests WHERE id = $1", [id])) as RequestRow);
    },
  };
}

export interface RequestRow {
  id: string;
  stay_id: string | null;
  reservation_id: string | null;
  kind: hotel.GuestRequestOut["kind"];
  text: string;
  due_at: string | null;
  status: "open" | "done";
  source: "staff" | "concierge" | "guest";
  created_by: string | null;
  completed_by: string | null;
}

export const toRequest = (r: RequestRow): hotel.GuestRequestOut => ({
  id: r.id,
  stayId: r.stay_id,
  reservationId: r.reservation_id,
  kind: r.kind,
  text: r.text,
  dueAt: r.due_at,
  status: r.status,
  source: r.source,
  createdBy: r.created_by,
  completedBy: r.completed_by,
});

export type FrontdeskService = ReturnType<typeof frontdeskService>;
