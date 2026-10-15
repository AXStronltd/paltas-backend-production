import { ops } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { migrationStatus } from "../../db/migrate.js";
import { ApiError } from "../../http/errors.js";
import { route, streamRoute } from "../../http/route.js";
import type { CoreServices } from "../core-services.js";
import { exportOrganisation } from "./export.js";

// Readiness is public; everything else is auth "staff" (anyone else gets 404, as if it did not exist).
export function opsRoutes(ctx: AppContext, core: CoreServices) {
  const { ops: O, scheduler: J } = core;
  return [
    route(ops.ready, async () => {
      let migrations: Awaited<ReturnType<typeof migrationStatus>>;
      try {
        migrations = await migrationStatus(ctx.db);
      } catch (err) {
        ctx.log.warn({ err }, "Readiness check: database not reachable");
        throw new ApiError(503, "SERVER_ERROR", "Not ready: the database does not answer");
      }
      if (migrations.pending.length)
        throw new ApiError(503, "SERVER_ERROR", `Not ready: ${migrations.pending.length} migration(s) not applied`, {
          pending: migrations.pending,
        });
      return { ready: true as const, database: "up" as const, migrations };
    }),

    route(ops.listJobs, async (req) => J.listJobs(req.query)),
    route(ops.listRuns, async (req) => J.listRuns(req.params.jobId, req.query.limit)),
    route(ops.pauseJob, async (req) => J.pause(req.user, req.params.jobId, req.body.reason)),
    route(ops.resumeJob, async (req) => J.resume(req.user, req.params.jobId, req.body.reason)),
    route(ops.runJobNow, async (req) => {
      const run = await J.runNow(req.user, req.params.jobId, req.body.reason);
      core.schedulerWorker.wake();
      return run;
    }),
    route(ops.rescheduleJob, async (req) => J.reschedule(req.user, req.params.jobId, req.body)),

    route(ops.suspendOrg, async (req) => O.suspend(req.user, req.params.orgId, req.body.reason)),
    route(ops.reactivateOrg, async (req) => O.reactivate(req.user, req.params.orgId, req.body.reason)),
    route(ops.listSuspensions, async (req) => O.suspensions(req.params.orgId)),
    streamRoute(ops.exportOrg, async (req) => exportOrganisation(ctx, req.user, req.params.orgId, req.query.reason)),

    route(ops.requestPriceChange, async (req) => O.requestPriceChange(req.user, req.body)),
    route(ops.listPriceChanges, async (req) => O.listPriceChanges(req.query)),
    route(ops.approvePriceChange, async (req) => O.approvePriceChange(req.user, req.params.changeId, req.body.note)),
    route(ops.rejectPriceChange, async (req) => O.rejectPriceChange(req.user, req.params.changeId, req.body.reason)),
    route(ops.auditSearch, async (req) => O.auditSearch(req.query)),
  ];
}
