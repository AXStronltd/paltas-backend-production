import { roleCan, type Capability, type Role } from "@paltas/contracts";
import type { AppContext } from "../../../context.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { OrgScope } from "../../../core/access/org-access.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";

const STEPS = [
  {
    step: "project",
    days: 0,
    title: "Welcome to your developer workspace",
    message: "Add your first project to start tracking units, sales and construction.",
    route: "projects",
    cap: "developer.projects",
  },
  {
    step: "leads",
    days: 1,
    title: "Bring your existing buyers into PALTAS",
    message: "Import your buyer records and payment history. Match the columns and review the results before saving.",
    route: "devmigrate",
    cap: "migration.run",
  },
  {
    step: "budget",
    days: 3,
    title: "Set your construction budget",
    message: "Add your project budget to compare approved costs with your plan. Review expenses before approving them.",
    route: "cost",
    cap: "developer.budget",
  },
] as const;
const COMPLETE = `CASE a.step WHEN 'project' THEN EXISTS(SELECT 1 FROM dev_projects p WHERE p.org_id=a.org_id)
 WHEN 'leads' THEN EXISTS(SELECT 1 FROM dev_contacts c WHERE c.org_id=a.org_id AND c.kind='buyer' AND c.status<>'merged')
 ELSE EXISTS(SELECT 1 FROM dev_budget_lines b WHERE b.org_id=a.org_id AND b.original_set) END`;
export function setupNotifications(ctx: AppContext, core: CoreServices) {
  const { db, clock } = ctx;
  async function ensure(orgId: string, userId: string, role: Role) {
    const o = await db.row<{ created_at: string; projects: number; buyers: number; budgets: number }>(
      `SELECT s.created_at,
   (SELECT count(*)::int FROM dev_projects WHERE org_id=o.id) AS projects,
   (SELECT count(*)::int FROM dev_contacts WHERE org_id=o.id AND kind='buyer' AND status<>'merged') AS buyers,
   (SELECT count(*)::int FROM dev_budget_lines WHERE org_id=o.id AND original_set) AS budgets FROM organisations o JOIN subscriptions s ON s.org_id=o.id AND s.product='developer' WHERE o.id=$1`,
      [orgId],
    );
    if (!o) return;
    const age = Math.max(0, (clock.now().getTime() - new Date(o.created_at).getTime()) / 86400000);
    for (const step of STEPS) {
      const done = step.step === "project" ? o.projects : step.step === "leads" ? o.buyers : o.budgets;
      if (done || age < step.days || !roleCan(role, step.cap as Capability)) continue;
      await db.run(
        `INSERT INTO dev_setup_alerts(id,org_id,user_id,step,title,message,action_route) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,user_id,step) DO NOTHING`,
        [newId("dsa"), orgId, userId, step.step, step.title, step.message, step.route],
      );
    }
    await db.run(
      `UPDATE dev_setup_alerts a SET dismissed_at=COALESCE(dismissed_at,$2) WHERE org_id=$1 AND (${COMPLETE})`,
      [orgId, clock.now().toISOString()],
    );
  }
  async function list(s: OrgScope) {
    await ensure(s.orgId, s.userId, s.role);
    const rows = await db.rows<{
      id: string;
      step: "project" | "leads" | "budget";
      title: string;
      message: string;
      actionRoute: "projects" | "devmigrate" | "cost";
      createdAt: string;
      readAt: string | null;
    }>(
      `SELECT id,step,title,message,action_route AS "actionRoute",created_at AS "createdAt",read_at AS "readAt" FROM dev_setup_alerts WHERE org_id=$1 AND user_id=$2 AND dismissed_at IS NULL ORDER BY created_at DESC,id`,
      [s.orgId, s.userId],
    );
    const alerts = rows.filter((a) => {
      const step = STEPS.find((x) => x.step === a.step);
      return step ? roleCan(s.role, step.cap as Capability) : false;
    });
    return { alerts, unread: alerts.filter((a) => !a.readAt).length };
  }
  async function update(s: OrgScope, id: string, dismiss: boolean) {
    const n = await db.run(
      `UPDATE dev_setup_alerts SET read_at=COALESCE(read_at,$4),dismissed_at=CASE WHEN $5 THEN $4 ELSE dismissed_at END WHERE org_id=$1 AND user_id=$2 AND id=$3`,
      [s.orgId, s.userId, id, clock.now().toISOString(), dismiss],
    );
    if (!n) throw fail.notFound("Reminder not found");
    return { updated: true as const };
  }
  async function sendDue() {
    // Existing companies never receive a retroactive onboarding email burst. Only new, verified administrators.
    const people = await db.rows<{ org_id: string; user_id: string; role: Role; email: string }>(
      `SELECT m.org_id,m.user_id,m.role,u.email FROM memberships m JOIN users u ON u.id=m.user_id JOIN organisations o ON o.id=m.org_id
   JOIN subscriptions s ON s.org_id=o.id AND s.product='developer' AND s.status IN ('trial','active')
   WHERE m.status='active' AND m.role='org_admin' AND u.email_verified_at IS NOT NULL AND o.suspended_at IS NULL
    AND s.created_at>=(SELECT eligible_after FROM dev_onboarding_campaign WHERE singleton)
    AND (s.status='active' OR s.trial_ends >= $1::date) ORDER BY m.org_id,m.user_id`,
      [clock.today()],
    );
    let recorded = 0;
    for (const p of people) {
      await ensure(p.org_id, p.user_id, p.role);
      const alerts = await db.rows<{ step: string; title: string; message: string; action_route: string }>(
        `SELECT step,title,message,action_route FROM dev_setup_alerts WHERE org_id=$1 AND user_id=$2 AND dismissed_at IS NULL`,
        [p.org_id, p.user_id],
      );
      for (const a of alerts) {
        await db.tx((t) =>
          core.notifications.record(t, {
            orgId: p.org_id,
            channel: "email",
            to: p.email,
            category: "transactional",
            subject: a.title,
            body:
              a.message +
              "\n\nOpen your workspace: " +
              ctx.config.signup.appBaseUrl +
              "/developer-dashboard#" +
              a.action_route,
            source: "platform",
            sourceRef: "developer.setup:" + p.user_id + ":" + a.step,
          }),
        );
        recorded++;
      }
    }
    return { summary: `${recorded} developer setup email(s) recorded; delivery handled by the verified provider` };
  }
  return { list, update, sendDue };
}
