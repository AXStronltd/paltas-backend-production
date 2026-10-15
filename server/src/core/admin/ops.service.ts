/*
 * PALTAS Super Admin operations for production: organisation suspension and reactivation, catalogue price changes
 * that need a second Super Admin, and audit search. Staff only (route auth "staff"); changes need super_admin and are
 * audited. A client account — an owner, an organisation administrator — never reaches any of this.
 */
import type { ops, z } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audit/audit.service.js";
import { saveModule, savePlan, type PlanRow } from "../catalogue/catalogue.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { staffActor } from "./admin.service.js";

type PriceChangeDto = ops.PriceChange;
type PriceRequest = z.infer<typeof ops.requestPriceChange.body>;
type AuditQuery = z.infer<typeof ops.auditSearch.query>;

interface ChangeRow {
  id: string;
  target_kind: "plan" | "module";
  target_id: string;
  before: Record<string, unknown>;
  proposed: Record<string, unknown>;
  applied: Record<string, unknown> | null;
  reason: string;
  status: "pending" | "applied" | "rejected";
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

const toChange = (r: ChangeRow): PriceChangeDto => ({
  id: r.id,
  target: r.target_kind,
  targetId: r.target_id,
  before: r.before,
  proposed: r.proposed,
  applied: r.applied,
  reason: r.reason,
  status: r.status,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
});

const planPrices = (p: PlanRow) => ({
  baseMinor: p.base_minor,
  extraBuildingMinor: p.extra_building_minor,
  currency: p.currency,
});

interface ModulePriceRow {
  price_minor: number | null;
  price_ccy: string | null;
}
const modulePrices = (m: ModulePriceRow) => ({ priceMinor: m.price_minor, currency: m.price_ccy });

/** Same prices, whatever the key order (jsonb reorders keys). */
const samePrices = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => (a[k] ?? null) === (b[k] ?? null));

async function currentPrices(t: Db, kind: "plan" | "module", id: string, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  if (kind === "plan") {
    const p = await t.row<PlanRow>(`SELECT * FROM catalogue_plans WHERE id = $1${suffix}`, [id]);
    if (!p) throw fail.notFound("Unknown plan");
    return { plan: p, prices: planPrices(p) as Record<string, unknown> };
  }
  const m = await t.row<ModulePriceRow>(
    `SELECT price_minor, price_ccy FROM catalogue_modules WHERE key = $1${suffix}`,
    [id],
  );
  if (!m) throw fail.notFound("Unknown module");
  return { plan: null, prices: modulePrices(m) as Record<string, unknown> };
}

export function opsService(ctx: AppContext) {
  const { db } = ctx;

  async function loadChange(t: Db, id: string): Promise<ChangeRow> {
    const c = await t.row<ChangeRow>("SELECT * FROM catalogue_price_changes WHERE id = $1 FOR UPDATE", [id]);
    if (!c) throw fail.notFound("No such price change");
    if (c.status !== "pending") throw fail.conflict(`This price change is already ${c.status}`);
    return c;
  }

  return {
    // ---------------------------------------------------------------- suspension

    async suspend(user: SessionUser, orgId: string, reason: string) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        const o = await t.row<{ suspended_at: string | null }>(
          "SELECT suspended_at FROM organisations WHERE id = $1 FOR UPDATE",
          [orgId],
        );
        if (!o) throw fail.notFound("Organisation not found");
        if (o.suspended_at) throw fail.conflict("This organisation is already suspended");
        const row = await t.row<{ suspended_at: string }>(
          "UPDATE organisations SET suspended_at = now(), suspended_reason = $2 WHERE id = $1 RETURNING suspended_at",
          [orgId, reason],
        );
        await t.run("INSERT INTO org_suspensions (org_id, action, reason, by_user) VALUES ($1,'suspend',$2,$3)", [
          orgId,
          reason,
          user.id,
        ]);
        await recordAudit(t, { actor, orgId, action: "Organisation suspended", target: orgId, detail: reason });
        return { orgId, suspended: true as const, since: (row as { suspended_at: string }).suspended_at };
      });
    },

    async reactivate(user: SessionUser, orgId: string, reason: string) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        const o = await t.row<{ suspended_at: string | null; suspended_reason: string | null }>(
          "SELECT suspended_at, suspended_reason FROM organisations WHERE id = $1 FOR UPDATE",
          [orgId],
        );
        if (!o) throw fail.notFound("Organisation not found");
        if (!o.suspended_at) throw fail.conflict("This organisation is not suspended");
        await t.run("UPDATE organisations SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1", [orgId]);
        await t.run("INSERT INTO org_suspensions (org_id, action, reason, by_user) VALUES ($1,'reactivate',$2,$3)", [
          orgId,
          reason,
          user.id,
        ]);
        await recordAudit(t, {
          actor,
          orgId,
          action: "Organisation reactivated",
          target: orgId,
          detail: reason,
          before: { suspendedSince: o.suspended_at, reason: o.suspended_reason },
        });
        return { orgId, suspended: false as const };
      });
    },

    async suspensions(orgId: string) {
      const o = await db.row<{ suspended_at: string | null; suspended_reason: string | null }>(
        "SELECT suspended_at, suspended_reason FROM organisations WHERE id = $1",
        [orgId],
      );
      if (!o) throw fail.notFound("Organisation not found");
      const history = await db.rows<{
        id: number;
        action: "suspend" | "reactivate";
        reason: string;
        by_user: string;
        at: string;
      }>("SELECT * FROM org_suspensions WHERE org_id = $1 ORDER BY id DESC", [orgId]);
      return {
        suspended: !!o.suspended_at,
        reason: o.suspended_reason,
        since: o.suspended_at,
        history: history.map((h) => ({
          id: String(h.id),
          action: h.action,
          reason: h.reason,
          byUserId: h.by_user,
          at: h.at,
        })),
      };
    },

    // ---------------------------------------------------------------- price changes

    async requestPriceChange(user: SessionUser, b: PriceRequest) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        const { prices } = await currentPrices(t, b.target, b.targetId);
        const proposed =
          b.target === "plan"
            ? {
                baseMinor: b.baseMinor === undefined ? prices.baseMinor : b.baseMinor,
                extraBuildingMinor:
                  b.extraBuildingMinor === undefined ? prices.extraBuildingMinor : b.extraBuildingMinor,
                currency: b.currency,
              }
            : { priceMinor: b.priceMinor, currency: b.currency };
        if (samePrices(proposed, prices)) throw fail.invalid("These are already the prices");
        if (
          await t.row(
            "SELECT 1 FROM catalogue_price_changes WHERE target_kind = $1 AND target_id = $2 AND status = 'pending'",
            [b.target, b.targetId],
          )
        )
          throw fail.conflict("A price change for this is already waiting for approval");
        const row = await t.row<ChangeRow>(
          `INSERT INTO catalogue_price_changes (id, target_kind, target_id, before, proposed, reason, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [newId("prc"), b.target, b.targetId, JSON.stringify(prices), JSON.stringify(proposed), b.reason, user.id],
        );
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "Price change requested",
          target: `${b.target}:${b.targetId}`,
          detail: b.reason,
          before: prices,
          after: proposed,
        });
        return toChange(row as ChangeRow);
      });
    },

    async listPriceChanges(q: { status?: PriceChangeDto["status"] | undefined; targetId?: string | undefined }) {
      const rows = await db.rows<ChangeRow>(
        `SELECT * FROM catalogue_price_changes WHERE ($1::text IS NULL OR status = $1)
           AND ($2::text IS NULL OR target_id = $2) ORDER BY requested_at DESC, id`,
        [q.status ?? null, q.targetId ?? null],
      );
      return { changes: rows.map(toChange) };
    },

    /** Apply a requested price change; the requester can never approve their own (also a database rule). */
    async approvePriceChange(user: SessionUser, id: string, note?: string) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        const c = await loadChange(t, id);
        if (c.requested_by === user.id)
          throw fail.separationOfDuties(
            "A price change must be approved by a Super Admin other than the one who asked",
          );
        const { plan, prices } = await currentPrices(t, c.target_kind, c.target_id, true);
        if (!samePrices(prices, c.before))
          throw fail.conflict("The prices changed since this was requested — reject it and ask again");
        const p = c.proposed as {
          baseMinor?: number | null;
          extraBuildingMinor?: number | null;
          priceMinor?: number | null;
          currency: string;
        };
        let applied: Record<string, unknown>;
        if (plan) {
          const { after } = await savePlan(t, plan.id, {
            name: plan.name,
            tier: plan.tier,
            product: plan.product,
            modules: plan.modules,
            buildingsIncluded: plan.buildings_included,
            baseMinor: p.baseMinor ?? null,
            extraBuildingMinor: p.extraBuildingMinor ?? null,
            currency: p.currency,
            frequency: plan.frequency,
            trialDays: plan.trial_days,
            taxPct: plan.tax_pct,
            taxNote: plan.tax_note,
            capSites: plan.cap_sites,
            capUnits: plan.cap_units,
          });
          applied = planPrices(after);
        } else {
          const { after } = await saveModule(t, c.target_id, {
            priceMinor: p.priceMinor ?? null,
            currency: p.currency,
          });
          applied = modulePrices(after);
        }
        const row = await t.row<ChangeRow>(
          `UPDATE catalogue_price_changes SET status = 'applied', decided_by = $2, decided_at = now(), decision_note = $3,
             applied = $4 WHERE id = $1 RETURNING *`,
          [id, user.id, note ?? null, JSON.stringify(applied)],
        );
        // issued invoices are never rewritten: the new prices apply to invoices issued from now on
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "Price change approved",
          target: `${c.target_kind}:${c.target_id}`,
          detail: `${id}${note ? " · " + note : ""} · requested by ${c.requested_by}`,
          before: c.before,
          after: applied,
        });
        return toChange(row as ChangeRow);
      });
    },

    async rejectPriceChange(user: SessionUser, id: string, reason: string) {
      const actor = staffActor(user, "super_admin");
      return db.tx(async (t) => {
        const c = await loadChange(t, id);
        if (c.requested_by === user.id)
          throw fail.separationOfDuties("A price change is decided by a Super Admin other than the one who asked");
        const row = await t.row<ChangeRow>(
          `UPDATE catalogue_price_changes SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
           WHERE id = $1 RETURNING *`,
          [id, user.id, reason],
        );
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "Price change rejected",
          target: `${c.target_kind}:${c.target_id}`,
          detail: `${id} · ${reason}`,
        });
        return toChange(row as ChangeRow);
      });
    },

    // ---------------------------------------------------------------- audit search

    async auditSearch(q: AuditQuery) {
      const rows = await db.rows<{
        id: number;
        at: string;
        actor_user: string | null;
        actor_role: string | null;
        org_id: string | null;
        action: string;
        target: string | null;
        detail: string;
        before: unknown;
        after: unknown;
      }>(
        `SELECT * FROM audit_log
         WHERE ($1::text IS NULL OR org_id = $1)
           AND ($2::text IS NULL OR actor_user = $2)
           AND ($3::text IS NULL OR action = $3)
           AND ($4::text IS NULL OR target = $4)
           AND ($5::text IS NULL OR action ILIKE $5 OR target ILIKE $5 OR detail ILIKE $5)
           AND ($6::date IS NULL OR at >= $6::date)
           AND ($7::date IS NULL OR at < $7::date + 1)
           AND ($8::bigint IS NULL OR id < $8)
         ORDER BY id DESC LIMIT $9`,
        [
          q.orgId ?? null,
          q.actorUserId ?? null,
          q.action ?? null,
          q.target ?? null,
          q.q ? "%" + q.q.replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null,
          q.from ?? null,
          q.to ?? null,
          q.before ?? null,
          q.limit + 1,
        ],
      );
      const page = rows.slice(0, q.limit);
      return {
        entries: page.map((r) => ({
          id: String(r.id),
          at: r.at,
          actorUserId: r.actor_user,
          actorRole: r.actor_role,
          action: r.action,
          target: r.target,
          detail: r.detail,
          before: r.before,
          after: r.after,
          orgId: r.org_id,
        })),
        nextBefore: rows.length > q.limit ? String(page[page.length - 1]?.id) : null,
      };
    },
  };
}

export type OpsService = ReturnType<typeof opsService>;
