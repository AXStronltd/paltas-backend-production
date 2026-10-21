import { randomUUID } from "node:crypto";
import { admin, type z } from "@paltas/contracts";
import { type Campaign, SocialChannel } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { route } from "../../http/route.js";
import { fail } from "../../http/errors.js";
import { recordAudit } from "../audit/audit.service.js";
import { staffActor } from "./admin.service.js";

type Row = z.infer<typeof Campaign>;
const select = `SELECT id::text,title,goal,landing_url AS "landingUrl",posts,status,version,created_by AS "createdBy",edited_by AS "editedBy",approved_by AS "approvedBy",scheduled_at AS "scheduledAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM social_campaigns`;
export function marketingRoutes(ctx: AppContext) {
  const db = ctx.db;
  return [
    route(admin.marketingOverview, async () => ({
      campaigns: await db.rows<Row>(`${select} ORDER BY updated_at DESC LIMIT 200`),
      publishingEnabled: false as const,
      channels: SocialChannel.options.map((channel) => ({ channel, connected: false as const })),
    })),
    route(admin.createCampaign, async (r) => {
      const actor = staffActor(r.user, "marketing.manage"),
        id = randomUUID();
      return db.tx(async (t) => {
        await t.run(
          `INSERT INTO social_campaigns(id,title,goal,landing_url,posts,created_by,edited_by) VALUES($1,$2,$3,$4,$5,$6,$6)`,
          [id, r.body.title, r.body.goal, r.body.landingUrl, JSON.stringify(r.body.posts), r.user.id],
        );
        await recordAudit(t, { actor, orgId: null, action: "marketing.campaign.created", target: id });
        const saved = await t.row<Row>(`${select} WHERE id=$1`, [id]);
        if (!saved) throw fail.notFound();
        return saved;
      });
    }),
    route(admin.updateCampaign, async (r) => {
      const actor = staffActor(r.user, "marketing.manage");
      return db.tx(async (t) => {
        const before = await t.row<Row>(`${select} WHERE id=$1 FOR UPDATE`, [r.params.campaignId]);
        if (!before) throw fail.notFound();
        if (before.version !== r.body.version) throw fail.conflict("This campaign changed. Reload before editing.");
        if (before.status === "cancelled")
          throw fail.conflict("Create a new draft instead of changing a cancelled campaign.");
        await t.run(
          `UPDATE social_campaigns SET title=$2,goal=$3,landing_url=$4,posts=$5,status='draft',edited_by=$6,approved_by=NULL,scheduled_at=NULL,version=version+1,updated_at=now() WHERE id=$1`,
          [before.id, r.body.title, r.body.goal, r.body.landingUrl, JSON.stringify(r.body.posts), r.user.id],
        );
        await recordAudit(t, {
          actor,
          orgId: null,
          action: "marketing.campaign.edited",
          target: before.id,
          detail: "Approval and schedule cleared",
        });
        const saved = await t.row<Row>(`${select} WHERE id=$1`, [before.id]);
        if (!saved) throw fail.notFound();
        return saved;
      });
    }),
    route(admin.campaignAction, async (r) => {
      const actor = staffActor(r.user, "marketing.manage");
      return db.tx(async (t) => {
        const c = await t.row<Row>(`${select} WHERE id=$1 FOR UPDATE`, [r.params.campaignId]);
        if (!c) throw fail.notFound();
        if (c.version !== r.body.version) throw fail.conflict("This campaign changed. Reload before continuing.");
        const a = r.body.action;
        if (a === "submit" && c.status !== "draft") throw fail.conflict("Only a draft can be sent for review.");
        if (a === "approve" && (c.status !== "in_review" || c.createdBy === r.user.id || c.editedBy === r.user.id))
          throw fail.conflict("A different PALTAS administrator must review and approve this draft.");
        if (a === "schedule" && c.status !== "approved")
          throw fail.conflict("Approve this campaign before scheduling.");
        if (a === "schedule" && (!r.body.scheduledAt || Date.parse(r.body.scheduledAt) <= Date.now()))
          throw fail.conflict("Choose a future date and time.");
        if (a === "cancel" && c.status === "cancelled") throw fail.conflict("This campaign is already cancelled.");
        const status = { submit: "in_review", approve: "approved", schedule: "scheduled", cancel: "cancelled" }[a];
        await t.run(
          `UPDATE social_campaigns SET status=$2,approved_by=$3,scheduled_at=$4,version=version+1,updated_at=now() WHERE id=$1`,
          [c.id, status, a === "approve" ? r.user.id : c.approvedBy, a === "schedule" ? r.body.scheduledAt : null],
        );
        await recordAudit(t, {
          actor,
          orgId: null,
          action: `marketing.campaign.${a}`,
          target: c.id,
          detail: a === "schedule" ? "Handoff scheduled; social accounts not connected, no automatic publication" : "",
        });
        const saved = await t.row<Row>(`${select} WHERE id=$1`, [c.id]);
        if (!saved) throw fail.notFound();
        return saved;
      });
    }),
  ];
}
