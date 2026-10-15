// Start the PALTAS API server:  npm run dev   (reads server/.env if present). Local only — not deployed anywhere.
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp(config);
await app.server.listen({ host: config.host, port: config.port });
app.server.log.info(
  `PALTAS API on http://${config.host}:${config.port} · billing ${config.billingMode} · ${config.env}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
