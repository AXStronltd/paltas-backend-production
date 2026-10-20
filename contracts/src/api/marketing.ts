import { z } from "zod";
import { endpoint } from "../endpoint.js";

export const SocialChannel = z.enum(["facebook", "instagram", "linkedin", "x", "tiktok", "youtube"]);
const Post = z.object({ channel: SocialChannel, caption: z.string().trim().min(1).max(2200) }).superRefine((p, ctx) => {
  if (p.channel === "x" && [...p.caption].length > 280)
    ctx.addIssue({ code: "custom", message: "Keep X posts within 280 characters", path: ["caption"] });
});
export const CampaignInput = z.object({
  title: z.string().trim().min(3).max(160),
  goal: z.string().trim().min(3).max(1000),
  landingUrl: z
    .string()
    .url()
    .max(500)
    .refine((s) => {
      try {
        const u = new URL(s);
        return u.origin === "https://paltas.io" && !u.username && !u.password;
      } catch {
        return false;
      }
    }, "Use a public https://paltas.io link"),
  posts: z
    .array(Post)
    .min(1)
    .max(6)
    .refine((p) => new Set(p.map((x) => x.channel)).size === p.length, "Choose each channel once"),
});
export const Campaign = CampaignInput.extend({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(["draft", "in_review", "approved", "scheduled", "cancelled"]),
  createdBy: z.string(),
  editedBy: z.string(),
  approvedBy: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const params = z.object({ campaignId: z.string().uuid() });
export const marketingOverview = endpoint({
  id: "admin.marketing.overview",
  method: "GET",
  path: "/api/v1/admin/marketing",
  auth: "staff",
  summary: "PALTAS-only campaign review and scheduled handoff queue; publishing is not connected",
  response: z.object({
    campaigns: z.array(Campaign),
    publishingEnabled: z.literal(false),
    channels: z.array(z.object({ channel: SocialChannel, connected: z.literal(false) })),
  }),
});
export const createCampaign = endpoint({
  id: "admin.marketing.create",
  method: "POST",
  path: "/api/v1/admin/marketing/campaigns",
  auth: "staff",
  summary: "Create a server-saved PALTAS social campaign draft",
  body: CampaignInput,
  response: Campaign,
});
export const updateCampaign = endpoint({
  id: "admin.marketing.update",
  method: "PUT",
  path: "/api/v1/admin/marketing/campaigns/:campaignId",
  auth: "staff",
  params,
  summary: "Edit a campaign with version checking; editing clears previous approval and scheduling",
  body: CampaignInput.extend({ version: z.number().int().positive() }),
  response: Campaign,
});
export const campaignAction = endpoint({
  id: "admin.marketing.action",
  method: "POST",
  path: "/api/v1/admin/marketing/campaigns/:campaignId/actions",
  auth: "staff",
  params,
  summary: "Submit, independently approve, schedule a handoff or cancel; never publishes to a provider",
  body: z.object({
    version: z.number().int().positive(),
    action: z.enum(["submit", "approve", "schedule", "cancel"]),
    scheduledAt: z.string().datetime().optional(),
  }),
  response: Campaign,
});
