import { Readable } from "node:stream";
/*
 * The public marketplace (no sign-in). Every read shows only listings PALTAS staff approved, from organisations
 * whose subscription for the listing's product is usable today (mkt_org_usable), and maps rows through
 * toPublicListing, which carries no personal data. Every submission goes to the listing's own organisation only,
 * counts against the caller address's budget, and is capped per person and listing in the database.
 * Buyers and guests follow an offer or booking with its reference and the private token returned once.
 */
import type { marketplace } from "@paltas/contracts";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import type { AgencyDeps } from "../deps.js";
import { leadEvent } from "../leads/leads.repo.js";
import { advanceLead, openLeadFor } from "../leads/leads.service.js";
import { mediaOf, toPublicListing, type ListingRow } from "../listings/listings.repo.js";
import { linkContact, noteOnContact } from "../shared/contacts.js";
import { HOLDING, nightlyPrices, quote } from "../shared/quote.js";
import { daysBetween, hashToken, newToken, unique, VISITOR } from "../shared/util.js";
import { insertBooking } from "../stays/stays.service.js";
import { findStay, type StayRow } from "../stays/stays.repo.js";

type PublicRow = ListingRow & { org_name: string; rating_avg: number | null; rating_count: number };

/** Published, and the owning organisation's subscription for that product is usable today ($1 = today). */
const PUBLIC = `l.status = 'published' AND mkt_org_usable(l.org_id, l.product, $1::date)`;
const PUBLIC_SQL = `SELECT l.*, o.name AS org_name,
    (SELECT avg(rating)::float FROM agency_reviews r WHERE r.listing_id = l.id AND r.status = 'approved') AS rating_avg,
    (SELECT count(*)::int FROM agency_reviews r WHERE r.listing_id = l.id AND r.status = 'approved') AS rating_count
  FROM agency_listings l JOIN organisations o ON o.id = l.org_id`;

/** Where marketplace contacts came from (kept with their consent). */
const SOURCE = "PALTAS marketplace";

/** Most open requests one person may have on one listing (enquiries, offers, booking requests). */
const OPEN_PER_PERSON = { enquiries: 3, bookings: 2 };

export function publicService(d: AgencyDeps) {
  const { db } = d.core;
  const { clock } = d.ctx;
  const storage = d.storage;

  async function publicListing(t: Db, id: string, lock = false): Promise<PublicRow> {
    const l = await t.row<PublicRow>(`${PUBLIC_SQL} WHERE ${PUBLIC} AND l.id = $2${lock ? " FOR UPDATE OF l" : ""}`, [
      clock.today(),
      id,
    ]);
    if (!l) throw fail.notFound("Listing not found");
    return l;
  }

  async function show(t: Db, rows: PublicRow[]) {
    const media = await mediaOf(
      t,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toPublicListing(r, media.get(r.id) ?? [], storage));
  }

  async function offerByToken(t: Db, reference: string, token: string, lock = false) {
    const o = await t.row<{
      id: string;
      org_id: string;
      number: string;
      listing_id: string;
      lead_id: string | null;
      l_title: string;
      currency: string;
      amount_minor: number;
      counter_minor: number | null;
      status: marketplace.PublicOffer["status"];
      token_hash: string;
    }>(
      `SELECT o.*, l.title AS l_title, l.currency FROM agency_offers o JOIN agency_listings l ON l.id = o.listing_id
       WHERE o.id = $1 AND o.token_hash = $2${lock ? " FOR UPDATE OF o" : ""}`,
      [reference, hashToken(token)],
    );
    // a wrong token and an unknown reference look the same
    if (!o) throw fail.notFound("Offer not found");
    return o;
  }

  const offerView = (o: Awaited<ReturnType<typeof offerByToken>>): marketplace.PublicOffer => ({
    reference: o.id,
    listingTitle: o.l_title,
    currency: o.currency,
    amountMinor: o.amount_minor,
    counterMinor: o.counter_minor,
    status: o.status,
  });

  async function stayByToken(t: Db, reference: string, token: string, lock = false): Promise<StayRow> {
    const r = await t.row<{ org_id: string }>("SELECT org_id FROM agency_stays WHERE id = $1 AND token_hash = $2", [
      reference,
      hashToken(token),
    ]);
    if (!r) throw fail.notFound("Booking not found");
    return findStay(t, r.org_id, reference, lock);
  }

  async function bookingView(t: Db, r: StayRow): Promise<marketplace.PublicBooking> {
    const reviewed = await t.row("SELECT 1 FROM agency_reviews WHERE stay_id = $1", [r.id]);
    return {
      reference: r.id,
      listingTitle: r.l_title,
      status: r.status,
      checkIn: r.check_in,
      checkOut: r.check_out,
      guests: r.guests,
      currency: r.currency,
      totalMinor: r.total_minor,
      paidMinor: r.paid_minor,
      canReview: r.status === "completed" && !reviewed,
    };
  }

  return {
    // ---------------------------------------------------------------- reading
    async mediaContent(ip: string, listingId: string, mediaId: string) {
      d.limiter.read(ip);
      await publicListing(db, listingId);
      const photo = await db.row<{ content: Buffer }>(
        `SELECT f.content FROM agency_photo_files f JOIN agency_listing_media m ON m.id = f.media_id
         WHERE m.listing_id = $1 AND m.id = $2 AND m.kind = 'photo' AND m.storage = 'postgres-image'`,
        [listingId, mediaId],
      );
      if (!photo) throw fail.notFound("Photo not found");
      return {
        body: Readable.from([photo.content]),
        filename: "listing-photo.jpg",
        contentType: "image/jpeg" as const,
      };
    },

    async search(
      ip: string,
      q: {
        purpose?: string | undefined;
        city?: string | undefined;
        q?: string | undefined;
        propertyType?: string | undefined;
        minPriceMinor?: number | undefined;
        maxPriceMinor?: number | undefined;
        bedrooms?: number | undefined;
        guests?: number | undefined;
        amenities?: string[] | undefined;
        checkIn?: string | undefined;
        checkOut?: string | undefined;
        sort: "newest" | "price_low" | "price_high";
        limit: number;
        offset: number;
      },
    ) {
      d.limiter.read(ip);
      if ((q.checkIn && !q.checkOut) || (!q.checkIn && q.checkOut))
        throw fail.invalid("Give both check-in and check-out");
      if (q.checkIn && q.checkOut && (q.checkOut <= q.checkIn || daysBetween(q.checkIn, q.checkOut) > 90))
        throw fail.invalid("Check-out must be 1 to 90 nights after check-in");
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
      const order = { newest: "l.published_at DESC", price_low: "l.price_minor ASC", price_high: "l.price_minor DESC" }[
        q.sort
      ];
      const rows = await db.rows<PublicRow & { total: number }>(
        `${PUBLIC_SQL.replace("SELECT l.*,", "SELECT l.*, count(*) OVER () ::int AS total,")}
         WHERE ${PUBLIC}
           AND ($2::text IS NULL OR l.purpose = $2)
           AND ($3::text IS NULL OR lower(l.city) = lower($3))
           AND ($4::text IS NULL OR l.title ILIKE $4 OR l.area ILIKE $4 OR l.city ILIKE $4 OR l.description ILIKE $4)
           AND ($5::text IS NULL OR lower(l.property_type) = lower($5))
           AND ($6::bigint IS NULL OR l.price_minor >= $6)
           AND ($7::bigint IS NULL OR l.price_minor <= $7)
           AND ($8::int IS NULL OR l.bedrooms >= $8)
           AND ($9::int IS NULL OR (l.purpose = 'stay' AND l.max_guests >= $9) OR l.purpose <> 'stay')
           AND ($10::text[] IS NULL OR l.amenities @> $10)
           AND ($11::date IS NULL OR (l.purpose = 'stay' AND NOT EXISTS (
                 SELECT 1 FROM agency_stays s WHERE s.listing_id = l.id AND s.status = ANY($13)
                   AND daterange(s.check_in, s.check_out, '[)') && daterange($11::date, $12::date, '[)'))))
         ORDER BY ${order}, l.id LIMIT $14 OFFSET $15`,
        [
          clock.today(),
          q.purpose ?? null,
          q.city ?? null,
          like,
          q.propertyType ?? null,
          q.minPriceMinor ?? null,
          q.maxPriceMinor ?? null,
          q.bedrooms ?? null,
          q.guests ?? null,
          q.amenities?.length ? q.amenities : null,
          q.checkIn ?? null,
          q.checkOut ?? null,
          HOLDING,
          q.limit,
          q.offset,
        ],
      );
      return { listings: await show(db, rows), total: rows[0]?.total ?? 0, limit: q.limit, offset: q.offset };
    },

    async get(ip: string, id: string) {
      d.limiter.read(ip);
      const l = await publicListing(db, id);
      // count the view for the organisation's listing performance (nothing about the visitor is kept)
      await db.run(
        `INSERT INTO agency_listing_views (listing_id, org_id, date, views) VALUES ($1, $2, $3, 1)
         ON CONFLICT (listing_id, date) DO UPDATE SET views = agency_listing_views.views + 1`,
        [l.id, l.org_id, clock.today()],
      );
      const reviews = await db.rows<{ rating: number; text: string; display_name: string; created_at: string }>(
        "SELECT rating, text, display_name, created_at FROM agency_reviews WHERE listing_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 50",
        [id],
      );
      const [one] = await show(db, [l]);
      return {
        ...(one as marketplace.PublicListing),
        reviews: reviews.map((r) => ({
          rating: r.rating,
          text: r.text,
          displayName: r.display_name,
          at: r.created_at,
        })),
      };
    },

    async availability(ip: string, id: string, from: string, to: string) {
      d.limiter.read(ip);
      const l = await publicListing(db, id);
      if (l.purpose !== "stay") throw fail.invalid("Only stays have a calendar");
      const span = daysBetween(from, to);
      if (span < 1 || span > 120) throw fail.invalid("Ask for 1 to 120 days");
      const held = await db.rows<{ check_in: string; check_out: string }>(
        "SELECT check_in, check_out FROM agency_stays WHERE listing_id = $1 AND status = ANY($4) AND check_in < $3 AND check_out > $2",
        [l.id, from, to, HOLDING],
      );
      const today = clock.today();
      return {
        days: (await nightlyPrices(db, l, from, to)).map((n) => ({
          date: n.date,
          available: n.date >= today && !held.some((h) => h.check_in <= n.date && n.date < h.check_out),
          priceMinor: n.priceMinor,
        })),
      };
    },

    async quote(ip: string, id: string, q: { checkIn: string; checkOut: string; guests: number }) {
      d.limiter.read(ip);
      const l = await publicListing(db, id);
      if (l.purpose !== "stay") throw fail.invalid("Only stays are booked");
      return quote(db, l, q, clock.today());
    },

    // ---------------------------------------------------------------- submissions
    async enquire(
      ip: string,
      id: string,
      b: {
        kind: "enquiry" | "viewing_request";
        name: string;
        email?: string | undefined;
        phone?: string | undefined;
        marketingConsent: boolean;
        message: string;
        preferredDate?: string | undefined;
        preferredTime?: string | undefined;
      },
    ) {
      d.limiter.submit(ip);
      const today = clock.today();
      if (b.preferredDate && (b.preferredDate < today || b.preferredDate > addDays(today, 180)))
        throw fail.invalid("Pick a viewing date within the next six months");
      return db.tx(async (t) => {
        const l = await publicListing(t, id);
        if (b.kind === "viewing_request" && l.purpose === "stay") throw fail.invalid("Stays are booked, not viewed");
        const c = await linkContact(d.core, t, {
          orgId: l.org_id,
          person: b,
          as: "enquirer",
          marketing: b.marketingConsent,
          source: SOURCE,
          actor: VISITOR,
        });
        const open = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM agency_enquiries WHERE listing_id = $1 AND contact_id = $2 AND status = 'new'",
          [l.id, c.id],
        );
        if ((open?.n ?? 0) >= OPEN_PER_PERSON.enquiries)
          throw fail.tooManyAttempts("You have already asked about this listing — the company will reply");
        const number = await nextNumber(t, l.org_id, "ENQ");
        const enquiryId = newId("enq");
        await t.run(
          `INSERT INTO agency_enquiries (id, org_id, number, kind, listing_id, contact_id, message, preferred_date, preferred_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            enquiryId,
            l.org_id,
            number,
            b.kind,
            l.id,
            c.id,
            b.message,
            b.preferredDate ?? null,
            b.preferredTime ?? null,
          ],
        );
        await noteOnContact(d.core, t, {
          orgId: l.org_id,
          contactId: c.id,
          kind: "enquiry",
          text: `${number} via the PALTAS marketplace about ${l.number}${b.message ? `: “${b.message}”` : ""}`.slice(
            0,
            2000,
          ),
          refType: "agency_enquiry",
          refId: enquiryId,
          by: null,
        });
        await recordAudit(t, {
          actor: VISITOR,
          orgId: l.org_id,
          action: b.kind === "enquiry" ? "Marketplace enquiry received" : "Marketplace viewing request received",
          target: number,
          detail: l.number,
        });
        return { reference: number, status: "received" as const };
      });
    },

    async offer(
      ip: string,
      id: string,
      b: {
        name: string;
        email: string;
        phone?: string | undefined;
        marketingConsent: boolean;
        amountMinor: number;
        message: string;
      },
    ) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        const l = await publicListing(t, id);
        if (l.purpose !== "sale") throw fail.invalid("Offers are made on homes for sale");
        const c = await linkContact(d.core, t, {
          orgId: l.org_id,
          person: b,
          as: "buyer",
          marketing: b.marketingConsent,
          source: SOURCE,
          actor: VISITOR,
        });
        if (
          await t.row(
            "SELECT 1 FROM agency_offers WHERE listing_id = $1 AND contact_id = $2 AND status IN ('pending', 'countered')",
            [l.id, c.id],
          )
        )
          throw fail.conflict("You already have an open offer on this home — follow it with your reference");
        const lead = await openLeadFor(t, {
          orgId: l.org_id,
          contactId: c.id,
          listingId: l.id,
          source: "PALTAS marketplace",
          by: null,
          agent: l.agent_user,
        });
        await advanceLead(t, lead, "offer", null);
        const { token, hash } = newToken();
        const offerId = newId("off");
        const number = await nextNumber(t, l.org_id, "OFF");
        await t.run(
          `INSERT INTO agency_offers (id, org_id, number, listing_id, contact_id, lead_id, amount_minor, message, token_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [offerId, l.org_id, number, l.id, c.id, lead.id, b.amountMinor, b.message, hash],
        );
        await leadEvent(t, lead, "offer", `Offer ${number}: ${b.amountMinor}`, null);
        await noteOnContact(d.core, t, {
          orgId: l.org_id,
          contactId: c.id,
          kind: "enquiry",
          text: `Offer ${number} on ${l.number}: ${l.currency} ${b.amountMinor} (minor units)`,
          refType: "agency_offer",
          refId: offerId,
          by: null,
        });
        await recordAudit(t, {
          actor: VISITOR,
          orgId: l.org_id,
          action: "Marketplace offer received",
          target: number,
          detail: l.number,
        });
        return { ...offerView(await offerByToken(t, offerId, token)), token };
      });
    },

    async offerStatus(ip: string, reference: string, token: string) {
      d.limiter.read(ip);
      return offerView(await offerByToken(db, reference, token));
    },

    async acceptCounter(ip: string, reference: string, token: string) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        const o = await offerByToken(t, reference, token, true);
        if (o.status !== "countered" || o.counter_minor === null)
          throw fail.conflict("There is no counter-offer to accept");
        await unique(
          t.run("UPDATE agency_offers SET status = 'accepted', amount_minor = counter_minor WHERE id = $1", [o.id]),
          "The seller has already accepted another offer",
        );
        await recordAudit(t, {
          actor: VISITOR,
          orgId: o.org_id,
          action: "Counter-offer accepted by the buyer",
          target: o.number,
        });
        return offerView(await offerByToken(t, reference, token));
      });
    },

    async withdrawOffer(ip: string, reference: string, token: string) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        const o = await offerByToken(t, reference, token, true);
        if (!["pending", "countered"].includes(o.status)) throw fail.conflict(`This offer is ${o.status}`);
        await t.run("UPDATE agency_offers SET status = 'withdrawn' WHERE id = $1", [o.id]);
        await recordAudit(t, {
          actor: VISITOR,
          orgId: o.org_id,
          action: "Offer withdrawn by the buyer",
          target: o.number,
        });
        return offerView(await offerByToken(t, reference, token));
      });
    },

    async book(
      ip: string,
      id: string,
      b: {
        name: string;
        email: string;
        phone?: string | undefined;
        marketingConsent: boolean;
        checkIn: string;
        checkOut: string;
        guests: number;
        message: string;
      },
    ) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        const l = await publicListing(t, id);
        if (l.purpose !== "stay") throw fail.invalid("Only stays are booked");
        const c = await linkContact(d.core, t, {
          orgId: l.org_id,
          person: b,
          as: "guest",
          marketing: b.marketingConsent,
          source: SOURCE,
          actor: VISITOR,
        });
        const open = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM agency_stays WHERE listing_id = $1 AND contact_id = $2 AND status = 'requested'",
          [l.id, c.id],
        );
        if ((open?.n ?? 0) >= OPEN_PER_PERSON.bookings)
          throw fail.tooManyAttempts("You already have booking requests waiting for this stay");
        const { token, hash } = newToken();
        const q = await quote(t, l, b, clock.today());
        const r = await insertBooking(t, {
          orgId: l.org_id,
          listing: l,
          contactId: c.id,
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          guests: b.guests,
          source: "marketplace",
          status: l.instant_book ? "confirmed" : "requested",
          note: b.message,
          tokenHash: hash,
          by: null,
          today: clock.today(),
        });
        await noteOnContact(d.core, t, {
          orgId: l.org_id,
          contactId: c.id,
          kind: "enquiry",
          text: `Stay ${r.number} at ${l.number}: ${r.check_in} → ${r.check_out} (${r.status})`,
          refType: "agency_stay",
          refId: r.id,
          by: null,
        });
        await recordAudit(t, {
          actor: VISITOR,
          orgId: l.org_id,
          action: l.instant_book ? "Marketplace stay booked (instant)" : "Marketplace booking request received",
          target: r.number,
          detail: `${l.number} · ${r.check_in} → ${r.check_out}`,
        });
        return { ...(await bookingView(t, r)), token, quote: q };
      });
    },

    async bookingStatus(ip: string, reference: string, token: string) {
      d.limiter.read(ip);
      return bookingView(db, await stayByToken(db, reference, token));
    },

    async cancelBooking(ip: string, reference: string, token: string) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        const r = await stayByToken(t, reference, token, true);
        if (!["requested", "confirmed"].includes(r.status))
          throw fail.conflict(`A ${r.status} booking cannot be cancelled`);
        if (r.check_in <= clock.today()) throw fail.conflict("The stay has started — ask the host");
        await t.run("UPDATE agency_stays SET status = 'cancelled' WHERE id = $1", [r.id]);
        await recordAudit(t, {
          actor: VISITOR,
          orgId: r.org_id,
          action: "Booking cancelled by the guest",
          target: r.number,
        });
        return bookingView(t, await findStay(t, r.org_id, r.id));
      });
    },

    async review(
      ip: string,
      reference: string,
      b: { token: string; rating: number; text: string; displayName: string },
    ) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        const r = await stayByToken(t, reference, b.token, true);
        if (r.status !== "completed") throw fail.conflict("A stay can be reviewed after check-out");
        await unique(
          t.run(
            `INSERT INTO agency_reviews (id, org_id, listing_id, stay_id, rating, text, display_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newId("rev"), r.org_id, r.listing_id, r.id, b.rating, b.text, b.displayName],
          ),
          "This stay has already been reviewed",
        );
        await recordAudit(t, {
          actor: VISITOR,
          orgId: r.org_id,
          action: "Guest review received (awaiting moderation)",
          target: r.number,
        });
        return { status: "pending" as const };
      });
    },
  };
}

export type PublicService = ReturnType<typeof publicService>;
