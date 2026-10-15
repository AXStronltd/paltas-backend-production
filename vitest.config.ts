import { defineConfig } from "vitest/config";

// Tests run against the compiled packages (npm test builds first) and a real PostgreSQL database.
// Each test file gets its own fresh database, so files can run in parallel without sharing state.
export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "contracts/test/**/*.test.ts", "api-client/test/**/*.test.ts"],
    globalSetup: ["server/test/support/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
