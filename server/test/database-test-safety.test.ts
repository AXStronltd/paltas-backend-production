import { describe, expect, it } from "vitest";
import { safeTestAdminUrl } from "./support/global-setup.js";

describe("database test connection safety", () => {
  it("accepts only local PostgreSQL test connections", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(safeTestAdminUrl(`postgres://test@${host}:5432/postgres`)).toContain(host);
    }
    for (const url of [
      "postgres://production.example.com/live",
      "postgres://paltas-api.onrender.com/db",
      "https://localhost/db",
    ]) {
      expect(() => safeTestAdminUrl(url)).toThrow("isolated PostgreSQL");
    }
  });
});
