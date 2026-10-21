// The typed client builds requests exactly as the contracts define them and turns error answers into PaltasApiError.
import { describe, expect, it } from "vitest";
import { createClient, PaltasApiError } from "../dist/index.js";

function fakeFetch(answer: { status: number; body: unknown } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("API client", () => {
  it("gives up when the server does not start answering in time, but never cuts off an answer already arriving", async () => {
    // a server that never answers: the request is aborted after timeoutMs and reported as a network problem
    let aborted = false;
    const silent = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;
    const api = createClient({ baseUrl: "http://api.test", fetch: silent, timeoutMs: 50 });
    const err = await api.ledger.listJournals({ params: { orgId: "O" } }).catch((e: unknown) => e);
    expect(aborted).toBe(true);
    expect(err).toBeInstanceOf(PaltasApiError);
    expect(err).toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "The PALTAS server did not answer in time",
    });
    // headers arrive in time; the body is slow: the answer is read in full, not aborted
    const slowBody = (async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            await new Promise((r) => setTimeout(r, 120));
            c.enqueue(new TextEncoder().encode(JSON.stringify({ journals: [] })));
            c.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const ok = createClient({ baseUrl: "http://api.test", fetch: slowBody, timeoutMs: 50 });
    expect(await ok.ledger.listJournals({ params: { orgId: "O" } })).toEqual({ journals: [] });
  });

  it("fills path params (encoded), query and body, and sends the token", async () => {
    const { f, calls } = fakeFetch({ status: 201, body: { id: "x" } });
    const api = createClient({ baseUrl: "http://api.test/", token: "t0k", fetch: f });
    await api.ledger.createJournal({
      params: { orgId: "ORG 1/2" },
      body: { date: "2026-10-01", memo: "Test", lines: [] },
    });
    expect(calls[0]!.url).toBe("http://api.test/api/v1/orgs/ORG%201%2F2/ledger/journals");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t0k");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ memo: "Test" });
    await api.ledger.listJournals({ params: { orgId: "O" }, query: { status: "posted", limit: 5, from: undefined } });
    expect(calls[1]!.url).toBe("http://api.test/api/v1/orgs/O/ledger/journals?status=posted&limit=5");
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it("normalises trailing slashes in linear time without changing other path characters", async () => {
    const huge = "/".repeat(150_000);
    for (const [baseUrl, expected] of [
      ["", ""],
      ["http://api.test///", "http://api.test"],
      [huge, ""],
      ["http://api.test/" + huge + "x", "http://api.test/" + huge + "x"],
    ]) {
      const { f, calls } = fakeFetch({ status: 200, body: { ok: true } });
      await createClient({ baseUrl: baseUrl!, fetch: f }).identity.health();
      expect(calls[0]!.url === expected + "/api/v1/health").toBe(true);
    }
  });

  it("turns error answers into PaltasApiError with the stable code", async () => {
    const { f } = fakeFetch({
      status: 403,
      body: { error: { code: "MODULE_NOT_ENTITLED", message: "Not in plan", details: { module: "crm" } } },
    });
    const api = createClient({ baseUrl: "http://api.test", fetch: f });
    const e = await api.identity.me().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PaltasApiError);
    expect(e).toMatchObject({
      status: 403,
      code: "MODULE_NOT_ENTITLED",
      message: "Not in plan",
      details: { module: "crm" },
    });
  });

  it("reports network failures and answers that are not JSON", async () => {
    const down = createClient({ baseUrl: "http://api.test", fetch: fakeFetch(new Error("ECONNREFUSED")).f });
    await expect(down.identity.health()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    const weird = createClient({
      baseUrl: "http://api.test",
      fetch: (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(weird.identity.health()).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
  });

  it("with validateResponses, an answer that does not match its contract is refused", async () => {
    const api = createClient({
      baseUrl: "http://api.test",
      validateResponses: true,
      fetch: fakeFetch({ status: 200, body: { ok: true, database: "mysql" } }).f,
    });
    await expect(api.identity.health()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("setToken changes the token for later calls", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: { ok: true } });
    const api = createClient({ baseUrl: "http://api.test", fetch: f });
    await api.identity.logout();
    api.setToken("new");
    await api.identity.logout();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer new");
  });

  it("the browser bundle exposes the same client as a global", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../browser/paltas-api-client.js", import.meta.url), "utf8");
    const self: Record<string, any> = {};
    new Function("self", "module", src)(self, undefined);
    expect(typeof self.PaltasApi.createClient).toBe("function");
    expect(Object.keys(self.PaltasApi.API)).toEqual([
      "identity",
      "organisations",
      "subscriptions",
      "payments",
      "ledger",
      "admin",
      "migration",
      "hotel",
      "ops",
      "notifications",
      "paymentProviders",
      "security",
      "agency",
      "marketplace",
      "development",
      "contacts",
      "property",
      "signup",
      "support",
    ]);
    expect(self.PaltasApi.roleCan("accountant", "ledger.approve")).toBe(true);
    expect(self.PaltasApi.roleCan("leasing_agent", "ledger.approve")).toBe(false);
  });
});
