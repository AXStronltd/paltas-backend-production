/*
 * Events and meetings: venue spaces, quotes with the event order (room hire, menus, AV), the function sheet
 * (banquet event order) with a version that moves on with every change after the contract, the contract (a document
 * reference — e-signature not connected), deposits (bank 1000 / deposits 2350, recorded not processed) and the final
 * bill: every line charged by department with the hotel's taxes, deposits applied, and a company event sent to the
 * city ledger within its credit limit. A contracted venue is never double-booked (exclusion constraint).
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { ACC } from "../accounts.js";
import type { HotelDeps } from "../deps.js";
import type { FoliosService } from "../folios/folios.service.js";
import * as folioRepo from "../folios/folios.repo.js";
import { at } from "../outlets/outlets.service.js";
import type { HotelScope } from "../shared/access.js";
import { cr, dr, lockBusinessDate, postToLedger } from "../shared/posting.js";
import { group, sumTaxed } from "../shared/settle.js";

interface EventRow {
  id: string;
  number: string;
  name: string;
  corporate_account_id: string | null;
  contact_name: string;
  contact_email: string | null;
  venue_id: string;
  date: string;
  start_time: string;
  end_time: string;
  pax: number;
  setup: hotel.HotelEventOut["setup"];
  status: hotel.HotelEventOut["status"];
  contract_ref: string | null;
  beo_version: number;
  notes: string;
  folio_id: string | null;
}

interface ItemRow {
  id: string;
  kind: "venue_hire" | "fnb" | "av" | "other";
  description: string;
  department: "rooms" | "fnb" | "spa" | "other";
  quantity: number;
  unit_minor: number;
  time_label: string;
  notes: string;
}

type ItemInput = z.output<typeof hotel.createEvent.body>["items"][number];

const SECTIONS: Record<ItemRow["kind"], string> = {
  venue_hire: "Room and set-up",
  fnb: "Food and beverage",
  av: "Audio-visual",
  other: "Other services",
};

export function eventsService(d: HotelDeps, x: { folios: FoliosService }) {
  const { core } = d;
  const { db } = core;
  const { folios } = x;

  async function eventRow(t: Db, propertyId: string, id: string, lock = false): Promise<EventRow> {
    const e = await t.row<EventRow>(
      `SELECT * FROM hotel_events WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [propertyId, id],
    );
    if (!e) throw fail.notFound("Event not found");
    return e;
  }

  const items = (t: Db, eventId: string) =>
    t.rows<ItemRow>("SELECT * FROM hotel_event_items WHERE event_id = $1 ORDER BY seq", [eventId]);

  async function toEvent(t: Db, s: HotelScope, e: EventRow): Promise<hotel.HotelEventOut> {
    const its = await items(t, e.id);
    const deps = await t.rows<{
      id: string;
      amount_minor: number;
      method: hotel.PaymentMethod;
      reference: string;
      received_date: string;
      applied_line_id: string | null;
    }>("SELECT * FROM hotel_event_deposits WHERE event_id = $1 ORDER BY received_date, id", [e.id]);
    const lines = its.map((i) => ({
      department: i.department,
      description: i.description,
      net: i.quantity * i.unit_minor,
    }));
    return {
      id: e.id,
      number: e.number,
      name: e.name,
      corporateAccountId: e.corporate_account_id,
      contactName: e.contact_name,
      contactEmail: e.contact_email,
      venueId: e.venue_id,
      date: e.date,
      start: e.start_time,
      end: e.end_time,
      pax: e.pax,
      setup: e.setup,
      status: e.status,
      contractRef: e.contract_ref,
      beoVersion: e.beo_version,
      notes: e.notes,
      items: its.map((i) => ({
        id: i.id,
        kind: i.kind,
        description: i.description,
        department: i.department,
        quantity: i.quantity,
        unitMinor: i.unit_minor,
        netMinor: i.quantity * i.unit_minor,
        timeLabel: i.time_label,
        notes: i.notes,
      })),
      netMinor: lines.reduce((n, l) => n + l.net, 0),
      estimatedTotalMinor: lines.length ? sumTaxed(s.property, lines) : 0,
      deposits: deps.map((x) => ({
        id: x.id,
        amountMinor: x.amount_minor,
        method: x.method,
        reference: x.reference,
        receivedOn: x.received_date,
        applied: !!x.applied_line_id,
      })),
      folioId: e.folio_id,
    };
  }

  const load = async (s: HotelScope, id: string) => toEvent(db, s, await eventRow(db, s.property.id, id));

  async function venue(t: Db, s: HotelScope, id: string, pax: number) {
    const v = await t.row<{ name: string; capacity: number; active: boolean }>(
      "SELECT name, capacity, active FROM hotel_venues WHERE property_id = $1 AND id = $2",
      [s.property.id, id],
    );
    if (!v?.active) throw fail.notFound("Venue not found");
    if (pax > v.capacity) throw fail.invalid(`${v.name} holds ${v.capacity}`);
    return v;
  }

  async function writeItems(t: Db, eventId: string, list: ItemInput[]) {
    await t.run("DELETE FROM hotel_event_items WHERE event_id = $1", [eventId]);
    for (const i of list)
      await t.run(
        `INSERT INTO hotel_event_items (id, event_id, kind, description, department, quantity, unit_minor, time_label, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId("hei"), eventId, i.kind, i.description, i.department, i.quantity, i.unitMinor, i.timeLabel, i.notes],
      );
  }

  /** The venue guard of the database, as a clear answer. */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string }).code === "23P01")
        throw fail.conflict("The venue is already contracted to another event at that time");
      throw e;
    }
  }

  return {
    async listVenues(s: HotelScope) {
      const rows = await db.rows<{ id: string; code: string; name: string; capacity: number; active: boolean }>(
        "SELECT * FROM hotel_venues WHERE property_id = $1 ORDER BY code",
        [s.property.id],
      );
      return {
        venues: rows.map((v) => ({ id: v.id, code: v.code, name: v.name, capacity: v.capacity, active: v.active })),
      };
    },

    async createVenue(s: HotelScope, b: { code: string; name: string; capacity: number }) {
      const id = newId("hvn");
      await db.tx(async (t) => {
        if (await t.row("SELECT 1 FROM hotel_venues WHERE property_id = $1 AND code = $2", [s.property.id, b.code]))
          throw fail.conflict(`Venue ${b.code} already exists`);
        await t.run(
          "INSERT INTO hotel_venues (id, org_id, property_id, code, name, capacity) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, s.orgId, s.property.id, b.code, b.name, b.capacity],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Venue added", target: b.code });
      });
      return { id, code: b.code, name: b.name, capacity: b.capacity, active: true };
    },

    async create(s: HotelScope, b: z.output<typeof hotel.createEvent.body>) {
      const id = newId("hev");
      await db.tx(async (t) => {
        await venue(t, s, b.venueId, b.pax);
        if (b.date < s.property.business_date) throw fail.invalid("That date has passed");
        if (
          b.corporateAccountId &&
          !(await t.row("SELECT 1 FROM hotel_corporate_accounts WHERE org_id = $1 AND id = $2", [
            s.orgId,
            b.corporateAccountId,
          ]))
        )
          throw fail.invalid("Unknown company account");
        const number = await nextNumber(t, s.orgId, "EVT", 5);
        await t.run(
          `INSERT INTO hotel_events (id, org_id, property_id, number, name, corporate_account_id, contact_name, contact_email,
             venue_id, date, start_time, end_time, starts_at, ends_at, pax, setup, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            id,
            s.orgId,
            s.property.id,
            number,
            b.name,
            b.corporateAccountId ?? null,
            b.contactName,
            b.contactEmail ?? null,
            b.venueId,
            b.date,
            b.start,
            b.end,
            at(b.date, b.start),
            at(b.date, b.end),
            b.pax,
            b.setup,
            b.notes,
            s.userId,
          ],
        );
        await writeItems(t, id, b.items);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Event quoted",
          target: number,
          detail: b.name,
        });
      });
      return load(s, id);
    },

    async list(s: HotelScope, q: { from?: string | undefined; to?: string | undefined }) {
      const rows = await db.rows<EventRow>(
        `SELECT * FROM hotel_events WHERE property_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
         ORDER BY date, start_time, number`,
        [s.property.id, q.from ?? null, q.to ?? null],
      );
      const events = [];
      for (const e of rows) events.push(await toEvent(db, s, e));
      return { events };
    },

    get: load,

    async setItems(s: HotelScope, id: string, b: { items: ItemInput[]; pax?: number | undefined }) {
      await db.tx(async (t) => {
        const e = await eventRow(t, s.property.id, id, true);
        if (!["quote", "contract"].includes(e.status)) throw fail.conflict(`Event ${e.number} is ${e.status}`);
        if (b.pax) await venue(t, s, e.venue_id, b.pax);
        await writeItems(t, id, b.items);
        await t.run("UPDATE hotel_events SET pax = COALESCE($2, pax), beo_version = beo_version + $3 WHERE id = $1", [
          id,
          b.pax ?? null,
          e.status === "contract" ? 1 : 0,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Event order changed",
          target: e.number,
          detail: e.status === "contract" ? `Function sheet version ${e.beo_version + 1}` : "Quote revised",
        });
      });
      return load(s, id);
    },

    async contract(s: HotelScope, id: string, contractRef: string) {
      await db.tx(async (t) => {
        const e = await eventRow(t, s.property.id, id, true);
        if (e.status !== "quote") throw fail.conflict(`Event ${e.number} is ${e.status}`);
        if (!(await items(t, id)).length) throw fail.conflict("Price the event order before the contract");
        await guarded(() =>
          t.run("UPDATE hotel_events SET status = 'contract', contract_ref = $2 WHERE id = $1", [id, contractRef]),
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Event contracted",
          target: e.number,
          detail: contractRef,
        });
      });
      return load(s, id);
    },

    async deposit(
      s: HotelScope,
      id: string,
      b: { amountMinor: number; method: hotel.PaymentMethod; reference: string },
    ) {
      await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const e = await eventRow(t, s.property.id, id, true);
        if (e.status !== "contract") throw fail.conflict("Deposits are taken on a contracted event");
        const depId = newId("hed");
        const journalId = await postToLedger(t, core, {
          orgId: s.orgId,
          propertyId: s.property.id,
          date: s.property.business_date,
          kind: "event_deposit",
          memo: `${e.number} ${e.name} · event deposit by ${b.method} (ref ${b.reference}) — recorded, not processed`,
          ref: `event-deposit:${depId}`,
          lines: [dr(ACC.bank, b.amountMinor), cr(ACC.deposits, b.amountMinor)],
        });
        await t.run(
          `INSERT INTO hotel_event_deposits (id, org_id, property_id, event_id, amount_minor, method, reference, received_date,
             journal_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            depId,
            s.orgId,
            s.property.id,
            id,
            b.amountMinor,
            b.method,
            b.reference,
            s.property.business_date,
            journalId,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Event deposit recorded",
          target: e.number,
          detail: `${b.amountMinor}`,
        });
      });
      return load(s, id);
    },

    async bill(s: HotelScope, id: string) {
      const folioId = await db.tx(async (t) => {
        await lockBusinessDate(t, s);
        const e = await eventRow(t, s.property.id, id, true);
        if (e.status !== "contract")
          throw fail.conflict(`Only a contracted event is billed (${e.number} is ${e.status})`);
        const its = await items(t, id);
        const fid = await folios.open(t, s, {
          name: `Event ${e.number} · ${e.name}`,
          payer: e.corporate_account_id ? "company" : "guest",
          corporateAccountId: e.corporate_account_id,
        });
        for (const l of group(
          its.map((i) => ({
            department: i.department,
            description: `${e.name}: ${i.description}`,
            net: i.quantity * i.unit_minor,
          })),
        ))
          await folios.charge(t, s, fid, { department: l.department, description: l.description, net: l.net });
        const deps = await t.rows<{ id: string; amount_minor: number; method: hotel.PaymentMethod; reference: string }>(
          "SELECT * FROM hotel_event_deposits WHERE event_id = $1 AND applied_line_id IS NULL ORDER BY received_date, id FOR UPDATE",
          [id],
        );
        for (const dep of deps) {
          const lineId = newId("hfl");
          const journalId = await postToLedger(t, core, {
            orgId: s.orgId,
            propertyId: s.property.id,
            date: s.property.business_date,
            kind: "deposit_applied",
            memo: `Event deposit applied to ${e.number} (ref ${dep.reference})`,
            ref: `event-deposit-applied:${dep.id}`,
            lines: [dr(ACC.deposits, dep.amount_minor), cr(ACC.guestLedger, dep.amount_minor)],
          });
          await folios.insertLine(t, s, fid, {
            id: lineId,
            kind: "deposit",
            description: "Event deposit applied",
            net: -dep.amount_minor,
            method: dep.method,
            reference: dep.reference,
            journalId,
          });
          await t.run("UPDATE hotel_event_deposits SET applied_line_id = $2 WHERE id = $1", [dep.id, lineId]);
        }
        if (e.corporate_account_id) await folios.toCityLedger(t, s, fid);
        if ((await folioRepo.balance(t, fid)) === 0) await folios.close(t, s, fid);
        await t.run("UPDATE hotel_events SET status = 'billed', folio_id = $2 WHERE id = $1", [id, fid]);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Event billed", target: e.number, detail: fid });
        return fid;
      });
      return { event: await load(s, id), folio: await folios.get(s.property.id, folioId) };
    },

    async cancel(s: HotelScope, id: string, reason: string) {
      await db.tx(async (t) => {
        const e = await eventRow(t, s.property.id, id, true);
        if (!["quote", "contract"].includes(e.status)) throw fail.conflict(`Event ${e.number} is ${e.status}`);
        if (await t.row("SELECT 1 FROM hotel_event_deposits WHERE event_id = $1", [id]))
          throw fail.conflict("The event holds a deposit — bill a cancellation charge instead");
        await t.run("UPDATE hotel_events SET status = 'cancelled', cancel_reason = $2 WHERE id = $1", [id, reason]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Event cancelled",
          target: e.number,
          detail: reason,
        });
      });
      return load(s, id);
    },

    async functionSheet(s: HotelScope, id: string) {
      const e = await eventRow(db, s.property.id, id);
      const its = await items(db, id);
      const v = await db.row<{ name: string }>("SELECT name FROM hotel_venues WHERE id = $1", [e.venue_id]);
      const client = e.corporate_account_id
        ? ((
            await db.row<{ name: string }>("SELECT name FROM hotel_corporate_accounts WHERE id = $1", [
              e.corporate_account_id,
            ])
          )?.name ?? e.contact_name)
        : e.contact_name;
      const sections = (Object.keys(SECTIONS) as ItemRow["kind"][])
        .map((k) => ({
          kind: k,
          title: SECTIONS[k],
          lines: its
            .filter((i) => i.kind === k)
            .sort((a, b) => a.time_label.localeCompare(b.time_label))
            .map((i) => ({ time: i.time_label, description: i.description, quantity: i.quantity, notes: i.notes })),
        }))
        .filter((x) => x.lines.length);
      return {
        eventId: e.id,
        number: e.number,
        version: e.beo_version,
        name: e.name,
        client,
        venue: v?.name ?? "",
        date: e.date,
        start: e.start_time,
        end: e.end_time,
        pax: e.pax,
        setup: e.setup,
        sections,
        notes: e.notes,
      };
    },

    async diary(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<EventRow & { venue: string }>(
        `SELECT e.*, v.name AS venue FROM hotel_events e JOIN hotel_venues v ON v.id = e.venue_id
         WHERE e.property_id = $1 AND e.date BETWEEN $2 AND $3 AND e.status <> 'cancelled' ORDER BY e.date, e.start_time, v.code`,
        [s.property.id, from, to],
      );
      const days = [...new Set(rows.map((r) => r.date))].map((date) => ({
        date,
        events: rows
          .filter((r) => r.date === date)
          .map((r) => ({
            eventId: r.id,
            name: r.name,
            venueId: r.venue_id,
            venue: r.venue,
            start: r.start_time,
            end: r.end_time,
            pax: r.pax,
            status: r.status,
          })),
      }));
      return { days };
    },
  };
}

export type EventsService = ReturnType<typeof eventsService>;
