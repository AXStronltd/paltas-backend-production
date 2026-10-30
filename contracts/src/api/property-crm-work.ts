import { z } from "zod";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";
const Base = "/api/v1/orgs/:orgId/property/crm";
const Id = z.string().min(1).max(80);
const Status = z.enum(["open", "completed", "cancelled", "archived"]);
const Fields = z.object({
  propertyId: Id,
  contactId: Id.nullable().default(null),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).default(""),
  kind: z.enum(["task", "call", "meeting"]).default("task"),
  dueAt: z.iso.datetime({ offset: true }),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  assigneeId: Id.optional(),
});
export const CrmWork = z.object({
  id: Id,
  propertyId: Id,
  propertyName: z.string(),
  contactId: Id.nullable(),
  contactName: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["task", "call", "meeting"]),
  dueAt: z.string(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  assigneeId: Id,
  assigneeName: z.string(),
  status: Status,
  version: z.number().int(),
  createdAt: z.string(),
});
const Params = OrgParams.extend({ taskId: Id });
export const listCrmWork = endpoint({
  id: "property.crm.work.list",
  method: "GET",
  path: Base + "/work",
  auth: "user",
  summary: "Scoped CRM tasks, follow-ups and meetings",
  params: OrgParams,
  query: z.object({
    propertyId: Id.optional(),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    status: Status.optional(),
    q: z.string().max(160).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }),
  response: z.object({ items: z.array(CrmWork), total: z.number().int() }),
});
export const createCrmWork = endpoint({
  id: "property.crm.work.create",
  method: "POST",
  path: Base + "/work",
  auth: "user",
  summary: "Create an assigned CRM task without sending a message",
  params: OrgParams,
  body: Fields.extend({ requestKey: z.string().min(16).max(100) }),
  response: CrmWork,
  status: 201,
});
export const updateCrmWork = endpoint({
  id: "property.crm.work.update",
  method: "PUT",
  path: Base + "/work/:taskId",
  auth: "user",
  summary: "Correct or transition CRM work with version and audit checks",
  params: Params,
  body: Fields.extend({
    expectedVersion: z.number().int().positive(),
    status: Status,
    reason: z.string().trim().min(5).max(1000),
  }),
  response: CrmWork,
});
export const crmWorkHistory = endpoint({
  id: "property.crm.work.history",
  method: "GET",
  path: Base + "/work/:taskId/history",
  auth: "user",
  summary: "Immutable CRM work revision history",
  params: Params,
  response: z.object({
    events: z.array(
      z.object({ version: z.number().int(), at: z.string(), actor: z.string(), reason: z.string(), snapshot: CrmWork }),
    ),
  }),
});
export const crmAssignees = endpoint({
  id: "property.crm.work.assignees",
  method: "GET",
  path: Base + "/assignees",
  auth: "user",
  summary: "Authorised CRM assignees for a property",
  params: OrgParams,
  query: z.object({ propertyId: Id }),
  response: z.object({ users: z.array(z.object({ id: Id, name: z.string() })) }),
});
export const crmMessageLog = endpoint({
  id: "property.crm.messages.list",
  method: "GET",
  path: Base + "/messages",
  auth: "user",
  summary: "Scoped message log; recorded is never represented as delivered",
  params: OrgParams,
  query: z.object({
    contactId: Id.optional(),
    q: z.string().max(160).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }),
  response: z.object({
    items: z.array(
      z.object({
        id: Id,
        contactId: Id,
        contactName: z.string(),
        channel: z.string(),
        direction: z.string(),
        subject: z.string(),
        body: z.string(),
        status: z.string(),
        deliveryStatus: z.string().nullable(),
        deliveryNote: z.string().nullable(),
        reason: z.string(),
        at: z.string(),
      }),
    ),
    total: z.number().int(),
  }),
});
