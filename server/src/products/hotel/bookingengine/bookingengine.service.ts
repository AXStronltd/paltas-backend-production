/*
 * The direct booking engine on top of the ONE availability record:
 *   - promo codes: a percentage off the nightly rate for stay dates, plans and a number of uses (the use count is
 *     taken under a row lock inside the booking, so the last use cannot be sold twice);
 *   - member rates: a loyalty member's tier discount; a booking gets the better of the promo and the member rate,
 *     never both. Discounted nights carry their reason, so the income audit lists them as DISCOUNT, not as a rate
 *     below plan;
 *   - attribute-based selling: features (sea view, high floor …) priced per night; a room with every chosen feature
 *     is held for the stay at booking, and the fee is charged with each night;
 *   - upsells (breakfast, transfer, late check-out …) priced per stay, per night or per adult per night, charged to
 *     the guest folio at check-in.
 */
import type { hotel, z } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps } from "../deps.js";
import { memberDiscountBp } from "../guests/loyalty.js";
import type { ReservationsService } from "../reservations/reservations.service.js";
import type { HotelScope } from "../shared/access.js";
import { daysBetween, nightsOf } from "../shared/dates.js";
import { fromBp, toBp } from "../shared/property.js";
import { loadRateBook, stayPrices } from "../shared/rates.js";

interface PromoRow {
  id: string;
  code: string;
  description: string;
  discount_bp: number;
  stay_from: string | null;
  stay_to: string | null;
  min_nights: number;
  max_uses: number | null;
  uses: number;
  rate_plan_ids: string[];
  active: boolean;
}

interface UpsellRow {
  id: string;
  code: string;
  name: string;
  department: "rooms" | "fnb" | "spa" | "other";
  pricing: "per_stay" | "per_night" | "per_adult_night";
  amount_minor: number;
  active: boolean;
}

const toPromo = (p: PromoRow): hotel.PromoCodeOut => ({
  id: p.id,
  code: p.code,
  description: p.description,
  discountPct: fromBp(p.discount_bp),
  stayFrom: p.stay_from,
  stayTo: p.stay_to,
  minNights: p.min_nights,
  maxUses: p.max_uses,
  uses: p.uses,
  ratePlanIds: p.rate_plan_ids,
  active: p.active,
});

const toUpsell = (u: UpsellRow): hotel.UpsellOut => ({
  id: u.id,
  code: u.code,
  name: u.name,
  department: u.department,
  pricing: u.pricing,
  amountMinor: u.amount_minor,
  active: u.active,
});

type QuoteInput = z.output<typeof hotel.bookingQuote.body>;

export function bookingEngineService(d: HotelDeps, x: { reservations: ReservationsService }) {
  const { db } = d.core;
  const { reservations } = x;

  async function promoRow(t: Db, propertyId: string, id: string): Promise<PromoRow> {
    const p = await t.row<PromoRow>("SELECT * FROM hotel_promo_codes WHERE property_id = $1 AND id = $2", [
      propertyId,
      id,
    ]);
    if (!p) throw fail.notFound("Promo code not found");
    return p;
  }

  /** A promo code that applies to this booking, or a clear refusal. */
  async function validPromo(t: Db, s: HotelScope, q: QuoteInput, lock = false): Promise<PromoRow> {
    const p = await t.row<PromoRow>(
      `SELECT * FROM hotel_promo_codes WHERE property_id = $1 AND upper(code) = upper($2)${lock ? " FOR UPDATE" : ""}`,
      [s.property.id, q.promoCode],
    );
    if (!p || !p.active) throw fail.invalid(`Promo code ${q.promoCode} is not valid`);
    const nights = nightsOf(q.arrival, q.departure);
    if (nights.length < p.min_nights)
      throw fail.invalid(`Promo code ${p.code} needs at least ${p.min_nights} night(s)`);
    if ((p.stay_from && q.arrival < p.stay_from) || (p.stay_to && (nights.at(-1) as string) > p.stay_to))
      throw fail.invalid(
        `Promo code ${p.code} is for stays from ${p.stay_from ?? "now"} to ${p.stay_to ?? "any date"}`,
      );
    if (p.max_uses != null && p.uses >= p.max_uses) throw fail.invalid(`Promo code ${p.code} has been fully used`);
    if (p.rate_plan_ids.length && q.rooms.some((r) => !p.rate_plan_ids.includes(r.ratePlanId)))
      throw fail.invalid(`Promo code ${p.code} does not apply to this rate plan`);
    return p;
  }

  /** The guest profile a booking would use (returning guests are recognised the same way as at booking). */
  async function knownGuest(t: Db, orgId: string, g?: z.output<typeof hotel.GuestInput>): Promise<string | null> {
    if (!g) return null;
    const r = await t.row<{ id: string }>(
      `SELECT id FROM hotel_guests WHERE org_id = $1 AND (
         ($2::text IS NOT NULL AND lower(email) = lower($2)) OR ($3::text IS NOT NULL AND phone = $3)
         OR ($4::text IS NOT NULL AND id_number = $4))
       ORDER BY created_at LIMIT 1`,
      [orgId, g.email ?? null, g.phone ?? null, g.idNumber ?? null],
    );
    return r?.id ?? null;
  }

  async function quote(t: Db, s: HotelScope, q: QuoteInput, lockPromo = false) {
    const book = await loadRateBook(t, s.property.id);
    const nights = daysBetween(q.arrival, q.departure);
    const promo = q.promoCode ? await validPromo(t, s, q, lockPromo) : null;
    const member = await memberDiscountBp(t, s.orgId, await knownGuest(t, s.orgId, q.guest));
    let discount: { kind: "promo" | "member"; ref: string; bp: number; label: string } | null = null;
    if (promo && promo.discount_bp >= member.bp)
      discount = { kind: "promo", ref: promo.code, bp: promo.discount_bp, label: `Promo code ${promo.code}` };
    else if (member.bp > 0 && member.tier)
      discount = { kind: "member", ref: member.tier, bp: member.bp, label: `Member rate (${member.tier})` };
    const prices = new Map(
      (
        await t.rows<{ attribute: string; amount_minor: number }>(
          "SELECT attribute, amount_minor FROM hotel_attribute_prices WHERE property_id = $1",
          [s.property.id],
        )
      ).map((a) => [a.attribute, a.amount_minor]),
    );
    const rooms = q.rooms.map((r) => {
      const unknown = r.attributes.filter((a) => !prices.has(a));
      if (unknown.length) throw fail.invalid(`Not sold as a room feature: ${unknown.join(", ")}`);
      const fee = r.attributes.reduce((n, a) => n + (prices.get(a) ?? 0), 0);
      const ns = stayPrices(book, r.ratePlanId, r.roomTypeId, q.arrival, q.departure).map((n) => ({
        date: n.date,
        planRateMinor: n.amount,
        rateMinor: discount ? n.amount - Math.round((n.amount * discount.bp) / 10_000) : n.amount,
      }));
      return {
        roomTypeId: r.roomTypeId,
        ratePlanId: r.ratePlanId,
        nights: ns,
        attributesPerNightMinor: fee,
        totalMinor: ns.reduce((n, x) => n + x.rateMinor, 0) + fee * nights,
        attributes: r.attributes,
      };
    });
    const adults = q.rooms.reduce((n, r) => n + r.adults, 0);
    const upsells = [];
    for (const u of q.upsells) {
      const row = await t.row<UpsellRow>("SELECT * FROM hotel_upsells WHERE property_id = $1 AND id = $2", [
        s.property.id,
        u.upsellId,
      ]);
      if (!row?.active) throw fail.invalid("That extra is not offered");
      const units = row.pricing === "per_stay" ? 1 : row.pricing === "per_night" ? nights : nights * adults;
      upsells.push({
        upsellId: row.id,
        name: row.name,
        department: row.department,
        quantity: u.quantity,
        amountMinor: row.amount_minor * units * u.quantity,
      });
    }
    return {
      // the code is used only when it gives the better discount
      promo: discount?.kind === "promo" ? promo : null,
      out: {
        nights,
        discount: discount ? { kind: discount.kind, pct: fromBp(discount.bp), label: discount.label } : null,
        rooms: rooms.map((r) => ({
          roomTypeId: r.roomTypeId,
          ratePlanId: r.ratePlanId,
          nights: r.nights,
          attributesPerNightMinor: r.attributesPerNightMinor,
          totalMinor: r.totalMinor,
        })),
        upsells: upsells.map((u) => ({ upsellId: u.upsellId, name: u.name, amountMinor: u.amountMinor })),
        totalBeforeTaxMinor:
          rooms.reduce((n, r) => n + r.totalMinor, 0) + upsells.reduce((n, u) => n + u.amountMinor, 0),
      },
      discount,
      rooms,
      upsells,
    };
  }

  async function attributePrices(s: HotelScope) {
    const rows = await db.rows<{ attribute: string; name: string; amount_minor: number; rooms: number }>(
      `SELECT a.attribute, a.name, a.amount_minor,
         (SELECT count(*)::int FROM hotel_rooms r WHERE r.property_id = a.property_id AND a.attribute = ANY(r.attributes)) AS rooms
       FROM hotel_attribute_prices a WHERE a.property_id = $1 ORDER BY a.attribute`,
      [s.property.id],
    );
    return {
      prices: rows.map((r) => ({ attribute: r.attribute, name: r.name, amountMinor: r.amount_minor, rooms: r.rooms })),
    };
  }

  return {
    // ---------------------------------------------------------------- promo codes
    async listPromoCodes(s: HotelScope) {
      const rows = await db.rows<PromoRow>("SELECT * FROM hotel_promo_codes WHERE property_id = $1 ORDER BY code", [
        s.property.id,
      ]);
      return { promoCodes: rows.map(toPromo) };
    },

    async createPromoCode(s: HotelScope, b: z.output<typeof hotel.createPromoCode.body>) {
      const id = newId("hpc");
      await db.tx(async (t) => {
        if (
          await t.row("SELECT 1 FROM hotel_promo_codes WHERE property_id = $1 AND upper(code) = upper($2)", [
            s.property.id,
            b.code,
          ])
        )
          throw fail.conflict(`Promo code ${b.code} already exists`);
        const plans = await t.rows<{ id: string }>(
          "SELECT id FROM hotel_rate_plans WHERE property_id = $1 AND id = ANY($2::text[])",
          [s.property.id, b.ratePlanIds],
        );
        if (plans.length !== new Set(b.ratePlanIds).size) throw fail.invalid("Unknown rate plan for this hotel");
        await t.run(
          `INSERT INTO hotel_promo_codes (id, org_id, property_id, code, description, discount_bp, stay_from, stay_to,
             min_nights, max_uses, rate_plan_ids, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            s.orgId,
            s.property.id,
            b.code.toUpperCase(),
            b.description,
            toBp(b.discountPct),
            b.stayFrom ?? null,
            b.stayTo ?? null,
            b.minNights,
            b.maxUses ?? null,
            b.ratePlanIds,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Promo code added",
          target: b.code.toUpperCase(),
          detail: `${b.discountPct}% off`,
        });
      });
      return toPromo(await promoRow(db, s.property.id, id));
    },

    async updatePromoCode(s: HotelScope, id: string, b: z.output<typeof hotel.updatePromoCode.body>) {
      await db.tx(async (t) => {
        const p = await promoRow(t, s.property.id, id);
        if (b.maxUses != null && b.maxUses < p.uses) throw fail.invalid(`The code was used ${p.uses} time(s) already`);
        await t.run(
          `UPDATE hotel_promo_codes SET active = COALESCE($2, active), description = COALESCE($3, description),
             max_uses = CASE WHEN $4 THEN $5 ELSE max_uses END WHERE id = $1`,
          [id, b.active ?? null, b.description ?? null, b.maxUses !== undefined, b.maxUses ?? null],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Promo code changed",
          target: p.code,
          after: b,
        });
      });
      return toPromo(await promoRow(db, s.property.id, id));
    },

    // ---------------------------------------------------------------- upsells and room features
    async listUpsells(s: HotelScope) {
      const rows = await db.rows<UpsellRow>("SELECT * FROM hotel_upsells WHERE property_id = $1 ORDER BY code", [
        s.property.id,
      ]);
      return { upsells: rows.map(toUpsell) };
    },

    async saveUpsell(s: HotelScope, b: z.output<typeof hotel.saveUpsell.body>) {
      const id = await db.tx(async (t) => {
        const row = await t.row<{ id: string }>(
          `INSERT INTO hotel_upsells (id, org_id, property_id, code, name, department, pricing, amount_minor, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (property_id, code) DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department,
             pricing = EXCLUDED.pricing, amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active
           RETURNING id`,
          [newId("hup"), s.orgId, s.property.id, b.code, b.name, b.department, b.pricing, b.amountMinor, b.active],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Extra saved",
          target: b.code,
          detail: `${b.name} · ${b.amountMinor} ${b.pricing}`,
        });
        return (row as { id: string }).id;
      });
      return toUpsell((await db.row<UpsellRow>("SELECT * FROM hotel_upsells WHERE id = $1", [id])) as UpsellRow);
    },

    listAttributePrices: attributePrices,

    async setAttributePrices(s: HotelScope, prices: { attribute: string; name: string; amountMinor: number }[]) {
      if (new Set(prices.map((p) => p.attribute)).size !== prices.length) throw fail.invalid("One price per feature");
      await db.tx(async (t) => {
        await t.run("DELETE FROM hotel_attribute_prices WHERE property_id = $1", [s.property.id]);
        for (const p of prices)
          await t.run(
            "INSERT INTO hotel_attribute_prices (property_id, attribute, org_id, name, amount_minor) VALUES ($1,$2,$3,$4,$5)",
            [s.property.id, p.attribute, s.orgId, p.name, p.amountMinor],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Room feature prices set",
          target: s.property.id,
          after: prices,
        });
      });
      return attributePrices(s);
    },

    // ---------------------------------------------------------------- quote and book
    quote: async (s: HotelScope, q: QuoteInput) => (await quote(db, s, q)).out,

    async book(s: HotelScope, b: z.output<typeof hotel.bookDirect.body>) {
      const out = await db.tx(async (t) => {
        // priced inside the booking's transaction, with the promo code's row locked (its last use is sold once)
        const q = await quote(t, s, b, true);
        const id = await reservations.create(
          s,
          {
            guest: b.guest,
            arrival: b.arrival,
            departure: b.departure,
            rooms: b.rooms.map((r) => ({
              roomTypeId: r.roomTypeId,
              ratePlanId: r.ratePlanId,
              adults: r.adults,
              children: r.children,
            })),
            source: b.source,
            specialRequests: b.specialRequests,
            waitlist: false,
          },
          {
            discount: q.discount ? { kind: q.discount.kind, ref: q.discount.ref, bp: q.discount.bp } : null,
            roomFeatures: q.rooms.map((r) => ({ attributes: r.attributes, feePerNight: r.attributesPerNightMinor })),
            promoCodeId: q.promo?.id ?? null,
            linenReuse: b.linenReuse,
            ...(b.arrivalTime ? { arrivalTime: b.arrivalTime } : {}),
            after: async (t2, reservationId) => {
              if (q.promo) await t2.run("UPDATE hotel_promo_codes SET uses = uses + 1 WHERE id = $1", [q.promo.id]);
              for (const u of q.upsells)
                await t2.run(
                  `INSERT INTO hotel_reservation_upsells (id, org_id, property_id, reservation_id, upsell_id, description,
                     department, amount_minor)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                  [
                    newId("hru"),
                    s.orgId,
                    s.property.id,
                    reservationId,
                    u.upsellId,
                    `${u.name}${u.quantity > 1 ? ` × ${u.quantity}` : ""}`,
                    u.department,
                    u.amountMinor,
                  ],
                );
              await t2.run(
                `UPDATE hotel_guests g SET marketing_consent = g.marketing_consent OR $2, language = COALESCE($3, g.language)
                 FROM hotel_reservations r WHERE r.id = $1 AND g.id = r.guest_id`,
                [reservationId, b.marketingConsent, b.language ?? null],
              );
            },
          },
          t,
        );
        return { id, quote: q.out };
      });
      return { reservation: await reservations.load(db, s.property.id, out.id), quote: out.quote };
    },
  };
}

export type BookingEngineService = ReturnType<typeof bookingEngineService>;
