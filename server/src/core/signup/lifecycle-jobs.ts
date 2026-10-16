/*
 * The trial lifecycle, one platform job (daily), the same for every product:
 *
 *   platform.trials.lifecycle
 *     - reminders: a trial policy.reminderDays before its end (T-7, T-3, T-1 by default) gets a reminder for each
 *       organisation administrator, RECORDED in the notifications outbox (never claimed as sent) — at most once per
 *       organisation, product, administrator and day (the outbox's source reference);
 *     - trial ended: once a trial has run out of its grace days (the renewals job marks it expired), each
 *       administrator gets one "trial ended" message (records kept, export allowed);
 *     - unverified: a self-service trial whose administrator has not verified the e-mail address within
 *       policy.verifyWithinDays is suspended (records kept; verifying lifts it) — only while an e-mail provider is
 *       configured, unless the policy's suspendUnverifiedRequiresDelivery is switched off.
 *
 * Expiry itself (trial end + grace days → "expired", read-only) is the platform.subscriptions.renewals job.
 */
import { entitlements, type Product } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import type { ScheduledJobDefinition } from "../scheduler/types.js";
import { loadPolicy } from "./policy.js";
import type { SignupService } from "./signup.service.js";

export function trialJobs(
  ctx: AppContext,
  deps: { notifications: NotificationsService; signup: SignupService },
): ScheduledJobDefinition[] {
  const { db, clock } = ctx;

  return [
    {
      key: "platform.trials.lifecycle",
      label: "Trial reminders, trial-ended notices and unverified sign-ups",
      scope: "platform",
      defaultCron: "20 0 * * *",
      async run() {
        const today = clock.today();
        const policy = await loadPolicy(db);
        const subs = await db.rows<{
          org_id: string;
          org_name: string;
          product: Product;
          status: "trial" | "expired";
          trial_ends: string;
          grace_days: number;
          anchor: string | null;
        }>(
          `SELECT s.org_id, o.name AS org_name, s.product, s.status, s.trial_ends, s.grace_days, s.anchor
           FROM subscriptions s JOIN organisations o ON o.id = s.org_id AND o.suspended_at IS NULL
           WHERE s.status IN ('trial', 'expired') AND s.trial_ends IS NOT NULL AND s.anchor IS NULL
           ORDER BY s.org_id, s.product`,
        );
        let reminders = 0;
        let ended = 0;
        for (const s of subs) {
          const st = entitlements.trialState(
            { plan: "", status: s.status, trialEnds: s.trial_ends, graceDays: s.grace_days, anchor: s.anchor },
            today,
          );
          if (!st) continue;
          const remind = st.phase === "trial" && policy.reminderDays.includes(st.daysLeft);
          const over = st.phase === "expired" && s.status === "expired";
          if (!remind && !over) continue;
          const admins = await db.rows<{ id: string; email: string; name: string }>(
            `SELECT u.id, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.org_id = $1 AND m.role = 'org_admin' AND m.status = 'active' ORDER BY u.id`,
            [s.org_id],
          );
          for (const a of admins) {
            const sourceRef = remind
              ? `trial.reminder:${s.product}:${today}:${a.id}`
              : `trial.ended:${s.product}:${s.trial_ends}:${a.id}`;
            await db.tx(async (t) => {
              if (
                await t.row(
                  "SELECT 1 FROM notifications WHERE org_id = $1 AND source = 'platform' AND source_ref = $2",
                  [s.org_id, sourceRef],
                )
              )
                return;
              await deps.notifications.record(t, {
                orgId: s.org_id,
                channel: "email",
                to: a.email,
                category: "transactional",
                templateKey: remind ? "trial.reminder" : "trial.ended",
                vars: {
                  name: a.name,
                  productName: entitlements.PRODUCT_NAME[s.product] ?? s.product,
                  trialEnds: st.trialEnds,
                  daysLeft: String(st.daysLeft),
                  graceDays: String(s.grace_days),
                  daysLeftText: st.daysLeft === 1 ? "1 day" : `${st.daysLeft} days`,
                  link: `${ctx.config.signup.appBaseUrl}/account.html#upgrade`,
                },
                source: "platform",
                sourceRef,
              });
              if (remind) reminders++;
              else ended++;
            });
          }
        }
        const suspended = await deps.signup.suspendUnverified(policy, today);
        return {
          summary:
            `${reminders} trial reminder(s) · ${ended} trial-ended notice(s) recorded in the outbox · ` +
            (suspended === null
              ? "unverified sign-ups not suspended: no e-mail provider is configured"
              : `${suspended} unverified sign-up(s) suspended`),
        };
      },
    },
  ];
}
