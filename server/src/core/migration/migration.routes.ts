import { migration as api, type Capability } from "@paltas/contracts";
import type { SessionUser } from "../identity/identity.service.js";
import { route } from "../../http/route.js";
import type { CoreServices } from "../core-services.js";

// Reading needs migration.read; the stages up to and including the import need migration.run; approving, rolling
// back and signing off need migration.approve. Changes also need an active subscription for the domain's product.
// Another organisation's migration answers "not found".
export function migrationRoutes(core: CoreServices) {
  const { access, migration: M } = core;

  async function jobScope(user: SessionUser, orgId: string, jobId: string, capability: Capability, write = false) {
    const product = await M.productOf(orgId, jobId);
    const s = await access.scope(user, orgId, { capability, write, ...(product ? { products: [product] } : {}) });
    return s;
  }
  const domainProduct = (domain: string) => M.domains.get(domain)?.product;

  return [
    route(api.listDomains, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "migration.read" });
      return { domains: M.listDomains(s.entitlement.products) };
    }),
    route(api.listProfiles, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "migration.read" });
      return { profiles: await M.listProfiles(req.params.orgId, req.query.domain) };
    }),
    route(api.saveProfile, async (req) => {
      const product = domainProduct(req.body.domain);
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "migration.run",
        write: true,
        ...(product ? { products: [product] } : {}),
      });
      return M.saveProfile(s, req.body);
    }),
    route(api.createJob, async (req) => {
      const product = domainProduct(req.body.domain);
      const s = await access.scope(req.user, req.params.orgId, {
        capability: "migration.run",
        write: true,
        ...(product ? { products: [product] } : {}),
      });
      return M.createJob(s, req.body);
    }),
    route(api.listJobs, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "migration.read" });
      return { jobs: await M.listJobs(req.params.orgId) };
    }),
    route(api.getJob, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return M.getJob(req.params.orgId, req.params.jobId);
    }),
    route(api.startUpload, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.startUpload(s, req.params.jobId, req.body);
    }),
    route(api.uploadChunk, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.uploadChunk(s, req.params.jobId, req.params.fileId, req.params.index, req.body.dataBase64);
    }),
    route(api.completeUpload, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.completeUpload(s, req.params.jobId, req.params.fileId);
    }),
    route(api.listFiles, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { files: await M.listFiles(req.params.orgId, req.params.jobId) };
    }),
    route(api.detect, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.detect(s, req.params.jobId);
    }),
    route(api.listTables, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { tables: await M.listTables(req.params.orgId, req.params.jobId) };
    }),
    route(api.mapTable, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.mapTable(s, req.params.jobId, req.params.tableId, req.body);
    }),
    route(api.validate, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.validate(s, req.params.jobId);
    }),
    route(api.listIssues, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return M.listIssues(req.params.orgId, req.params.jobId, req.query);
    }),
    route(api.listRows, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { rows: await M.listRows(req.params.orgId, req.params.jobId, req.query) };
    }),
    route(api.resolveRow, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.resolveRow(s, req.params.jobId, req.params.rowId, req.body);
    }),
    route(api.listDocuments, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { documents: await M.listDocuments(req.params.orgId, req.params.jobId, req.query.status) };
    }),
    route(api.resolveDocument, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.resolveDocument(s, req.params.jobId, req.params.documentId, req.body);
    }),
    route(api.dryRun, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.dryRun(s, req.params.jobId);
    }),
    route(api.approve, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.approve", true);
      return M.approve(s, req.params.jobId);
    }),
    route(api.startImport, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.startImport(s, req.params.jobId);
    }),
    route(api.retry, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.retry(s, req.params.jobId);
    }),
    route(api.listBatches, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { batches: await M.listBatches(req.params.orgId, req.params.jobId) };
    }),
    route(api.rollbackBatch, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.approve", true);
      return M.rollbackBatch(s, req.params.jobId, req.params.seq, req.body.reason);
    }),
    route(api.reconcile, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.run", true);
      return M.reconcile(s, req.params.jobId);
    }),
    route(api.complete, async (req) => {
      const s = await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.approve", true);
      return M.complete(s, req.params.jobId);
    }),
    route(api.report, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return M.report(req.params.orgId, req.params.jobId, req.query.kind, req.query.format);
    }),
    route(api.listRecords, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { records: await M.listRecords(req.params.orgId, req.params.jobId, req.query.entity, req.query.limit) };
    }),
    route(api.jobAudit, async (req) => {
      await jobScope(req.user, req.params.orgId, req.params.jobId, "migration.read");
      return { entries: await M.audit(req.params.orgId, req.params.jobId) };
    }),
  ];
}
