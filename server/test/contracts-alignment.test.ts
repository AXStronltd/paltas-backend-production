// The server serves exactly the endpoints defined in @paltas/contracts — no more, no fewer — so the front-end
// client and the server can never disagree about what exists.
import { allEndpoints, API } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTS } from "../dist/products/index.js";
import { startServer, type TestServer } from "./support/test-server.js";

describe("contracts and server agree", () => {
  let S: TestServer;
  // the real products, as production runs them (product endpoints are part of the contracts too)
  beforeAll(async () => (S = await startServer({ products: PRODUCTS })));
  afterAll(() => S.close());

  it("every endpoint in the contracts has a handler", () => {
    const missing = allEndpoints().filter((e) => !S.app.server.hasRoute({ method: e.method, url: e.path }));
    expect(missing.map((e) => `${e.method} ${e.path}`)).toEqual([]);
  });

  it("the server has no route that the contracts do not define", () => {
    const defined = new Set(allEndpoints().map((e) => e.id));
    const extra = S.app.endpoints.filter((e) => !defined.has(e.id)).map((e) => e.id);
    expect(extra).toEqual([]);
    expect(S.app.endpoints.length).toBe(allEndpoints().length);
  });

  it("endpoint ids and method+path pairs are unique", () => {
    const ids = allEndpoints().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = allEndpoints().map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the client exposes one method per endpoint", () => {
    for (const [group, endpoints] of Object.entries(API)) {
      for (const name of Object.keys(endpoints))
        expect(typeof (S.api as unknown as Record<string, Record<string, unknown>>)[group]![name]).toBe("function");
    }
  });
});
