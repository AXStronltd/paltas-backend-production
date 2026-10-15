/*
 * Smart-room records: mobile keys (door-lock boundary) and room-control commands (energy boundary). Each record
 * says which adapter handled it; with the test adapter nothing reaches a lock or a thermostat.
 */
import type { hotel } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { newId } from "../../../lib/ids.js";
import type { HotelOp } from "../deps.js";
import type { HotelAdapters } from "./adapters.js";

interface KeyRow {
  id: string;
  stay_id: string;
  room_id: string;
  valid_from: string;
  valid_to: string;
  status: "active" | "revoked";
  adapter_ref: string;
}

interface CommandRow {
  id: string;
  room_id: string;
  room_number: string;
  command: "eco_on" | "eco_off" | "set_temperature";
  value: number | null;
  reason: string;
  status: string;
  created_at: string;
}

export function smartRooms(adapters: HotelAdapters) {
  const toKey = (k: KeyRow): hotel.KeyOut => ({
    id: k.id,
    stayId: k.stay_id,
    roomId: k.room_id,
    validFrom: k.valid_from,
    validTo: k.valid_to,
    status: k.status,
    adapterRef: k.adapter_ref,
    integration: adapters.locks.state,
  });

  const toCommand = (c: CommandRow): hotel.RoomCommandOut => ({
    id: c.id,
    roomId: c.room_id,
    roomNumber: c.room_number,
    command: c.command,
    value: c.value,
    reason: c.reason,
    integration: { ...adapters.roomControls.state, status: c.status },
    at: c.created_at,
  });

  async function revokeKeys(t: Db, op: HotelOp, stayId: string): Promise<number> {
    const keys = await t.rows<KeyRow>("SELECT * FROM hotel_keys WHERE stay_id = $1 AND status = 'active' FOR UPDATE", [
      stayId,
    ]);
    for (const k of keys) {
      adapters.locks.revoke(k.adapter_ref);
      await t.run("UPDATE hotel_keys SET status = 'revoked', revoked_at = now() WHERE id = $1", [k.id]);
    }
    if (keys.length)
      await recordAudit(t, {
        actor: op.actor,
        orgId: op.orgId,
        action: "Mobile key(s) revoked",
        target: stayId,
        detail: `${keys.length} key(s) · ${adapters.locks.state.status}`,
      });
    return keys.length;
  }

  async function issueKey(
    t: Db,
    op: HotelOp,
    stay: { id: string; departure: string },
    room: { id: string; number: string },
  ): Promise<hotel.KeyOut> {
    await revokeKeys(t, op, stay.id);
    const id = newId("hky");
    const validFrom = op.property.business_date;
    const { ref } = adapters.locks.issue({ id, roomNumber: room.number, validFrom, validTo: stay.departure });
    await t.run(
      `INSERT INTO hotel_keys (id, org_id, property_id, stay_id, room_id, valid_from, valid_to, adapter, adapter_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, op.orgId, op.property.id, stay.id, room.id, validFrom, stay.departure, adapters.locks.state.adapter, ref],
    );
    await recordAudit(t, {
      actor: op.actor,
      orgId: op.orgId,
      action: "Mobile key issued",
      target: stay.id,
      detail: `Room ${room.number} until ${stay.departure} · ${adapters.locks.state.status}`,
    });
    return toKey((await t.row<KeyRow>("SELECT * FROM hotel_keys WHERE id = $1", [id])) as KeyRow);
  }

  async function command(
    t: Db,
    op: HotelOp,
    room: { id: string; number: string },
    c: { command: "eco_on" | "eco_off" | "set_temperature"; value: number | null; reason: string },
  ): Promise<hotel.RoomCommandOut> {
    const status = adapters.roomControls.send({ roomNumber: room.number, command: c.command, value: c.value });
    const id = newId("hcm");
    await t.run(
      `INSERT INTO hotel_room_commands (id, org_id, property_id, room_id, command, value, reason, adapter, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        op.orgId,
        op.property.id,
        room.id,
        c.command,
        c.value,
        c.reason,
        adapters.roomControls.state.adapter,
        status,
      ],
    );
    if (c.command !== "set_temperature")
      await t.run("UPDATE hotel_rooms SET eco_mode = $2 WHERE id = $1", [room.id, c.command === "eco_on"]);
    return toCommand(
      (await t.row<CommandRow>(
        "SELECT c.*, r.number AS room_number FROM hotel_room_commands c JOIN hotel_rooms r ON r.id = c.room_id WHERE c.id = $1",
        [id],
      )) as CommandRow,
    );
  }

  async function keysOf(db: Db, stayId: string): Promise<hotel.KeyOut[]> {
    return (await db.rows<KeyRow>("SELECT * FROM hotel_keys WHERE stay_id = $1 ORDER BY issued_at, id", [stayId])).map(
      toKey,
    );
  }

  async function commands(db: Db, propertyId: string): Promise<hotel.RoomCommandOut[]> {
    return (
      await db.rows<CommandRow>(
        `SELECT c.*, r.number AS room_number FROM hotel_room_commands c JOIN hotel_rooms r ON r.id = c.room_id
         WHERE c.property_id = $1 ORDER BY c.seq DESC LIMIT 500`,
        [propertyId],
      )
    ).map(toCommand);
  }

  async function key(db: Db, propertyId: string, id: string): Promise<KeyRow | null> {
    return db.row<KeyRow>("SELECT * FROM hotel_keys WHERE property_id = $1 AND id = $2", [propertyId, id]);
  }

  return { issueKey, revokeKeys, command, keysOf, commands, key };
}

export type SmartRooms = ReturnType<typeof smartRooms>;
