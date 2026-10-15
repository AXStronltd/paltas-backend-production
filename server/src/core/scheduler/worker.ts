/*
 * The scheduler worker: runs due jobs inside the server process, one run at a time, with a heartbeat that keeps its
 * lease while a run works. stop() waits for the current run, so app.close() can stop it BEFORE the database pool
 * closes (same pattern as the data-migration worker).
 */
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { SchedulerService } from "./scheduler.service.js";

export interface SchedulerWorker {
  readonly id: string;
  start(): void;
  /** Stop after the current run. */
  stop(): Promise<void>;
  /** Look for work now instead of at the next poll. */
  wake(): void;
  /** Queue what is due and run at most one run now; true if one ran. */
  runOnce(now?: Date): Promise<boolean>;
}

export function createSchedulerWorker(o: {
  scheduler: SchedulerService;
  log: FastifyBaseLogger;
  pollMs: number;
  leaseMs: number;
}): SchedulerWorker {
  const id = `sch_${randomBytes(6).toString("hex")}`;
  let running = false;
  let loop: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wakeUp: (() => void) | null = null;

  const beat = (run: { id: string }) => {
    const h = setInterval(
      () => {
        o.scheduler
          .heartbeat(run.id, id)
          .catch((err: unknown) => o.log.warn({ err, run: run.id }, "Scheduler heartbeat failed"));
      },
      Math.max(100, Math.floor(o.leaseMs / 3)),
    );
    return () => clearInterval(h);
  };

  const runOnce = (now?: Date) => o.scheduler.runOnce(id, now, beat);

  async function forever() {
    while (running) {
      let worked = false;
      try {
        worked = await runOnce();
      } catch (err) {
        o.log.error({ err }, "Scheduler worker error");
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
