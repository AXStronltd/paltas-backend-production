// Inventory code contracts and schema declarations only. Never reads customer databases or credentials.
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { API, ROLE_DEFINITIONS } from "../contracts/dist/index.js";
const out = new URL("../docs/enterprise/", import.meta.url);
await mkdir(out, { recursive: true });
const endpoints = Object.entries(API).flatMap(([area, group]) =>
  Object.entries(group).map(([method, e]) => ({
    area,
    clientMethod: method,
    id: e.id,
    method: e.method,
    path: e.path,
    auth: e.auth,
    summary: e.summary,
    classification: "Partially integrated",
    evidence: "Contract declared; endpoint existence alone is not end-to-end verification.",
  })),
);
const schema = [];
for (const file of (await readdir(new URL("../server/migrations/", import.meta.url)))
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const sql = await readFile(new URL("../server/migrations/" + file, import.meta.url), "utf8");
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi))
    schema.push({ table: m[1], migration: file });
}
await writeFile(
  new URL("API-INVENTORY.json", out),
  JSON.stringify({ scope: "Declared contracts, not completed workflow claims", endpoints }, null, 2) + "\n",
);
await writeFile(
  new URL("DATABASE-AND-PERMISSIONS.json", out),
  JSON.stringify({ schema, roles: ROLE_DEFINITIONS }, null, 2) + "\n",
);
console.log(
  JSON.stringify({ endpoints: endpoints.length, tables: schema.length, roles: Object.keys(ROLE_DEFINITIONS).length }),
);
