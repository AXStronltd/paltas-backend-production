/*
 * PALTAS staff side of the marketplace: listing moderation (only staff publish), review moderation, and
 * "For Business" sign-up requests. Approving a request runs the core onboarding (core.admin.createOrganisation:
 * organisation, first product subscription, chart of accounts, administrator) — nothing is duplicated here.
 */
import { rentalRules, type marketplace, type Product } from "@paltas/contracts";
import { staffActor } from "../../../core/admin/admin.service.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import type { SessionUser } from "../../../core/identity/identity.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { AgencyDeps } from "../deps.js";
import { publicCompliance, rulesInput, type ListingRow } from "../listings/listings.repo.js";
import { unique, VISITOR } from "../shared/util.js";

type ModRow = ListingRow & { org_name: string; media_count: number };
const MOD_SQL = `SELECT l.*, o.name AS org_name,
    (SELECT count(*)::int FROM agency_listing_media m WHERE m.listing_id = l.id) AS media_count
  FROM agency_listings l JOIN organisations o ON o.id = l.org_id`;
const toMod = (r: ModRow): marketplace.ModerationListing => ({
  id: r.id,
  number: r.number,
  orgId: r.org_id,
  orgName: r.org_name,
  purpose: r.purpose,
  propertyType: r.property_type,
  title: r.title,
  description: r.description,
  city: r.city,
  area: r.area,
  currency: r.currency,
  priceMinor: r.price_minor,
  mediaCount: r.media_count,
  status: r.status,
  submittedAt: r.submitted_at,
  reviewedAt: r.reviewed_at,
  reviewNote: r.review_note,
  country: r.country,
  minNights: r.min_nights,
  maxGuests: r.max_guests,
  compliance: {
    ...publicCompliance(r),
    strRegistrationNumber: r.str_registration_number || null,
    hostPresent: r.host_present,
    needsRegistrationCheck: rentalRules.isNycShortTermRental(rulesInput(r)),
    strVerifiedAt: r.str_verified_at,
    issues: rentalRules.rentalRuleIssues(rulesInput(r)),
  },
});

interface ReviewRow {
  id: string;
  org_id: string;
  org_name: string;
  l_number: string;
  l_title: string;
  rating: number;
  text: string;
  display_name: string;
  status: marketplace.ModerationReview["status"];
  created_at: string;
}
const REVIEW_SQL = `SELECT r.*, o.name AS org_name, l.number AS l_number, l.title AS l_title
  FROM agency_reviews r JOIN organisations o ON o.id = r.org_id JOIN agency_listings l ON l.id = r.listing_id`;
const toReview = (r: ReviewRow): marketplace.ModerationReview => ({
  id: r.id,
  orgName: r.org_name,
  listingNumber: r.l_number,
  listingTitle: r.l_title,
  rating: r.rating,
  text: r.text,
  displayName: r.display_name,
  status: r.status,
  createdAt: r.created_at,
});

interface RequestRow {
  id: string;
  number: string;
  product: Product;
  org_name: string;
  registration_number: string;
  country: string;
  currency: string;
  timezone: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  modules: string[];
  details: Record<string, string>;
  status: marketplace.BusinessRequest["status"];
  decision_note: string;
  org_id: string | null;
  created_at: string;
}
const toRequest = (r: RequestRow): marketplace.BusinessRequest => ({
  id: r.id,
  reference: r.number,
  product: r.product,
  orgName: r.org_name,
  registrationNumber: r.registration_number,
  country: r.country,
  currency: r.currency,
  timezone: r.timezone,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  modules: r.modules,
  details: r.details,
  status: r.status,
  decisionNote: r.decision_note,
  orgId: r.org_id,
  createdAt: r.created_at,
});

export function moderationService(d: AgencyDeps) {
  const { db } = d.core;

  async function listing(t: Db, id: string): Promise<ModRow> {
    const r = await t.row<ModRow>(`${MOD_SQL} WHERE l.id = $1`, [id]);
    if (!r) throw fail.notFound("Listing not found");
    return r;
  }

  async function request(t: Db, id: string, lock = false): Promise<RequestRow> {
    const r = await t.row<RequestRow>(`SELECT * FROM mkt_business_requests WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [
      id,
    ]);
    if (!r) throw fail.notFound("Request not found");
    return r;
  }

  return {
    // ---------------------------------------------------------------- listings
    async queue(user: SessionUser, status: string) {
      staffActor(user);
      const rows = await db.rows<ModRow>(
        `${MOD_SQL} WHERE l.status = $1 ORDER BY l.submitted_at NULLS LAST, l.id LIMIT 500`,
        [status],
      );
      return { listings: rows.map(toMod) };
    },

    async approve(user: SessionUser, id: string, note: string, registrationChecked = false) {
      const actor = staffActor(user);
      return db.tx(async (t) => {
        await t.run("SELECT 1 FROM agency_listings WHERE id = $1 FOR UPDATE", [id]);
        const l = await listing(t, id);
        if (l.status !== "pending_review")
          throw fail.conflict(`This listing is ${l.status.replace("_", " ")}, not waiting for review`);
        const photo = await t.row<{ n: number }>(
          "SELECT count(*)::int n FROM agency_photo_files f JOIN agency_listing_media m ON m.id=f.media_id WHERE m.listing_id=$1 AND m.kind='photo'",
          [id],
        );
        if (!photo?.n) throw fail.invalid("This listing needs an uploaded photo before it can be published");
        const issues = rentalRules.rentalRuleIssues(rulesInput(l));
        if (issues.length) throw fail.invalid(issues.join(" "));
        // New York City stays under 30 nights: staff confirm the OSE registration before PALTAS lists the home
        const str = rentalRules.isNycShortTermRental(rulesInput(l));
        if (str && !registrationChecked && !l.str_verified_at)
          throw fail.invalid(
            "Check the host's short-term rental registration number with the NYC Office of Special Enforcement, then confirm the check to publish.",
          );
        await t.run(
          `UPDATE agency_listings SET status = 'published', reviewed_by = $2, reviewed_at = now(), published_at = now(),
             review_note = $3, updated_at = now(),
             str_verified_by = CASE WHEN $4 THEN $2 ELSE str_verified_by END,
             str_verified_at = CASE WHEN $4 THEN now() ELSE str_verified_at END
           WHERE id = $1`,
          [id, user.id, note, str && registrationChecked],
        );
        await recordAudit(t, {
          actor,
          orgId: l.org_id,
          action: "Listing approved and published by PALTAS",
          target: l.number,
          detail:
            str && registrationChecked
              ? `OSE registration ${l.str_registration_number} checked by PALTAS staff${note ? ". " + note : ""}`
              : note,
        });
        return toMod(await listing(t, id));
      });
    },

    async reject(user: SessionUser, id: string, reason: string) {
      const actor = staffActor(user);
      return db.tx(async (t) => {
        await t.run("SELECT 1 FROM agency_listings WHERE id = $1 FOR UPDATE", [id]);
        const l = await listing(t, id);
        if (!["pending_review", "published"].includes(l.status))
          throw fail.conflict(`This listing is ${l.status}, neither waiting for review nor published`);
        await t.run(
          `UPDATE agency_listings SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3,
             updated_at = now() WHERE id = $1`,
          [id, user.id, reason],
        );
        await recordAudit(t, {
          actor,
          orgId: l.org_id,
          action: l.status === "published" ? "Listing taken down by PALTAS" : "Listing refused by PALTAS",
          target: l.number,
          detail: reason,
        });
        return toMod(await listing(t, id));
      });
    },

    // ---------------------------------------------------------------- reviews
    async reviews(user: SessionUser, status: string) {
      staffActor(user);
      const rows = await db.rows<ReviewRow>(`${REVIEW_SQL} WHERE r.status = $1 ORDER BY r.created_at, r.id LIMIT 500`, [
        status,
      ]);
      return { reviews: rows.map(toReview) };
    },

    async moderateReview(user: SessionUser, id: string, b: { decision: "approve" | "reject"; note: string }) {
      const actor = staffActor(user);
      return db.tx(async (t) => {
        const r = await t.row<ReviewRow>(`${REVIEW_SQL} WHERE r.id = $1 FOR UPDATE OF r`, [id]);
        if (!r) throw fail.notFound("Review not found");
        if (r.status !== "pending") throw fail.conflict(`This review is already ${r.status}`);
        const status = b.decision === "approve" ? "approved" : "rejected";
        await t.run(
          "UPDATE agency_reviews SET status = $2, moderated_by = $3, moderated_at = now(), moderation_note = $4 WHERE id = $1",
          [id, status, user.id, b.note],
        );
        await recordAudit(t, {
          actor,
          orgId: r.org_id,
          action: `Guest review ${status} by PALTAS`,
          target: r.l_number,
          detail: b.note,
        });
        return toReview({ ...r, status });
      });
    },

    // ---------------------------------------------------------------- For Business requests
    async submitRequest(
      ip: string,
      b: {
        product: Product;
        orgName: string;
        registrationNumber: string;
        country: string;
        currency: string;
        timezone: string;
        contactName: string;
        contactEmail: string;
        contactPhone?: string | undefined;
        modules: string[];
        details: Record<string, string>;
      },
    ) {
      d.limiter.submit(ip);
      return db.tx(async (t) => {
        if (await t.row("SELECT 1 FROM organisations WHERE lower(name) = lower($1)", [b.orgName]))
          throw fail.conflict(`${b.orgName} is already on PALTAS — ask its administrator for an invitation`);
        const known = await t.rows<{ key: string }>("SELECT key FROM catalogue_modules WHERE $1 = ANY(products)", [
          b.product,
        ]);
        const unknown = b.modules.filter((m) => !known.some((k) => k.key === m));
        if (unknown.length) throw fail.invalid(`Not offered with this product: ${unknown.join(", ")}`);
        const number = await nextNumber(t, "platform", "BIZ");
        await unique(
          t.run(
            `INSERT INTO mkt_business_requests (id, number, product, org_name, registration_number, country, currency,
               timezone, contact_name, contact_email, contact_phone, modules, details)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              newId("biz"),
              number,
              b.product,
              b.orgName,
              b.registrationNumber,
              b.country,
              b.currency,
              b.timezone,
              b.contactName,
              b.contactEmail,
              b.contactPhone ?? "",
              [...new Set(b.modules)],
              JSON.stringify(b.details),
            ],
          ),
          "A request for this company is already waiting for PALTAS",
        );
        await recordAudit(t, {
          actor: VISITOR,
          orgId: null,
          action: "For Business request received",
          target: number,
          detail: b.orgName,
        });
        return { reference: number, status: "pending" as const };
      });
    },

    async requests(user: SessionUser, status: string) {
      staffActor(user);
      const rows = await db.rows<RequestRow>(
        "SELECT * FROM mkt_business_requests WHERE status = $1 ORDER BY created_at, id LIMIT 500",
        [status],
      );
      return { requests: rows.map(toRequest) };
    },

    async approveRequest(user: SessionUser, id: string, b: { plan: string; trial: boolean }) {
      staffActor(user, "super_admin");
      const r = await request(db, id);
      if (r.status !== "pending") throw fail.conflict(`This request is already ${r.status}`);
      // the core onboarding: organisation + subscription + chart of accounts + administrator, in its own transaction
      const created = await d.core.admin.createOrganisation(user, {
        name: r.org_name,
        legalName: r.org_name,
        product: r.product,
        plan: b.plan,
        country: r.country,
        currency: r.currency,
        timezone: r.timezone,
        trial: b.trial,
        admin: { email: r.contact_email, name: r.contact_name },
      });
      return db.tx(async (t) => {
        const again = await request(t, id, true);
        if (again.status !== "pending") throw fail.conflict(`This request is already ${again.status}`);
        await t.run(
          `UPDATE mkt_business_requests SET status = 'approved', org_id = $2, decided_by = $3, decided_at = now(),
             decision_note = $4 WHERE id = $1`,
          [id, created.id, user.id, `Plan ${b.plan}${b.trial ? " (trial)" : ""}`],
        );
        await recordAudit(t, {
          actor: staffActor(user),
          orgId: created.id,
          action: "For Business request approved — organisation created",
          target: r.number,
          detail: `${r.org_name} · ${b.plan}`,
        });
        return { request: toRequest(await request(t, id)), temporaryPassword: created.temporaryPassword };
      });
    },

    async rejectRequest(user: SessionUser, id: string, reason: string) {
      const actor = staffActor(user);
      return db.tx(async (t) => {
        const r = await request(t, id, true);
        if (r.status !== "pending") throw fail.conflict(`This request is already ${r.status}`);
        await t.run(
          "UPDATE mkt_business_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1",
          [id, user.id, reason],
        );
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "For Business request refused",
          target: r.number,
          detail: reason,
        });
        return toRequest(await request(t, id));
      });
    },
  };
}

export type ModerationService = ReturnType<typeof moderationService>;
