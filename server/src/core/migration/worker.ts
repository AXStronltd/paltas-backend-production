/*
 * The background import worker: runs queued batches inside the server process, so an import never depends on a
 * browser tab or an HTTP request staying open.
 *
 * The queue is the mig_batches table. A worker CLAIMS a batch by taking a lease (lease_owner, lease_until) and
 * renews it while it works (heartbeat). If the server stops, the lease runs out and any worker — after a restart,
 * or another server — claims the batch again. A batch runs in one transaction, so a stopped batch left nothing.
 * Batches of a job run strictly in order (a batch waits until every earlier batch of its job is done).
 */
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/database.js";
import type { BatchRow } from "./migration.repo.js";

export interface WorkerOptions {
  db: Db;
  log: FastifyBaseLogger;
  pollMs: number;
  leaseMs: number;
  /** Run one claimed batch (the caller handles success and failure, checking it still holds the lease). */
  run(batch: BatchRow, workerId: string): Promise<void>;
}

export interface MigrationWorker {
  readonly id: string;
  start(): void;
  /** Stop after the current batch. */
  stop(): Promise<void>;
  /** Look for work now instead of at the next poll. */
  wake(): void;
  /** Claim and run at most one batch; true if one ran. */
  runOnce(): Promise<boolean>;
}

export function createWorker(o: WorkerOptions): MigrationWorker {
  const id = `wrk_${randomBytes(6).toString("hex")}`;
  let running = false;
  let loop: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wakeUp: (() => void) | null = null;

  async function claim(): Promise<BatchRow | null> {
    return o.db.row<BatchRow>(
      `UPDATE mig_batches b SET status = 'running', lease_owner = $1, lease_until = now() + $2 * interval '1 millisecond',
         heartbeat_at = now(), attempts = attempts + 1, started_at = now(), error = NULL
       WHERE b.id = (
         SELECT c.id FROM mig_batches c JOIN mig_jobs j ON j.id = c.job_id
         WHERE j.status = 'importing'
           AND (c.status = 'queued' OR (c.status = 'running' AND c.lease_until < now()))
           AND NOT EXISTS (SELECT 1 FROM mig_batches p WHERE p.job_id = c.job_id AND p.seq < c.seq
                           AND p.status NOT IN ('done', 'rolled_back'))
         ORDER BY c.queued_at, c.seq
         LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
       RETURNING b.*`,
      [id, o.leaseMs],
    );
  }

  async function runOnce(): Promise<boolean> {
    const batch = await claim();
    if (!batch) return false;
    const beat = setInterval(
      () => {
        o.db
          .run(
            `UPDATE mig_batches SET lease_until = now() + $3 * interval '1 millisecond', heartbeat_at = now()
             WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
            [batch.id, id, o.leaseMs],
          )
          .catch((err: unknown) => o.log.warn({ err, batch: batch.id }, "Migration heartbeat failed"));
      },
      Math.max(100, Math.floor(o.leaseMs / 3)),
    );
    try {
      await o.run(batch, id);
    } finally {
      clearInterval(beat);
    }
    return true;
  }

  async function forever() {
    while (running) {
      let worked = false;
      try {
        worked = await runOnce();
      } catch (err) {
        o.log.error({ err }, "Migration worker error");
      }
      if (worked || !running) continue;
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
        timer = setTimeout(resolve, o.pollMs);
        timer.unref();
      });
      wakeUp = null;
    }
  }

  return {
    id,
    start() {
      if (running) return;
      running = true;
      loop = forever();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      wakeUp?.();
      await loop;
      loop = null;
    },
    wake() {
      wakeUp?.();
    },
    runOnce,
  };
}
