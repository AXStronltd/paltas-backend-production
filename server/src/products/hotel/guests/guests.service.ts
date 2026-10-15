/*
 * Guests: the loyalty programme (set-up, members, redemptions, adjustments), internal post-stay feedback with
 * low-score alerts and rule-based trends, message templates, and the personalisation view of arrivals. All from the
 * hotel's own records; no external AI and no review-site connection (invitations stay BLOCKED behind their adapter).
 */
import type { hotel, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { HotelDeps } from "../deps.js";
import type { HotelScope } from "../shared/access.js";
import { DEFAULT_TEMPLATES, messageManagers, type TemplateKey } from "../shared/outbox.js";
import {
  enrol,
  entriesOf,
  entryRow,
  memberOfGuest,
  memberRow,
  programmeOf,
  toMember,
  type Loyalty,
  type MemberRow,
} from "./loyalty.js";

interface FeedbackRow {
  id: string;
  reservation_id: string;
  guest_id: string;
  guest_name: string;
  score: number;
  categories: Record<string, number>;
  comment: string;
  source: hotel.FeedbackOut["source"];
  business_date: string;
  alert_request_id: string | null;
}

const toFeedback = (f: FeedbackRow): hotel.FeedbackOut => ({
  id: f.id,
  reservationId: f.reservation_id,
  guestId: f.guest_id,
  guestName: f.guest_name,
  score: f.score,
  categories: f.categories,
  comment: f.comment,
  source: f.source,
  date: f.business_date,
  alertRequestId: f.alert_request_id,
});

const FEEDBACK_SELECT = `SELECT f.*, g.name AS guest_name FROM hotel_feedback f JOIN hotel_guests g ON g.id = f.guest_id`;

/** Words that say nothing about the stay (left out of the themes). */
const STOP = new Set(
  "the and was were with that this very from have had our for but not are you your they them their there what when which would could been also just room hotel stay staff really".split(
    " ",
  ),
);

const round1 = (n: number) => Math.round(n * 10) / 10;

export function guestsService(d: HotelDeps, x: { loyalty: Loyalty }) {
  const { core, adapters } = d;
  const { db } = core;
  const { loyalty } = x;

  const programmeView = async (orgId: string) => {
    const p = await programmeOf(db, orgId);
    return {
      programme: p
        ? { name: p.name, minorPerPoint: p.minor_per_point, pointValueMinor: p.point_value_minor, tiers: p.tiers }
        : null,
      chainConnection: adapters.chainLoyalty.state,
    };
  };

  const member = async (orgId: string, id: string) => toMember(await memberRow(db, orgId, id));

  return {
    // ---------------------------------------------------------------- loyalty
    getProgramme: (s: OrgScope) => programmeView(s.orgId),

    async setProgramme(s: OrgScope, b: z.output<typeof hotel.LoyaltyProgramme>) {
      if (new Set(b.tiers.map((t) => t.code)).size !== b.tiers.length) throw fail.invalid("Tier codes must differ");
      await db.tx(async (t) => {
        const before = await programmeOf(t, s.orgId);
        if (before && before.point_value_minor !== b.pointValueMinor) {
          const held = await t.row<{ n: number }>(
            `SELECT (COALESCE((SELECT sum(points) FROM hotel_loyalty_members WHERE org_id = $1), 0)
               + COALESCE((SELECT -sum(points) FROM hotel_loyalty_entries WHERE org_id = $1 AND kind = 'redeem'
                           AND status = 'pending'), 0))::bigint AS n`,
            [s.orgId],
          );
          if ((held?.n ?? 0) > 0)
            throw fail.conflict("Points are outstanding at the current value — the point value cannot change now");
        }
        const removed = before?.tiers.filter((x) => !b.tiers.some((y) => y.code === x.code)).map((x) => x.code) ?? [];
        if (
          removed.length &&
          (await t.row("SELECT 1 FROM hotel_loyalty_members WHERE org_id = $1 AND tier = ANY($2::text[])", [
            s.orgId,
            removed,
          ]))
        )
          throw fail.conflict(`Members are in tier(s) ${removed.join(", ")} — keep those tiers`);
        await t.run(
          `INSERT INTO hotel_loyalty_programmes (org_id, name, minor_per_point, point_value_minor, tiers)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name, minor_per_point = EXCLUDED.minor_per_point,
             point_value_minor = EXCLUDED.point_value_minor, tiers = EXCLUDED.tiers, updated_at = now()`,
          [s.orgId, b.name, b.minorPerPoint, b.pointValueMinor, JSON.stringify(b.tiers)],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Loyalty programme set",
          target: s.orgId,
          before,
          after: b,
        });
      });
      return programmeView(s.orgId);
    },

    async listMembers(s: OrgScope, q?: string) {
      const rows = await db.rows<MemberRow>(
        `SELECT m.*, g.name AS guest_name,
           COALESCE((SELECT -sum(e.points) FROM hotel_loyalty_entries e WHERE e.member_id = m.id AND e.kind = 'redeem'
                     AND e.status = 'pending'), 0)::bigint AS pending
         FROM hotel_loyalty_members m JOIN hotel_guests g ON g.id = m.guest_id
         WHERE m.org_id = $1 AND ($2::text IS NULL OR g.name ILIKE '%' || $2 || '%' OR m.number = $2
           OR lower(g.email) = lower($2) OR g.phone = $2)
         ORDER BY m.number`,
        [s.orgId, q ?? null],
      );
      return { members: rows.map(toMember) };
    },

    async enrol(s: OrgScope, guestId: string) {
      const id = await db.tx((t) => enrol(t, s, guestId, s.today));
      return member(s.orgId, id);
    },

    async getMember(s: OrgScope, id: string) {
      const m = await memberRow(db, s.orgId, id);
      return { member: toMember(m), entries: await entriesOf(db, m.id) };
    },

    async redeem(s: HotelScope, reservationId: string, points: number) {
      const entryId = await db.tx((t) => loyalty.redeem(t, s, reservationId, points));
      const e = await entryRow(db, entryId);
      const m = await db.row<{ member_id: string }>("SELECT member_id FROM hotel_loyalty_entries WHERE id = $1", [
        entryId,
      ]);
      return { member: await member(s.orgId, m?.member_id as string), entry: e };
    },

    async adjust(s: HotelScope, memberId: string, points: number, reason: string) {
      const entryId = await db.tx((t) => loyalty.adjust(t, s, memberId, points, reason));
      return { member: await member(s.orgId, memberId), entry: await entryRow(db, entryId) };
    },

    // ---------------------------------------------------------------- feedback
    async recordFeedback(s: HotelScope, b: z.output<typeof hotel.recordFeedback.body>) {
      const id = newId("hfb");
      await db.tx(async (t) => {
        const r = await t.row<{ id: string; number: string; guest_id: string; guest: string }>(
          `SELECT r.id, r.number, r.guest_id, g.name AS guest FROM hotel_reservations r JOIN hotel_guests g ON g.id = r.guest_id
           WHERE r.property_id = $1 AND r.id = $2`,
          [s.property.id, b.reservationId],
        );
        if (!r) throw fail.notFound("Reservation not found");
        const stayed = await t.row("SELECT 1 FROM hotel_stays WHERE reservation_id = $1 AND status = 'checked_out'", [
          r.id,
        ]);
        if (!stayed) throw fail.conflict("Feedback is recorded after the guest has stayed (checked out)");
        if (await t.row("SELECT 1 FROM hotel_feedback WHERE reservation_id = $1", [r.id]))
          throw fail.conflict(`Feedback for ${r.number} is already recorded`);
        let alert: string | null = null;
        if (b.score <= 2) {
          alert = newId("hrq");
          await t.run(
            `INSERT INTO hotel_requests (id, org_id, property_id, reservation_id, kind, text, source, created_by)
             VALUES ($1,$2,$3,$4,'handoff',$5,'guest',$6)`,
            [
              alert,
              s.orgId,
              s.property.id,
              r.id,
              `Low score ${b.score}/5 from ${r.guest} (${r.number}): ${b.comment || "no comment"}`,
              s.userId,
            ],
          );
          await messageManagers(
            t,
            d,
            s,
            "low_score_alert",
            { guest: r.guest, amount: b.score, number: r.number },
            r.id,
          );
        }
        await t.run(
          `INSERT INTO hotel_feedback (id, org_id, property_id, reservation_id, guest_id, score, categories, comment, source,
             business_date, alert_request_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            s.orgId,
            s.property.id,
            r.id,
            r.guest_id,
            b.score,
            JSON.stringify(b.categories),
            b.comment,
            b.source,
            s.property.business_date,
            alert,
            s.userId,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Guest feedback recorded",
          target: r.number,
          detail: `${b.score}/5${alert ? " — manager alerted" : ""}`,
        });
      });
      return toFeedback((await db.row<FeedbackRow>(`${FEEDBACK_SELECT} WHERE f.id = $1`, [id])) as FeedbackRow);
    },

    async listFeedback(s: HotelScope, q: { from?: string | undefined; to?: string | undefined }) {
      const rows = await db.rows<FeedbackRow>(
        `${FEEDBACK_SELECT} WHERE f.property_id = $1 AND ($2::date IS NULL OR f.business_date >= $2)
           AND ($3::date IS NULL OR f.business_date <= $3) ORDER BY f.business_date, f.id`,
        [s.property.id, q.from ?? null, q.to ?? null],
      );
      return { feedback: rows.map(toFeedback) };
    },

    async feedbackReport(s: HotelScope, from: string, to: string) {
      const rows = await db.rows<FeedbackRow>(
        `${FEEDBACK_SELECT} WHERE f.property_id = $1 AND f.business_date BETWEEN $2 AND $3 ORDER BY f.business_date`,
        [s.property.id, from, to],
      );
      const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
      const months = [...new Set(rows.map((r) => r.business_date.slice(0, 7)))].map((m) => {
        const mine = rows.filter((r) => r.business_date.startsWith(m));
        return {
          month: m,
          responses: mine.length,
          averageScore: avg(mine.map((r) => r.score)),
          lowScores: mine.filter((r) => r.score <= 2).length,
        };
      });
      const cats = new Map<string, number[]>();
      for (const r of rows) for (const [k, v] of Object.entries(r.categories)) cats.set(k, [...(cats.get(k) ?? []), v]);
      const words = new Map<string, number[]>();
      for (const r of rows) {
        const seen = new Set(
          r.comment
            .toLowerCase()
            .split(/[^\p{L}]+/u)
            .filter((w) => w.length > 3 && !STOP.has(w)),
        );
        for (const w of seen) words.set(w, [...(words.get(w) ?? []), r.score]);
      }
      return {
        responses: rows.length,
        averageScore: avg(rows.map((r) => r.score)),
        lowScores: rows.filter((r) => r.score <= 2).length,
        months,
        categories: [...cats.entries()]
          .map(([category, xs]) => ({ category, averageScore: avg(xs), responses: xs.length }))
          .sort((a, b) => a.category.localeCompare(b.category)),
        themes: [...words.entries()]
          .filter(([, xs]) => xs.length >= 2)
          .map(([word, xs]) => ({ word, mentions: xs.length, averageScore: avg(xs) }))
          .sort((a, b) => b.mentions - a.mentions || a.word.localeCompare(b.word))
          .slice(0, 15),
        method: "Rule-based: words repeated across the hotel's own surveys, with their average score — no external AI",
        reviewInvitations: adapters.reviewSites.state,
      };
    },

    // ---------------------------------------------------------------- message templates
    async listTemplates(s: HotelScope) {
      const own = await db.rows<{ template: TemplateKey; language: string; subject: string; body: string }>(
        "SELECT template, language, subject, body FROM hotel_message_templates WHERE property_id = $1 ORDER BY template, language",
        [s.property.id],
      );
      const builtIn = (Object.keys(DEFAULT_TEMPLATES) as TemplateKey[])
        .filter((k) => !own.some((o) => o.template === k && o.language === "en"))
        .map((k) => ({ template: k, language: "en", ...DEFAULT_TEMPLATES[k], custom: false }));
      return { templates: [...own.map((o) => ({ ...o, custom: true })), ...builtIn] };
    },

    async setTemplate(s: HotelScope, template: TemplateKey, b: { language: string; subject: string; body: string }) {
      await db.tx(async (t) => {
        await t.run(
          `INSERT INTO hotel_message_templates (property_id, template, language, org_id, subject, body, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (property_id, template, language) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body,
             updated_by = EXCLUDED.updated_by`,
          [s.property.id, template, b.language, s.orgId, b.subject, b.body, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Message template set",
          target: `${template}/${b.language}`,
        });
      });
      return { template, language: b.language, subject: b.subject, body: b.body, custom: true };
    },

    // ---------------------------------------------------------------- personalisation
    async personalisation(s: HotelScope, date: string) {
      const arrivals = await db.rows<{
        reservation_id: string;
        number: string;
        guest_id: string;
        name: string;
        vip: boolean;
        preferences: Record<string, string>;
        allergies: string | null;
      }>(
        `SELECT DISTINCT r.id AS reservation_id, r.number, g.id AS guest_id, g.name, g.vip, g.preferences, g.allergies
         FROM hotel_reservations r JOIN hotel_guests g ON g.id = r.guest_id
         JOIN hotel_stays st ON st.reservation_id = r.id
         WHERE r.property_id = $1 AND st.arrival = $2 AND st.status IN ('reserved', 'in_house') ORDER BY r.number`,
        [s.property.id, date],
      );
      const out = [];
      for (const a of arrivals) {
        const past = await db.row<{ stays: number; spend: number; spa: number; fnb: number }>(
          `SELECT
             (SELECT count(DISTINCT r.id)::int FROM hotel_reservations r JOIN hotel_stays st ON st.reservation_id = r.id
               WHERE r.guest_id = $1 AND r.id <> $2 AND st.status = 'checked_out') AS stays,
             COALESCE((SELECT sum(l.net_minor) FROM hotel_folio_lines l JOIN hotel_folios f ON f.id = l.folio_id
               JOIN hotel_reservations r ON r.id = f.reservation_id
               WHERE r.guest_id = $1 AND r.id <> $2 AND l.kind IN ('charge', 'void', 'allowance')), 0)::bigint AS spend,
             COALESCE((SELECT sum(l.net_minor) FROM hotel_folio_lines l JOIN hotel_folios f ON f.id = l.folio_id
               JOIN hotel_reservations r ON r.id = f.reservation_id
               WHERE r.guest_id = $1 AND r.id <> $2 AND l.kind = 'charge' AND l.department = 'spa'), 0)::bigint AS spa,
             COALESCE((SELECT sum(l.net_minor) FROM hotel_folio_lines l JOIN hotel_folios f ON f.id = l.folio_id
               JOIN hotel_reservations r ON r.id = f.reservation_id
               WHERE r.guest_id = $1 AND r.id <> $2 AND l.kind = 'charge' AND l.department = 'fnb'), 0)::bigint AS fnb`,
          [a.guest_id, a.reservation_id],
        );
        const extras = await db.rows<{ name: string }>(
          `SELECT DISTINCT u.name FROM hotel_reservation_upsells ru JOIN hotel_upsells u ON u.id = ru.upsell_id
           JOIN hotel_reservations r ON r.id = ru.reservation_id
           WHERE r.guest_id = $1 AND r.id <> $2 AND ru.status = 'posted' ORDER BY u.name`,
          [a.guest_id, a.reservation_id],
        );
        const m = await memberOfGuest(db, a.guest_id);
        const last = await db.row<{ score: number }>(
          "SELECT score FROM hotel_feedback WHERE guest_id = $1 ORDER BY created_at DESC LIMIT 1",
          [a.guest_id],
        );
        const temp = Number.parseFloat(a.preferences.temperature ?? a.preferences.temp ?? "");
        const offers = [
          ...((past?.spa ?? 0) > 0 ? ["Spa treatment (booked spa before)"] : []),
          ...((past?.fnb ?? 0) > 0 ? ["Dinner reservation at the restaurant (dined before)"] : []),
          ...extras.map((e) => `${e.name} (taken on an earlier stay)`),
          ...(m ? [] : ["Invite to the loyalty programme"]),
          ...(a.vip ? ["VIP welcome amenity"] : []),
        ];
        out.push({
          reservationId: a.reservation_id,
          number: a.number,
          guestId: a.guest_id,
          guestName: a.name,
          vip: a.vip,
          returning: (past?.stays ?? 0) > 0,
          previousStays: past?.stays ?? 0,
          previousSpendMinor: past?.spend ?? 0,
          loyaltyTier: m?.tier ?? null,
          preferences: a.preferences,
          allergies: a.allergies,
          lastScore: last?.score ?? null,
          roomSetup: {
            temperatureC: Number.isFinite(temp) ? temp : null,
            notes: Object.entries(a.preferences)
              .filter(([k]) => !["temperature", "temp"].includes(k))
              .map(([k, v]) => `${k}: ${v}`),
          },
          offers,
        });
      }
      return {
        date,
        arrivals: out,
        method:
          "Rules over the hotel's own records (past stays, spend by department, extras, loyalty, surveys) — no external AI",
      };
    },
  };
}

export type GuestsService = ReturnType<typeof guestsService>;
