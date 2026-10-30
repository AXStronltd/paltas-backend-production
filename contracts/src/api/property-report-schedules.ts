import { z } from "zod";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";
const Base = "/api/v1/orgs/:orgId/property/reports/schedules";
const Id = z.string().min(1).max(80);
const Fields = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["receipts", "invoices"]),
  format: z.enum(["csv", "xlsx", "print"]),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  status: z.enum(["active", "paused", "archived"]),
});
export const CollectionReportSchedule = Fields.extend({
  id: Id,
  propertyId: Id,
  timezone: z.string(),
  version: z.number().int(),
  jobStatus: z.enum(["active", "paused"]).nullable(),
  nextRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSummary: z.string().nullable(),
});
export type CollectionReportSchedule = z.infer<typeof CollectionReportSchedule>;
export type CollectionReportScheduleInput = z.infer<typeof Fields>;
const Params = OrgParams.extend({ reportScheduleId: Id });
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ScheduledCollectionReport = z.object({
  id: Id,
  version: z.number().int(),
  from: z.string(),
  to: z.string(),
  asOf: z.string(),
  createdAt: z.string(),
  filename: z.string(),
  rowCount: z.number().int(),
  fingerprint: z.string(),
  trigger: z.enum(["manual", "schedule"]),
});
export const listCollectionReportSchedules = endpoint({
  id: "property.reports.schedules.list",
  method: "GET",
  path: Base,
  auth: "user",
  summary: "Property-scoped collection report schedules",
  params: OrgParams,
  query: Page.extend({ propertyId: Id }),
  response: z.object({
    schedules: z.array(CollectionReportSchedule),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
});
export const createCollectionReportSchedule = endpoint({
  id: "property.reports.schedules.create",
  method: "POST",
  path: Base,
  auth: "user",
  summary: "Create a reviewed in-workspace report schedule",
  params: OrgParams,
  body: Fields.extend({ propertyId: Id, requestKey: z.string().min(16).max(100) }),
  response: CollectionReportSchedule,
});
export const updateCollectionReportSchedule = endpoint({
  id: "property.reports.schedules.update",
  method: "PUT",
  path: Base + "/:reportScheduleId",
  auth: "user",
  summary: "Edit pause archive or restore an authorised report schedule",
  params: Params,
  body: Fields.extend({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(1000) }),
  response: CollectionReportSchedule,
});
export const runCollectionReportSchedule = endpoint({
  id: "property.reports.schedules.run",
  method: "POST",
  path: Base + "/:reportScheduleId/run",
  auth: "user",
  summary: "Prepare the last complete period, once per schedule version and period",
  params: Params,
  body: z.object({ confirm: z.literal("GENERATE") }),
  response: ScheduledCollectionReport,
});
export const collectionReportRuns = endpoint({
  id: "property.reports.schedules.runs",
  method: "GET",
  path: Base + "/:reportScheduleId/runs",
  auth: "user",
  summary: "Saved report runs with source window and fingerprints",
  params: Params,
  query: Page,
  response: z.object({
    reports: z.array(ScheduledCollectionReport),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
});
export const downloadCollectionReport = endpoint({
  id: "property.reports.schedules.download",
  method: "GET",
  path: Base + "/runs/:reportRunId/download",
  auth: "user",
  summary: "Download a retained report after current scope authorisation",
  params: OrgParams.extend({ reportRunId: Id }),
  response: z.object({
    filename: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    contentType: z.enum(["text/csv", "text/html", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
    rowCount: z.number().int(),
    fingerprint: z.string(),
  }),
});
