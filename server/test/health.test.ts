// The health check is what the host (Render) polls: "ok" must mean the database answers, not only that the process runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./support/test-server.js";

describe("health", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startServer();
  });
  afterAll(() => S.close());

  it("answers ok when the database answers", async () => {
    expect(await S.api.identity.health()).toMatchObject({ ok: true, database: "postgres" });
  });

  it("answers 503 when the database cannot be reached, so the host sees the service as unhealthy", async () => {
    const db = S.app.ctx.db;
    const row = db.row.bind(db);
    db.row = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    try {
      const r = await S.raw("GET", "/api/v1/health");
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({ code: "SERVER_ERROR", message: "The database is not reachable" });
    } finally {
      db.row = row;
    }
    expect((await S.raw("GET", "/api/v1/health")).status).toBe(200);
  });
});
