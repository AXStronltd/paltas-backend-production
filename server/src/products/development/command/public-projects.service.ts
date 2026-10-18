import type { AppContext } from "../../../context.js";
import type { CoreServices } from "../../../core/core-services.js";
import type { OrgScope } from "../../../core/access/org-access.js";
import { recordAudit, SYSTEM } from "../../../core/audit/audit.service.js";
import { resolveEntitlement } from "../../../core/subscriptions/entitlement.service.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { createTask, findProject } from "../shared/records.js";
export function publicProjects(ctx: AppContext, core: CoreServices) {
  const { db, clock } = ctx;
  async function publication(s: OrgScope, projectId: string) {
    await findProject(db, s.orgId, projectId);
    return db.row<{ slug: string; published: boolean }>(
      "SELECT slug,published FROM dev_public_projects WHERE org_id=$1 AND project_id=$2",
      [s.orgId, projectId],
    );
  }
  async function publish(s: OrgScope, projectId: string, published: boolean) {
    await findProject(db, s.orgId, projectId);
    if (published && !(await db.row("SELECT 1 FROM users WHERE id=$1 AND email_verified_at IS NOT NULL", [s.userId])))
      throw fail.forbidden("Verify your email before publishing a project page.");
    return db.tx(async (t) => {
      const result = await t.row<{ slug: string; published: boolean }>(
        `INSERT INTO dev_public_projects(project_id,org_id,slug,published,published_by) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(project_id) DO UPDATE SET published=EXCLUDED.published,published_by=EXCLUDED.published_by,updated_at=now() RETURNING slug,published`,
        [projectId, s.orgId, newId("project"), published, s.userId],
      );
      await recordAudit(t, {
        actor: s.actor,
        orgId: s.orgId,
        action: published ? "Developer project page published" : "Developer project page unpublished",
        target: projectId,
      });
      if (!result) throw new Error("Project publication could not be saved");
      return result;
    });
  }
  async function visible(slug: string) {
    const p = await db.row<{ id: string; org_id: string; name: string; location: string | null; progress_pct: number }>(
      `SELECT p.id,p.org_id,p.name,p.location,p.progress_pct FROM dev_public_projects x JOIN dev_projects p ON p.id=x.project_id AND p.org_id=x.org_id JOIN organisations o ON o.id=p.org_id WHERE x.slug=$1 AND x.published AND o.suspended_at IS NULL`,
      [slug],
    );
    if (!p) throw fail.notFound("Project page not found");
    const e = await resolveEntitlement(db, ctx.products, clock.today(), p.org_id, "developer");
    if (!e?.ent.usable || !e.ent.modules.crm) throw fail.notFound("Project page not found");
    return p;
  }
  async function get(slug: string) {
    const p = await visible(slug);
    return { name: p.name, location: p.location, constructionPct: p.progress_pct };
  }
  async function enquire(slug: string, b: { name: string; email: string; message: string; contactConsent: true }) {
    const p = await visible(slug);
    await db.tx(async (t) => {
      // Serialize submissions within a company to deduplicate concurrent enquiries without disclosing buyer existence.
      await t.run("SELECT pg_advisory_xact_lock(hashtextextended('developer.leads:'||$1,0))", [p.org_id]);
      const existing = await t.row<{ id: string; agent_user_id: string | null }>(
        "SELECT id,agent_user_id FROM dev_contacts WHERE org_id=$1 AND kind='buyer' AND lower(email)=lower($2) AND status<>'merged' ORDER BY created_at,id LIMIT 1",
        [p.org_id, b.email],
      );
      const volume = await t.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM dev_project_enquiries WHERE org_id=$1 AND created_at >= now()-interval '1 day'",
        [p.org_id],
      );
      if ((volume?.n ?? 0) >= 500)
        throw fail.tooManyAttempts("This company has received many enquiries today. Please try again later.");
      if (
        existing &&
        (await t.row(
          "SELECT 1 FROM dev_project_enquiries WHERE org_id=$1 AND project_id=$2 AND buyer_id=$3 AND message=$4 AND created_at>=now()-interval '1 day'",
          [p.org_id, p.id, existing.id, b.message],
        ))
      )
        return;
      const agent = await t.row<{ user_id: string }>(
        `SELECT m.user_id FROM memberships m WHERE m.org_id=$1 AND m.status='active' AND m.role IN ('sales_agent','org_admin') ORDER BY CASE WHEN m.role='sales_agent' THEN 0 ELSE 1 END, (SELECT count(*) FROM dev_contacts c WHERE c.org_id=m.org_id AND c.agent_user_id=m.user_id AND c.status='active'),m.user_id LIMIT 1`,
        [p.org_id],
      );
      if (!agent) throw fail.conflict("This project is not accepting enquiries yet.");
      const id = existing?.id ?? newId("dby");
      if (!existing) {
        const { contact } = await core.contacts.findOrCreate(
          t,
          p.org_id,
          { name: b.name, email: b.email, types: ["prospect"], partyType: "individual" },
          SYSTEM,
        );
        await t.run(
          `INSERT INTO dev_contacts(id,org_id,kind,name,email,project_id,source,status,contact_id,agent_user_id,next_follow_up) VALUES($1,$2,'buyer',$3,$4,$5,'Public project page','active',$6,$7,$8)`,
          [id, p.org_id, b.name, b.email.toLowerCase(), p.id, contact.id, agent?.user_id ?? null, clock.today()],
        );
      }
      await t.run(
        "INSERT INTO dev_project_enquiries(id,org_id,project_id,buyer_id,message,contact_consent) VALUES($1,$2,$3,$4,$5,true)",
        [newId("den"), p.org_id, p.id, id, b.message],
      );
      await createTask(t, p.org_id, {
        title: "Respond to project enquiry: " + b.name,
        dueDate: clock.today(),
        priority: "high",
        category: "sales",
        buyerId: id,
        projectId: p.id,
        assignee: existing?.agent_user_id ?? agent.user_id,
        description: "Project: " + p.name + "\n" + b.message,
        createdBy: null,
      });
      await recordAudit(t, {
        actor: SYSTEM,
        orgId: p.org_id,
        action: "Public project enquiry received",
        target: id,
        detail: p.name,
      });
    });
    return { received: true as const };
  }
  return { publication, publish, get, enquire };
}
