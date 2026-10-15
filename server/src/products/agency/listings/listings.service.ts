/*
 * Listings: drafted by the organisation, submitted to PALTAS, published only by PALTAS staff (moderation), taken down
 * by the organisation at any time. A listing that is public or waiting for review cannot be changed: take it down,
 * change it, submit it again. Media are metadata; the storage adapter keeps the bytes.
 */
import type { agency } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { addDays } from "../../../lib/dates.js";
import { newId } from "../../../lib/ids.js";
import type { AgencyDeps } from "../deps.js";
import { findContact } from "../shared/contacts.js";
import { requireMember } from "../shared/members.js";
import { HOLDING, nightlyPrices } from "../shared/quote.js";
import { daysBetween, toBp, unique } from "../shared/util.js";
import { findListing, mediaOf, toListing, toOrgMedia, type ListingRow, type MediaRow } from "./listings.repo.js";

type Input = agency.ListingInput;

/** Statuses in which the organisation may change a listing. */
const EDITABLE = ["draft", "paused", "rejected"];

export function listingsService(d: AgencyDeps) {
  const { db } = d.core;
  const storage = d.storage;

  async function view(t: Db, l: ListingRow): Promise<agency.Listing> {
    return toListing(l, (await mediaOf(t, [l.id])).get(l.id) ?? [], storage);
  }

  async function check(t: Db, s: OrgScope, b: Input): Promise<void> {
    if (b.purpose === "stay") {
      if (s.product !== "agency") throw fail.invalid("Short stays are part of the Agent / Host product");
      if (!b.maxGuests) throw fail.invalid("A stay needs the most guests it sleeps (maxGuests)");
    }
    if (b.ownerContactId) await findContact(d.core, t, s.orgId, b.ownerContactId);
    if (b.agreementId) {
      const a = await t.row<{ kind: string; status: string; client_contact_id: string }>(
        "SELECT kind, status, client_contact_id FROM agency_agreements WHERE org_id = $1 AND id = $2",
        [s.orgId, b.agreementId],
      );
      if (!a) throw fail.notFound("Agreement not found");
      if (a.status !== "active") throw fail.conflict("That agreement has ended");
      const fits = { sale: "sale", rent: "letting", stay: "stay_management" }[b.purpose];
      if (a.kind !== fits) throw fail.invalid(`A ${b.purpose} listing needs a ${fits.replace("_", " ")} agreement`);
      if (b.ownerContactId && a.client_contact_id !== b.ownerContactId)
        throw fail.invalid("The agreement is with another client than the listing's owner");
    }
    if (b.agentUserId) await requireMember(t, s.orgId, b.agentUserId, "agency.listings.manage");
  }

  const values = (b: Input) => [
    b.purpose,
    b.propertyType,
    b.title,
    b.description,
    b.country,
    b.city,
    b.area,
    b.addressPrivate,
    b.bedrooms,
    b.bathrooms,
    b.sizeM2 ?? null,
    b.maxGuests ?? null,
    [...new Set(b.amenities)],
    b.priceMinor,
    b.depositMinor,
    b.cleaningFeeMinor,
    toBp(b.serviceFeePct),
    toBp(b.taxPct),
    b.minNights,
    b.instantBook,
    b.ownerContactId ?? null,
    b.agreementId ?? null,
    b.agentUserId ?? null,
  ];

  async function audit(t: Db, s: OrgScope, action: string, l: ListingRow, detail = "") {
    await recordAudit(t, { actor: s.actor, orgId: s.orgId, action, target: l.number, detail: detail || l.title });
  }

  return {
    async list(s: OrgScope, q: { status?: string | undefined; purpose?: string | undefined }) {
      const rows = await db.rows<ListingRow>(
        `SELECT * FROM agency_listings WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR purpose = $3) ORDER BY created_at DESC, id`,
        [s.orgId, q.status ?? null, q.purpose ?? null],
      );
      const media = await mediaOf(
        db,
        rows.map((r) => r.id),
      );
      return { listings: rows.map((r) => toListing(r, media.get(r.id) ?? [], storage)) };
    },

    async get(s: OrgScope, id: string) {
      return view(db, await findListing(db, s.orgId, id));
    },

    async create(s: OrgScope, b: Input) {
      return db.tx(async (t) => {
        await check(t, s, b);
        const org = await t.row<{ currency: string }>("SELECT currency FROM organisations WHERE id = $1", [s.orgId]);
        const l = (await t.row<ListingRow>(
          `INSERT INTO agency_listings (id, org_id, product, number, currency, created_by, purpose, property_type, title,
             description, country, city, area, address_private, bedrooms, bathrooms, size_m2, max_guests, amenities,
             price_minor, deposit_minor, cleaning_fee_minor, service_fee_bp, tax_bp, min_nights, instant_book,
             owner_contact_id, agreement_id, agent_user)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           RETURNING *`,
          [
            newId("lst"),
            s.orgId,
            s.product,
            await nextNumber(t, s.orgId, "LST"),
            org?.currency,
            s.userId,
            ...values(b),
          ],
        )) as ListingRow;
        await audit(t, s, "Listing drafted", l);
        return view(t, l);
      });
    },

    async update(s: OrgScope, id: string, b: Input) {
      return db.tx(async (t) => {
        const before = await findListing(t, s.orgId, id, true);
        if (!EDITABLE.includes(before.status))
          throw fail.conflict(
            before.status === "closed"
              ? "This listing is closed (sold or let)"
              : "Take the listing off the marketplace before changing it",
          );
        if (before.purpose !== b.purpose) throw fail.invalid("A listing's purpose cannot change — draft a new one");
        await check(t, s, b);
        const l = (await t.row<ListingRow>(
          `UPDATE agency_listings SET purpose = $3, property_type = $4, title = $5, description = $6, country = $7,
             city = $8, area = $9, address_private = $10, bedrooms = $11, bathrooms = $12, size_m2 = $13,
             max_guests = $14, amenities = $15, price_minor = $16, deposit_minor = $17, cleaning_fee_minor = $18,
             service_fee_bp = $19, tax_bp = $20, min_nights = $21, instant_book = $22, owner_contact_id = $23,
             agreement_id = $24, agent_user = $25, updated_at = now()
           WHERE org_id = $1 AND id = $2 RETURNING *`,
          [s.orgId, id, ...values(b)],
        )) as ListingRow;
        await audit(t, s, "Listing changed", l);
        return view(t, l);
      });
    },

    async submit(s: OrgScope, id: string) {
      return db.tx(async (t) => {
        const l = await findListing(t, s.orgId, id, true);
        if (!EDITABLE.includes(l.status))
          throw fail.conflict(`A ${l.status.replace("_", " ")} listing cannot be submitted`);
        const photos = await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM agency_listing_media WHERE listing_id = $1 AND kind = 'photo'",
          [l.id],
        );
        if (!photos?.n) throw fail.invalid("Add at least one photo before submitting the listing");
        if (l.description.trim().length < 20) throw fail.invalid("Describe the property (20 characters or more)");
        const out = (await t.row<ListingRow>(
          `UPDATE agency_listings SET status = 'pending_review', submitted_by = $2, submitted_at = now(),
             review_note = '', updated_at = now() WHERE id = $1 RETURNING *`,
          [l.id, s.userId],
        )) as ListingRow;
        await audit(t, s, "Listing submitted for review", out);
        return view(t, out);
      });
    },

    async unpublish(s: OrgScope, id: string) {
      return db.tx(async (t) => {
        const l = await findListing(t, s.orgId, id, true);
        if (!["published", "pending_review"].includes(l.status))
          throw fail.conflict("The listing is not on the marketplace or waiting for review");
        const out = (await t.row<ListingRow>(
          "UPDATE agency_listings SET status = 'paused', updated_at = now() WHERE id = $1 RETURNING *",
          [l.id],
        )) as ListingRow;
        await audit(t, s, "Listing taken off the marketplace", out);
        return view(t, out);
      });
    },

    async addMedia(
      s: OrgScope,
      id: string,
      b: {
        kind: MediaRow["kind"];
        fileName: string;
        contentType: string;
        sizeBytes: number;
        sha256: string;
        caption: string;
        position: number;
      },
    ) {
      return db.tx(async (t) => {
        const l = await findListing(t, s.orgId, id, true);
        if (!EDITABLE.includes(l.status))
          throw fail.conflict("Take the listing off the marketplace before changing it");
        const mediaId = newId("med");
        const reserved = storage.reserve({
          orgId: s.orgId,
          listingId: l.id,
          mediaId,
          fileName: b.fileName,
          contentType: b.contentType,
          sizeBytes: b.sizeBytes,
          sha256: b.sha256,
        });
        const m = (await unique(
          t.row<MediaRow>(
            `INSERT INTO agency_listing_media (id, listing_id, org_id, kind, file_name, content_type, size_bytes, sha256,
               caption, position, storage, storage_key, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [
              mediaId,
              l.id,
              s.orgId,
              b.kind,
              b.fileName,
              b.contentType,
              b.sizeBytes,
              b.sha256,
              b.caption,
              b.position,
              storage.name,
              reserved.storageKey,
              s.userId,
            ],
          ),
          "This file is already on the listing",
        )) as MediaRow;
        await audit(t, s, "Listing media added", l, `${b.kind} · ${b.fileName}`);
        return {
          media: toOrgMedia(m, storage),
          upload: {
            adapter: storage.name,
            connected: storage.connected,
            status: storage.status,
            uploadUrl: reserved.uploadUrl,
          },
        };
      });
    },

    async removeMedia(s: OrgScope, id: string, mediaId: string) {
      return db.tx(async (t) => {
        const l = await findListing(t, s.orgId, id, true);
        if (!EDITABLE.includes(l.status))
          throw fail.conflict("Take the listing off the marketplace before changing it");
        const m = await t.row<MediaRow>(
          "DELETE FROM agency_listing_media WHERE listing_id = $1 AND id = $2 RETURNING *",
          [l.id, mediaId],
        );
        if (!m) throw fail.notFound("File not found");
        await audit(t, s, "Listing media removed", l, `${m.kind} · ${m.file_name}`);
        return { ok: true as const };
      });
    },

    async calendar(s: OrgScope, id: string, from: string, to: string) {
      const l = await findListing(db, s.orgId, id);
      if (l.purpose !== "stay") throw fail.invalid("Only stays have a calendar");
      const span = daysBetween(from, to);
      if (span < 1 || span > 366) throw fail.invalid("Ask for 1 to 366 days");
      const stays = await db.rows<{
        number: string;
        kind: string;
        status: string;
        check_in: string;
        check_out: string;
      }>(
        `SELECT number, kind, status, check_in, check_out FROM agency_stays
         WHERE listing_id = $1 AND status = ANY($4) AND check_in < $3 AND check_out > $2`,
        [l.id, from, to, [...HOLDING, "requested"]],
      );
      const prices = await nightlyPrices(db, l, from, to);
      const days: agency.CalendarDay[] = prices.map((p) => {
        const on = stays.filter((x) => x.check_in <= p.date && p.date < x.check_out);
        const held = on.find((x) => x.status !== "requested");
        const state = held ? (held.kind === "block" ? "blocked" : "booked") : on.length ? "requested" : "free";
        return { date: p.date, priceMinor: p.priceMinor, state, stayNumber: (held ?? on[0])?.number ?? null };
      });
      return { days };
    },

    async setRates(s: OrgScope, id: string, rates: { date: string; priceMinor: number | null }[]) {
      return db.tx(async (t) => {
        const l = await findListing(t, s.orgId, id, true);
        if (l.purpose !== "stay") throw fail.invalid("Only stays have nightly prices");
        if (rates.some((r) => r.date < s.today || r.date > addDays(s.today, 730)))
          throw fail.invalid("Set prices for today up to two years ahead");
        for (const r of rates) {
          if (r.priceMinor === null)
            await t.run("DELETE FROM agency_stay_rates WHERE listing_id = $1 AND date = $2", [l.id, r.date]);
          else
            await t.run(
              `INSERT INTO agency_stay_rates (listing_id, org_id, date, price_minor) VALUES ($1, $2, $3, $4)
               ON CONFLICT (listing_id, date) DO UPDATE SET price_minor = EXCLUDED.price_minor`,
              [l.id, s.orgId, r.date, r.priceMinor],
            );
        }
        await audit(t, s, "Stay prices set", l, `${rates.length} night(s)`);
        return { ok: true as const };
      });
    },
  };
}

export type ListingsService = ReturnType<typeof listingsService>;
