/*
 * The scheduler's platform jobs (created at start-up; PALTAS staff can pause or reschedule them):
 *
 *   platform.sessions.cleanup         hourly: delete expired sessions and sessions past the 12-hour maximum
 *   platform.subscriptions.renewals   daily: a trial past its end and its grace days (trial policy) becomes "expired"
 *                                     (read-only, records kept); an active subscription gets its
 *                                     next period's invoice SCHEDULER_RENEWAL_LEAD_DAYS before the period starts
 *                                     (once per period, prices from the catalogue — none in code)
 *   platform.notifications.dispatch   every minute: hand recorded messages to their provider adapter
 *
 * Products add their own (hotel night audit, monthly rent invoicing) through ProductModule.scheduledJobs.
 */
import type { Product } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { addDays, addMonths } from "../../lib/dates.js";
import { recordAudit, SYSTEM } from "../audit/audit.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import type { BillingService } from "../subscriptions/billing.service.js";
import { resolveEntitlement } from "../subscriptions/entitlement.service.js";
import type { ScheduledJobDefinition } from "./types.js";

export const RENEWAL_NOTE = "Renewal — issued automatically";
const MAX_SESSION_HOURS = 12;

export function platformJobs(
  ctx: AppContext,
  deps: { billing: BillingService; notifications: NotificationsService },
): ScheduledJobDefinition[] {
  const { db, clock, config, products } = ctx;

  return [
    {
      key: "platform.sessions.cleanup",
      label: "Remove expired sign-in sessions",
      scope: "platform",
      defaultCron: "17 * * * *",
      async run() {
        const now = clock.now();
        const n = await db.run("DELETE FROM sessions WHERE expires_at <= $1 OR created_at <= $2", [
          now.toISOString(),
          new Date(now.getTime() - MAX_SESSION_HOURS * 3_600_000).toISOString(),
        ]);
        return { summary: `${n} expired session(s) removed` };
      },
    },
    {
      key: "platform.subscriptions.renewals",
      label: "Subscription trial expiry and renewal invoices",
      scope: "platform",
      defaultCron: "5 0 * * *",
      async run() {
        const today = clock.today();
        const subs = await db.rows<{
          org_id: string;
          product: Product;
          status: string;
          trial_ends: string | null;
          grace_days: number;
        }>(
          `SELECT s.org_id, s.product, s.status, s.trial_ends, s.grace_days FROM subscriptions s
           JOIN organisations o ON o.id = s.org_id AND o.suspended_at IS NULL
           WHERE s.status IN ('trial', 'active') AND (s.status='trial' OR NOT EXISTS (SELECT 1 FROM stripe_checkouts sc WHERE sc.org_id=s.org_id AND sc.product=s.product AND sc.status NOT IN ('canceled','incomplete_expired','expired'))) ORDER BY s.org_id, s.product`,
        );
        let expired = 0;
        let issued = 0;
        let unpriced = 0;
        for (const s of subs) {
          if (s.status === "trial") {
            if (!s.trial_ends || addDays(s.trial_ends, s.grace_days) >= today) continue;
            await db.tx(async (t) => {
              const n = await t.run(
                `UPDATE subscriptions SET status = 'expired'
                 WHERE org_id = $1 AND product = $2 AND status = 'trial' AND trial_ends + grace_days < $3`,
                [s.org_id, s.product, today],
              );
              if (!n) return;
              expired++;
              await recordAudit(t, {
                actor: SYSTEM,
                orgId: s.org_id,
                action: "Trial ended — subscription expired",
                target: s.product,
                detail: `trial ended ${s.trial_ends}, grace ${s.grace_days} day(s) · records kept, read-only until a plan is chosen`,
              });
            });
            continue;
          }
          await db.tx(async (t) => {
            // the same lock as a Super Admin issuing an invoice by hand, so a period is never invoiced twice
            await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["invoice:" + s.org_id]);
            const en = await resolveEntitlement(t, products, today, s.org_id, s.product);
            const from = en?.ent.nextBilling;
            if (!en || !en.ent.usable || en.ent.status !== "active" || !from) return;
            if (from > addDays(today, config.scheduler.renewalLeadDays)) return;
            if (en.ent.pending.some((p) => p.type === "cancel" && p.effective <= from)) return;
            if (
              await t.row(
                `SELECT 1 FROM billing_invoices WHERE org_id = $1 AND product = $2 AND period_from = $3
                   AND period_to = $4 AND status <> 'Void'`,
                [s.org_id, s.product, from, addDays(addMonths(from, 1), -1)],
              )
            )
              return;
            const inv = await deps.billing.issuePeriodInvoice(t, en, RENEWAL_NOTE);
            if (!inv) {
              unpriced++;
              return;
            }
            issued++;
            await recordAudit(t, {
              actor: SYSTEM,
              orgId: s.org_id,
              action: "Subscription renewal invoice issued",
              target: inv.id,
              detail: `${s.product} · ${inv.periodFrom} to ${inv.periodTo} · ${inv.currency} ${inv.totalMinor} (minor units)`,
            });
          });
        }
        return {
          summary: `${expired} trial(s) expired · ${issued} renewal invoice(s) issued${unpriced ? ` · ${unpriced} not priced in the organisation's currency` : ""}`,
        };
      },
    },
    {
      key: "platform.notifications.dispatch",
      label: "Hand recorded messages to their provider adapter",
      scope: "platform",
      defaultCron: "* * * * *",
      async run() {
        const c = await deps.notifications.dispatchPending();
        return {
          summary: `${c.sent} sent (accepted by the provider) · ${c.queued} queued (test adapter, not sent) · ${c.failed} refused · ${c.retrying} to retry · ${c.waiting} waiting`,
        };
      },
    },
  ];
}
