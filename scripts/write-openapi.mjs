// Writes docs/openapi.json from the endpoint definitions in @paltas/contracts, so the API description can never
// drift from the code. Run: npm run openapi
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { allEndpoints, z } from "@paltas/contracts";

const schema = (s, io) => z.toJSONSchema(s, { io, unrepresentable: "any" });
const SECURITY = {
  user: [{ bearer: [] }],
  staff: [{ bearer: [] }],
  "signed-webhook": [{ paltasSignature: [] }],
  public: [],
};

const paths = {};
for (const e of allEndpoints()) {
  const path = e.path.replace(/:([A-Za-z_]+)/g, "{$1}");
  const params = Object.keys(e.params.shape ?? {}).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const qShape = e.query.shape ?? {};
  const query = Object.entries(qShape).map(([name, s]) => ({
    name,
    in: "query",
    required: !s.safeParse(undefined).success,
    schema: schema(s, "input"),
  }));
  const takesBody = !e.body.safeParse(undefined).success;
  paths[path] ??= {};
  paths[path][e.method.toLowerCase()] = {
    operationId: e.id,
    summary: e.summary,
    security: SECURITY[e.auth],
    parameters: [...params, ...query],
    ...(takesBody
      ? { requestBody: { required: true, content: { "application/json": { schema: schema(e.body, "input") } } } }
      : {}),
    responses: {
      [e.status]: {
        description: "Success",
        content:
          e.id === "marketplace.mediaContent"
            ? { "image/jpeg": { schema: { type: "string", format: "binary" } } }
            : { "application/json": { schema: schema(e.response, "output") } },
      },
      default: {
        description: "Error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  };
}

const doc = {
  openapi: "3.1.0",
  info: {
    title: "PALTAS API",
    version: "0.2.0",
    description:
      "Generated from backend/contracts — do not edit by hand. Money is in integer minor units with a currency. " +
      "Errors are { error: { code, message, details? } }.",
  },
  servers: [{ url: "http://localhost:8787", description: "Local development" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "Token from POST /api/v1/auth/login" },
      paltasSignature: {
        type: "apiKey",
        in: "header",
        name: "X-Paltas-Signature",
        description: "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
          },
        },
      },
    },
  },
  paths,
};
const out = fileURLToPath(new URL("../docs/openapi.json", import.meta.url));
await writeFile(out, JSON.stringify(doc, null, 2) + "\n");
console.warn(`Wrote ${out} (${allEndpoints().length} endpoints)`);
