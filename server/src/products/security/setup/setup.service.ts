/*
 * Security set-up: settings, payroll rules (configuration rows), clients and their portal users, sites, posts and
 * versioned post orders, patrol checkpoints, contracts with service levels, and the sales pipeline. Every change is
 * audited.
 */
import type { security, z } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { nextNumber } from "../../../db/counters.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import type { SecurityDeps } from "../deps.js";
import { actingGuard } from "../shared/access.js";
import {
  findClient,
  findSite,
  fromBp,
  memberRole,
  must,
  shareOf,
  toBp,
  type ClientRow,
  type SiteRow,
} from "../shared/util.js";

type Body<E extends { body: z.ZodType }> = z.output<E["body"]>;

interface SettingsRow {
  late_fee_bp: number | null;
  licence_alert_days: number;
  min_rest_hours: number;
  clock_in_early_minutes: number;
  no_show_grace_minutes: number;
  visitor_retention_days: number;
  personal_relief_minor: number;
}

/** The organisation's settings row (created with the defaults on first use). */
export async function loadSettings(t: Db, orgId: string): Promise<SettingsRow> {
  await t.run("INSERT INTO sec_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING", [orgId]);
  return must(await t.row<SettingsRow>("SELECT * FROM sec_settings WHERE org_id = $1", [orgId]), "settings");
}

const toSettings = (r: SettingsRow): security.Settings => ({
  lateFeePct: r.late_fee_bp === null ? null : fromBp(r.late_fee_bp),
  licenceAlertDays: r.licence_alert_days,
  minRestHours: r.min_rest_hours,
  clockInEarlyMinutes: r.clock_in_early_minutes,
  noShowGraceMinutes: r.no_show_grace_minutes,
  visitorRetentionDays: r.visitor_retention_days,
});

export const toClient = (c: ClientRow, portalUserIds: string[]): security.Client => ({
  id: c.id,
  number: c.number,
  name: c.name,
  contactName: c.contact_name,
  email: c.email,
  phone: c.phone,
  paymentTermsDays: c.payment_terms_days,
  whtPct: fromBp(c.wht_bp),
  vatWhtPct: fromBp(c.vat_wht_bp),
  creditLimitMinor: c.credit_limit_minor,
  portalUserIds,
});

export const toSite = (s: SiteRow): security.Site => ({
  id: s.id,
  clientId: s.client_id,
  name: s.name,
  area: s.area,
  kind: s.kind,
  risk: s.risk,
  geofence:
    s.lat !== null && s.lng !== null && s.radius_m !== null ? { lat: s.lat, lng: s.lng, radiusM: s.radius_m } : null,
  instructions: s.instructions,
  alarmMonitoring:
    s.alarm_provider && s.alarm_account_ref ? { provider: s.alarm_provider, accountRef: s.alarm_account_ref } : null,
  active: s.active,
});

interface PostRow {
  id: string;
  site_id: string;
  name: string;
  cover: "24h" | "day" | "night";
  guards_required: number;
  order_version: number;
  order_text: string;
  order_updated_at: string | null;
  acked: string[];
}
const POST_SELECT = `SELECT p.*, COALESCE((SELECT array_agg(a.guard_id ORDER BY a.guard_id) FROM sec_post_order_acks a
  WHERE a.post_id = p.id AND a.version = p.order_version), '{}') AS acked FROM sec_posts p`;
const toPost = (p: PostRow) => ({
  id: p.id,
  siteId: p.site_id,
  name: p.name,
  cover: p.cover,
  guardsRequired: p.guards_required,
  orderVersion: p.order_version,
  orderText: p.order_text,
  orderUpdatedAt: p.order_updated_at,
  acknowledgedBy: p.acked,
});

interface CheckpointRow {
  id: string;
  site_id: string;
  code: string;
  name: string;
  tag_ref: string;
  seq: number;
  offset_minutes: number;
  grace_minutes: number;
}
export const toCheckpoint = (c: CheckpointRow) => ({
  id: c.id,
  siteId: c.site_id,
  code: c.code,
  name: c.name,
  tagRef: c.tag_ref,
  seq: c.seq,
  offsetMinutes: c.offset_minutes,
  graceMinutes: c.grace_minutes,
});

export interface ContractRow {
  id: string;
  number: string;
  client_id: string;
  site_id: string;
  start_date: string;
  end_date: string | null;
  monthly_fee_minor: number;
  extra_hour_rate_minor: number;
  vat_bp: number;
  patrol_target_bp: number;
  response_minutes: number;
  status: "active" | "ended";
}
export const toContract = (c: ContractRow): security.Contract => ({
  id: c.id,
  number: c.number,
  clientId: c.client_id,
  siteId: c.site_id,
  startDate: c.start_date,
  endDate: c.end_date,
  monthlyFeeMinor: c.monthly_fee_minor,
  extraHourRateMinor: c.extra_hour_rate_minor,
  vatPct: fromBp(c.vat_bp),
  patrolTargetPct: fromBp(c.patrol_target_bp),
  responseMinutes: c.response_minutes,
  status: c.status,
});

interface OpportunityRow {
  id: string;
  name: string;
  stage: z.infer<typeof security.Opportunity>["stage"];
  guards_per_shift: number;
  grade: string | null;
  monthly_quote_minor: number | null;
  survey_date: string | null;
  client_id: string | null;
  note: string;
}

const STAGE_ORDER = ["enquiry", "survey", "quoted", "won"] as const;

export function setupService(d: SecurityDeps) {
  const { db } = d.core;

  async function portalUsers(t: Db, clientId: string): Promise<string[]> {
    return (
      await t.rows<{ user_id: string }>("SELECT user_id FROM sec_client_users WHERE client_id = $1 ORDER BY user_id", [
        clientId,
      ])
    ).map((r) => r.user_id);
  }

  async function client(t: Db, orgId: string, id: string) {
    return toClient(await findClient(t, orgId, id), await portalUsers(t, id));
  }

  async function post(t: Db, orgId: string, id: string) {
    const p = await t.row<PostRow>(`${POST_SELECT} WHERE p.org_id = $1 AND p.id = $2`, [orgId, id]);
    if (!p) throw fail.notFound("Post not found");
    return toPost(p);
  }

  async function contractRow(t: Db, orgId: string, id: string) {
    const c = await t.row<ContractRow>("SELECT * FROM sec_contracts WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!c) throw fail.notFound("Contract not found");
    return c;
  }

  /** Estimated monthly cost of a guarded position: guards × 24 h × 30 days at the grade rate + employer share. */
  async function estimate(t: Db, orgId: string, guards: number, grade: string | null): Promise<number | null> {
    if (!grade) return null;
    const rate = await t.row<{ hourly_minor: number }>(
      "SELECT hourly_minor FROM sec_pay_rates WHERE org_id = $1 AND grade = $2",
      [orgId, grade],
    );
    if (!rate) return null;
    const employer = await t.row<{ bp: number }>(
      "SELECT COALESCE(sum(rate_bp), 0)::int AS bp FROM sec_statutory_rules WHERE org_id = $1 AND party = 'employer'",
      [orgId],
    );
    const wages = guards * 24 * 30 * rate.hourly_minor;
    return wages + shareOf(wages, employer?.bp ?? 0);
  }

  async function opportunity(t: Db, orgId: string, id: string): Promise<z.infer<typeof security.Opportunity>> {
    const o = await t.row<OpportunityRow>("SELECT * FROM sec_opportunities WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!o) throw fail.notFound("Opportunity not found");
    const cost = await estimate(t, orgId, o.guards_per_shift, o.grade);
    const margin =
      cost !== null && o.monthly_quote_minor
        ? Math.round(((o.monthly_quote_minor - cost) / o.monthly_quote_minor) * 1000) / 10
        : null;
    return {
      id: o.id,
      name: o.name,
      stage: o.stage,
      guardsPerShift: o.guards_per_shift,
      grade: o.grade,
      monthlyQuoteMinor: o.monthly_quote_minor,
      estimatedMonthlyCostMinor: cost,
      marginPct: margin,
      surveyDate: o.survey_date,
      clientId: o.client_id,
      note: o.note,
    };
  }

  async function insertClient(t: Db, s: OrgScope, b: Body<typeof security.createClient>) {
    const id = newId("scl");
    await t.run(
      `INSERT INTO sec_clients (id, org_id, number, name, contact_name, email, phone, payment_terms_days, wht_bp,
         vat_wht_bp, credit_limit_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        s.orgId,
        await nextNumber(t, s.orgId, "SCL"),
        b.name,
        b.contactName,
        b.email ?? null,
        b.phone ?? null,
        b.paymentTermsDays,
        toBp(b.whtPct),
        toBp(b.vatWhtPct),
        b.creditLimitMinor,
      ],
    );
    await recordAudit(t, {
      actor: s.actor,
      orgId: s.orgId,
      action: "Security client added",
      target: id,
      detail: b.name,
    });
    return id;
  }

  return {
    // ---------------------------------------------------------------- settings
    async getSettings(s: OrgScope) {
      return toSettings(await loadSettings(db, s.orgId));
    },

    async updateSettings(s: OrgScope, b: Body<typeof security.updateSettings>) {
      return db.tx(async (t) => {
        const before = toSettings(await loadSettings(t, s.orgId));
        await t.run(
          `UPDATE sec_settings SET
             late_fee_bp = CASE WHEN $2::boolean THEN $3::int ELSE late_fee_bp END,
             licence_alert_days = COALESCE($4, licence_alert_days), min_rest_hours = COALESCE($5, min_rest_hours),
             clock_in_early_minutes = COALESCE($6, clock_in_early_minutes),
             no_show_grace_minutes = COALESCE($7, no_show_grace_minutes),
             visitor_retention_days = COALESCE($8, visitor_retention_days)
           WHERE org_id = $1`,
          [
            s.orgId,
            b.lateFeePct !== undefined,
            b.lateFeePct === undefined || b.lateFeePct === null ? null : toBp(b.lateFeePct),
            b.licenceAlertDays ?? null,
            b.minRestHours ?? null,
            b.clockInEarlyMinutes ?? null,
            b.noShowGraceMinutes ?? null,
            b.visitorRetentionDays ?? null,
          ],
        );
        const after = toSettings(await loadSettings(t, s.orgId));
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Security settings changed", before, after });
        return after;
      });
    },

    async getPayrollRules(s: OrgScope): Promise<security.PayrollRules> {
      return payrollRules(db, s.orgId);
    },

    async setPayrollRules(s: OrgScope, b: Body<typeof security.setPayrollRules>) {
      const grades = b.payRates.map((r) => r.grade.toLowerCase());
      if (new Set(grades).size !== grades.length) throw fail.invalid("Each grade can have one pay rate");
      const keys = b.statutory.map((r) => `${r.party}:${r.code}`);
      if (new Set(keys).size !== keys.length) throw fail.invalid("Each statutory code appears once per party");
      const n = b.incomeTaxBands.length;
      if (b.incomeTaxBands.some((x, i) => (x.widthMinor === null) !== (i === n - 1)))
        throw fail.invalid("Every income-tax band has a width except the last one (everything above)");
      return db.tx(async (t) => {
        const before = await payrollRules(t, s.orgId);
        await loadSettings(t, s.orgId);
        await t.run("DELETE FROM sec_pay_rates WHERE org_id = $1", [s.orgId]);
        await t.run("DELETE FROM sec_statutory_rules WHERE org_id = $1", [s.orgId]);
        await t.run("DELETE FROM sec_income_tax_bands WHERE org_id = $1", [s.orgId]);
        for (const r of b.payRates)
          await t.run(
            "INSERT INTO sec_pay_rates (org_id, grade, hourly_minor, overtime_bp, holiday_bp) VALUES ($1,$2,$3,$4,$5)",
            [s.orgId, r.grade, r.hourlyMinor, toBp(r.overtimePct), toBp(r.holidayPct)],
          );
        for (const [i, r] of b.statutory.entries())
          await t.run(
            `INSERT INTO sec_statutory_rules (org_id, code, party, label, rate_bp, min_minor, base_cap_minor,
               reduces_taxable_pay, seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [s.orgId, r.code, r.party, r.label, toBp(r.pct), r.minMinor, r.baseCapMinor, r.reducesTaxablePay, i],
          );
        for (const [i, r] of b.incomeTaxBands.entries())
          await t.run("INSERT INTO sec_income_tax_bands (org_id, seq, width_minor, rate_bp) VALUES ($1,$2,$3,$4)", [
            s.orgId,
            i,
            r.widthMinor,
            toBp(r.pct),
          ]);
        await t.run("UPDATE sec_settings SET personal_relief_minor = $2 WHERE org_id = $1", [
          s.orgId,
          b.personalReliefMinor,
        ]);
        const after = await payrollRules(t, s.orgId);
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Payroll rules changed", before, after });
        return after;
      });
    },

    // ---------------------------------------------------------------- clients
    async listClients(s: OrgScope) {
      const rows = await db.rows<ClientRow>("SELECT * FROM sec_clients WHERE org_id = $1 ORDER BY name", [s.orgId]);
      const clients = [];
      for (const c of rows) clients.push(toClient(c, await portalUsers(db, c.id)));
      return { clients };
    },

    async createClient(s: OrgScope, b: Body<typeof security.createClient>) {
      return db.tx(async (t) => client(t, s.orgId, await insertClient(t, s, b)));
    },

    async setPortalUsers(s: OrgScope, clientId: string, userIds: string[]) {
      return db.tx(async (t) => {
        await findClient(t, s.orgId, clientId);
        for (const u of userIds)
          if ((await memberRole(t, s.orgId, u)) !== "security_client")
            throw fail.invalid("Portal users must be members with the security client role");
        await t.run("DELETE FROM sec_client_users WHERE client_id = $1", [clientId]);
        for (const u of new Set(userIds))
          await t.run("INSERT INTO sec_client_users (client_id, org_id, user_id) VALUES ($1, $2, $3)", [
            clientId,
            s.orgId,
            u,
          ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Client portal users set",
          target: clientId,
          after: userIds,
        });
        return client(t, s.orgId, clientId);
      });
    },

    // ---------------------------------------------------------------- sites, posts, checkpoints
    async listSites(s: OrgScope) {
      const rows = await db.rows<SiteRow>("SELECT * FROM sec_sites WHERE org_id = $1 ORDER BY name", [s.orgId]);
      return { sites: rows.map(toSite) };
    },

    async createSite(s: OrgScope, b: Body<typeof security.createSite>) {
      return db.tx(async (t) => {
        if (b.clientId) await findClient(t, s.orgId, b.clientId);
        const id = newId("sst");
        await t.run(
          `INSERT INTO sec_sites (id, org_id, client_id, name, area, kind, risk, lat, lng, radius_m, instructions,
             alarm_provider, alarm_account_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            s.orgId,
            b.clientId,
            b.name,
            b.area,
            b.kind,
            b.risk,
            b.geofence?.lat ?? null,
            b.geofence?.lng ?? null,
            b.geofence?.radiusM ?? null,
            b.instructions,
            b.alarmMonitoring?.provider ?? null,
            b.alarmMonitoring?.accountRef ?? null,
          ],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Security site added",
          target: id,
          detail: b.name,
        });
        return toSite(await findSite(t, s.orgId, id));
      });
    },

    async getSite(s: OrgScope, siteId: string) {
      const site = await findSite(db, s.orgId, siteId);
      const posts = await db.rows<PostRow>(`${POST_SELECT} WHERE p.site_id = $1 ORDER BY p.name`, [siteId]);
      const cps = await db.rows<CheckpointRow>("SELECT * FROM sec_checkpoints WHERE site_id = $1 ORDER BY seq", [
        siteId,
      ]);
      const c = await db.row<ContractRow>("SELECT * FROM sec_contracts WHERE site_id = $1 AND status = 'active'", [
        siteId,
      ]);
      return {
        ...toSite(site),
        posts: posts.map(toPost),
        checkpoints: cps.map(toCheckpoint),
        contract: c ? toContract(c) : null,
      };
    },

    async createPost(s: OrgScope, siteId: string, b: Body<typeof security.createPost>) {
      return db.tx(async (t) => {
        await findSite(t, s.orgId, siteId);
        const id = newId("spo");
        const hasOrder = b.orderText.length > 0;
        await t.run(
          `INSERT INTO sec_posts (id, org_id, site_id, name, cover, guards_required, order_version, order_text,
             order_updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            s.orgId,
            siteId,
            b.name,
            b.cover,
            b.guardsRequired,
            hasOrder ? 1 : 0,
            b.orderText,
            hasOrder ? new Date() : null,
          ],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Post added", target: id, detail: b.name });
        return post(t, s.orgId, id);
      });
    },

    /** Change only the fields sent; the change is audited with the values before and after. */
    async updateSite(s: OrgScope, siteId: string, b: Body<typeof security.updateSite>) {
      return db.tx(async (t) => {
        const before = await findSite(t, s.orgId, siteId);
        if (b.clientId) await findClient(t, s.orgId, b.clientId);
        const has = (k: keyof typeof b) => b[k] !== undefined;
        await t.run(
          `UPDATE sec_sites SET client_id = $3, name = $4, area = $5, kind = $6, risk = $7, lat = $8, lng = $9,
             radius_m = $10, instructions = $11, alarm_provider = $12, alarm_account_ref = $13
           WHERE org_id = $1 AND id = $2`,
          [
            s.orgId,
            siteId,
            has("clientId") ? b.clientId : before.client_id,
            b.name ?? before.name,
            b.area ?? before.area,
            b.kind ?? before.kind,
            b.risk ?? before.risk,
            has("geofence") ? (b.geofence?.lat ?? null) : before.lat,
            has("geofence") ? (b.geofence?.lng ?? null) : before.lng,
            has("geofence") ? (b.geofence?.radiusM ?? null) : before.radius_m,
            b.instructions ?? before.instructions,
            has("alarmMonitoring") ? (b.alarmMonitoring?.provider ?? null) : before.alarm_provider,
            has("alarmMonitoring") ? (b.alarmMonitoring?.accountRef ?? null) : before.alarm_account_ref,
          ],
        );
        const after = await findSite(t, s.orgId, siteId);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Security site changed",
          target: siteId,
          before: toSite(before),
          after: toSite(after),
        });
        return toSite(after);
      });
    },

    async updatePostOrder(s: OrgScope, postId: string, text: string) {
      return db.tx(async (t) => {
        const n = await t.run(
          `UPDATE sec_posts SET order_version = order_version + 1, order_text = $3, order_updated_at = now()
           WHERE org_id = $1 AND id = $2`,
          [s.orgId, postId, text],
        );
        if (!n) throw fail.notFound("Post not found");
        const p = await post(t, s.orgId, postId);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Post order published",
          target: postId,
          detail: `Version ${p.orderVersion}`,
        });
        return p;
      });
    },

    async acknowledgePostOrder(s: OrgScope, postId: string, guardId: string, version: number) {
      return db.tx(async (t) => {
        const p = await post(t, s.orgId, postId);
        await actingGuard(t, s, guardId);
        if (p.orderVersion === 0) throw fail.conflict("This post has no post order yet");
        if (version !== p.orderVersion)
          throw fail.conflict(`The current post order is version ${p.orderVersion}: read it and acknowledge that one`);
        await t.run(
          `INSERT INTO sec_post_order_acks (post_id, version, guard_id, org_id, acked_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [postId, version, guardId, s.orgId, s.userId],
        );
        return post(t, s.orgId, postId);
      });
    },

    async createCheckpoints(s: OrgScope, siteId: string, b: Body<typeof security.createCheckpoints>) {
      return db.tx(async (t) => {
        await findSite(t, s.orgId, siteId);
        const start = await t.row<{ n: number }>(
          "SELECT COALESCE(max(seq), 0)::int AS n FROM sec_checkpoints WHERE site_id = $1",
          [siteId],
        );
        let seq = start?.n ?? 0;
        for (const c of b.checkpoints)
          await t.run(
            `INSERT INTO sec_checkpoints (id, org_id, site_id, code, name, tag_ref, seq, offset_minutes, grace_minutes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [newId("scp"), s.orgId, siteId, c.code, c.name, c.tagRef, ++seq, c.offsetMinutes, c.graceMinutes],
          );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Patrol checkpoints added",
          target: siteId,
          detail: b.checkpoints.map((c) => c.code).join(", "),
        });
        const rows = await t.rows<CheckpointRow>("SELECT * FROM sec_checkpoints WHERE site_id = $1 ORDER BY seq", [
          siteId,
        ]);
        return { checkpoints: rows.map(toCheckpoint) };
      });
    },

    // ---------------------------------------------------------------- contracts
    async listContracts(s: OrgScope) {
      const rows = await db.rows<ContractRow>("SELECT * FROM sec_contracts WHERE org_id = $1 ORDER BY number", [
        s.orgId,
      ]);
      return { contracts: rows.map(toContract) };
    },

    async createContract(s: OrgScope, b: Body<typeof security.createContract>) {
      if (b.endDate && b.endDate < b.startDate) throw fail.invalid("The contract ends before it starts");
      return db.tx(async (t) => {
        await findClient(t, s.orgId, b.clientId);
        const site = await findSite(t, s.orgId, b.siteId);
        if (site.client_id !== b.clientId) throw fail.invalid("This site does not belong to this client");
        const id = newId("sct");
        try {
          await t.run(
            `INSERT INTO sec_contracts (id, org_id, number, client_id, site_id, start_date, end_date, monthly_fee_minor,
               extra_hour_rate_minor, vat_bp, patrol_target_bp, response_minutes, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13)`,
            [
              id,
              s.orgId,
              await nextNumber(t, s.orgId, "SCT"),
              b.clientId,
              b.siteId,
              b.startDate,
              b.endDate,
              b.monthlyFeeMinor,
              b.extraHourRateMinor,
              toBp(b.vatPct),
              toBp(b.patrolTargetPct),
              b.responseMinutes,
              s.userId,
            ],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw fail.conflict("This site already has an active contract: end it first");
          throw e;
        }
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Security contract created",
          target: id,
          after: b,
        });
        return toContract(await contractRow(t, s.orgId, id));
      });
    },

    async endContract(s: OrgScope, contractId: string, endDate: string, reason: string) {
      return db.tx(async (t) => {
        const c = await contractRow(t, s.orgId, contractId);
        if (c.status !== "active") throw fail.conflict("This contract has already ended");
        if (endDate < c.start_date) throw fail.invalid("The end date is before the contract started");
        await t.run("UPDATE sec_contracts SET status = 'ended', end_date = $2 WHERE id = $1", [contractId, endDate]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Security contract ended",
          target: c.number,
          detail: reason,
        });
        return toContract(await contractRow(t, s.orgId, contractId));
      });
    },

    // ---------------------------------------------------------------- sales pipeline
    async listOpportunities(s: OrgScope) {
      const ids = await db.rows<{ id: string }>(
        "SELECT id FROM sec_opportunities WHERE org_id = $1 ORDER BY created_at",
        [s.orgId],
      );
      const opportunities = [];
      for (const r of ids) opportunities.push(await opportunity(db, s.orgId, r.id));
      return { opportunities };
    },

    async createOpportunity(s: OrgScope, b: Body<typeof security.createOpportunity>) {
      return db.tx(async (t) => {
        const id = newId("sop");
        await t.run(
          `INSERT INTO sec_opportunities (id, org_id, name, stage, guards_per_shift, grade, note, created_by)
           VALUES ($1,$2,$3,'enquiry',$4,$5,$6,$7)`,
          [id, s.orgId, b.name, b.guardsPerShift, b.grade ?? null, b.note, s.userId],
        );
        await recordAudit(t, { actor: s.actor, orgId: s.orgId, action: "Enquiry added", target: id, detail: b.name });
        return opportunity(t, s.orgId, id);
      });
    },

    async moveOpportunity(s: OrgScope, id: string, b: Body<typeof security.moveOpportunity>) {
      return db.tx(async (t) => {
        const o = await t.row<OpportunityRow>(
          "SELECT * FROM sec_opportunities WHERE org_id = $1 AND id = $2 FOR UPDATE",
          [s.orgId, id],
        );
        if (!o) throw fail.notFound("Opportunity not found");
        if (o.stage === "won" || o.stage === "lost") throw fail.conflict(`This opportunity is already ${o.stage}`);
        if (b.stage !== "lost" && STAGE_ORDER.indexOf(b.stage) < STAGE_ORDER.indexOf(o.stage))
          throw fail.conflict("An opportunity only moves forward (or to lost)");
        const quote = b.monthlyQuoteMinor ?? o.monthly_quote_minor;
        if ((b.stage === "quoted" || b.stage === "won") && !quote)
          throw fail.invalid("A quote needs the monthly amount (monthlyQuoteMinor)");
        let clientId = o.client_id;
        if (b.stage === "won" && !clientId) {
          if (!b.client) throw fail.invalid("Winning an opportunity creates the client: send the client details");
          clientId = await insertClient(t, s, b.client);
        }
        await t.run(
          `UPDATE sec_opportunities SET stage = $2, survey_date = COALESCE($3, survey_date), monthly_quote_minor = $4,
             grade = COALESCE($5, grade), client_id = $6, note = COALESCE($7, note) WHERE id = $1`,
          [id, b.stage, b.surveyDate ?? null, quote, b.grade ?? null, clientId, b.note ?? null],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Opportunity moved",
          target: id,
          detail: `${o.stage} → ${b.stage}`,
        });
        return opportunity(t, s.orgId, id);
      });
    },
  };
}

export type SetupService = ReturnType<typeof setupService>;

/** The organisation's payroll rules as configured. */
export async function payrollRules(t: Db, orgId: string): Promise<security.PayrollRules> {
  const rates = await t.rows<{ grade: string; hourly_minor: number; overtime_bp: number; holiday_bp: number }>(
    "SELECT * FROM sec_pay_rates WHERE org_id = $1 ORDER BY grade",
    [orgId],
  );
  const rules = await t.rows<{
    code: string;
    label: string;
    party: "employee" | "employer";
    rate_bp: number;
    min_minor: number;
    base_cap_minor: number | null;
    reduces_taxable_pay: boolean;
  }>("SELECT * FROM sec_statutory_rules WHERE org_id = $1 ORDER BY seq", [orgId]);
  const bands = await t.rows<{ width_minor: number | null; rate_bp: number }>(
    "SELECT * FROM sec_income_tax_bands WHERE org_id = $1 ORDER BY seq",
    [orgId],
  );
  const settings = await t.row<{ personal_relief_minor: number }>(
    "SELECT personal_relief_minor FROM sec_settings WHERE org_id = $1",
    [orgId],
  );
  return {
    payRates: rates.map((r) => ({
      grade: r.grade,
      hourlyMinor: r.hourly_minor,
      overtimePct: fromBp(r.overtime_bp),
      holidayPct: fromBp(r.holiday_bp),
    })),
    statutory: rules.map((r) => ({
      code: r.code,
      label: r.label,
      party: r.party,
      pct: fromBp(r.rate_bp),
      minMinor: r.min_minor,
      baseCapMinor: r.base_cap_minor,
      reducesTaxablePay: r.reduces_taxable_pay,
    })),
    incomeTaxBands: bands.map((b) => ({ widthMinor: b.width_minor, pct: fromBp(b.rate_bp) })),
    personalReliefMinor: settings?.personal_relief_minor ?? 0,
  };
}
