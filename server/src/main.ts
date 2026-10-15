// Start the PALTAS API server:  npm run dev   (reads server/.env if present). On Render: node server/dist/main.js.
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp(config);
await app.server.listen({ host: config.host, port: config.port });
app.server.log.info(
  `PALTAS API on http://${config.host}:${config.port} · billing ${config.billingMode} · ${config.env}`,
);

// Graceful shutdown: stop taking requests (in-flight ones finish; new ones get 503), stop the background workers
// after their current batch or run, then close the database pool. If that takes longer than SHUTDOWN_TIMEOUT_MS
// the process exits anyway (leases make any unfinished work resumable by the next server).
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    app.server.log.info({ signal }, "Shutting down");
    const force = setTimeout(() => {
      app.server.log.error({ timeoutMs: config.shutdownTimeoutMs }, "Shutdown took too long — exiting");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.server.log.error({ err }, "Shutdown failed");
        process.exit(1);
      },
    );
  });
}
