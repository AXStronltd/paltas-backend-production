/*
 * The hotel's integration boundaries, as the API sees them: adapter status, the channel-manager queue and its
 * signed booking webhook, mobile keys, room controls / energy rules, the rule-based concierge and guest messages.
 * Nothing here pretends an external system acted: every answer names the adapter and its status.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit, SYSTEM } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps, HotelOp } from "../deps.js";
import type { ReservationsService } from "../reservations/reservations.service.js";
import * as resRepo from "../reservations/reservations.repo.js";
import type { HotelScope } from "../shared/access.js";
import { recordMessage, toMessage, type MessageRow } from "../shared/outbox.js";
import { findProperty } from "../shared/property.js";
import { rooms as roomRows } from "../setup/setup.repo.js";
import type { SmartRooms } from "./smart.js";

/** Lower-case words of a text, for matching concierge keywords. */
const normalise = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;

export function integrationsService(d: HotelDeps, x: { reservations: ReservationsService; smart: SmartRooms }) {
  const { core, adapters } = d;
  const { db } = core;
  const { reservations, smart } = x;

  async function message(
    t: Db,
    op: HotelOp,
    m: {
      reservationId: string | null;
      channel: hotel.MessageOut["channel"];
      direction: "inbound" | "outbound";
      body: string;
    },
  ): Promise<string> {
    return (await recordMessage(t, d, op, m)) as string;
  }

  return {
    status(): { adapters: hotel.IntegrationAdapterOut[] } {
      return {
        adapters: [
          {
            kind: "channel_manager",
            ...adapters.channels.state,
            note: "Availability and rate updates are queued, not transmitted. Bookings arrive through the signed webhook.",
          },
          {
            kind: "door_locks",
            ...adapters.locks.state,
            note: "Mobile keys are recorded with their validity; no lock is programmed.",
          },
          {
            kind: "room_controls",
            ...adapters.roomControls.state,
            note: "Eco mode and temperature commands are recorded, not sent.",
          },
          { kind: "messaging", ...adapters.messaging.state, note: "Guest messages are recorded, not sent." },
          {
            kind: "payments",
            adapter: "none",
            connected: false,
            status: "Not connected — payments are recorded only",
            note: "Guests pay through the hotel's own provider and bank; PALTAS records and reconciles.",
          },
          {
            kind: "ai_concierge",
            adapter: "rules",
            connected: true,
            status: "Rule-based answers from the hotel's own FAQ — no external AI",
            note: "Unknown questions are handed to staff as a task.",
          },
          {
            kind: "e_invoicing",
            ...adapters.einvoicing.state,
            note: "Tax invoices are issued and numbered here; submission to the tax authority waits for a certified adapter.",
          },
          {
            kind: "kitchen_printers",
            ...adapters.kitchenPrinters.state,
            note: "Orders appear on the kitchen screen; nothing is printed.",
          },
          {
            kind: "review_sites",
            ...adapters.reviewSites.state,
            note: "Surveys are internal; no review-site invitations.",
          },
          {
            kind: "fx_rates",
            ...adapters.fxRates.state,
            note: "Foreign-currency payments use the day's rate staff enter.",
          },
          {
            kind: "rate_shopping",
            ...adapters.rateShopping.state,
            note: "No competitor rate or benchmark feed: revenue suggestions use the hotel's own bookings.",
          },
          {
            kind: "payroll_engine",
            ...adapters.payrollEngine.state,
            note: "Gross pay, tips and service charge are prepared here; statutory deductions need a payroll engine.",
          },
          { kind: "sensors", ...adapters.sensors.state, note: "Meter readings are entered by staff." },
          {
            kind: "chain_loyalty",
            ...adapters.chainLoyalty.state,
            note: "Points, tiers and member rates run in PALTAS.",
          },
        ],
      };
    },

    async ariQueue(s: HotelScope, channelId?: string) {
      const rows = await db.rows<{
        id: string;
        channel_id: string;
        room_type_id: string;
        date_from: string;
        date_to: string;
        payload: hotel.AriMessageOut["days"];
        status: string;
        created_at: string;
      }>(
        `SELECT * FROM hotel_ari_outbox WHERE property_id = $1 AND ($2::text IS NULL OR channel_id = $2)
         ORDER BY seq DESC LIMIT 500`,
        [s.property.id, channelId ?? null],
      );
      return {
        messages: rows.map((r) => ({
          id: r.id,
          channelId: r.channel_id,
          roomTypeId: r.room_type_id,
          from: r.date_from,
          to: r.date_to,
          days: r.payload,
          status: r.status,
          at: r.created_at,
        })),
      };
    },

    /** A signed booking from the channel manager. The same booking delivered twice is taken once. */
    async channelBooking(provider: string, b: z.output<typeof hotel.channelBooking.body>) {
      const property = await findProperty(db, b.orgId, b.propertyId).catch(() => null);
      if (!property) throw fail.notFound("Unknown hotel");
      const channel = await db.row<{ id: string; provider: string; active: boolean }>(
        "SELECT id, provider, active FROM hotel_channels WHERE property_id = $1 AND code = $2",
        [property.id, b.channelCode],
      );
      // a provider can only deliver bookings for the channels connected through it
      if (!channel || channel.provider !== provider || !channel.active) throw fail.notFound("Unknown channel");
      const existing = await db.row<{ id: string; number: string }>(
        "SELECT id, number FROM hotel_reservations WHERE channel_id = $1 AND external_ref = $2",
        [channel.id, b.externalRef],
      );
      if (existing) return { reservationId: existing.id, number: existing.number, duplicate: true };
      const op: HotelOp = { orgId: b.orgId, userId: null, actor: { ...SYSTEM, role: `channel:${provider}` }, property };
      const id = await reservations.create(
        op,
        {
          guest: b.guest,
          arrival: b.arrival,
          departure: b.departure,
          rooms: [{ roomTypeId: b.roomTypeId, ratePlanId: b.ratePlanId, adults: b.adults, children: b.children }],
          source: "channel",
          channelId: channel.id,
          specialRequests: "",
          waitlist: false,
        },
        { externalRef: b.externalRef },
      );
      const r = await resRepo.reservationRow(db, property.id, id);
      return { reservationId: id, number: r.number, duplicate: false };
    },

    async keys(s: HotelScope, stayId: string) {
      await resRepo.stayRow(db, s.property.id, stayId);
      return { keys: await smart.keysOf(db, stayId) };
    },

    async checkKey(s: HotelScope, keyId: string, roomId: string, date: string) {
      const k = await smart.key(db, s.property.id, keyId);
      if (!k) throw fail.notFound("Key not found");
      const r = adapters.locks.opens(
        { status: k.status, roomId: k.room_id, validFrom: k.valid_from, validTo: k.valid_to },
        roomId,
        date,
      );
      return { ...r, integration: adapters.locks.state };
    },

    /** Energy rules for the business date: eco for empty rooms with no arrival, welcome temperature for arrivals. */
    async runEnergy(s: HotelScope) {
      const bd = s.property.business_date;
      return db.tx(async (t) => {
        const arriving = new Set(
          (
            await t.rows<{ room_id: string }>(
              "SELECT room_id FROM hotel_stays WHERE property_id = $1 AND status = 'reserved' AND arrival = $2 AND room_id IS NOT NULL",
              [s.property.id, bd],
            )
          ).map((r) => r.room_id),
        );
        const commands = [];
        for (const r of await roomRows(t, s.property.id)) {
          if (r.occupied) continue;
          if (arriving.has(r.id)) {
            commands.push(
              await smart.command(t, s, r, {
                command: "set_temperature",
                value: Number(s.property.welcome_temp_c),
                reason: `Welcome temperature before today's arrival`,
              }),
            );
            if (r.eco_mode)
              commands.push(await smart.command(t, s, r, { command: "eco_off", value: null, reason: "Arrival today" }));
          } else if (!r.eco_mode) {
            commands.push(
              await smart.command(t, s, r, { command: "eco_on", value: null, reason: "Vacant and unsold for tonight" }),
            );
          }
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Energy rules run",
          target: s.property.id,
          detail: `${commands.length} command(s) · ${adapters.roomControls.state.status}`,
        });
        return { commands };
      });
    },

    commands: async (s: HotelScope) => ({ commands: await smart.commands(db, s.property.id) }),

    /** Answer from the hotel's FAQ; otherwise hand over to staff as a task. No external AI is involved. */
    async ask(s: HotelScope, b: z.output<typeof hotel.askConcierge.body>) {
      if (b.reservationId) await resRepo.reservationRow(db, s.property.id, b.reservationId);
      const text = normalise(b.question);
      const hit = s.property.faq.find((f) => f.keywords.some((k) => text.includes(normalise(k))));
      return db.tx(async (t) => {
        await message(t, s, {
          reservationId: b.reservationId ?? null,
          channel: b.channel,
          direction: "inbound",
          body: b.question,
        });
        if (hit) {
          await message(t, s, {
            reservationId: b.reservationId ?? null,
            channel: b.channel,
            direction: "outbound",
            body: hit.answer,
          });
          return { answered: true, answer: hit.answer, handoffRequestId: null };
        }
        const id = newId("hrq");
        await t.run(
          `INSERT INTO hotel_requests (id, org_id, property_id, reservation_id, kind, text, source, created_by)
           VALUES ($1,$2,$3,$4,'handoff',$5,'concierge',$6)`,
          [id, s.orgId, s.property.id, b.reservationId ?? null, `Guest asked: ${b.question}`, s.userId],
        );
        const answer = "Thank you — a member of our team will reply shortly.";
        await message(t, s, {
          reservationId: b.reservationId ?? null,
          channel: b.channel,
          direction: "outbound",
          body: answer,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Concierge handed over to staff",
          target: id,
          detail: b.question,
        });
        return { answered: false, answer, handoffRequestId: id };
      });
    },

    async messages(s: HotelScope, reservationId?: string) {
      const rows = await db.rows<MessageRow>(
        `SELECT * FROM hotel_messages WHERE property_id = $1 AND ($2::text IS NULL OR reservation_id = $2)
         ORDER BY seq LIMIT 500`,
        [s.property.id, reservationId ?? null],
      );
      return { messages: rows.map(toMessage) };
    },

    async send(s: HotelScope, b: z.output<typeof hotel.sendMessage.body>) {
      await resRepo.reservationRow(db, s.property.id, b.reservationId);
      const id = await db.tx(async (t) => {
        const mid = await message(t, s, {
          reservationId: b.reservationId,
          channel: b.channel,
          direction: "outbound",
          body: b.body,
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guest message recorded",
          target: mid,
          detail: b.channel,
        });
        return mid;
      });
      return toMessage((await db.row<MessageRow>("SELECT * FROM hotel_messages WHERE id = $1", [id])) as MessageRow);
    },
  };
}

export type IntegrationsService = ReturnType<typeof integrationsService>;
