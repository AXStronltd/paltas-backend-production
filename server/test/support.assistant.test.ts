// The PALTAS assistant's call to the Anthropic Messages API (a fake fetch: no network): the request carries the key
// only in its header, the model and the conversation; [[HANDOVER]] is read and removed; any failure is null (the
// conversation then goes to the PALTAS team). Without a key there is no assistant at all.
import { describe, expect, it } from "vitest";
import { anthropicAssistant, readReply, toTurns } from "../dist/core/support/assistant.js";

const log = { warn: () => undefined };

describe("the PALTAS assistant", () => {
  it("sends the conversation with the key in the header, and reads the answer", async () => {
    let req: { url: string; init: RequestInit } | null = null;
    const fetchFake = (async (url: string, init: RequestInit) => {
      req = { url, init };
      return new Response(JSON.stringify({ model: "m-1", content: [{ type: "text", text: "Hello!\n[[HANDOVER]]" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const a = anthropicAssistant({ apiKey: "sk-test-key-0123456789", model: "m-1" }, log, fetchFake)!;
    const r = await a({ system: "Be kind", turns: [{ role: "user", content: "Hi" }] });
    expect(r).toEqual({ text: "Hello!", handover: true, model: "m-1" });
    expect(req!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = req!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test-key-0123456789");
    const body = JSON.parse(String(req!.init.body));
    expect(body).toMatchObject({ model: "m-1", system: "Be kind", messages: [{ role: "user", content: "Hi" }] });
    expect(String(req!.init.body)).not.toContain("sk-test-key");
  });

  it("a refusal, an error or an empty answer is null; no key means no assistant", async () => {
    const status = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;
    const broken = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const cfg = { apiKey: "sk-test-key-0123456789", model: "m" };
    expect(await anthropicAssistant(cfg, log, status(529))!({ system: "", turns: [] })).toBeNull();
    expect(await anthropicAssistant(cfg, log, broken)!({ system: "", turns: [] })).toBeNull();
    expect(await anthropicAssistant(cfg, log, status(200))!({ system: "", turns: [] })).toBeNull();
    expect(anthropicAssistant({ apiKey: undefined, model: "m" }, log)).toBeNull();
    expect(readReply("[[HANDOVER]]", "m")).toEqual({ text: "", handover: true, model: "m" });
  });

  it("turns alternate, start with the client, and name the PALTAS team", () => {
    expect(
      toTurns([
        { author: "system", authorName: "PALTAS", body: "Welcome" },
        { author: "client", authorName: "Ann", body: "Hi" },
        { author: "client", authorName: "Ann", body: "Anyone?" },
        { author: "staff", authorName: "Sam · PALTAS team", body: "Here" },
        { author: "client", authorName: "Ann", body: "Thanks" },
      ]),
    ).toEqual([
      { role: "user", content: "Hi\n\nAnyone?" },
      { role: "assistant", content: "(Sam · PALTAS team) Here" },
      { role: "user", content: "Thanks" },
    ]);
  });
});
